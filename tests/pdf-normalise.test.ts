import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normaliseConversion } from "../src/server/converters/normalise.ts";
import { ConverterError, type PageResult } from "../src/core/pdf-converter.ts";
import { parsePageMarkedMarkdown } from "../src/core/material-pages.ts";

const conversion = (pages: PageResult[]) => ({ pages, converterVersion: "test" });

function badResponse(pages: PageResult[], count: number, pattern: RegExp) {
	assert.throws(() => normaliseConversion(conversion(pages), count), (error) => error instanceof ConverterError && error.kind === "bad_response" && pattern.test(error.message));
}

describe("PDF conversion normaliser", () => {
	it("writes every physical page and records empty and unreadable pages", () => {
		const out = normaliseConversion(conversion([
			{ page: 2, status: "unreadable", reason: "OCR failed" },
			{ page: 1, status: "ok", markdown: "Text" },
			{ page: 3, status: "empty", reason: "Blank" },
		]), 3);
		assert.equal(out.content, "--- Page 1 ---\nText\n--- Page 2 ---\n\n--- Page 3 ---\n");
		assert.deepEqual(out.failedPages, [
			{ page: 2, status: "unreadable", reason: "OCR failed" },
			{ page: 3, status: "empty", reason: "Blank" },
		]);
	});

	it("rejects duplicate pages", () => {
		badResponse([{ page: 1, status: "ok", markdown: "a" }, { page: 1, status: "ok", markdown: "b" }], 1, /duplicate page 1/);
	});

	it("rejects missing pages", () => {
		badResponse([{ page: 2, status: "ok", markdown: "b" }], 2, /omitted page 1/);
	});

	it("rejects out-of-range and non-integer pages", () => {
		badResponse([{ page: 2, status: "ok", markdown: "b" }], 1, /out-of-range page 2/);
		badResponse([{ page: 1.5, status: "ok", markdown: "b" }], 1, /out-of-range page 1.5/);
	});

	it("rejects a document with no text", () => {
		badResponse([{ page: 1, status: "empty" }, { page: 2, status: "unreadable" }], 2, /no readable text/);
		badResponse([{ page: 1, status: "ok", markdown: " \n" }], 1, /no readable text/);
	});

	it("normalises CRLF, escapes marker-like lines, and round trips their text", () => {
		const original = "Before\r\n--- Page 3 ---\r\n\\--- Page 4 ---\r\nAfter";
		const out = normaliseConversion(conversion([
			{ page: 1, status: "ok", markdown: original },
			{ page: 2, status: "ok", markdown: "End" },
		]), 2);
		assert.equal(out.content, "--- Page 1 ---\nBefore\n\\--- Page 3 ---\n\\\\--- Page 4 ---\nAfter\n--- Page 2 ---\nEnd");
		const parsed = parsePageMarkedMarkdown(out.content);
		assert.deepEqual(parsed, [
			{ page: 1, markdown: original.replace(/\r\n/g, "\n") },
			{ page: 2, markdown: "End" },
		]);
		assert.equal(parsed.filter((page) => page.page === 3).length, 0);
	});
});
