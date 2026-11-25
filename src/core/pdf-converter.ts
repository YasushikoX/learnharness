/**
 * PDF conversion contracts (fork addition, 2026-11-24). Pure, browser-safe.
 *
 * An uploaded PDF is converted ONCE into a page-marked `content.md` beside the
 * material (src/server/material-conversion.ts writes it; the page-marker
 * contract is src/core/material-split.ts). Converters implement PdfConverter;
 * the registry (src/server/converters/registry.ts) picks the configured one.
 */

/** The page ceiling for any PDF the app converts (uploads and the notes import). */
export const PDF_MAX_PAGES = 1000;
/** auth.json entry holding the Docling key; never copied into process.env or listed as a generic key. */
export const DOCLING_API_KEY = "DOCLING_API_KEY";
/** auth.json entry holding the canonical base URL the Docling key is bound to. */
export const DOCLING_AUTH_BINDING = "__learnharness_docling_base_url";
/** auth.json entry holding every profile converter's key, each bound to its base URL (a JSON string); kept out of process.env like Docling's. */
export const CONVERTER_CREDENTIALS = "__learnharness_converter_credentials";

export type ConverterErrorKind =
	/** The service could not be reached (connection refused, DNS, 5xx). Falls back to pdfjs. */
	| "unreachable"
	| "auth"
	| "rate_limit"
	| "too_large"
	| "too_many_pages"
	/** A request or the job deadline elapsed. Falls back to pdfjs. */
	| "timeout"
	/** The service answered with something the client cannot use (or a redirect). */
	| "bad_response"
	/** The service ran the job and reported that it failed (its own message and retryable flag). */
	| "conversion_failed"
	/** The converter found no text on any page. */
	| "no_text"
	/** The selected converter lacks required configuration (internal: the registry falls back with a warning). */
	| "not_configured"
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
	/** The page count the host read locally (pdfjs); every converter must answer for exactly these pages. */
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
	/** The version of what produced the text: the service's own version for a remote converter. */
	converterVersion: string;
	warnings?: string[];
}

/** Option values that change a converter's output; part of the skip-if-unchanged key. */
export type ConverterOptions = Readonly<Record<string, string | number | boolean>>;

export interface PdfConverter {
	id: string;
	/** The name messages use (a profile's display name); the id when absent. */
	label?: string;
	/** The client implementation's version (the converter version itself for a local converter). */
	version: string;
	/** Runs in-process and uploads nothing (an interrupted run may simply run again). */
	local?: boolean;
	/** The options that shape its output (skip-if-unchanged key). */
	options?: ConverterOptions;
	maxBytes?: number;
	maxPages?: number;
	/** A remote converter's current service version, asked without uploading anything. */
	serverVersion?(signal: AbortSignal): Promise<string>;
	convert(input: ConvertInput, ctx: ConvertContext): Promise<ConvertResult>;
}

/** What a material records when its conversion failed; the material stays usable through pdfjs. */
export type MaterialConversionErrorKind = ConverterErrorKind | "interrupted" | "internal";

export interface MaterialConversionError {
	kind: MaterialConversionErrorKind;
	/** Shown to the user. */
	message: string;
	retryable: boolean;
}

/** A running conversion's progress (derived on read from the live run, never stored). */
export interface MaterialConversionProgress {
	stage: string;
	donePages?: number;
	totalPages?: number;
}
