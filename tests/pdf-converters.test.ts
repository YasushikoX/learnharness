import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, describe, it } from "node:test";
import { ConverterError, type ConvertInput, type PageResult } from "../src/core/pdf-converter.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { tinyPdf } from "./helpers/tiny-pdf.ts";
import { closedBaseUrl, fakeDocling, formFields, json, recordedPdf, recordedResponse, withServer } from "./helpers/docling-server.ts";
import type { DoclingConverterOptions } from "../src/server/converters/docling.ts";

// The registry reads the Docling key from the credential store: a private one, never the repo's auth.json.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-pdf-converters-"));
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
process.env.LH_DATA_DIR = TMP;
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const { assignDoclingPages, createDoclingConverter } = await import("../src/server/converters/docling.ts");
const { normaliseConversion } = await import("../src/server/converters/normalise.ts");
const { convertWithFallback, isRegisteredPdfConverter, resolvePdfConverter } = await import("../src/server/converters/registry.ts");
const { pdfjsConverter } = await import("../src/server/converters/pdfjs.ts");
const { parsePdfConversionSettingsBody } = await import("../src/server/settings-body.ts");

const tiny = tinyPdf([{ runs: [{ text: "First page text", x: 72, y: 700 }] }, { image: true }]);
const tinyInput: ConvertInput = { bytes: tiny, filename: "tiny.pdf", pageCount: 2 };
/** A real three-page PDF (text on every page), so a fallback to pdfjs has the same page count. */
const threeInput: ConvertInput = { bytes: recordedPdf("three-full"), filename: "three-full.pdf", pageCount: 3 };
const context = (signal = new AbortController().signal) => ({ signal, onProgress: () => {} });
/** Fast polling for the loopback server. */
const fast = (baseUrl: string, extra: Partial<DoclingConverterOptions> = {}) => createDoclingConverter({ baseUrl, minPollIntervalMs: 1, pollWaitSeconds: 0, ...extra });

async function rejectsWith(promise: Promise<unknown>, kind: ConverterError["kind"], message?: RegExp): Promise<ConverterError> {
	let caught: unknown;
	await promise.then(() => assert.fail(`expected a ${kind} ConverterError`), (error: unknown) => { caught = error; });
	assert.ok(caught instanceof ConverterError, `not a ConverterError: ${String(caught)}`);
	assert.equal(caught.kind, kind, caught.message);
	if (message) assert.match(caught.message, message);
	return caught;
}

const texts = (pages: PageResult[]) => pages.map((p) => (p.status === "ok" ? p.markdown : p.status));
const uploads = (log: { url: string }[]) => log.filter((r) => r.url === "/v1/convert/file/async").length;

describe("PDF conversion settings", () => {
	it("uses the ordinary settings section and keeps credentials out of it", () => {
		const parsed = parsePdfConversionSettingsBody({
			converter: "docling",
			docling: { baseUrl: "http://localhost:5001/", ocr: false, formulaEnrichment: true },
			apiKey: "not-accepted-here",
		});
		assert.deepEqual(parsed, {
			ok: true,
			settings: { converter: "docling", docling: { baseUrl: "http://localhost:5001", ocr: false, formulaEnrichment: true } },
		});
		const sanitized = sanitizeUserSettings({ version: 1, ...(parsed.ok ? { pdfConversion: parsed.settings } : {}) });
		assert.deepEqual(sanitized?.pdfConversion, parsed.ok ? parsed.settings : undefined);
		assert.equal(JSON.stringify(sanitized).includes("not-accepted-here"), false);
	});

	it("accepts only registered converter ids", () => {
		assert.equal(isRegisteredPdfConverter("pdfjs"), true);
		assert.equal(parsePdfConversionSettingsBody({ converter: "pdfjs" }).ok, true);
		const unknown = parsePdfConversionSettingsBody({ converter: "marker" });
		assert.equal(unknown.ok, false);
		assert.match(unknown.ok ? "" : unknown.error, /one of: pdfjs, docling/);
	});
});

describe("pdfjs converter", () => {
	it("extracts text and identifies an image-only page as needing OCR", async () => {
		const result = await pdfjsConverter.convert(tinyInput, context());
		assert.equal(result.pages[0]?.status, "ok");
		assert.match(result.pages[0]?.status === "ok" ? result.pages[0].markdown : "", /First page text/);
		assert.deepEqual(result.pages[1], { page: 2, status: "empty", reason: "No extractable text; this page looks like a scan and needs an OCR converter." });
	});
});

describe("Docling pages from the recorded responses (F5)", () => {
	const cases: [string, (string | RegExp)[]][] = [
		["three-full", [/ALPHA/, /BRAVO/, /CHARLIE/]],
		["blank-middle", [/ALPHA/, "empty", /CHARLIE/]],
		["blank-first-last", ["empty", /BRAVO/, "empty"]],
	];
	for (const [name, expected] of cases) {
		it(`${name}: every segment lands on its physical page`, async () => {
			const docling = fakeDocling(recordedResponse(name));
			await withServer(docling.handler, async (baseUrl, log) => {
				const result = await fast(baseUrl).convert({ bytes: recordedPdf(name), filename: `${name}.pdf`, pageCount: 3 }, context());
				const got = texts(result.pages);
				expected.forEach((want, i) => (typeof want === "string" ? assert.equal(got[i], want) : assert.match(got[i]!, want)));
				assert.equal(result.converterVersion, "docling 2.61.1; docling-serve 1.38.2");
				const upload = log.find((r) => r.url === "/v1/convert/file/async")!;
				assert.deepEqual(formFields(upload.body ?? "", "to_formats"), ["md", "json"]);
				assert.equal(uploads(log), 1);
			});
		});
	}

	it("the recorded blank-middle Markdown has one placeholder for three pages", () => {
		const md = (recordedResponse("blank-middle").document as { md_content: string }).md_content;
		assert.equal(md.split("[[LH-PAGE-BREAK]]").length, 2);
	});
});

describe("assignDoclingPages", () => {
	const D = "<!-- break -->";
	const doc = (items: { ref: string; page: number | number[]; layer?: string }[], pages = 3) => {
		const lists: Record<string, Record<string, unknown>[]> = { texts: [], tables: [], pictures: [], key_value_items: [], form_items: [], groups: [] };
		const children = items.map((item) => {
			const [, list] = /^#\/([a-z_]+)\//.exec(item.ref)!;
			const pagesOf = Array.isArray(item.page) ? item.page : [item.page];
			lists[list!]!.push({ self_ref: item.ref, prov: pagesOf.map((page_no) => ({ page_no })), ...(item.layer ? { content_layer: item.layer } : {}) });
			return { $ref: item.ref };
		});
		return { ...lists, body: { self_ref: "#/body", children }, pages: Object.fromEntries(Array.from({ length: pages }, (_, i) => [String(i + 1), { page_no: i + 1 }])) };
	};

	it("counts pages from every item kind, not only texts", () => {
		const pages = assignDoclingPages(`A${D}<!-- image -->${D}| t |`, doc([{ ref: "#/texts/0", page: 1 }, { ref: "#/pictures/0", page: 2 }, { ref: "#/tables/0", page: 3 }]), D, 3);
		assert.deepEqual(texts(pages), ["A", "empty", "| t |"]);
		assert.match(pages[1]?.status === "empty" ? (pages[1].reason ?? "") : "", /only an image/);
	});

	it("ignores furniture (page headers and footers are not in the Markdown)", () => {
		const pages = assignDoclingPages(`A${D}C`, doc([{ ref: "#/texts/0", page: 1 }, { ref: "#/texts/1", page: 2, layer: "furniture" }, { ref: "#/texts/2", page: 3 }]), D, 3);
		assert.deepEqual(texts(pages), ["A", "empty", "C"]);
	});

	it("ignores children of a non-body group whose children omit content_layer", () => {
		const jsonDoc = {
			pages: { "1": { page_no: 1 }, "2": { page_no: 2 }, "3": { page_no: 3 } },
			body: { self_ref: "#/body", children: [{ $ref: "#/texts/0" }, { $ref: "#/groups/0" }, { $ref: "#/texts/2" }] },
			groups: [{ self_ref: "#/groups/0", content_layer: "furniture", children: [{ $ref: "#/texts/1" }] }],
			texts: [
				{ self_ref: "#/texts/0", content_layer: "body", prov: [{ page_no: 1 }] },
				{ self_ref: "#/texts/1", prov: [{ page_no: 2 }] },
				{ self_ref: "#/texts/2", content_layer: "body", prov: [{ page_no: 3 }] },
			],
		};
		const pages = assignDoclingPages(`A${D}C`, jsonDoc, D, 3);
		assert.deepEqual(texts(pages), ["A", "empty", "C"]);
	});

	it("treats image-placeholder-only pages as empty while keeping text plus image placeholders", () => {
		const mixed = assignDoclingPages(
			`  <!-- image -->\n\n<!-- image -->  ${D}Caption text\n\n<!-- image -->`,
			doc([{ ref: "#/pictures/0", page: 1 }, { ref: "#/texts/0", page: 2 }], 2),
			D,
			2,
		);
		assert.equal(mixed[0]?.status, "empty");
		assert.match(mixed[0]?.status === "empty" ? (mixed[0].reason ?? "") : "", /only an image/);
		assert.deepEqual(mixed[1], { page: 2, status: "ok", markdown: "Caption text\n\n<!-- image -->" });

		const allImages = assignDoclingPages(
			`<!-- image -->${D}<!-- image -->`,
			doc([{ ref: "#/pictures/0", page: 1 }, { ref: "#/pictures/1", page: 2 }], 2),
			D,
			2,
		);
		assert.deepEqual(texts(allImages), ["empty", "empty"]);
		assert.throws(
			() => normaliseConversion({ converterVersion: "1.38.2", pages: allImages }, 2),
			(e: unknown) => e instanceof ConverterError && e.kind === "no_text",
		);
	});

	it("places an item spanning pages on its first page", () => {
		const pages = assignDoclingPages(`A${D}C`, doc([{ ref: "#/tables/0", page: [1, 2] }, { ref: "#/texts/0", page: 3 }]), D, 3);
		assert.deepEqual(texts(pages), ["A", "empty", "C"]);
	});

	it("a segment count that differs from the pages with items is bad_response", () => {
		assert.throws(() => assignDoclingPages(`A${D}B${D}C`, doc([{ ref: "#/texts/0", page: 1 }, { ref: "#/texts/1", page: 3 }]), D, 3), (e: unknown) => e instanceof ConverterError && e.kind === "bad_response");
		assert.throws(() => assignDoclingPages("A", doc([{ ref: "#/texts/0", page: 1 }, { ref: "#/texts/1", page: 3 }]), D, 3), (e: unknown) => e instanceof ConverterError && e.kind === "bad_response");
	});

	it("a JSON page count that differs from the local one is bad_response", () => {
		assert.throws(() => assignDoclingPages("A", doc([{ ref: "#/texts/0", page: 1 }], 2), D, 3), /Docling saw 2 pages; this PDF has 3/);
	});

	it("a reading order that goes back to an earlier page is bad_response", () => {
		assert.throws(() => assignDoclingPages(`A${D}B`, doc([{ ref: "#/texts/0", page: 2 }, { ref: "#/texts/1", page: 1 }]), D, 3), /goes back/);
	});

	it("no JSON document is bad_response; no items and no text is all empty", () => {
		assert.throws(() => assignDoclingPages("A", null, D, 1), /no JSON document/);
		assert.deepEqual(texts(assignDoclingPages("", doc([], 2), D, 2)), ["empty", "empty"]);
	});
});

describe("Docling client", () => {
	it("sends the key on every request, the options, and polls with a server-side wait", async () => {
		const docling = fakeDocling(recordedResponse("three-full"));
		await withServer(docling.handler, async (baseUrl, log) => {
			await createDoclingConverter({ baseUrl, apiKey: "test-key", formulaEnrichment: true, minPollIntervalMs: 1 }).convert(threeInput, context());
			assert.deepEqual(log.map((r) => r.url), ["/version", "/v1/convert/file/async", "/v1/status/poll/task%201?wait=5", "/v1/result/task%201"]);
			for (const request of log) assert.equal(request.headers["x-api-key"], "test-key");
			const body = log[1]!.body ?? "";
			assert.deepEqual(formFields(body, "do_ocr"), ["true"]);
			assert.deepEqual(formFields(body, "do_formula_enrichment"), ["true"]);
			assert.match(docling.delimiter(), /^<!-- learnharness-page-[0-9a-f-]{36} -->$/);
		});
	});

	it("a refused key stops before the upload", async () => {
		await withServer((_req, res) => json(res, { detail: "Invalid API key" }, 401), async (baseUrl, log) => {
			await rejectsWith(fast(baseUrl, { apiKey: "wrong-key" }).convert(threeInput, context()), "auth", /Invalid API key/);
			assert.equal(uploads(log), 0);
		});
	});

	it("rate limiting is reported without resubmitting", async () => {
		const docling = fakeDocling(recordedResponse("three-full"), { upload: (_q, r) => json(r, { detail: "slow down" }, 429) });
		await withServer(docling.handler, async (baseUrl, log) => {
			const error = await rejectsWith(fast(baseUrl).convert(threeInput, context()), "rate_limit");
			assert.equal(error.retryable, true);
			assert.equal(uploads(log), 1);
		});
	});

	it("a task that fails surfaces the server's message and its retryable flag", async () => {
		for (const retryable of [true, false]) {
			const docling = fakeDocling(recordedResponse("three-full"), {
				poll: (_q, r) => json(r, { task_id: "task 1", task_type: "convert", task_status: "failure", failure: { category: "resource", message: "Worker ran out of memory", retryable, phase: "convert" } }),
			});
			await withServer(docling.handler, async (baseUrl) => {
				const error = await rejectsWith(fast(baseUrl).convert(threeInput, context()), "conversion_failed", /Worker ran out of memory/);
				assert.equal(error.retryable, retryable);
			});
		}
	});

	it("a TaskFailureResult from the result endpoint surfaces the server's message", async () => {
		const docling = fakeDocling(() => ({ kind: "TaskFailureResult", failure: { category: "input", message: "PDF is encrypted", retryable: false, phase: "parse" } }));
		await withServer(docling.handler, async (baseUrl) => {
			await rejectsWith(fast(baseUrl).convert(threeInput, context()), "conversion_failed", /PDF is encrypted/);
		});
	});

	it("a zip result is bad_response", async () => {
		const docling = fakeDocling({}, { result: (_q, res) => { res.setHeader("content-type", "application/zip"); res.end("PK\u0003\u0004"); } });
		await withServer(docling.handler, async (baseUrl) => {
			await rejectsWith(fast(baseUrl).convert(threeInput, context()), "bad_response", /zip/);
		});
	});

	it("C6: a redirect is bad_response with a clear message, never followed", async () => {
		await withServer((_req, res) => { res.statusCode = 307; res.setHeader("location", "https://docling.example/version"); res.end(); }, async (baseUrl, log) => {
			await rejectsWith(convertWithFallback({ converter: fast(baseUrl), requestedId: "docling", warnings: [] }, threeInput, context()), "bad_response", /redirect \(HTTP 307 to https:\/\/docling\.example\/version\)/);
			assert.equal(log.length, 1);
		});
	});

	it("an old service without /version still converts, version unknown", async () => {
		const docling = fakeDocling(recordedResponse("three-full"), { version: (_q, r) => json(r, { detail: "Not Found" }, 404) });
		await withServer(docling.handler, async (baseUrl) => {
			assert.equal((await fast(baseUrl).convert(threeInput, context())).converterVersion, "unknown");
		});
	});

	it("timeouts: a request that hangs times out without resubmitting the upload", { timeout: 20_000 }, async () => {
		const docling = fakeDocling(recordedResponse("three-full"), { upload: () => {} });
		await withServer(docling.handler, async (baseUrl, log) => {
			await rejectsWith(fast(baseUrl, { uploadTimeoutMs: 300 }).convert(threeInput, context()), "timeout", /did not answer within/);
			await new Promise((resolve) => setTimeout(resolve, 300)); // a resubmission would arrive in this time
			assert.ok(uploads(log) <= 1, `uploads: ${uploads(log)}`);
		});
	});

	it("C4: the upload has its own longer timeout than ordinary requests", { timeout: 20_000 }, async () => {
		const docling = fakeDocling(recordedResponse("three-full"), {
			upload: (_q, r) => void setTimeout(() => json(r, { task_id: "task 1", task_type: "convert", task_status: "success" }), 1500),
		});
		await withServer(docling.handler, async (baseUrl) => {
			const result = await fast(baseUrl, { requestTimeoutMs: 1000, uploadTimeoutMs: 20_000 }).convert(threeInput, context());
			assert.match(texts(result.pages)[2]!, /CHARLIE/);
		});
	});

	it("the job deadline covers polling", { timeout: 20_000 }, async () => {
		const docling = fakeDocling(recordedResponse("three-full"), { poll: (_q, r) => json(r, { task_id: "task 1", task_type: "convert", task_status: "started" }) });
		await withServer(docling.handler, async (baseUrl) => {
			await rejectsWith(fast(baseUrl, { jobDeadlineMs: 400, minPollIntervalMs: 20 }).convert(threeInput, context()), "timeout", /job deadline/);
		});
	});

	/** A result whose headers and half its body arrive, then nothing. */
	const halfResult = (sent: () => void) => fakeDocling({}, {
		result: (_q, res) => {
			res.setHeader("content-type", "application/json");
			res.write('{"status":"success","document":{"md_content":"');
			sent();
		},
	});

	it("F2: an abort stops a response body that is still arriving", { timeout: 20_000 }, async () => {
		const controller = new AbortController();
		let sent!: () => void;
		const arrived = new Promise<void>((resolve) => { sent = resolve; });
		await withServer(halfResult(() => sent()).handler, async (baseUrl) => {
			const converting = fast(baseUrl).convert(threeInput, context(controller.signal));
			await arrived;
			const started = Date.now();
			controller.abort();
			await rejectsWith(converting, "aborted");
			assert.ok(Date.now() - started < 5000);
		});
	});

	it("F2: the request timeout and the job deadline stop a body that is still arriving", { timeout: 20_000 }, async () => {
		await withServer(halfResult(() => {}).handler, async (baseUrl) => {
			await rejectsWith(fast(baseUrl, { requestTimeoutMs: 300 }).convert(threeInput, context()), "timeout", /did not answer within/);
		});
		await withServer(halfResult(() => {}).handler, async (baseUrl) => {
			await rejectsWith(fast(baseUrl, { jobDeadlineMs: 500 }).convert(threeInput, context()), "timeout", /job deadline/);
		});
	});

	it("F6: a response larger than the cap is refused, declared or streamed", async () => {
		const big = "x".repeat(10_000);
		const streamed = fakeDocling({}, { result: (_q, res) => { res.setHeader("content-type", "application/json"); res.write(`{"pad":"${big}`); res.end(`${big}"}`); } });
		await withServer(streamed.handler, async (baseUrl) => {
			await rejectsWith(fast(baseUrl, { maxResponseBytes: 5_000 }).convert(threeInput, context()), "bad_response", /larger than/);
		});
		const declared = fakeDocling({}, { result: (_q, res) => { res.setHeader("content-type", "application/json"); res.setHeader("content-length", String(1_000_000)); res.write("{"); } });
		await withServer(declared.handler, async (baseUrl) => {
			await rejectsWith(fast(baseUrl, { maxResponseBytes: 5_000 }).convert(threeInput, context()), "bad_response", /larger than/);
		});
	});

	it("an abort during polling stops without a second upload", async () => {
		const controller = new AbortController();
		const docling = fakeDocling(recordedResponse("three-full"), {
			poll: (_q, r) => {
				controller.abort();
				json(r, { task_id: "task 1", task_type: "convert", task_status: "started" });
			},
		});
		await withServer(docling.handler, async (baseUrl, log) => {
			await rejectsWith(fast(baseUrl).convert(threeInput, context(controller.signal)), "aborted");
			assert.equal(uploads(log), 1);
		});
	});
});

describe("registry", () => {
	const noKey = () => undefined;

	// Test files import settings-body.ts before they isolate their data folder (cache-retention.test.ts): if it loaded
	// config.ts, the settings store would stay bound to the repo's data/ folder and the test would write there.
	it("importing the settings parser (and so the registry) does not load config.ts", () => {
		const lateDir = path.resolve(os.tmpdir(), "lh-late-data-dir");
		const probe = [
			"await import('./src/server/settings-body.ts');",
			`process.env.LH_DATA_DIR = ${JSON.stringify(lateDir)};`,
			"const config = await import('./config.ts');",
			"console.log(config.SETTINGS_FILE);",
		].join("\n");
		const env: NodeJS.ProcessEnv = { ...process.env };
		delete env.LH_DATA_DIR;
		const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], { cwd: path.join(import.meta.dirname, ".."), env, encoding: "utf8" });
		assert.equal(run.status, 0, run.stderr);
		assert.equal(run.stdout.trim(), path.join(lateDir, "settings.json"));
	});

	it("Docling without a URL falls back to pdfjs with a warning that says so", () => {
		const resolved = resolvePdfConverter({ converter: "docling" }, noKey);
		assert.equal(resolved.converter.id, "pdfjs");
		assert.match(resolved.warnings[0] ?? "", /no Docling URL is configured; the built-in reader \(pdfjs\) was used instead/);
	});

	it("an unknown converter id in the settings falls back to pdfjs with a warning", () => {
		const resolved = resolvePdfConverter({ converter: "gone" }, noKey);
		assert.equal(resolved.converter.id, "pdfjs");
		assert.match(resolved.warnings[0] ?? "", /"gone"/);
	});

	it("Docling with a URL carries its options in the cache key", () => {
		const resolved = resolvePdfConverter({ converter: "docling", docling: { baseUrl: "http://127.0.0.1:1", ocr: false } }, noKey);
		assert.equal(resolved.converter.id, "docling");
		assert.deepEqual(resolved.converter.options, { ocr: false, formulaEnrichment: false });
	});

	it("an unreachable service (loopback, nothing listening) falls back to pdfjs with a warning", async () => {
		const baseUrl = await closedBaseUrl();
		const result = await convertWithFallback({ converter: fast(baseUrl), requestedId: "docling", warnings: [] }, threeInput, context());
		assert.equal(result.converterId, "pdfjs");
		assert.match(result.warnings?.[0] ?? "", /^Docling failed \(Could not reach Docling at http:\/\/127\.0\.0\.1:\d+: .+\); the built-in reader \(pdfjs\) was used instead\.$/);
		assert.match(texts(result.pages)[0]!, /ALPHA/);
	});

	it("a timeout falls back to pdfjs", { timeout: 20_000 }, async () => {
		await withServer(() => {}, async (baseUrl) => {
			const result = await convertWithFallback({ converter: fast(baseUrl, { requestTimeoutMs: 300 }), requestedId: "docling", warnings: [] }, threeInput, context());
			assert.equal(result.converterId, "pdfjs");
			assert.match(result.warnings?.[0] ?? "", /did not answer within/);
		});
	});

	it("rate limiting does not fall back", async () => {
		await withServer((_req, res) => json(res, {}, 429), async (baseUrl, log) => {
			await rejectsWith(convertWithFallback({ converter: fast(baseUrl), requestedId: "docling", warnings: [] }, threeInput, context()), "rate_limit");
			assert.equal(log.length, 1);
		});
	});
});
