import type { CredentialStatus } from "../../core/converter-settings.ts";
import { normalizeBaseUrl } from "../../core/settings.ts";
import { readConverterCredentials, readDoclingAuth, writeConverterCredentials } from "../../store/auth.ts";
import { readDoclingCredential } from "./auth.ts";
import type { CredentialReader } from "./registry.ts";

/**
 * Profile converter credentials (fork addition, 2026-11-25), exactly like Docling's (auth.ts): each key lives only
 * in auth.json (mode 0600) under one entry, bound to the canonical base URL it was saved for. A different URL gets no
 * key, so changing a service's URL needs the key entered again. keys.ts keeps the entry out of process.env, the
 * generic key list and child processes. No function here returns a key to a client: `credentialStatus` says only
 * whether one is stored and, for a long key, its last four characters.
 */

export function readProfileCredential(converterId: string, baseUrl: string): string | undefined {
	const canonical = normalizeBaseUrl(baseUrl);
	if (!canonical) return undefined;
	const entry = readConverterCredentials()[converterId];
	return entry && entry.baseUrl === canonical ? entry.apiKey : undefined;
}

/** Store (or, with undefined, remove) the key of `converterId`, bound to `baseUrl`. */
export function writeProfileCredential(converterId: string, baseUrl: string, apiKey: string | undefined): void {
	const all = readConverterCredentials();
	if (apiKey === undefined) {
		if (!(converterId in all)) return;
		delete all[converterId];
	} else {
		const canonical = normalizeBaseUrl(baseUrl);
		if (!canonical) throw new Error("A converter key needs an absolute HTTP(S) base URL without credentials, query or fragment");
		all[converterId] = { baseUrl: canonical, apiKey };
	}
	writeConverterCredentials(all);
}

/** The key reader conversions use: Docling's own record, every other converter's from the profile entry. */
export const readConverterCredential: CredentialReader = (converterId, baseUrl) =>
	converterId === "docling" ? readDoclingCredential(baseUrl) : readProfileCredential(converterId, baseUrl);

function status(binding: string | undefined, apiKey: string | undefined, baseUrl: string | undefined): CredentialStatus {
	if (apiKey === undefined || binding === undefined) return { stored: false };
	const canonical = baseUrl ? normalizeBaseUrl(baseUrl) : "";
	if (!canonical || canonical !== binding) return { stored: false, boundElsewhere: true };
	const key = apiKey.trim();
	return { stored: true, ...(key.length >= 20 ? { hint: `…${key.slice(-4)}` } : {}) };
}

export function credentialStatus(converterId: string, baseUrl: string | undefined): CredentialStatus {
	if (converterId === "docling") {
		const auth = readDoclingAuth();
		return status(auth.baseUrl, auth.apiKey, baseUrl);
	}
	const entry = readConverterCredentials()[converterId];
	return status(entry?.baseUrl, entry?.apiKey, baseUrl);
}
