import { headerValueProblem } from "../../core/http-converter-spec.ts";
import { MATERIAL_MAX_BYTES } from "../../core/materials.ts";
import { ConverterError, type ConvertResult, type PageResult } from "../../core/pdf-converter.ts";

/**
 * The request discipline every remote converter shares (fork addition, 2026-11-25; factored out of the Docling
 * client so the declarative HTTP interpreter uses the very same code):
 *
 *   - one JOB per conversion: the caller's abort signal plus the job deadline;
 *   - every request under the job, with its own timeout (the upload a longer one);
 *   - every response body read inside its request as a stream, capped (declared and actual size);
 *   - redirects never followed: a redirect is bad_response;
 *   - one mapping of HTTP statuses and network failures to ConverterError kinds;
 *   - nothing here retries, so an upload is never sent twice;
 *   - every secret (the API key) is removed from everything that leaves a converter: error messages (before any
 *     truncation), the converter version, warnings, page text and page reasons (redactSecrets, redactConversion).
 */

// ── Secrets ────────────────────────────────────────────────────────────────

/** What replaces a secret in any text. */
export const REDACTED = "[redacted]";
/** The warning a conversion carries when the service's answer contained the API key (removed from the text). */
export const SECRET_REDACTED_WARNING = "The service's answer contained the API key; it was removed from the text.";
/** The shortest API key the app stores: a shorter one could not be removed from text without mangling ordinary words. */
export const API_KEY_MIN_LENGTH = 8;
export const API_KEY_MAX_LENGTH = 4096;

/**
 * Every form a secret can take in a service's text: as is, URL-encoded (encodeURIComponent with upper- and lower-case
 * hex, and the form encoding with + for a space), as it appears inside a JSON string (quotes and backslashes escaped,
 * which is how a truncated JSON error body carries it), and base64 (standard with and without padding, and
 * base64url). Not covered: hex, and a secret base64-encoded together with other text (for example `user:key` in Basic
 * auth), whose base64 depends on what precedes it.
 */
export function secretForms(secret: string): string[] {
	if (!secret) return [];
	const base64 = Buffer.from(secret, "utf8").toString("base64");
	const encoded = encodeURIComponent(secret);
	const lowerHex = encoded.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
	const forms = new Set([
		secret, encoded, lowerHex, encoded.replace(/%20/g, "+"), lowerHex.replace(/%20/g, "+"), JSON.stringify(secret).slice(1, -1),
		base64, base64.replace(/=+$/, ""), Buffer.from(secret, "utf8").toString("base64url"),
	]);
	return [...forms].filter((form) => form.length > 0).sort((a, b) => b.length - a.length);
}

/** `text` with every form of every secret replaced by [redacted]. Empty secrets are ignored; any other length is removed. */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
	let out = text;
	for (const secret of secrets) {
		if (!secret) continue;
		for (const form of secretForms(secret)) if (out.includes(form)) out = out.split(form).join(REDACTED);
	}
	return out;
}

/** Whether `text` holds any form of any secret. */
export function containsSecret(text: string, secrets: readonly (string | undefined)[]): boolean {
	return secrets.some((secret) => !!secret && secretForms(secret).some((form) => text.includes(form)));
}

/** Every string inside a JSON-like value with the secrets removed (a new value; the input is not changed). */
export function redactDeep<T>(value: T, secrets: readonly (string | undefined)[]): T {
	if (!secrets.some(Boolean)) return value;
	const walk = (node: unknown): unknown =>
		typeof node === "string" ? redactSecrets(node, secrets)
		: Array.isArray(node) ? node.map(walk)
		: node !== null && typeof node === "object" ? Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]))
		: node;
	return walk(value) as T;
}

/** The messages along an error's `cause` chain, joined (bounded depth): what a logged error would print. */
export function causeText(error: unknown): string {
	const parts: string[] = [];
	let current: unknown = error;
	for (let depth = 0; depth < 6 && current !== undefined && current !== null; depth++) {
		parts.push(current instanceof Error ? `${current.name}: ${current.message}` : String(current));
		current = current instanceof Error ? current.cause : undefined;
	}
	return parts.join("\n");
}

/** `{ cause }` for a new error only when the cause's own text holds no secret: an engine's parse or network error can
 *  quote the text it choked on (V8's JSON.parse quotes the start of the body), and a cause is printed with the error. */
export function safeCause(cause: unknown, redact: (text: string) => string): { cause: unknown } | undefined {
	const text = causeText(cause);
	return redact(text) === text ? { cause } : undefined;
}

/** A ConverterError with the secrets removed from its message and no cause that carries one (the same error when
 *  there was nothing to remove). */
export function redactError(error: ConverterError, secrets: readonly (string | undefined)[]): ConverterError {
	const message = redactSecrets(error.message, secrets);
	const cause = error.cause === undefined ? "" : causeText(error.cause);
	if (message === error.message && !containsSecret(cause, secrets)) return error;
	const httpStatus = error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus };
	return new ConverterError(error.kind, message, error.retryable, containsSecret(cause, secrets) ? httpStatus : { cause: error.cause, ...httpStatus });
}

/**
 * A conversion's answer with the secrets removed from its version, warnings, page text and page reasons. A service
 * that echoed a secret is reported through SECRET_REDACTED_WARNING (the converter test turns it into a failure).
 */
export function redactConversion(result: ConvertResult, secrets: readonly (string | undefined)[]): ConvertResult {
	if (!secrets.some(Boolean)) return result;
	let echoed = false;
	const clean = (text: string): string => {
		const out = redactSecrets(text, secrets);
		if (out !== text) echoed = true;
		return out;
	};
	const pages = result.pages.map((page): PageResult => {
		if (page.status === "ok") return { ...page, markdown: clean(page.markdown) };
		return page.reason === undefined ? page : { ...page, reason: clean(page.reason) };
	});
	const converterVersion = clean(result.converterVersion);
	const warnings = (result.warnings ?? []).map(clean);
	if (echoed && !warnings.includes(SECRET_REDACTED_WARNING)) warnings.push(SECRET_REDACTED_WARNING);
	return { ...result, converterVersion, pages, ...(warnings.length ? { warnings } : {}) };
}

export { headerValueProblem };

/** Why a stored key cannot be sent (checked when it is used: characters fetch would refuse), or undefined. */
export function storedKeyProblem(key: string): string | undefined {
	const trimmed = key.trim();
	// a key stored before the length rule existed: too short to remove from text without mangling ordinary words
	if (trimmed.length > 0 && trimmed.length < API_KEY_MIN_LENGTH) return `The stored API key is shorter than ${API_KEY_MIN_LENGTH} characters; enter the key again in Settings → PDF conversion`;
	const problem = headerValueProblem(trimmed);
	return problem ? `The API key ${problem}` : undefined;
}

/** Why an API key cannot be stored (checked when it is saved: length and characters), or undefined. */
export function apiKeyProblem(key: string): string | undefined {
	const trimmed = key.trim();
	if (trimmed.length < API_KEY_MIN_LENGTH) return `An API key must be at least ${API_KEY_MIN_LENGTH} characters long`;
	if (trimmed.length > API_KEY_MAX_LENGTH) return `An API key must be at most ${API_KEY_MAX_LENGTH} characters long`;
	const problem = headerValueProblem(trimmed);
	return problem ? `The API key ${problem}` : undefined;
}

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
	/** Removed from every message before it is shortened or leaves the job (the API key). */
	secrets?: readonly (string | undefined)[];
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
	const http = { httpStatus: status };
	if (status === 401 || status === 403) return new ConverterError("auth", `${name} refused the key (HTTP ${status})${suffix}`, false, http);
	if (status === 429) return new ConverterError("rate_limit", `${name} rate limit reached (HTTP 429)${suffix}`, true, http);
	if (status === 413) return new ConverterError("too_large", `${name} rejected the PDF as too large (HTTP 413)${suffix}`, false, http);
	if (status === 408 || status === 504) return new ConverterError("timeout", `${name} timed out (HTTP ${status})${suffix}`, true, http);
	if (status >= 500) return new ConverterError("unreachable", `${name} failed (HTTP ${status})${suffix}`, true, http);
	return new ConverterError("bad_response", `${name} rejected the request (HTTP ${status})${suffix}`, false, http);
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

/** The longest service message quoted in an error. */
export const SERVICE_MESSAGE_CHARS = 300;

/** A service's message, secrets removed first, then shortened (so no prefix of a secret survives the cut). */
export function serviceMessage(text: string, secrets: readonly (string | undefined)[] = []): string {
	return redactSecrets(text, secrets).slice(0, SERVICE_MESSAGE_CHARS);
}

/** A short reason from an error body (FastAPI's `detail`, or a `message`), secrets removed before it is shortened. */
export function errorDetail(text: string, secrets: readonly (string | undefined)[] = []): string {
	try {
		const body = asRecord(JSON.parse(text));
		const detail = body?.detail ?? body?.message;
		if (typeof detail === "string") return serviceMessage(detail, secrets);
		if (detail !== undefined) return serviceMessage(JSON.stringify(detail), secrets);
	} catch {
		// not JSON
	}
	return serviceMessage(text.trim(), secrets);
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
	/** The service's secrets removed from a text. */
	redact(text: string): string;
}

export function classifyConverterFailure(error: unknown, job: ConverterJob, requestElapsed: boolean, timeoutMs: number): ConverterError {
	if (error instanceof ConverterError) return error;
	const { name, baseUrl } = job.service;
	const cause = safeCause(error, job.redact);
	if (job.parent.aborted) return new ConverterError("aborted", "PDF conversion was aborted", false, cause);
	if (job.deadlineElapsed()) return new ConverterError("timeout", `${name} did not finish within the ${seconds(job.deadlineMs)} job deadline`, true, cause);
	if (requestElapsed) return new ConverterError("timeout", `${name} did not answer within ${seconds(timeoutMs)}`, true, cause);
	const reason = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
	return new ConverterError("unreachable", `Could not reach ${name} at ${baseUrl}: ${job.redact(reason)}`, true, cause);
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
	const secrets = service.secrets ?? [];
	const job: ConverterJob = { service, signal: controller.signal, parent, deadlineElapsed: () => elapsed, deadlineMs, redact: (text) => redactSecrets(text, secrets) };
	try {
		return await work(job);
	} catch (error) {
		throw redactError(classifyConverterFailure(error, job, false, 0), secrets);
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

/**
 * One request and its whole body, as JSON, under the job, its own timeout and the size cap. Never follows a redirect.
 * `init.headers` must already be a Headers object (built by the caller, so a value fetch would refuse fails there,
 * as a configuration problem, never as an unreachable service).
 */
export async function requestServiceJson(job: ConverterJob, url: string, init: RequestInit & { headers?: Headers }, options: ServiceRequestOptions): Promise<unknown> {
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
			badResponse(`${name} answered with a redirect (HTTP ${response.status}${location ? ` to ${serviceMessage(location, job.service.secrets)}` : ""}); set the ${name} URL to the address the service itself answers at`);
		}
		if (options.accept404 && response.status === 404) {
			await response.body?.cancel().catch(() => {});
			return undefined;
		}
		if (!response.ok) {
			const detail = await readCapped(response, controller.signal, ERROR_BODY_BYTES, name).catch(() => "");
			controller.signal.throwIfAborted();
			throw httpStatusError(name, response.status, errorDetail(detail, job.service.secrets));
		}
		if (/zip/i.test(response.headers.get("content-type") ?? "")) {
			await response.body?.cancel().catch(() => {});
			badResponse(`${name} returned a zip archive instead of a JSON result`);
		}
		const text = await readCapped(response, controller.signal, options.maxResponseBytes, name);
		try {
			return JSON.parse(text) as unknown;
		} catch {
			// no cause: the engine's SyntaxError quotes the start of the body, which a service may have filled with the key
			throw new ConverterError("bad_response", `${name} returned invalid JSON`, false);
		}
	} catch (error) {
		throw classifyConverterFailure(error, job, elapsed, options.timeoutMs);
	} finally {
		clearTimeout(timer);
		job.signal.removeEventListener("abort", onJob);
	}
}

/**
 * The headers of a request as a Headers object, every value checked first. A value fetch would refuse is a
 * configuration problem (`kind`, default not_configured), raised before anything is sent, so it never reads as an
 * unreachable service and never triggers the fallback to the built-in reader.
 */
export function buildHeaders(entries: readonly (readonly [string, string])[], name: string, kind: "auth" | "not_configured" = "not_configured"): Headers {
	const headers = new Headers();
	for (const [header, value] of entries) {
		const problem = headerValueProblem(value);
		if (problem) throw new ConverterError(kind, `${name}: the ${header} header ${problem}; nothing was sent`, false);
		try {
			headers.set(header, value);
		} catch {
			throw new ConverterError(kind, `${name}: the ${header} header cannot be sent; nothing was sent`, false);
		}
	}
	return headers;
}
