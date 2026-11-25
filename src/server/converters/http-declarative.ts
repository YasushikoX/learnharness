import { createHash, randomUUID } from "node:crypto";
import {
	POLL_DEFAULT_INTERVAL_MS,
	POLL_MAX_COUNT,
	fillPlaceholders,
	jsonPointerGet,
	jsonPointerSet,
	profileUrl,
	validateHttpConverterProfile,
	type HttpConverterProfile,
} from "../../core/http-converter-spec.ts";
import { MATERIAL_MAX_BYTES } from "../../core/materials.ts";
import { ConverterError, PDF_MAX_PAGES, type ConvertContext, type ConvertResult, type PageResult, type PdfConverter } from "../../core/pdf-converter.ts";
import { normalizeBaseUrl } from "../../core/settings.ts";
import {
	CONVERTER_JOB_DEADLINE_MS,
	CONVERTER_MAX_RESPONSE_BYTES,
	CONVERTER_REQUEST_TIMEOUT_MS,
	CONVERTER_UPLOAD_TIMEOUT_MS,
	SECRET_REDACTED_WARNING,
	storedKeyProblem,
	badResponse,
	buildHeaders,
	delay,
	redactConversion,
	redactError,
	requestServiceJson,
	runConverterJob,
	serviceMessage,
	type ConverterJob,
} from "./http-common.ts";

/**
 * The declarative HTTP converter (fork addition, 2026-11-25): turns a validated profile
 * (core/http-converter-spec.ts) plus a base URL and a credential into a PdfConverter. The host makes every request
 * itself; the profile only says where things are.
 *
 *   submit   one upload (multipart, or base64 inside a JSON body), never sent twice
 *   poll     optional: the job id from the submit answer, status checks every intervalMs, bounded by maxPolls and
 *            the job deadline
 *   result   optional: one separate request for the finished answer
 *   extract  a page array (numbers from the declared field) or one Markdown string split at a delimiter
 *
 * Request discipline (http-common.ts, shared with the Docling client): cancellable to the last byte, capped bodies,
 * a longer upload timeout, the job deadline, redirects refused as bad_response, one mapping of failures.
 *
 * ORIGIN. Every URL is built under the configured base URL and checked before its request (profileUrl); a profile
 * whose paths leave it is refused when the converter is created, before anything is sent. The credential goes only
 * into the profile's one auth header, only on requests to that origin.
 *
 * PAGES. A page array must have exactly one entry per PDF page (checked before anything is mapped); its numbers come
 * from the declared field and the host's normaliser rejects duplicates, gaps and out-of-range numbers. A delimited
 * answer is split with a limit and must match the declared placement exactly: `between` gives one segment per page,
 * `after` and `before` one more, which must be the empty last (after) or first (before) one. Anything else is
 * bad_response: a generic profile cannot tell a blank page from a missing break, so it never guesses.
 *
 * SECRETS. The key is removed from every page text, page reason, warning, version and error message (before any
 * message is shortened); a service that echoes it is reported through SECRET_REDACTED_WARNING, which the validator
 * turns into a failure. A key that cannot be sent in a header is an `auth` error before anything is sent (never
 * "unreachable", so it never falls back to the built-in reader quietly).
 */

/** The interpreter's own version (part of every profile converter's version). */
export const HTTP_ENGINE_VERSION = "1";
export { SECRET_REDACTED_WARNING };

export interface HttpConverterOptions {
	/** The settings id: a preset's id, or `custom:<id>`. */
	converterId: string;
	/** Validated again here, every time. */
	profile: unknown;
	/** A bundled preset (the only kind that may carry defaultBaseUrl). Default false: validated as untrusted. */
	bundled?: boolean;
	/** The service URL saved in the settings (a profile's defaultBaseUrl is never used here). */
	baseUrl: string;
	apiKey?: string;
	requestTimeoutMs?: number;
	uploadTimeoutMs?: number;
	jobDeadlineMs?: number;
	maxResponseBytes?: number;
	/** Overrides the profile's poll interval (tests). */
	pollIntervalMs?: number;
}

function notConfigured(message: string): never {
	throw new ConverterError("not_configured", message, false);
}

/** The version a profile converter records: the profile's own version, a digest of its content, the engine. */
export function profileConverterVersion(profile: HttpConverterProfile): string {
	const digest = createHash("sha256").update(JSON.stringify(profile)).digest("hex").slice(0, 8);
	return `${profile.version}+${digest}/http${HTTP_ENGINE_VERSION}`;
}

function sameScalar(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function pageNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isInteger(value)) return value;
	if (typeof value === "string" && /^(?:0|[1-9]\d{0,5})$/.test(value)) return Number(value);
	return undefined;
}

/**
 * One Markdown string split into the PDF's pages at `delimiter`, by the declared placement, strictly (pure; exported
 * for tests). `split` is given a limit, so a hostile answer full of delimiters cannot allocate millions of segments.
 *   between  exactly pageCount segments;
 *   after    exactly pageCount + 1, the last one empty (a delimiter after every page, the last one included);
 *   before   exactly pageCount + 1, the first one empty.
 * Anything else is bad_response saying the service did not mark every page.
 */
export function splitPages(markdown: string, delimiter: string, placement: "between" | "after" | "before", pageCount: number, name: string): string[] {
	const expected = placement === "between" ? pageCount : pageCount + 1;
	const limit = pageCount + 3;
	const segments = markdown.split(delimiter, limit);
	const counted = segments.length === limit ? `more than ${limit - 1}` : String(segments.length);
	const fail = (detail: string): never =>
		badResponse(`${name} did not mark every page: ${detail}, so its text cannot be placed on pages reliably`);
	const pages = `${pageCount} ${pageCount === 1 ? "page" : "pages"}`;
	if (segments.length !== expected) {
		const what = placement === "between" ? "" : ` (a page break ${placement} every page gives ${expected})`;
		fail(`its answer has ${counted} page ${segments.length === 1 ? "segment" : "segments"} for the PDF's ${pages}${what}`);
	}
	if (placement === "after") {
		if (segments.at(-1)!.trim()) fail(`its answer does not end with a page break, though the profile says one follows every page (PDF of ${pages})`);
		return segments.slice(0, -1);
	}
	if (placement === "before") {
		if (segments[0]!.trim()) fail(`its answer does not start with a page break, though the profile says one precedes every page (PDF of ${pages})`);
		return segments.slice(1);
	}
	return segments;
}

export function createHttpConverter(options: HttpConverterOptions): PdfConverter {
	const checked = validateHttpConverterProfile(options.profile, { bundled: options.bundled === true });
	if (!checked.ok) notConfigured(`The converter profile is not valid: ${checked.errors.join("; ")}`);
	const profile = checked.profile;
	const name = profile.name;
	const baseUrl = normalizeBaseUrl(options.baseUrl);
	if (!baseUrl) notConfigured(`${name} needs an absolute HTTP(S) base URL without credentials, query or fragment`);
	const origin = new URL(baseUrl).origin;
	const apiKey = options.apiKey?.trim() || undefined;
	if (profile.auth && !apiKey) notConfigured(`${name} needs an API key for ${origin}`);
	const secrets = apiKey ? [apiKey] : [];
	/** Checked when a conversion starts, as an auth error: a stored key that cannot be sent is never "unreachable". */
	const keyProblem = profile.auth && apiKey ? storedKeyProblem(apiKey) : undefined;

	// Every URL the profile can produce, checked before anything is sent.
	let submitUrl: string;
	try {
		submitUrl = profileUrl(baseUrl, profile.submit.path);
		if (profile.poll) profileUrl(baseUrl, profile.poll.path, "job");
		if (profile.result) profileUrl(baseUrl, profile.result.path, "job");
	} catch (error) {
		notConfigured(`${name}: ${(error as Error).message}; nothing was sent`);
	}

	const requestTimeoutMs = options.requestTimeoutMs ?? CONVERTER_REQUEST_TIMEOUT_MS;
	const uploadTimeoutMs = options.uploadTimeoutMs ?? CONVERTER_UPLOAD_TIMEOUT_MS;
	const jobDeadlineMs = options.jobDeadlineMs ?? CONVERTER_JOB_DEADLINE_MS;
	const maxResponseBytes = options.maxResponseBytes ?? CONVERTER_MAX_RESPONSE_BYTES;
	const maxBytes = Math.min(profile.limits?.maxBytes ?? MATERIAL_MAX_BYTES, MATERIAL_MAX_BYTES);
	const maxPages = Math.min(profile.limits?.maxPages ?? PDF_MAX_PAGES, PDF_MAX_PAGES);
	const version = profileConverterVersion(profile);

	/** Every request's headers, built and checked before anything is sent (a Headers object, never a plain record). */
	const headersFor = (extra: readonly (readonly [string, string])[] = []): Headers => {
		const fixed = buildHeaders([["Accept", "application/json"], ...Object.entries(profile.submit.headers ?? {}), ...extra], name);
		if (profile.auth && apiKey) {
			const credential = buildHeaders([[profile.auth.header, fillPlaceholders(profile.auth.value, { API_KEY: apiKey })]], name, "auth");
			credential.forEach((value, header) => fixed.set(header, value));
		}
		return fixed;
	};

	/** One request to a path under the base URL; the URL is checked again right before it is sent. */
	const request = (job: ConverterJob, url: string, init: RequestInit, timeoutMs: number, extra: readonly (readonly [string, string])[] = []) =>
		requestServiceJson(job, url, { ...init, headers: headersFor(extra) }, { timeoutMs, maxResponseBytes });

	const urlFor = (template: string, jobId?: string): string => {
		try {
			return profileUrl(baseUrl, template, jobId);
		} catch (error) {
			return badResponse(`${name}: ${(error as Error).message}; the request was not sent`);
		}
	};

	function submitBody(input: { bytes: Uint8Array; filename: string }, delimiter: string | undefined): { body: BodyInit; headers?: [string, string][] } {
		const fill = (text: string) => (delimiter !== undefined && text.includes("{{DELIMITER}}") ? fillPlaceholders(text, { DELIMITER: delimiter }) : text);
		const body = profile.submit.body;
		if (body.type === "multipart") {
			const form = new FormData();
			form.append(body.fileField, new Blob([input.bytes.slice().buffer as ArrayBuffer], { type: "application/pdf" }), input.filename);
			for (const [field, value] of Object.entries(body.fields ?? {})) {
				for (const item of Array.isArray(value) ? value : [value]) form.append(field, fill(item));
			}
			return { body: form };
		}
		const fillDeep = (value: unknown): unknown =>
			typeof value === "string" ? fill(value)
			: Array.isArray(value) ? value.map(fillDeep)
			: value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDeep(v)]))
			: value;
		const json = fillDeep(structuredClone(body.json ?? {})) as Record<string, unknown>;
		const base64 = Buffer.from(input.bytes).toString("base64");
		jsonPointerSet(json, body.filePointer, body.encoding === "data-url" ? `data:application/pdf;base64,${base64}` : base64);
		return { body: JSON.stringify(json), headers: [["Content-Type", "application/json"]] };
	}

	function extractPages(answer: unknown, pageCount: number, delimiter: string | undefined): PageResult[] {
		const extract = profile.extract;
		const noText = `${name} returned no text for this page`;
		if (extract.type === "pages") {
			const list = jsonPointerGet(answer, extract.pagesPointer);
			if (!Array.isArray(list)) badResponse(`${name}'s answer has no page list at ${extract.pagesPointer || "its top level"}`);
			if (list.length !== pageCount) {
				badResponse(`${name}'s answer lists ${list.length} ${list.length === 1 ? "page" : "pages"} for the PDF's ${pageCount} ${pageCount === 1 ? "page" : "pages"}, so its text cannot be placed on pages reliably`);
			}
			return list.map((item, i): PageResult => {
				const number = pageNumber(jsonPointerGet(item, extract.numberPointer));
				if (number === undefined) badResponse(`${name}'s page entry ${i} has no page number at ${extract.numberPointer}`);
				const page = extract.numberBase === 0 ? number + 1 : number;
				const markdown = jsonPointerGet(item, extract.markdownPointer);
				if (markdown === undefined || markdown === null) return { page, status: "empty", reason: noText };
				if (typeof markdown !== "string") badResponse(`${name}'s page entry ${i} has no Markdown text at ${extract.markdownPointer}`);
				return { page, status: "ok", markdown };
			});
		}
		const markdown = jsonPointerGet(answer, extract.markdownPointer);
		if (typeof markdown !== "string") badResponse(`${name}'s answer has no Markdown text at ${extract.markdownPointer || "its top level"}`);
		const segments = splitPages(markdown, delimiter!, extract.placement ?? "between", pageCount, name);
		return segments.map((segment, i): PageResult => {
			const text = segment.replace(/\r\n?/g, "\n").trim();
			return text ? { page: i + 1, status: "ok", markdown: text } : { page: i + 1, status: "empty", reason: noText };
		});
	}

	async function run(job: ConverterJob, input: { bytes: Uint8Array; filename: string; pageCount: number }, ctx: ConvertContext): Promise<ConvertResult> {
		const total = input.pageCount;
		const extract = profile.extract;
		const delimiter = extract.type !== "delimited" ? undefined : "random" in extract.delimiter ? `<!-- learnharness-page-${randomUUID()} -->` : extract.delimiter.literal;

		ctx.onProgress("uploading", undefined, total);
		let submit: ReturnType<typeof submitBody>;
		try {
			submit = submitBody(input, delimiter);
		} catch (error) {
			throw new ConverterError("not_configured", `${name}: the request body could not be built (${(error as Error).message}); nothing was sent`, false);
		}
		let answer = await request(job, submitUrl, { method: profile.submit.method, body: submit.body }, uploadTimeoutMs, submit.headers);

		const poll = profile.poll;
		let jobId: string | undefined;
		if (poll) {
			const id = jsonPointerGet(answer, poll.jobIdPointer);
			if ((typeof id !== "string" || !id) && !(typeof id === "number" && Number.isFinite(id))) badResponse(`${name} did not return a job id at ${poll.jobIdPointer}`);
			jobId = String(id);
			const pollUrl = urlFor(poll.path, jobId);
			const interval = options.pollIntervalMs ?? poll.intervalMs ?? POLL_DEFAULT_INTERVAL_MS;
			const maxPolls = poll.maxPolls ?? Math.min(POLL_MAX_COUNT, Math.ceil(jobDeadlineMs / Math.max(interval, 1)) + 1);
			for (let count = 0; ; count++) {
				if (count >= maxPolls) throw new ConverterError("timeout", `${name} did not finish after ${maxPolls} status checks`, true);
				await delay(interval, job.signal);
				answer = await request(job, pollUrl, { method: poll.method ?? "GET" }, requestTimeoutMs);
				const status = jsonPointerGet(answer, poll.statusPointer);
				if (poll.done.some((v) => sameScalar(v, status))) break;
				if ((poll.failed ?? []).some((v) => sameScalar(v, status))) {
					const reason = poll.errorPointer === undefined ? undefined : jsonPointerGet(answer, poll.errorPointer);
					const message = typeof reason === "string" && reason ? serviceMessage(reason, secrets) : reason !== undefined && reason !== null ? serviceMessage(JSON.stringify(reason), secrets) : "no reason given";
					throw new ConverterError("conversion_failed", `${name} could not convert the PDF: ${message}`, false);
				}
				if (!poll.running.some((v) => sameScalar(v, status))) badResponse(`${name} returned unknown job status ${serviceMessage(JSON.stringify(status) ?? "(none)", secrets)} at ${poll.statusPointer}`);
				ctx.onProgress("converting", undefined, total);
			}
		}
		if (profile.result) {
			ctx.onProgress("downloading", undefined, total);
			answer = await request(job, urlFor(profile.result.path, jobId), { method: profile.result.method ?? "GET" }, requestTimeoutMs);
		}

		const pages = extractPages(answer, total, delimiter);
		ctx.onProgress("complete", total, total);
		return redactConversion({ converterVersion: version, pages }, secrets);
	}

	return {
		id: options.converterId,
		label: name,
		version,
		options: {},
		maxBytes,
		maxPages,
		async convert(input, ctx) {
			if (input.bytes.byteLength > maxBytes) throw new ConverterError("too_large", `PDF exceeds ${name}'s size limit of ${Math.floor(maxBytes / 1024 / 1024)} MB`, false);
			if (input.pageCount > maxPages) throw new ConverterError("too_many_pages", `PDF exceeds ${name}'s limit of ${maxPages} pages`, false);
			if (keyProblem) throw new ConverterError("auth", `${keyProblem.replace("The API key", `The stored ${name} key`)}; enter the key again in Settings → PDF conversion. Nothing was sent.`, false);
			headersFor(); // a header fetch would refuse fails here, before the upload, as a configuration error
			try {
				return await runConverterJob({ name, baseUrl, secrets }, ctx.signal, jobDeadlineMs, (job) => run(job, input, ctx));
			} catch (error) {
				throw error instanceof ConverterError ? redactError(error, secrets) : error;
			}
		},
	};
}
