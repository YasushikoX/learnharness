import { normalizeBaseUrl } from "../../core/settings.ts";
import { readDoclingAuth, writeDoclingAuth } from "../../store/auth.ts";

export function readDoclingCredential(baseUrl: string): string | undefined {
	const canonical = normalizeBaseUrl(baseUrl);
	if (!canonical) return undefined;
	const auth = readDoclingAuth();
	return auth.baseUrl === canonical ? auth.apiKey : undefined;
}

export function writeDoclingCredential(baseUrl: string, apiKey: string | undefined): void {
	const canonical = normalizeBaseUrl(baseUrl);
	if (!canonical) throw new Error("Docling requires an absolute HTTP(S) base URL without credentials, query, or fragment");
	writeDoclingAuth(canonical, apiKey);
}
