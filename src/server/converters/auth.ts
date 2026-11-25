import { CURRENT_SETTINGS_VERSION, normalizeBaseUrl } from "../../core/settings.ts";
import { apiKeyProblem } from "./http-common.ts";
import { readDoclingAuth, writeDoclingAuth } from "../../store/auth.ts";
import { readSettings, writeSettings } from "../../store/settings.ts";

/**
 * The Docling credential (fork addition, 2026-11-24). The key lives only in
 * auth.json (mode 0600), bound to the canonical base URL it was saved for: a
 * different URL in the settings gets no key. keys.ts keeps both entries out
 * of process.env, the generic key list and child processes.
 */

export function readDoclingCredential(baseUrl: string): string | undefined {
	const canonical = normalizeBaseUrl(baseUrl);
	if (!canonical) return undefined;
	const auth = readDoclingAuth();
	return auth.baseUrl === canonical ? auth.apiKey : undefined;
}

/** Store (or, with undefined, remove) the key bound to `baseUrl`. */
export function writeDoclingCredential(baseUrl: string, apiKey: string | undefined): void {
	const canonical = normalizeBaseUrl(baseUrl);
	if (!canonical) throw new Error("Docling needs an absolute HTTP(S) base URL without credentials, query or fragment");
	writeDoclingAuth(canonical, apiKey);
}

/**
 * Point the app at a Docling service: the key (bound to the URL; an empty or absent key removes it) and the
 * pdfConversion settings section (the URL, other options kept; `select` makes Docling the converter). Returns the
 * canonical URL. The settings screen of a later package and scripts/docling-credential.ts call this.
 */
export function configureDocling(input: { baseUrl: string; apiKey?: string; select?: boolean }): string {
	const canonical = normalizeBaseUrl(input.baseUrl);
	if (!canonical) throw new Error("Docling needs an absolute HTTP(S) base URL without credentials, query or fragment");
	const keyProblem = input.apiKey?.trim() ? apiKeyProblem(input.apiKey) : undefined;
	if (keyProblem) throw new Error(`${keyProblem}; nothing was saved`);
	writeDoclingCredential(canonical, input.apiKey?.trim() ? input.apiKey.trim() : undefined);
	const record = readSettings() ?? { version: CURRENT_SETTINGS_VERSION };
	const section = record.pdfConversion ?? {};
	writeSettings({
		...record,
		pdfConversion: {
			...section,
			...(input.select === false ? {} : { converter: "docling" }),
			docling: { ...section.docling, baseUrl: canonical },
		},
	});
	return canonical;
}
