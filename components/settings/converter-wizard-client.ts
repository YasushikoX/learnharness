import type { ConverterDraftView, ConverterDraftsOverview, ConvertersOverview } from "../../src/core/index.ts";

/**
 * The connector wizard's requests (fork addition, 2026-11-25; app/api/converters/drafts/). None throws; each answers
 * its value or an error sentence. A key is only ever sent, never received.
 */

/** The client's own limit for a draft's Test: the server's two-minute deadline plus time for its answer. */
export const DRAFT_TEST_CLIENT_TIMEOUT_MS = 2 * 60_000 + 15_000;

type Answer<T> = { value: T | null; error: string | null; errors: string[]; aborted?: boolean };

async function call<T>(url: string, init: RequestInit | undefined, fallback: string): Promise<Answer<T>> {
	try {
		const res = await fetch(url, { cache: "no-store", ...init });
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { error?: string; errors?: string[] };
			return { value: null, error: body.error ?? `${fallback} (${res.status})`, errors: Array.isArray(body.errors) ? body.errors : [] };
		}
		return { value: (await res.json()) as T, error: null, errors: [] };
	} catch {
		return { value: null, error: fallback, errors: [], ...(init?.signal?.aborted ? { aborted: true } : {}) };
	}
}

const json = (method: string, body: unknown, signal?: AbortSignal): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });

export const loadDrafts = () => call<ConverterDraftsOverview>("/api/converters/drafts", undefined, "Could not load the drafts");

export interface NewDraft {
	serviceName: string;
	docsUrl?: string;
	docsText?: string;
	sample?: string;
}

export const createDraft = (input: NewDraft, signal?: AbortSignal) => call<ConverterDraftView>("/api/converters/drafts", json("POST", input, signal), "The draft could not be written");

export interface DraftChange {
	id: string;
	baseUrl?: string;
	apiKey?: string;
	removeKey?: boolean;
	profile?: string;
}

export const updateDraft = (change: DraftChange) => call<ConverterDraftView>("/api/converters/drafts", json("PUT", change), "Could not save");

export const testDraft = (id: string, signal?: AbortSignal) => call<ConverterDraftView>("/api/converters/drafts/test", json("POST", { id }, signal), "The test could not run");

export const fixDraft = (id: string, signal?: AbortSignal) => call<ConverterDraftView>("/api/converters/drafts/fix", json("POST", { id }, signal), "The fix could not be written");

export const approveDraft = (id: string, shown: string, acknowledged: boolean) =>
	call<{ id: string; overview: ConvertersOverview }>("/api/converters/drafts/approve", json("POST", { id, shown, acknowledged }), "Could not approve the draft");

export const discardDraft = (id: string) => call<ConverterDraftsOverview>(`/api/converters/drafts?id=${encodeURIComponent(id)}`, { method: "DELETE" }, "Could not discard the draft");
