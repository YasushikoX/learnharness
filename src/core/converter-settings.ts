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
	/** A bundled preset's own address, offered until a URL is saved (saved as the service URL when it is chosen). */
	defaultBaseUrl?: string;
	/** The service URL saved in the settings (absent: none saved yet). */
	baseUrl?: string;
	/** Where PDFs go when this converter is used: the saved URL's origin (a preset: else its own address's). */
	origin?: string;
	/**
	 * Choosing it now would make it send PDFs: a saved URL (a preset's own address counts, it is saved when chosen),
	 * a stored key when it needs one, and not this app's own address. The built-in reader is always ready.
	 */
	ready: boolean;
	/** Why it is not ready, as a plain instruction ("Save its API key first."). */
	setup?: string;
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

export type ValidationCheckId = "converted" | "markers" | "page_1" | "page_2" | "own_pages" | "blank_page" | "no_secret";

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

/** The plain sentence about where PDFs go, for a converter entry; `active` when it is the one used for new PDFs. */
export function destinationLine(entry: ConverterEntry, active = true): string {
	if (entry.local) return active ? "PDFs stay on this computer: the built-in reader converts them here." : "If you use it, PDFs stay on this computer: the built-in reader converts them here.";
	if (!entry.origin) return "Save the service URL first. Nothing is sent until then.";
	if (active && !entry.ready) return `Not set up yet, so nothing is sent to ${entry.origin}: the built-in reader converts PDFs on this computer.${entry.setup ? ` ${entry.setup}` : ""}`;
	return active ? `PDFs you upload are sent to ${entry.origin}.` : `If you use it, PDFs you upload will be sent to ${entry.origin}.`;
}
