import { HTTP_CONVERTER_PROFILE_FORMAT, validateHttpConverterProfile, type HttpConverterProfile } from "../../core/http-converter-spec.ts";

/**
 * Bundled converter profiles ("presets", fork addition, 2026-11-25): hosted services described entirely in the
 * declarative profile format (core/http-converter-spec.ts), interpreted by http-declarative.ts like any custom
 * profile. Each is validated when this module loads; an invalid preset is a programming error.
 *
 * MISTRAL OCR — unverified: written from Mistral's public API reference (read 2026-11-25) without a real call.
 *   POST https://api.mistral.ai/v1/ocr, `Authorization: Bearer <key>`, JSON body
 *   { model, document: { type: "document_url", document_url }, include_image_base64 }, synchronous answer
 *   { pages: [{ index, markdown, … }], model, usage_info }.
 *   Assumptions that only a real call can settle (Settings → PDF conversion → Test does):
 *     - a PDF is accepted as a base64 data URL `data:application/pdf;base64,…` in `document_url` (the reference
 *       shows the data-URL form only for images);
 *     - `index` counts from 0 (the reference's schema says so; its example starts at 1: if the service counts from
 *       1, the last page lands out of range and the host's normaliser refuses the answer, no shift);
 *     - the alias `mistral-ocr-latest` stays valid;
 *     - limits of 50 MB and 1,000 pages (not stated in the reference; from memory).
 *   Its key is the preset's own, bound to the base URL in auth.json; the MISTRAL_API_KEY model-provider key is not
 *   reused, because provider keys are reflected into process.env and so reach child processes.
 */

export const MISTRAL_OCR_PRESET: HttpConverterProfile = {
	format: HTTP_CONVERTER_PROFILE_FORMAT,
	id: "mistral-ocr",
	name: "Mistral OCR",
	version: "1",
	description: "Mistral's hosted OCR API. Reads scanned pages, tables and formulas. Needs a Mistral API key; billed by Mistral per page.",
	docsUrl: "https://docs.mistral.ai/api/endpoint/ocr",
	defaultBaseUrl: "https://api.mistral.ai",
	unverified: true,
	auth: { header: "Authorization", value: "Bearer {{API_KEY}}" },
	limits: { maxBytes: 50 * 1024 * 1024, maxPages: 1000 },
	submit: {
		method: "POST",
		path: "/v1/ocr",
		body: {
			type: "json-base64",
			filePointer: "/document/document_url",
			encoding: "data-url",
			json: { model: "mistral-ocr-latest", document: { type: "document_url" }, include_image_base64: false },
		},
	},
	extract: { type: "pages", pagesPointer: "/pages", numberPointer: "/index", numberBase: 0, markdownPointer: "/markdown" },
};

export const PRESET_PROFILES: readonly HttpConverterProfile[] = [MISTRAL_OCR_PRESET];

for (const preset of PRESET_PROFILES) {
	const checked = validateHttpConverterProfile(preset, { bundled: true });
	if (!checked.ok) throw new Error(`Invalid converter preset ${preset.id}: ${checked.errors.join("; ")}`);
}

/** A bundled preset by id (the only profiles that may carry defaultBaseUrl). */
export function presetProfile(id: string): HttpConverterProfile | undefined {
	return PRESET_PROFILES.find((p) => p.id === id);
}
