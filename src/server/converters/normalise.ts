import { ConverterError, type ConvertResult, type PageResult } from "../../core/pdf-converter.ts";
import { escapePageMarkerLines, formatPageMarker } from "../../core/material-split.ts";

/**
 * The host's normaliser (fork addition, 2026-11-24): any converter's answer
 * becomes `content.md` by THE PAGE MARKER CONTRACT (core/material-split.ts).
 * The host owns page numbering: one marker per local page 1..N, in order,
 * every page's own text passed through escapePageMarkerLines. A converter's
 * answer is checked first, as untrusted input.
 */

export type FailedPage = Extract<PageResult, { status: "empty" | "unreadable" }>;

export interface NormalisedConversion {
	content: string;
	/** Pages without text: empty (including whitespace-only "ok" pages) or unreadable, in page order. */
	failedPages: FailedPage[];
}

function badResponse(message: string): never {
	throw new ConverterError("bad_response", message, false);
}

const WHITESPACE_REASON = "The converter returned only whitespace for this page";

export function normaliseConversion(result: ConvertResult, expectedPageCount: number): NormalisedConversion {
	if (!Number.isInteger(expectedPageCount) || expectedPageCount < 1) badResponse(`Invalid expected PDF page count: ${expectedPageCount}`);
	if (!result || !Array.isArray(result.pages)) badResponse("Converter returned no page list");
	const byPage = new Map<number, PageResult>();
	for (const page of result.pages as unknown[]) {
		const p = page as Partial<PageResult> | null;
		if (!p || typeof p !== "object") badResponse("Converter returned a page that is not an object");
		if (!Number.isInteger(p.page) || p.page! < 1 || p.page! > expectedPageCount) {
			badResponse(`Converter returned out-of-range page ${String(p.page)}; expected 1–${expectedPageCount}`);
		}
		if (p.status !== "ok" && p.status !== "empty" && p.status !== "unreadable") badResponse(`Converter returned unknown status ${String(p.status)} for page ${p.page}`);
		if (p.status === "ok" && typeof (p as { markdown?: unknown }).markdown !== "string") badResponse(`Converter returned non-text Markdown for page ${p.page}`);
		if (byPage.has(p.page!)) badResponse(`Converter returned duplicate page ${p.page}`);
		byPage.set(p.page!, p as PageResult);
	}
	for (let page = 1; page <= expectedPageCount; page++) {
		if (!byPage.has(page)) badResponse(`Converter omitted page ${page}`);
	}
	const ordered = Array.from({ length: expectedPageCount }, (_, index): PageResult => {
		const page = byPage.get(index + 1)!;
		return page.status === "ok" && !page.markdown.trim() ? { page: page.page, status: "empty", reason: WHITESPACE_REASON } : page;
	});
	if (!ordered.some((page) => page.status === "ok")) {
		throw new ConverterError("no_text", "The converter found no text on any page", false);
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
