import { MATERIAL_MAX_BYTES } from "../../core/materials.ts";
import { ConverterError } from "../../core/pdf-converter.ts";

/**
 * The request discipline every remote converter shares (fork addition, 2026-11-25; factored out of the Docling
 * client so the declarative HTTP interpreter uses the very same code):
 *
 *   - one JOB per conversion: the caller's abort signal plus the job deadline;
 *   - every request under the job, with its own timeout (the upload a longer one);
 *   - every response body read inside its request as a stream, capped (declared and actual size);
 *   - redirects never followed: a redirect is bad_response;
 *   - one mapping of HTTP statuses and network failures to ConverterError kinds;
 *   - nothing here retries, so an upload is never sent twice.
 */

/** One ordinary request (version, poll, result). */
export const CONVERTER_REQUEST_TIMEOUT_MS = 30_000;
/** The upload request, which carries the PDF. */
export const CONVERTER_UPLOAD_TIMEOUT_MS = 5 * 60_000;
/** The whole job: every request and wait. */
export const CONVERTER_JOB_DEADLINE_MS = 15 * 60_000;
/** The largest response body read (a result can carry Markdown and a JSON document). */
export const CONVERTER_MAX_RESPONSE_BYTES = 2 * MATERIAL_MAX_BYTES;
/** The largest error body read for its message. */
const ERROR_BODY_BYTES = 64 * 1024;

/** The service as its messages name it. */
export interface ConverterService {
	/** "Docling", "Mistral OCR", … */
	name: string;
	/** Where it was configured to be (the base URL), for "Could not reach …". */
	baseUrl: string;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function badResponse(message: string): never {
	throw new ConverterError("bad_response", message, false);
}

export function seconds(ms: number): string {
	return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
}

export function httpStatusError(name: string, status: number, detail: string): ConverterError {
	const suffix = detail ? `: ${detail}` : "";
	if (status === 401 || status === 403) return new ConverterError("auth", `${name} refused the key (HTTP ${status})${suffix}`, false);
	if (status === 429) return new ConverterError("rate_limit", `${name} rate limit reached (HTTP 429)${suffix}`, true);
	if (status === 413) return new ConverterError("too_large", `${name} rejected the PDF as too large (HTTP 413)${suffix}`, false);
	if (status === 408 || status === 504) return new ConverterError("timeout", `${name} timed out (HTTP ${status})${suffix}`, true);
	if (status >= 500) return new ConverterError("unreachable", `${name} failed (HTTP ${status})${suffix}`, true);
	return new ConverterError("bad_response", `${name} rejected the request (HTTP ${status})${suffix}`, false);
}

/** A response body as text: declared and actual size capped, every read under `signal`. */
export async function readCapped(response: Response, signal: AbortSignal, maxBytes: number, name: string): Promise<string> {
	const declared = Number(response.headers.get("content-length") ?? NaN);
	const tooLarge = () => new ConverterError("bad_response", `${name}'s answer is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit`, false);
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
export function errorDetail(text: string): string {
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

export function delay(ms: number, signal: AbortSignal): Promise<void> {
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

export interface ConverterJob {
	service: ConverterService;
	/** Aborted by the caller's signal or the job deadline. */
	signal: AbortSignal;
	/** The caller's own signal (an abort, not a timeout). */
	parent: AbortSignal;
	deadlineElapsed(): boolean;
	deadlineMs: number;
}

export function classifyConverterFailure(error: unknown, job: ConverterJob, requestElapsed: boolean, timeoutMs: number): ConverterError {
	if (error instanceof ConverterError) return error;
	const { name, baseUrl } = job.service;
	if (job.parent.aborted) return new ConverterError("aborted", "PDF conversion was aborted", false, { cause: error });
	if (job.deadlineElapsed()) return new ConverterError("timeout", `${name} did not finish within the ${seconds(job.deadlineMs)} job deadline`, true, { cause: error });
	if (requestElapsed) return new ConverterError("timeout", `${name} did not answer within ${seconds(timeoutMs)}`, true, { cause: error });
	const reason = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
	return new ConverterError("unreachable", `Could not reach ${name} at ${baseUrl}: ${reason}`, true, { cause: error });
}

/** Run `work` as one job: the caller's signal plus the job deadline. Every failure leaves as a ConverterError. */
export async function runConverterJob<T>(service: ConverterService, parent: AbortSignal, deadlineMs: number, work: (job: ConverterJob) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	let elapsed = false;
	const onParent = () => controller.abort(parent.reason);
	if (parent.aborted) onParent();
	else parent.addEventListener("abort", onParent, { once: true });
	const deadline = setTimeout(() => {
		elapsed = true;
		controller.abort(new Error(`${service.name} job deadline elapsed`));
	}, deadlineMs);
	const job: ConverterJob = { service, signal: controller.signal, parent, deadlineElapsed: () => elapsed, deadlineMs };
	try {
		return await work(job);
	} catch (error) {
		throw classifyConverterFailure(error, job, false, 0);
	} finally {
		clearTimeout(deadline);
		parent.removeEventListener("abort", onParent);
	}
}

export interface ServiceRequestOptions {
	timeoutMs: number;
	maxResponseBytes: number;
	/** Answer undefined for a 404 instead of failing (an optional endpoint). */
	accept404?: boolean;
}

/** One request and its whole body, as JSON, under the job, its own timeout and the size cap. Never follows a redirect. */
export async function requestServiceJson(job: ConverterJob, url: string, init: RequestInit, options: ServiceRequestOptions): Promise<unknown> {
	const { name } = job.service;
	const controller = new AbortController();
	let elapsed = false;
	const onJob = () => controller.abort(job.signal.reason);
	if (job.signal.aborted) onJob();
	else job.signal.addEventListener("abort", onJob, { once: true });
	const timer = setTimeout(() => {
		elapsed = true;
		controller.abort(new Error(`${name} request timeout`));
	}, options.timeoutMs);
	try {
		const response = await fetch(url, { ...init, redirect: "manual", signal: controller.signal });
		if ((response.status >= 300 && response.status < 400) || response.type === "opaqueredirect") {
			await response.body?.cancel().catch(() => {});
			const location = response.headers.get("location");
			badResponse(`${name} answered with a redirect (HTTP ${response.status}${location ? ` to ${location}` : ""}); set the ${name} URL to the address the service itself answers at`);
		}
		if (options.accept404 && response.status === 404) {
			await response.body?.cancel().catch(() => {});
			return undefined;
		}
		if (!response.ok) {
			const detail = await readCapped(response, controller.signal, ERROR_BODY_BYTES, name).catch(() => "");
			controller.signal.throwIfAborted();
			throw httpStatusError(name, response.status, errorDetail(detail));
		}
		if (/zip/i.test(response.headers.get("content-type") ?? "")) {
			await response.body?.cancel().catch(() => {});
			badResponse(`${name} returned a zip archive instead of a JSON result`);
		}
		const text = await readCapped(response, controller.signal, options.maxResponseBytes, name);
		try {
			return JSON.parse(text) as unknown;
		} catch (error) {
			throw new ConverterError("bad_response", `${name} returned invalid JSON`, false, { cause: error });
		}
	} catch (error) {
		throw classifyConverterFailure(error, job, elapsed, options.timeoutMs);
	} finally {
		clearTimeout(timer);
		job.signal.removeEventListener("abort", onJob);
	}
}
