import { createHash } from "node:crypto";
import fs from "node:fs";
import { MATERIAL_MAX_BYTES, type LessonMaterial } from "../core/materials.ts";
import { ConverterError, PDF_MAX_PAGES, type ConvertContext, type ConvertInput } from "../core/pdf-converter.ts";
import type { MaterialStore } from "../core/ports.ts";
import { openPdfBytes } from "../agent/subagents/pdf-ops.ts";
import { materialStore } from "../store/materials.ts";
import { normaliseConversion, type FailedPage } from "./converters/normalise.ts";
import { configuredPdfConverter, convertConfiguredPdf, type RegistryConversion } from "./converters/registry.ts";

export const PDF_CONVERSION_SIDECAR = "conversion.json";

export interface PdfConversionSidecar {
	version: 1;
	converterId: string;
	converterVersion: string;
	sourceHash: string;
	failedPages: FailedPage[];
	warnings: string[];
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

function sidecarMatches(value: unknown, sourceHash: string, converter: { id: string; version: string }): value is PdfConversionSidecar {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const sidecar = value as Partial<PdfConversionSidecar>;
	return sidecar.version === 1 && sidecar.sourceHash === sourceHash && sidecar.converterId === converter.id && sidecar.converterVersion === converter.version;
}

export async function ensureMaterialContent(
	ownerId: string,
	material: LessonMaterial,
	signal: AbortSignal,
	convert: (input: ConvertInput, ctx: ConvertContext) => Promise<RegistryConversion> = convertConfiguredPdf,
	store: MaterialStore = materialStore,
): Promise<PdfConversionSidecar> {
	const sourcePath = store.filePath(ownerId, material);
	const bytes = new Uint8Array(fs.readFileSync(sourcePath));
	const sourceHash = createHash("sha256").update(bytes).digest("hex");
	const converter = configuredPdfConverter();
	const contentPath = store.auxPath(ownerId, material.id, "content.md");
	const sidecarPath = store.auxPath(ownerId, material.id, PDF_CONVERSION_SIDECAR);
	if (fs.existsSync(contentPath) && fs.existsSync(sidecarPath)) {
		try {
			const existing: unknown = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
			if (sidecarMatches(existing, sourceHash, converter)) return existing;
		} catch {
			// A missing or invalid derived record is rebuilt from the original.
		}
	}
	const input = await probePdfInput(bytes, material.name, signal);
	const result = await convert(input, {
		signal,
		onProgress: () => {},
	});
	const normalised = normaliseConversion(result, input.pageCount);
	const sidecar: PdfConversionSidecar = {
		version: 1,
		converterId: result.converterId,
		converterVersion: result.converterVersion,
		sourceHash,
		failedPages: normalised.failedPages,
		warnings: result.warnings ?? [],
	};
	fs.writeFileSync(contentPath, normalised.content, "utf8");
	fs.writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, "\t")}\n`, "utf8");
	return sidecar;
}
