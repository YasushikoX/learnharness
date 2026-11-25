import type { ConverterEntry, ConvertersOverview, ConverterValidationReport } from "../../core/converter-settings.ts";
import { customConverterId, customProfileIdOf, profileOrigin, type HttpConverterProfile } from "../../core/http-converter-spec.ts";
import { CURRENT_SETTINGS_VERSION, normalizeBaseUrl, type PdfConversionSettings } from "../../core/settings.ts";
import { writeDoclingAuth } from "../../store/auth.ts";
import { readSettings, writeSettings } from "../../store/settings.ts";
import { writeDoclingCredential } from "./auth.ts";
import { credentialStatus, readConverterCredential, writeProfileCredential } from "./credentials.ts";
import { listCustomProfiles, loadCustomProfile, removeCustomProfile, saveCustomProfile } from "./custom-profiles.ts";
import { pdfjsConverter } from "./pdfjs.ts";
import { PRESET_PROFILES, presetProfile } from "./presets.ts";
import { resolvePdfConverter } from "./registry.ts";
import { validateConverter } from "./validator.ts";

export type { ConverterEntry, ConvertersOverview };

/**
 * Settings → PDF conversion, server side (fork addition, 2026-11-25), behind app/api/converters/. Non-secret
 * configuration goes to the pdfConversion settings section; keys go to the credential store (auth.json) bound to
 * the base URL, through auth.ts (Docling) and credentials.ts (profiles). Nothing here returns a key: the overview
 * says only whether one is stored for the current URL and, for a long key, its last four characters. Changing a
 * service's URL without entering a key removes the stored one, so it is never sent to the new address.
 */

function section(): PdfConversionSettings {
	return readSettings()?.pdfConversion ?? {};
}

function writeSection(next: PdfConversionSettings): void {
	const record = readSettings() ?? { version: CURRENT_SETTINGS_VERSION };
	writeSettings({ ...record, pdfConversion: next });
}

function profileEntry(id: string, kind: "preset" | "custom", profile: HttpConverterProfile, settings: PdfConversionSettings): ConverterEntry {
	const baseUrl = settings.services?.[id]?.baseUrl;
	const effective = baseUrl ?? profile.defaultBaseUrl;
	const origin = profileOrigin(profile, baseUrl);
	return {
		id,
		kind,
		name: profile.name,
		...(profile.description ? { description: profile.description } : {}),
		local: false,
		...(profile.unverified ? { unverified: true } : {}),
		...(profile.docsUrl ? { docsUrl: profile.docsUrl } : {}),
		...(profile.defaultBaseUrl ? { defaultBaseUrl: profile.defaultBaseUrl } : {}),
		...(baseUrl ? { baseUrl } : {}),
		...(origin ? { origin } : {}),
		key: profile.auth ? "required" : "none",
		credential: profile.auth ? credentialStatus(id, effective) : { stored: false },
		...(profile.limits ? { limits: profile.limits } : {}),
	};
}

export function convertersOverview(): ConvertersOverview {
	const settings = section();
	const doclingUrl = settings.docling?.baseUrl;
	const custom = listCustomProfiles();
	return {
		selected: settings.converter ?? pdfjsConverter.id,
		converters: [
			{ id: "pdfjs", kind: "builtin", name: "Built-in reader", description: "Reads the text layer of a PDF on this computer. No setup, no OCR: scanned pages come out empty.", local: true, key: "none", credential: { stored: false } },
			{
				id: "docling",
				kind: "docling",
				name: "Docling (self-hosted)",
				description: "A Docling Serve instance you run yourself, with OCR and formula recognition.",
				local: false,
				docsUrl: "https://github.com/docling-project/docling-serve",
				...(doclingUrl ? { baseUrl: doclingUrl, origin: new URL(doclingUrl).origin } : {}),
				key: "optional",
				credential: credentialStatus("docling", doclingUrl),
				options: { ocr: settings.docling?.ocr ?? true, formulaEnrichment: settings.docling?.formulaEnrichment ?? false },
			},
			...PRESET_PROFILES.map((p) => profileEntry(p.id, "preset", p, settings)),
			...custom.profiles.map((p) => profileEntry(customConverterId(p.id), "custom", p, settings)),
		],
		invalidProfiles: custom.invalid,
	};
}

export interface ConfigureConverterInput {
	id: string;
	/** Make it the converter uploads use. */
	select?: boolean;
	/** "" clears it (a preset then uses its default URL). */
	baseUrl?: string;
	/** A new key, bound to the (new) base URL. Never returned. */
	apiKey?: string;
	removeKey?: boolean;
	/** Docling only. */
	ocr?: boolean;
	formulaEnrichment?: boolean;
}

export type ServiceResult<T> = { ok: true; value: T } | { ok: false; error: string; status?: number };

function profileFor(id: string): HttpConverterProfile | undefined | null {
	const preset = presetProfile(id);
	if (preset) return preset;
	const customId = customProfileIdOf(id);
	if (customId === undefined) return null;
	const loaded = loadCustomProfile(customId);
	return loaded.ok ? loaded.profile : undefined;
}

/** Parse an untrusted request body into ConfigureConverterInput (shape only). */
export function parseConfigureBody(body: unknown): ServiceResult<ConfigureConverterInput> {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Invalid JSON body" };
	const raw = body as Record<string, unknown>;
	const allowed = new Set(["id", "select", "baseUrl", "apiKey", "removeKey", "ocr", "formulaEnrichment"]);
	const unknown = Object.keys(raw).find((k) => !allowed.has(k));
	if (unknown) return { ok: false, error: `unknown field ${unknown}` };
	if (typeof raw.id !== "string" || !raw.id) return { ok: false, error: "id must be a converter id" };
	for (const flag of ["select", "removeKey", "ocr", "formulaEnrichment"] as const) {
		if (raw[flag] !== undefined && typeof raw[flag] !== "boolean") return { ok: false, error: `${flag} must be true or false` };
	}
	if (raw.baseUrl !== undefined && typeof raw.baseUrl !== "string") return { ok: false, error: "baseUrl must be a URL" };
	if (raw.apiKey !== undefined) {
		if (typeof raw.apiKey !== "string" || raw.apiKey.length > 4096 || /[\r\n\0]/.test(raw.apiKey)) return { ok: false, error: "apiKey must be one line of text" };
	}
	return { ok: true, value: raw as unknown as ConfigureConverterInput };
}

export function configureConverter(input: ConfigureConverterInput): ServiceResult<ConvertersOverview> {
	const { id } = input;
	const settings = section();
	const isDocling = id === "docling";
	const profile = isDocling || id === "pdfjs" ? null : profileFor(id);
	if (!isDocling && id !== "pdfjs" && !profile) {
		return { ok: false, error: profile === undefined ? `The converter profile ${id} is missing or not valid` : `Unknown converter ${id}`, status: profile === undefined ? 409 : 400 };
	}
	const apiKey = input.apiKey?.trim() || undefined;
	if (id === "pdfjs" && (input.baseUrl !== undefined || apiKey || input.removeKey)) return { ok: false, error: "The built-in reader has no URL or key" };
	if (!isDocling && (input.ocr !== undefined || input.formulaEnrichment !== undefined)) return { ok: false, error: "Only Docling has OCR and formula options" };
	if (profile && !profile.auth && apiKey) return { ok: false, error: `${profile.name} takes no key` };

	let baseUrl: string | undefined;
	if (input.baseUrl !== undefined && input.baseUrl.trim()) {
		baseUrl = normalizeBaseUrl(input.baseUrl);
		if (!baseUrl) return { ok: false, error: "The URL must be an absolute HTTP(S) address without credentials, query or fragment" };
	}
	const next: PdfConversionSettings = structuredClone(settings);
	let before: string | undefined;
	let after: string | undefined;
	if (isDocling) {
		before = settings.docling?.baseUrl;
		const docling = { ...settings.docling };
		if (input.baseUrl !== undefined) {
			if (baseUrl) docling.baseUrl = baseUrl;
			else delete docling.baseUrl;
		}
		if (input.ocr !== undefined) docling.ocr = input.ocr;
		if (input.formulaEnrichment !== undefined) docling.formulaEnrichment = input.formulaEnrichment;
		next.docling = docling;
		after = docling.baseUrl;
	} else if (profile) {
		const current = settings.services?.[id]?.baseUrl;
		before = current ?? profile.defaultBaseUrl;
		const services = { ...settings.services };
		if (input.baseUrl !== undefined) Object.defineProperty(services, id, { value: baseUrl && baseUrl !== profile.defaultBaseUrl ? { baseUrl } : {}, enumerable: true, configurable: true, writable: true });
		next.services = services;
		after = services[id]?.baseUrl ?? profile.defaultBaseUrl;
	}
	if (apiKey && !after) return { ok: false, error: "Enter the service URL before its key: the key is bound to it" };
	if (input.select) next.converter = id;

	// Keys first, each bound to the URL it is for; a crash between the two writes never sends a key to another URL.
	const urlChanged = (before ?? "") !== (after ?? "");
	if (isDocling) {
		if (apiKey) writeDoclingCredential(after!, apiKey);
		else if (input.removeKey || urlChanged) writeDoclingAuth("", undefined);
	} else if (profile?.auth) {
		if (apiKey) writeProfileCredential(id, after!, apiKey);
		else if (input.removeKey || urlChanged) writeProfileCredential(id, after ?? "", undefined);
	}
	writeSection(next);
	return { ok: true, value: convertersOverview() };
}

export function importConverterProfile(profile: unknown): ServiceResult<{ id: string; replaced: boolean; overview: ConvertersOverview }> | { ok: false; error: string; errors: string[]; status: number } {
	const saved = saveCustomProfile(profile);
	if (!saved.ok) return { ok: false, error: "The profile is not valid", errors: saved.errors, status: 400 };
	return { ok: true, value: { id: customConverterId(saved.profile.id), replaced: saved.replaced === true, overview: convertersOverview() } };
}

/** Remove a custom profile file, its key, its URL, and its selection (back to the built-in reader). */
export function deleteConverterProfile(converterId: string): ServiceResult<ConvertersOverview> {
	const profileId = customProfileIdOf(converterId);
	if (profileId === undefined) return { ok: false, error: "Only your own profiles can be removed" };
	const removed = removeCustomProfile(profileId);
	writeProfileCredential(converterId, "", undefined);
	const settings = section();
	if (settings.services?.[converterId] || settings.converter === converterId) {
		const next = structuredClone(settings);
		if (next.services) delete next.services[converterId];
		if (next.converter === converterId) delete next.converter;
		writeSection(next);
	}
	return removed ? { ok: true, value: convertersOverview() } : { ok: false, error: "No such profile", status: 404 };
}

/** Run the converter test (validator.ts) on one converter with its saved settings and key. Never falls back to pdfjs. */
export async function testConverter(id: string, signal: AbortSignal): Promise<ServiceResult<ConverterValidationReport>> {
	const settings = { ...section(), converter: id };
	const resolved = resolvePdfConverter(settings, readConverterCredential, loadCustomProfile);
	if (resolved.converter.id !== id) return { ok: false, error: resolved.warnings[0]?.replace(/; the built-in reader \(pdfjs\) was used instead\.$/, ".") ?? `Unknown converter ${id}` };
	const profile = id === "docling" || id === "pdfjs" ? null : profileFor(id);
	const baseUrl = id === "docling" ? settings.docling?.baseUrl : profile ? (settings.services?.[id]?.baseUrl ?? profile.defaultBaseUrl) : undefined;
	const secret = baseUrl ? readConverterCredential(id, baseUrl) : undefined;
	const report = await validateConverter(resolved.converter, { signal, secrets: secret ? [secret] : [] });
	return { ok: true, value: report };
}
