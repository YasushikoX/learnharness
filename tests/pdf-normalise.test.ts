import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normaliseConversion } from "../src/server/converters/normalise.ts";
import { ConverterError, type ConvertResult, type PageResult } from "../src/core/pdf-converter.ts";
import { contentPages, escapePageMarkerLines, formatPageMarker, PAGE_MARKER_PATTERN, splitMaterial, unescapePageMarkerLines } from "../src/core/material-split.ts";

/** The page the indexer assigns each non-marker line to (a budget of one text line per batch). */
function indexerPages(content: string): Map<string, number> {
	const pages = new Map<string, number>();
	const textLines = (text: string) => text.split("\n").filter((line) => line.trim() && !PAGE_MARKER_PATTERN.test(line)).length;
	for (const batch of splitMaterial(content, { budgetTokens: 1, estimateTokens: textLines })) {
		for (const line of batch.text.split("\n")) if (line.trim() && !PAGE_MARKER_PATTERN.test(line)) pages.set(line, batch.pageStart);
	}
	return pages;
}

const result = (pages: PageResult[]): ConvertResult => ({ converterVersion: "test", pages });

function kindOf(fn: () => unknown): string | undefined {
	try {
		fn();
	} catch (error) {
		return error instanceof ConverterError ? error.kind : "other";
	}
	return undefined;
}

describe("normaliseConversion", () => {
	it("writes one marker per page in order and lists pages without text", () => {
		const normalised = normaliseConversion(result([
			{ page: 2, status: "empty", reason: "scan" },
			{ page: 1, status: "ok", markdown: "First\r\nline" },
			{ page: 3, status: "unreadable", reason: "broken" },
		]), 3);
		assert.equal(normalised.content, "--- Page 1 ---\nFirst\nline\n--- Page 2 ---\n\n--- Page 3 ---\n");
		assert.deepEqual(normalised.failedPages.map((p) => [p.page, p.status]), [[2, "empty"], [3, "unreadable"]]);
	});

	it("rejects out-of-range, duplicate, missing and malformed pages as bad_response", () => {
		assert.equal(kindOf(() => normaliseConversion(result([{ page: 2, status: "ok", markdown: "x" }]), 1)), "bad_response");
		assert.equal(kindOf(() => normaliseConversion(result([{ page: 1, status: "ok", markdown: "x" }, { page: 1, status: "ok", markdown: "y" }]), 1)), "bad_response");
		assert.equal(kindOf(() => normaliseConversion(result([{ page: 1, status: "ok", markdown: "x" }]), 2)), "bad_response");
		assert.equal(kindOf(() => normaliseConversion(result([{ page: 1, status: "weird" } as unknown as PageResult]), 1)), "bad_response");
	});

	it("an ok page whose Markdown is not a string is bad_response, not a TypeError", () => {
		const page = { page: 1, status: "ok", markdown: 42 } as unknown as PageResult;
		assert.equal(kindOf(() => normaliseConversion(result([page]), 1)), "bad_response");
		assert.equal(kindOf(() => normaliseConversion(result([{ page: 1, status: "ok" } as unknown as PageResult]), 1)), "bad_response");
	});

	it("a whitespace-only ok page counts as empty", () => {
		const normalised = normaliseConversion(result([{ page: 1, status: "ok", markdown: "Text" }, { page: 2, status: "ok", markdown: " \n\t" }]), 2);
		assert.deepEqual(normalised.failedPages.map((p) => [p.page, p.status]), [[2, "empty"]]);
		assert.equal(normalised.content, "--- Page 1 ---\nText\n--- Page 2 ---\n");
	});

	it("no text on any page is no_text", () => {
		assert.equal(kindOf(() => normaliseConversion(result([{ page: 1, status: "empty" }, { page: 2, status: "ok", markdown: "  " }]), 2)), "no_text");
	});

	it("F4: page text that looks like a marker (trailing space or tab, page 0, leading zeros, escaped) cannot move text to another page", () => {
		const tricky = ["--- Page 2 --- ", "--- Page 2 ---\t", "--- Page 0 ---", "--- Page 02 ---", "\\--- Page 0 ---", "\\\\--- Page 3 ---"];
		const page1 = ["intro", ...tricky, "still page one"].join("\n");
		const { content } = normaliseConversion(result([{ page: 1, status: "ok", markdown: page1 }, { page: 2, status: "ok", markdown: "real page two" }]), 2);
		assert.deepEqual(content.split("\n").filter((line) => PAGE_MARKER_PATTERN.test(line)), ["--- Page 1 ---", "--- Page 2 ---"]);
		const pages = indexerPages(content);
		assert.equal(pages.get("still page one"), 1);
		assert.equal(pages.get("real page two"), 2);
		assert.equal(contentPages(content)[0]!.text, page1, "the reader gets the page's own text back, \\--- Page 0 --- included");
	});

	it("F4: a marker-like line with a \\r ending cannot become a boundary", () => {
		const escaped = escapePageMarkerLines("a\r\n--- Page 7 ---\r\nb");
		assert.equal(escaped.split("\n").some((line) => PAGE_MARKER_PATTERN.test(line)), false);
		const { content } = normaliseConversion(result([{ page: 1, status: "ok", markdown: "a\r\n--- Page 7 ---\r\nb" }]), 1);
		assert.deepEqual(content.split("\n").filter((line) => PAGE_MARKER_PATTERN.test(line)), ["--- Page 1 ---"]);
	});
});

describe("the page-marker contract (one module: core/material-split.ts)", () => {
	it("formatPageMarker refuses page 0", () => {
		assert.throws(() => formatPageMarker(0), RangeError);
		assert.equal(formatPageMarker(3), "--- Page 3 ---");
	});

	it("escape then unescape is the identity, already-escaped lines included", () => {
		const text = "--- Page 3 ---\n\\--- Page 3 ---\n\\\\--- Page 0 --- \nplain";
		assert.equal(unescapePageMarkerLines(escapePageMarkerLines(text)), text);
		assert.equal(escapePageMarkerLines(text).split("\n").some((line) => PAGE_MARKER_PATTERN.test(line)), false);
	});

	// The review's difference table, row by row, for the reader that parses content.md back into pages.
	it("F7: text before the first marker belongs to the first page, as for the indexer", () => {
		assert.deepEqual(contentPages("preface\n--- Page 1 ---\nbody\n--- Page 2 ---\nnext"), [
			{ page: 1, text: "preface\nbody" },
			{ page: 2, text: "next" },
		]);
		assert.equal(indexerPages("preface\n--- Page 1 ---\nbody").get("preface"), 1);
	});

	it("a file with no markers is all page 1", () => {
		assert.deepEqual(contentPages("just notes\n\\--- Page 4 ---"), [{ page: 1, text: "just notes\n--- Page 4 ---" }]);
		assert.deepEqual(contentPages(""), [{ page: 1, text: "" }]);
	});

	it("F7: a page keeps its leading blank lines, and the normaliser's output reads back exactly", () => {
		const { content } = normaliseConversion(result([
			{ page: 1, status: "ok", markdown: "\n\nA" },
			{ page: 2, status: "empty" },
			{ page: 3, status: "ok", markdown: "C\n--- Page 9 ---\n" },
		]), 3);
		assert.deepEqual(contentPages(content), [
			{ page: 1, text: "\n\nA" },
			{ page: 2, text: "" },
			{ page: 3, text: "C\n--- Page 9 ---\n" },
		]);
	});

	it("a marker with trailing spaces or \\r is a boundary, as for the indexer", () => {
		assert.deepEqual(contentPages("--- Page 1 --- \r\none\r\n--- Page 2 ---\r\ntwo").map((p) => p.page), [1, 2]);
	});
});
