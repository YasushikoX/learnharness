import { randomUUID } from "node:crypto";
import { MATERIAL_MAX_BYTES } from "../../core/materials.ts";
import { GEMINI_MODEL_SETTING } from "../../core/settings.ts";
import { ConverterError, PDF_MAX_PAGES, type ConvertContext, type ConvertResult, type PageResult, type PdfConverter } from "../../core/pdf-converter.ts";
import {
	CONVERTER_REQUEST_TIMEOUT_MS,
	CONVERTER_UPLOAD_TIMEOUT_MS,
	asRecord,
	badResponse,
	buildHeaders,
	classifyConverterFailure,
	delay,
	httpStatusError,
	readCapped,
	redactConversion,
	redactError,
	runConverterJob,
	serviceMessage,
	storedKeyProblem,
	type ConverterJob as Job,
} from "./http-common.ts";

/**
 * The Google AI Studio (Gemini API) PDF converter (fork addition, 2026-11-25). A code converter, not a declarative
 * profile: the PDF goes into `contents[].parts[]` as an uploaded file, which the profile format cannot express.
 *
 * CHECKED IN GOOGLE'S DOCS ON 2026-11-25 (US Pacific; aistudio.google.com/docs, which ai.google.dev/gemini-api/docs
 * now redirects to), written WITHOUT a real call (so the converter is marked unverified until one is made):
 *   - document-processing: PDFs up to 50 MB and 1,000 pages, inline or through the Files API (the limits cover the
 *     whole file also when only some pages are selected); ~560 tokens a page at the default resolution on Gemini 3/4,
 *     258 on Gemini 2.5. Page selection ("slicing") is 1-based and inclusive, for "Gemini 3 and Gemini 4 models"; only
 *     the selected pages are billed. That page shows it for the Interactions API only (`processing.page_options`).
 *   - api-reference generate-content: POST /v1beta/models/{model}:generateContent. A Part holds `fileData { fileUri,
 *     mimeType }` and, beside it, `documentMetadata { startPage, endPage, contentLayers: PAGE_IMAGE | PAGE_TEXT }`
 *     (1-indexed, inclusive; the layers default to PAGE_IMAGE). candidates[].finishReason: STOP, MAX_TOKENS, SAFETY,
 *     RECITATION, LANGUAGE, OTHER, BLOCKLIST, PROHIBITED_CONTENT, SPII, …; promptFeedback.blockReason when the prompt
 *     was blocked and no candidate is returned. Nothing there says generateContent is deprecated (Google points new
 *     work at its Interactions API). thinkingConfig.thinkingLevel: "Recommended for Gemini 3 or later models. Use
 *     with earlier models results in an error", so it is sent only to Gemini 3 and later.
 *   - files: resumable upload, POST /upload/v1beta/files with X-Goog-Upload-Protocol resumable, -Command start,
 *     -Header-Content-Length, -Header-Content-Type and a JSON `{ file: { display_name } }`; the upload URL comes back
 *     in the `x-goog-upload-url` header; the bytes go there with X-Goog-Upload-Offset 0 and X-Goog-Upload-Command
 *     "upload, finalize"; the answer is `{ file: { name, uri, … } }`, while GET /v1beta/{name} answers the file
 *     itself. DELETE /v1beta/{name}. Files are kept 48 hours; file URIs work with v1 and v1beta.
 *   - v1beta discovery schema (generativelanguage.googleapis.com/$discovery/rest?version=v1beta, checked 2026-11-25):
 *     File.name may be chosen by the caller on create ("files/" + up to 40 lowercase letters, digits or dashes, not
 *     starting or ending with a dash; "If the name is empty on create, a unique name will be generated"), so this
 *     client names the upload itself and can delete it even when the finalize answer is lost. File.state is
 *     STATE_UNSPECIFIED ("used if the state is omitted"), PROCESSING ("cannot be used for inference yet"), ACTIVE or
 *     FAILED (with `error`): only ACTIVE starts inference. PromptFeedback.blockReason: "If set, the prompt was blocked
 *     and no candidates are returned"; an answer with neither is a protocol error. The resumable session's query
 *     command (X-Goog-Upload-Command: query; X-Goog-Upload-Status active|final, X-Goog-Upload-Size-Received) is
 *     Google's resumable upload protocol as its SDKs use it, unverified here.
 *   - thinking: gemini-3.8-flash takes low/medium/high (no minimal); 3.6-flash, 3.5-flash-lite: minimal…high;
 *     gemini-4-hydrogen: low…xhigh. LOW is accepted by all of them. maxOutputTokens includes thinking tokens; Gemini 4
 *     caps a synchronous answer at 65,536 tokens.
 *   - api-errors / troubleshooting: 400 invalid request; 400 failed_precondition (e.g. billing; the free tier is not
 *     offered everywhere); 401 bad or missing key; 402 prepaid credit used up; 403 permission denied (a blocked or
 *     leaked key, FREE_TIER_VERIFICATION_REQUIRED, a restricted project); 404 unknown model; 429 per-minute limit
 *     (`rate_limit_exceeded`) or daily quota (`quota_exceeded`, "wait until the quota resets"); 500/503 retry; 504
 *     deadline. Retry 429, 408 and 5xx with exponential backoff; never 400, 402, 403. NOT documented there (from
 *     Google's v1beta error format in practice, so unverified): an invalid key as 400 with ErrorInfo reason
 *     API_KEY_INVALID, and a 429 body with google.rpc.RetryInfo `retryDelay` ("31s") and google.rpc.QuotaFailure
 *     violations whose quotaId names the window ("…PerDay…", "…PerMinute…"). Without either this client backs off
 *     exponentially.
 *   - rate-limits: RPM, TPM and RPD, per project (not per key); RPD resets at midnight Pacific time. The free-tier
 *     numbers are shown only in AI Studio, which is why batches run one at a time.
 *   - pricing: gemini-3.8-flash (the default here), gemini-3.6-flash, gemini-3.5-flash-lite, gemini-3.1-flash-lite
 *     and gemini-4-hydrogen have a free tier; gemini-4-carbon/argon/neon do not. gemini-2.5-flash is deprecated and
 *     rerouted to gemini-3.5-flash-lite from 2026-12-01. Free tier: "Content used to improve our products".
 *   - terms (effective 2026-03-23): on Unpaid Services Google uses submitted content and responses to improve its
 *     products and human reviewers may read them: "Do not submit sensitive, confidential, or personal information to
 *     the Unpaid Services". (Users in the EEA, Switzerland and the UK get the paid-service data terms.)
 *
 * FLOW. One upload per PDF (Files API, under a name this client picks), waited on until ACTIVE, then one generateContent per batch of pages, in
 * order, one at a time (free-tier limits). Each answer must hold one exact marker line per page of its batch
 * (`<<<PAGE n>>>`, physical page numbers); a reply that hit MAX_TOKENS, or whose markers are missing, duplicated,
 * out of order or out of range, is split in half and asked again, down to single pages; a single page that still
 * fails (twice for a marker problem) is `empty` with the reason. SAFETY, RECITATION and the other refusals isolate the
 * page the same way and leave only it `empty`. Page numbers are never guessed or shifted. The uploaded file is
 * deleted at the end, also after a failure or an abort (best effort, with its own short timeout).
 *
 * ERRORS. 401/403 and an invalid key are `auth`; network failures and 5xx (after two retries) are `unreachable`, so
 * the registry falls back to the built-in reader; the job deadline is `timeout`; ctx.signal is `aborted`. A
 * per-minute 429 waits (Retry-After, RetryInfo, else backoff) and tries again, a bounded number of times; a daily
 * quota, or a wait longer than GEMINI_MAX_RATE_LIMIT_WAIT_MS, fails at once with `rate_limit` and says when to retry.
 *
 * SECRETS. The key is sent only in the `x-goog-api-key` header, never in a URL. It and the upload session URL are
 * removed from every message and every answer (http-common.ts redactSecrets) and the key is never logged.
 */

export const GEMINI_CONVERTER_ID = "gemini";
export const GEMINI_NAME = "Google AI Studio (Gemini)";
/** The Gemini API's address; the converter's key is bound to it in the credential store. */
export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
export const GEMINI_KEY_URL = "https://aistudio.google.com/apikey";
export const GEMINI_DOCS_URL = "https://aistudio.google.com/docs/document-processing";
/** A current Flash model with a free tier (pricing page, 2026-11-25). Gemini 4 Neon has none. */
export const GEMINI_DEFAULT_MODEL = "gemini-3.8-flash";
/** Offered in Settings; any other model id may be typed. All have a free tier (pricing page, 2026-11-25). */
export const GEMINI_MODEL_SUGGESTIONS = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-4-hydrogen"] as const;
/** A model id as Google writes them (letters, digits, dots, dashes; an optional `models/` prefix is removed). */
export const GEMINI_MODEL_ID = GEMINI_MODEL_SETTING;
/** Written from Google's documentation without a real call: shown as "unverified" until one is made. */
export const GEMINI_UNVERIFIED = true;
export const GEMINI_PRIVACY_NOTE = "Google's free tier may use uploaded files to improve its products; don't upload private documents.";
/** This client's version: part of the recorded converter version, with the model. */
export const GEMINI_CLIENT_VERSION = "1";
/** Google's PDF limits (document-processing, 2026-11-25), within the app's own material limit. */
export const GEMINI_MAX_BYTES = Math.min(50 * 1024 * 1024, MATERIAL_MAX_BYTES);
export const GEMINI_MAX_PAGES = Math.min(1000, PDF_MAX_PAGES);
/** Pages per request: about 10 × 560 input tokens, and a reply far below the output cap. */
export const GEMINI_BATCH_PAGES = 10;
/** The output cap asked for (the current Flash models allow 64K, thinking included). */
export const GEMINI_MAX_OUTPUT_TOKENS = 65_536;
/** One generateContent request (a batch of pages can take a while). */
export const GEMINI_GENERATE_TIMEOUT_MS = 5 * 60_000;
/** How long an uploaded file may stay PROCESSING. */
export const GEMINI_PROCESSING_TIMEOUT_MS = 5 * 60_000;
export const GEMINI_PROCESSING_POLL_MS = 2_000;
/** 429 retries per request (per-minute limits) and the longest single wait; a longer wait fails with rate_limit. */
export const GEMINI_MAX_RATE_LIMIT_RETRIES = 6;
export const GEMINI_MAX_RATE_LIMIT_WAIT_MS = 2 * 60_000;
/** The first backoff step when Google gives no delay (doubled per retry, capped at the longest wait). */
export const GEMINI_BACKOFF_BASE_MS = 5_000;
/** 5xx retries per generateContent request before the service counts as unreachable. */
export const GEMINI_MAX_SERVER_RETRIES = 2;
/** The largest answer read: one batch of Markdown. */
export const GEMINI_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const ERROR_BODY_BYTES = 64 * 1024;
const DELETE_TIMEOUT_MS = 10_000;

/** The job deadline for a PDF of `pageCount` pages: sequential batches, so it grows with the page count (capped). */
export function geminiJobDeadlineMs(pageCount: number, batchPages = GEMINI_BATCH_PAGES): number {
	const batches = Math.max(1, Math.ceil(pageCount / batchPages));
	return Math.min(10 * 60_000 + batches * 3 * 60_000, 4 * 60 * 60_000);
}

/** A typed model id normalized once: trimmed, one `models/` prefix removed (the result is validated as it is). */
export function normalizeGeminiModel(typed: string): string {
	return typed.trim().replace(/^models\//, "");
}

/** The model id to use: the default for a blank setting, else the setting normalized once; undefined when not well-formed. */
export function geminiModelId(setting: string | undefined): string | undefined {
	if (!(setting ?? "").trim()) return GEMINI_DEFAULT_MODEL;
	const id = normalizeGeminiModel(setting!);
	return GEMINI_MODEL_ID.test(id) ? id : undefined;
}

/** Whether a model takes thinkingLevel and page selection (Gemini 3, 4 and later, and the `-latest` aliases). */
export function geminiModelIsCurrent(model: string): boolean {
	return /^gemini-(?:[3-9]|\d{2,})/.test(model) || /^gemini-[a-z-]*latest$/.test(model);
}

export interface GeminiConverterOptions {
	apiKey: string;
	model?: string;
	/** Where the key came from (the converter's own, or the Google model provider's): only for messages. */
	keySource?: "own" | "provider";
	baseUrl?: string;
	batchPages?: number;
	requestTimeoutMs?: number;
	uploadTimeoutMs?: number;
	generateTimeoutMs?: number;
	jobDeadlineMs?: number;
	processingPollMs?: number;
	processingTimeoutMs?: number;
	maxRateLimitRetries?: number;
	maxRateLimitWaitMs?: number;
	backoffBaseMs?: number;
	maxServerRetries?: number;
	maxResponseBytes?: number;
	/** The current time (tests: the daily reset message). */
	now?: () => Date;
}

// ── Pages ────────────────────────────────────────────────────────────────────

export const GEMINI_PAGE_MARKER = (page: number) => `<<<PAGE ${page}>>>`;
/** A marker line: at most three spaces of indentation (four or a tab would be an indented code block). */
const MARKER_LINE = /^ {0,3}<<<\s*PAGE\s+(\d{1,5})\s*>>>[ \t]*$/;
/** A Markdown code fence line (CommonMark: up to three spaces, then three or more backticks or tildes). */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** The response-wide wrapper some models add despite the prompt: one fence around a reply that starts with a marker. */
const WRAPPER = /^(`{3,}|~{3,})[a-z]*\n([\s\S]*?)\n\1$/i;
export const GEMINI_EMPTY_REASON = "Gemini found no text on this page";

/** The transcription prompt for pages `from`–`to` of a `total`-page PDF (exported for tests). */
export function geminiPrompt(from: number, to: number, total: number): string {
	const range = from === to ? `page ${from}` : `pages ${from} to ${to}`;
	return [
		`You are a transcription engine. The attached PDF has ${total} pages. Transcribe ${range} of it to Markdown, in order.`,
		`Page numbers here are physical: page 1 is the first page of the file, whatever number is printed on it.`,
		``,
		`Rules:`,
		`- Start every page with this exact line on its own: ${GEMINI_PAGE_MARKER(from)} (with that page's number). Write one such line for each page from ${from} to ${to}, once, in order, also for a blank page.`,
		`- Keep the headings (#), lists, emphasis and the reading order. Write tables as Markdown tables. Write formulas as LaTeX: $…$ inline, $$…$$ on their own lines.`,
		`- For a diagram, chart, photo or other image, write one short description on its own line: [Figure: …].`,
		`- Leave out running headers, footers and printed page numbers. A blank page has nothing after its marker line.`,
		`- Transcribe exactly what is on the page: do not summarise, translate, correct or add anything.`,
		`- Write only the transcription: no introduction, no commentary, no code fences, nothing before the first marker line.`,
	].join("\n");
}

export type ParsedBatch = { ok: true; pages: PageResult[] } | { ok: false; reason: string };

/**
 * A reply split at its marker lines into pages `from`–`to` (pure; exported for tests). Every page of the range must
 * have exactly one marker, in order, and nothing but whitespace may come before the first. A reply wrapped in one
 * code fence (around its first marker) is unwrapped. A marker line inside a code fence is page text, not a marker
 * (a page may show the marker syntax in an example). A page with nothing after its marker is empty, as the prompt
 * asks; any text, even "Empty", is that page's text.
 */
export function parseGeminiPages(text: string, from: number, to: number): ParsedBatch {
	let body = text.replace(/\r\n?/g, "\n").trim();
	const wrapped = WRAPPER.exec(body);
	if (wrapped && MARKER_LINE.test(wrapped[2]!.trimStart().split("\n")[0]!)) body = wrapped[2]!;
	const lines = body.split("\n");
	const pages: { page: number; lines: string[] }[] = [];
	const expected = to - from + 1;
	/** The open fence (its character and length), or undefined outside a fence. An unclosed fence runs to the end. */
	let fence: { char: string; length: number } | undefined;
	for (const line of lines) {
		const fenceLine = FENCE_LINE.exec(line);
		if (fence) {
			// a closing fence: the same character, at least as long, nothing after it but spaces
			if (fenceLine && fenceLine[1]![0] === fence.char && fenceLine[1]!.length >= fence.length && !fenceLine[2]!.trim()) fence = undefined;
		} else if (fenceLine && !(fenceLine[1]![0] === "`" && fenceLine[2]!.includes("`"))) {
			fence = { char: fenceLine[1]![0]!, length: fenceLine[1]!.length };
		}
		const marker = fence || fenceLine ? null : MARKER_LINE.exec(line);
		if (marker) {
			const page = Number(marker[1]);
			const want = from + pages.length;
			if (pages.length >= expected) return { ok: false, reason: `the reply has more page markers than the ${expected} pages asked for` };
			if (page !== want) {
				const seen = pages.some((p) => p.page === page);
				return { ok: false, reason: seen ? `the reply marks page ${page} twice` : page < from || page > to ? `the reply marks page ${page}, outside pages ${from}–${to}` : `the reply skips from page ${want - 1} to page ${page}` };
			}
			pages.push({ page, lines: [] });
			continue;
		}
		if (pages.length === 0) {
			if (line.trim()) return { ok: false, reason: "the reply has text before its first page marker" };
			continue;
		}
		pages.at(-1)!.lines.push(line);
	}
	if (pages.length === 0) return { ok: false, reason: "the reply has no page markers" };
	if (pages.length < expected) return { ok: false, reason: `the reply stops after page ${pages.at(-1)!.page} of ${from}–${to}` };
	return {
		ok: true,
		pages: pages.map(({ page, lines: content }): PageResult => {
			const markdown = content.join("\n").trim();
			return !markdown ? { page, status: "empty", reason: GEMINI_EMPTY_REASON } : { page, status: "ok", markdown };
		}),
	};
}

// ── Google errors ───────────────────────────────────────────────────────────

interface GoogleError {
	status: number;
	/** error.status: INVALID_ARGUMENT, RESOURCE_EXHAUSTED, … */
	code?: string;
	message: string;
	reasons: string[];
	quotaIds: string[];
	retryDelayMs?: number;
	retryAfterMs?: number;
}

/** "31s", "1.5s", "200ms" → milliseconds. */
function durationMs(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s)\s*$/.exec(value);
	if (!match) return undefined;
	return Math.round(Number(match[1]) * (match[2] === "ms" ? 1 : 1000));
}

function retryAfterMs(header: string | null, now: Date): number | undefined {
	if (!header) return undefined;
	if (/^\d+(?:\.\d+)?$/.test(header.trim())) return Math.round(Number(header.trim()) * 1000);
	const at = Date.parse(header);
	return Number.isFinite(at) ? Math.max(0, at - now.getTime()) : undefined;
}

/** A Google API error body (`{ error: { code, message, status, details[] } }`), secrets removed from its message. */
export function parseGoogleError(status: number, text: string, retryAfter: string | null, secrets: readonly string[], now = new Date()): GoogleError {
	let error: Record<string, unknown> | undefined;
	try {
		error = asRecord(asRecord(JSON.parse(text))?.error);
	} catch {
		// not JSON
	}
	const reasons: string[] = [];
	const quotaIds: string[] = [];
	let retryDelay: number | undefined;
	for (const detail of Array.isArray(error?.details) ? error.details : []) {
		const d = asRecord(detail);
		if (!d) continue;
		const type = typeof d["@type"] === "string" ? d["@type"] : "";
		if (type.endsWith("google.rpc.ErrorInfo") && typeof d.reason === "string") reasons.push(d.reason);
		if (type.endsWith("google.rpc.RetryInfo")) retryDelay = durationMs(d.retryDelay) ?? retryDelay;
		if (type.endsWith("google.rpc.QuotaFailure")) {
			for (const v of Array.isArray(d.violations) ? d.violations : []) {
				const violation = asRecord(v);
				for (const field of ["quotaId", "quotaMetric"]) if (typeof violation?.[field] === "string") quotaIds.push(violation[field] as string);
			}
		}
	}
	const message = typeof error?.message === "string" ? error.message : text.trim();
	return {
		status,
		...(typeof error?.status === "string" ? { code: error.status } : typeof error?.code === "string" ? { code: error.code } : {}),
		message: serviceMessage(message, secrets),
		reasons,
		quotaIds,
		...(retryDelay !== undefined ? { retryDelayMs: retryDelay } : {}),
		...(retryAfterMs(retryAfter, now) !== undefined ? { retryAfterMs: retryAfterMs(retryAfter, now) } : {}),
	};
}

/** Whether a 429 is a daily quota (the error code `quota_exceeded`, or a quota id, metric or message that names a day). */
export function isDailyQuota(error: Pick<GoogleError, "quotaIds" | "message"> & { code?: string }): boolean {
	return error.code === "quota_exceeded" || error.quotaIds.some((id) => /per[\s_-]?day|daily/i.test(id)) || /per[\s_-]?day|daily/i.test(error.message);
}

/** Minutes until the next midnight in Pacific time (when Google resets daily quotas). */
export function minutesUntilPacificMidnight(now: Date): number {
	const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(now).map((p) => [p.type, p.value]));
	const minutes = Number(parts.hour) * 60 + Number(parts.minute);
	return Math.max(1, 24 * 60 - minutes);
}

function inAbout(minutes: number): string {
	if (minutes < 90) return `in about ${minutes} minute${minutes === 1 ? "" : "s"}`;
	const hours = Math.round(minutes / 60);
	return `in about ${hours} hour${hours === 1 ? "" : "s"}`;
}

// ── The converter ────────────────────────────────────────────────────────────

interface Range {
	from: number;
	to: number;
	/** Attempts already made at this exact range (a single page gets a second try for a marker problem). */
	tries: number;
}

type BatchOutcome =
	| { kind: "ok"; pages: PageResult[] }
	/** Split the range (or, for a single page, give up on it) for this reason; `retry`: a single page may try again. */
	| { kind: "failed"; reason: string; retry: boolean };

export function createGeminiConverter(options: GeminiConverterOptions): PdfConverter {
	const baseUrl = (options.baseUrl ?? GEMINI_BASE_URL).replace(/\/+$/, "");
	const origin = new URL(baseUrl).origin;
	const model = geminiModelId(options.model);
	if (!model) throw new ConverterError("not_configured", `${GEMINI_NAME} is not set up: the model id in Settings → PDF conversion is not valid`, false);
	const apiKey = options.apiKey.trim();
	const keyName = options.keySource === "provider" ? "Your Google provider key" : "The Gemini key";
	const batchPages = Math.max(1, Math.floor(options.batchPages ?? GEMINI_BATCH_PAGES));
	const requestTimeoutMs = options.requestTimeoutMs ?? CONVERTER_REQUEST_TIMEOUT_MS;
	const uploadTimeoutMs = options.uploadTimeoutMs ?? CONVERTER_UPLOAD_TIMEOUT_MS;
	const generateTimeoutMs = options.generateTimeoutMs ?? GEMINI_GENERATE_TIMEOUT_MS;
	const processingPollMs = options.processingPollMs ?? GEMINI_PROCESSING_POLL_MS;
	const processingTimeoutMs = options.processingTimeoutMs ?? GEMINI_PROCESSING_TIMEOUT_MS;
	const maxRateLimitRetries = options.maxRateLimitRetries ?? GEMINI_MAX_RATE_LIMIT_RETRIES;
	const maxRateLimitWaitMs = options.maxRateLimitWaitMs ?? GEMINI_MAX_RATE_LIMIT_WAIT_MS;
	const backoffBaseMs = options.backoffBaseMs ?? GEMINI_BACKOFF_BASE_MS;
	const maxServerRetries = options.maxServerRetries ?? GEMINI_MAX_SERVER_RETRIES;
	const maxResponseBytes = options.maxResponseBytes ?? GEMINI_MAX_RESPONSE_BYTES;
	const now = options.now ?? (() => new Date());
	const current = geminiModelIsCurrent(model);
	const version = `${GEMINI_CLIENT_VERSION}; ${model}`;

	const headers = (extra: [string, string][] = []): Headers => {
		const problem = storedKeyProblem(apiKey);
		if (!apiKey || problem) throw new ConverterError("auth", `${problem ? problem.replace("The API key", keyName).replace("The stored API key", keyName) : `${keyName} is empty`}; enter the key again in Settings → PDF conversion. Nothing was sent.`, false);
		return buildHeaders([["x-goog-api-key", apiKey], ...extra], GEMINI_NAME, "auth");
	};

	/**
	 * A Google error as a ConverterError (429 handled by the caller before this). `operation` says which request failed:
	 * a FAILED_PRECONDITION is about the uploaded file when it names the file (or comes from a file request), about
	 * the key's project only when it names billing, the free tier or the user's location, and otherwise reported as
	 * Google's own message.
	 */
	function errorFor(error: GoogleError, operation: Operation): ConverterError {
		const http = { httpStatus: error.status };
		const detail = error.message ? `: ${error.message}` : "";
		if (error.reasons.includes("API_KEY_INVALID") || (error.status === 400 && /api key not valid/i.test(error.message))) {
			return new ConverterError("auth", `Google AI Studio refused the key (HTTP ${error.status}): ${keyName} is not valid. Create one at ${GEMINI_KEY_URL} and enter it in Settings → PDF conversion.`, false, http);
		}
		if (error.status === 401 || error.status === 403) {
			return new ConverterError("auth", `Google AI Studio refused the key (HTTP ${error.status})${detail}. Check that the key is active and the Gemini API is enabled for its project.`, false, http);
		}
		if (error.status === 400 && error.code === "FAILED_PRECONDITION") {
			const about = `${error.message} ${error.reasons.join(" ")}`;
			if (/billing|free[\s_-]?tier|location|region|country/i.test(about)) {
				return new ConverterError("auth", `Google AI Studio cannot be used with this key (HTTP 400)${detail}. The free tier is not offered in every country; billing may have to be enabled for the project.`, false, http);
			}
			if (operation === "file" || operation === "upload" || /\bfiles?\b|ACTIVE/i.test(about)) {
				return new ConverterError("conversion_failed", `Google AI Studio could not use the uploaded PDF yet (HTTP 400)${detail}. Convert the PDF again.`, true, http);
			}
			return new ConverterError("bad_response", `Google AI Studio refused the request (HTTP 400, FAILED_PRECONDITION)${detail}`, false, http);
		}
		if (error.status === 402) return new ConverterError("rate_limit", `Google AI Studio refused the request: the project's prepaid credit is used up (HTTP 402)${detail}`, false, http);
		if (error.status === 404) return new ConverterError("bad_response", `Google AI Studio does not know the model "${model}" (HTTP 404)${detail}. Check the model id in Settings → PDF conversion.`, false, http);
		return httpStatusError(GEMINI_NAME, error.status, error.message);
	}

	/** Which request failed (for errorFor): the upload, a request about the uploaded file, or generateContent. */
	type Operation = "upload" | "file" | "generate";

	type Answer = { ok: true; headers: Headers; body: unknown } | { ok: false; error: GoogleError };

	/**
	 * One request under the job, its own timeout and the size caps. Never follows a redirect. Answers the parsed
	 * Google error for a non-2xx status instead of throwing (the caller decides about retries).
	 */
	async function request(job: Job, url: string, init: { method: string; headers: Headers; body?: BodyInit }, timeoutMs: number, emptyBody = false): Promise<Answer> {
		const controller = new AbortController();
		let elapsed = false;
		const onJob = () => controller.abort(job.signal.reason);
		if (job.signal.aborted) onJob();
		else job.signal.addEventListener("abort", onJob, { once: true });
		const timer = setTimeout(() => {
			elapsed = true;
			controller.abort(new Error(`${GEMINI_NAME} request timeout`));
		}, timeoutMs);
		try {
			const response = await fetch(url, { ...init, redirect: "manual", signal: controller.signal });
			if ((response.status >= 300 && response.status < 400) || response.type === "opaqueredirect") {
				await response.body?.cancel().catch(() => {});
				badResponse(`${GEMINI_NAME} answered with a redirect (HTTP ${response.status})`);
			}
			if (!response.ok) {
				const text = await readCapped(response, controller.signal, ERROR_BODY_BYTES, GEMINI_NAME).catch(() => "");
				controller.signal.throwIfAborted();
				return { ok: false, error: parseGoogleError(response.status, text, response.headers.get("retry-after"), job.service.secrets as string[], now()) };
			}
			const text = await readCapped(response, controller.signal, maxResponseBytes, GEMINI_NAME);
			if (emptyBody || !text.trim()) return { ok: true, headers: response.headers, body: undefined };
			try {
				return { ok: true, headers: response.headers, body: JSON.parse(text) as unknown };
			} catch {
				// no cause: the engine's SyntaxError quotes the start of the body
				throw new ConverterError("bad_response", `${GEMINI_NAME} returned invalid JSON`, false);
			}
		} catch (error) {
			throw classifyConverterFailure(error, job, elapsed, timeoutMs);
		} finally {
			clearTimeout(timer);
			job.signal.removeEventListener("abort", onJob);
		}
	}

	/** The retries one request has used so far. */
	type RetryState = { rateLimited: number; serverFailed: number };

	/**
	 * The quota and retry policy for a failed answer: a per-minute 429 waits (Retry-After, RetryInfo, else backoff;
	 * bounded in length and count) and returns, a daily quota fails at once; 5xx (not 504) waits and returns
	 * `serverRetries` times. Anything else throws the error to report.
	 */
	async function waitToRetry(job: Job, error: GoogleError, state: RetryState, serverRetries: number, operation: Operation): Promise<void> {
		if (error.status === 429) {
			if (isDailyQuota(error)) {
				throw new ConverterError("rate_limit", `Google AI Studio's daily free-tier quota for ${model} is used up (HTTP 429). It resets at midnight Pacific time, ${inAbout(minutesUntilPacificMidnight(now()))}; convert the PDF again after that, or choose another model in Settings → PDF conversion.`, true, { httpStatus: 429 });
			}
			const wait = error.retryAfterMs ?? error.retryDelayMs ?? Math.min(backoffBaseMs * 2 ** state.rateLimited, maxRateLimitWaitMs);
			if (wait > maxRateLimitWaitMs) {
				throw new ConverterError("rate_limit", `Google AI Studio's rate limit for ${model} is reached (HTTP 429); it asks to wait ${inAbout(Math.ceil(wait / 60_000))}. Convert the PDF again after that.`, true, { httpStatus: 429 });
			}
			if (state.rateLimited >= maxRateLimitRetries) {
				throw new ConverterError("rate_limit", `Google AI Studio's rate limit for ${model} is still reached after ${state.rateLimited} waits (HTTP 429)${error.message ? `: ${error.message}` : ""}. Try again in a few minutes.`, true, { httpStatus: 429 });
			}
			state.rateLimited++;
			await delay(wait, job.signal);
			return;
		}
		if (error.status >= 500 && error.status !== 504 && state.serverFailed < serverRetries) {
			await delay(Math.min(backoffBaseMs * 2 ** state.serverFailed, maxRateLimitWaitMs), job.signal);
			state.serverFailed++;
			return;
		}
		throw errorFor(error, operation);
	}

	/** A request that may be sent again as it is, under the quota and retry policy (waitToRetry). */
	async function requestWithRetry(job: Job, url: string, init: () => { method: string; headers: Headers; body?: BodyInit }, timeoutMs: number, serverRetries: number, operation: Operation): Promise<{ headers: Headers; body: unknown }> {
		const state: RetryState = { rateLimited: 0, serverFailed: 0 };
		for (;;) {
			const answer = await request(job, url, init(), timeoutMs);
			if (answer.ok) return answer;
			await waitToRetry(job, answer.error, state, serverRetries, operation);
		}
	}

	/**
	 * Upload the PDF (resumable: start, then the bytes with finalize); answers the file's name, uri and state.
	 * The file's name is chosen here and sent in the start request (File.name: "If the name is empty on create, a unique
	 * name will be generated", v1beta schema), and `onName` gets it before any byte is sent: an upload Google commits
	 * while its answer is lost (an abort or a timeout while reading it, a malformed answer) can still be deleted.
	 */
	async function upload(job: Job, bytes: Uint8Array, onName: (name: string) => void): Promise<{ name: string; uri: string; state?: string; error?: string }> {
		// the id: up to 40 lowercase letters, digits or dashes, not starting or ending with a dash (v1beta File.name)
		const name = `files/lh-${randomUUID()}`;
		const started = await requestWithRetry(job, `${baseUrl}/upload/v1beta/files`, () => ({
			method: "POST",
			headers: headers([
				["X-Goog-Upload-Protocol", "resumable"],
				["X-Goog-Upload-Command", "start"],
				["X-Goog-Upload-Header-Content-Length", String(bytes.byteLength)],
				["X-Goog-Upload-Header-Content-Type", "application/pdf"],
				["Content-Type", "application/json"],
			]),
			body: JSON.stringify({ file: { name, display_name: `learnharness-${randomUUID()}.pdf` } }),
		}), requestTimeoutMs, 0, "upload");
		const uploadUrl = started.headers.get("x-goog-upload-url");
		if (!uploadUrl) badResponse(`${GEMINI_NAME} did not return an upload address`);
		let parsed: URL;
		try {
			parsed = new URL(uploadUrl);
		} catch {
			badResponse(`${GEMINI_NAME} returned an upload address that is not a URL`);
		}
		// the key goes with the bytes, so only to Google's own address
		if (parsed.origin !== origin) badResponse(`${GEMINI_NAME} returned an upload address on another host (${parsed.host}); nothing was uploaded`);
		// the session address lets anyone holding it write to the upload: kept out of every message like the key
		const uploadId = parsed.searchParams.get("upload_id");
		(job.service.secrets as string[]).push(uploadUrl, parsed.search.slice(1), ...(uploadId && uploadId.length >= 8 ? [uploadId] : []));
		onName(name);
		// The bytes, under the same quota and retry policy as every other request. Before bytes are sent again, the
		// session is asked how far it got (X-Goog-Upload-Command: query): an upload Google already finalized is
		// fetched, not sent twice, and a partial one resumes at the offset Google reports.
		const state: RetryState = { rateLimited: 0, serverFailed: 0 };
		let offset = 0;
		for (;;) {
			const done = await request(job, uploadUrl, {
				method: "POST",
				headers: headers([
					["X-Goog-Upload-Offset", String(offset)],
					["X-Goog-Upload-Command", "upload, finalize"],
				]),
				body: new Blob([bytes.slice(offset).buffer as ArrayBuffer], { type: "application/pdf" }),
			}, uploadTimeoutMs);
			if (done.ok) return fileOf(asRecord(done.body)?.file ?? done.body, onName);
			await waitToRetry(job, done.error, state, maxServerRetries, "upload");
			const status = await request(job, uploadUrl, { method: "POST", headers: headers([["X-Goog-Upload-Command", "query"]]) }, requestTimeoutMs, true);
			if (!status.ok) throw errorFor(status.error, "upload");
			const uploadStatus = status.headers.get("x-goog-upload-status");
			if (uploadStatus === "final") {
				return fileOf((await requestWithRetry(job, `${baseUrl}/v1beta/${name}`, () => ({ method: "GET", headers: headers() }), requestTimeoutMs, maxServerRetries, "file")).body, onName);
			}
			const received = Number(status.headers.get("x-goog-upload-size-received") ?? NaN);
			if (uploadStatus !== "active" || !Number.isInteger(received) || received < 0 || received > bytes.byteLength) {
				badResponse(`${GEMINI_NAME}'s upload session cannot be resumed (status ${serviceMessage(uploadStatus ?? "missing")}); nothing was sent twice`);
			}
			offset = received;
		}
	}

	/** The File resource in an answer; `onName` gets its name as soon as it is known (to delete it later). */
	function fileOf(value: unknown, onName?: (name: string) => void): { name: string; uri: string; state?: string; error?: string } {
		const file = asRecord(value) ?? badResponse(`${GEMINI_NAME} did not describe the uploaded file`);
		if (typeof file.name !== "string" || !/^files\/[a-z0-9-]{1,40}$/.test(file.name)) badResponse(`${GEMINI_NAME} returned no valid file name for the upload`);
		onName?.(file.name);
		if (typeof file.uri !== "string" || !file.uri.startsWith("https://")) badResponse(`${GEMINI_NAME} returned no valid file URI for the upload`);
		const err = asRecord(file.error);
		return { name: file.name, uri: file.uri, ...(typeof file.state === "string" ? { state: file.state } : {}), ...(typeof err?.message === "string" ? { error: err.message } : {}) };
	}

	/**
	 * Wait until the uploaded file is ACTIVE; FAILED is conversion_failed. Anything else is polled until the processing
	 * deadline: PROCESSING, and also an omitted state, which the v1beta schema defines as STATE_UNSPECIFIED, not ACTIVE.
	 */
	async function waitActive(job: Job, file: { name: string; uri: string; state?: string; error?: string }, ctx: ConvertContext, total: number): Promise<void> {
		const started = Date.now();
		let current = file;
		for (;;) {
			if (current.state === "ACTIVE") return;
			if (current.state === "FAILED") throw new ConverterError("conversion_failed", `Google AI Studio could not process the PDF${current.error ? `: ${serviceMessage(current.error, job.service.secrets)}` : ""}`, false);
			if (Date.now() - started > processingTimeoutMs) throw new ConverterError("timeout", `Google AI Studio was still processing the PDF after ${Math.round(processingTimeoutMs / 1000)} s`, true);
			ctx.onProgress("processing", 0, total);
			await delay(processingPollMs, job.signal);
			current = fileOf((await requestWithRetry(job, `${baseUrl}/v1beta/${current.name}`, () => ({ method: "GET", headers: headers() }), requestTimeoutMs, maxServerRetries, "file")).body);
		}
	}

	async function generate(job: Job, fileUri: string, range: Range, total: number): Promise<BatchOutcome> {
		const filePart: Record<string, unknown> = { fileData: { mimeType: "application/pdf", fileUri } };
		if (current) filePart.documentMetadata = { startPage: range.from, endPage: range.to, contentLayers: ["PAGE_IMAGE", "PAGE_TEXT"] };
		const body = JSON.stringify({
			contents: [{ role: "user", parts: [filePart, { text: geminiPrompt(range.from, range.to, total) }] }],
			generationConfig: { maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS, ...(current ? { thinkingConfig: { thinkingLevel: "LOW" } } : {}) },
		});
		const answer = await requestWithRetry(job, `${baseUrl}/v1beta/models/${encodeURIComponent(model!)}:generateContent`, () => ({
			method: "POST",
			headers: headers([["Content-Type", "application/json"]]),
			body,
		}), generateTimeoutMs, maxServerRetries, "generate");
		const result = asRecord(answer.body) ?? badResponse(`${GEMINI_NAME}'s answer is not an object`);
		const candidates = Array.isArray(result.candidates) ? result.candidates : [];
		const candidate = asRecord(candidates[0]);
		if (!candidate) {
			// PromptFeedback.blockReason: "If set, the prompt was blocked and no candidates are returned" (v1beta schema).
			// Without one, an answer with no candidate is outside the protocol: not something a smaller batch would fix.
			const block = asRecord(result.promptFeedback)?.blockReason;
			if (typeof block === "string" && block && block !== "BLOCK_REASON_UNSPECIFIED") return { kind: "failed", reason: `Gemini blocked the request (${serviceMessage(block)})`, retry: false };
			badResponse(`${GEMINI_NAME} answered without a transcription and without saying why (no candidate, no block reason)`);
		}
		const finish = typeof candidate.finishReason === "string" ? candidate.finishReason : "STOP";
		const parts = Array.isArray(asRecord(candidate.content)?.parts) ? (asRecord(candidate.content)!.parts as unknown[]) : [];
		const text = parts.map(asRecord).filter((p) => p && p.thought !== true && typeof p.text === "string").map((p) => p!.text as string).join("");
		if (finish === "MAX_TOKENS") return { kind: "failed", reason: "Gemini's reply for this page was cut off at the output limit", retry: false };
		if (finish !== "STOP" && finish !== "FINISH_REASON_UNSPECIFIED") return { kind: "failed", reason: `Gemini declined to transcribe this page (${serviceMessage(finish)})`, retry: false };
		const parsed = parseGeminiPages(text, range.from, range.to);
		if (!parsed.ok) return { kind: "failed", reason: `Gemini's reply could not be placed on this page: ${parsed.reason}`, retry: true };
		return { kind: "ok", pages: parsed.pages };
	}

	/** Delete the uploaded file, with its own short timeout (the job may have been aborted or timed out). */
	async function remove(name: string): Promise<void> {
		try {
			const response = await fetch(`${baseUrl}/v1beta/${name}`, { method: "DELETE", headers: headers(), redirect: "manual", signal: AbortSignal.timeout(DELETE_TIMEOUT_MS) });
			await response.body?.cancel().catch(() => {});
		} catch {
			// best effort: Google deletes uploads after 48 hours anyway
		}
	}

	return {
		id: GEMINI_CONVERTER_ID,
		label: GEMINI_NAME,
		version,
		local: false,
		options: { model },
		maxBytes: GEMINI_MAX_BYTES,
		maxPages: GEMINI_MAX_PAGES,
		async convert(input, ctx): Promise<ConvertResult> {
			if (input.bytes.byteLength > GEMINI_MAX_BYTES) throw new ConverterError("too_large", `PDF exceeds Google AI Studio's ${Math.round(GEMINI_MAX_BYTES / 1024 / 1024)} MB limit`, false);
			if (input.pageCount > GEMINI_MAX_PAGES) throw new ConverterError("too_many_pages", `PDF exceeds Google AI Studio's ${GEMINI_MAX_PAGES}-page limit`, false);
			headers(); // a key that cannot be sent is an auth error before anything is sent
			const secrets: string[] = [apiKey];
			const service = { name: GEMINI_NAME, baseUrl, secrets };
			const total = input.pageCount;
			/** Every name the upload may exist under at Google, known before its bytes are sent; all deleted at the end. */
			const uploaded = new Set<string>();
			try {
				return await runConverterJob(service, ctx.signal, options.jobDeadlineMs ?? geminiJobDeadlineMs(total, batchPages), async (job) => {
					ctx.onProgress("uploading", 0, total);
					const file = await upload(job, input.bytes, (name) => uploaded.add(name));
					await waitActive(job, file, ctx, total);

					const results = new Map<number, PageResult>();
					const pending: Range[] = [];
					for (let from = 1; from <= total; from += batchPages) pending.push({ from, to: Math.min(total, from + batchPages - 1), tries: 0 });
					ctx.onProgress("converting", 0, total);
					while (pending.length > 0) {
						const range = pending.shift()!;
						const outcome = await generate(job, file.uri, range, total);
						if (outcome.kind === "ok") {
							for (const page of outcome.pages) results.set(page.page, page);
						} else if (range.to > range.from) {
							const middle = range.from + Math.floor((range.to - range.from + 1) / 2) - 1;
							pending.unshift({ from: range.from, to: middle, tries: 0 }, { from: middle + 1, to: range.to, tries: 0 });
							continue;
						} else if (outcome.retry && range.tries < 1) {
							pending.unshift({ ...range, tries: range.tries + 1 });
							continue;
						} else {
							results.set(range.from, { page: range.from, status: "empty", reason: outcome.reason });
						}
						ctx.onProgress("converting", results.size, total);
					}
					const pages = Array.from({ length: total }, (_, i) => results.get(i + 1) ?? badResponse(`${GEMINI_NAME} left page ${i + 1} unanswered`));
					ctx.onProgress("complete", total, total);
					return redactConversion({ converterVersion: version, pages }, secrets);
				});
			} catch (error) {
				throw error instanceof ConverterError ? redactError(error, secrets) : error;
			} finally {
				for (const name of uploaded) await remove(name);
			}
		},
	};
}
