import React, { act } from "react";
(globalThis as { React?: typeof React }).React = React;
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { GOOGLE_TTS_LIMIT_NOTICE, type GeneralSettings, type GoogleTtsFailure, type ReadAloudStatus, GOOGLE_TTS_MODELS, GOOGLE_TTS_VOICES, GOOGLE_TTS_DEFAULT_MODEL, GOOGLE_TTS_DEFAULT_VOICES } from "../src/core/index.ts";
import {
	createReadAloudController,
	resetReadAloudSession,
	type AudioLike,
	type GoogleAudioResult,
	type GoogleTtsClient,
} from "../components/read-aloud-controller.ts";
import type { SpeechSynthesisLike, SpeechUtteranceLike, SpeechVoiceLike } from "../components/speech-controller.ts";
import { QuestionReadAloud, clearAutoReadHistory } from "../components/question-read-aloud.tsx";
import { ReadAloudSection } from "../components/settings/read-aloud-section.tsx";
import type { ReadAloudClient } from "../components/settings/read-aloud-client.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	Event: dom.window.Event,
	IS_REACT_ACT_ENVIRONMENT: true,
});
// react-dom decides at load whether the DOM has input events (`oninput` in document): it is loaded after the DOM is set
// up, so typing into a field reaches onChange (tests/converter-wizard.test.tsx does the same).
(dom.document as unknown as Record<string, unknown>).oninput = null;
const { createRoot } = await import("react-dom/client");

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

class MockUtterance implements SpeechUtteranceLike {
	text: string;
	lang = "";
	rate = 1;
	voice: SpeechVoiceLike | null = null;
	onend: ((event: unknown) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	constructor(text: string) {
		this.text = text;
	}
}

function mockSystem() {
	const spoken: MockUtterance[] = [];
	const synthesis: SpeechSynthesisLike = {
		getVoices: () => [{ voiceURI: "en", name: "Samantha", lang: "en-US", default: true, localService: true }],
		speak: (u) => {
			spoken.push(u as MockUtterance);
		},
		cancel: () => {},
	};
	return { synthesis, Utterance: MockUtterance, spoken };
}

class FakeAudio implements AudioLike {
	static all: FakeAudio[] = [];
	playbackRate = 1;
	onended: ((event: unknown) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	paused = false;
	constructor(public url: string) {
		FakeAudio.all.push(this);
	}
	play() {
		return Promise.resolve();
	}
	pause() {
		this.paused = true;
	}
}

/** A Google client whose answers are given per chunk text; records requests, releases and prefetches. */
function fakeGoogle(answer: (text: string) => GoogleAudioResult | Promise<GoogleAudioResult>) {
	const requests: string[] = [];
	const prefetched: string[] = [];
	const released: string[] = [];
	const client: GoogleTtsClient = {
		async fetchAudio(text) {
			requests.push(text);
			const r = await answer(text);
			return r.ok ? { ok: true, url: r.url, release: () => released.push(r.url) } : r;
		},
		prefetch(text) {
			prefetched.push(text);
		},
	};
	return { client, requests, prefetched, released };
}

const ok = (url: string): GoogleAudioResult => ({ ok: true, url, release: () => {} });
const fail = (kind: GoogleTtsFailure, retryAfterMs?: number): GoogleAudioResult => ({ ok: false, kind, ...(retryAfterMs ? { retryAfterMs } : {}) });

const LONG = Array.from({ length: 6 }, (_, i) => `Sentence number ${i + 1} is here and it is reasonably long so that chunks fill up.`);

describe("read-aloud controller: engines and fallback", () => {
	beforeEach(() => {
		FakeAudio.all = [];
		resetReadAloudSession();
	});

	it("uses system voices unless Google is chosen, and keeps the speech controller's interface", () => {
		const sys = mockSystem();
		const g = fakeGoogle(() => ok("u"));
		const c = createReadAloudController({ synthesis: sys.synthesis, Utterance: sys.Utterance, cancelGapMs: 0, google: g.client, createAudio: (u) => new FakeAudio(u) });
		assert.equal(c.getState().engine, "system");
		assert.equal(c.speak(["Hello."], { language: "en" }), true);
		assert.equal(sys.spoken.length, 1);
		assert.equal(g.requests.length, 0);
		assert.equal(c.getState().speaking, true);
		c.stop();
		assert.equal(c.getState().speaking, false);
		c.dispose();
	});

	it("plays Google audio chunk by chunk at the rate, fetching the next while one plays", async () => {
		const sys = mockSystem();
		const g = fakeGoogle((t) => ok(`url:${t.slice(0, 20)}`));
		const c = createReadAloudController({ synthesis: sys.synthesis, Utterance: sys.Utterance, cancelGapMs: 0, google: g.client, createAudio: (u) => new FakeAudio(u) });
		c.setEngine("google");
		assert.equal(c.getState().engine, "google");
		assert.equal(c.speak(LONG, { language: "en", rate: 1.5 }), true);
		assert.equal(c.getState().speaking, true);
		await flush();
		assert.equal(FakeAudio.all.length, 1, "the first chunk plays as soon as it arrives");
		assert.equal(FakeAudio.all[0]!.playbackRate, 1.5);
		assert.ok(g.requests.length >= 2, "the next chunk is fetched behind it");
		assert.ok(g.requests[0]!.length <= 200, "the first chunk is short");
		assert.equal(sys.spoken.length, 0);
		while (c.getState().speaking && FakeAudio.all.length < 10) {
			const audio = c.getActiveAudio();
			assert.ok(audio);
			audio.onended?.({});
			await flush();
		}
		assert.equal(c.getState().speaking, false);
		assert.equal(g.requests.join(" "), LONG.join(" "), "every sentence was read once, in order");
		assert.equal(g.released.length, g.requests.length, "every object URL is released");
		c.dispose();
	});

	for (const kind of ["no_key", "offline", "bad_response", "auth"] as const) {
		it(`falls back to system voices on ${kind}, with no notice`, async () => {
			const sys = mockSystem();
			const g = fakeGoogle(() => fail(kind));
			const c = createReadAloudController({ synthesis: sys.synthesis, Utterance: sys.Utterance, cancelGapMs: 0, google: g.client, createAudio: (u) => new FakeAudio(u) });
			c.setEngine("google");
			c.speak(["One.", "Two."], { language: "en" });
			await flush();
			assert.deepEqual(sys.spoken.map((u) => u.text), ["One."]);
			assert.equal(c.getState().speaking, true);
			assert.equal(c.getState().notice, null);
			assert.equal(c.getState().engine, "google", "Google stays chosen for the next read");
			c.dispose();
		});
	}

	it("on a 429 quota: system voices read the rest, a notice shows once, and Google rests until the limit lasts", async () => {
		const sys = mockSystem();
		let clock = 0;
		let served = 0;
		// the first chunk arrives; the next one hits the daily quota
		const g = fakeGoogle((t) => (served++ >= 1 ? fail("quota", 10_000) : ok(t)));
		const deps = { synthesis: sys.synthesis, Utterance: sys.Utterance, cancelGapMs: 0, google: g.client, createAudio: (u: string) => new FakeAudio(u), now: () => clock };
		const c = createReadAloudController(deps);
		c.setEngine("google");
		c.speak(LONG, { language: "en" });
		await flush();
		c.getActiveAudio()!.onended?.({});
		await flush();
		await flush();
		assert.ok(sys.spoken.length > 0, "the remaining sentences go to system voices");
		assert.equal(sys.spoken[0]!.text, LONG.find((l) => !g.requests[0]!.includes(l)));
		assert.equal(c.getState().notice, GOOGLE_TTS_LIMIT_NOTICE);
		assert.equal(c.getState().engine, "system", "limited: system voices meanwhile");
		const before = g.requests.length;
		c.speak(["Again."], { language: "en" });
		assert.equal(g.requests.length, before, "no Google request while limited");
		assert.equal(c.getState().notice, null);
		c.dispose();

		// another controller (the dock remounted) does not show the notice again
		clock = 0;
		const c2 = createReadAloudController(deps);
		c2.setEngine("google");
		assert.equal(c2.getState().engine, "system");
		clock = 11_000;
		served = 0;
		c2.speak(["Later."], { language: "en" });
		await flush();
		assert.equal(g.requests.at(-1), "Later.", "Google is tried again once the limit is over");
		c2.dispose();
	});

	it("never stays on Stop: a chunk that never arrives hands over to system voices", async () => {
		const sys = mockSystem();
		const timers: { fn: () => void; ms: number }[] = [];
		const g = fakeGoogle(() => new Promise<GoogleAudioResult>(() => {}));
		const c = createReadAloudController({
			synthesis: sys.synthesis, Utterance: sys.Utterance, cancelGapMs: 0, google: g.client, createAudio: (u) => new FakeAudio(u),
			fetchTimeoutMs: 5_000,
			scheduleTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
			cancelTimer: () => {},
		});
		c.setEngine("google");
		c.speak(["Stuck."], { language: "en" });
		assert.equal(c.getState().speaking, true);
		timers.find((t) => t.ms === 5_000)!.fn();
		assert.deepEqual(sys.spoken.map((u) => u.text), ["Stuck."]);
		c.dispose();
	});

	it("the playback watchdog stops a chunk that never ends; Stop pauses and releases", async () => {
		const sys = mockSystem();
		const timers: { fn: () => void; ms: number; id: number }[] = [];
		const cancelled = new Set<unknown>();
		const g = fakeGoogle((t) => ok(t));
		const c = createReadAloudController({
			synthesis: sys.synthesis, Utterance: sys.Utterance, cancelGapMs: 0, google: g.client, createAudio: (u) => new FakeAudio(u),
			watchdogMinMs: 1_000, watchdogMsPerChar: 0,
			scheduleTimer: (fn, ms) => { timers.push({ fn, ms, id: timers.length + 1 }); return timers.length; },
			cancelTimer: (h) => cancelled.add(h),
		});
		c.setEngine("google");
		c.speak(["Hangs."], { language: "en" });
		await flush();
		const watchdog = timers.find((t) => t.ms === 1_000 && !cancelled.has(t.id))!;
		watchdog.fn();
		assert.equal(c.getState().speaking, false);
		assert.equal(FakeAudio.all[0]!.paused, true);
		assert.deepEqual(g.released, ["Hangs."]);

		c.speak(["Stop me."], { language: "en" });
		await flush();
		c.stop();
		assert.equal(c.getState().speaking, false);
		assert.equal(FakeAudio.all[1]!.paused, true);
		assert.ok(g.released.includes("Stop me."));
		c.dispose();
	});

	it("prefetch warms only the first chunk, and only with Google", () => {
		const sys = mockSystem();
		const g = fakeGoogle(() => ok("u"));
		const c = createReadAloudController({ synthesis: sys.synthesis, Utterance: sys.Utterance, cancelGapMs: 0, google: g.client });
		c.prefetch(LONG, { language: "en" });
		assert.equal(g.prefetched.length, 0);
		c.setEngine("google");
		c.prefetch(LONG, { language: "nb" });
		assert.equal(g.prefetched.length, 1);
		assert.ok(LONG.join(" ").startsWith(g.prefetched[0]!));
		c.dispose();
	});

	it("is ready with Google even when the system has no voices", () => {
		const g = fakeGoogle(() => ok("u"));
		const c = createReadAloudController({ synthesis: null, Utterance: null, google: g.client });
		assert.equal(c.getState().status, "unsupported");
		c.setEngine("google");
		assert.equal(c.getState().status, "ready");
		c.dispose();
	});
});

describe("question button with Google voices", () => {
	let host: HTMLElement;
	let root: Root;
	beforeEach(() => {
		FakeAudio.all = [];
		resetReadAloudSession();
		clearAutoReadHistory();
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		host.remove();
	});

	it("reads through Google, and shows the limit notice quietly after a quota hit", async () => {
		const sys = mockSystem();
		const g = fakeGoogle(() => fail("quota"));
		const deps = { synthesis: sys.synthesis, Utterance: sys.Utterance, cancelGapMs: 0, google: g.client, createAudio: (u: string) => new FakeAudio(u) };
		await act(async () =>
			root.render(<QuestionReadAloud questionId="q1" question="What is two plus two?" active settingsOverride={{ autoRead: false, rate: 1, voice: null, engine: "google" }} controllerDeps={deps} />),
		);
		const button = host.querySelector<HTMLButtonElement>('[data-testid="question-read-aloud"]')!;
		assert.equal(button.getAttribute("data-speech-engine"), "google");
		await act(async () => button.click());
		await act(async () => flush());
		assert.equal(g.requests.length, 1);
		assert.ok(sys.spoken.length > 0, "system voices read it");
		const notice = host.querySelector('[data-testid="question-read-aloud-notice"]');
		assert.equal(notice?.textContent, GOOGLE_TTS_LIMIT_NOTICE);
		assert.equal(notice?.getAttribute("role"), "status");
	});
});

describe("Settings → Read aloud with Google voices", () => {
	let host: HTMLElement;
	let root: Root;

	const status = (source: ReadAloudStatus["key"]["source"], verified = false): ReadAloudStatus => ({
		key: { source },
		verified,
		keyUrl: "https://aistudio.google.com/apikey",
		privacyNote: "PRIVACY NOTE",
		models: GOOGLE_TTS_MODELS,
		voices: GOOGLE_TTS_VOICES,
		defaults: { model: GOOGLE_TTS_DEFAULT_MODEL, voices: GOOGLE_TTS_DEFAULT_VOICES },
	});

	function client(over: Partial<ReadAloudClient> & { statusValue?: ReadAloudStatus | null } = {}) {
		const log: string[] = [];
		const c: ReadAloudClient = {
			status: async () => over.statusValue === undefined ? status(null) : over.statusValue,
			saveKey: async (k) => {
				log.push(`save:${k}`);
				return { error: null };
			},
			test: async () => {
				log.push("test");
				return { ok: true };
			},
			preview: async (_t, language, voice, model) => {
				log.push(`preview:${language}:${voice}:${model}`);
				return { ok: true, url: "blob:x", release: () => log.push("release") };
			},
			play: async () => {
				log.push("play");
			},
			...over,
		};
		return { c, log };
	}

	beforeEach(() => {
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		host.remove();
	});

	const q = <T extends Element = HTMLElement>(id: string) => host.querySelector<T>(`[data-testid="${id}"]`);

	it("without a key: System voices by default; choosing Google asks for a key with a link", async () => {
		const { c } = client();
		const updates: GeneralSettings[] = [];
		await act(async () => root.render(<ReadAloudSection general={{}} onChange={(n) => updates.push(n)} client={c} />));
		await act(async () => flush());
		assert.equal(q<HTMLSelectElement>("select-read-aloud-engine")!.value, "system");
		assert.equal(q("row-read-aloud-key"), null);

		await act(async () => root.render(<ReadAloudSection general={{ readAloudEngine: "google" }} onChange={(n) => updates.push(n)} client={c} />));
		await act(async () => flush());
		assert.equal(q("read-aloud-key-state")!.getAttribute("data-state"), "none");
		assert.equal(q("read-aloud-key-state")!.textContent, "Not set");
		assert.ok(q("read-aloud-key-input"));
		assert.equal(q<HTMLAnchorElement>("read-aloud-key-link")!.getAttribute("href"), "https://aistudio.google.com/apikey");
		assert.match(q("read-aloud-privacy")!.textContent ?? "", /PRIVACY NOTE/);
		assert.equal(q<HTMLButtonElement>("read-aloud-preview-en")!.disabled, true, "no preview without a key");
	});

	it("saving a key stores it with the converter, then tests it: testing → working", async () => {
		let resolveTest!: (v: { ok: true }) => void;
		let current = status(null);
		const { c, log } = client({
			status: async () => current,
			saveKey: async (k) => {
				log.push(`save:${k}`);
				current = status("own");
				return { error: null };
			},
			test: () => new Promise((r) => { log.push("test"); resolveTest = r; }),
		});
		await act(async () => root.render(<ReadAloudSection general={{ readAloudEngine: "google" }} onChange={() => {}} client={c} />));
		await act(async () => flush());
		const input = q<HTMLInputElement>("read-aloud-key-input")!;
		await act(async () => {
			let proto: object | null = Object.getPrototypeOf(input);
			let setter: ((v: string) => void) | undefined;
			while (proto && !setter) {
				setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
				proto = Object.getPrototypeOf(proto);
			}
			setter!.call(input, "AIzaSyTESTKEY12345678");
			input.dispatchEvent(new window.Event("input", { bubbles: true }));
		});
		await act(async () => q<HTMLButtonElement>("read-aloud-key-save")!.click());
		await act(async () => flush());
		assert.deepEqual(log.slice(0, 2), ["save:AIzaSyTESTKEY12345678", "test"]);
		assert.equal(q("read-aloud-key-state")!.getAttribute("data-state"), "testing");
		assert.ok(q("read-aloud-unverified"));
		current = status("own", true);
		await act(async () => resolveTest({ ok: true }));
		await act(async () => flush());
		assert.equal(q("read-aloud-key-state")!.getAttribute("data-state"), "working");
		assert.equal(q("read-aloud-unverified"), null);
	});

	it("a failed test shows the error notice with Try again", async () => {
		let attempt = 0;
		const { c } = client({
			statusValue: status("provider"),
			test: async () => (++attempt === 1 ? { ok: false, kind: "auth", error: "Google refused the key (HTTP 403)" } : { ok: true }),
		});
		await act(async () => root.render(<ReadAloudSection general={{}} onChange={() => {}} client={c} />));
		await act(async () => flush());
		assert.equal(q<HTMLSelectElement>("select-read-aloud-engine")!.value, "google", "a key makes Google the default");
		assert.equal(q("read-aloud-key-state")!.getAttribute("data-state"), "untested");
		assert.match(q("read-aloud-key-hint")!.textContent ?? "", /Google provider key/);
		await act(async () => q<HTMLButtonElement>("read-aloud-key-test")!.click());
		await act(async () => flush());
		assert.equal(q("read-aloud-key-state")!.getAttribute("data-state"), "failed");
		assert.ok(q("read-aloud-test-error"));
		assert.match(q("read-aloud-test-error-detail")!.textContent ?? "", /403/);
		await act(async () => q<HTMLButtonElement>("read-aloud-test-error-retry")!.click());
		await act(async () => flush());
		assert.equal(q("read-aloud-key-state")!.getAttribute("data-state"), "working");
		assert.equal(q("read-aloud-test-error"), null);
	});

	it("voice per language with a ▶ preview; quality and voice choices are saved", async () => {
		const { c, log } = client({ statusValue: status("own", true) });
		const updates: GeneralSettings[] = [];
		await act(async () => root.render(<ReadAloudSection general={{ readAloudVoices: { nb: "Kore" } }} onChange={(n) => updates.push(n)} client={c} />));
		await act(async () => flush());
		assert.equal(q("read-aloud-key-state")!.getAttribute("data-state"), "working");
		assert.equal(q<HTMLSelectElement>("select-read-aloud-google-voice-en")!.value, GOOGLE_TTS_DEFAULT_VOICES.en);
		assert.equal(q<HTMLSelectElement>("select-read-aloud-google-voice-nb")!.value, "Kore");
		assert.equal(q<HTMLSelectElement>("select-read-aloud-google-voice-en")!.querySelectorAll("option").length, 30);
		await act(async () => q<HTMLButtonElement>("read-aloud-preview-nb")!.click());
		await act(async () => flush());
		assert.deepEqual(log, [`preview:nb:Kore:${GOOGLE_TTS_DEFAULT_MODEL}`, "play", "release"]);

		const change = (id: string, value: string) => {
			const select = q<HTMLSelectElement>(id)!;
			Object.defineProperty(select, "value", { configurable: true, writable: true, value });
			select.dispatchEvent(new window.Event("change", { bubbles: true }));
		};
		await act(async () => change("select-read-aloud-model", GOOGLE_TTS_MODELS[1]!.id));
		assert.equal(updates.at(-1)!.readAloudModel, GOOGLE_TTS_MODELS[1]!.id);
		await act(async () => change("select-read-aloud-google-voice-en", "Puck"));
		assert.deepEqual(updates.at(-1)!.readAloudVoices, { nb: "Kore", en: "Puck" });
		await act(async () => change("select-read-aloud-engine", "system"));
		assert.equal(updates.at(-1)!.readAloudEngine, "system");
	});

	it("a failed preview shows the error notice under its voice", async () => {
		const { c } = client({ statusValue: status("own", true), preview: async () => ({ ok: false, error: "429 rate limited" }) });
		await act(async () => root.render(<ReadAloudSection general={{}} onChange={() => {}} client={c} />));
		await act(async () => flush());
		await act(async () => q<HTMLButtonElement>("read-aloud-preview-en")!.click());
		await act(async () => flush());
		assert.ok(q("read-aloud-preview-error-en"));
		assert.match(q("read-aloud-preview-error-en")!.textContent ?? "", /busy/);
	});
});
