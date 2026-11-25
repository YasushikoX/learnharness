import React, { act } from "react";
(globalThis as { React?: typeof React }).React = React;
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";
import type { QuestionAnswerData, SketchPayload } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
Object.defineProperty(dom.document, "oninput", { configurable: true, value: null });
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	Event: dom.window.Event,
	CustomEvent: dom.window.CustomEvent,
	KeyboardEvent: dom.window.KeyboardEvent ?? dom.window.Event,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0) as unknown as number,
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	ResizeObserver: class {
		observe() {}
		disconnect() {}
	},
});
(dom.window.HTMLElement.prototype as unknown as { getContext: () => null }).getContext = () => null;

const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const { CONFIDENCE_STOPS, parseExplainInput, resolveTheme } = await import("../src/core/index.ts");
const { placementGraderPrompt } = await import("../src/agent/subagents/placement-grader.ts");
const { AppearanceProvider, resolveAppearance, useAppearance } = await import("../components/settings/appearance.tsx");
const { CONFIDENCE_COLORS, confidenceColor, confidenceRailStyle } = await import("../components/confidence-rail.tsx");
const { clampConfidenceStep, CONFIDENCE_SLIDER_MIN } = await import("../components/confidence-slider.tsx");
const { QuestionDock } = await import("../components/question-dock.tsx");
const { PracticeDock } = await import("../components/practice-dock.tsx");
const { AnsweredCard } = await import("../components/answered-card.tsx");
const { SketchView } = await import("../components/sketch/sketch-view.tsx");
const { writeInk } = await import("../components/sketch/ink-memory.ts");
const { InteractionLayersProvider } = await import("../components/interaction-layers.tsx");

const QUIZ_INPUT = {
	question: "Which planet is closest to the sun?",
	options: [{ label: "Venus" }, { label: "Mercury" }],
	correctAnswer: "Mercury",
	explanation: "Mercury is the innermost planet.",
};

function setRangeValue(input: HTMLInputElement, value: number) {
	Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, String(value));
	input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
}

describe("confidenceColor and confidenceRailStyle", () => {
	it("preserves exact hex colors at every stop and interpolates smoothly for intermediate values", () => {
		for (let i = 0; i < CONFIDENCE_STOPS.length; i++) {
			assert.equal(confidenceColor(CONFIDENCE_STOPS[i]!), CONFIDENCE_COLORS[i]);
		}
		const mid = confidenceColor(65);
		assert.match(mid, /^#[0-9a-f]{6}$/);
		assert.notEqual(mid, CONFIDENCE_COLORS[2]);
		assert.notEqual(mid, CONFIDENCE_COLORS[3]);

		const unsetStyle = confidenceRailStyle(null);
		assert.match(String(unsetStyle.backgroundImage), /transparent 0%, transparent 100%/);
		const setStyle = confidenceRailStyle(65);
		assert.match(String(setStyle.backgroundImage), /65%/);
	});
});

describe("QuestionDock confidence slider mode (default)", () => {
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
	});

	it("defaults to slider mode, enforces minimum 5 (reserving 0 for I don't know), blocks submit while unset, steps by 5, and submits exact value (Item 10)", async () => {
		assert.equal(resolveAppearance(undefined).confidenceControl, "slider");
		assert.equal(CONFIDENCE_SLIDER_MIN, 5);
		assert.equal(clampConfidenceStep(0), 5);
		assert.equal(clampConfidenceStep(2), 5);

		const answers: QuestionAnswerData[] = [];
		await act(async () =>
			root.render(
				<QuestionDock
					toolName="quiz"
					toolCallId="slider-q1"
					input={QUIZ_INPUT}
					expanded
					dictationClaim={false}
					onExpand={() => {}}
					onSubmit={(a) => { answers.push(a); }}
				/>,
			),
		);

		const slider = host.querySelector<HTMLInputElement>('[data-testid="confidence-slider"]')!;
		const readout = host.querySelector<HTMLElement>('[data-testid="confidence-readout"]')!;
		const submitBtn = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
		assert.ok(slider, "slider renders by default");
		assert.equal(host.querySelector('[data-testid="confidence-buttons"]'), null, "buttons not rendered in slider mode");
		assert.equal(slider.getAttribute("min"), "5");
		assert.equal(slider.getAttribute("aria-valuemin"), "5");
		assert.equal(slider.getAttribute("max"), "100");
		assert.equal(slider.getAttribute("step"), "5");
		assert.equal(readout.textContent, "—", "starts unset");
		assert.equal(submitBtn.disabled, true, "submit disabled before pick and confidence");

		// Pick Mercury: still blocked until confidence is set
		const mercury = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent?.includes("Mercury"))!;
		await act(async () => mercury.click());
		assert.equal(submitBtn.disabled, true, "submit still blocked while confidence is unset");

		// Keyboard stepping on slider: ArrowRight from unset → 55, ArrowRight → 60, ArrowRight → 65 (no double step!)
		await act(async () => {
			slider.dispatchEvent(Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key: "ArrowRight" }));
		});
		assert.equal(readout.textContent, "55%");
		await act(async () => {
			slider.dispatchEvent(Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key: "ArrowRight" }));
		});
		assert.equal(readout.textContent, "60%");
		await act(async () => {
			slider.dispatchEvent(Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key: "ArrowRight" }));
		});
		assert.equal(readout.textContent, "65%");
		assert.equal(submitBtn.disabled, false, "submit enabled once both pick and confidence are set");

		// Home → 5% (never 0%), ArrowLeft at 5% stays 5%, End → 100%, then set back to 65% via range change
		await act(async () => {
			slider.dispatchEvent(Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Home" }));
		});
		assert.equal(readout.textContent, "5%");
		await act(async () => {
			slider.dispatchEvent(Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key: "ArrowLeft" }));
		});
		assert.equal(readout.textContent, "5%");
		await act(async () => {
			slider.dispatchEvent(Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key: "End" }));
		});
		assert.equal(readout.textContent, "100%");
		await act(async () => setRangeValue(slider, 65));
		assert.equal(readout.textContent, "65%");

		// Keys 1-5 must NOT auto-submit in slider mode
		await act(async () => {
			document.dispatchEvent(Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key: "3" }));
		});
		assert.equal(answers.length, 0);

		// Submit sends exact 65
		assert.ok(submitBtn.closest("form"));
		await act(async () => {
			submitBtn.closest("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
		});
		assert.equal(answers.length, 1);
		assert.equal(answers[0]!.confidence, 65);
		assert.equal(answers[0]!.correct, true);
		assert.equal(answers[0]!.answers[0]!.value, "Mercury");

		// AnsweredCard displays step-of-5 value cleanly with ConfidenceRail
		const cardHtml = renderToStaticMarkup(<AnsweredCard answer={answers[0]!} input={QUIZ_INPUT} />);
		assert.match(cardHtml, /data-testid="confidence-rail"/);
		assert.match(cardHtml, /65%/);
	});

	it("supports pressing 0 for I don't know in slider mode as well as clicking the button (Item 10)", async () => {
		const answers: QuestionAnswerData[] = [];
		await act(async () =>
			root.render(
				<QuestionDock
					toolName="quiz"
					toolCallId="slider-dk-key"
					input={QUIZ_INPUT}
					expanded
					dictationClaim={false}
					onExpand={() => {}}
					onSubmit={(a) => { answers.push(a); }}
				/>,
			),
		);
		// Key 0 submits "I don't know" in slider mode
		await act(async () => {
			document.dispatchEvent(Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key: "0" }));
		});
		assert.equal(answers.length, 1);
		assert.equal(answers[0]!.dontKnow, true);
		assert.equal(answers[0]!.confidence, undefined);

		// Clicking the button also works without setting confidence
		const dk = host.querySelector<HTMLButtonElement>('[data-testid="dont-know-button"]')!;
		assert.equal(dk.disabled, false);
		await act(async () => dk.click());
		assert.equal(answers.length, 2);
		assert.equal(answers[1]!.dontKnow, true);
		assert.equal(answers[1]!.confidence, undefined);
	});

	it("keeps placement recall unchanged from main in both slider and buttons modes: no skill kept, no confidence control, no confidence sent to grader (Item 3)", async () => {
		const rawRecall = {
			question: "State the chain rule.",
			correctAnswer: "(f(g(x)))' = f'(g(x))g'(x)",
			skill: "chain-rule",
			type: "recall",
		};
		const parsed = parseExplainInput(rawRecall);
		assert.ok(parsed);
		assert.equal("skill" in parsed ? (parsed as Record<string, unknown>).skill : undefined, undefined, "parseExplainInput must strip skill just like main");

		for (const mode of ["slider", "buttons"] as const) {
			const recallAnswers: QuestionAnswerData[] = [];
			await act(async () =>
				root.render(
					<AppearanceProvider initialAppearance={{ confidenceControl: mode }} initialTheme={resolveTheme(undefined)}>
						<QuestionDock
							toolName="recall"
							toolCallId={`placement-recall-${mode}`}
							input={rawRecall as never}
							expanded
							dictationClaim={false}
							onExpand={() => {}}
							onSubmit={(a) => { recallAnswers.push(a); }}
						/>
					</AppearanceProvider>,
				),
			);
			assert.equal(host.querySelector('[data-testid="confidence-slider"]'), null, `no confidence slider on recall in ${mode} mode`);
			assert.equal(host.querySelector('[data-testid="confidence-buttons"]'), null, `no confidence buttons on recall in ${mode} mode`);
			assert.equal(host.querySelector('[data-testid="confidence-row"]'), null, `no confidence row on recall in ${mode} mode`);

			const submitBtn = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
			const editor = host.querySelector<HTMLElement>('[data-testid="answer-field"] [data-file-path-input]')!;
			await act(async () => {
				editor.textContent = "f'(g(x)) * g'(x)";
				editor.dispatchEvent(new window.Event("input", { bubbles: true }));
			});
			assert.equal(submitBtn.disabled, false, `placement recall submits without confidence in ${mode} mode`);
			await act(async () => {
				submitBtn.closest("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
			});
			assert.equal(recallAnswers.length, 1);
			assert.equal(recallAnswers[0]!.confidence, undefined);

			const graderText = placementGraderPrompt({
				skill: { id: "chain-rule", name: "Chain rule" },
				toolName: "recall",
				question: rawRecall.question,
				correctAnswer: rawRecall.correctAnswer,
				...(recallAnswers[0]!.confidence !== undefined ? { confidence: recallAnswers[0]!.confidence } : {}),
				...(recallAnswers[0]!.text ? { text: recallAnswers[0]!.text } : {}),
			});
			assert.ok(!graderText.includes("Stated confidence"), `grader prompt must not receive confidence in ${mode} mode`);
		}
	});

	it("submits photo answer with I don't know cleanly in both buttons and slider modes (Item 10)", async () => {
		const canvasProto = Object.getPrototypeOf(document.createElement("canvas")) as Record<string, unknown>;
		const prevBitmap = (globalThis as Record<string, unknown>).createImageBitmap;
		const prevGetContext = canvasProto.getContext;
		const prevToBlob = canvasProto.toBlob;
		const prevCreateUrl = URL.createObjectURL;
		const prevRevokeUrl = URL.revokeObjectURL;
		const prevFileReader = (globalThis as Record<string, unknown>).FileReader;

		(globalThis as Record<string, unknown>).createImageBitmap = async () => ({
			width: 800,
			height: 600,
			close() {},
		});
		canvasProto.getContext = () => ({
			drawImage() {},
		});
		canvasProto.toBlob = (cb: (b: Blob | null) => void) => {
			cb(new Blob(["jpeg-bytes"], { type: "image/jpeg" }));
		};
		URL.createObjectURL = () => "blob:mock-photo";
		URL.revokeObjectURL = () => {};
		(globalThis as Record<string, unknown>).FileReader = class MockFileReader {
			result: string | null = null;
			onload: (() => void) | null = null;
			onerror: (() => void) | null = null;
			readAsDataURL() {
				this.result = "data:image/jpeg;base64,/9j/4AAQ";
				queueMicrotask(() => this.onload?.());
			}
		};

		try {
			for (const mode of ["buttons", "slider"] as const) {
				const received: Array<{ answer: QuestionAnswerData; sketch?: SketchPayload }> = [];
				await act(async () =>
					root.render(
						<AppearanceProvider initialAppearance={{ confidenceControl: mode }} initialTheme={resolveTheme(undefined)}>
							<QuestionDock
								toolName="quiz"
								toolCallId={`photo-dk-${mode}`}
								input={QUIZ_INPUT}
								expanded
								dictationClaim={false}
								onExpand={() => {}}
								onSubmit={(a, sketch) => { received.push({ answer: a, sketch }); }}
							/>
						</AppearanceProvider>,
					),
				);

				const fileInput = host.querySelector<HTMLInputElement>('[data-testid="camera-input"]')!;
				assert.ok(fileInput, "camera file input exists");
				const fakeFile = new File(["img"], "work.jpg", { type: "image/jpeg" });
				Object.defineProperty(fileInput, "files", { configurable: true, value: [fakeFile] });
				await act(async () => {
					fileInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
					await new Promise((r) => setTimeout(r, 20));
				});

				const dk = host.querySelector<HTMLButtonElement>('[data-testid="dont-know-button"]')!;
				await act(async () => {
					dk.click();
					await new Promise((r) => setTimeout(r, 10));
				});

				assert.equal(received.length, 1, `photo + I don't know must submit in ${mode} mode`);
				assert.equal(received[0]!.answer.dontKnow, true);
				assert.equal(received[0]!.answer.confidence, undefined);
				assert.ok(received[0]!.answer.sketch, "answer carries sketch ref for photo");
				assert.equal(received[0]!.sketch?.producer, "photo");
			}
		} finally {
			(globalThis as Record<string, unknown>).createImageBitmap = prevBitmap;
			canvasProto.getContext = prevGetContext;
			canvasProto.toBlob = prevToBlob;
			URL.createObjectURL = prevCreateUrl;
			URL.revokeObjectURL = prevRevokeUrl;
			(globalThis as Record<string, unknown>).FileReader = prevFileReader;
		}
	});

	it("keeps written explain questions free of confidence slider and preserves wordingOnly hiding", async () => {
		const html = renderToStaticMarkup(
			<QuestionDock
				toolName="explain"
				toolCallId="exp-1"
				input={{ question: "Explain conservation of momentum.", correctAnswer: "Total momentum is constant.", type: "final" } as never}
				expanded
				onExpand={() => {}}
				onSubmit={() => {}}
			/>,
		);
		assert.ok(!html.includes('data-testid="confidence-slider"'));
		assert.ok(html.includes('data-testid="final-problem-row"'));
		assert.match(html, /Submit answer/);

		const wordingHtml = renderToStaticMarkup(
			<QuestionDock
				toolName="quiz"
				toolCallId="wording-1"
				input={QUIZ_INPUT}
				wordingOnly
				expanded
				onExpand={() => {}}
				onSubmit={() => {}}
			/>,
		);
		assert.match(wordingHtml, /class="[^"]*hidden[^"]*"[^>]*data-testid="confidence-row"/);
	});

	it("switches live between slider and buttons via AppearanceProvider", async () => {
		let setMode!: (mode: "slider" | "buttons") => void;
		function Harness() {
			const { onAppearanceChange } = useAppearance();
			setMode = (mode) => onAppearanceChange({ confidenceControl: mode });
			return (
				<QuestionDock
					toolName="quiz"
					toolCallId="switch-q"
					input={QUIZ_INPUT}
					expanded
					dictationClaim={false}
					onExpand={() => {}}
					onSubmit={() => {}}
				/>
			);
		}
		await act(async () =>
			root.render(
				<AppearanceProvider initialAppearance={undefined} initialTheme={resolveTheme(undefined)}>
					<Harness />
				</AppearanceProvider>,
			),
		);
		assert.ok(host.querySelector('[data-testid="confidence-slider"]'));
		assert.ok(host.querySelector('button[type="submit"]'));

		await act(async () => setMode("buttons"));
		assert.equal(host.querySelector('[data-testid="confidence-slider"]'), null);
		assert.ok(host.querySelector('[data-testid="confidence-buttons"]'));
		assert.equal(host.querySelector('button[type="submit"]'), null);

		await act(async () => setMode("slider"));
		assert.ok(host.querySelector('[data-testid="confidence-slider"]'));
		assert.ok(host.querySelector('button[type="submit"]'));
	});

	it("keeps practice problems on confidence buttons even when slider mode is active (Item 13)", async () => {
		await act(async () =>
			root.render(
				<InteractionLayersProvider>
					<AppearanceProvider initialAppearance={{ confidenceControl: "slider" }} initialTheme={resolveTheme(undefined)}>
						<PracticeDock
							problemCallId="prac-1"
							input={{ statement: "Solve $2x = 6$.", title: "Linear equation" } as never}
							expanded
							onExpand={() => {}}
							onSubmit={async () => true}
						/>
					</AppearanceProvider>
				</InteractionLayersProvider>,
			),
		);
		const editor = host.querySelector<HTMLElement>('[data-file-path-input]')!;
		assert.ok(editor);
		await act(async () => {
			editor.textContent = "x = 3";
			editor.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
		});
		const submitBtn = host.querySelector<HTMLButtonElement>('[data-testid="practice-send"]')!;
		assert.ok(submitBtn);
		await act(async () => submitBtn.click());
		assert.ok(host.querySelector('[data-testid="practice-confidence-row"]'), "practice problem uses button stops row");
		assert.equal(host.querySelector('[data-testid="confidence-slider"]'), null, "practice problem does not render slider");
	});

	it("supports sketch submission in slider mode with exact 5–100 confidence", async () => {
		const inkKey = "sketch-slider-test";
		writeInk(inkKey, {
			strokes: [{ points: [10, 10, 0.5, 90, 50, 0.6], size: 4 }],
			undo: [],
			redo: [],
		});
		let submittedVal: number | undefined;
		await act(async () =>
			root.render(
				<InteractionLayersProvider>
					<SketchView
						label="Question"
						statement="Draw your work."
						inkKey={inkKey}
						confidenceLevels
						confidenceMode="slider"
						onClose={() => {}}
						onSubmit={async (_payload: SketchPayload, _idx, accepted, val) => {
							submittedVal = val;
							accepted?.();
							return true;
						}}
					/>
				</InteractionLayersProvider>,
			),
		);
		const submitBtn = document.body.querySelector<HTMLButtonElement>('[data-testid="sketch-submit"]')!;
		await act(async () => submitBtn.click());

		const slider = document.body.querySelector<HTMLInputElement>('[data-testid="sketch-confidence-slider"]')!;
		const confirm = document.body.querySelector<HTMLButtonElement>('[data-testid="sketch-confidence-submit"]')!;
		assert.ok(slider, "sketch toolbar shows confidence slider");
		assert.equal(slider.getAttribute("min"), "5");
		assert.equal(confirm.disabled, true, "sketch submit waits until confidence is set");

		await act(async () => setRangeValue(slider, 75));
		assert.equal(confirm.disabled, false);
		await act(async () => confirm.click());
		assert.equal(submittedVal, 75);
	});
});
