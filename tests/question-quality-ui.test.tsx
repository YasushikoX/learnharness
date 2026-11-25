/**
 * WP6 rendering (2026-11-25): the answered written question's key points (unmarked, then marked met/missed once the
 * tutor's next question records the verdict) and the shown figure's "Look at" / "Try this" notes, labelled in the
 * lesson language. Static markup, no DOM (see render-cards.test.tsx for the classic-JSX shim).
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AnsweredCard } from "../components/answered-card.tsx";
import { ShowFigureCard } from "../components/artifacts/show-figure-card.tsx";
import { QuestionDock } from "../components/question-dock.tsx";
import { LessonLanguageContext } from "../components/lesson-language.tsx";
import { buildAnswer, type QuestionData } from "../src/core/question-core.ts";
import { buildSubagentSteer } from "../src/core/contracts.ts";
import { projectView } from "../src/core/view.ts";

const explainArgs = {
	type: "check", nodeId: "n1", level: "apply", conceptIds: ["spring constant"], lead: "Now use it.",
	question: "What is $k$?", correctAnswer: "$k=200\\,\\text{N/m}$.",
	keyPoints: ["uses k = F/x", "converts cm to m", "states 200 N/m"],
};
const qd = (keyPoints?: string[]): QuestionData => ({
	id: "e1", kind: "explain", question: explainArgs.question, mode: "text", options: [], committedAnswer: explainArgs.correctAnswer,
	...(keyPoints ? { keyPoints } : {}), createdAt: "t",
});

describe("the answered card's key points", () => {
	it("are listed unmarked after the answer, before the tutor's verdict", () => {
		const answer = buildAnswer(qd(explainArgs.keyPoints), { text: "200" }, "explain");
		const html = renderToStaticMarkup(<AnsweredCard answer={answer} input={explainArgs} />);
		assert.match(html, /data-testid="answered-key-points" data-graded="false"/);
		assert.match(html, /Key points/);
		assert.equal(html.split('data-key-point="unmarked"').length - 1, 3);
		assert.match(html, /converts cm to m/);
	});

	it("are marked met and missed once the verdict exists", () => {
		const answer = buildAnswer(qd(explainArgs.keyPoints), { text: "200" }, "explain");
		const html = renderToStaticMarkup(<AnsweredCard answer={answer} input={explainArgs} keyPointsMet={new Set([1, 3])} />);
		assert.match(html, /data-graded="true"/);
		assert.equal(html.split('data-key-point="met"').length - 1, 2);
		assert.equal(html.split('data-key-point="missed"').length - 1, 1);
		assert.match(html, /missing from your answer/);
	});

	it("\"I don't know\" reveals them; the label follows the lesson language", () => {
		const answer = buildAnswer(qd(explainArgs.keyPoints), { dontKnow: true }, "explain");
		const html = renderToStaticMarkup(
			<LessonLanguageContext.Provider value="nb">
				<AnsweredCard answer={answer} input={explainArgs} />
			</LessonLanguageContext.Provider>,
		);
		assert.match(html, /Nøkkelpunkter/);
		assert.match(html, /states 200 N\/m/);
	});

	it("an old answered explain (no key points anywhere) renders exactly as before", () => {
		const oldArgs = { type: "check", nodeId: "n1", lead: "L", question: "Why?", correctAnswer: "Because." };
		const answer = buildAnswer({ ...qd(), question: "Why?", committedAnswer: "Because." }, { text: "x" }, "explain");
		const html = renderToStaticMarkup(<AnsweredCard answer={answer} input={oldArgs} />);
		assert.doesNotMatch(html, /answered-key-points/);
		assert.match(html, /The answer: /);
	});

	it("the pending card never shows them", () => {
		const html = renderToStaticMarkup(<QuestionDock toolName="explain" toolCallId="e1" input={explainArgs as never} expanded onExpand={() => {}} onSubmit={() => {}} />);
		assert.match(html, /What is/);
		assert.doesNotMatch(html, /converts cm to m|Key points/);
	});
});

describe("the figure card's notes", () => {
	const showFigure = (kind: "visual" | "demo", args: Record<string, unknown>) => {
		const steer = kind === "visual"
			? buildSubagentSteer({ id: "jv", kind: "visual", toolCallId: "cv" }, { svg: "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"40\" height=\"20\"></svg>" })
			: buildSubagentSteer({ id: "jv", kind: "demo", toolCallId: "cd" }, { title: "Damping", html: "<html><body>x</body></html>", tested: true });
		const call = { id: "a_show", role: "assistant", content: [{ type: "toolCall", id: "call-show", name: "show_figure", arguments: args }], api: "faux", provider: "faux", model: "faux", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 };
		const result = { id: "r_show", role: "toolResult", toolCallId: "call-show", toolName: "show_figure", content: [{ type: "text", text: "Shown." }], details: { jobId: "jv", kind }, isError: false, timestamp: 3 };
		return projectView([steer, call, result] as never).flatMap((m) => m.parts).find((p) => p.type === "tool-show_figure");
	};

	it("a visual shows its Look at points, labelled; tryThis is not shown on a visual", () => {
		const html = renderToStaticMarkup(<ShowFigureCard part={showFigure("visual", { figure: "jv", lookAt: ["the dashed curve: no feedback", "the solid curve: with feedback"], tryThis: "ignored" }) as never} />);
		assert.match(html, /data-testid="figure-look-at"/);
		assert.match(html, /Look at/);
		assert.match(html, /the dashed curve: no feedback/);
		assert.doesNotMatch(html, /figure-try-this|ignored/);
	});

	it("a demo shows Look at and Try this, in Norwegian in a Norwegian lesson", () => {
		const html = renderToStaticMarkup(
			<LessonLanguageContext.Provider value="nb">
				<ShowFigureCard part={showFigure("demo", { figure: "jv", lookAt: ["toppen av oversvingen"], tryThis: "Dra dempingen til 0. Gjett først: mer eller mindre oversving?" }) as never} />
			</LessonLanguageContext.Provider>,
		);
		assert.match(html, /Se på/);
		assert.match(html, /Prøv dette/);
		assert.match(html, /Gjett først/);
	});

	it("an old show_figure call without notes renders as before", () => {
		for (const kind of ["visual", "demo"] as const) {
			const html = renderToStaticMarkup(<ShowFigureCard part={showFigure(kind, { figure: "jv", caption: "The band" }) as never} />);
			assert.doesNotMatch(html, /figure-notes/, kind);
			assert.match(html, /The band/, kind);
		}
	});
});
