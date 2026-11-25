import { ConverterError, type ConvertResult, type PageResult } from "../../core/pdf-converter.ts";
import { escapePageMarkerLines, formatPageMarker } from "../../core/material-pages.ts";

export type FailedPage = Extract<PageResult, { status: "empty" | "unreadable" }>;

export interface NormalisedConversion {
	content: string;
	failedPages: FailedPage[];
}

function badResponse(message: string): never {
	throw new ConverterError("bad_response", message, false);
}

export function normaliseConversion(result: ConvertResult, expectedPageCount: number): NormalisedConversion {
	if (!Number.isInteger(expectedPageCount) || expectedPageCount < 1) badResponse(`Invalid expected PDF page count: ${expectedPageCount}`);
	const byPage = new Map<number, PageResult>();
	for (const page of result.pages) {
		if (!Number.isInteger(page.page) || page.page < 1 || page.page > expectedPageCount) {
			badResponse(`Converter returned out-of-range page ${page.page}; expected 1–${expectedPageCount}`);
		}
		if (byPage.has(page.page)) badResponse(`Converter returned duplicate page ${page.page}`);
		byPage.set(page.page, page);
	}
	for (let page = 1; page <= expectedPageCount; page++) {
		if (!byPage.has(page)) badResponse(`Converter omitted page ${page}`);
	}
	const ordered = Array.from({ length: expectedPageCount }, (_, index) => byPage.get(index + 1)!);
	if (!ordered.some((page) => page.status === "ok" && page.markdown.trim())) {
		badResponse("Converter returned no readable text on any page");
	}
	const failedPages = ordered.filter((page): page is FailedPage => page.status !== "ok");
	const content = ordered
		.map((page) => {
			const markdown = page.status === "ok" ? page.markdown.replace(/\r\n?/g, "\n") : "";
			return `${formatPageMarker(page.page)}\n${escapePageMarkerLines(markdown)}`;
		})
		.join("\n");
	return { content, failedPages };
}
