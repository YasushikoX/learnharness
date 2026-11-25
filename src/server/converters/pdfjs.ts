import { MATERIAL_MAX_BYTES } from "../../core/materials.ts";
import { ConverterError, PDF_MAX_PAGES, type PdfConverter } from "../../core/pdf-converter.ts";
import { convertPdf } from "../../agent/subagents/pdf-ops.ts";

export const PDFJS_CONVERTER_VERSION = "1";
const EMPTY_REASON = "No extractable text; this page looks like a scan and needs an OCR converter.";

export function createPdfjsConverter(): PdfConverter {
	return {
		id: "pdfjs",
		version: PDFJS_CONVERTER_VERSION,
		maxBytes: MATERIAL_MAX_BYTES,
		maxPages: PDF_MAX_PAGES,
		async convert(input, ctx) {
			if (input.bytes.byteLength > MATERIAL_MAX_BYTES) throw new ConverterError("too_large", "PDF exceeds the material size limit", false);
			if (input.pageCount > PDF_MAX_PAGES) throw new ConverterError("too_many_pages", `PDF exceeds ${PDF_MAX_PAGES} pages`, false);
			ctx.onProgress("extracting", 0, input.pageCount);
			let converted: Awaited<ReturnType<typeof convertPdf>>;
			try {
				converted = await convertPdf(input.bytes.slice(), PDF_MAX_PAGES, { signal: ctx.signal });
			} catch (error) {
				if (ctx.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
					throw new ConverterError("aborted", "PDF conversion was aborted", false, { cause: error });
				}
				throw error;
			}
			if (converted.kind === "too-long") throw new ConverterError("too_many_pages", `PDF exceeds ${PDF_MAX_PAGES} pages`, false);
			if (converted.kind === "unreadable") throw new ConverterError("bad_response", "pdfjs could not read the PDF", false);
			ctx.onProgress("extracting", input.pageCount, input.pageCount);
			return {
				converterVersion: PDFJS_CONVERTER_VERSION,
				pages: converted.pages.map((page) => page.kind === "text"
					? { page: page.number, status: "ok" as const, markdown: page.markdown }
					: { page: page.number, status: "empty" as const, reason: EMPTY_REASON }),
			};
		},
	};
}

export const pdfjsConverter = createPdfjsConverter();
