import { AUTH_PROVIDER_KEYS } from "../../core/auth-keys.ts";
import type { CredentialStatus } from "../../core/converter-settings.ts";
import { normalizeBaseUrl } from "../../core/settings.ts";
import { authStore, readConverterCredentials, readDoclingAuth, writeConverterCredentials } from "../../store/auth.ts";
import { readDoclingCredential } from "./auth.ts";
import { GEMINI_BASE_URL, GEMINI_CONVERTER_ID } from "./gemini.ts";
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

/** The model provider key the Gemini converter may borrow (the "google" provider's env var, GEMINI_API_KEY). */
export const GOOGLE_PROVIDER_ENV_VAR = AUTH_PROVIDER_KEYS.find((p) => p.id === "google")!.envVar;

/**
 * The Google model provider's key, read the way server/keys.ts keyValue reads it (the real environment first, then
 * auth.json; with LH_IGNORE_ENV_KEYS=1 auth.json only), without importing that module (its import has side
 * effects). Read only, at the moment of use: it is never copied into the converter credentials or anywhere else.
 */
export function readGoogleProviderKey(): string | undefined {
	const fromFile = () => authStore.authVars()[GOOGLE_PROVIDER_ENV_VAR];
	const value = process.env.LH_IGNORE_ENV_KEYS === "1" ? fromFile() : (process.env[GOOGLE_PROVIDER_ENV_VAR] ?? fromFile());
	return value?.trim() ? value.trim() : undefined;
}

/** Where the Gemini converter's key comes from: its own (bound to the Gemini API's address), else the provider's. */
export function geminiKeySource(baseUrl = GEMINI_BASE_URL): "own" | "provider" | undefined {
	if (readProfileCredential(GEMINI_CONVERTER_ID, baseUrl) !== undefined) return "own";
	return normalizeBaseUrl(baseUrl) === normalizeBaseUrl(GEMINI_BASE_URL) && readGoogleProviderKey() !== undefined ? "provider" : undefined;
}

/**
 * The key reader conversions use: Docling's own record, every other converter's from the profile entry. Gemini
 * without a key of its own uses the Google model provider's key (only for the Gemini API's own address).
 */
export const readConverterCredential: CredentialReader = Object.assign(
	(converterId: string, baseUrl: string): string | undefined => {
		if (converterId === "docling") return readDoclingCredential(baseUrl);
		if (converterId === GEMINI_CONVERTER_ID) {
			const source = geminiKeySource(baseUrl);
			return source === "own" ? readProfileCredential(converterId, baseUrl) : source === "provider" ? readGoogleProviderKey() : undefined;
		}
		return readProfileCredential(converterId, baseUrl);
	},
	{ sourceOf: (converterId: string, baseUrl: string) => (converterId === GEMINI_CONVERTER_ID ? geminiKeySource(baseUrl) : undefined) },
);

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
