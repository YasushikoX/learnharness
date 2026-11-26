import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

/**
 * The Google AI Studio (Gemini) PDF converter (src/server/converters/gemini.ts) against a fake fetch: the upload →
 * generateContent → delete flow, the page markers, splitting a batch (MAX_TOKENS, missing markers), refusals for one
 * page, 429 waits and the daily quota, the error kinds (auth, unreachable with the pdfjs fallback, aborted), the key
 * never leaving in a URL or a message; then its credentials (the Google provider key as a fallback, never copied),
 * the Settings API round trip and the Test button.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-gemini-converter-"));
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
process.env.LH_DATA_DIR = path.join(TMP, "data");
const savedProviderKey = process.env.GEMINI_API_KEY;
const savedIgnore = process.env.LH_IGNORE_ENV_KEYS;
delete process.env.GEMINI_API_KEY;
delete process.env.LH_IGNORE_ENV_KEYS;
after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
	if (savedProviderKey === undefined) delete process.env.GEMINI_API_KEY;
	else process.env.GEMINI_API_KEY = savedProviderKey;
	if (savedIgnore === undefined) delete process.env.LH_IGNORE_ENV_KEYS;
	else process.env.LH_IGNORE_ENV_KEYS = savedIgnore;
});

const gemini = await import("../src/server/converters/gemini.ts");
const { ConverterError } = await import("../src/core/pdf-converter.ts");
const { convertWithFallback, resolvePdfConverter } = await import("../src/server/converters/registry.ts");
const credentials = await import("../src/server/converters/credentials.ts");
const store = await import("../src/store/auth.ts");
const { readSettings, writeSettings } = await import("../src/store/settings.ts");
const { sanitizeUserSettings } = await import("../src/core/settings.ts");
const { parsePdfConversionSettingsBody } = await import("../src/server/settings-body.ts");
const { CONVERTER_CREDENTIALS } = await import("../src/core/pdf-converter.ts");
const convertersRoute = await import("../app/api/converters/route.ts");
const testRoute = await import("../app/api/converters/test/route.ts");
const { validationPdf, VALIDATION_SENTENCES } = await import("../src/server/converters/validation-fixture.ts");
type ConvertersOverview = import("../src/core/converter-settings.ts").ConvertersOverview;
type ConverterValidationReport = import("../src/core/converter-settings.ts").ConverterValidationReport;
type PageResult = import("../src/core/pdf-converter.ts").PageResult;
type PdfConverter = import("../src/core/pdf-converter.ts").PdfConverter;

/** Obviously fake keys (never token-shaped). */
const KEY = "test-gemini-key-0001";
const PROVIDER_KEY = "test-google-provider-key-0002";
const BASE = "https://gemini.test";

// ── The fake Gemini API ──────────────────────────────────────────────────────

interface Seen {
	method: string;
	url: string;
	headers: Headers;
	body?: string;
}

interface Generate {
	from: number;
	to: number;
	total: number;
	call: number;
	body: Record<string, unknown>;
}

type Reply = { status?: number; json?: unknown; headers?: Record<string, string>; text?: string } | "hang";

interface FakeOptions {
	/** The answer to generateContent; default: every asked page with its own text. */
	generate?: (g: Generate) => Reply;
	/** States the GET of the uploaded file answers, in turn (default: ACTIVE). */
	states?: string[];
	/** The state the upload answers with (default PROCESSING when `states` is given, else ACTIVE); null: omitted. */
	uploadState?: string | null;
	/** Answer the upload start with this instead. */
	start?: () => Reply;
	/**
	 * The bytes request (upload, finalize), call n: whether the file is committed, and the answer (default: the
	 * file). "hang-body": the status line and part of the body come, then the body never ends.
	 */
	finalize?: (n: number) => { commit: boolean; reply?: Reply | "hang-body" };
}

const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
const pageText = (page: number) => `Text of page ${page}.`;
/** The default answer: one marker and one line of text for each page asked. */
const markedPages = (from: number, to: number, text = pageText) => Array.from({ length: to - from + 1 }, (_, i) => `${gemini.GEMINI_PAGE_MARKER(from + i)}\n${text(from + i)}`).join("\n\n");
const answer = (text: string, finishReason = "STOP"): Reply => ({ json: { candidates: [{ content: { parts: [{ text }], role: "model" }, finishReason }] } });

function installFake(options: FakeOptions = {}) {
	const seen: Seen[] = [];
	const generates: Generate[] = [];
	const deleted: string[] = [];
	const uploads = new Map<string, Uint8Array>();
	/** The name each upload session was started with (the caller's File.name, else one Google picks). */
	const sessions = new Map<string, string>();
	let finalizeCalls = 0;
	const states = [...(options.states ?? [])];
	const original = globalThis.fetch;
	const reply = async (r: Reply, signal?: AbortSignal | null): Promise<Response> => {
		if (r === "hang") {
			return new Promise<Response>((_, reject) => {
				if (signal?.aborted) reject(signal.reason);
				signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		}
		const body = r.text ?? (r.json === undefined ? "" : JSON.stringify(r.json));
		return new Response(body, { status: r.status ?? 200, headers: { "content-type": "application/json", ...r.headers } });
	};
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const headers = new Headers(init?.headers);
		const method = init?.method ?? "GET";
		let body: string | undefined;
		let bytes: Uint8Array | undefined;
		if (typeof init?.body === "string") body = init.body;
		else if (init?.body instanceof Blob) bytes = new Uint8Array(await init.body.arrayBuffer());
		seen.push({ method, url, headers, ...(body !== undefined ? { body } : {}) });
		const u = new URL(url);
		if (init?.signal?.aborted) throw init.signal.reason;
		if (method === "POST" && u.pathname === "/upload/v1beta/files" && headers.get("x-goog-upload-command") === "start") {
			if (options.start) return reply(options.start(), init?.signal);
			const requested = (JSON.parse(body ?? "{}") as { file?: { name?: string } }).file?.name;
			const session = `session-abc123${sessions.size ? `-${sessions.size}` : ""}`;
			sessions.set(session, requested ?? `files/upload${sessions.size + 1}`);
			return reply({ json: {}, headers: { "x-goog-upload-url": `${u.origin}/upload/v1beta/files?upload_id=${session}&upload_protocol=resumable` } });
		}
		const sessionName = sessions.get(u.searchParams.get("upload_id") ?? "");
		if (method === "POST" && u.pathname === "/upload/v1beta/files" && headers.get("x-goog-upload-command") === "query" && sessionName) {
			const committed = uploads.has(sessionName);
			return reply({ headers: { "x-goog-upload-status": committed ? "final" : "active", "x-goog-upload-size-received": String(committed ? pdf.byteLength : 0) } });
		}
		if (method === "POST" && u.pathname === "/upload/v1beta/files" && headers.get("x-goog-upload-command") === "upload, finalize" && sessionName) {
			const plan = options.finalize?.(++finalizeCalls) ?? { commit: true };
			if (plan.commit) uploads.set(sessionName, bytes ?? new Uint8Array());
			if (plan.reply === "hang-body") {
				const signal = init?.signal;
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(`{"file":{"name":"${sessionName}","ur`));
						signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
					},
				});
				return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
			}
			if (plan.reply) return reply(plan.reply, init?.signal);
			const state = options.uploadState === null ? undefined : (options.uploadState ?? (options.states ? "PROCESSING" : "ACTIVE"));
			return reply({ json: { file: { name: sessionName, uri: `${u.origin}/v1beta/${sessionName}`, mimeType: "application/pdf", ...(state ? { state } : {}) } } });
		}
		const fileMatch = /^\/v1beta\/(files\/[a-z0-9-]+)$/.exec(u.pathname);
		if (fileMatch && method === "GET") {
			const state = states.shift() ?? "ACTIVE";
			return reply({ json: { name: fileMatch[1], uri: `${u.origin}/v1beta/${fileMatch[1]}`, state, ...(state === "FAILED" ? { error: { message: "the file is damaged" } } : {}) } });
		}
		if (fileMatch && method === "DELETE") {
			deleted.push(fileMatch[1]!);
			return reply({ json: {} });
		}
		if (method === "POST" && /^\/v1beta\/models\/[^/]+:generateContent$/.test(u.pathname)) {
			const parsed = JSON.parse(body ?? "{}") as Record<string, unknown>;
			const parts = ((parsed.contents as { parts: Record<string, unknown>[] }[])[0]!.parts);
			const meta = parts[0]!.documentMetadata as { startPage: number; endPage: number } | undefined;
			const prompt = String(parts[1]!.text);
			const total = Number(/has (\d+) pages/.exec(prompt)![1]);
			const from = meta?.startPage ?? Number(/(?:pages?) (\d+)/.exec(prompt.split("\n")[0]!.split("Transcribe ")[1]!)![1]);
			const to = meta?.endPage ?? from;
			const g: Generate = { from, to, total, call: generates.length + 1, body: parsed };
			generates.push(g);
			return reply(options.generate ? options.generate(g) : answer(markedPages(from, to)), init?.signal);
		}
		return reply({ status: 404, json: { error: { code: 404, message: `no route ${method} ${u.pathname}`, status: "NOT_FOUND" } } });
	}) as typeof fetch;
	return {
		seen,
		generates,
		deleted,
		uploads,
		/** The names of the committed uploads, in order. */
		committed: () => [...uploads.keys()],
		restore: () => {
			globalThis.fetch = original;
		},
	};
}

let fake: ReturnType<typeof installFake> | undefined;
afterEach(() => {
	fake?.restore();
	fake = undefined;
});
const useFake = (options?: FakeOptions) => (fake = installFake(options));

const quick = { baseUrl: BASE, processingPollMs: 1, backoffBaseMs: 1, maxRateLimitWaitMs: 1_000 };
const converter = (over: Partial<import("../src/server/converters/gemini.ts").GeminiConverterOptions> = {}) => gemini.createGeminiConverter({ apiKey: KEY, ...quick, ...over });

async function run(c: PdfConverter, pageCount: number, signal = new AbortController().signal) {
	const progress: [string, number | undefined, number | undefined][] = [];
	const result = await c.convert({ bytes: pdf, filename: "notes.pdf", pageCount }, { signal, onProgress: (stage, done, total) => progress.push([stage, done, total]) });
	return { ...result, progress };
}

async function failure(promise: Promise<unknown>): Promise<InstanceType<typeof ConverterError>> {
	try {
		await promise;
	} catch (error) {
		assert.ok(error instanceof ConverterError, `expected a ConverterError, got ${String(error)}`);
		return error;
	}
	assert.fail("expected the conversion to fail");
}

const noKeyAnywhere = (f: ReturnType<typeof installFake>) => {
	for (const s of f.seen) assert.equal(s.url.includes(KEY), false, `the key is in ${s.url}`);
};

// ── The converter ────────────────────────────────────────────────────────────

describe("Gemini converter: the flow", () => {
	it("uploads once (resumable), waits for ACTIVE, asks in batches with page selection, deletes the file", async () => {
		const f = useFake({ states: ["PROCESSING", "ACTIVE"] });
		const result = await run(converter({ batchPages: 2 }), 5);
		assert.deepEqual(result.pages, [1, 2, 3, 4, 5].map((page): PageResult => ({ page, status: "ok", markdown: pageText(page) })));
		assert.equal(result.converterVersion, `${gemini.GEMINI_CLIENT_VERSION}; ${gemini.GEMINI_DEFAULT_MODEL}`);

		const [start, bytes] = f.seen;
		assert.equal(start!.url, `${BASE}/upload/v1beta/files`);
		assert.equal(start!.headers.get("x-goog-upload-protocol"), "resumable");
		assert.equal(start!.headers.get("x-goog-upload-header-content-length"), String(pdf.byteLength));
		assert.equal(start!.headers.get("x-goog-upload-header-content-type"), "application/pdf");
		assert.match(JSON.parse(start!.body!).file.display_name, /^learnharness-[0-9a-f-]+\.pdf$/);
		// the client names the upload itself (File.name), so it can delete it even when the finalize answer is lost
		assert.match(JSON.parse(start!.body!).file.name, /^files\/lh-[0-9a-f-]{36}$/);
		assert.equal(JSON.parse(start!.body!).file.name.length - "files/".length <= 40, true);
		assert.deepEqual(f.committed(), [JSON.parse(start!.body!).file.name]);
		assert.match(bytes!.url, /upload_id=session-abc123/);
		assert.equal(bytes!.headers.get("x-goog-upload-offset"), "0");
		assert.deepEqual([...f.uploads.values()][0], pdf);
		assert.equal(f.seen.filter((s) => s.headers.get("x-goog-upload-command") === "start").length, 1, "one upload");
		assert.equal(f.seen.filter((s) => s.method === "GET").length, 2, "polled until ACTIVE");

		assert.deepEqual(f.generates.map((g) => [g.from, g.to, g.total]), [[1, 2, 5], [3, 4, 5], [5, 5, 5]]);
		const body = f.generates[0]!.body as { contents: { parts: Record<string, unknown>[] }[]; generationConfig: Record<string, unknown> };
		assert.deepEqual(body.contents[0]!.parts[0], { fileData: { mimeType: "application/pdf", fileUri: `${BASE}/v1beta/${f.committed()[0]}` }, documentMetadata: { startPage: 1, endPage: 2, contentLayers: ["PAGE_IMAGE", "PAGE_TEXT"] } });
		assert.match(String(body.contents[0]!.parts[1]!.text), /<<<PAGE 1>>>/);
		assert.deepEqual(body.generationConfig, { maxOutputTokens: gemini.GEMINI_MAX_OUTPUT_TOKENS, thinkingConfig: { thinkingLevel: "LOW" } });
		assert.match(f.seen.find((s) => s.url.includes(":generateContent"))!.url, new RegExp(`/v1beta/models/${gemini.GEMINI_DEFAULT_MODEL.replace(/\./g, "\\.")}:generateContent$`));

		for (const s of f.seen) assert.equal(s.headers.get("x-goog-api-key"), KEY);
		noKeyAnywhere(f);
		assert.deepEqual(f.deleted, f.committed());
		assert.equal(f.seen.at(-1)!.method, "DELETE");
		assert.deepEqual(result.progress.map((p) => p[0]), ["uploading", "processing", "processing", "converting", "converting", "converting", "converting", "complete"]);
		assert.deepEqual(result.progress.filter((p) => p[0] === "converting").map((p) => p[1]), [0, 2, 4, 5]);
	});

	it("a model before Gemini 3 gets no thinkingLevel and no page selection; the prompt names the pages", async () => {
		const f = useFake();
		await run(converter({ model: "models/gemini-2.5-flash", batchPages: 3 }), 3);
		const body = f.generates[0]!.body as { contents: { parts: Record<string, unknown>[] }[]; generationConfig: Record<string, unknown> };
		assert.equal(body.contents[0]!.parts[0]!.documentMetadata, undefined);
		assert.deepEqual(body.generationConfig, { maxOutputTokens: gemini.GEMINI_MAX_OUTPUT_TOKENS });
		assert.match(f.seen.find((s) => s.url.includes(":generateContent"))!.url, /models\/gemini-2\.5-flash:generateContent$/);
	});

	it("a file Google could not process is conversion_failed, and is deleted", async () => {
		const f = useFake({ states: ["FAILED"] });
		const error = await failure(run(converter(), 2));
		assert.equal(error.kind, "conversion_failed");
		assert.match(error.message, /the file is damaged/);
		assert.deepEqual(f.deleted, f.committed());
	});

	it("refuses an upload address on another host (the key would go with the bytes)", async () => {
		const f = useFake({ start: () => ({ json: {}, headers: { "x-goog-upload-url": "https://elsewhere.test/upload?upload_id=1" } }) });
		const error = await failure(run(converter(), 1));
		assert.equal(error.kind, "bad_response");
		assert.match(error.message, /another host/);
		assert.equal(f.seen.some((s) => s.url.startsWith("https://elsewhere.test")), false);
	});

	it("checks the PDF limits before anything is sent", async () => {
		const f = useFake();
		assert.equal((await failure(run(converter(), gemini.GEMINI_MAX_PAGES + 1))).kind, "too_many_pages");
		assert.equal(f.seen.length, 0);
		assert.equal(gemini.GEMINI_MAX_BYTES <= 50 * 1024 * 1024, true);
		assert.equal(gemini.GEMINI_MAX_PAGES, 1000);
	});
});

describe("Gemini converter: page markers", () => {
	it("parses one marker per page, unwraps a fence, keeps blank pages empty", () => {
		const parsed = gemini.parseGeminiPages("```markdown\n<<<PAGE 3>>>\n# Title\n\n| a | b |\n|---|---|\n<<< PAGE 4 >>>\n\n<<<PAGE 5>>>\n```", 3, 5);
		assert.deepEqual(parsed, {
			ok: true,
			pages: [
				{ page: 3, status: "ok", markdown: "# Title\n\n| a | b |\n|---|---|" },
				{ page: 4, status: "empty", reason: gemini.GEMINI_EMPTY_REASON },
				{ page: 5, status: "empty", reason: gemini.GEMINI_EMPTY_REASON },
			],
		});
	});

	it("a page whose only text is \"Empty\" or \"Blank\" keeps it; only a page with nothing after its marker is empty", () => {
		assert.deepEqual(gemini.parseGeminiPages("<<<PAGE 1>>>\nEmpty\n<<<PAGE 2>>>\n\n<<<PAGE 3>>>\n[Blank]", 1, 3), {
			ok: true,
			pages: [
				{ page: 1, status: "ok", markdown: "Empty" },
				{ page: 2, status: "empty", reason: gemini.GEMINI_EMPTY_REASON },
				{ page: 3, status: "ok", markdown: "[Blank]" },
			],
		});
	});

	it("a marker line inside a code fence is page text, with backticks or tildes, also inside a wrapped reply", () => {
		const example = (fence: string) => `Write this:\n${fence}text\n${gemini.GEMINI_PAGE_MARKER(2)}\n${fence}\nAfter the example.`;
		for (const fence of ["```", "~~~", "````"]) {
			assert.deepEqual(gemini.parseGeminiPages(`${gemini.GEMINI_PAGE_MARKER(1)}\n${example(fence)}\n${gemini.GEMINI_PAGE_MARKER(2)}\nPage two.`, 1, 2), {
				ok: true,
				pages: [
					{ page: 1, status: "ok", markdown: example(fence) },
					{ page: 2, status: "ok", markdown: "Page two." },
				],
			}, fence);
			// without the real marker, the one in the example does not stand in for it
			assert.deepEqual(gemini.parseGeminiPages(`${gemini.GEMINI_PAGE_MARKER(1)}\n${example(fence)}`, 1, 2), { ok: false, reason: "the reply stops after page 1 of 1–2" }, fence);
		}
		// a shorter or different fence does not close a fence
		assert.equal(gemini.parseGeminiPages(`${gemini.GEMINI_PAGE_MARKER(1)}\n\`\`\`\`\n~~~\n\`\`\`\n${gemini.GEMINI_PAGE_MARKER(2)}\n\`\`\`\``, 1, 2).ok, false);
		// the response-wide wrapper is removed first; the fence inside page 1 still holds its marker as text
		const wrapped = `\`\`\`markdown\n${gemini.GEMINI_PAGE_MARKER(1)}\n${example("```")}\n${gemini.GEMINI_PAGE_MARKER(2)}\nPage two.\n\`\`\``;
		assert.deepEqual(gemini.parseGeminiPages(wrapped, 1, 2), { ok: true, pages: [{ page: 1, status: "ok", markdown: example("```") }, { page: 2, status: "ok", markdown: "Page two." }] });
		// a marker indented as a code block is text too
		assert.equal(gemini.parseGeminiPages(`${gemini.GEMINI_PAGE_MARKER(1)}\n    ${gemini.GEMINI_PAGE_MARKER(2)}`, 1, 2).ok, false);
	});

	it("refuses missing, duplicated, out-of-range and shifted markers, and text before the first", () => {
		const reason = (text: string, from: number, to: number) => {
			const parsed = gemini.parseGeminiPages(text, from, to);
			assert.equal(parsed.ok, false);
			return (parsed as { reason: string }).reason;
		};
		assert.match(reason("<<<PAGE 1>>>\na", 1, 2), /stops after page 1/);
		assert.match(reason("<<<PAGE 1>>>\na\n<<<PAGE 1>>>\nb", 1, 2), /marks page 1 twice/);
		assert.match(reason("<<<PAGE 1>>>\na\n<<<PAGE 9>>>\nb", 1, 2), /outside pages 1–2/);
		assert.match(reason("<<<PAGE 1>>>\na\n<<<PAGE 3>>>\nb\n<<<PAGE 2>>>", 1, 3), /skips from page 1 to page 3/);
		assert.match(reason("Here is the transcription:\n<<<PAGE 1>>>\na", 1, 1), /text before/);
		assert.match(reason("", 1, 1), /no page markers/);
		assert.match(reason("just text", 1, 1), /text before/);
		assert.match(reason("<<<PAGE 1>>>\na\n<<<PAGE 2>>>\nb", 1, 1), /more page markers/);
	});

	it("the prompt asks for the exact marker, Markdown tables, LaTeX and figure notes, without commentary", () => {
		const prompt = gemini.geminiPrompt(4, 6, 12);
		assert.match(prompt, /12 pages/);
		assert.match(prompt, /pages 4 to 6/);
		assert.match(prompt, /<<<PAGE 4>>>/);
		assert.match(prompt, /Markdown tables/);
		assert.match(prompt, /\$…\$/);
		assert.match(prompt, /\[Figure: …\]/);
		assert.match(prompt, /no commentary/);
	});
});

describe("Gemini converter: splitting batches", () => {
	it("MAX_TOKENS splits the batch in half; a single page still cut off is empty with the reason", async () => {
		const f = useFake({ generate: (g) => (g.to > g.from + 1 || g.from === 3 ? answer(markedPages(g.from, g.to).slice(0, 20), "MAX_TOKENS") : answer(markedPages(g.from, g.to))) });
		const result = await run(converter({ batchPages: 4 }), 4);
		assert.deepEqual(f.generates.map((g) => [g.from, g.to]), [[1, 4], [1, 2], [3, 4], [3, 3], [4, 4]]);
		assert.deepEqual(result.pages.map((p) => p.status), ["ok", "ok", "empty", "ok"]);
		assert.match((result.pages[2] as { reason: string }).reason, /cut off at the output limit/);
		assert.deepEqual(result.pages.map((p) => p.page), [1, 2, 3, 4]);
	});

	it("a page whose marker is always missing is asked twice on its own, then empty; no page is shifted", async () => {
		const f = useFake({ generate: (g) => answer(markedPages(g.from, g.to).replace(`${gemini.GEMINI_PAGE_MARKER(2)}\n`, "")) });
		const result = await run(converter({ batchPages: 3 }), 3);
		assert.deepEqual(f.generates.map((g) => [g.from, g.to]), [[1, 3], [1, 1], [2, 3], [2, 2], [2, 2], [3, 3]]);
		assert.deepEqual(result.pages, [
			{ page: 1, status: "ok", markdown: pageText(1) },
			{ page: 2, status: "empty", reason: "Gemini's reply could not be placed on this page: the reply has text before its first page marker" },
			{ page: 3, status: "ok", markdown: pageText(3) },
		]);
	});

	it("SAFETY or RECITATION leaves only that page empty", async () => {
		useFake({ generate: (g) => (g.from <= 2 && g.to >= 2 ? answer("", g.from === g.to ? "RECITATION" : "SAFETY") : answer(markedPages(g.from, g.to))) });
		const result = await run(converter({ batchPages: 3 }), 3);
		assert.deepEqual(result.pages.map((p) => p.status), ["ok", "empty", "ok"]);
		assert.match((result.pages[1] as { reason: string }).reason, /declined to transcribe this page \(RECITATION\)/);
	});

	it("thought parts are not part of the transcription", async () => {
		useFake({ generate: (g) => ({ json: { candidates: [{ content: { parts: [{ text: "thinking about it", thought: true }, { text: markedPages(g.from, g.to) }] }, finishReason: "STOP" }] } }) });
		const result = await run(converter(), 1);
		assert.deepEqual(result.pages, [{ page: 1, status: "ok", markdown: pageText(1) }]);
	});
});

const quota429 = (window: "PerMinute" | "PerDay", retryDelay?: string): Reply => ({
	status: 429,
	json: {
		error: {
			code: 429,
			status: "RESOURCE_EXHAUSTED",
			message: "You exceeded your current quota.",
			details: [
				{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", quotaId: `GenerateRequests${window}PerProjectPerModel-FreeTier` }] },
				...(retryDelay ? [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay }] : []),
			],
		},
	},
});

describe("Gemini converter: rate limits", () => {
	it("a per-minute 429 waits for RetryInfo's delay (or Retry-After) and tries again", async () => {
		let n = 0;
		const f = useFake({ generate: (g) => (++n === 1 ? quota429("PerMinute", "0.05s") : n === 2 ? { status: 429, headers: { "retry-after": "0" }, json: { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "slow down" } } } : answer(markedPages(g.from, g.to))) });
		const started = Date.now();
		const result = await run(converter(), 2);
		assert.ok(Date.now() - started >= 45, "waited for the delay Google asked for");
		assert.equal(f.generates.length, 3);
		assert.deepEqual(result.pages.map((p) => p.status), ["ok", "ok"]);
	});

	it("a daily quota fails at once with rate_limit, says when it resets, and deletes the file", async () => {
		const f = useFake({ generate: () => quota429("PerDay", "30s") });
		const error = await failure(run(converter({ now: () => new Date("2026-11-25T20:00:00Z") }), 2));
		assert.equal(error.kind, "rate_limit");
		assert.equal(error.httpStatus, 429);
		assert.match(error.message, /daily free-tier quota/);
		assert.match(error.message, /midnight Pacific time, in about 12 hours/);
		assert.equal(f.generates.length, 1, "no retry");
		assert.deepEqual(f.deleted, f.committed());
	});

	it("the Interactions API's quota_exceeded code counts as the daily quota too", async () => {
		useFake({ generate: () => ({ status: 429, json: { error: { code: "quota_exceeded", message: "You have exceeded your daily quota." } } }) });
		const error = await failure(run(converter(), 1));
		assert.equal(error.kind, "rate_limit");
		assert.match(error.message, /daily/);
	});

	it("a wait longer than the limit, or too many waits, fails with rate_limit instead of spinning", async () => {
		useFake({ generate: () => quota429("PerMinute", "3600s") });
		assert.match((await failure(run(converter(), 1))).message, /asks to wait in about 60 minutes/);
		fake!.restore();
		const f = useFake({ generate: () => quota429("PerMinute", "0.001s") });
		const error = await failure(run(converter({ maxRateLimitRetries: 2 }), 1));
		assert.equal(error.kind, "rate_limit");
		assert.match(error.message, /after 2 waits/);
		assert.equal(f.generates.length, 3);
	});

	it("minutesUntilPacificMidnight counts to the next midnight in Los Angeles", () => {
		assert.equal(gemini.minutesUntilPacificMidnight(new Date("2026-11-26T07:30:00Z")), 30); // 23:30 PST
		assert.equal(gemini.minutesUntilPacificMidnight(new Date("2026-07-01T06:00:00Z")), 60); // 23:00 PDT
	});
});

describe("Gemini converter: review fixes (2026-11-25)", () => {
	const example = `Write this:\n\`\`\`text\n${gemini.GEMINI_PAGE_MARKER(2)}\n\`\`\`\nAfter the example.`;

	it("a fenced example marker with the real page 2 marker missing: the batch is split, nothing moves to page 2", async () => {
		const f = useFake({ generate: (g) => answer(g.from === 1 && g.to === 2 ? `${gemini.GEMINI_PAGE_MARKER(1)}\n${example}` : g.from === 1 ? `${gemini.GEMINI_PAGE_MARKER(1)}\n${example}` : markedPages(g.from, g.to)) });
		const result = await run(converter({ batchPages: 2 }), 2);
		assert.deepEqual(f.generates.map((g) => [g.from, g.to]), [[1, 2], [1, 1], [2, 2]]);
		assert.deepEqual(result.pages, [
			{ page: 1, status: "ok", markdown: example },
			{ page: 2, status: "ok", markdown: pageText(2) },
		]);
	});

	it("a fenced example marker with the real page 2 marker present: one call, each page keeps its own text", async () => {
		const f = useFake({ generate: () => answer(`${gemini.GEMINI_PAGE_MARKER(1)}\n${example}\n${gemini.GEMINI_PAGE_MARKER(2)}\n${pageText(2)}`) });
		const result = await run(converter({ batchPages: 2 }), 2);
		assert.equal(f.generates.length, 1, "no retry for a correct transcription");
		assert.deepEqual(result.pages, [
			{ page: 1, status: "ok", markdown: example },
			{ page: 2, status: "ok", markdown: pageText(2) },
		]);
	});

	it("an abort while the finalize answer is read deletes the upload Google already committed", async () => {
		const controller = new AbortController();
		const f = useFake({
			finalize: () => {
				setTimeout(() => controller.abort(), 10);
				return { commit: true, reply: "hang-body" };
			},
		});
		const error = await failure(run(converter(), 2, controller.signal));
		assert.equal(error.kind, "aborted");
		assert.equal(f.committed().length, 1);
		assert.deepEqual(f.deleted, f.committed(), "DELETE targets the committed name");
		assert.equal(f.generates.length, 0);
	});

	it("a finalize answer with a valid name but no URI is bad_response, and the file is deleted", async () => {
		const f = useFake({ finalize: () => ({ commit: true, reply: { json: { file: { name: "files/whatever", state: "ACTIVE" } } } }) });
		const error = await failure(run(converter(), 1));
		assert.equal(error.kind, "bad_response");
		assert.match(error.message, /no valid file URI/);
		// the name this client chose, and the one in the answer
		assert.deepEqual(f.deleted, [...f.committed(), "files/whatever"]);
	});

	it("an omitted file state is polled (omitted → PROCESSING → ACTIVE); generation starts only after ACTIVE", async () => {
		const f = useFake({ uploadState: null, states: ["PROCESSING", "ACTIVE"] });
		const result = await run(converter(), 1);
		assert.deepEqual(result.pages, [{ page: 1, status: "ok", markdown: pageText(1) }]);
		const gets = f.seen.flatMap((s, i) => (s.method === "GET" ? [i] : []));
		assert.equal(gets.length, 2);
		const firstGenerate = f.seen.findIndex((s) => s.url.includes(":generateContent"));
		assert.ok(firstGenerate > gets[1]!, "generateContent after the GET that answered ACTIVE");
		// STATE_UNSPECIFIED is not ACTIVE either
		f.restore();
		const g = useFake({ uploadState: "STATE_UNSPECIFIED", states: ["ACTIVE"] });
		await run(converter(), 1);
		assert.ok(g.seen.findIndex((s) => s.url.includes(":generateContent")) > g.seen.findIndex((s) => s.method === "GET"));
	});

	it("a file precondition error is about the file, not the key; a location precondition still is about the key", async () => {
		useFake({ generate: () => ({ status: 400, json: { error: { code: 400, message: "The File abc is not in an ACTIVE state and usage is not allowed.", status: "FAILED_PRECONDITION" } } }) });
		const file = await failure(run(converter(), 1));
		assert.equal(file.kind, "conversion_failed");
		assert.doesNotMatch(file.message, /billing|country/);
		fake!.restore();
		useFake({ generate: () => ({ status: 400, json: { error: { code: 400, message: "User location is not supported for the API use.", status: "FAILED_PRECONDITION" } } }) });
		const location = await failure(run(converter(), 1));
		assert.equal(location.kind, "auth");
		assert.match(location.message, /not offered in every country/);
	});

	it("an empty success answer is one call, bad_response, and the file is deleted; a documented block leaves only the page empty", async () => {
		const f = useFake({ generate: () => ({ json: {} }) });
		const error = await failure(run(converter({ batchPages: 10 }), 10));
		assert.equal(error.kind, "bad_response");
		assert.match(error.message, /no candidate, no block reason/);
		assert.equal(f.generates.length, 1, "no split, no retry");
		assert.deepEqual(f.deleted, f.committed());
		f.restore();
		useFake({ generate: (g) => (g.from === g.to && g.from === 2 ? { json: { promptFeedback: { blockReason: "SAFETY" } } } : g.from <= 2 && g.to >= 2 ? { json: { promptFeedback: { blockReason: "SAFETY" } } } : answer(markedPages(g.from, g.to))) });
		const result = await run(converter({ batchPages: 3 }), 3);
		assert.deepEqual(result.pages.map((p) => p.status), ["ok", "empty", "ok"]);
		assert.match((result.pages[1] as { reason: string }).reason, /blocked the request \(SAFETY\)/);
	});

	it("a per-minute 429 on the bytes waits, asks the session how far it got, and sends the bytes again", async () => {
		const f = useFake({ finalize: (n) => (n === 1 ? { commit: false, reply: quota429("PerMinute", "0.02s") } : { commit: true }) });
		const result = await run(converter(), 1);
		assert.deepEqual(result.pages, [{ page: 1, status: "ok", markdown: pageText(1) }]);
		const commands = f.seen.map((s) => s.headers.get("x-goog-upload-command")).filter(Boolean);
		assert.deepEqual(commands, ["start", "upload, finalize", "query", "upload, finalize"]);
		assert.equal(f.seen.filter((s) => s.headers.get("x-goog-upload-command") === "upload, finalize").at(-1)!.headers.get("x-goog-upload-offset"), "0");
		assert.deepEqual([...f.uploads.values()][0], pdf);
		assert.deepEqual(f.deleted, f.committed());
	});

	it("a 429 after Google committed the bytes fetches the file instead of uploading twice", async () => {
		const f = useFake({ finalize: () => ({ commit: true, reply: quota429("PerMinute", "0.01s") }) });
		const result = await run(converter(), 1);
		assert.deepEqual(result.pages, [{ page: 1, status: "ok", markdown: pageText(1) }]);
		assert.equal(f.seen.filter((s) => s.headers.get("x-goog-upload-command") === "upload, finalize").length, 1, "the bytes were sent once");
		assert.ok(f.seen.some((s) => s.method === "GET" && s.url === `${BASE}/v1beta/${f.committed()[0]}`));
		assert.deepEqual(f.deleted, f.committed());
	});

	it("a daily-quota 429 on the bytes is rate_limit with the reset time, not \"a few minutes\", and is not retried", async () => {
		const f = useFake({ finalize: () => ({ commit: false, reply: quota429("PerDay", "30s") }) });
		const error = await failure(run(converter({ now: () => new Date("2026-11-25T20:00:00Z") }), 1));
		assert.equal(error.kind, "rate_limit");
		assert.match(error.message, /daily free-tier quota/);
		assert.match(error.message, /midnight Pacific time, in about 12 hours/);
		assert.doesNotMatch(error.message, /few minutes/);
		assert.equal(f.seen.filter((s) => s.headers.get("x-goog-upload-command") === "upload, finalize").length, 1);
		assert.equal(f.seen.some((s) => s.headers.get("x-goog-upload-command") === "query"), false);
	});
});

describe("Gemini converter: errors", () => {
	it("401, 403 and an invalid key (400 API_KEY_INVALID) are auth, and nothing is retried", async () => {
		for (const [status, json] of [
			[401, { error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } }],
			[403, { error: { code: 403, message: "Generative Language API has not been used in project 123 before or it is disabled.", status: "PERMISSION_DENIED" } }],
			[400, { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID", domain: "googleapis.com" }] } }],
		] as const) {
			const f = useFake({ start: () => ({ status, json }) });
			const error = await failure(run(converter(), 1));
			assert.equal(error.kind, "auth", `HTTP ${status}`);
			assert.equal(error.httpStatus, status);
			assert.equal(f.seen.length, 1, "not retried");
			f.restore();
		}
	});

	it("the provider key is named as such in an auth error", async () => {
		useFake({ start: () => ({ status: 400, json: { error: { code: 400, message: "API key not valid.", status: "INVALID_ARGUMENT" } } }) });
		const error = await failure(run(converter({ keySource: "provider" }), 1));
		assert.match(error.message, /Your Google provider key is not valid/);
	});

	it("an unknown model is bad_response that names the model setting", async () => {
		useFake({ generate: () => ({ status: 404, json: { error: { code: 404, message: "models/gemini-9-nope is not found", status: "NOT_FOUND" } } }) });
		const error = await failure(run(converter({ model: "gemini-9-nope" }), 1));
		assert.equal(error.kind, "bad_response");
		assert.match(error.message, /does not know the model "gemini-9-nope"/);
	});

	it("5xx after its retries is unreachable, and the registry falls back to the built-in reader", async () => {
		const f = useFake({ generate: () => ({ status: 503, json: { error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } } }) });
		const c = converter({ maxServerRetries: 1 });
		const error = await failure(run(c, 2));
		assert.equal(error.kind, "unreachable");
		assert.equal(f.generates.length, 2, "one retry");
		assert.deepEqual(f.deleted, f.committed());

		const bytes = validationPdf();
		const fell = await convertWithFallback({ converter: c, requestedId: "gemini", warnings: [] }, { bytes, filename: "t.pdf", pageCount: 2 }, { signal: new AbortController().signal, onProgress: () => {} });
		assert.equal(fell.converterId, "pdfjs");
		assert.equal(fell.fallbackFrom?.converterId, "gemini");
		assert.match(fell.warnings!.join(" "), /Google AI Studio \(Gemini\) failed/);
	});

	it("a network failure is unreachable", async () => {
		const original = globalThis.fetch;
		globalThis.fetch = (async () => {
			throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND gemini.test") });
		}) as typeof fetch;
		try {
			const error = await failure(run(converter(), 1));
			assert.equal(error.kind, "unreachable");
		} finally {
			globalThis.fetch = original;
		}
	});

	it("an abort while a batch runs is aborted, and the uploaded file is still deleted", async () => {
		const controller = new AbortController();
		const f = useFake({
			generate: () => {
				setTimeout(() => controller.abort(), 5);
				return "hang";
			},
		});
		const error = await failure(run(converter(), 3, controller.signal));
		assert.equal(error.kind, "aborted");
		assert.deepEqual(f.deleted, f.committed());
	});

	it("the job deadline is timeout", async () => {
		const f = useFake({ generate: () => "hang" });
		const error = await failure(run(converter({ jobDeadlineMs: 30 }), 1));
		assert.equal(error.kind, "timeout");
		assert.deepEqual(f.deleted, f.committed());
	});

	it("the key never appears in an error, a URL or the pages, even when Google echoes it", async () => {
		let f = useFake({ start: () => ({ status: 403, json: { error: { code: 403, message: `Key ${KEY} is blocked (${encodeURIComponent(KEY)})`, status: "PERMISSION_DENIED" } } }) });
		const error = await failure(run(converter(), 1));
		assert.equal(error.message.includes(KEY), false);
		assert.match(error.message, /\[redacted\]/);
		noKeyAnywhere(f);
		f.restore();

		f = useFake({ generate: (g) => answer(markedPages(g.from, g.to, (p) => `page ${p} mentions ${KEY}`)) });
		const result = await run(converter(), 1);
		assert.equal(JSON.stringify(result).includes(KEY), false);
		assert.ok(result.warnings?.length);
		f.restore();

		f = useFake({ generate: () => ({ status: 500, json: { error: { code: 500, message: `upload session ${"session-abc123"} failed`, status: "INTERNAL" } } }) });
		const server = await failure(run(converter({ maxServerRetries: 0 }), 1));
		assert.equal(server.message.includes("session-abc123"), false, "the upload session id is a secret too");
	});

	it("an empty or unsendable key is auth before anything is sent; a bad model id is not_configured", async () => {
		const f = useFake();
		assert.equal((await failure(run(converter({ apiKey: "short" }), 1))).kind, "auth");
		assert.equal((await failure(run(converter({ apiKey: "two\nlines-key" }), 1))).kind, "auth");
		assert.equal(f.seen.length, 0);
		assert.throws(() => converter({ model: "Gemini 3.8 Flash!" }), (e: unknown) => e instanceof ConverterError && e.kind === "not_configured");
	});
});

// ── Credentials, settings and the Test button ────────────────────────────────

const settingsFile = () => path.join(process.env.LH_DATA_DIR!, "settings.json");
const readText = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
const put = async (body: unknown) => {
	const response = await convertersRoute.PUT(new Request("http://localhost/api/converters", { method: "PUT", body: JSON.stringify(body) }));
	return { status: response.status, json: (await response.json()) as ConvertersOverview & { error?: string } };
};
const overview = async () => (await (await convertersRoute.GET()).json()) as ConvertersOverview;
const geminiEntry = async () => (await overview()).converters.find((c) => c.id === "gemini")!;

describe("Gemini converter: credentials", () => {
	beforeEach(() => {
		fs.rmSync(process.env.LH_AUTH_FILE!, { force: true });
		writeSettings({ version: 1 });
		delete process.env.GEMINI_API_KEY;
	});
	afterEach(() => {
		delete process.env.GEMINI_API_KEY;
		delete process.env.LH_IGNORE_ENV_KEYS;
	});

	it("its own key is bound to the Gemini API's address and wins over the provider key", () => {
		credentials.writeProfileCredential("gemini", gemini.GEMINI_BASE_URL, KEY);
		process.env.GEMINI_API_KEY = PROVIDER_KEY;
		assert.equal(credentials.readConverterCredential("gemini", gemini.GEMINI_BASE_URL), KEY);
		assert.equal(credentials.readConverterCredential.sourceOf?.("gemini", gemini.GEMINI_BASE_URL), "own");
		assert.equal(credentials.readConverterCredential("gemini", "https://proxy.example"), undefined);
	});

	it("without one, the Google provider key is used (env, else auth.json) and never copied", () => {
		assert.equal(credentials.readConverterCredential("gemini", gemini.GEMINI_BASE_URL), undefined);
		store.authStore.setAuthVar("GEMINI_API_KEY", PROVIDER_KEY);
		assert.equal(credentials.readConverterCredential("gemini", gemini.GEMINI_BASE_URL), PROVIDER_KEY);
		assert.equal(credentials.readConverterCredential.sourceOf?.("gemini", gemini.GEMINI_BASE_URL), "provider");
		process.env.GEMINI_API_KEY = "test-google-env-key-0003";
		assert.equal(credentials.readConverterCredential("gemini", gemini.GEMINI_BASE_URL), "test-google-env-key-0003");
		process.env.LH_IGNORE_ENV_KEYS = "1";
		assert.equal(credentials.readConverterCredential("gemini", gemini.GEMINI_BASE_URL), PROVIDER_KEY);
		// only for Google's own address, and never written into the converter credentials
		assert.equal(credentials.readConverterCredential("gemini", "https://proxy.example"), undefined);
		const raw = JSON.parse(readText(process.env.LH_AUTH_FILE!)) as Record<string, string>;
		assert.equal(raw[CONVERTER_CREDENTIALS], undefined);
		// no other converter borrows it
		assert.equal(credentials.readConverterCredential("mistral-ocr", "https://api.mistral.ai"), undefined);
	});

	it("the registry builds it from the provider key and says where the key came from; without any key it falls back", async () => {
		writeSettings({ version: 1, pdfConversion: { converter: "gemini" } });
		const none = resolvePdfConverter({ converter: "gemini" }, credentials.readConverterCredential);
		assert.equal(none.converter.id, "pdfjs");
		assert.match(none.warnings[0]!, /no Gemini API key is saved/);
		store.authStore.setAuthVar("GEMINI_API_KEY", PROVIDER_KEY);
		const resolved = resolvePdfConverter({ converter: "gemini", gemini: { model: "gemini-3.6-flash" } }, credentials.readConverterCredential);
		assert.equal(resolved.converter.id, "gemini");
		assert.deepEqual(resolved.converter.options, { model: "gemini-3.6-flash" });
		const entry = await geminiEntry();
		assert.equal(entry.ready, true);
		assert.deepEqual(entry.credential, { stored: false, provider: true });
	});
});

describe("Gemini converter: Settings API", () => {
	beforeEach(() => {
		fs.rmSync(process.env.LH_AUTH_FILE!, { force: true });
		writeSettings({ version: 1 });
		delete process.env.GEMINI_API_KEY;
	});

	it("is listed with a fixed address, key link, privacy note, model and limits, unverified and not ready", async () => {
		const entry = await geminiEntry();
		assert.equal(entry.kind, "gemini");
		assert.equal(entry.name, "Google AI Studio (Gemini)");
		assert.equal(entry.local, false);
		assert.equal(entry.unverified, true);
		assert.equal(entry.fixedUrl, true);
		assert.equal(entry.origin, "https://generativelanguage.googleapis.com");
		assert.equal(entry.keyUrl, "https://aistudio.google.com/apikey");
		assert.match(entry.privacyNote!, /free tier may use uploaded files to improve its products; don't upload private documents/);
		assert.deepEqual(entry.model, { default: gemini.GEMINI_DEFAULT_MODEL, suggestions: [...gemini.GEMINI_MODEL_SUGGESTIONS] });
		assert.equal(entry.ready, false);
		assert.match(entry.setup!, /Save a Gemini API key first/);
		assert.equal(gemini.GEMINI_MODEL_SUGGESTIONS.includes("gemini-4-neon" as never), false, "no free tier");
	});

	it("round-trips key, model and selection; the key never reaches settings.json", async () => {
		const refused = await put({ id: "gemini", select: true });
		assert.equal(refused.status, 409);
		assert.match(refused.json.error!, /Save a Gemini API key first/);

		let r = await put({ id: "gemini", apiKey: ` ${KEY} `, model: "models/gemini-3.6-flash" });
		assert.equal(r.status, 200);
		let entry = r.json.converters.find((c) => c.id === "gemini")!;
		assert.equal(entry.credential.stored, true);
		assert.equal(entry.credential.provider, undefined);
		assert.equal(entry.model?.value, "gemini-3.6-flash");
		assert.equal(credentials.readConverterCredential("gemini", gemini.GEMINI_BASE_URL), KEY);

		r = await put({ id: "gemini", select: true });
		assert.equal(r.json.selected, "gemini");
		const saved = readSettings()!.pdfConversion!;
		assert.deepEqual(saved, { converter: "gemini", gemini: { model: "gemini-3.6-flash" } });
		assert.equal(readText(settingsFile()).includes(KEY), false);
		assert.deepEqual(sanitizeUserSettings(JSON.parse(readText(settingsFile())))!.pdfConversion, saved);

		r = await put({ id: "gemini", model: "" });
		assert.equal(r.json.converters.find((c) => c.id === "gemini")!.model?.value, undefined);
		assert.deepEqual(readSettings()!.pdfConversion!.gemini, {});

		r = await put({ id: "gemini", removeKey: true });
		entry = r.json.converters.find((c) => c.id === "gemini")!;
		assert.equal(entry.credential.stored, false);
		assert.equal(entry.ready, false);
	});

	it("refuses a bad model id, a URL, Docling options, a short key, and a model for another converter", async () => {
		assert.match((await put({ id: "gemini", model: "Gemini Flash!" })).json.error!, /model id may hold only/);
		assert.match((await put({ id: "gemini", baseUrl: "https://proxy.example" })).json.error!, /fixed address/);
		assert.match((await put({ id: "gemini", ocr: true })).json.error!, /Only Docling/);
		assert.match((await put({ id: "gemini", apiKey: "short" })).json.error!, /at least 8 characters/);
		assert.match((await put({ id: "docling", model: "gemini-3.8-flash" })).json.error!, /Only Google AI Studio \(Gemini\) has a model setting/);
		assert.deepEqual(readSettings()!.pdfConversion ?? {}, {});
	});

	it("a malformed model id is refused and the saved model stays; only a blank field resets it", async () => {
		await put({ id: "gemini", model: "gemini-3.6-flash" });
		for (const typed of ["models/models/gemini-3.6-flash", "models/", " models/ "]) {
			const r = await put({ id: "gemini", model: typed });
			assert.equal(r.status, 400, typed);
			assert.match(r.json.error!, /model id may hold only/, typed);
			assert.deepEqual(readSettings()!.pdfConversion!.gemini, { model: "gemini-3.6-flash" }, typed);
		}
		const r = await put({ id: "gemini", model: " models/gemini-3.5-flash-lite " });
		assert.equal(r.json.converters.find((c) => c.id === "gemini")!.model?.value, "gemini-3.5-flash-lite");
		assert.deepEqual(sanitizeUserSettings(JSON.parse(readText(settingsFile())))!.pdfConversion!.gemini, { model: "gemini-3.5-flash-lite" }, "the saved value survives the sanitizer");
		assert.equal(gemini.geminiModelId("models/"), undefined);
		assert.equal(gemini.geminiModelId("models/models/gemini-3.6-flash"), undefined);
		assert.equal(gemini.geminiModelId(" "), gemini.GEMINI_DEFAULT_MODEL);
	});

	it("can be selected with only the provider key", async () => {
		store.authStore.setAuthVar("GEMINI_API_KEY", PROVIDER_KEY);
		const r = await put({ id: "gemini", select: true });
		assert.equal(r.status, 200);
		assert.equal(r.json.selected, "gemini");
	});

	it("the settings section parser and sanitizer keep a valid model and drop a bad one", () => {
		assert.deepEqual(parsePdfConversionSettingsBody({ converter: "gemini", gemini: { model: " gemini-3.8-flash " } }), { ok: true, settings: { converter: "gemini", gemini: { model: "gemini-3.8-flash" } } });
		assert.equal(parsePdfConversionSettingsBody({ gemini: { model: "Not A Model" } }).ok, false);
		assert.equal(parsePdfConversionSettingsBody({ gemini: "x" }).ok, false);
		assert.deepEqual(sanitizeUserSettings({ version: 1, pdfConversion: { gemini: { model: "BAD MODEL" } } })!.pdfConversion, { gemini: {} });
	});

	it("Test runs the bundled test PDFs through it (validation fixture flow)", async () => {
		credentials.writeProfileCredential("gemini", gemini.GEMINI_BASE_URL, KEY);
		const sentence = (bytes: Uint8Array, page: number): string | undefined => {
			const streams = [...Buffer.from(bytes).toString("latin1").matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((m) => m[1]!);
			return /\((.*)\) Tj/.exec(streams[page - 1] ?? "")?.[1];
		};
		const f = useFake({
			generate: (g) => {
				const bytes = [...fake!.uploads.values()].at(-1)!;
				return answer(Array.from({ length: g.to - g.from + 1 }, (_, i) => `${gemini.GEMINI_PAGE_MARKER(g.from + i)}\n${sentence(bytes, g.from + i) ?? ""}`).join("\n"));
			},
		});
		const response = await testRoute.POST(new Request("http://localhost/api/converters/test", { method: "POST", body: JSON.stringify({ id: "gemini" }) }));
		const report = (await response.json()) as ConverterValidationReport;
		assert.equal(response.status, 200);
		assert.equal(report.converterId, "gemini");
		assert.equal(report.ok, true, JSON.stringify(report.checks));
		assert.equal(report.pages[0]!.text.includes(VALIDATION_SENTENCES[0]), true);
		assert.ok(f.seen.every((s) => s.url.startsWith(gemini.GEMINI_BASE_URL)));
		assert.equal(f.deleted.length, 2, "both test PDFs deleted");
		noKeyAnywhere(f);
	});
});
