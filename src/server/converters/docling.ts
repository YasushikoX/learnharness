import { randomUUID } from "node:crypto";
import { MATERIAL_MAX_BYTES } from "../../core/materials.ts";
import { ConverterError, PDF_MAX_PAGES, type ConvertContext, type ConvertResult, type PageResult, type PdfConverter } from "../../core/pdf-converter.ts";
import { normalizeBaseUrl } from "../../core/settings.ts";

/**
 * The Docling Serve converter (fork addition, 2026-11-24): a self-hosted
 * service at a configured base URL, its key (optional) from the credential
 * store (converters/auth.ts), sent only as X-Api-Key.
 *
 *   GET  /version                                the service version (cache key; also checks reachability and the key before uploading)
 *   POST /v1/convert/file/async                  one upload: to_formats md AND json, a random page-break placeholder
 *   GET  /v1/status/poll/{task_id}?wait=N        server-side wait of N seconds per poll
 *   GET  /v1/result/{task_id}                    the result (or the server's failure)
 *
 * Every response body is read inside its request, under the same abort signal
 * and timeout, as a stream capped at CONVERTER_MAX_RESPONSE_BYTES. The upload
 * has its own longer timeout; the job deadline covers everything.
 *
 * PAGES. Docling writes the placeholder only between pages that have content,
 * so the Markdown segments are matched, in order, to the pages that hold at
 * least one item in `json_content` (assignDoclingPages); every other page is
 * empty. Any disagreement is bad_response, never a guess.
 */

/** This client's own version (the converter version recorded is the service's, from /version). */
export const DOCLING_CLIENT_VERSION = "2";
/** One ordinary request (version, poll, result). */
export const CONVERTER_REQUEST_TIMEOUT_MS = 30_000;
/** The upload request, which carries the PDF. */
export const CONVERTER_UPLOAD_TIMEOUT_MS = 5 * 60_000;
/** The whole job: every request and wait. */
export const CONVERTER_JOB_DEADLINE_MS = 15 * 60_000;
/** The poll's server-side wait. */
export const DOCLING_POLL_WAIT_SECONDS = 5;
/** The least time between two polls, should a server answer a poll at once. */
export const DOCLING_MIN_POLL_INTERVAL_MS = 1_000;
/** The largest response body read (the result carries Markdown and the JSON document). */
export const CONVERTER_MAX_RESPONSE_BYTES = 2 * MATERIAL_MAX_BYTES;

export interface DoclingConverterOptions {
	baseUrl: string;
	apiKey?: string;
	ocr?: boolean;
	formulaEnrichment?: boolean;
	requestTimeoutMs?: number;
	uploadTimeoutMs?: number;
	jobDeadlineMs?: number;
	pollWaitSeconds?: number;
	minPollIntervalMs?: number;
	maxResponseBytes?: number;
}

const TASK_STATUSES = new Set(["pending", "started", "failure", "success", "partial_success", "skipped"]);

interface TaskStatus {
	task_id: string;
	task_status: string;
	error_message?: string | null;
	failure?: { message?: unknown; retryable?: unknown } | null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function badResponse(message: string): never {
	throw new ConverterError("bad_response", message, false);
}

function seconds(ms: number): string {
	return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
}

function httpError(status: number, detail: string): ConverterError {
	const suffix = detail ? `: ${detail}` : "";
	if (status === 401 || status === 403) return new ConverterError("auth", `Docling refused the key (HTTP ${status})${suffix}`, false);
	if (status === 429) return new ConverterError("rate_limit", `Docling rate limit reached (HTTP 429)${suffix}`, true);
	if (status === 413) return new ConverterError("too_large", `Docling rejected the PDF as too large (HTTP 413)${suffix}`, false);
	if (status === 408 || status === 504) return new ConverterError("timeout", `Docling timed out (HTTP ${status})${suffix}`, true);
	if (status >= 500) return new ConverterError("unreachable", `Docling failed (HTTP ${status})${suffix}`, true);
	return new ConverterError("bad_response", `Docling rejected the request (HTTP ${status})${suffix}`, false);
}

/** A response body as text: declared and actual size capped, every read under `signal`. */
async function readCapped(response: Response, signal: AbortSignal, maxBytes: number): Promise<string> {
	const declared = Number(response.headers.get("content-length") ?? NaN);
	const tooLarge = () => new ConverterError("bad_response", `Docling's answer is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit`, false);
	if (Number.isFinite(declared) && declared > maxBytes) {
		await response.body?.cancel().catch(() => {});
		throw tooLarge();
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const onAbort = () => void reader.cancel(signal.reason).catch(() => {});
	signal.addEventListener("abort", onAbort, { once: true });
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			signal.throwIfAborted();
			const { done, value } = await reader.read();
			signal.throwIfAborted();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				await reader.cancel().catch(() => {});
				throw tooLarge();
			}
			chunks.push(value);
		}
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** A short reason from an error body (FastAPI's `detail`, or a `message`). */
function errorDetail(text: string): string {
	try {
		const body = asRecord(JSON.parse(text));
		const detail = body?.detail ?? body?.message;
		if (typeof detail === "string") return detail.slice(0, 300);
		if (detail !== undefined) return JSON.stringify(detail).slice(0, 300);
	} catch {
		// not JSON
	}
	return text.trim().slice(0, 300);
}

interface Job {
	/** Aborted by the caller's signal or the job deadline. */
	signal: AbortSignal;
	/** The caller's own signal (an abort, not a timeout). */
	parent: AbortSignal;
	deadlineElapsed(): boolean;
	deadlineMs: number;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", aborted);
			resolve();
		}, ms);
		const aborted = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		signal.addEventListener("abort", aborted, { once: true });
	});
}

/**
 * The page each item that Docling's Markdown serializer writes starts on, in reading order, consecutive repeats
 * collapsed: the body tree's items (every kind: texts, tables, pictures, key-value and form items, inside groups) in
 * the body content layer, by their first provenance entry. Picture children (text found inside a figure) are part of
 * the figure, as in the serializer's default.
 */
function bodyPageSequence(doc: Record<string, unknown>): number[] {
	const sequence: number[] = [];
	const seen = new Set<string>();
	const resolve = (ref: string): Record<string, unknown> | undefined => {
		const match = /^#\/([a-z_]+)\/(\d+)$/.exec(ref);
		if (!match) return undefined;
		const list = doc[match[1]!];
		return Array.isArray(list) ? asRecord(list[Number(match[2])]) : undefined;
	};
	const visit = (node: Record<string, unknown>, ref: string) => {
		const layer = node.content_layer;
		if (layer !== undefined && layer !== null && layer !== "body") return;
		const prov = Array.isArray(node.prov) ? node.prov : [];
		const first = asRecord(prov[0]);
		if (first) {
			const page = first.page_no;
			if (!Number.isInteger(page)) badResponse(`Docling item ${ref} has no page number`);
			if (sequence.at(-1) !== page) sequence.push(page as number);
		}
		if (ref.startsWith("#/pictures/")) return;
		for (const child of Array.isArray(node.children) ? node.children : []) {
			const childRef = asRecord(child)?.$ref;
			if (typeof childRef !== "string" || seen.has(childRef)) continue;
			seen.add(childRef);
			const item = resolve(childRef);
			if (item) visit(item, childRef);
		}
	};
	const body = asRecord(doc.body);
	if (body) visit(body, "#/body");
	return sequence;
}

/** Markdown that consists only of Docling's image placeholder(s) and whitespace has no readable text. */
const IMAGE_PLACEHOLDER_ONLY = /^(?:\s*<!--\s*image\s*-->\s*)+$/i;

/**
 * Docling's Markdown split at `delimiter` and matched to physical pages through its JSON document (pure; exported for
 * tests). The JSON's page list must name exactly the local pages 1..pageCount; the reading-order sequence of pages with
 * items (bodyPageSequence) must only move forward and have exactly one segment each. Pages without items, or whose
 * Markdown consists only of image placeholders and whitespace, are empty. Every mismatch is bad_response.
 *
 * Known limitation: an item continuing onto the next page (a paragraph or table whose provenance spans two pages) is
 * assigned wholly to its first page, because Docling's Markdown is split at page breaks between items; citations for
 * the continued part therefore point one page early.
 */
export function assignDoclingPages(markdown: string, jsonContent: unknown, delimiter: string, pageCount: number): PageResult[] {
	const doc = asRecord(jsonContent) ?? badResponse("Docling's result has no JSON document to place its pages with");
	const pageKeys = Object.keys(asRecord(doc.pages) ?? badResponse("Docling's JSON document has no page list"));
	if (pageKeys.length !== pageCount) badResponse(`Docling saw ${pageKeys.length} pages; this PDF has ${pageCount}`);
	const physical = new Set(pageKeys.map(Number));
	for (let page = 1; page <= pageCount; page++) if (!physical.has(page)) badResponse(`Docling's page list lacks page ${page}`);
	const sequence = bodyPageSequence(doc);
	for (let i = 0; i < sequence.length; i++) {
		if (sequence[i]! < 1 || sequence[i]! > pageCount) badResponse(`Docling placed an item on page ${sequence[i]}; this PDF has ${pageCount}`);
		if (i > 0 && sequence[i]! <= sequence[i - 1]!) badResponse(`Docling's reading order goes back from page ${sequence[i - 1]} to page ${sequence[i]}, so its Markdown cannot be split into pages reliably`);
	}
	const segments = markdown.split(delimiter);
	if (sequence.length === 0) {
		if (markdown.trim()) badResponse("Docling returned text but placed no item on any page");
	} else if (segments.length !== sequence.length) {
		badResponse(`Docling returned ${segments.length} Markdown page segments for ${sequence.length} pages with content`);
	}
	const textOf = new Map(sequence.map((page, i) => [page, segments[i]!.replace(/\r\n?/g, "\n").trim()]));
	return Array.from({ length: pageCount }, (_, i): PageResult => {
		const page = i + 1;
		const text = textOf.get(page);
		if (!text) return { page, status: "empty", reason: "Docling found no content on this page" };
		if (IMAGE_PLACEHOLDER_ONLY.test(text)) return { page, status: "empty", reason: "This page contains only an image and no readable text" };
		return { page, status: "ok", markdown: text };
	});
}

/** The service version from /version: every docling* component, e.g. "docling 2.61.1; docling-serve 1.38.2". */
function versionString(body: unknown): string {
	const record = asRecord(body) ?? {};
	const parts = Object.entries(record)
		.filter(([name, value]) => /^docling/i.test(name) && typeof value === "string")
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, value]) => `${name} ${value as string}`);
	return parts.length ? parts.join("; ") : "unknown";
}

export function createDoclingConverter(options: DoclingConverterOptions): PdfConverter {
	const baseUrl = normalizeBaseUrl(options.baseUrl);
	if (!baseUrl) throw new ConverterError("not_configured", "Docling needs an absolute HTTP(S) base URL without credentials, query or fragment", false);
	const requestTimeoutMs = options.requestTimeoutMs ?? CONVERTER_REQUEST_TIMEOUT_MS;
	const uploadTimeoutMs = options.uploadTimeoutMs ?? CONVERTER_UPLOAD_TIMEOUT_MS;
	const jobDeadlineMs = options.jobDeadlineMs ?? CONVERTER_JOB_DEADLINE_MS;
	const pollWaitSeconds = options.pollWaitSeconds ?? DOCLING_POLL_WAIT_SECONDS;
	const minPollIntervalMs = options.minPollIntervalMs ?? DOCLING_MIN_POLL_INTERVAL_MS;
	const maxResponseBytes = options.maxResponseBytes ?? CONVERTER_MAX_RESPONSE_BYTES;
	const ocr = options.ocr ?? true;
	const formulaEnrichment = options.formulaEnrichment ?? false;
	const headers: Record<string, string> = options.apiKey ? { "X-Api-Key": options.apiKey } : {};

	/** Run `work` as one job: the caller's signal plus the job deadline. */
	async function asJob<T>(parent: AbortSignal, deadlineMs: number, work: (job: Job) => Promise<T>): Promise<T> {
		const controller = new AbortController();
		let elapsed = false;
		const onParent = () => controller.abort(parent.reason);
		if (parent.aborted) onParent();
		else parent.addEventListener("abort", onParent, { once: true });
		const deadline = setTimeout(() => {
			elapsed = true;
			controller.abort(new Error("Docling job deadline elapsed"));
		}, deadlineMs);
		const job: Job = { signal: controller.signal, parent, deadlineElapsed: () => elapsed, deadlineMs };
		try {
			return await work(job);
		} catch (error) {
			throw classify(error, job, false, 0);
		} finally {
			clearTimeout(deadline);
			parent.removeEventListener("abort", onParent);
		}
	}

	function classify(error: unknown, job: Job, requestElapsed: boolean, timeoutMs: number): ConverterError {
		if (error instanceof ConverterError) return error;
		if (job.parent.aborted) return new ConverterError("aborted", "PDF conversion was aborted", false, { cause: error });
		if (job.deadlineElapsed()) return new ConverterError("timeout", `Docling did not finish within the ${seconds(job.deadlineMs)} job deadline`, true, { cause: error });
		if (requestElapsed) return new ConverterError("timeout", `Docling did not answer within ${seconds(timeoutMs)}`, true, { cause: error });
		const reason = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
		return new ConverterError("unreachable", `Could not reach Docling at ${baseUrl}: ${reason}`, true, { cause: error });
	}

	/** One request and its whole body, as JSON, under the job, its own timeout and the size cap. */
	async function requestJson(job: Job, route: string, init: RequestInit, timeoutMs: number, accept404 = false): Promise<unknown> {
		const controller = new AbortController();
		let elapsed = false;
		const onJob = () => controller.abort(job.signal.reason);
		if (job.signal.aborted) onJob();
		else job.signal.addEventListener("abort", onJob, { once: true });
		const timer = setTimeout(() => {
			elapsed = true;
			controller.abort(new Error("Docling request timeout"));
		}, timeoutMs);
		try {
			const response = await fetch(`${baseUrl}${route}`, { ...init, redirect: "manual", headers, signal: controller.signal });
			if ((response.status >= 300 && response.status < 400) || response.type === "opaqueredirect") {
				await response.body?.cancel().catch(() => {});
				const location = response.headers.get("location");
				badResponse(`Docling answered with a redirect (HTTP ${response.status}${location ? ` to ${location}` : ""}); set the Docling URL to the address the service itself answers at`);
			}
			if (accept404 && response.status === 404) {
				await response.body?.cancel().catch(() => {});
				return undefined;
			}
			if (!response.ok) {
				const detail = await readCapped(response, controller.signal, 64 * 1024).catch(() => "");
				controller.signal.throwIfAborted();
				throw httpError(response.status, errorDetail(detail));
			}
			if (/zip/i.test(response.headers.get("content-type") ?? "")) {
				await response.body?.cancel().catch(() => {});
				badResponse("Docling returned a zip archive instead of a JSON result");
			}
			const text = await readCapped(response, controller.signal, maxResponseBytes);
			try {
				return JSON.parse(text) as unknown;
			} catch (error) {
				throw new ConverterError("bad_response", "Docling returned invalid JSON", false, { cause: error });
			}
		} catch (error) {
			throw classify(error, job, elapsed, timeoutMs);
		} finally {
			clearTimeout(timer);
			job.signal.removeEventListener("abort", onJob);
		}
	}

	const fetchVersion = async (job: Job) => {
		const body = await requestJson(job, "/version", { method: "GET" }, requestTimeoutMs, true);
		return body === undefined ? "unknown" : versionString(body);
	};

	function taskStatus(body: unknown): TaskStatus {
		const record = asRecord(body);
		if (!record || typeof record.task_id !== "string" || !record.task_id) badResponse("Docling did not return a task id");
		if (typeof record.task_status !== "string" || !TASK_STATUSES.has(record.task_status)) badResponse(`Docling returned unknown task status ${String(record.task_status)}`);
		return record as unknown as TaskStatus;
	}

	function taskFailure(failure: unknown, fallback: string | null | undefined): ConverterError {
		const info = asRecord(failure);
		const message = typeof info?.message === "string" && info.message ? info.message : fallback || "no reason given";
		return new ConverterError("conversion_failed", `Docling could not convert the PDF: ${message}`, info?.retryable === true);
	}

	return {
		id: "docling",
		version: DOCLING_CLIENT_VERSION,
		options: { ocr, formulaEnrichment },
		maxBytes: MATERIAL_MAX_BYTES,
		maxPages: PDF_MAX_PAGES,
		serverVersion(signal) {
			return asJob(signal, requestTimeoutMs, fetchVersion);
		},
		async convert(input, ctx: ConvertContext): Promise<ConvertResult> {
			if (input.bytes.byteLength > MATERIAL_MAX_BYTES) throw new ConverterError("too_large", "PDF exceeds the material size limit", false);
			if (input.pageCount > PDF_MAX_PAGES) throw new ConverterError("too_many_pages", `PDF exceeds ${PDF_MAX_PAGES} pages`, false);
			return asJob(ctx.signal, jobDeadlineMs, async (job) => {
				const total = input.pageCount;
				ctx.onProgress("connecting", undefined, total);
				const converterVersion = await fetchVersion(job);

				ctx.onProgress("uploading", undefined, total);
				const delimiter = `<!-- learnharness-page-${randomUUID()} -->`;
				const form = new FormData();
				form.append("files", new Blob([input.bytes.slice().buffer as ArrayBuffer], { type: "application/pdf" }), input.filename);
				form.append("from_formats", "pdf");
				form.append("to_formats", "md");
				form.append("to_formats", "json");
				form.append("image_export_mode", "placeholder");
				form.append("do_ocr", String(ocr));
				form.append("do_formula_enrichment", String(formulaEnrichment));
				form.append("abort_on_error", "false");
				form.append("md_page_break_placeholder", delimiter);
				let status = taskStatus(await requestJson(job, "/v1/convert/file/async", { method: "POST", body: form }, uploadTimeoutMs));
				const taskPath = encodeURIComponent(status.task_id);

				while (status.task_status === "pending" || status.task_status === "started") {
					ctx.onProgress(status.task_status === "pending" ? "queued" : "converting", undefined, total);
					const started = Date.now();
					status = taskStatus(await requestJson(job, `/v1/status/poll/${taskPath}?wait=${pollWaitSeconds}`, { method: "GET" }, requestTimeoutMs + pollWaitSeconds * 1000));
					const waited = Date.now() - started;
					if ((status.task_status === "pending" || status.task_status === "started") && waited < minPollIntervalMs) await delay(minPollIntervalMs - waited, job.signal);
				}
				if (status.task_status === "failure") throw taskFailure(status.failure, status.error_message);
				if (status.task_status === "skipped") throw taskFailure(status.failure, status.error_message ?? "Docling skipped the document");

				ctx.onProgress("downloading", undefined, total);
				const result = asRecord(await requestJson(job, `/v1/result/${taskPath}`, { method: "GET" }, requestTimeoutMs)) ?? badResponse("Docling's result is not an object");
				if (result.kind === "TaskFailureResult" || (result.failure !== undefined && result.document === undefined)) throw taskFailure(result.failure, undefined);
				const errors = (Array.isArray(result.errors) ? result.errors : []).map(asRecord).filter((e) => e !== undefined);
				if (result.status === "failure" || result.status === "skipped") {
					const reasons = errors.map((e) => e.error_message).filter((m): m is string => typeof m === "string");
					throw new ConverterError("conversion_failed", `Docling could not convert the PDF: ${reasons.join("; ") || `status ${String(result.status)}`}`, false);
				}
				const document = asRecord(result.document) ?? badResponse("Docling's result has no document");
				if (typeof document.md_content !== "string") badResponse("Docling's result has no Markdown content");
				const pages = assignDoclingPages(document.md_content, document.json_content, delimiter, total);

				const warnings: string[] = [];
				for (const error of errors) {
					const message = typeof error.error_message === "string" ? error.error_message : "unknown error";
					const page = error.page_no;
					if (!Number.isInteger(page) || (page as number) < 1 || (page as number) > total) {
						warnings.push(`Docling reported: ${message}`);
						continue;
					}
					const index = (page as number) - 1;
					if (pages[index]!.status === "ok") warnings.push(`Docling reported a problem on page ${page}: ${message}`);
					else pages[index] = { page: page as number, status: "unreadable", reason: message };
				}
				ctx.onProgress("complete", total, total);
				return { converterVersion, pages, ...(warnings.length ? { warnings } : {}) };
			});
		},
	};
}
