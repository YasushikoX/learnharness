import { randomUUID } from "node:crypto";
import { MATERIAL_MAX_BYTES } from "../../core/materials.ts";
import { ConverterError, PDF_MAX_PAGES, type ConvertResult, type PdfConverter } from "../../core/pdf-converter.ts";
import { normalizeBaseUrl } from "../../core/settings.ts";

export const DOCLING_CONVERTER_VERSION = "1.38.2";
export const CONVERTER_REQUEST_TIMEOUT_MS = 30_000;
export const CONVERTER_JOB_DEADLINE_MS = 15 * 60_000;
export const DOCLING_POLL_INTERVAL_MS = 1_000;

export interface DoclingConverterOptions {
	baseUrl: string;
	apiKey?: string;
	ocr?: boolean;
	formulaEnrichment?: boolean;
	fetch?: typeof fetch;
	requestTimeoutMs?: number;
	jobDeadlineMs?: number;
	pollIntervalMs?: number;
}

interface TaskStatus {
	task_id: string;
	task_status: "pending" | "started" | "failure" | "success" | "partial_success" | "skipped";
	error_message?: string | null;
	failure?: { message?: string; retryable?: boolean } | null;
}

interface ConversionResponse {
	status: TaskStatus["task_status"];
	document?: { md_content?: string | null };
	errors?: { error_message: string; page_no?: number | null }[];
}

function httpError(response: Response): ConverterError {
	const status = response.status;
	if (status === 401 || status === 403) return new ConverterError("auth", `Docling authentication failed (HTTP ${status})`, false);
	if (status === 429) return new ConverterError("rate_limit", "Docling rate limit reached (HTTP 429)", true);
	if (status === 413) return new ConverterError("too_large", "Docling rejected the PDF as too large (HTTP 413)", false);
	if (status === 408 || status === 504) return new ConverterError("timeout", `Docling request timed out (HTTP ${status})`, true);
	if (status >= 500) return new ConverterError("unreachable", `Docling service failed (HTTP ${status})`, true);
	return new ConverterError("bad_response", `Docling rejected the conversion (HTTP ${status})`, false);
}

async function jsonBody<T>(response: Response): Promise<T> {
	try {
		return await response.json() as T;
	} catch (error) {
		throw new ConverterError("bad_response", "Docling returned invalid JSON", false, { cause: error });
	}
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
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

export function createDoclingConverter(options: DoclingConverterOptions): PdfConverter {
	const baseUrl = normalizeBaseUrl(options.baseUrl);
	if (!baseUrl) throw new Error("Docling requires an absolute HTTP(S) base URL without credentials, query, or fragment");
	const fetcher = options.fetch ?? fetch;
	const requestTimeoutMs = options.requestTimeoutMs ?? CONVERTER_REQUEST_TIMEOUT_MS;
	const jobDeadlineMs = options.jobDeadlineMs ?? CONVERTER_JOB_DEADLINE_MS;
	const pollIntervalMs = options.pollIntervalMs ?? DOCLING_POLL_INTERVAL_MS;
	const ocr = options.ocr ?? true;
	const formulaEnrichment = options.formulaEnrichment ?? false;

	return {
		id: "docling",
		version: DOCLING_CONVERTER_VERSION,
		maxBytes: MATERIAL_MAX_BYTES,
		maxPages: PDF_MAX_PAGES,
		async convert(input, ctx): Promise<ConvertResult> {
			if (input.bytes.byteLength > MATERIAL_MAX_BYTES) throw new ConverterError("too_large", "PDF exceeds the material size limit", false);
			if (input.pageCount > PDF_MAX_PAGES) throw new ConverterError("too_many_pages", `PDF exceeds ${PDF_MAX_PAGES} pages`, false);
			const job = new AbortController();
			let deadlineElapsed = false;
			const parentAbort = () => job.abort(ctx.signal.reason);
			ctx.signal.addEventListener("abort", parentAbort, { once: true });
			if (ctx.signal.aborted) parentAbort();
			const deadline = setTimeout(() => {
				deadlineElapsed = true;
				job.abort(new Error("Docling job deadline elapsed"));
			}, jobDeadlineMs);
			const headers = options.apiKey ? { "X-Api-Key": options.apiKey } : undefined;

			const request = async (url: string, init: RequestInit): Promise<Response> => {
				const controller = new AbortController();
				let requestElapsed = false;
				const jobAbort = () => controller.abort(job.signal.reason);
				job.signal.addEventListener("abort", jobAbort, { once: true });
				if (job.signal.aborted) jobAbort();
				const timeout = setTimeout(() => {
					requestElapsed = true;
					controller.abort(new Error("Docling request timeout"));
				}, requestTimeoutMs);
				try {
					const response = await fetcher(url, { ...init, redirect: "error", headers: { ...headers, ...init.headers }, signal: controller.signal });
					if (!response.ok) throw httpError(response);
					return response;
				} catch (error) {
					if (error instanceof ConverterError) throw error;
					if (ctx.signal.aborted) throw new ConverterError("aborted", "PDF conversion was aborted", false, { cause: error });
					if (requestElapsed || deadlineElapsed) throw new ConverterError("timeout", "Docling conversion timed out", true, { cause: error });
					if (job.signal.aborted) throw new ConverterError("aborted", "PDF conversion was aborted", false, { cause: error });
					throw new ConverterError("unreachable", "Could not reach Docling", true, { cause: error });
				} finally {
					clearTimeout(timeout);
					job.signal.removeEventListener("abort", jobAbort);
				}
			};

			try {
				ctx.onProgress("submitting", 0, input.pageCount);
				const delimiter = `<!-- learnharness-page-${randomUUID()} -->`;
				const form = new FormData();
				const bytes = input.bytes.slice();
				form.append("files", new Blob([bytes.buffer as ArrayBuffer], { type: "application/pdf" }), input.filename);
				form.append("from_formats", "pdf");
				form.append("to_formats", "md");
				form.append("image_export_mode", "placeholder");
				form.append("do_ocr", String(ocr));
				form.append("do_formula_enrichment", String(formulaEnrichment));
				form.append("abort_on_error", "false");
				form.append("md_page_break_placeholder", delimiter);
				const submitted = await request(`${baseUrl}/v1/convert/file/async`, { method: "POST", body: form });
				const task = await jsonBody<TaskStatus>(submitted);
				if (!task.task_id) throw new ConverterError("bad_response", "Docling did not return a task id", false);

				let status = task;
				while (status.task_status === "pending" || status.task_status === "started") {
					ctx.onProgress("converting", undefined, input.pageCount);
					await delay(pollIntervalMs, job.signal);
					const polled = await request(`${baseUrl}/v1/status/poll/${encodeURIComponent(task.task_id)}?wait=0`, { method: "GET" });
					status = await jsonBody<TaskStatus>(polled);
				}
				if (status.task_status === "failure" || status.task_status === "skipped") {
					throw new ConverterError("bad_response", status.failure?.message ?? status.error_message ?? "Docling conversion failed", false);
				}
				if (status.task_status !== "success" && status.task_status !== "partial_success") {
					throw new ConverterError("bad_response", `Docling returned unknown task status ${String(status.task_status)}`, false);
				}

				ctx.onProgress("fetching-result", undefined, input.pageCount);
				const resultResponse = await request(`${baseUrl}/v1/result/${encodeURIComponent(task.task_id)}`, { method: "GET" });
				const result = await jsonBody<ConversionResponse>(resultResponse);
				if (result.status === "failure" || result.status === "skipped") throw new ConverterError("bad_response", "Docling conversion failed", false);
				const markdown = result.document?.md_content;
				if (typeof markdown !== "string") throw new ConverterError("bad_response", "Docling result has no Markdown content", false);
				const chunks = markdown.split(delimiter);
				if (chunks.length !== input.pageCount) {
					throw new ConverterError("bad_response", `Docling returned ${chunks.length} pages; expected ${input.pageCount}`, false);
				}
				const failed = new Map<number, string>();
				const warnings: string[] = [];
				for (const error of result.errors ?? []) {
					if (typeof error.page_no === "number" && error.page_no >= 1 && error.page_no <= input.pageCount) failed.set(error.page_no, error.error_message);
					else warnings.push(error.error_message);
				}
				ctx.onProgress("complete", input.pageCount, input.pageCount);
				return {
					converterVersion: DOCLING_CONVERTER_VERSION,
					pages: chunks.map((chunk, index) => {
						const page = index + 1;
						const reason = failed.get(page);
						if (reason) return { page, status: "unreadable" as const, reason };
						return chunk.trim()
							? { page, status: "ok" as const, markdown: chunk.replace(/\r\n?/g, "\n").trim() }
							: { page, status: "empty" as const, reason: "Docling returned no text for this page" };
					}),
					...(warnings.length ? { warnings } : {}),
				};
			} catch (error) {
				if (error instanceof ConverterError) throw error;
				if (ctx.signal.aborted) throw new ConverterError("aborted", "PDF conversion was aborted", false, { cause: error });
				if (deadlineElapsed) throw new ConverterError("timeout", "Docling conversion exceeded its job deadline", true, { cause: error });
				throw new ConverterError("unreachable", "Docling conversion failed while contacting the service", true, { cause: error });
			} finally {
				clearTimeout(deadline);
				ctx.signal.removeEventListener("abort", parentAbort);
			}
		},
	};
}
