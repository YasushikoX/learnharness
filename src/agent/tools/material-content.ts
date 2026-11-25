import * as fs from "node:fs/promises";
import { contentPages, escapePageMarkerLines, formatPageMarker, PAGE_MARKER_PATTERN, type ContentPage } from "../../core/material-split.ts";
import { parsePageSpec } from "../subagents/pdf-ops.ts";

/**
 * A converted PDF's `content.md` for the material lookup tools (fork addition,
 * 2026-11-24). Only those tools read it, by its explicit path; the shared pdfjs
 * helpers (pdf-ops.ts pdfExtract / pdfSearch) and the profiler never do.
 * `content.md` follows the page-marker contract in core/material-split.ts.
 */

/**
 * The pages of a PDF material's `content.md`, or null when the tools should use pdfjs on the original instead: the file
 * is missing or unreadable, empty, or has no page marker (the host always writes one per page, so a marker-less file
 * is not a conversion).
 */
export async function readConvertedPages(contentPath: string): Promise<ContentPage[] | null> {
	let text: string;
	try {
		text = await fs.readFile(contentPath, "utf8");
	} catch {
		return null;
	}
	if (!text.trim() || !text.split("\n").some((line) => PAGE_MARKER_PATTERN.test(line))) return null;
	return contentPages(text);
}

/** One page's text, duplicates of a page number joined in document order. */
function byPage(pages: readonly ContentPage[]): Map<number, string> {
	const map = new Map<number, string>();
	for (const page of pages) map.set(page.page, map.has(page.page) ? `${map.get(page.page)}\n${page.text}` : page.text);
	return map;
}

/** material_read for a converted PDF: the pages a spec selects, in pdf_extract's `--- Page N ---` format. */
export function extractConvertedPages(pages: readonly ContentPage[], pageSpec: string): string {
	const texts = byPage(pages);
	const total = Math.max(1, ...texts.keys());
	const selected = parsePageSpec(pageSpec, total);
	if (selected.length === 0) return "No pages selected — page spec matched nothing.";
	return selected.map((page) => `${formatPageMarker(page)}\n${escapePageMarkerLines(texts.get(page) ?? "")}`).join("\n");
}

/** material_search for a converted PDF: hits with page, 1-based line within the page and context (pdf_search's shape). */
export function searchConvertedPages(
	pages: readonly ContentPage[],
	pattern: RegExp,
	contextLines: number,
): { page: number; line: number; context: string }[] {
	const hits: { page: number; line: number; context: string }[] = [];
	for (const [page, text] of byPage(pages)) {
		const lines = text.split("\n");
		for (let ln = 0; ln < lines.length; ln++) {
			if (!pattern.test(lines[ln]!)) continue;
			const start = Math.max(0, ln - contextLines);
			const end = Math.min(lines.length, ln + contextLines + 1);
			const context = lines
				.slice(start, end)
				.map((l, j) => `${start + j === ln ? ">>>" : "   "} ${l}`)
				.join("\n");
			hits.push({ page, line: ln + 1, context });
		}
	}
	return hits;
}
