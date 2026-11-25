import React, { act } from "react";
(globalThis as { React?: typeof React }).React = React;
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { kbdEventForAction, type QuestionAnswerData } from "../src/core/index.ts";
import {
	createSpeechController,
	DEFAULT_CANCEL_GAP_MS,
	pickSpeechVoice,
	utteranceWatchdogMs,
	type SpeechSynthesisLike,
	type SpeechUtteranceLike,
	type SpeechVoiceLike,
} from "../components/speech-controller.ts";
import { clearAutoReadHistory, QuestionReadAloud, speechOptionsFromQuestion } from "../components/question-read-aloud.tsx";
import { QuestionDock, questionCardStandIn } from "../components/question-dock.tsx";
import { ToolContentResponse } from "../components/ai-elements/message.tsx";
import { markdownToSpeech } from "../src/core/speech-text.ts";

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

function createMockSynthesis(initialVoices: SpeechVoiceLike[]) {
	let voices = [...initialVoices];
	const spoken: MockUtterance[] = [];
	const events: string[] = [];
	const listeners = new Set<() => void>();
	let cancels = 0;
	let resumes = 0;

	const synthesis: SpeechSynthesisLike = {
		getVoices: () => voices,
		speak: (u) => {
			events.push(`speak:${u.text}`);
			spoken.push(u as MockUtterance);
		},
		cancel: () => {
			events.push("cancel");
			cancels++;
		},
		resume: () => {
			events.push("resume");
			resumes++;
		},
		addEventListener: (type, fn) => {
			if (type === "voiceschanged") listeners.add(fn);
		},
		removeEventListener: (type, fn) => {
			if (type === "voiceschanged") listeners.delete(fn);
		},
	};

	return {
		synthesis,
		Utterance: MockUtterance,
		spoken,
		events,
		get cancels() {
			return cancels;
		},
		get resumes() {
			return resumes;
		},
		setVoices(next: SpeechVoiceLike[]) {
			voices = [...next];
			for (const fn of listeners) fn();
		},
		finishLast() {
			const last = spoken[spoken.length - 1];
			last?.onend?.({});
		},
	};
}

function createFakeTimers() {
	let nextId = 1;
	const pending = new Map<number, { fn: () => void; ms: number; active: boolean }>();
	return {
		pending,
		scheduleTimer(fn: () => void, ms: number) {
			const id = nextId++;
			pending.set(id, { fn, ms, active: true });
			return id;
		},
		cancelTimer(handle: unknown) {
			const entry = pending.get(handle as number);
			if (entry) entry.active = false;
			pending.delete(handle as number);
		},
		fireNext() {
			const first = pending.entries().next();
			if (first.done) return false;
			const [id, entry] = first.value;
			pending.delete(id);
			if (entry.active) entry.fn();
			return true;
		},
	};
}

const VOICES: SpeechVoiceLike[] = [
	{ voiceURI: "en-local", name: "Samantha", lang: "en-US", default: true, localService: true },
	{ voiceURI: "en-alt", name: "Daniel", lang: "en-GB", default: false, localService: true },
	{ voiceURI: "nb-local", name: "Nora", lang: "nb-NO", default: false, localService: true },
	{ voiceURI: "fr-remote", name: "Thomas", lang: "fr-FR", default: false, localService: false },
];

describe("pickSpeechVoice and SpeechController", () => {
	it("chooses lesson language voice, respects explicit voice only when language matches, and falls back sensibly (Item 11)", () => {
		assert.equal(pickSpeechVoice(VOICES, "en", null)?.voiceURI, "en-local");
		assert.equal(pickSpeechVoice(VOICES, "nb", null)?.voiceURI, "nb-local");
		// Explicit voice matching lesson language is respected:
		assert.equal(pickSpeechVoice(VOICES, "en", "en-alt")?.voiceURI, "en-alt");
		// Explicit voice whose language does NOT match lesson language is overridden by a lesson-matching voice:
		assert.equal(pickSpeechVoice(VOICES, "en", "nb-local")?.voiceURI, "en-local");
		assert.equal(pickSpeechVoice(VOICES, "nb", "en-local")?.voiceURI, "nb-local");
		// Fallback when no Norwegian voice is installed: explicit voice or system default is used
		const enOnly = VOICES.filter((v) => v.lang.startsWith("en"));
		assert.equal(pickSpeechVoice(enOnly, "nb", null)?.voiceURI, "en-local");
		assert.equal(pickSpeechVoice(enOnly, "nb", "en-alt")?.voiceURI, "en-alt");
	});

	it("speaks utterances sequentially, applies rate, retains active utterance ref, and stops promptly mid-sequence", () => {
		const mock = createMockSynthesis(VOICES);
		const ctl = createSpeechController({ synthesis: mock.synthesis, Utterance: mock.Utterance, cancelGapMs: 0 });

		assert.equal(ctl.getState().status, "ready");
		assert.equal(ctl.getActiveUtterance(), null);
		assert.equal(ctl.speak(["First sentence.", "Second sentence."], { language: "nb", rate: 1.25 }), true);
		assert.equal(ctl.getState().speaking, true);
		assert.equal(mock.spoken.length, 1);
		assert.equal(mock.spoken[0]!.text, "First sentence.");
		assert.equal(mock.spoken[0]!.voice?.voiceURI, "nb-local");
		assert.equal(mock.spoken[0]!.rate, 1.25);
		assert.equal(ctl.getActiveUtterance(), mock.spoken[0]);

		mock.finishLast();
		assert.equal(mock.spoken.length, 2);
		assert.equal(mock.spoken[1]!.text, "Second sentence.");
		assert.equal(ctl.getActiveUtterance(), mock.spoken[1]);

		// Stop mid-sequence
		ctl.stop();
		assert.equal(ctl.getState().speaking, false);
		assert.equal(ctl.getActiveUtterance(), null);
		assert.ok(mock.cancels >= 2);
		// Late onend from cancelled utterance must not advance
		mock.finishLast();
		assert.equal(mock.spoken.length, 2);
		ctl.dispose();
	});

	it("waits cancelGapMs between cancel and speak, calls resume before speak, and stops stalled utterances via watchdog (Item 5)", () => {
		const mock = createMockSynthesis(VOICES);
		const timers = createFakeTimers();
		const ctl = createSpeechController({
			synthesis: mock.synthesis,
			Utterance: mock.Utterance,
			scheduleTimer: timers.scheduleTimer,
			cancelTimer: timers.cancelTimer,
		});

		// Verify watchdog scales with utterance length and inverse rate
		assert.ok(utteranceWatchdogMs("a".repeat(200), 1) > utteranceWatchdogMs("short", 1));
		assert.ok(utteranceWatchdogMs("a".repeat(200), 0.75) > utteranceWatchdogMs("a".repeat(200), 1.5));

		// Start speaking: cancel runs immediately, speak waits for the gap timer
		assert.equal(ctl.speak(["Hello world."], { language: "en", rate: 1 }), true);
		assert.equal(ctl.getState().speaking, true);
		assert.equal(mock.cancels, 1);
		assert.equal(mock.spoken.length, 0, "speak must wait for the cancel gap");
		assert.equal(timers.pending.size, 1);
		assert.equal([...timers.pending.values()][0]!.ms, DEFAULT_CANCEL_GAP_MS);

		// Fire gap timer -> resume() then speak(), and watchdog timer is scheduled
		assert.equal(timers.fireNext(), true);
		assert.deepEqual(mock.events, ["cancel", "resume", "speak:Hello world."]);
		assert.equal(ctl.getActiveUtterance(), mock.spoken[0]);
		assert.equal(timers.pending.size, 1, "watchdog timer should be armed");

		// Simulate Chromium/Electron stall (neither onend nor onerror fires): watchdog fires and resets speaking to false
		assert.equal(timers.fireNext(), true);
		assert.equal(ctl.getState().speaking, false);
		assert.equal(ctl.getActiveUtterance(), null);
		assert.equal(mock.cancels, 2);

		// Stop during cancel gap prevents speak() from running at all
		assert.equal(ctl.speak(["Cancelled before gap."], { language: "en", rate: 1 }), true);
		assert.equal(timers.pending.size, 1);
		ctl.stop();
		assert.equal(timers.pending.size, 0);
		assert.equal(mock.spoken.length, 1);
		ctl.dispose();
	});

	it("handles late-loading voices via voiceschanged", () => {
		const mock = createMockSynthesis([]);
		const ctl = createSpeechController({ synthesis: mock.synthesis, Utterance: mock.Utterance, cancelGapMs: 0 });
		assert.equal(ctl.getState().status, "no-voices");

		mock.setVoices(VOICES);
		assert.equal(ctl.getState().status, "ready");
		assert.equal(ctl.getState().voices.length, VOICES.length);
		ctl.dispose();
	});
});

describe("QuestionReadAloud component", () => {
	let host: HTMLElement;
	let root: Root;

	beforeEach(() => {
		clearAutoReadHistory();
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		host.remove();
		Object.defineProperty(document, "hidden", { configurable: true, value: false });
		clearAutoReadHistory();
	});

	it("shows a disabled button with visible aria-describedby reason and touch target class when unavailable (Item 12)", async () => {
		await act(async () =>
			root.render(
				<QuestionReadAloud
					questionId="q-unsupported"
					question="Hello?"
					active
					settingsOverride={{ autoRead: false, rate: 1, voice: null }}
					controllerDeps={{ synthesis: null, Utterance: null, cancelGapMs: 0 }}
				/>,
			),
		);
		const btn = host.querySelector<HTMLButtonElement>('[data-testid="question-read-aloud"]')!;
		const reason = host.querySelector<HTMLElement>('[data-testid="question-read-aloud-reason"]')!;
		assert.ok(btn, "button stays visible rather than hidden silently");
		assert.ok(btn.classList.contains("lh-touch"), "button carries the app touch-target class");
		assert.equal(btn.disabled, true);
		assert.equal(btn.getAttribute("aria-pressed"), null, "must not combine aria-pressed with changing label");
		assert.ok(reason, "disabled reason is visible text, not title-only");
		assert.match(reason.textContent ?? "", /unavailable/i);
		assert.equal(btn.getAttribute("aria-describedby"), reason.id);

		const noVoices = createMockSynthesis([]);
		await act(async () =>
			root.render(
				<QuestionReadAloud
					questionId="q-novoices"
					question="Hello?"
					active
					settingsOverride={{ autoRead: false, rate: 1, voice: null }}
					controllerDeps={{ synthesis: noVoices.synthesis, Utterance: noVoices.Utterance, cancelGapMs: 0 }}
				/>,
			),
		);
		const btn2 = host.querySelector<HTMLButtonElement>('[data-testid="question-read-aloud"]')!;
		const reason2 = host.querySelector<HTMLElement>('[data-testid="question-read-aloud-reason"]')!;
		assert.equal(btn2.disabled, true);
		assert.match(reason2.textContent ?? "", /no system speech voices/i);
		assert.equal(btn2.getAttribute("aria-describedby"), reason2.id);

		// Late voices enable the button and remove the disabled reason
		await act(async () => noVoices.setVoices(VOICES));
		assert.equal(btn2.disabled, false);
		assert.equal(host.querySelector('[data-testid="question-read-aloud-reason"]'), null);
		assert.equal(btn2.getAttribute("aria-describedby"), null);
	});

	it("toggles Play/Stop via changing label (no aria-pressed) on click/shortcut, recovers via watchdog, and cancels on lifecycle events (Items 5 & 12)", async () => {
		const mock = createMockSynthesis(VOICES);
		const timers = createFakeTimers();
		const renderWith = async (questionId: string, active = true) => {
			await act(async () =>
				root.render(
					<QuestionReadAloud
						questionId={questionId}
						question={`Question ${questionId}?`}
						options={[{ letter: "A", label: "First" }, { letter: "B", label: "Second" }]}
						language="en"
						active={active}
						settingsOverride={{ autoRead: false, rate: 1.5, voice: null }}
						controllerDeps={{
							synthesis: mock.synthesis,
							Utterance: mock.Utterance,
							cancelGapMs: 0,
							scheduleTimer: timers.scheduleTimer,
							cancelTimer: timers.cancelTimer,
						}}
					/>,
				),
			);
		};

		await renderWith("q1", true);
		const btn = () => host.querySelector<HTMLButtonElement>('[data-testid="question-read-aloud"]')!;
		assert.equal(btn().disabled, false);
		assert.equal(btn().getAttribute("aria-pressed"), null);
		assert.equal(btn().getAttribute("aria-label"), "Read question aloud");
		assert.equal(btn().textContent, "Read aloud");

		// Click starts speaking
		await act(async () => btn().click());
		assert.equal(btn().getAttribute("aria-pressed"), null);
		assert.equal(btn().getAttribute("aria-label"), "Stop reading question");
		assert.equal(btn().textContent, "Stop");
		assert.equal(mock.spoken[0]!.text, "Question q1?");
		assert.equal(mock.spoken[0]!.rate, 1.5);

		// Watchdog firing returns button cleanly to Read aloud (never stuck on Stop)
		await act(async () => { timers.fireNext(); });
		assert.equal(btn().getAttribute("aria-label"), "Read question aloud");
		assert.equal(btn().textContent, "Read aloud");

		// Keyboard shortcut starts speaking again, then stops
		await act(async () => {
			window.dispatchEvent(new window.CustomEvent(kbdEventForAction("read-question-aloud")));
		});
		assert.equal(btn().textContent, "Stop");
		await act(async () => {
			window.dispatchEvent(new window.CustomEvent(kbdEventForAction("read-question-aloud")));
		});
		assert.equal(btn().textContent, "Read aloud");

		// Start again -> Question change cancels speech
		await act(async () => btn().click());
		assert.equal(btn().textContent, "Stop");
		await renderWith("q2", true);
		assert.equal(btn().textContent, "Read aloud");

		// Start again, then hide app window -> cancels
		await act(async () => btn().click());
		assert.equal(btn().textContent, "Stop");
		Object.defineProperty(document, "hidden", { configurable: true, value: true });
		await act(async () => {
			document.dispatchEvent(new window.Event("visibilitychange"));
		});
		assert.equal(btn().textContent, "Read aloud");
		Object.defineProperty(document, "hidden", { configurable: true, value: false });

		// Start again, then collapse dock (active=false) -> cancels
		await act(async () => btn().click());
		assert.equal(btn().textContent, "Stop");
		await renderWith("q2", false);
		assert.equal(btn().textContent, "Read aloud");

		// Start again, then unmount -> cancels
		await renderWith("q2", true);
		await act(async () => btn().click());
		const cancelsBeforeUnmount = mock.cancels;
		await act(async () => root.unmount());
		assert.ok(mock.cancels > cancelsBeforeUnmount);
	});

	it("auto-reads a new pending question once and does not re-read on re-render or dock remount (Item 11)", async () => {
		const mock = createMockSynthesis(VOICES);
		const renderQ = async (questionId: string, active: boolean, extraOptionLabel = "Alpha") => {
			await act(async () =>
				root.render(
					<QuestionReadAloud
						questionId={questionId}
						question={`Stem ${questionId}.`}
						options={[{ letter: "A", label: extraOptionLabel }]}
						active={active}
						settingsOverride={{ autoRead: true, rate: 1, voice: null }}
						controllerDeps={{ synthesis: mock.synthesis, Utterance: mock.Utterance, cancelGapMs: 0 }}
					/>,
				),
			);
		};

		// While collapsed (unrevealed teach check), auto-read must NOT fire
		await renderQ("q-auto-1", false);
		assert.equal(mock.spoken.length, 0);

		// Once revealed/active, auto-read fires once
		await renderQ("q-auto-1", true);
		assert.equal(mock.spoken.length, 1);
		assert.equal(mock.spoken[0]!.text, "Stem q-auto-1.");

		// Finish and re-render same questionId -> must NOT re-read
		await act(async () => {
			mock.finishLast();
			mock.finishLast();
		});
		const countAfterFinish = mock.spoken.length;
		await renderQ("q-auto-1", true, "Alpha");
		assert.equal(mock.spoken.length, countAfterFinish);

		// Unmount and remount for the SAME pending questionId (restored draft / reopened chat) -> must NOT re-read
		await act(async () => root.unmount());
		root = createRoot(host);
		await renderQ("q-auto-1", true, "Alpha");
		assert.equal(mock.spoken.length, countAfterFinish, "remounting for the same pending question must not auto-read again");

		// New questionId -> auto-reads once
		await renderQ("q-auto-2", true);
		assert.equal(mock.spoken.length, countAfterFinish + 1);
		assert.equal(mock.spoken[mock.spoken.length - 1]!.text, "Stem q-auto-2.");
	});
});

describe("ToolContentResponse and markdownToSpeech hidden-content parity (Item 1)", () => {
	const hiddenCases: Array<{ name: string; md: string; secrets: string[]; visible?: string[] }> = [
		{
			name: "inline HTML comment",
			md: "Which is right?<!-- SECRET_INLINE_COMMENT --> Pick one.",
			secrets: ["SECRET_INLINE_COMMENT"],
			visible: ["Which is right?", "Pick one."],
		},
		{
			name: "multiline HTML comment",
			md: "Start.\n<!--\nSECRET_MULTI_1\nSECRET_MULTI_2\n-->\nEnd.",
			secrets: ["SECRET_MULTI_1", "SECRET_MULTI_2"],
			visible: ["Start.", "End."],
		},
		{
			name: "collapsed details with summary",
			md: "Question.<details><summary>Hint</summary>SECRET_COLLAPSED_HINT</details>",
			secrets: ["SECRET_COLLAPSED_HINT"],
			visible: ["Question.", "Hint"],
		},
		{
			name: "collapsed details without summary",
			md: "Prompt.<details>SECRET_NO_SUMMARY</details>",
			secrets: ["SECRET_NO_SUMMARY"],
			visible: ["Prompt."],
		},
		{
			name: "nested collapsed details inside open details",
			md: "<details open><summary>Outer</summary>Outer visible <details><summary>Inner</summary>SECRET_INNER_HINT</details></details>",
			secrets: ["SECRET_INNER_HINT"],
			visible: ["Outer", "Outer visible", "Inner"],
		},
		{
			name: "script element",
			md: "Before <script>SECRET_SCRIPT()</script> After",
			secrets: ["SECRET_SCRIPT"],
			visible: ["Before", "After"],
		},
		{
			name: "style element",
			md: "Before <style>.x { content: 'SECRET_STYLE'; }</style> After",
			secrets: ["SECRET_STYLE"],
			visible: ["Before", "After"],
		},
		{
			name: "template element",
			md: "Before <template>SECRET_TEMPLATE</template> After",
			secrets: ["SECRET_TEMPLATE"],
			visible: ["Before", "After"],
		},
		{
			name: "unclosed figure fence",
			md: "Inspect:\n```plot\nSECRET_PLOT_SOURCE\naxes x 0..5",
			secrets: ["SECRET_PLOT_SOURCE"],
			visible: ["Inspect:"],
		},
		{
			name: "GitHub alert marker",
			md: "> [!IMPORTANT]\n> Remember units.",
			secrets: ["[!IMPORTANT]"],
			visible: ["Remember units."],
		},
	];

	function visibleTextFromRenderedHtml(html: string): string {
		const frag = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
		const walk = (node: Node): string => {
			if (node.nodeType === 8) return ""; // comment
			if (node.nodeType === 3) return node.textContent ?? "";
			if (node.nodeType !== 1) return "";
			const el = node as Element;
			const tag = el.tagName.toLowerCase();
			if (tag === "script" || tag === "style" || tag === "template") return "";
			if (tag === "details" && !el.hasAttribute("open")) {
				const summary = el.querySelector(":scope > summary");
				return summary ? walk(summary) : "";
			}
			return [...el.childNodes].map(walk).join(" ");
		};
		return walk(frag.document.body).replace(/\s+/g, " ").trim();
	}

	it("never speaks text that is hidden when rendered by ToolContentResponse", () => {
		for (const c of hiddenCases) {
			const html = renderToStaticMarkup(<ToolContentResponse>{c.md}</ToolContentResponse>);
			const renderedVisible = visibleTextFromRenderedHtml(html);
			const spoken = markdownToSpeech(c.md);

			for (const secret of c.secrets) {
				assert.ok(!spoken.includes(secret), `[${c.name}] speech leaked hidden text: ${secret} -> ${spoken}`);
				if (c.name !== "style element") {
					// style text is stripped from speech too even if rehype-sanitize unwraps <style> in HTML
					assert.ok(!renderedVisible.includes(secret), `[${c.name}] rendered visible unexpectedly included: ${secret}`);
				}
			}
			for (const expected of c.visible ?? []) {
				assert.ok(renderedVisible.includes(expected), `[${c.name}] rendered visible missing: ${expected}`);
				assert.ok(spoken.includes(expected), `[${c.name}] speech missing visible text: ${expected} -> ${spoken}`);
			}
		}
	});
});

describe("QuestionDock read-aloud privacy, layout parity, and submit cancellation", () => {
	let host: HTMLElement;
	let root: Root;
	let prevSynth: PropertyDescriptor | undefined;
	let prevUtr: PropertyDescriptor | undefined;

	beforeEach(() => {
		clearAutoReadHistory();
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		prevSynth = Object.getOwnPropertyDescriptor(window, "speechSynthesis");
		prevUtr = Object.getOwnPropertyDescriptor(window, "SpeechSynthesisUtterance");
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		host.remove();
		if (prevSynth) Object.defineProperty(window, "speechSynthesis", prevSynth);
		else Reflect.deleteProperty(window, "speechSynthesis");
		if (prevUtr) Object.defineProperty(window, "SpeechSynthesisUtterance", prevUtr);
		else Reflect.deleteProperty(window, "SpeechSynthesisUtterance");
		clearAutoReadHistory();
	});

	it("speaks only displayed question/options with displayed letters, never hidden fields, and cancels on submit", async () => {
		const mock = createMockSynthesis(VOICES);
		Object.defineProperty(window, "speechSynthesis", { configurable: true, value: mock.synthesis });
		Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, value: mock.Utterance });

		const submitted: QuestionAnswerData[] = [];
		const quizInput = {
			question: "Which planet is closest to the sun?<!-- SECRET_HTML_COMMENT -->",
			details: "Think of the inner solar system. <details><summary>Hint</summary>SECRET_DETAILS_HINT</details>",
			options: [
				{ label: "Venus", description: "SECRET_OPTION_DESCRIPTION" },
				{ label: "Mercury", description: "SECRET_CORRECT_DESCRIPTION" },
			],
			correctAnswer: "Mercury",
			explanation: "SECRET_EXPLANATION_NEVER_SPEAK",
			lead: "SECRET_TUTOR_LEAD_PLANNING",
		};

		await act(async () =>
			root.render(
				<QuestionDock
					toolName="quiz"
					toolCallId="privacy-q1"
					input={quizInput as never}
					language="nb"
					expanded
					dictationClaim={false}
					onExpand={() => {}}
					onSubmit={(a) => { submitted.push(a); }}
				/>,
			),
		);

		const readBtn = host.querySelector<HTMLButtonElement>('[data-testid="question-read-aloud"]')!;
		assert.ok(readBtn);
		assert.equal(readBtn.disabled, false);

		await act(async () => readBtn.click());
		// Wait past the default cancel-to-speak gap so speech actually starts
		await act(async () => {
			await new Promise((r) => setTimeout(r, DEFAULT_CANCEL_GAP_MS + 25));
		});
		// Drain all queued utterances
		for (let i = 0; i < 10 && mock.spoken.length > i; i++) {
			await act(async () => mock.finishLast());
		}

		const allSpoken = mock.spoken.map((u) => u.text).join(" ");
		assert.match(allSpoken, /Which planet is closest to the sun\?/);
		assert.match(allSpoken, /Think of the inner solar system\./);
		assert.match(allSpoken, /A:/);
		assert.match(allSpoken, /B:/);
		assert.match(allSpoken, /Mercury/);
		assert.match(allSpoken, /Venus/);
		assert.equal(mock.spoken[0]!.voice?.voiceURI, "nb-local");

		// Hidden fields and hidden Markdown MUST NEVER appear in spoken utterances
		assert.ok(!allSpoken.includes("SECRET_HTML_COMMENT"));
		assert.ok(!allSpoken.includes("SECRET_DETAILS_HINT"));
		assert.ok(!allSpoken.includes("SECRET_EXPLANATION_NEVER_SPEAK"));
		assert.ok(!allSpoken.includes("SECRET_TUTOR_LEAD_PLANNING"));
		assert.ok(!allSpoken.includes("SECRET_OPTION_DESCRIPTION"));
		assert.ok(!allSpoken.includes("SECRET_CORRECT_DESCRIPTION"));

		// Start speaking again, then submit via "I don't know" -> speech cancels
		await act(async () => readBtn.click());
		const cancelsBeforeSubmit = mock.cancels;
		const dontKnow = host.querySelector<HTMLButtonElement>('[data-testid="dont-know-button"]')!;
		await act(async () => dontKnow.click());
		assert.equal(submitted.length, 1);
		assert.ok(mock.cancels > cancelsBeforeSubmit, "submitting cancels active speech");
	});

	it("keeps the pending question part's label row and flow height identical to questionCardStandIn (Item 8)", async () => {
		const mock = createMockSynthesis(VOICES);
		Object.defineProperty(window, "speechSynthesis", { configurable: true, value: mock.synthesis });
		Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, value: mock.Utterance });

		const quizInput = {
			question: "What is 2 + 2?",
			options: [{ label: "3" }, { label: "4" }],
			correctAnswer: "4",
			explanation: "2 + 2 equals 4.",
		};

		await act(async () =>
			root.render(
				<QuestionDock
					toolName="quiz"
					toolCallId="layout-parity-q1"
					input={quizInput as never}
					expanded
					dictationClaim={false}
					onExpand={() => {}}
					onSubmit={() => {}}
				/>,
			),
		);

		const questionPart = host.querySelector<HTMLElement>('[data-question-part]')!;
		assert.ok(questionPart);
		const live = (html: string) => { const el = document.createElement("div"); el.innerHTML = html; return el; };
		const standIn = questionCardStandIn(document as unknown as Document, {
			label: "Check",
			kind: "quiz",
			multiSelect: false,
			question: live("<p>What is 2 + 2?</p>"),
			context: null,
			options: [live("<p>3</p>"), live("<p>4</p>")],
		});

		// Pending label row keeps the exact same class as questionCardStandIn (no flex / button height inflation)
		const pendingLabel = questionPart.firstElementChild as HTMLElement;
		const standInLabel = standIn.question.firstElementChild as HTMLElement;
		assert.equal(pendingLabel.className, standInLabel.className);
		assert.equal(pendingLabel.querySelector('[data-testid="question-read-aloud"]'), null);

		// The read-aloud control sits out of normal flow (absolute) so it does not change [data-question-part] height
		const readAloudWrapper = host.querySelector<HTMLElement>('[data-testid="question-read-aloud"]')!.parentElement!;
		assert.ok(readAloudWrapper.classList.contains("absolute"), "read-aloud control must be out of normal document flow");
	});

	it("builds speech options inside question-read-aloud with displayed letters and hides quiz descriptions (Item 9)", () => {
		const qd = {
			question: "Q",
			mode: "single-select",
			optionOrder: { A: 2, B: 1 },
			options: [
				{ value: "v2", label: "Second", description: "Desc 2" },
				{ value: "v1", label: "First", description: "Desc 1" },
			],
		} as never;
		const quizOpts = speechOptionsFromQuestion(qd, "quiz");
		assert.deepEqual(quizOpts, [
			{ letter: "A", label: "Second", description: undefined },
			{ letter: "B", label: "First", description: undefined },
		]);
		const askOpts = speechOptionsFromQuestion(qd, "ask");
		assert.deepEqual(askOpts, [
			{ letter: "A", label: "Second", description: "Desc 2" },
			{ letter: "B", label: "First", description: "Desc 1" },
		]);
	});
});
