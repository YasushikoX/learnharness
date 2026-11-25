import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import { createDoclingConverter } from "../src/server/converters/docling.ts";
import { convertWithRegistry } from "../src/server/converters/registry.ts";
import { pdfjsConverter } from "../src/server/converters/pdfjs.ts";
import { ConverterError, type ConvertInput } from "../src/core/pdf-converter.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { parsePdfConversionSettingsBody } from "../src/server/settings-body.ts";
import { tinyPdf } from "./helpers/tiny-pdf.ts";

const bytes = tinyPdf([
	{ runs: [{ text: "First page text", x: 72, y: 700 }] },
	{ image: true },
]);
const input: ConvertInput = { bytes, filename: "tiny.pdf", pageCount: 2 };
const context = (signal = new AbortController().signal) => ({ signal, onProgress: () => {} });

async function server(
	handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string, requests: string[]) => void,
	run: (baseUrl: string, requests: string[]) => Promise<void>,
) {
	const requests: string[] = [];
	const sockets = new Set<import("node:net").Socket>();
	const instance = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		req.on("end", () => {
			requests.push(`${req.method} ${req.url}`);
			handler(req, res, Buffer.concat(chunks).toString("latin1"), requests);
		});
	});
	instance.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
	const address = instance.address();
	assert.ok(address && typeof address === "object");
	try {
		await run(`http://127.0.0.1:${address.port}`, requests);
	} finally {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => instance.close(() => resolve()));
	}
}

function field(body: string, name: string): string {
	return body.split(`name="${name}"\r\n\r\n`)[1]?.split("\r\n")[0] ?? "";
}

async function expectKind(promise: Promise<unknown>, kind: ConverterError["kind"]) {
	await assert.rejects(promise, (error) => error instanceof ConverterError && error.kind === kind);
}

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
});

describe("pdfjs converter", () => {
	it("extracts text and identifies an image-only page as needing OCR", async () => {
		const result = await pdfjsConverter.convert(input, context());
		assert.equal(result.pages[0]?.status, "ok");
		assert.match(result.pages[0]?.status === "ok" ? result.pages[0].markdown : "", /First page text/);
		assert.deepEqual(result.pages[1], {
			page: 2,
			status: "empty",
			reason: "No extractable text; this page looks like a scan and needs an OCR converter.",
		});
	});
});

describe("Docling converter", () => {
	it("submits once, polls, checks auth and options, and splits returned Markdown", async () => {
		let polls = 0;
		let delimiter = "";
		await server((req, res, body) => {
			if (req.url === "/v1/convert/file/async") {
				assert.equal(req.headers["x-api-key"], "test-key");
				assert.equal(field(body, "do_ocr"), "true");
				assert.equal(field(body, "do_formula_enrichment"), "true");
				delimiter = field(body, "md_page_break_placeholder");
				assert.match(delimiter, /^<!-- learnharness-page-/);
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify({ task_id: "job 1", task_type: "convert", task_status: "started" }));
				return;
			}
			if (req.url?.startsWith("/v1/status/poll/")) {
				polls++;
				assert.ok(req.url.includes("job%201"));
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify({ task_id: "job 1", task_type: "convert", task_status: polls === 1 ? "started" : "success" }));
				return;
			}
			assert.equal(req.url, "/v1/result/job%201");
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ status: "success", processing_time: 1, document: { filename: "tiny.pdf", md_content: `First${delimiter}Second` } }));
		}, async (baseUrl, requests) => {
			const result = await createDoclingConverter({ baseUrl, apiKey: "test-key", formulaEnrichment: true, pollIntervalMs: 1 }).convert(input, context());
			assert.equal(result.pages.length, 2);
			assert.equal(result.pages[0]?.status === "ok" ? result.pages[0].markdown : "", "First");
			assert.equal(result.pages[1]?.status === "ok" ? result.pages[1].markdown : "", "Second");
			assert.equal(polls, 2);
			assert.equal(requests.filter((request) => request.includes("/convert/file/async")).length, 1);
		});
	});

	it("rejects a page-count mismatch", async () => {
		let delimiter = "";
		await server((req, res, body) => {
			res.setHeader("content-type", "application/json");
			if (req.url === "/v1/convert/file/async") {
				delimiter = field(body, "md_page_break_placeholder");
				res.end(JSON.stringify({ task_id: "j", task_type: "convert", task_status: "success" }));
			} else if (req.url?.startsWith("/v1/result/")) {
				res.end(JSON.stringify({ status: "success", processing_time: 1, document: { filename: "x", md_content: `one${delimiter}two` } }));
			} else res.end(JSON.stringify({ task_id: "j", task_type: "convert", task_status: "success" }));
		}, async (baseUrl) => {
			const threePages = { ...input, pageCount: 3 };
			await expectKind(createDoclingConverter({ baseUrl }).convert(threePages, context()), "bad_response");
		});
	});

	for (const [status, kind] of [[401, "auth"], [429, "rate_limit"]] as const) {
		it(`maps HTTP ${status} to ${kind} without resubmitting`, async () => {
			await server((_req, res) => {
				res.statusCode = status;
				res.end();
			}, async (baseUrl, requests) => {
				await expectKind(createDoclingConverter({ baseUrl }).convert(input, context()), kind);
				assert.equal(requests.length, 1);
			});
		});
	}

	it("times out a request without resubmitting", async () => {
		await server(() => {}, async (baseUrl, requests) => {
			await expectKind(createDoclingConverter({ baseUrl, requestTimeoutMs: 20 }).convert(input, context()), "timeout");
			assert.equal(requests.length, 1);
		});
	});

	it("honours abort during polling", async () => {
		const controller = new AbortController();
		await server((req, res) => {
			res.setHeader("content-type", "application/json");
			if (req.url?.startsWith("/v1/status/poll/")) controller.abort();
			res.end(JSON.stringify({ task_id: "j", task_type: "convert", task_status: "started" }));
		}, async (baseUrl, requests) => {
			await expectKind(createDoclingConverter({ baseUrl, pollIntervalMs: 5 }).convert(input, context(controller.signal)), "aborted");
			assert.equal(requests.filter((request) => request.includes("/convert/file/async")).length, 1);
		});
	});

	it("falls back to pdfjs only for an unreachable service and records a warning", async () => {
		const failingFetch = async () => { throw new TypeError("connection refused"); };
		const result = await convertWithRegistry(input, context(), {
			converterId: "docling",
			docling: { baseUrl: "http://docling.invalid", fetch: failingFetch as typeof fetch },
		});
		assert.equal(result.converterId, "pdfjs");
		assert.match(result.warnings?.[0] ?? "", /docling failed \(unreachable\); used pdfjs instead/);
		assert.equal(result.pages[0]?.status, "ok");
	});

	it("does not fall back or resubmit after rate limiting", async () => {
		await server((_req, res) => {
			res.statusCode = 429;
			res.end();
		}, async (baseUrl, requests) => {
			await expectKind(convertWithRegistry(input, context(), { converterId: "docling", docling: { baseUrl } }), "rate_limit");
			assert.equal(requests.length, 1);
		});
	});
});
