import type { ConverterEntry, ConvertersOverview, ConverterValidationReport } from "../../core/converter-settings.ts";
import { customConverterId, customProfileIdOf, sameServiceUrl, serviceOrigin, type HttpConverterProfile } from "../../core/http-converter-spec.ts";
import { CURRENT_SETTINGS_VERSION, normalizeBaseUrl, type PdfConversionSettings } from "../../core/settings.ts";
import { writeDoclingAuth } from "../../store/auth.ts";
import { readSettings, writeSettings } from "../../store/settings.ts";
import { writeDoclingCredential } from "./auth.ts";
import { credentialStatus, geminiKeySource, readConverterCredential, readGoogleProviderKey, writeProfileCredential } from "./credentials.ts";
import {
	GEMINI_BASE_URL,
	GEMINI_CONVERTER_ID,
	GEMINI_DEFAULT_MODEL,
	GEMINI_DOCS_URL,
	GEMINI_KEY_URL,
	GEMINI_MAX_BYTES,
	GEMINI_MAX_PAGES,
	GEMINI_MODEL_SUGGESTIONS,
	GEMINI_NAME,
	GEMINI_PRIVACY_NOTE,
	GEMINI_UNVERIFIED,
	geminiModelId,
} from "./gemini.ts";
import { listCustomProfiles, loadCustomProfile, removeCustomProfile, saveCustomProfile } from "./custom-profiles.ts";
import { API_KEY_MAX_LENGTH, apiKeyProblem } from "./http-common.ts";
import { pdfjsConverter } from "./pdfjs.ts";
import { PRESET_PROFILES, presetProfile } from "./presets.ts";
import { createProfileConverter, resolvePdfConverter } from "./registry.ts";
import { selfOriginProblem } from "./self-origin.ts";
import { CONVERTER_TEST_DEADLINE_MS, validateConverter } from "./validator.ts";

export type { ConverterEntry, ConvertersOverview };

/**
 * Settings → PDF conversion, server side (fork addition, 2026-11-25), behind app/api/converters/. Non-secret
 * configuration goes to the pdfConversion settings section; keys go to the credential store (auth.json) bound to
 * the base URL, through auth.ts (Docling) and credentials.ts (profiles). Nothing here returns a key: the overview
 * says only whether one is stored for the current URL and, for a long key, its last four characters. Changing a
 * service's URL without entering a key removes the stored one, so it is never sent to the new address (URLs are
 * compared canonically).
 *
 * SETUP BEFORE USE (review 1, finding 2). A service converter is "ready" only with a SAVED service URL and, when it
 * takes a key, a key stored for that URL; a URL that is this app's own address is refused. A bundled preset's own
 * address is saved as its URL when the user chooses the preset (`select`) or saves its key, on the screen that shows
 * that address. `select` (Settings: "Use for new PDFs") refuses a converter that is not ready, with the step that is
 * missing. A key shorter than API_KEY_MIN_LENGTH, or with characters a header cannot carry, is refused when saved.
 *
 * GOOGLE AI STUDIO (gemini.ts, 2026-11-25) has one fixed address and no URL field. Its own key is stored like a
 * profile's, bound to that address; without one, the Google model provider's key (GEMINI_API_KEY) is used and the
 * overview says so (`credential.provider`), never copying it. Its model id is the one other setting.
 */

function section(): PdfConversionSettings {
	return readSettings()?.pdfConversion ?? {};
}

function writeSection(next: PdfConversionSettings): void {
	const record = readSettings() ?? { version: CURRENT_SETTINGS_VERSION };
	writeSettings({ ...record, pdfConversion: next });
}

/** The URL a profile converter would use: the saved one, else (a bundled preset only) its own address. */
function effectiveUrl(kind: "preset" | "custom", profile: HttpConverterProfile, settings: PdfConversionSettings, id: string): string | undefined {
	return settings.services?.[id]?.baseUrl ?? (kind === "preset" ? profile.defaultBaseUrl : undefined);
}

/** Why a service converter with this URL and key state would not send anything, or undefined when it would. */
function setupProblem(name: string, url: string | undefined, needsKey: boolean, keyStored: boolean): string | undefined {
	if (!url) return `Save the ${name} service URL first.`;
	const self = selfOriginProblem(url);
	if (self) return `${self}. Enter the address of the service.`;
	if (needsKey && !keyStored) return `Save its API key first.`;
	return undefined;
}

function profileEntry(id: string, kind: "preset" | "custom", profile: HttpConverterProfile, settings: PdfConversionSettings): ConverterEntry {
	const baseUrl = settings.services?.[id]?.baseUrl;
	const effective = effectiveUrl(kind, profile, settings, id);
	const origin = serviceOrigin(effective);
	const credential = profile.auth ? credentialStatus(id, effective) : { stored: false };
	// the upload path uses only a SAVED address (registry.ts), so a converter that is in use without one is not set up,
	// whatever a preset's bundled address would allow (settings edited by hand, or written by an older build)
	const unsaved = settings.converter === id && !baseUrl && !!effective;
	const setup = setupProblem(profile.name, effective, !!profile.auth, credential.stored) ?? (unsaved ? `Save the service URL (${effective}) to confirm it.` : undefined);
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
		ready: setup === undefined,
		...(setup ? { setup } : {}),
		key: profile.auth ? "required" : "none",
		credential,
		...(profile.limits ? { limits: profile.limits } : {}),
	};
}

function geminiEntry(settings: PdfConversionSettings): ConverterEntry {
	const own = credentialStatus(GEMINI_CONVERTER_ID, GEMINI_BASE_URL);
	const source = geminiKeySource();
	const model = geminiModelId(settings.gemini?.model) ? settings.gemini?.model : undefined;
	const setup = source ? undefined : "Save a Gemini API key first (or add a Google key under model providers).";
	return {
		id: GEMINI_CONVERTER_ID,
		kind: "gemini",
		name: GEMINI_NAME,
		description: "Google's Gemini models read the PDF itself: scanned pages, tables, formulas and diagrams. Free tier with daily limits; needs an AI Studio API key.",
		local: false,
		...(GEMINI_UNVERIFIED ? { unverified: true } : {}),
		docsUrl: GEMINI_DOCS_URL,
		baseUrl: GEMINI_BASE_URL,
		origin: GEMINI_BASE_URL,
		fixedUrl: true,
		ready: setup === undefined,
		...(setup ? { setup } : {}),
		key: "required",
		credential: { ...own, ...(source === "provider" ? { provider: true } : {}) },
		keyUrl: GEMINI_KEY_URL,
		privacyNote: GEMINI_PRIVACY_NOTE,
		model: { ...(model ? { value: model } : {}), default: GEMINI_DEFAULT_MODEL, suggestions: [...GEMINI_MODEL_SUGGESTIONS] },
		limits: { maxBytes: GEMINI_MAX_BYTES, maxPages: GEMINI_MAX_PAGES },
	};
}

export function convertersOverview(): ConvertersOverview {
	const settings = section();
	const doclingUrl = settings.docling?.baseUrl;
	const custom = listCustomProfiles();
	const doclingSetup = setupProblem("Docling", doclingUrl, false, false);
	return {
		selected: settings.converter ?? pdfjsConverter.id,
		converters: [
			{ id: "pdfjs", kind: "builtin", name: "Built-in reader", description: "Reads the text layer of a PDF on this computer. No setup, no OCR: scanned pages come out empty.", local: true, ready: true, key: "none", credential: { stored: false } },
			{
				id: "docling",
				kind: "docling",
				name: "Docling (self-hosted)",
				description: "A Docling Serve instance you run yourself, with OCR and formula recognition.",
				local: false,
				docsUrl: "https://github.com/docling-project/docling-serve",
				...(doclingUrl ? { baseUrl: doclingUrl, origin: new URL(doclingUrl).origin } : {}),
				ready: doclingSetup === undefined,
				...(doclingSetup ? { setup: doclingSetup } : {}),
				key: "optional",
				credential: credentialStatus("docling", doclingUrl),
				options: { ocr: settings.docling?.ocr ?? true, formulaEnrichment: settings.docling?.formulaEnrichment ?? false },
			},
			geminiEntry(settings),
			...PRESET_PROFILES.map((p) => profileEntry(p.id, "preset", p, settings)),
			...custom.profiles.map((p) => profileEntry(customConverterId(p.id), "custom", p, settings)),
		],
		invalidProfiles: custom.invalid,
	};
}

export interface ConfigureConverterInput {
	id: string;
	/** Make it the converter uploads use ("Use for new PDFs"); refused unless it is ready. */
	select?: boolean;
	/** "" clears it (nothing is sent until a URL is saved again). */
	baseUrl?: string;
	/** A new key, bound to the (new) base URL. Never returned. */
	apiKey?: string;
	removeKey?: boolean;
	/** Docling only. */
	ocr?: boolean;
	formulaEnrichment?: boolean;
	/** Google AI Studio only: the model id ("" goes back to the default). */
	model?: string;
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
	const allowed = new Set(["id", "select", "baseUrl", "apiKey", "removeKey", "ocr", "formulaEnrichment", "model"]);
	const unknown = Object.keys(raw).find((k) => !allowed.has(k));
	if (unknown) return { ok: false, error: `unknown field ${unknown}` };
	if (typeof raw.id !== "string" || !raw.id) return { ok: false, error: "id must be a converter id" };
	for (const flag of ["select", "removeKey", "ocr", "formulaEnrichment"] as const) {
		if (raw[flag] !== undefined && typeof raw[flag] !== "boolean") return { ok: false, error: `${flag} must be true or false` };
	}
	if (raw.baseUrl !== undefined && typeof raw.baseUrl !== "string") return { ok: false, error: "baseUrl must be a URL" };
	if (raw.apiKey !== undefined) {
		if (typeof raw.apiKey !== "string" || raw.apiKey.length > API_KEY_MAX_LENGTH || /[\r\n\0]/.test(raw.apiKey)) return { ok: false, error: "apiKey must be one line of text" };
	}
	if (raw.model !== undefined && (typeof raw.model !== "string" || raw.model.length > 100)) return { ok: false, error: "model must be a model id" };
	return { ok: true, value: raw as unknown as ConfigureConverterInput };
}

/** Google AI Studio: its key (bound to the fixed address), its model, `select`. */
function configureGemini(input: ConfigureConverterInput, settings: PdfConversionSettings): ServiceResult<ConvertersOverview> {
	if (input.baseUrl !== undefined) return { ok: false, error: `${GEMINI_NAME} has a fixed address; there is no URL to set` };
	if (input.ocr !== undefined || input.formulaEnrichment !== undefined) return { ok: false, error: "Only Docling has OCR and formula options" };
	const apiKey = input.apiKey?.trim() || undefined;
	if (apiKey) {
		const problem = apiKeyProblem(apiKey);
		if (problem) return { ok: false, error: `${problem}. Nothing was saved.` };
	}
	const next: PdfConversionSettings = structuredClone(settings);
	if (input.model !== undefined) {
		const typed = input.model.trim().replace(/^models\//, "");
		if (typed && !geminiModelId(typed)) return { ok: false, error: "The model id may hold only lowercase letters, digits, dots and dashes (for example gemini-3.8-flash). Nothing was saved." };
		next.gemini = typed && typed !== GEMINI_DEFAULT_MODEL ? { ...settings.gemini, model: typed } : (({ model: _drop, ...rest }) => rest)(settings.gemini ?? {});
	}
	if (input.select) {
		const keyAfter = !!apiKey || (!input.removeKey && geminiKeySource() === "own") || readGoogleProviderKey() !== undefined;
		if (!keyAfter) return { ok: false, error: `${GEMINI_NAME} cannot be used yet: Save a Gemini API key first (or add a Google key under model providers).`, status: 409 };
		next.converter = GEMINI_CONVERTER_ID;
	}
	if (apiKey) writeProfileCredential(GEMINI_CONVERTER_ID, GEMINI_BASE_URL, apiKey);
	else if (input.removeKey) writeProfileCredential(GEMINI_CONVERTER_ID, GEMINI_BASE_URL, undefined);
	writeSection(next);
	return { ok: true, value: convertersOverview() };
}

export function configureConverter(input: ConfigureConverterInput): ServiceResult<ConvertersOverview> {
	const { id } = input;
	const settings = section();
	if (id === GEMINI_CONVERTER_ID) return configureGemini(input, settings);
	if (input.model !== undefined) return { ok: false, error: `Only ${GEMINI_NAME} has a model setting` };
	const isDocling = id === "docling";
	const bundled = presetProfile(id) !== undefined;
	const profile = isDocling || id === "pdfjs" ? null : profileFor(id);
	if (!isDocling && id !== "pdfjs" && !profile) {
		return { ok: false, error: profile === undefined ? `The converter profile ${id} is missing or not valid` : `Unknown converter ${id}`, status: profile === undefined ? 409 : 400 };
	}
	const apiKey = input.apiKey?.trim() || undefined;
	if (id === "pdfjs" && (input.baseUrl !== undefined || apiKey || input.removeKey)) return { ok: false, error: "The built-in reader has no URL or key" };
	if (!isDocling && (input.ocr !== undefined || input.formulaEnrichment !== undefined)) return { ok: false, error: "Only Docling has OCR and formula options" };
	if (profile && !profile.auth && apiKey) return { ok: false, error: `${profile.name} takes no key` };
	if (apiKey) {
		const problem = apiKeyProblem(apiKey);
		if (problem) return { ok: false, error: `${problem}. Nothing was saved.` };
	}

	let baseUrl: string | undefined;
	if (input.baseUrl !== undefined && input.baseUrl.trim()) {
		baseUrl = normalizeBaseUrl(input.baseUrl);
		if (!baseUrl) return { ok: false, error: "The URL must be an absolute HTTP(S) address without credentials, query or fragment" };
		const self = selfOriginProblem(baseUrl);
		if (self) return { ok: false, error: `${self}. Nothing was saved.` };
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
		before = settings.services?.[id]?.baseUrl;
		after = before;
		if (input.baseUrl !== undefined) after = baseUrl;
		// A preset's own address is saved once the user chooses it, or saves its key, on the screen that shows it.
		else if (bundled && !before && profile.defaultBaseUrl && (input.select || apiKey)) after = profile.defaultBaseUrl;
		if (!sameServiceUrl(before, after) || input.baseUrl !== undefined) {
			const services = { ...settings.services };
			Object.defineProperty(services, id, { value: after ? { baseUrl: after } : {}, enumerable: true, configurable: true, writable: true });
			next.services = services;
		}
	}
	if (apiKey && !after) return { ok: false, error: "Enter the service URL before its key: the key is bound to it" };

	const urlChanged = !sameServiceUrl(before, after);
	if (input.select) {
		if (id !== "pdfjs") {
			const keyAfter = apiKey !== undefined || (!input.removeKey && !urlChanged && !!after && readConverterCredential(id, after) !== undefined);
			const problem = setupProblem(isDocling ? "Docling" : profile!.name, after, !isDocling && !!profile?.auth, keyAfter);
			if (problem) return { ok: false, error: `${isDocling ? "Docling" : profile!.name} cannot be used yet: ${problem}`, status: 409 };
		}
		next.converter = id;
	}

	// Keys first, each bound to the URL it is for; a crash between the two writes never sends a key to another URL.
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

/**
 * Why a write of the whole pdfConversion section through the generic settings route (PUT /api/settings/pdfConversion)
 * is refused, or undefined: it may not change a service URL (Docling's or a profile's), because only
 * configureConverter re-approves the key bound to a URL. URLs are compared canonically.
 */
export function pdfConversionUrlChange(before: PdfConversionSettings | undefined, after: PdfConversionSettings): string | undefined {
	const refusal = "Service URLs are changed in Settings → PDF conversion, which also removes the key saved for the old address";
	if (!sameServiceUrl(before?.docling?.baseUrl, after.docling?.baseUrl)) return refusal;
	const ids = new Set([...Object.keys(before?.services ?? {}), ...Object.keys(after.services ?? {})]);
	for (const id of ids) if (!sameServiceUrl(before?.services?.[id]?.baseUrl, after.services?.[id]?.baseUrl)) return refusal;
	return undefined;
}

export function importConverterProfile(profile: unknown): ServiceResult<{ id: string; replaced: boolean; deselected?: boolean; overview: ConvertersOverview }> | { ok: false; error: string; errors: string[]; status: number } {
	const saved = saveCustomProfile(profile);
	if (!saved.ok) return { ok: false, error: "The profile is not valid", errors: saved.errors, status: 400 };
	const id = customConverterId(saved.profile.id);
	// a replaced profile is a different set of requests to the same address: if it was in use it stops being used until
	// the user has looked at it again and chosen it (its saved URL and key stay; they are bound to the address)
	const settings = section();
	const deselected = saved.replaced === true && settings.converter === id;
	if (deselected) {
		const next = structuredClone(settings);
		delete next.converter;
		writeSection(next);
	}
	return { ok: true, value: { id, replaced: saved.replaced === true, ...(deselected ? { deselected: true } : {}), overview: convertersOverview() } };
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

/**
 * Run the converter test (validator.ts) on one converter with its saved settings and key. Never falls back to pdfjs.
 * A custom profile's file is read once. The whole test is bounded by CONVERTER_TEST_DEADLINE_MS and stops when
 * `signal` aborts (the request closed).
 */
export async function testConverter(id: string, signal: AbortSignal, deadlineMs = CONVERTER_TEST_DEADLINE_MS): Promise<ServiceResult<ConverterValidationReport>> {
	const settings = { ...section(), converter: id };
	let resolved: { converter: import("../../core/pdf-converter.ts").PdfConverter; secret?: string };
	const customId = customProfileIdOf(id);
	if (customId !== undefined) {
		const loaded = loadCustomProfile(customId);
		if (!loaded.ok) return { ok: false, error: `Your PDF converter profile "${customId}" cannot be used (${loaded.error}).` };
		try {
			const converter = createProfileConverter(id, loaded.profile, settings, readConverterCredential);
			const url = settings.services?.[id]?.baseUrl;
			resolved = { converter, secret: url ? readConverterCredential(id, url) : undefined };
		} catch (error) {
			return { ok: false, error: `${(error as Error).message}.` };
		}
	} else {
		const result = resolvePdfConverter(settings, readConverterCredential);
		if (result.converter.id !== id) return { ok: false, error: result.warnings[0]?.replace(/; the built-in reader \(pdfjs\) was used instead\.$/, ".") ?? `Unknown converter ${id}` };
		const url = id === "docling" ? settings.docling?.baseUrl : id === GEMINI_CONVERTER_ID ? GEMINI_BASE_URL : presetProfile(id) ? settings.services?.[id]?.baseUrl : undefined;
		resolved = { converter: result.converter, secret: url ? readConverterCredential(id, url) : undefined };
	}
	const report = await validateConverter(resolved.converter, { signal, secrets: resolved.secret ? [resolved.secret] : [], deadlineMs });
	return { ok: true, value: report };
}
