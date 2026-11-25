import { ConverterError, type ConvertContext, type ConvertInput, type ConvertResult, type PdfConverter } from "../../core/pdf-converter.ts";
import { readSettings } from "../../store/settings.ts";
import { readDoclingCredential } from "./auth.ts";
import { createDoclingConverter, type DoclingConverterOptions } from "./docling.ts";
import { pdfjsConverter } from "./pdfjs.ts";

export interface RegistryConversion extends ConvertResult {
	converterId: string;
}

export interface ConvertWithRegistryOptions {
	converterId?: string;
	docling?: Omit<DoclingConverterOptions, "apiKey"> & { apiKey?: string };
}

const converters = new Map<string, PdfConverter>([[pdfjsConverter.id, pdfjsConverter]]);

export function registerPdfConverter(converter: PdfConverter): void {
	if (converters.has(converter.id)) throw new Error(`PDF converter already registered: ${converter.id}`);
	converters.set(converter.id, converter);
}

export function getPdfConverter(id: string): PdfConverter | undefined {
	return converters.get(id);
}

function resolveConverter(options: ConvertWithRegistryOptions): PdfConverter {
	const id = options.converterId ?? "pdfjs";
	if (id === "docling") return createDoclingConverter(options.docling ?? { baseUrl: "" });
	const converter = getPdfConverter(id);
	if (!converter) throw new ConverterError("bad_response", `Unknown PDF converter: ${id}`, false);
	return converter;
}

export async function convertWithRegistry(
	input: ConvertInput,
	ctx: ConvertContext,
	options: ConvertWithRegistryOptions = {},
): Promise<RegistryConversion> {
	const selected = resolveConverter(options);
	try {
		const result = await selected.convert(input, ctx);
		return { ...result, converterId: selected.id };
	} catch (error) {
		if (selected.id === "pdfjs" || !(error instanceof ConverterError) || (error.kind !== "unreachable" && error.kind !== "timeout")) throw error;
		const result = await pdfjsConverter.convert(input, ctx);
		return {
			...result,
			converterId: pdfjsConverter.id,
			warnings: [
				`Configured converter ${selected.id} failed (${error.kind}); used pdfjs instead.`,
				...(result.warnings ?? []),
			],
		};
	}
}

export function configuredPdfConverter(): { id: string; version: string } {
	const settings = readSettings()?.pdfConversion;
	return resolveConverter({
		converterId: settings?.converter,
		docling: settings?.docling?.baseUrl
			? { ...settings.docling, baseUrl: settings.docling.baseUrl, apiKey: readDoclingCredential(settings.docling.baseUrl) }
			: undefined,
	});
}

export function convertConfiguredPdf(input: ConvertInput, ctx: ConvertContext): Promise<RegistryConversion> {
	const settings = readSettings()?.pdfConversion;
	return convertWithRegistry(input, ctx, {
		converterId: settings?.converter,
		docling: settings?.docling?.baseUrl
			? { ...settings.docling, baseUrl: settings.docling.baseUrl, apiKey: readDoclingCredential(settings.docling.baseUrl) }
			: undefined,
	});
}
