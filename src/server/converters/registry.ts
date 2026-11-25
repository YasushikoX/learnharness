import { ConverterError, type ConvertContext, type ConvertInput, type ConvertResult, type PdfConverter } from "../../core/pdf-converter.ts";
import type { PdfConversionSettings } from "../../core/settings.ts";
import { customProfileIdOf, type HttpConverterProfile } from "../../core/http-converter-spec.ts";
import { createDoclingConverter } from "./docling.ts";
import { createHttpConverter } from "./http-declarative.ts";
import { pdfjsConverter } from "./pdfjs.ts";
import { PRESET_PROFILES } from "./presets.ts";
import { selfOriginProblem } from "./self-origin.ts";

/**
 * The PDF converter registry (fork addition, 2026-11-24). A converter is
 * registered as a factory that builds it from the settings section; the
 * settings route accepts only registered ids. resolvePdfConverter is called
 * ONCE per conversion; the conversion uses what it returned throughout.
 *
 * Fallback to pdfjs, always with a warning the material shows:
 *   - the selected converter lacks configuration (Docling without a URL), or an id is unknown;
 *   - the selected service is unreachable or timed out (convertWithFallback).
 * Every other failure (auth, rate limit, bad response, the service's own
 * failure) is the material's conversionError, with no fallback.
 *
 * Profile converters (fork addition, 2026-11-25): each bundled preset
 * (presets.ts) is registered here like Docling; a user's own profile is
 * `custom:<id>`, loaded and validated on every resolve through the
 * CustomProfileLoader its caller passes in (a missing or invalid file falls
 * back to pdfjs with a warning, like an unknown id).
 *
 * NOTHING IS SENT BEFORE SETUP (review 1, finding 2). A service converter
 * sends nothing until the user has saved a service URL for it in the
 * settings (a preset's own address counts only once it has been saved, which
 * choosing the preset in Settings does) and, when it takes a key, a key is
 * stored for that URL. A URL that is this app's own address is refused
 * (self-origin.ts). Each is `not_configured`: the conversion falls back to
 * the built-in reader with a warning, and no request is made.
 *
 * No store import here (settings-body.ts imports this module, and test
 * files import that before isolating their data folder): a converter's key
 * arrives through the CredentialReader its caller passes in.
 */

/** A converter's key for a base URL, from the credential store (converters/auth.ts), or undefined. */
export type CredentialReader = (converterId: string, baseUrl: string) => string | undefined;

/** A user's own profile by its id (custom-profiles.ts), validated on every call. */
export type CustomProfileLoader = (profileId: string) => { ok: true; profile: HttpConverterProfile } | { ok: false; error: string };

export interface PdfConverterFactory {
	id: string;
	/** Throws ConverterError("not_configured") when the settings lack what it needs. */
	create(settings: PdfConversionSettings, readCredential: CredentialReader): PdfConverter;
}

export interface ResolvedPdfConverter {
	converter: PdfConverter;
	/** The id the settings asked for ("pdfjs" when absent). */
	requestedId: string;
	warnings: string[];
}

export interface RegistryConversion extends ConvertResult {
	/** The converter that produced the pages (pdfjs after a fallback). */
	converterId: string;
	/** Set when the configured converter failed with unreachable/timeout and fell back to pdfjs. */
	fallbackFrom?: { converterId: string; reason: string; label?: string };
}

const factories = new Map<string, PdfConverterFactory>();

export function registerPdfConverter(factory: PdfConverterFactory): void {
	if (factories.has(factory.id)) throw new Error(`PDF converter already registered: ${factory.id}`);
	factories.set(factory.id, factory);
}

export function registeredPdfConverterIds(): string[] {
	return [...factories.keys()];
}

/** A built-in or preset id, or any well-formed `custom:<id>` (whether its file exists is checked when it is used). */
export function isRegisteredPdfConverter(id: string): boolean {
	return factories.has(id) || customProfileIdOf(id) !== undefined;
}

/** Refuse a service URL that is this app's own address, before any request. */
function refuseSelf(name: string, baseUrl: string): void {
	const problem = selfOriginProblem(baseUrl);
	if (problem) throw new ConverterError("not_configured", `${name} is not set up: ${problem}; nothing was sent`, false);
}

/**
 * A profile converter for the settings: the service URL SAVED in `services` (a profile's defaultBaseUrl is never
 * used here), its key from the store. `bundled` only for presets.
 */
export function createProfileConverter(converterId: string, profile: HttpConverterProfile, settings: PdfConversionSettings, readCredential: CredentialReader, bundled = false): PdfConverter {
	const baseUrl = settings.services?.[converterId]?.baseUrl;
	if (!baseUrl) throw new ConverterError("not_configured", `${profile.name} is not set up: no service URL is saved for it in Settings → PDF conversion`, false);
	refuseSelf(profile.name, baseUrl);
	return createHttpConverter({ converterId, profile, bundled, baseUrl, apiKey: readCredential(converterId, baseUrl) });
}

registerPdfConverter({ id: pdfjsConverter.id, create: () => pdfjsConverter });
registerPdfConverter({
	id: "docling",
	create(settings, readCredential) {
		const baseUrl = settings.docling?.baseUrl;
		if (!baseUrl) throw new ConverterError("not_configured", "Docling is selected but no Docling URL is configured", false);
		refuseSelf("Docling", baseUrl);
		return createDoclingConverter({
			baseUrl,
			apiKey: readCredential("docling", baseUrl),
			ocr: settings.docling?.ocr,
			formulaEnrichment: settings.docling?.formulaEnrichment,
		});
	},
});
for (const preset of PRESET_PROFILES) {
	registerPdfConverter({ id: preset.id, create: (settings, readCredential) => createProfileConverter(preset.id, preset, settings, readCredential, true) });
}

/** The converter the settings select, built once. Never throws for configuration: it falls back to pdfjs with a warning. */
export function resolvePdfConverter(settings: PdfConversionSettings | undefined, readCredential: CredentialReader, loadCustomProfile?: CustomProfileLoader): ResolvedPdfConverter {
	const requestedId = settings?.converter ?? pdfjsConverter.id;
	const customId = customProfileIdOf(requestedId);
	if (customId !== undefined) {
		const loaded = loadCustomProfile ? loadCustomProfile(customId) : { ok: false as const, error: "custom profiles are not available here" };
		if (!loaded.ok) {
			return { converter: pdfjsConverter, requestedId, warnings: [`Your PDF converter profile "${customId}" could not be used (${loaded.error}); the built-in reader (pdfjs) was used instead.`] };
		}
		try {
			return { converter: createProfileConverter(requestedId, loaded.profile, settings ?? {}, readCredential), requestedId, warnings: [] };
		} catch (error) {
			if (!(error instanceof ConverterError) || error.kind !== "not_configured") throw error;
			return { converter: pdfjsConverter, requestedId, warnings: [`${error.message}; the built-in reader (pdfjs) was used instead.`] };
		}
	}
	const factory = factories.get(requestedId);
	if (!factory) {
		return { converter: pdfjsConverter, requestedId, warnings: [`The PDF converter "${requestedId}" in the settings is not available; the built-in reader (pdfjs) was used instead.`] };
	}
	try {
		return { converter: factory.create(settings ?? {}, readCredential), requestedId, warnings: [] };
	} catch (error) {
		if (!(error instanceof ConverterError) || error.kind !== "not_configured" || factory.id === pdfjsConverter.id) throw error;
		return { converter: pdfjsConverter, requestedId, warnings: [`${error.message}; the built-in reader (pdfjs) was used instead.`] };
	}
}

/** Convert with the resolved converter; an unreachable or timed-out service falls back to pdfjs with a warning. */
export async function convertWithFallback(resolved: ResolvedPdfConverter, input: ConvertInput, ctx: ConvertContext): Promise<RegistryConversion> {
	const selected = resolved.converter;
	try {
		const result = await selected.convert(input, ctx);
		return { ...result, converterId: selected.id, warnings: [...resolved.warnings, ...(result.warnings ?? [])] };
	} catch (error) {
		if (selected.id === pdfjsConverter.id || !(error instanceof ConverterError) || (error.kind !== "unreachable" && error.kind !== "timeout")) throw error;
		const result = await pdfjsConverter.convert(input, ctx);
		return {
			...result,
			converterId: pdfjsConverter.id,
			fallbackFrom: { converterId: selected.id, reason: error.message, ...(selected.label ? { label: selected.label } : {}) },
			warnings: [
				...resolved.warnings,
				`${selected.id === "docling" ? "Docling" : (selected.label ?? selected.id)} failed (${error.message}); the built-in reader (pdfjs) was used instead.`,
				...(result.warnings ?? []),
			],
		};
	}
}
