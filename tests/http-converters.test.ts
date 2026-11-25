import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConverterError, type ConvertInput, type PageResult } from "../src/core/pdf-converter.ts";
import { createHttpConverter, SECRET_REDACTED_WARNING, type HttpConverterOptions } from "../src/server/converters/http-declarative.ts";
import { normaliseConversion } from "../src/server/converters/normalise.ts";
import { convertWithFallback } from "../src/server/converters/registry.ts";
import { MISTRAL_OCR_PRESET } from "../src/server/converters/presets.ts";
import { validationPdf } from "../src/server/converters/validation-fixture.ts";
import { closedBaseUrl, withServer, type LoggedRequest } from "./helpers/docling-server.ts";
import { KEY, bodyJson, delimitedProfile, formFields, json, pageArrayProfile, pagesAnswer, pollingProfile, routes } from "./helpers/converter-services.ts";

/**
 * The declarative HTTP interpreter (src/server/converters/http-declarative.ts) against loopback services: every
 * submit kind, polling, a separate result, page arrays from 0 and 1, a per-job random delimiter, and each failure.
 */

const pdf = validationPdf();
const input: ConvertInput = { bytes: pdf, filename: "two.pdf", pageCount: 2 };
const context = (signal = new AbortController().signal) => ({ signal, onProgress: () => {} });
const make = (baseUrl: string, profile: unknown, extra: Partial<HttpConverterOptions> = {}) =>
	createHttpConverter({ converterId: "custom:test", profile, baseUrl, apiKey: KEY, pollIntervalMs: 1, ...extra });
const texts = (pages: PageResult[]) => pages.map((p) => (p.status === "ok" ? p.markdown : p.status));
const count = (log: LoggedRequest[], url: string) => log.filter((r) => r.url.split("?")[0] === url).length;

async function rejectsWith(promise: Promise<unknown>, kind: ConverterError["kind"], message?: RegExp): Promise<ConverterError> {
	let caught: unknown;
	await promise.then(() => assert.fail(`expected a ${kind} ConverterError`), (error: unknown) => { caught = error; });
	assert.ok(caught instanceof ConverterError, `not a ConverterError: ${String(caught)}`);
	assert.equal(caught.kind, kind, caught.message);
	if (message) assert.match(caught.message, message);
	return caught;
}

describe("declarative HTTP converter: submit and extract", () => {
	it("multipart submit to a page-array service numbering from 1; the key only in its header", async () => {
		await withServer(routes({ "POST /convert": (_q, r) => json(r, pagesAnswer(["first", "second"])) }), async (baseUrl, log) => {
			const result = await make(baseUrl, pageArrayProfile(1)).convert(input, context());
			assert.deepEqual(texts(result.pages), ["first", "second"]);
			assert.equal(log.length, 1);
			const upload = log[0]!;
			assert.equal(upload.headers["x-api-key"], KEY);
			assert.deepEqual(formFields(upload.body!, "format"), ["markdown"]);
			assert.deepEqual(formFields(upload.body!, "flags"), ["a", "b"]);
			assert.match(upload.body!, /name="document"; filename="two\.pdf"\r\nContent-Type: application\/pdf/);
			assert.ok(upload.body!.includes(Buffer.from(pdf).toString("latin1")), "the PDF bytes are sent unchanged");
			assert.equal(upload.url.includes(KEY), false);
			assert.match(result.converterVersion, /^1\+[0-9a-f]{8}\/http1$/);
		});
	});

	it("a page array numbering from 0 lands on pages 1..N; normalised output has both markers", async () => {
		await withServer(routes({ "POST /convert": (_q, r) => json(r, pagesAnswer(["zero", "one"], 0)) }), async (baseUrl) => {
			const result = await make(baseUrl, pageArrayProfile(0)).convert(input, context());
			assert.deepEqual(result.pages.map((p) => p.page), [1, 2]);
			assert.equal(normaliseConversion(result, 2).content, "--- Page 1 ---\nzero\n--- Page 2 ---\none");
		});
	});

	it("a 1-based service read as 0-based is refused by the normaliser, not shifted", async () => {
		await withServer(routes({ "POST /convert": (_q, r) => json(r, pagesAnswer(["first", "second"], 1)) }), async (baseUrl) => {
			const result = await make(baseUrl, pageArrayProfile(0)).convert(input, context());
			assert.throws(() => normaliseConversion(result, 2), /out-of-range page 3/);
		});
	});

	it("base64 JSON submit: the Mistral OCR preset against a loopback imitation", async () => {
		const service = routes({
			"POST /v1/ocr": (_q, r, body) => {
				const sent = JSON.parse(body) as { document: { document_url: string } };
				const ok = sent.document.document_url === `data:application/pdf;base64,${Buffer.from(pdf).toString("base64")}`;
				json(r, ok ? { model: "mistral-ocr-test", pages: [{ index: 0, markdown: "# Page A" }, { index: 1, markdown: "Page B" }] } : { message: "bad document" }, ok ? 200 : 422);
			},
		});
		await withServer(service, async (baseUrl, log) => {
			const result = await createHttpConverter({ converterId: "mistral-ocr", profile: MISTRAL_OCR_PRESET, baseUrl, apiKey: KEY }).convert(input, context());
			assert.deepEqual(texts(result.pages), ["# Page A", "Page B"]);
			const sent = bodyJson(log[0]!);
			assert.equal(sent.model, "mistral-ocr-latest");
			assert.equal(sent.include_image_base64, false);
			assert.deepEqual(Object.keys(sent.document as object), ["type", "document_url"]);
			assert.equal(log[0]!.headers.authorization, `Bearer ${KEY}`);
			assert.equal(log[0]!.headers["content-type"], "application/json");
		});
	});

	it("a delimiter service with a per-job random delimiter", async () => {
		const delimiters: string[] = [];
		const service = routes({
			"POST /api/convert": (_q, r, body) => {
				const sent = JSON.parse(body) as { page_separator: string; file: { data: string } };
				delimiters.push(sent.page_separator);
				assert.equal(sent.file.data, Buffer.from(pdf).toString("base64"));
				json(r, { markdown: ["Alpha text", "Beta text"].join(`\n${sent.page_separator}\n`) });
			},
		});
		await withServer(service, async (baseUrl) => {
			const converter = make(baseUrl, delimitedProfile());
			assert.deepEqual(texts((await converter.convert(input, context())).pages), ["Alpha text", "Beta text"]);
			await converter.convert(input, context());
		});
		assert.match(delimiters[0]!, /^<!-- learnharness-page-[0-9a-f-]{36} -->$/);
		assert.notEqual(delimiters[0], delimiters[1], "a new delimiter per job");
	});

	it("a literal delimiter written after every page", async () => {
		const profile = delimitedProfile({ submit: { method: "POST", path: "/api/convert", body: { type: "multipart", fileField: "f" } }, extract: { type: "delimited", markdownPointer: "/markdown", delimiter: { literal: "\f" }, placement: "after" } });
		await withServer(routes({ "POST /api/convert": (_q, r) => json(r, { markdown: "One\fTwo\f" }) }), async (baseUrl) => {
			assert.deepEqual(texts((await make(baseUrl, profile).convert(input, context())).pages), ["One", "Two"]);
		});
	});

	it("segment-count mismatch is bad_response saying the service did not mark every page", async () => {
		await withServer(routes({ "POST /api/convert": (_q, r) => json(r, { markdown: "All the text, no page breaks" }) }), async (baseUrl) => {
			await rejectsWith(make(baseUrl, delimitedProfile()).convert(input, context()), "bad_response", /did not mark every page: its answer has 1 page segment for the PDF's 2 pages/);
		});
	});

	it("a missing page list or page number is bad_response", async () => {
		await withServer(routes({ "POST /convert": (_q, r) => json(r, { result: { pages: [{ text: "x" }] } }) }), async (baseUrl) => {
			await rejectsWith(make(baseUrl, pageArrayProfile()).convert(input, context()), "bad_response", /no page number at \/n/);
		});
		await withServer(routes({ "POST /convert": (_q, r) => json(r, { other: true }) }), async (baseUrl) => {
			await rejectsWith(make(baseUrl, pageArrayProfile()).convert(input, context()), "bad_response", /no page list at \/result\/pages/);
		});
	});
});

describe("declarative HTTP converter: polling", () => {
	function pollingService(states: string[], final: unknown = { pages: [{ page: 1, markdown: "P1" }, { page: 2, markdown: "P2" }] }) {
		let polls = 0;
		return routes({
			"POST /jobs": (_q, r) => json(r, { id: "job 7/x" }),
			"GET /jobs/job%207%2Fx": (_q, r) => json(r, { status: states[Math.min(polls++, states.length - 1)], error: "Engine exploded" }),
			"GET /jobs/job%207%2Fx/result": (_q, r) => json(r, final),
		});
	}

	it("polls with the job id (URL-encoded) until done, then makes the separate result request", async () => {
		await withServer(pollingService(["queued", "running", "done"]), async (baseUrl, log) => {
			const result = await make(baseUrl, pollingProfile()).convert(input, context());
			assert.deepEqual(texts(result.pages), ["P1", "P2"]);
			assert.deepEqual(log.map((r) => `${r.method} ${r.url}`), ["POST /jobs", "GET /jobs/job%207%2Fx", "GET /jobs/job%207%2Fx", "GET /jobs/job%207%2Fx", "GET /jobs/job%207%2Fx/result"]);
			for (const request of log) assert.equal(request.headers["x-api-key"], KEY);
		});
	});

	it("without a result request the done answer itself is extracted", async () => {
		const profile = pollingProfile({ result: undefined });
		delete profile.result;
		const service = routes({
			"POST /jobs": (_q, r) => json(r, { id: 42 }),
			"GET /jobs/42": (_q, r) => json(r, { status: "done", pages: [{ page: 1, markdown: "A" }, { page: 2, markdown: "B" }] }),
		});
		await withServer(service, async (baseUrl) => {
			assert.deepEqual(texts((await make(baseUrl, profile).convert(input, context())).pages), ["A", "B"]);
		});
	});

	it("a job that fails surfaces the service's message, with no result request", async () => {
		await withServer(pollingService(["running", "failed"]), async (baseUrl, log) => {
			await rejectsWith(make(baseUrl, pollingProfile()).convert(input, context()), "conversion_failed", /Polling Service could not convert the PDF: Engine exploded/);
			assert.equal(count(log, "/jobs/job%207%2Fx/result"), 0);
			assert.equal(count(log, "/jobs"), 1);
		});
	});

	it("an unknown status is bad_response; a missing job id is bad_response", async () => {
		await withServer(pollingService(["melting"]), async (baseUrl) => {
			await rejectsWith(make(baseUrl, pollingProfile()).convert(input, context()), "bad_response", /unknown job status "melting"/);
		});
		await withServer(routes({ "POST /jobs": (_q, r) => json(r, {}) }), async (baseUrl, log) => {
			await rejectsWith(make(baseUrl, pollingProfile()).convert(input, context()), "bad_response", /did not return a job id at \/id/);
			assert.equal(log.length, 1);
		});
	});

	it("a job id that would leave the base path is refused before the poll is sent", async () => {
		await withServer(routes({ "POST /jobs": (_q, r) => json(r, { id: ".." }) }), async (baseUrl, log) => {
			await rejectsWith(make(baseUrl, pollingProfile()).convert(input, context()), "bad_response", /job id/);
			assert.equal(log.length, 1);
		});
	});

	it("polling is bounded by count and by the job deadline", { timeout: 20_000 }, async () => {
		await withServer(pollingService(["running"]), async (baseUrl, log) => {
			const profile = pollingProfile();
			profile.poll!.maxPolls = 3;
			await rejectsWith(make(baseUrl, profile).convert(input, context()), "timeout", /did not finish after 3 status checks/);
			assert.equal(count(log, "/jobs/job%207%2Fx"), 3);
		});
		await withServer(pollingService(["running"]), async (baseUrl) => {
			await rejectsWith(make(baseUrl, pollingProfile(), { jobDeadlineMs: 300, pollIntervalMs: 20 }).convert(input, context()), "timeout", /job deadline/);
		});
	});

	it("an abort during polling stops without a second upload", async () => {
		const controller = new AbortController();
		const service = routes({
			"POST /jobs": (_q, r) => json(r, { id: "j" }),
			"GET /jobs/j": (_q, r) => {
				controller.abort();
				json(r, { status: "running" });
			},
		});
		await withServer(service, async (baseUrl, log) => {
			await rejectsWith(make(baseUrl, pollingProfile()).convert(input, context(controller.signal)), "aborted");
			assert.equal(count(log, "/jobs"), 1);
		});
	});
});

describe("declarative HTTP converter: request discipline and origin", () => {
	it("a redirect is refused as bad_response and never followed", async () => {
		await withServer((_req, res) => { res.statusCode = 302; res.setHeader("location", "https://elsewhere.example/steal"); res.end(); }, async (baseUrl, log) => {
			await rejectsWith(make(baseUrl, pageArrayProfile()).convert(input, context()), "bad_response", /redirect \(HTTP 302 to https:\/\/elsewhere\.example\/steal\)/);
			assert.equal(log.length, 1);
		});
	});

	it("an oversized response is refused, declared or streamed", async () => {
		const big = "x".repeat(10_000);
		await withServer((_q, res) => { res.setHeader("content-type", "application/json"); res.write(`{"pad":"${big}`); res.end(`${big}"}`); }, async (baseUrl) => {
			await rejectsWith(make(baseUrl, pageArrayProfile(), { maxResponseBytes: 5_000 }).convert(input, context()), "bad_response", /larger than/);
		});
		await withServer((_q, res) => { res.setHeader("content-length", "1000000"); res.write("{"); }, async (baseUrl) => {
			await rejectsWith(make(baseUrl, pageArrayProfile(), { maxResponseBytes: 5_000 }).convert(input, context()), "bad_response", /larger than/);
		});
	});

	it("a hanging upload times out without being sent again", { timeout: 20_000 }, async () => {
		await withServer(() => {}, async (baseUrl, log) => {
			await rejectsWith(make(baseUrl, pageArrayProfile(), { uploadTimeoutMs: 300 }).convert(input, context()), "timeout", /did not answer within/);
			await new Promise((resolve) => setTimeout(resolve, 300));
			assert.equal(log.length, 1);
		});
	});

	it("HTTP failures map to the same kinds as Docling's, with no resubmission", async () => {
		const cases: [number, ConverterError["kind"]][] = [[401, "auth"], [429, "rate_limit"], [413, "too_large"], [503, "unreachable"], [400, "bad_response"]];
		for (const [status, kind] of cases) {
			await withServer((_q, r) => json(r, { message: "nope" }, status), async (baseUrl, log) => {
				await rejectsWith(make(baseUrl, pageArrayProfile()).convert(input, context()), kind, new RegExp(`Pages Service .*HTTP ${status}.*nope`));
				assert.equal(log.length, 1);
			});
		}
	});

	it("an unreachable or timed-out service falls back to pdfjs through the registry, named by its profile", async () => {
		const baseUrl = await closedBaseUrl();
		const result = await convertWithFallback({ converter: make(baseUrl, pageArrayProfile()), requestedId: "custom:test", warnings: [] }, input, context());
		assert.equal(result.converterId, "pdfjs");
		assert.equal(result.fallbackFrom?.label, "Pages Service");
		assert.match(result.warnings?.[0] ?? "", /^Pages Service failed \(Could not reach Pages Service at http:\/\/127\.0\.0\.1:\d+: .+\); the built-in reader \(pdfjs\) was used instead\.$/);
	});

	it("a profile whose URL leaves the base origin is refused before any request", async () => {
		await withServer(routes({}), async (baseUrl, log) => {
			const escaping = pageArrayProfile();
			escaping.submit.path = `//127.0.0.1:1/steal`;
			assert.throws(() => make(baseUrl, escaping), (e: unknown) => e instanceof ConverterError && e.kind === "not_configured" && /not valid/.test(e.message));
			const dotted = pollingProfile();
			dotted.poll!.path = "/jobs/../../{{JOB_ID}}";
			assert.throws(() => make(`${baseUrl}/api`, dotted), (e: unknown) => e instanceof ConverterError && e.kind === "not_configured");
			assert.equal(log.length, 0);
		});
	});

	it("limits from the profile refuse a PDF before any request", async () => {
		await withServer(routes({}), async (baseUrl, log) => {
			await rejectsWith(make(baseUrl, pageArrayProfile(1, { limits: { maxPages: 1 } })).convert(input, context()), "too_many_pages");
			await rejectsWith(make(baseUrl, pageArrayProfile(1, { limits: { maxBytes: 100 } })).convert(input, context()), "too_large");
			assert.equal(log.length, 0);
		});
	});

	it("a profile that needs a key and has none is not configured (the registry falls back with a warning)", () => {
		assert.throws(() => createHttpConverter({ converterId: "x", profile: pageArrayProfile(), baseUrl: "http://127.0.0.1:1" }), /needs an API key for http:\/\/127\.0\.0\.1:1/);
	});
});

describe("declarative HTTP converter: the key never leaks", () => {
	it("a service that echoes the key in an error: the message has it removed", async () => {
		await withServer((_q, r) => json(r, { message: `invalid key ${KEY}` }, 401), async (baseUrl) => {
			const error = await rejectsWith(make(baseUrl, pageArrayProfile()).convert(input, context()), "auth");
			assert.equal(error.message.includes(KEY), false);
			assert.match(error.message, /\[redacted\]/);
		});
	});

	it("a service that echoes the key in its text: removed from the pages, reported as a warning", async () => {
		await withServer(routes({ "POST /convert": (_q, r) => json(r, pagesAnswer([`key=${KEY}`, "fine"])) }), async (baseUrl) => {
			const result = await make(baseUrl, pageArrayProfile()).convert(input, context());
			assert.equal(JSON.stringify(result).includes(KEY), false);
			assert.deepEqual(result.warnings, [SECRET_REDACTED_WARNING]);
		});
	});
});
