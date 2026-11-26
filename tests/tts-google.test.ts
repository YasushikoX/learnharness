import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	chunkSpeechLines,
	effectiveReadAloudEngine,
	GOOGLE_TTS_DEFAULT_MODEL,
	GOOGLE_TTS_DEFAULT_VOICES,
	GOOGLE_TTS_FAST_MODEL,
	GOOGLE_TTS_STYLE,
	GOOGLE_TTS_VOICES,
	googleModelFor,
	googleVoiceFor,
} from "../src/core/tts.ts";
import { FACTORY_SETTINGS, sanitizeUserSettings } from "../src/core/settings.ts";
import { parseGeneralSettingsBody } from "../src/server/settings-body.ts";
import { createTtsCache, ttsCacheId } from "../src/server/tts/cache.ts";
import { geminiTtsBody, synthesizeGeminiSpeech, ttsFailureOf, wavFromInteraction } from "../src/server/tts/gemini-tts.ts";
import { createTtsService } from "../src/server/tts/service.ts";
import { wavFromPcm } from "../src/server/stt/wav.ts";

const KEY = "AIzaTESTKEY0123456789abcdef";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "lh-tts-"));
}

function pcm(samples: number): Uint8Array {
	const out = new Uint8Array(samples * 2);
	for (let i = 0; i < out.length; i++) out[i] = i % 251;
	return out;
}

function interaction(data: Uint8Array, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "i-1",
		status: "completed",
		steps: [{ type: "model_output", content: [{ type: "audio", data: Buffer.from(data).toString("base64"), ...extra }] }],
	};
}

type Call = { url: string; init: RequestInit };

function fakeFetch(answers: (call: Call, n: number) => Response): { fetch: typeof fetch; calls: Call[] } {
	const calls: Call[] = [];
	const f = (async (url: string | URL | Request, init?: RequestInit) => {
		const call = { url: String(url), init: init ?? {} };
		calls.push(call);
		return answers(call, calls.length);
	}) as typeof fetch;
	return { fetch: f, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("core/tts: engine choice, voices and chunking", () => {
	it("chooses Google once a key exists unless system voices are chosen", () => {
		assert.equal(effectiveReadAloudEngine(null, false), "system");
		assert.equal(effectiveReadAloudEngine(null, true), "google");
		assert.equal(effectiveReadAloudEngine("google", true), "google");
		assert.equal(effectiveReadAloudEngine("google", false), "system", "no key: system voices");
		assert.equal(effectiveReadAloudEngine("system", true), "system");
	});

	it("falls back to the default voice and model for unknown values", () => {
		assert.equal(googleVoiceFor("en", undefined), GOOGLE_TTS_DEFAULT_VOICES.en);
		assert.equal(googleVoiceFor("nb", { nb: "Kore" }), "Kore");
		assert.equal(googleVoiceFor("nb", { nb: "Nobody" }), GOOGLE_TTS_DEFAULT_VOICES.nb);
		assert.equal(googleModelFor(undefined), GOOGLE_TTS_DEFAULT_MODEL);
		assert.equal(googleModelFor(GOOGLE_TTS_FAST_MODEL), GOOGLE_TTS_FAST_MODEL);
		assert.equal(googleModelFor("gemini-9-tts"), GOOGLE_TTS_DEFAULT_MODEL);
		assert.equal(GOOGLE_TTS_VOICES.length, 30);
		for (const v of Object.values(GOOGLE_TTS_DEFAULT_VOICES)) assert.ok(GOOGLE_TTS_VOICES.some((g) => g.name === v));
	});

	it("packs sentences into a short first chunk, then larger ones, never splitting a sentence", () => {
		const s = (n: number, c: string) => c.repeat(n - 1) + ".";
		const lines = [s(80, "a"), s(80, "b"), s(80, "c"), s(300, "d"), s(300, "e"), " ", s(500, "f")];
		const chunks = chunkSpeechLines(lines, 200, 700);
		assert.deepEqual(chunks.map((c) => c.lines.length), [2, 3, 1]);
		assert.equal(chunks[0]!.text, `${lines[0]} ${lines[1]}`);
		assert.ok(chunks[0]!.text.length <= 200);
		assert.ok(chunks[1]!.text.length <= 700);
		assert.deepEqual(chunks.flatMap((c) => c.lines), lines.filter((l) => l.trim()));
		// a sentence longer than the cap is a chunk of its own
		const long = chunkSpeechLines(["x".repeat(900), "short."], 200, 700);
		assert.deepEqual(long.map((c) => c.lines.length), [1, 1]);
		assert.deepEqual(chunkSpeechLines(["", "  "]), []);
	});
});

describe("settings: the read-aloud engine fields", () => {
	it("sanitizes stored values and defaults to auto, the quality model and no voices", () => {
		assert.equal(FACTORY_SETTINGS.general.readAloudEngine, null);
		assert.equal(FACTORY_SETTINGS.general.readAloudModel, GOOGLE_TTS_DEFAULT_MODEL);
		const clean = sanitizeUserSettings({ version: 1, general: { readAloudEngine: "google", readAloudModel: GOOGLE_TTS_FAST_MODEL, readAloudVoices: { en: "Kore", nb: "Bogus", xx: "Puck" } } });
		assert.equal(clean!.general?.readAloudEngine, "google");
		assert.equal(clean!.general?.readAloudModel, GOOGLE_TTS_FAST_MODEL);
		assert.deepEqual(clean!.general?.readAloudVoices, { en: "Kore" });
		const bad = sanitizeUserSettings({ version: 1, general: { readAloudEngine: "piper", readAloudModel: "gemini-x" } });
		assert.equal(bad!.general?.readAloudEngine, undefined);
		assert.equal(bad!.general?.readAloudModel, undefined);
	});

	it("validates the API body", () => {
		assert.equal(parseGeneralSettingsBody({ readAloudEngine: "system" }).ok, true);
		assert.equal(parseGeneralSettingsBody({ readAloudEngine: null }).ok, true);
		assert.equal(parseGeneralSettingsBody({ readAloudEngine: "kokoro" }).ok, false);
		assert.equal(parseGeneralSettingsBody({ readAloudModel: GOOGLE_TTS_FAST_MODEL }).ok, true);
		assert.equal(parseGeneralSettingsBody({ readAloudModel: "gemini-3.8-flash" }).ok, false);
		assert.equal(parseGeneralSettingsBody({ readAloudVoices: { en: "Kore", nb: "Iapetus" } }).ok, true);
		assert.equal(parseGeneralSettingsBody({ readAloudVoices: { en: "Nobody" } }).ok, false);
	});
});

describe("Gemini TTS client against a fake API", () => {
	it("sends the documented Interactions request with the key only in the header", async () => {
		const wav = wavFromPcm(pcm(100), 24_000);
		const { fetch: f, calls } = fakeFetch(() => json(interaction(wav)));
		const result = await synthesizeGeminiSpeech({ apiKey: KEY, model: GOOGLE_TTS_DEFAULT_MODEL, voice: "Kore", text: "Hei på deg.", style: GOOGLE_TTS_STYLE, fetch: f, baseUrl: "https://g.test" });
		assert.equal(result.ok, true);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.url, "https://g.test/v1beta/interactions");
		assert.ok(!calls[0]!.url.includes(KEY));
		assert.equal((calls[0]!.init.headers as Record<string, string>)["x-goog-api-key"], KEY);
		assert.equal(calls[0]!.init.redirect, "manual");
		const body = JSON.parse(String(calls[0]!.init.body));
		assert.equal(body.model, GOOGLE_TTS_DEFAULT_MODEL);
		assert.deepEqual(body.generation_config, { speech_config: [{ voice: "Kore" }] });
		assert.deepEqual(body.response_format, { type: "audio" });
		assert.equal(body.store, false);
		assert.equal(body.input[0].content[0].text, "Hei på deg.");
		assert.deepEqual(body.input[0].content[0].annotations, [{ type: "speech_metadata", style: GOOGLE_TTS_STYLE }]);
		assert.deepEqual(body, geminiTtsBody(GOOGLE_TTS_DEFAULT_MODEL, "Kore", "Hei på deg.", GOOGLE_TTS_STYLE));
	});

	it("passes a WAV answer through and wraps raw 24 kHz PCM as WAV", () => {
		const wav = wavFromPcm(pcm(50), 24_000);
		assert.deepEqual(wavFromInteraction(interaction(wav)), wav);
		const raw = pcm(64);
		const wrapped = wavFromInteraction(interaction(raw, { mime_type: "audio/l16" }));
		assert.equal(Buffer.from(wrapped.subarray(0, 4)).toString("ascii"), "RIFF");
		const view = new DataView(wrapped.buffer, wrapped.byteOffset, wrapped.byteLength);
		assert.equal(view.getUint32(24, true), 24_000, "sample rate");
		assert.equal(view.getUint32(28, true), 48_000, "byte rate");
		assert.equal(view.getUint16(22, true), 1, "mono");
		assert.equal(view.getUint16(34, true), 16, "16-bit");
		assert.equal(view.getUint32(40, true), raw.byteLength);
		assert.deepEqual(wrapped.subarray(44), raw);
		// a stated sample rate is honored
		const at16 = wavFromInteraction(interaction(raw, { mime_type: "audio/l16", sample_rate: 16_000 }));
		assert.equal(new DataView(at16.buffer, at16.byteOffset).getUint32(24, true), 16_000);
	});

	it("takes the last audio item of the model output and refuses an answer without audio", () => {
		const a = wavFromPcm(pcm(10), 24_000);
		const b = wavFromPcm(pcm(20), 24_000);
		const body = { status: "completed", steps: [{ type: "thought", content: [{ type: "audio", data: Buffer.from(a).toString("base64") }] }, { type: "model_output", content: [{ type: "text", text: "x" }, { type: "audio", data: Buffer.from(a).toString("base64") }, { type: "audio", data: Buffer.from(b).toString("base64") }] }] };
		assert.deepEqual(wavFromInteraction(body), b);
		assert.throws(() => wavFromInteraction({ status: "completed", steps: [] }), /without audio/);
		assert.throws(() => wavFromInteraction({ status: "failed", errors: [{ code: "x", message: "boom" }] }), /failed: boom/);
		assert.throws(() => wavFromInteraction(interaction(pcm(4), { mime_type: "audio/mp3" })), /does not play/);
	});

	it("maps 429 per minute and per day, a bad key, offline and a timeout", async () => {
		const now = new Date("2026-11-26T20:00:00Z"); // 12:00 Pacific
		const perMinute = ttsFailureOf(429, JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "slow down", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "31s" }] } }), null, [KEY], now);
		assert.equal(perMinute.kind, "rate_limit");
		assert.equal(perMinute.retryAfterMs, 31_000);
		const daily = ttsFailureOf(429, JSON.stringify({ error: { code: 429, message: "Quota exceeded", details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] } }), null, [KEY], now);
		assert.equal(daily.kind, "quota");
		assert.equal(daily.retryAfterMs, 12 * 60 * 60_000);
		const badKey = ttsFailureOf(400, JSON.stringify({ error: { message: `API key not valid: ${KEY}`, details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }] } }), null, [KEY], now);
		assert.equal(badKey.kind, "auth");
		assert.ok(!badKey.message.includes(KEY), "the key is removed from messages");
		assert.equal(ttsFailureOf(503, "", null, [KEY], now).kind, "unavailable");

		const offline = await synthesizeGeminiSpeech({ apiKey: KEY, model: "m", voice: "Kore", text: "x", fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
		assert.equal(offline.ok, false);
		assert.equal(!offline.ok && offline.kind, "offline");

		const slow = await synthesizeGeminiSpeech({
			apiKey: KEY, model: "m", voice: "Kore", text: "x", timeoutMs: 10,
			fetch: ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch,
		});
		assert.equal(!slow.ok && slow.kind, "timeout");

		const noKey = await synthesizeGeminiSpeech({ apiKey: " ", model: "m", voice: "Kore", text: "x", fetch: (() => assert.fail("no call without a key")) as typeof fetch });
		assert.equal(!noKey.ok && noKey.kind, "no_key");
	});
});

describe("the audio cache", () => {
	const key = (text: string) => ({ model: GOOGLE_TTS_DEFAULT_MODEL, voice: "Kore", style: GOOGLE_TTS_STYLE, text });

	it("misses, then hits; the key covers model, voice, style and text", () => {
		const cache = createTtsCache(tmpDir());
		assert.equal(cache.get(key("a")), undefined);
		cache.put(key("a"), new Uint8Array([1, 2, 3]));
		assert.deepEqual([...cache.get(key("a"))!], [1, 2, 3]);
		assert.equal(cache.get({ ...key("a"), voice: "Puck" }), undefined);
		assert.notEqual(ttsCacheId(key("a")), ttsCacheId({ ...key("a"), model: GOOGLE_TTS_FAST_MODEL }));
		assert.notEqual(ttsCacheId(key("a")), ttsCacheId({ ...key("a"), style: "other" }));
	});

	it("stays under its size cap, dropping the least recently used first", () => {
		const dir = tmpDir();
		const cache = createTtsCache(dir, 250);
		const bytes = new Uint8Array(100);
		cache.put(key("one"), bytes);
		const old = new Date(Date.now() - 60_000);
		fs.utimesSync(path.join(dir, `${ttsCacheId(key("one"))}.wav`), old, old);
		cache.put(key("two"), bytes);
		fs.utimesSync(path.join(dir, `${ttsCacheId(key("two"))}.wav`), new Date(Date.now() - 30_000), new Date(Date.now() - 30_000));
		// reading "one" makes it the most recently used
		assert.ok(cache.get(key("one")));
		cache.put(key("three"), bytes);
		assert.ok(cache.size() <= 250);
		assert.equal(cache.get(key("two")), undefined, "the least recently used went first");
		assert.ok(cache.get(key("one")));
		assert.ok(cache.get(key("three")));
		// a file larger than the whole cap is not stored
		cache.put(key("huge"), new Uint8Array(300));
		assert.equal(cache.get(key("huge")), undefined);
	});
});

describe("the TTS service: cache, key and limits", () => {
	function service(opts: { key?: string; results?: Array<{ ok: true; wav: Uint8Array } | { ok: false; kind: "quota" | "rate_limit" | "offline"; message: string; retryAfterMs?: number }> } = {}) {
		const dir = tmpDir();
		let clock = 1_000_000;
		const calls: { model: string; voice: string; text: string }[] = [];
		const results = [...(opts.results ?? [])];
		const svc = createTtsService({
			readKey: () => opts.key,
			readGeneral: () => ({ readAloudVoices: { nb: "Kore" } }),
			cache: createTtsCache(path.join(dir, "cache")),
			stateFile: path.join(dir, "state.json"),
			now: () => clock,
			synthesize: async (req) => {
				calls.push({ model: req.model, voice: req.voice, text: req.text });
				return results.shift() ?? { ok: true, wav: new Uint8Array([9, 9]) };
			},
		});
		return { svc, calls, advance: (ms: number) => (clock += ms) };
	}

	it("answers no_key without calling Google", async () => {
		const { svc, calls } = service();
		const r = await svc.speak({ text: "Hello.", language: "en" });
		assert.equal(!r.ok && r.kind, "no_key");
		assert.equal(calls.length, 0);
		assert.equal(svc.status().key.source, null);
	});

	it("calls once, then replays from the cache; the saved voice per language is used; a success marks it verified", async () => {
		const { svc, calls } = service({ key: KEY });
		assert.equal(svc.status().verified, false);
		const first = await svc.speak({ text: "Hei.", language: "nb" });
		assert.equal(first.ok && first.cached, false);
		const again = await svc.speak({ text: "Hei.", language: "nb" });
		assert.equal(again.ok && again.cached, true);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.voice, "Kore");
		assert.equal(calls[0]!.model, GOOGLE_TTS_DEFAULT_MODEL);
		assert.equal(svc.status().verified, true);
		// a preview voice is another cache entry
		await svc.speak({ text: "Hei.", language: "nb", voice: "Puck" });
		assert.equal(calls.length, 2);
		// Test (fresh) skips the cache read
		await svc.speak({ text: "Hei.", language: "nb", fresh: true });
		assert.equal(calls.length, 3);
	});

	it("shares one call between a prefetch and the read that follows it", async () => {
		const { svc, calls } = service({ key: KEY });
		const [a, b] = await Promise.all([svc.speak({ text: "Same.", language: "en" }), svc.speak({ text: "Same.", language: "en" })]);
		assert.ok(a.ok && b.ok);
		assert.equal(calls.length, 1);
	});

	it("stops calling Google while a limit lasts, then tries again; cached audio still plays", async () => {
		const { svc, calls, advance } = service({ key: KEY, results: [{ ok: true, wav: new Uint8Array([1]) }, { ok: false, kind: "quota", message: "daily", retryAfterMs: 5_000 }] });
		await svc.speak({ text: "Cached.", language: "en" });
		const limited = await svc.speak({ text: "New.", language: "en" });
		assert.equal(!limited.ok && limited.kind, "quota");
		const blocked = await svc.speak({ text: "Other.", language: "en" });
		assert.equal(!blocked.ok && blocked.kind, "quota");
		assert.equal(calls.length, 2, "no call while limited");
		const hit = await svc.speak({ text: "Cached.", language: "en" });
		assert.ok(hit.ok && hit.cached);
		advance(6_000);
		const after = await svc.speak({ text: "Other.", language: "en" });
		assert.ok(after.ok);
		assert.equal(calls.length, 3);
	});

	it("does not hold back after an offline failure", async () => {
		const { svc, calls } = service({ key: KEY, results: [{ ok: false, kind: "offline", message: "no net" }] });
		const r = await svc.speak({ text: "A.", language: "en" });
		assert.equal(!r.ok && r.kind, "offline");
		assert.ok((await svc.speak({ text: "A.", language: "en" })).ok);
		assert.equal(calls.length, 2);
	});
});
