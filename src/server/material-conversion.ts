import { createHash } from "node:crypto";
import fs from "node:fs";
import { MATERIAL_MAX_BYTES, type LessonMaterial } from "../core/materials.ts";
import {
	ConverterError,
	PDF_MAX_PAGES,
	type ConverterOptions,
	type ConvertInput,
	type MaterialConversionError,
	type MaterialConversionProgress,
} from "../core/pdf-converter.ts";
import type { PdfConversionSettings } from "../core/settings.ts";
import type { MaterialStore } from "../core/ports.ts";
import { openPdfBytes } from "../agent/subagents/pdf-ops.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";
import { readDoclingCredential } from "./converters/auth.ts";
import { normaliseConversion, type FailedPage } from "./converters/normalise.ts";
import { convertWithFallback, resolvePdfConverter, type RegistryConversion } from "./converters/registry.ts";

/**
 * Converting an uploaded PDF once into `content.md` (fork addition,
 * 2026-11-24). Runs inside the material's background read, before the
 * profiler, and NEVER fails the material: a failure is recorded as the
 * material's conversionError, the profiler still reads the original PDF and
 * the lookup tools use pdfjs on it (agent/tools/material-content.ts).
 *
 * Beside the material (store.auxPath):
 *   content.md                  the page-marked text (core/material-split.ts contract); absent after a failure
 *   conversion.json             PdfConversionSidecar: the outcome, success or failure, and its key
 *   conversion-submitted.json   exists while a remote converter may hold the PDF; a run that finds it
 *                               (the app stopped mid-conversion) records "interrupted" and uploads nothing
 *
 * SKIP-IF-UNCHANGED. A run is skipped when conversion.json has the same
 * source hash, converter id and options, and either records a failure or a
 * fallback (no surprise re-upload; retry with force), or a success whose
 * converter version equals the current one (a remote service's from its
 * /version; a version that cannot be read does not invalidate it).
 */

export const PDF_CONTENT_FILE = "content.md";
export const PDF_CONVERSION_SIDECAR = "conversion.json";
export const PDF_CONVERSION_SUBMITTED = "conversion-submitted.json";

export interface PdfConversionKey {
	converterId: string;
	/** The converter version at conversion time (a remote service's own version; "unknown" when it could not be read). */
	converterVersion: string;
	options: ConverterOptions;
}

export interface PdfConversionSidecar {
	version: 2;
	sourceHash: string;
	/** What the settings selected: the skip-if-unchanged key. */
	requested: PdfConversionKey;
	/** What produced content.md (pdfjs after a fallback); absent when the conversion failed. */
	converterId?: string;
	converterVersion?: string;
	failedPages: FailedPage[];
	/** Shown on the material (conversionWarnings). */
	warnings: string[];
	/** Present when the conversion failed (no content.md). */
	error?: MaterialConversionError;
	convertedAt: string;
}

export interface MaterialConversionOutcome {
	status: "converted" | "unchanged" | "failed" | "interrupted";
	sidecar?: PdfConversionSidecar;
	error?: MaterialConversionError;
	warnings: string[];
}

export interface ConvertMaterialOptions {
	signal: AbortSignal;
	store: MaterialStore;
	/** The pdfConversion settings section, read once by the caller. */
	settings: PdfConversionSettings | undefined;
	/** A retry the user asked for: ignores the skip key and an interrupted marker. */
	force?: boolean;
	onProgress?: (progress: MaterialConversionProgress | undefined) => void;
}

export async function probePdfInput(bytes: Uint8Array, filename: string, signal: AbortSignal): Promise<ConvertInput> {
	if (bytes.byteLength > MATERIAL_MAX_BYTES) throw new ConverterError("too_large", "PDF exceeds the material size limit", false);
	let opened: Awaited<ReturnType<typeof openPdfBytes>> | undefined;
	try {
		opened = await openPdfBytes(bytes.slice(), signal);
		const pageCount = opened.doc.numPages;
		if (pageCount > PDF_MAX_PAGES) throw new ConverterError("too_many_pages", `PDF has ${pageCount} pages; the limit is ${PDF_MAX_PAGES}`, false);
		return { bytes, filename, pageCount };
	} catch (error) {
		if (error instanceof ConverterError) throw error;
		if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw new ConverterError("aborted", "PDF conversion was aborted", false, { cause: error });
		throw new ConverterError("bad_response", "Could not open the PDF", false, { cause: error });
	} finally {
		await opened?.task.destroy();
	}
}

export function readSidecar(file: string): PdfConversionSidecar | undefined {
	try {
		const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PdfConversionSidecar> | null;
		if (!value || value.version !== 2 || typeof value.sourceHash !== "string" || !value.requested || typeof value.requested.converterId !== "string") return undefined;
		return value as PdfConversionSidecar;
	} catch {
		return undefined; // missing or invalid: rebuilt from the original
	}
}

function sameOptions(a: ConverterOptions | undefined, b: ConverterOptions): boolean {
	const left = Object.entries(a ?? {}).sort(([x], [y]) => x.localeCompare(y));
	const right = Object.entries(b).sort(([x], [y]) => x.localeCompare(y));
	return JSON.stringify(left) === JSON.stringify(right);
}

function pageList(pages: number[]): string {
	const shown = pages.slice(0, 10).join(", ");
	return pages.length > 10 ? `${shown} and ${pages.length - 10} more` : shown;
}

const SCANNED = "No page of this PDF has extractable text, so it looks scanned. A converter with OCR (such as Docling) would read it; until then the tutor reads it from the page images.";

function materialError(
	error: unknown,
	ranWith: string | undefined,
	fallbackFrom?: RegistryConversion["fallbackFrom"],
): MaterialConversionError {
	if (error instanceof ConverterError) {
		if (error.kind === "no_text" && ranWith === "pdfjs") {
			if (fallbackFrom) {
				const name = fallbackFrom.converterId === "docling" ? "Docling" : fallbackFrom.converterId;
				return {
					kind: "no_text",
					message: `${name} could not be reached (${fallbackFrom.reason}), and the built-in reader (pdfjs) found no extractable text, so this PDF looks scanned. Retry the conversion once ${name} is reachable to read it with OCR.`,
					retryable: true,
				};
			}
			return { kind: "no_text", message: SCANNED, retryable: false };
		}
		return { kind: error.kind, message: error.message, retryable: error.retryable };
	}
	return { kind: "internal", message: `PDF conversion failed: ${error instanceof Error ? error.message : String(error)}`, retryable: true };
}

/**
 * Convert one PDF material (or skip it, see the module comment). Resolves with the outcome; rejects only when
 * `signal` aborted (the material was removed).
 */
export async function convertMaterialPdf(ownerId: string, material: LessonMaterial, opts: ConvertMaterialOptions): Promise<MaterialConversionOutcome> {
	const { signal, store } = opts;
	const contentPath = store.auxPath(ownerId, material.id, PDF_CONTENT_FILE);
	const sidecarPath = store.auxPath(ownerId, material.id, PDF_CONVERSION_SIDECAR);
	const submittedPath = store.auxPath(ownerId, material.id, PDF_CONVERSION_SUBMITTED);
	const bytes = new Uint8Array(await fs.promises.readFile(store.filePath(ownerId, material)));
	signal.throwIfAborted();
	const sourceHash = createHash("sha256").update(bytes).digest("hex");

	if (!opts.force && fs.existsSync(submittedPath)) {
		const error: MaterialConversionError = {
			kind: "interrupted",
			message: "The PDF conversion was interrupted (the app stopped while it ran) and was not started again, so the PDF is not uploaded twice. Retry the conversion to finish it.",
			retryable: true,
		};
		return { status: "interrupted", error, warnings: [] };
	}

	const resolved = resolvePdfConverter(opts.settings, (id, baseUrl) => (id === "docling" ? readDoclingCredential(baseUrl) : undefined));
	const converter = resolved.converter;
	const options = converter.options ?? {};
	const existing = opts.force ? undefined : readSidecar(sidecarPath);
	if (existing && existing.sourceHash === sourceHash && existing.requested.converterId === resolved.requestedId && sameOptions(existing.requested.options, options)) {
		const done = existing.error !== undefined || fs.existsSync(contentPath);
		const fellBack = existing.error !== undefined || existing.converterId !== resolved.requestedId;
		let unchanged = done && fellBack;
		if (done && !fellBack) {
			if (converter.local || !converter.serverVersion) unchanged = existing.requested.converterVersion === converter.version;
			else {
				try {
					unchanged = existing.requested.converterVersion === (await converter.serverVersion(signal));
				} catch (error) {
					signal.throwIfAborted();
					unchanged = error instanceof ConverterError; // the service cannot be asked: keep what it produced
				}
			}
		}
		if (unchanged) return { status: "unchanged", sidecar: existing, ...(existing.error ? { error: existing.error } : {}), warnings: existing.warnings };
	}

	const progress = (stage: string, donePages?: number, totalPages?: number) =>
		opts.onProgress?.({ stage, ...(donePages !== undefined ? { donePages } : {}), ...(totalPages !== undefined ? { totalPages } : {}) });
	let result: RegistryConversion | undefined;
	try {
		progress("opening");
		const input = await probePdfInput(bytes, material.name, signal);
		// Recorded before anything is uploaded: a run that finds it does not upload again.
		if (!converter.local) writeFileAtomicSync(submittedPath, `${JSON.stringify({ converterId: converter.id, sourceHash, submittedAt: new Date().toISOString() })}\n`);
		result = await convertWithFallback(resolved, input, { signal, onProgress: progress });
		const normalised = normaliseConversion(result, input.pageCount);
		const warnings = [...(result.warnings ?? [])];
		const blank = normalised.failedPages.filter((p) => p.status === "empty").map((p) => p.page);
		if (blank.length > 0 && result.converterId === "pdfjs") {
			warnings.push(`${blank.length === 1 ? "Page" : "Pages"} ${pageList(blank)} ${blank.length === 1 ? "has" : "have"} no extractable text and may be scanned; a converter with OCR (such as Docling) would read ${blank.length === 1 ? "it" : "them"}.`);
		}
		const sidecar: PdfConversionSidecar = {
			version: 2,
			sourceHash,
			requested: { converterId: resolved.requestedId, converterVersion: result.converterId === resolved.requestedId ? result.converterVersion : "unknown", options },
			converterId: result.converterId,
			converterVersion: result.converterVersion,
			failedPages: normalised.failedPages,
			warnings,
			convertedAt: new Date().toISOString(),
		};
		signal.throwIfAborted();
		writeFileAtomicSync(contentPath, normalised.content);
		writeFileAtomicSync(sidecarPath, `${JSON.stringify(sidecar, null, "\t")}\n`);
		fs.rmSync(submittedPath, { force: true });
		return { status: "converted", sidecar, warnings };
	} catch (error) {
		if (signal.aborted) {
			fs.rmSync(submittedPath, { force: true });
			throw error;
		}
		const failure = materialError(error, result?.converterId ?? (converter.local ? converter.id : undefined), result?.fallbackFrom);
		const warnings = result?.warnings ?? resolved.warnings;
		const sidecar: PdfConversionSidecar = {
			version: 2,
			sourceHash,
			requested: { converterId: resolved.requestedId, converterVersion: "unknown", options },
			failedPages: [],
			warnings,
			error: failure,
			convertedAt: new Date().toISOString(),
		};
		fs.rmSync(contentPath, { force: true });
		writeFileAtomicSync(sidecarPath, `${JSON.stringify(sidecar, null, "\t")}\n`);
		fs.rmSync(submittedPath, { force: true });
		return { status: "failed", sidecar, error: failure, warnings };
	} finally {
		opts.onProgress?.(undefined);
	}
}

/**
 * The upload hook's step (server/materials.ts): convert, then record the outcome on the material
 * (conversionError, conversionWarnings). Never rejects; an abort records nothing.
 */
export async function convertPdfMaterial(
	ownerId: string,
	material: LessonMaterial,
	signal: AbortSignal,
	store: MaterialStore,
	settings: PdfConversionSettings | undefined,
	options: { force?: boolean; onProgress?: ConvertMaterialOptions["onProgress"] } = {},
): Promise<MaterialConversionOutcome | undefined> {
	let outcome: MaterialConversionOutcome;
	try {
		outcome = await convertMaterialPdf(ownerId, material, { signal, store, settings, ...options });
	} catch (error) {
		if (signal.aborted) return undefined;
		outcome = { status: "failed", error: materialError(error, undefined), warnings: [] };
	}
	if (signal.aborted) return undefined;
	store.update(ownerId, material.id, {
		conversionError: outcome.error,
		conversionWarnings: outcome.warnings.length > 0 ? outcome.warnings : undefined,
	});
	return outcome;
}
