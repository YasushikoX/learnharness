export const PDF_MAX_PAGES = 1000;
export const DOCLING_API_KEY = "DOCLING_API_KEY";
export const DOCLING_AUTH_BINDING = "__learnharness_docling_base_url";

export type ConverterErrorKind =
	| "unreachable"
	| "auth"
	| "rate_limit"
	| "too_large"
	| "too_many_pages"
	| "timeout"
	| "bad_response"
	| "aborted";

export class ConverterError extends Error {
	readonly name = "ConverterError";
	constructor(
		readonly kind: ConverterErrorKind,
		message: string,
		readonly retryable: boolean,
		options?: { cause?: unknown },
	) {
		super(message, options);
	}
}

export interface ConvertInput {
	bytes: Uint8Array;
	filename: string;
	pageCount: number;
}

export interface ConvertContext {
	signal: AbortSignal;
	onProgress(stage: string, donePages?: number, totalPages?: number): void;
}

export type PageResult =
	| { page: number; status: "ok"; markdown: string }
	| { page: number; status: "empty" | "unreadable"; reason?: string };

export interface ConvertResult {
	pages: PageResult[];
	converterVersion: string;
	warnings?: string[];
}

export interface PdfConverter {
	id: string;
	version: string;
	maxBytes?: number;
	maxPages?: number;
	convert(input: ConvertInput, ctx: ConvertContext): Promise<ConvertResult>;
}
