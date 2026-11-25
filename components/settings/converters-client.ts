import type { ConvertersOverview, ConverterValidationReport } from "../../src/core/index.ts";

/**
 * Settings → PDF conversion's requests (fork addition, 2026-11-25), apart from the component so they are tested
 * without a DOM. None throws; each answers its value or an error sentence. A key is only ever sent, never received.
 */

async function errorOf(res: Response, fallback: string): Promise<{ error: string; errors: string[] }> {
	const body = (await res.json().catch(() => ({}))) as { error?: string; errors?: string[] };
	return { error: body.error ?? `${fallback} (${res.status})`, errors: Array.isArray(body.errors) ? body.errors : [] };
}

async function call<T>(url: string, init: RequestInit | undefined, fallback: string): Promise<{ value: T | null; error: string | null; errors: string[] }> {
	try {
		const res = await fetch(url, { cache: "no-store", ...init });
		if (!res.ok) return { value: null, ...(await errorOf(res, fallback)) };
		return { value: (await res.json()) as T, error: null, errors: [] };
	} catch {
		return { value: null, error: fallback, errors: [] };
	}
}

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const loadConverters = () => call<ConvertersOverview>("/api/converters", undefined, "Could not load the PDF conversion settings");

export interface ConverterChange {
	id: string;
	select?: boolean;
	baseUrl?: string;
	apiKey?: string;
	removeKey?: boolean;
	ocr?: boolean;
	formulaEnrichment?: boolean;
}

export const saveConverter = (change: ConverterChange) => call<ConvertersOverview>("/api/converters", json("PUT", change), "Could not save");

export const runConverterTest = (id: string, signal?: AbortSignal) =>
	call<ConverterValidationReport>("/api/converters/test", { ...json("POST", { id }), ...(signal ? { signal } : {}) }, "The test could not run");

export const importProfile = (text: string) =>
	call<{ id: string; replaced: boolean; overview: ConvertersOverview }>("/api/converters/profiles", json("POST", { profile: text }), "Could not import the profile");

export const removeProfile = (id: string) => call<ConvertersOverview>(`/api/converters/profiles?id=${encodeURIComponent(id)}`, { method: "DELETE" }, "Could not remove the profile");
