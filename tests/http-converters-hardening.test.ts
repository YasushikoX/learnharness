import assert from "node:assert/strict";
import type http from "node:http";
import { describe, it } from "node:test";
import { HTTP_CONVERTER_PROFILE_FORMAT, HTTP_CONVERTER_PROFILE_MAX_DEPTH, parseHttpConverterProfile, sameServiceUrl, validateHttpConverterProfile, type HttpConverterProfile } from "../src/core/http-converter-spec.ts";
import { ConverterError, type ConvertInput, type PageResult } from "../src/core/pdf-converter.ts";
import { createDoclingConverter } from "../src/server/converters/docling.ts";
import { REDACTED, SECRET_REDACTED_WARNING, causeText, errorDetail, redactError, redactSecrets, storedKeyProblem } from "../src/server/converters/http-common.ts";
import { createHttpConverter, type HttpConverterOptions } from "../src/server/converters/http-declarative.ts";
import { MISTRAL_OCR_PRESET } from "../src/server/converters/presets.ts";
import { BLANK_PAGE_SENTENCES, VALIDATION_SENTENCES, blankPageTestPdf, validationPdf } from "../src/server/converters/validation-fixture.ts";
import { VALIDATION_MAX_ANSWER_CHARS, validateConverter, type ConverterValidationReport } from "../src/server/converters/validator.ts";
import { fakeDocling, formFields, withServer, type LoggedRequest } from "./helpers/docling-server.ts";
import { KEY, delimitedProfile, json, pageArrayProfile, pagesAnswer, pollingProfile, routes } from "./helpers/converter-services.ts";

/**
 * Review 1 of the declarative HTTP converters (council/reviews/wp3a2-review-1.md), one regression test per finding:
 * the key never leaves a converter or the converter test (finding 1, 9), strict page placement and bounded work on a
 * hostile reply (findings 4, 6), headers and keys fetch would refuse (finding 7), deep or huge profiles (finding 3),
 * canonical URLs (finding 8), redirects of every kind, the blank-page fixture and the converter test's deadline.
 * Loopback servers only.
 */

const pdf = validationPdf();
const input = (pageCount = 2): ConvertInput => ({ bytes: pdf, filename: "doc.pdf", pageCount });
const context = (signal = new AbortController().signal) => ({ signal, onProgress: () => {} });
const make = (baseUrl: string, profile: unknown, extra: Partial<HttpConverterOptions> = {}) =>
	createHttpConverter({ converterId: "custom:test", profile, baseUrl, apiKey: KEY, pollIntervalMs: 1, ...extra });
const texts = (pages: PageResult[]) => pages.map((p) => (p.status === "ok" ? p.markdown : p.status));
const status = (report: ConverterValidationReport) => Object.fromEntries(report.checks.map((c) => [c.id, c.status]));
const signal = () => new AbortController().signal;

async function rejectsWith(promise: Promise<unknown>, kind: ConverterError["kind"], message?: RegExp): Promise<ConverterError> {
	let caught: unknown;
	await promise.then(() => assert.fail(`expected a ${kind} ConverterError`), (error: unknown) => { caught = error; });
	assert.ok(caught instanceof ConverterError, `not a ConverterError: ${String(caught)}`);
	assert.equal(caught.kind, kind, caught.message);
	if (message) assert.match(caught.message, message);
	return caught;
}

/** A delimited profile with a fixed delimiter and the given placement (multipart upload). */
const literal = (delimiter: string, placement: "between" | "after" | "before") =>
	delimitedProfile({ submit: { method: "POST", path: "/api/convert", body: { type: "multipart", fileField: "f" } }, extract: { type: "delimited", markdownPointer: "/markdown", delimiter: { literal: delimiter }, placement } });

/** The sentences in an uploaded test PDF ("" for a blank page), from a multipart or base64 upload. */
function sentencesIn(pdfText: string): string[] {
	return [...pdfText.matchAll(/stream\n(.*?)\nendstream/gs)].map((m) => /\((.*)\) Tj/.exec(m[1]!)?.[1] ?? "");
}

// ── Finding 1 and 9: the key never leaves ─────────────────────────────────

describe("finding 1: the key never leaves a converter or the converter test", () => {
	const DOCLING_KEY = "dk-live-4f9c2a7e1b0d";

	/** A Docling whose every answer carries the key it was sent: /version, page text, a page error. */
	function echoingDocling(): ReturnType<typeof fakeDocling> {
		return fakeDocling(
			() => ({
				status: "partial_success",
				errors: [{ page_no: 2, error_message: `page failed for key ${DOCLING_KEY}` }],
				document: {
					md_content: `${VALIDATION_SENTENCES[0]} ${DOCLING_KEY}`,
					json_content: { pages: { 1: {}, 2: {} }, body: { children: [{ $ref: "#/texts/0" }] }, texts: [{ prov: [{ page_no: 1 }] }] },
				},
			}),
			{ version: (q, r) => json(r, { docling: `2.0-${String(q.headers["x-api-key"])}`, "docling-serve": "1.38.2" }) },
		);
	}

	it("Docling: a key echoed in /version, page text and a page error is removed everywhere, and the Test report never carries it", async () => {
		await withServer(echoingDocling().handler, async (baseUrl) => {
			const docling = createDoclingConverter({ baseUrl, apiKey: DOCLING_KEY, minPollIntervalMs: 1, pollWaitSeconds: 0 });
			assert.equal((await docling.serverVersion!(signal())).includes(DOCLING_KEY), false, "serverVersion (the sidecar's cache key) is redacted");
			const result = await docling.convert(input(), context());
			const text = JSON.stringify(result);
			assert.equal(text.includes(DOCLING_KEY), false, text);
			assert.match(result.converterVersion, /\[redacted\]/);
			assert.equal(result.pages[1]!.status, "unreadable");
			assert.match(result.pages[1]!.status === "unreadable" ? result.pages[1]!.reason ?? "" : "", /\[redacted\]/);
			assert.ok(result.warnings?.includes(SECRET_REDACTED_WARNING));

			const report = await validateConverter(docling, { signal: signal(), secrets: [DOCLING_KEY] });
			assert.equal(JSON.stringify(report).includes(DOCLING_KEY), false, "the report sent to Settings has no key, version included");
			assert.equal(status(report).no_secret, "fail");
		});
	});

	it("Docling: a key echoed in a 401's detail is removed from the error", async () => {
		await withServer((_q, r) => json(r, { detail: `Rejected key ${DOCLING_KEY}` }, 401), async (baseUrl) => {
			const docling = createDoclingConverter({ baseUrl, apiKey: DOCLING_KEY, minPollIntervalMs: 1, pollWaitSeconds: 0 });
			const error = await rejectsWith(docling.convert(input(), context()), "auth", /Rejected key \[redacted\]/);
			assert.equal(error.message.includes(DOCLING_KEY), false);
			const report = await validateConverter(docling, { signal: signal(), secrets: [DOCLING_KEY] });
			assert.equal(JSON.stringify(report).includes(DOCLING_KEY), false);
			assert.equal(status(report).no_secret, "fail");
		});
	});

	it("the converter test checks every secret it is given, however short", async () => {
		const fake = { id: "fake", version: "1", async convert() { return { converterVersion: "v-abc", pages: [{ page: 1, status: "ok" as const, markdown: `${VALIDATION_SENTENCES[0]} abc` }, { page: 2, status: "ok" as const, markdown: VALIDATION_SENTENCES[1] }] }; } };
		const report = await validateConverter(fake, { signal: signal(), secrets: ["abc"] });
		assert.equal(status(report).no_secret, "fail");
		assert.equal(report.converterVersion, `v-${REDACTED}`);
		assert.equal(JSON.stringify(report).includes("abc"), false);
	});

	it("the key is removed in its URL-encoded and base64 forms too", async () => {
		const key = "sk/live+key=09 Z";
		assert.equal(redactSecrets(`a ${encodeURIComponent(key)} b`, [key]), `a ${REDACTED} b`);
		assert.equal(redactSecrets(`a ${Buffer.from(key).toString("base64")} b`, [key]), `a ${REDACTED} b`);
		assert.equal(redactSecrets(`a ${Buffer.from(key).toString("base64url")} b`, [key]), `a ${REDACTED} b`);
		assert.equal(redactSecrets(`a ${encodeURIComponent(key).replace(/%20/g, "+")} b`, [key]), `a ${REDACTED} b`);
		const plain = "sk-test-0123456789abcdefWXYZ";
		const echoed = `${encodeURIComponent(plain)} ${Buffer.from(plain).toString("base64")}`;
		await withServer(routes({ "POST /convert": (_q, r) => json(r, { message: echoed }, 403) }), async (baseUrl) => {
			const error = await rejectsWith(make(baseUrl, pageArrayProfile()).convert(input(), context()), "auth");
			assert.equal(error.message.includes(Buffer.from(plain).toString("base64")), false);
			assert.equal(error.message, `Pages Service refused the key (HTTP 403): ${REDACTED} ${REDACTED}`);
		});
	});

	it("finding 9: a key straddling the 300-character cut leaves no prefix behind", async () => {
		const detail = `${"x".repeat(290)}${KEY}`;
		assert.equal(errorDetail(JSON.stringify({ message: detail }), [KEY]), `${"x".repeat(290)}${REDACTED}`);
		await withServer((_q, r) => json(r, { message: detail }, 400), async (baseUrl) => {
			const error = await rejectsWith(make(baseUrl, pageArrayProfile()).convert(input(), context()), "bad_response");
			assert.equal(error.message.includes(KEY.slice(0, 8)), false, error.message);
		});
		const polling = pollingProfile();
		await withServer(routes({ "POST /jobs": (_q, r) => json(r, { id: "j" }), "GET /jobs/j": (_q, r) => json(r, { status: "failed", error: detail }) }), async (baseUrl) => {
			const error = await rejectsWith(make(baseUrl, polling).convert(input(), context()), "conversion_failed");
			assert.equal(error.message.includes(KEY.slice(0, 8)), false, error.message);
		});
	});
});

// ── Findings 4 and 6: pages never shift, hostile replies stay cheap ──────

describe("finding 4: delimited pages follow the declared placement strictly", () => {
	const reply = (markdown: string) => routes({ "POST /api/convert": (_q, r) => json(r, { markdown }) });
	const D = "<<PAGE>>";

	it("after: a missing trailing break with a leading one is refused, not shifted", async () => {
		await withServer(reply(`${D}Page 1${D}Page 2`), async (baseUrl) => {
			await rejectsWith(make(baseUrl, literal(D, "after")).convert(input(3), context()), "bad_response", /did not mark every page/);
		});
	});

	it("before: a missing leading break with a trailing one is refused, not shifted", async () => {
		await withServer(reply(`Page 2${D}Page 3${D}`), async (baseUrl) => {
			await rejectsWith(make(baseUrl, literal(D, "before")).convert(input(3), context()), "bad_response", /did not mark every page/);
		});
	});

	it("after, one page: a service that ignores the delimiter is refused", async () => {
		await withServer(reply("All of it"), async (baseUrl) => {
			await rejectsWith(make(baseUrl, literal(D, "after")).convert(input(1), context()), "bad_response", /did not mark every page/);
		});
	});

	it("after and before, correctly marked, place every page (a blank one included)", async () => {
		await withServer(reply(`P1${D}${D}P3${D}`), async (baseUrl) => {
			assert.deepEqual(texts((await make(baseUrl, literal(D, "after")).convert(input(3), context())).pages), ["P1", "empty", "P3"]);
		});
		await withServer(reply(`${D}P1${D}P2${D}P3`), async (baseUrl) => {
			assert.deepEqual(texts((await make(baseUrl, literal(D, "before")).convert(input(3), context())).pages), ["P1", "P2", "P3"]);
		});
		await withServer(reply(`P1${D}P2${D}P3${D}`), async (baseUrl) => {
			await rejectsWith(make(baseUrl, literal(D, "before")).convert(input(3), context()), "bad_response", /does not start with a page break/);
		});
	});

	it("a service that ignores the per-job random delimiter is refused", async () => {
		await withServer(routes({ "POST /api/convert": (_q, r) => json(r, { markdown: "Page one\n\n---\n\nPage two" }) }), async (baseUrl) => {
			await rejectsWith(make(baseUrl, delimitedProfile()).convert(input(2), context()), "bad_response", /did not mark every page: its answer has 1 page segment/);
		});
		const after = delimitedProfile({ extract: { type: "delimited", markdownPointer: "/markdown", delimiter: { random: true }, placement: "after" } });
		await withServer(routes({ "POST /api/convert": (_q, r) => json(r, { markdown: "Only page" }) }), async (baseUrl) => {
			await rejectsWith(make(baseUrl, after).convert(input(1), context()), "bad_response", /did not mark every page/);
		});
	});
});

describe("finding 6: a hostile reply is refused before work proportional to it", () => {
	it("a page array longer than the PDF is refused before any page is mapped", async () => {
		const many = { result: { pages: Array.from({ length: 50_000 }, (_, i) => ({ n: i + 1, text: "a" })) } };
		await withServer(routes({ "POST /convert": (_q, r) => json(r, many) }), async (baseUrl) => {
			await rejectsWith(make(baseUrl, pageArrayProfile()).convert(input(2), context()), "bad_response", /lists 50000 pages for the PDF's 2 pages/);
		});
	});

	it("a Markdown string full of delimiters is split with a limit", async () => {
		await withServer(routes({ "POST /api/convert": (_q, r) => json(r, { markdown: "a".repeat(500_000) }) }), async (baseUrl) => {
			await rejectsWith(make(baseUrl, literal("a", "between")).convert(input(2), context()), "bad_response", /has more than 4 page segments for the PDF's 2 pages/);
		});
	});
});

// ── Finding 7: headers and keys ────────────────────────────────────────────

describe("finding 7: header names, header values and keys", () => {
	const errorsOf = (profile: unknown) => {
		const checked = validateHttpConverterProfile(profile);
		assert.equal(checked.ok, false, "expected the profile to be refused");
		return checked.ok ? "" : checked.errors.join("\n");
	};

	it("prototype names, credential headers and values fetch would refuse are refused in a profile", () => {
		for (const header of ["__proto__", "constructor", "prototype"]) {
			assert.match(errorsOf(pageArrayProfile(1, { auth: { header, value: "{{API_KEY}}" } })), /set by the app/, header);
		}
		for (const header of ["Authorization", "Cookie", "Proxy-Authorization"]) {
			const profile = pageArrayProfile();
			profile.submit.headers = { [header]: "Bearer fixed" };
			assert.match(errorsOf(profile), new RegExp(`${header}`), header);
		}
		const control = pageArrayProfile();
		control.submit.headers = { "X-Client": "a\u0001b" };
		assert.match(errorsOf(control), /control character/);
		const wide = pageArrayProfile();
		wide.submit.headers = { "X-Client": "ключ" };
		assert.match(errorsOf(wide), /Latin-1/);
		assert.match(errorsOf(pageArrayProfile(1, { auth: { header: "X-Api-Key", value: "{{API_KEY}}\u007f" } })), /control character/);
	});

	it("a stored key fetch would refuse is an auth error before anything is sent, never 'unreachable' (so no quiet fallback)", async () => {
		for (const badKey of ["sk-live-1234\u0001abcd", "sk-live-1234\u007fabcd", "sk-ключ-123456789"]) {
			await withServer(routes({ "POST /convert": (_q, r) => json(r, pagesAnswer(["a", "b"])) }), async (baseUrl, log) => {
				const error = await rejectsWith(make(baseUrl, pageArrayProfile(), { apiKey: badKey }).convert(input(), context()), "auth", /stored Pages Service key contains .*enter the key again/);
				assert.equal(error.message.includes(badKey), false);
				assert.equal(log.length, 0);
			});
			await withServer(fakeDocling({}).handler, async (baseUrl, log) => {
				await rejectsWith(createDoclingConverter({ baseUrl, apiKey: badKey }).convert(input(), context()), "auth", /stored Docling key/);
				assert.equal(log.length, 0);
			});
		}
	});

	it("headers are built with Headers: a profile header named like an object property still goes out", async () => {
		const profile = pageArrayProfile();
		profile.submit.headers = { "X-Has-Own-Property": "hasOwnProperty", "X-Value-Of": "valueOf" };
		await withServer(routes({ "POST /convert": (_q, r) => json(r, pagesAnswer(["a", "b"])) }), async (baseUrl, log) => {
			await make(baseUrl, profile).convert(input(), context());
			assert.equal(log[0]!.headers["x-has-own-property"], "hasOwnProperty");
			assert.equal(log[0]!.headers["x-api-key"], KEY);
		});
	});
});

// ── Findings 3, 5 and 8: profile size, depth and canonical URLs ───────────

describe("finding 3: deep and huge profiles are refused without a crash", () => {
	function nested(depth: number): Record<string, unknown> {
		let node: Record<string, unknown> = {};
		const root = node;
		for (let i = 0; i < depth; i++) {
			const child: Record<string, unknown> = {};
			node.a = child;
			node = child;
		}
		return root;
	}

	it("JSON nested 8,000 deep in submit.body.json is refused with a reason (text and parsed)", () => {
		const profile = delimitedProfile();
		(profile.submit.body as { json: unknown }).json = nested(8_000);
		const text = JSON.stringify(profile);
		assert.ok(text.length < 64 * 1024);
		const fromText = parseHttpConverterProfile(text);
		assert.deepEqual(fromText, { ok: false, errors: [`A profile is nested at most ${HTTP_CONVERTER_PROFILE_MAX_DEPTH} levels deep`] });
		assert.equal(validateHttpConverterProfile(JSON.parse(text)).ok, false);
		const shallow = delimitedProfile();
		(shallow.submit.body as { json: unknown }).json = { page_separator: "{{DELIMITER}}", deep: nested(20) };
		assert.equal(validateHttpConverterProfile(shallow).ok, true, "ordinary nesting is fine");
	});

	it("more than 2,000 values is refused before it is walked", () => {
		const profile = pageArrayProfile();
		profile.submit.body = { type: "multipart", fileField: "f", fields: { many: Array.from({ length: 50 }, () => "x") } };
		const wide = { ...profile, extra: Array.from({ length: 3_000 }, (_, i) => i) };
		assert.deepEqual(validateHttpConverterProfile(wide), { ok: false, errors: ["A profile holds at most 2000 values"] });
	});

	it("finding 5: the 64 KB cap is enforced on the canonical form of a parsed profile", () => {
		const profile = delimitedProfile();
		(profile.submit.body as { json: unknown }).json = { page_separator: "{{DELIMITER}}", pad: Array.from({ length: 600 }, () => "y".repeat(200)) };
		assert.deepEqual(validateHttpConverterProfile(profile), { ok: false, errors: ["A profile is at most 64 KB"] });
	});
});

describe("finding 2 and 8: only a bundled preset names its address, and it is canonical", () => {
	it("defaultBaseUrl is refused in any profile that is not bundled", () => {
		const custom = { ...pageArrayProfile(), defaultBaseUrl: "http://127.0.0.1:3000" };
		const checked = validateHttpConverterProfile(custom);
		assert.equal(checked.ok, false);
		assert.match(checked.ok ? "" : checked.errors[0]!, /cannot name its service address; remove defaultBaseUrl and enter the address in Settings → PDF conversion/);
		assert.equal(parseHttpConverterProfile(JSON.stringify(MISTRAL_OCR_PRESET)).ok, false, "even the preset's text, imported, is refused");
		assert.equal(validateHttpConverterProfile(MISTRAL_OCR_PRESET, { bundled: true }).ok, true);
		assert.throws(() => createHttpConverter({ converterId: "custom:x", profile: custom, baseUrl: "http://127.0.0.1:1", apiKey: KEY }), /not valid/);
	});

	it("a bundled preset's address must be canonical; URLs compare canonically", () => {
		const preset: HttpConverterProfile = { ...MISTRAL_OCR_PRESET, defaultBaseUrl: "https://API.MISTRAL.AI/" };
		assert.equal(validateHttpConverterProfile(preset, { bundled: true }).ok, false);
		assert.equal(sameServiceUrl("https://API.EXAMPLE.COM/", "https://api.example.com"), true);
		assert.equal(sameServiceUrl("https://api.example.com/v1/", "https://api.example.com/v1"), true);
		assert.equal(sameServiceUrl("https://api.example.com", "https://api.example.com:8443"), false);
		assert.equal(sameServiceUrl(undefined, ""), true);
	});
});

// ── Redirects of every kind ────────────────────────────────────────────────

describe("redirects are refused on submit, poll and result, whatever their status", () => {
	for (const code of [301, 302, 303, 307, 308]) {
		it(`HTTP ${code}`, async () => {
			await withServer(routes({}), async (elsewhere, elsewhereLog) => {
				const redirect = (res: http.ServerResponse) => {
					res.statusCode = code;
					res.setHeader("location", `${elsewhere}/steal`);
					res.end();
				};
				const stages: [string, Record<string, (q: http.IncomingMessage, r: http.ServerResponse) => void>][] = [
					["submit", { "POST /jobs": (_q, r) => redirect(r) }],
					["poll", { "POST /jobs": (_q, r) => json(r, { id: "j" }), "GET /jobs/j": (_q, r) => redirect(r) }],
					["result", { "POST /jobs": (_q, r) => json(r, { id: "j" }), "GET /jobs/j": (_q, r) => json(r, { status: "done" }), "GET /jobs/j/result": (_q, r) => redirect(r) }],
				];
				for (const [stage, table] of stages) {
					await withServer(routes(table), async (baseUrl, log: LoggedRequest[]) => {
						await rejectsWith(make(baseUrl, pollingProfile()).convert(input(), context()), "bad_response", new RegExp(`redirect \\(HTTP ${code} to `));
						assert.equal(log.filter((r) => r.method === "POST").length, 1, `${stage}: the upload is sent once`);
					});
				}
				assert.equal(elsewhereLog.length, 0, "no request ever reaches the redirect target");
			});
		});
	}
});

// ── The blank-page fixture and the converter test's deadline ──────────────

describe("the converter test: the three-page PDF with a blank middle page", () => {
	it("is built the same every time, equals the committed copy, and has three pages with page 2 blank", async () => {
		const fs = await import("node:fs");
		const path = await import("node:path");
		const { probePdfInput } = await import("../src/server/material-conversion.ts");
		const built = blankPageTestPdf();
		assert.deepEqual(blankPageTestPdf(), built);
		assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "converters", "validation-blank-middle.pdf"))), built);
		assert.equal((await probePdfInput(built, "x.pdf", signal())).pageCount, 3);
		assert.deepEqual(sentencesIn(Buffer.from(built).toString("latin1")), [BLANK_PAGE_SENTENCES[0], "", BLANK_PAGE_SENTENCES[2]]);
	});

	it("a delimited service that drops blank pages fails Test with a reason that says it cannot place a blank page", async () => {
		const service = routes({
			"POST /api/convert": (_q, r, body) => {
				const sent = JSON.parse(body) as { page_separator: string; file: { data: string } };
				const pages = sentencesIn(Buffer.from(sent.file.data, "base64").toString("latin1")).filter(Boolean); // blank pages vanish
				json(r, { markdown: pages.join(sent.page_separator) });
			},
		});
		await withServer(service, async (baseUrl) => {
			const report = await validateConverter(make(baseUrl, delimitedProfile()), { signal: signal(), secrets: [KEY] });
			assert.equal(report.ok, false);
			assert.deepEqual(status(report), { converted: "pass", markers: "pass", page_1: "pass", page_2: "pass", own_pages: "pass", blank_page: "fail", no_secret: "pass" });
			assert.match(report.checks.find((c) => c.id === "blank_page")!.message, /did not mark every page.*cannot place a blank page/);
		});
	});

	it("a page-array service that puts page 3's text on page 2 fails, saying so", async () => {
		const service = routes({
			"POST /convert": (_q, r, body) => {
				const pages = sentencesIn(body).filter(Boolean);
				json(r, pagesAnswer(pages.length === 2 && pages[0] === BLANK_PAGE_SENTENCES[0] ? [pages[0], pages[1]!, ""] : pages));
			},
		});
		await withServer(service, async (baseUrl) => {
			const report = await validateConverter(make(baseUrl, pageArrayProfile()), { signal: signal(), secrets: [KEY] });
			assert.equal(status(report).blank_page, "fail");
			assert.match(report.checks.find((c) => c.id === "blank_page")!.message, /page 3's sentence is on the blank page 2/);
		});
	});

	it("the native Docling client places the blank page (loopback imitation of Docling's structured output)", async () => {
		let upload = "";
		const docling = fakeDocling(
			(delimiter) => {
				const sentences = sentencesIn(upload);
				const withText = sentences.map((s, i) => ({ s, page: i + 1 })).filter((p) => p.s);
				return {
					status: "success",
					errors: [],
					document: {
						md_content: withText.map((p) => p.s).join(`\n\n${delimiter}\n\n`),
						json_content: {
							pages: Object.fromEntries(sentences.map((_, i) => [String(i + 1), { page_no: i + 1 }])),
							body: { children: withText.map((_, i) => ({ $ref: `#/texts/${i}` })) },
							texts: withText.map((p) => ({ prov: [{ page_no: p.page }] })),
						},
					},
				};
			},
			{
				upload: (_q, r, body) => {
					upload = body;
					assert.ok(formFields(body, "md_page_break_placeholder")[0]);
					json(r, { task_id: "task 1", task_type: "convert", task_status: "pending" });
				},
			},
		);
		await withServer(docling.handler, async (baseUrl) => {
			const report = await validateConverter(createDoclingConverter({ baseUrl, apiKey: "docling-key-123456", minPollIntervalMs: 1, pollWaitSeconds: 0 }), { signal: signal(), secrets: ["docling-key-123456"] });
			assert.equal(report.ok, true, JSON.stringify(report.checks));
			assert.equal(status(report).blank_page, "pass");
		});
	});

	it("the whole test has its own deadline, whatever the conversion deadlines are", { timeout: 20_000 }, async () => {
		await withServer(() => {}, async (baseUrl, log) => {
			const started = Date.now();
			const report = await validateConverter(make(baseUrl, pageArrayProfile()), { signal: signal(), secrets: [KEY], deadlineMs: 300 });
			assert.ok(Date.now() - started < 5_000);
			assert.equal(report.ok, false);
			assert.equal(report.error?.kind, "timeout");
			assert.match(report.checks[0]!.message, /did not finish within/);
			assert.equal(status(report).blank_page, "skipped", "a second PDF is not sent after the first failed");
			assert.equal(log.length, 1);
		});
	});
});

// ── Re-check 2 (council/reviews/wp3a2-review-2.md) ──────────────────────────

describe("re-check 2: what the fixes left open", () => {
	it("finding 1: a test answer far larger than the test PDF is refused before it is copied or compared", async () => {
		const big = "a ".repeat(VALIDATION_MAX_ANSWER_CHARS); // twice the cap, in two-character words
		const fake = { id: "fake", version: "1", async convert() { return { converterVersion: "v", pages: [{ page: 1, status: "ok" as const, markdown: `${VALIDATION_SENTENCES[0]} ${big}` }, { page: 2, status: "ok" as const, markdown: VALIDATION_SENTENCES[1]! }] }; } };
		const before = process.memoryUsage().rss;
		const report = await validateConverter(fake, { signal: signal(), secrets: [KEY] });
		assert.equal(status(report).converted, "fail");
		assert.match(report.checks[0]!.message, /characters of text for a test PDF that holds a few sentences/);
		assert.equal(report.pages.length, 0, "no preview of an answer that was not read");
		assert.ok(process.memoryUsage().rss - before < 64 * 1024 * 1024, "the oversized answer was not copied around");
		// an answer of ordinary size still passes
		const ok = { ...fake, async convert() { return { converterVersion: "v", pages: VALIDATION_SENTENCES.map((markdown, i) => ({ page: i + 1, status: "ok" as const, markdown })) }; } };
		assert.equal(status(await validateConverter(ok, { signal: signal(), secrets: [KEY] })).converted, "pass");
	});

	it("finding 1: an echoed key is still found in a large answer without serialising it", async () => {
		const fake = { id: "fake", version: "1", async convert() { return { converterVersion: "v", pages: [{ page: 1, status: "ok" as const, markdown: `${"b ".repeat(VALIDATION_MAX_ANSWER_CHARS)}${KEY}` }, { page: 2, status: "ok" as const, markdown: "x" }] }; } };
		const report = await validateConverter(fake, { signal: signal(), secrets: [KEY] });
		assert.equal(status(report).no_secret, "fail");
		assert.equal(JSON.stringify(report).includes(KEY), false);
	});

	it("finding 2: a reply that is not JSON and holds the key leaves no key anywhere on the error, cause included", async () => {
		for (const key of ["secret1234", "sk-live-secret-99887766"]) {
			await withServer(routes({ "POST /convert": (_q, r) => { r.writeHead(200, { "content-type": "application/json" }); r.end(`${key} is invalid`); } }), async (baseUrl) => {
				const error = await rejectsWith(make(baseUrl, pageArrayProfile(), { apiKey: key }).convert(input(), context()), "bad_response", /returned invalid JSON/);
				assert.equal(causeText(error).includes(key.slice(0, 8)), false, causeText(error));
				assert.equal(error.cause, undefined);
			});
			await withServer((_q, r) => { r.writeHead(200, { "content-type": "application/json" }); r.end(`${key} is invalid`); }, async (baseUrl) => {
				const error = await createDoclingConverter({ baseUrl, apiKey: key, minPollIntervalMs: 1 }).convert(input(), context()).then(() => assert.fail("expected a failure"), (e: unknown) => e as ConverterError);
				assert.equal(causeText(error).includes(key.slice(0, 8)), false, causeText(error));
			});
		}
		// redactError drops a cause that carries the secret and keeps a harmless one
		const leaky = new ConverterError("bad_response", "bad", false, { cause: new SyntaxError(`Unexpected token 's', "${KEY} inv"... is not valid JSON`) });
		assert.equal(redactError(leaky, [KEY]).cause, undefined);
		const harmless = new ConverterError("bad_response", "bad", false, { cause: new Error("socket hang up") });
		assert.equal(redactError(harmless, [KEY]), harmless);
	});

	it("finding 6: the key is removed in lower-case percent-encoding and as escaped inside a broken JSON error body", () => {
		const key = "sk+live/key=1234";
		assert.equal(redactSecrets("a sk%2blive%2fkey%3d1234 b", [key]), `a ${REDACTED} b`);
		const quoted = 'sk-"quote"\\slash';
		const body = `{"detail":"bad key ${JSON.stringify(quoted).slice(1, -1)}`; // truncated, so it cannot be parsed
		assert.equal(errorDetail(body, [quoted]).includes("quote"), false, errorDetail(body, [quoted]));
	});

	it("finding 6: a key stored before the length rule is refused when used, with a message that says what to do", async () => {
		assert.match(storedKeyProblem("the") ?? "", /shorter than 8 characters; enter the key again/);
		assert.equal(storedKeyProblem(KEY), undefined);
		assert.equal(storedKeyProblem(""), undefined, "no key at all is a different case");
		await withServer(routes({ "POST /convert": (_q, r) => json(r, pagesAnswer(["a", "b"])) }), async (baseUrl, log) => {
			await rejectsWith(make(baseUrl, pageArrayProfile(), { apiKey: "the" }).convert(input(), context()), "auth", /shorter than 8 characters/);
			assert.equal(log.length, 0, "nothing was sent with it");
		});
	});

	it("the Docling client does not allocate a segment per delimiter in a reply full of them", async () => {
		const docling = fakeDocling((delimiter) => ({ status: "success", document: { md_content: delimiter.repeat(50_000), json_content: { pages: { 1: {}, 2: {} }, body: { children: [{ $ref: "#/texts/0" }] }, texts: [{ prov: [{ page_no: 1 }] }] } } }));
		await withServer(docling.handler, async (baseUrl) => {
			// 2 pages: the split stops at 5 segments however many delimiters the reply holds
			await rejectsWith(createDoclingConverter({ baseUrl, apiKey: KEY, minPollIntervalMs: 1 }).convert(input(), context()), "bad_response", /returned 5 Markdown page segments/);
		});
	});
});
