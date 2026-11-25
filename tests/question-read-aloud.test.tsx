import React, { act } from "react";
(globalThis as { React?: typeof React }).React = React;
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { kbdEventForAction, type QuestionAnswerData } from "../src/core/index.ts";
import {
	createSpeechController,
	pickSpeechVoice,
	type SpeechSynthesisLike,
	type SpeechUtteranceLike,
	type SpeechVoiceLike,
} from "../components/speech-controller.ts";
import { QuestionReadAloud } from "../components/question-read-aloud.tsx";
import { QuestionDock } from "../components/question-dock.tsx";

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
	const listeners = new Set<() => void>();
	let cancels = 0;

	const synthesis: SpeechSynthesisLike = {
		getVoices: () => voices,
		speak: (u) => {
			spoken.push(u as MockUtterance);
		},
		cancel: () => {
			cancels++;
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
		get cancels() {
			return cancels;
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

const VOICES: SpeechVoiceLike[] = [
	{ voiceURI: "en-local", name: "Samantha", lang: "en-US", default: true, localService: true },
	{ voiceURI: "nb-local", name: "Nora", lang: "nb-NO", default: false, localService: true },
	{ voiceURI: "fr-remote", name: "Thomas", lang: "fr-FR", default: false, localService: false },
];

describe("pickSpeechVoice and SpeechController", () => {
	it("chooses lesson language voice (en and nb), respects explicit voice, and falls back sensibly", () => {
		assert.equal(pickSpeechVoice(VOICES, "en", null)?.voiceURI, "en-local");
		assert.equal(pickSpeechVoice(VOICES, "nb", null)?.voiceURI, "nb-local");
		assert.equal(pickSpeechVoice(VOICES, "en", "nb-local")?.voiceURI, "nb-local");
		// Fallback when no Norwegian voice is installed
		const enOnly = VOICES.filter((v) => v.lang.startsWith("en"));
		assert.equal(pickSpeechVoice(enOnly, "nb", null)?.voiceURI, "en-local");
	});

	it("speaks utterances sequentially, applies rate, and stops promptly mid-sequence", () => {
		const mock = createMockSynthesis(VOICES);
		const ctl = createSpeechController({ synthesis: mock.synthesis, Utterance: mock.Utterance });

		assert.equal(ctl.getState().status, "ready");
		assert.equal(ctl.speak(["First sentence.", "Second sentence."], { language: "nb", rate: 1.25 }), true);
		assert.equal(ctl.getState().speaking, true);
		assert.equal(mock.spoken.length, 1);
		assert.equal(mock.spoken[0]!.text, "First sentence.");
		assert.equal(mock.spoken[0]!.voice?.voiceURI, "nb-local");
		assert.equal(mock.spoken[0]!.rate, 1.25);

		mock.finishLast();
		assert.equal(mock.spoken.length, 2);
		assert.equal(mock.spoken[1]!.text, "Second sentence.");

		// Stop mid-sequence
		ctl.stop();
		assert.equal(ctl.getState().speaking, false);
		assert.ok(mock.cancels >= 2);
		// Late onend from cancelled utterance must not advance
		mock.finishLast();
		assert.equal(mock.spoken.length, 2);
		ctl.dispose();
	});

	it("handles late-loading voices via voiceschanged", () => {
		const mock = createMockSynthesis([]);
		const ctl = createSpeechController({ synthesis: mock.synthesis, Utterance: mock.Utterance });
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
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		host.remove();
		Object.defineProperty(document, "hidden", { configurable: true, value: false });
	});

	it("shows a disabled button with explanation when speechSynthesis is unsupported or has no voices", async () => {
		await act(async () =>
			root.render(
				<QuestionReadAloud
					questionId="q-unsupported"
					question="Hello?"
					active
					settingsOverride={{ autoRead: false, rate: 1, voice: null }}
					controllerDeps={{ synthesis: null, Utterance: null }}
				/>,
			),
		);
		const btn = host.querySelector<HTMLButtonElement>('[data-testid="question-read-aloud"]')!;
		assert.ok(btn, "button stays visible rather than hidden silently");
		assert.equal(btn.disabled, true);
		assert.match(btn.title, /unavailable/i);
		assert.match(btn.getAttribute("aria-label") ?? "", /unavailable/i);

		const noVoices = createMockSynthesis([]);
		await act(async () =>
			root.render(
				<QuestionReadAloud
					questionId="q-novoices"
					question="Hello?"
					active
					settingsOverride={{ autoRead: false, rate: 1, voice: null }}
					controllerDeps={{ synthesis: noVoices.synthesis, Utterance: noVoices.Utterance }}
				/>,
			),
		);
		const btn2 = host.querySelector<HTMLButtonElement>('[data-testid="question-read-aloud"]')!;
		assert.equal(btn2.disabled, true);
		assert.match(btn2.title, /no system speech voices/i);

		// Late voices enable the button
		await act(async () => noVoices.setVoices(VOICES));
		assert.equal(btn2.disabled, false);
	});

	it("toggles Play/Stop on click and keyboard shortcut, and cancels on question change, collapse, hidden window, and unmount", async () => {
		const mock = createMockSynthesis(VOICES);
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
						controllerDeps={{ synthesis: mock.synthesis, Utterance: mock.Utterance }}
					/>,
				),
			);
		};

		await renderWith("q1", true);
		const btn = () => host.querySelector<HTMLButtonElement>('[data-testid="question-read-aloud"]')!;
		assert.equal(btn().disabled, false);
		assert.equal(btn().getAttribute("aria-pressed"), "false");

		// Click starts speaking
		await act(async () => btn().click());
		assert.equal(btn().getAttribute("aria-pressed"), "true");
		assert.equal(mock.spoken[0]!.text, "Question q1?");
		assert.equal(mock.spoken[0]!.rate, 1.5);

		// Keyboard shortcut stops speaking
		await act(async () => {
			window.dispatchEvent(new window.CustomEvent(kbdEventForAction("read-question-aloud")));
		});
		assert.equal(btn().getAttribute("aria-pressed"), "false");

		// Keyboard shortcut starts speaking again
		await act(async () => {
			window.dispatchEvent(new window.CustomEvent(kbdEventForAction("read-question-aloud")));
		});
		assert.equal(btn().getAttribute("aria-pressed"), "true");

		// Question change cancels speech
		await renderWith("q2", true);
		assert.equal(btn().getAttribute("aria-pressed"), "false");

		// Start again, then hide app window → cancels
		await act(async () => btn().click());
		assert.equal(btn().getAttribute("aria-pressed"), "true");
		Object.defineProperty(document, "hidden", { configurable: true, value: true });
		await act(async () => {
			document.dispatchEvent(new window.Event("visibilitychange"));
		});
		assert.equal(btn().getAttribute("aria-pressed"), "false");
		Object.defineProperty(document, "hidden", { configurable: true, value: false });

		// Start again, then collapse dock (active=false) → cancels
		await act(async () => btn().click());
		assert.equal(btn().getAttribute("aria-pressed"), "true");
		await renderWith("q2", false);
		assert.equal(btn().getAttribute("aria-pressed"), "false");

		// Start again, then unmount → cancels
		await renderWith("q2", true);
		await act(async () => btn().click());
		const cancelsBeforeUnmount = mock.cancels;
		await act(async () => root.unmount());
		assert.ok(mock.cancels > cancelsBeforeUnmount);
	});

	it("auto-reads a new pending question once when enabled and never re-reads on re-render", async () => {
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
						controllerDeps={{ synthesis: mock.synthesis, Utterance: mock.Utterance }}
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

		// Finish and re-render same questionId → must NOT re-read
		await act(async () => {
			mock.finishLast();
			mock.finishLast();
		});
		const countAfterFinish = mock.spoken.length;
		await renderQ("q-auto-1", true, "Alpha");
		assert.equal(mock.spoken.length, countAfterFinish);

		// New questionId → auto-reads once
		await renderQ("q-auto-2", true);
		assert.equal(mock.spoken.length, countAfterFinish + 1);
		assert.equal(mock.spoken[mock.spoken.length - 1]!.text, "Stem q-auto-2.");
	});
});

describe("QuestionDock read-aloud privacy and submit cancellation", () => {
	let host: HTMLElement;
	let root: Root;
	let prevSynth: PropertyDescriptor | undefined;
	let prevUtr: PropertyDescriptor | undefined;

	beforeEach(() => {
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
	});

	it("speaks only displayed question/options with displayed letters, never hidden fields, and cancels on submit", async () => {
		const mock = createMockSynthesis(VOICES);
		Object.defineProperty(window, "speechSynthesis", { configurable: true, value: mock.synthesis });
		Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, value: mock.Utterance });

		const submitted: QuestionAnswerData[] = [];
		const quizInput = {
			question: "Which planet is closest to the sun?",
			details: "Think of the inner solar system.",
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

		// Hidden fields MUST NEVER appear in spoken utterances
		assert.ok(!allSpoken.includes("SECRET_EXPLANATION_NEVER_SPEAK"));
		assert.ok(!allSpoken.includes("SECRET_TUTOR_LEAD_PLANNING"));
		assert.ok(!allSpoken.includes("SECRET_OPTION_DESCRIPTION"));
		assert.ok(!allSpoken.includes("SECRET_CORRECT_DESCRIPTION"));

		// Start speaking again, then submit via "I don't know" → speech cancels
		await act(async () => readBtn.click());
		const cancelsBeforeSubmit = mock.cancels;
		const dontKnow = host.querySelector<HTMLButtonElement>('[data-testid="dont-know-button"]')!;
		await act(async () => dontKnow.click());
		assert.equal(submitted.length, 1);
		assert.ok(mock.cancels > cancelsBeforeSubmit, "submitting cancels active speech");
	});
});
