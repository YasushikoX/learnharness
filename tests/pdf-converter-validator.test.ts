import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { ConverterError, type ConvertResult, type PageResult, type PdfConverter } from "../src/core/pdf-converter.ts";
import { createHttpConverter, SECRET_REDACTED_WARNING } from "../src/server/converters/http-declarative.ts";
import { pdfjsConverter } from "../src/server/converters/pdfjs.ts";
import { VALIDATION_SENTENCES, validationPdf } from "../src/server/converters/validation-fixture.ts";
import { validateConverter, type ConverterValidationReport } from "../src/server/converters/validator.ts";
import { probePdfInput } from "../src/server/material-conversion.ts";
import { withServer } from "./helpers/docling-server.ts";
import { KEY, delimitedProfile, json, routes } from "./helpers/converter-services.ts";

/**
 * The converter test (src/server/converters/validator.ts) on the bundled two-page PDF: pdfjs and a loopback
 * profile service pass; each fail reason is produced by a converter that gets exactly that wrong.
 */

const [S1, S2] = VALIDATION_SENTENCES;
const signal = () => new AbortController().signal;
const ok = (page: number, markdown: string): PageResult => ({ page, status: "ok", markdown });

function fake(answer: () => ConvertResult | Promise<ConvertResult>): PdfConverter {
	return { id: "fake", version: "1", async convert() { return answer(); } };
}

const status = (report: ConverterValidationReport) => Object.fromEntries(report.checks.map((c) => [c.id, c.status]));

/** The page texts of an uploaded test PDF (sent as base64 in a JSON body): its sentences, "" for a blank page. */
function sentencesOf(body: string): string[] {
	const pdf = Buffer.from((JSON.parse(body) as { file: { data: string } }).file.data, "base64").toString("latin1");
	return [...pdf.matchAll(/stream\n(.*?)\nendstream/gs)].map((m) => /\((.*)\) Tj/.exec(m[1]!)?.[1] ?? "");
}

describe("the converter test PDF", () => {
	it("is built byte for byte the same every time, equals the committed fixture, and has two pages", async () => {
		const built = validationPdf();
		assert.deepEqual(validationPdf(), built);
		assert.ok(built.byteLength < 2048, `${built.byteLength} bytes`);
		const committed = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "converters", "validation-two-page.pdf"));
		assert.deepEqual(new Uint8Array(committed), built);
		assert.equal((await probePdfInput(built, "x.pdf", signal())).pageCount, 2);
	});
});

describe("validateConverter", () => {
	it("the built-in reader passes every check", async () => {
		const report = await validateConverter(pdfjsConverter, { signal: signal() });
		assert.equal(report.ok, true, JSON.stringify(report.checks));
		assert.deepEqual(status(report), { converted: "pass", markers: "pass", page_1: "pass", page_2: "pass", own_pages: "pass", blank_page: "pass", no_secret: "pass" });
		assert.match(report.pages[0]!.text, /heron/);
		assert.match(report.pages[1]!.text, /kettle/);
	});

	it("a profile service that places each page's text correctly passes", async () => {
		const service = routes({
			"POST /api/convert": (_q, r, body) => json(r, { markdown: sentencesOf(body).map((s, i) => (i === 0 ? `# ${s}` : s.toUpperCase())).join((JSON.parse(body) as { page_separator: string }).page_separator) }),
		});
		await withServer(service, async (baseUrl) => {
			const converter = createHttpConverter({ converterId: "custom:d", profile: delimitedProfile(), baseUrl, apiKey: KEY });
			const report = await validateConverter(converter, { signal: signal(), secrets: [KEY] });
			assert.equal(report.ok, true, JSON.stringify(report.checks));
		});
	});

	it("fail: the conversion throws (the reason is shown, the key removed, later checks skipped)", async () => {
		const report = await validateConverter(fake(() => { throw new ConverterError("auth", `refused ${KEY}`, false); }), { signal: signal(), secrets: [KEY] });
		assert.equal(report.ok, false);
		assert.deepEqual(status(report), { converted: "fail", markers: "skipped", page_1: "skipped", page_2: "skipped", own_pages: "skipped", blank_page: "skipped", no_secret: "fail" });
		assert.equal(JSON.stringify(report).includes(KEY), false);
		assert.equal(report.error?.kind, "auth");
	});

	it("fail: a page is missing (markers)", async () => {
		const report = await validateConverter(fake(() => ({ converterVersion: "1", pages: [ok(1, S1)] })), { signal: signal() });
		assert.equal(status(report).markers, "fail");
		assert.match(report.checks.find((c) => c.id === "markers")!.message, /omitted page 2/);
	});

	it("fail: no text on either page (markers)", async () => {
		const report = await validateConverter(fake(() => ({ converterVersion: "1", pages: [{ page: 1, status: "empty" }, { page: 2, status: "empty" }] })), { signal: signal() });
		assert.match(report.checks.find((c) => c.id === "markers")!.message, /no text on either page/);
	});

	it("fail: a page lacks its own sentence (page_1)", async () => {
		const report = await validateConverter(fake(() => ({ converterVersion: "1", pages: [ok(1, "something else"), ok(2, S2)] })), { signal: signal() });
		assert.deepEqual([status(report).page_1, status(report).page_2, status(report).own_pages], ["fail", "pass", "pass"]);
	});

	it("fail: shifted or swapped pages (own_pages)", async () => {
		const swapped = await validateConverter(fake(() => ({ converterVersion: "1", pages: [ok(1, S2), ok(2, S1)] })), { signal: signal() });
		assert.deepEqual([status(swapped).page_1, status(swapped).page_2, status(swapped).own_pages], ["fail", "fail", "fail"]);
		const merged = await validateConverter(fake(() => ({ converterVersion: "1", pages: [ok(1, `${S1} ${S2}`), ok(2, S2)] })), { signal: signal() });
		assert.equal(status(merged).own_pages, "fail");
		assert.match(merged.checks.find((c) => c.id === "own_pages")!.message, /page 1 has page 2's sentence/);
	});

	it("fail: the key appears in the answer, or the converter reported removing it (no_secret)", async () => {
		const echoed = await validateConverter(fake(() => ({ converterVersion: "1", pages: [ok(1, `${S1} ${KEY}`), ok(2, S2)] })), { signal: signal(), secrets: [KEY] });
		assert.equal(status(echoed).no_secret, "fail");
		assert.equal(JSON.stringify(echoed).includes(KEY), false, "the report itself never carries the key");
		const redacted = await validateConverter(fake(() => ({ converterVersion: "1", pages: [ok(1, S1), ok(2, S2)], warnings: [SECRET_REDACTED_WARNING] })), { signal: signal(), secrets: [KEY] });
		assert.equal(status(redacted).no_secret, "fail");
	});

	it("fail: a delimiter service that does not mark every page", async () => {
		await withServer(routes({ "POST /api/convert": (_q, r) => json(r, { markdown: `${S1} ${S2}` }) }), async (baseUrl) => {
			const report = await validateConverter(createHttpConverter({ converterId: "custom:d", profile: delimitedProfile(), baseUrl, apiKey: KEY }), { signal: signal(), secrets: [KEY] });
			assert.equal(status(report).converted, "fail");
			assert.match(report.checks[0]!.message, /did not mark every page/);
		});
	});

	it("an abort rejects instead of reporting", async () => {
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(validateConverter(fake(() => { throw new ConverterError("aborted", "aborted", false); }), { signal: controller.signal }));
	});
});
