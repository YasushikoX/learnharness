import type { ConverterErrorKind } from "./pdf-converter.ts";

/**
 * What Settings → PDF conversion exchanges with app/api/converters/ (fork addition, 2026-11-25). Pure, browser-safe.
 * No type here carries a key.
 */

export interface CredentialStatus {
	/** A key is stored for this converter AND bound to its current base URL. */
	stored: boolean;
	/** The last four characters of a stored key of 20 or more characters; else absent. */
	hint?: string;
	/** A key is stored, but for another URL (it is not sent until it is entered again). */
	boundElsewhere?: boolean;
}

export type ConverterKind = "builtin" | "docling" | "preset" | "custom";

export interface ConverterEntry {
	id: string;
	kind: ConverterKind;
	name: string;
	description?: string;
	/** Converts on this computer; nothing is uploaded. */
	local: boolean;
	/** A preset written from documentation without a real call. */
	unverified?: boolean;
	docsUrl?: string;
	/** The profile's default base URL (presets). */
	defaultBaseUrl?: string;
	/** The base URL saved in the settings (absent: the default, or none). */
	baseUrl?: string;
	/** Where PDFs are sent with the current settings; absent when no URL is set. */
	origin?: string;
	key: "required" | "optional" | "none";
	credential: CredentialStatus;
	/** Docling's options. */
	options?: { ocr: boolean; formulaEnrichment: boolean };
	limits?: { maxBytes?: number; maxPages?: number };
}

export interface ConvertersOverview {
	selected: string;
	converters: ConverterEntry[];
	/** Files in the profiles folder that failed validation (never used). */
	invalidProfiles: { file: string; errors: string[] }[];
}

export type ValidationCheckId = "converted" | "markers" | "page_1" | "page_2" | "own_pages" | "no_secret";

export interface ValidationCheck {
	id: ValidationCheckId;
	status: "pass" | "fail" | "skipped";
	message: string;
}

export interface ConverterValidationReport {
	ok: boolean;
	converterId: string;
	checks: ValidationCheck[];
	/** The start of each page's text as the normaliser placed it (empty when it rejected the answer). */
	pages: { page: number; text: string }[];
	converterVersion?: string;
	warnings: string[];
	error?: { kind: ConverterErrorKind | "internal"; message: string; retryable: boolean };
	durationMs: number;
}

/** The plain sentence about where PDFs go, for a converter entry. */
export function destinationLine(entry: ConverterEntry): string {
	if (entry.local) return "PDFs stay on this computer: the built-in reader converts them here.";
	if (!entry.origin) return "Set the service URL first. Until then PDFs are read by the built-in reader on this computer.";
	return `PDFs you upload are sent to ${entry.origin}.`;
}
