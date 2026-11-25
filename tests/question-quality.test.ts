/**
 * WP6 (2026-11-25): written answers by default, required key points / concept ids / level, explained figures, the
 * give-away option check and the one refusal budget. Faux-provider driven, no network. Owns its LH_DATA_DIR (the
 * prompt-override pins write override files there).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { Value } from "typebox/value";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, getCurrentTools, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import type { QuestionData } from "../src/core/question-core.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-question-quality-"));
process.env.LH_DATA_DIR = TMP_DATA;
after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const { PROMPTS_OVERRIDE_DIR } = await import("../config.ts");
const {
	explainInputBase, explainInputObject, probeQuizInputSchema, quizInputObject, buildAnswer, toClientQuestion, compactAnswerForModel,
} = await import("../src/core/question-core.ts");
const {
	KEY_POINTS_NEXT_TEXT, keyPointMarksOf, keyPointsOfCall, keyPointsProblems, normalizeConceptIds, normalizeKeyPoints, normalizeQuestionLevel,
	withKeyPointsForModel,
} = await import("../src/core/question-quality.ts");
const { figureNotesOf, figureNotesProblems } = await import("../src/core/figure-notes.ts");
const { lessonLabels } = await import("../src/core/lesson-labels.ts");
const { GIVEAWAY_MEDIAN_RATIO, GIVEAWAY_MIN_CHARS, giveawayOptionProblem, giveawayOptionReason } = await import("../src/core/giveaway-option.ts");
const { inputAppends } = await import("../src/core/input-events.ts");
const { newAnswerResult } = await import("../src/core/native-messages.ts");
const { answerForPresentation } = await import("../src/core/answer-presentation.ts");
const { parseQuestionInput } = await import("../src/core/tool-parts.ts");
const { projectView } = await import("../src/core/view.ts");
const { sideChatLessonDocument } = await import("../src/core/side-chat.ts");
const { buildQuestionSpeech } = await import("../src/core/speech-text.ts");
const { ANSWER_NEXT_TEXT, PROSE_GATE_REASON } = await import("../src/core/prose-gate.ts");
const { REFUSALS_PER_GATE, REFUSALS_PER_TURN, makeRefusalBudget } = await import("../src/agent/refusal-budget.ts");
const { NARRATION_GUARD_MAX_BLOCKS } = await import("../src/agent/narration-guard.ts");
const { GATE_REFUSAL_CAP, bareQuestionTools, composeInstructions, createTeacherAgent, makeGateRefusals } = await import("../src/agent/teacher-agent.ts");
const { QUIZ_FORM_RULE, WRITTEN_ANSWER_RULE, createTeacherTools, probeExplainTool, probeQuizTool, teachExplainToolFor } = await import("../src/agent/tools.ts");
const { ASK_SHOW_FIGURE_DESCRIPTION, createShowFigureTool } = await import("../src/agent/tools/show-figure.ts");
const { askTools } = await import("../src/agent/ask-agent.ts");
const { buildSubagentSteer } = await import("../src/core/contracts.ts");
const { effectivePromptSegments, allSegmentPaths } = await import("../src/agent/prompt-segments.ts");
const { TurnTimeline } = await import("../src/server/turn-timeline.ts");

// ─── fixtures ──────────────────────────────────────────────────────────────

const quizArgs = {
	type: "check",
	nodeId: "n1",
	level: "apply",
	conceptIds: ["Hooke's law"],
	lead: "Right: the spring pulls back in proportion to the stretch. Next, use that on a new case.",
	question: "A spring with $k=200\\,\\text{N/m}$ is stretched $0.05\\,\\text{m}$. Which force does it exert?",
	explanation: "$F=kx=200\\cdot0.05=10\\,\\text{N}$.",
	options: [
		{ label: "$10\\,\\text{N}$", value: "a" },
		{ label: "$4\\,\\text{N}$", value: "b" },
		{ label: "$40\\,\\text{N}$", value: "c" },
	],
	correctAnswer: "a",
};

const explainArgs = {
	type: "check",
	nodeId: "n1",
	level: "apply",
	conceptIds: ["Hooke's law", "spring constant"],
	lead: "Right. Now put the law to work.",
	question: "A spring stretches $2\\,\\text{cm}$ under $4\\,\\text{N}$. What is $k$? Give the number with its unit.",
	correctAnswer: "$k=F/x=4/0.02=200\\,\\text{N/m}$.",
	keyPoints: ["uses $k=F/x$", "converts 2 cm to 0.02 m", "$200\\,\\text{N/m}$ with the unit"],
};

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistantMsg = (id: string, content: unknown[]) => ({ id, role: "assistant", content, api: "faux", provider: "faux", model: "faux", usage, stopReason: "toolUse", timestamp: 1 });
const toolCall = (id: string, name: string, args: unknown) => ({ type: "toolCall", id, name, arguments: args });
const answerMsg = (id: string, toolCallId: string, toolName: string, details: unknown, isError = false) => ({
	id, role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: JSON.stringify(details) }], details, isError, timestamp: 2,
});
const userMsg = (id: string, text: string) => ({ id, role: "user", content: text, timestamp: 0 });

// ─── 2 + 3: the schemas ────────────────────────────────────────────────────

describe("the new required fields (schema acceptance and rejection)", () => {
	it("quiz: level and conceptIds are required; [] is a valid conceptIds; a bad level is rejected", () => {
		assert.equal(Value.Check(quizInputObject, quizArgs), true);
		assert.equal(Value.Check(quizInputObject, { ...quizArgs, conceptIds: [] }), true, "a class with no indexed material has no ids");
		const { level: _l, ...noLevel } = quizArgs;
		const { conceptIds: _c, ...noIds } = quizArgs;
		assert.equal(Value.Check(quizInputObject, noLevel), false);
		assert.equal(Value.Check(quizInputObject, noIds), false);
		assert.equal(Value.Check(quizInputObject, { ...quizArgs, level: "hard" }), false);
		for (const level of ["recall", "apply", "analyze", "transfer"]) assert.equal(Value.Check(quizInputObject, { ...quizArgs, level }), true, level);
	});

	it("explain: keyPoints is required, two to five non-empty points", () => {
		assert.equal(Value.Check(explainInputObject, explainArgs), true);
		const { keyPoints: _k, ...noPoints } = explainArgs;
		assert.equal(Value.Check(explainInputObject, noPoints), false);
		assert.equal(Value.Check(explainInputObject, { ...explainArgs, keyPoints: ["one"] }), false, "fewer than two");
		assert.equal(Value.Check(explainInputObject, { ...explainArgs, keyPoints: ["a", "b", "c", "d", "e", "f"] }), false, "more than five");
		assert.equal(Value.Check(explainInputObject, { ...explainArgs, keyPoints: ["a", ""] }), false, "an empty point");
		assert.deepEqual(keyPointsProblems(["a", "   "]), ["keyPoints has an empty point: every key point is a short statement of one thing a correct answer must contain."]);
		assert.deepEqual(keyPointsProblems(explainArgs.keyPoints), []);
		const { level: _l, ...noLevel } = explainArgs;
		assert.equal(Value.Check(explainInputObject, noLevel), false, "explain needs a level too");
	});

	it("previousKeyPoints is optional and takes point numbers", () => {
		assert.equal(Value.Check(quizInputObject, { ...quizArgs, previousKeyPoints: [1, 3] }), true);
		assert.equal(Value.Check(quizInputObject, { ...quizArgs, previousKeyPoints: [] }), true);
		assert.equal(Value.Check(quizInputObject, { ...quizArgs, previousKeyPoints: [0] }), false);
	});

	it("the probe, recall and placement schemas are unchanged: no new field", () => {
		for (const schema of [probeQuizInputSchema, explainInputBase, probeQuizTool.parameters, probeExplainTool.parameters]) {
			const keys = Object.keys((schema as { properties: Record<string, unknown> }).properties);
			for (const field of ["level", "conceptIds", "keyPoints", "previousKeyPoints"]) assert.ok(!keys.includes(field), field);
		}
	});

	it("the teach explain tool refuses blank key points in one error and accepts good ones", async () => {
		const chatStore = { getChat: () => ({ tree: { nodes: [{ id: "n1", title: "N" }] } }) } as never;
		const tool = teachExplainToolFor({ chatId: "c", chatStore });
		const bad = await tool.execute("e1", { ...explainArgs, keyPoints: ["fine", "  "] } as never, undefined);
		assert.match(JSON.stringify(bad.content), /keyPoints has an empty point/);
		const good = await tool.execute("e2", explainArgs as never, undefined);
		assert.doesNotMatch(JSON.stringify(good.content), /keyPoints/);
	});

	it("conceptIds read as opaque strings: trimmed, blanks and duplicates dropped, order kept; absent on old records", () => {
		assert.deepEqual(normalizeConceptIds([" Ohm's law", "ohm's law", "Ohm's law", "", 3, "KVL"]), ["Ohm's law", "ohm's law", "KVL"]);
		assert.deepEqual(normalizeConceptIds("[\"a\",\"a\"]"), ["a"], "the string-encoded wobble");
		assert.deepEqual(normalizeConceptIds([]), []);
		assert.equal(normalizeConceptIds(undefined), undefined);
		assert.equal(normalizeQuestionLevel(" \"analyze\" "), "analyze");
		assert.equal(normalizeQuestionLevel("hard"), undefined);
		assert.equal(normalizeQuestionLevel(undefined), undefined);
	});
});

// ─── 1: written answers are the default ────────────────────────────────────

describe("the form rule: written answers for concept checks", () => {
	const ctx = { chatId: "c", chatStore: { getChat: () => undefined }, jobStore: {}, spawn: () => {} } as never;
	it("the tool descriptions say it, and no longer route concept checks to multiple choice", () => {
		assert.match(QUIZ_FORM_RULE, /A concept check or a calculation is an `explain`/);
		assert.match(QUIZ_FORM_RULE, /only for a prediction/);
		assert.match(QUIZ_FORM_RULE, /misconception trap/);
		assert.doesNotMatch(QUIZ_FORM_RULE, /for predictions, and for concept checks/);
		const mixed = createTeacherTools(ctx, { quizMix: true } as never);
		assert.ok(mixed.quiz!.description.endsWith(QUIZ_FORM_RULE));
		assert.ok(mixed.explain!.description.includes(WRITTEN_ANSWER_RULE));
		assert.match(WRITTEN_ANSWER_RULE, /one to three sentences, or a number with its unit, or one line of working/);
		assert.ok(!probeExplainTool.description.includes(WRITTEN_ANSWER_RULE), "recall (the prober's) is unchanged");
	});

	it("a course lesson's explain notes the final problem is not short", () => {
		const tools = createTeacherTools({ ...(ctx as object), lesson: { skill: { id: "s", name: "S" } } } as never, { quizMix: true } as never);
		assert.match(tools.explain!.description, /A final problem is the exception/);
	});
});

// ─── 2: the explain answer path ───────────────────────────────────────────

describe("key points: committed with the question, graded in the tutor's next turn", () => {
	const record = { messages: [userMsg("u1", "teach me"), assistantMsg("a1", [toolCall("e1", "explain", explainArgs)])] as never };
	const answer = (extra: Record<string, unknown>) => ({ kind: "explain", tool: "explain", questionText: explainArgs.question, dontKnow: false, answers: [], answeredAt: "t", ...extra });
	const forModel = (msgs: unknown[]) => JSON.parse(((msgs[0] as { content: Array<{ text: string }> }).content[0]!).text) as Record<string, unknown>;

	it("the tool result the tutor reads carries the numbered key points beside his answer and asks for a verdict per point", () => {
		const out = forModel(inputAppends(record, { type: "answer", toolCallId: "e1", answer: answer({ text: "k is 200 N/m" }) as never }));
		assert.equal(out.text, "k is 200 N/m");
		assert.deepEqual(out.keyPoints, ["1. uses $k=F/x$", "2. converts 2 cm to 0.02 m", "3. $200\\,\\text{N/m}$ with the unit"]);
		assert.equal(out.next, `${ANSWER_NEXT_TEXT} ${KEY_POINTS_NEXT_TEXT}`);
		assert.match(KEY_POINTS_NEXT_TEXT, /`previousKeyPoints`/);
		assert.ok(Object.keys(out).indexOf("text") < Object.keys(out).indexOf("keyPoints"), "his answer comes first");
	});

	it("the points come from the call the server holds, never from the client's answer", () => {
		const out = forModel(inputAppends(record, { type: "answer", toolCallId: "e1", answer: answer({ text: "x", keyPoints: ["forged"] }) as never }));
		assert.equal((out.keyPoints as string[]).length, 3);
	});

	it("\"I don't know\" still gets them (and the card shows them); a photo answer keeps its read-first instruction", () => {
		const dk = forModel(inputAppends(record, { type: "answer", toolCallId: "e1", answer: answer({ dontKnow: true }) as never }));
		assert.equal(dk.dontKnow, true);
		assert.equal((dk.keyPoints as string[]).length, 3);
		const photo = forModel(inputAppends(record, { type: "answer", toolCallId: "e1", answer: answer({ sketch: { id: "sk1", pages: [{ page: 1 }] } }) as never }));
		assert.match(photo.next as string, /^A sketch is attached: call read_sketch/);
		assert.ok((photo.next as string).endsWith(KEY_POINTS_NEXT_TEXT));
	});

	it("a dismissal or a steer is not an answer: no key points", () => {
		const dismissed = forModel([newAnswerResult("e1", "explain", { kind: "explain", questionText: "Q", dismissed: true, dontKnow: false, answers: [], answeredAt: "t" }, undefined, explainArgs.keyPoints)]);
		assert.equal(dismissed.keyPoints, undefined);
		assert.deepEqual(withKeyPointsForModel({ kind: "explain", dismissed: true, steer: "wait" }, ["a", "b"]), { kind: "explain", dismissed: true, steer: "wait" });
	});

	it("a quiz answer and an old explain without key points read exactly as before", () => {
		const old = { messages: [userMsg("u1", "teach me"), assistantMsg("a1", [toolCall("e1", "explain", { type: "check", nodeId: "n1", lead: "L", question: "Why?", correctAnswer: "Because." })])] as never };
		const a = answer({ text: "because" });
		const result = inputAppends(old, { type: "answer", toolCallId: "e1", answer: a as never })[0] as { content: Array<{ text: string }> };
		assert.deepEqual(JSON.parse(result.content[0]!.text), { ...compactAnswerForModel(a as never), next: ANSWER_NEXT_TEXT });
		assert.equal(keyPointsOfCall("quiz", quizArgs), undefined);
		assert.equal(keyPointsOfCall("recall", explainArgs), undefined, "only the teach explain carries them");
	});

	it("never reach the client before the answer: toClientQuestion, the side helper's open question, read-aloud", () => {
		const qd: QuestionData = { id: "e1", kind: "explain", question: explainArgs.question, mode: "text", options: [], committedAnswer: explainArgs.correctAnswer, keyPoints: explainArgs.keyPoints, createdAt: "t" };
		const client = toClientQuestion(qd);
		assert.ok(!("keyPoints" in client));
		assert.doesNotMatch(JSON.stringify(client), /converts 2 cm/);
		assert.doesNotMatch(sideChatLessonDocument(record.messages), /converts 2 cm/, "the open question's hidden half stays hidden");
		assert.doesNotMatch(buildQuestionSpeech({ question: qd.question, context: qd.context }).join(" "), /converts/);
		// once answered, the answer record carries them for the card
		assert.deepEqual(buildAnswer(qd, { dontKnow: true }, "explain").keyPoints, explainArgs.keyPoints);
	});

	it("the answered card's data: projected from the call; marked from the next question's previousKeyPoints", () => {
		const a = buildAnswer({ id: "e1", kind: "explain", question: "Q", mode: "text", options: [], createdAt: "t" }, { text: "200" }, "explain");
		assert.deepEqual(answerForPresentation(a, explainArgs).keyPoints, explainArgs.keyPoints);
		const answered = answerMsg("r1", "e1", "explain", a);
		const refused = [assistantMsg("a2", [toolCall("q2", "quiz", { ...quizArgs, previousKeyPoints: [1] })]), answerMsg("r2", "q2", "quiz", null, true)];
		const next = assistantMsg("a3", [toolCall("q3", "quiz", { ...quizArgs, previous: "partly", previousKeyPoints: [1, 3, 9] })]);
		const base = [userMsg("u1", "go"), assistantMsg("a1", [toolCall("e1", "explain", explainArgs)]), answered] as never[];
		assert.equal(keyPointMarksOf(projectView(base)).size, 0, "no verdict yet: unmarked");
		const marks = keyPointMarksOf(projectView([...base, ...refused, next] as never));
		assert.deepEqual([...marks.get("e1")!], [1, 3], "the refused call does not count; out-of-range numbers are dropped");
		const noVerdict = keyPointMarksOf(projectView([...base, assistantMsg("a3", [toolCall("q3", "quiz", quizArgs)])] as never));
		assert.equal(noVerdict.get("e1"), undefined, "a next question without previousKeyPoints leaves it unmarked");
		assert.equal(normalizeKeyPoints(undefined), undefined);
	});
});

// ─── 4: explained figures ──────────────────────────────────────────────────

describe("show_figure: lookAt on every figure, tryThis on a demo", () => {
	const visual = buildSubagentSteer({ id: "job_v", kind: "visual", toolCallId: "cv" }, { svg: "<svg xmlns=\"http://www.w3.org/2000/svg\"/>" });
	const demo = buildSubagentSteer({ id: "job_d", kind: "demo", toolCallId: "cd" }, { title: "Damping", html: "<html></html>", tested: true });
	const tool = createShowFigureTool({ messages: () => [visual, demo] });
	const run = (args: Record<string, unknown>) => tool.execute("s", args as never, undefined);

	it("lookAt is a schema rule: required, one to three points", () => {
		assert.equal(Value.Check(tool.parameters, { figure: "job_v", lookAt: ["the band"] }), true);
		assert.equal(Value.Check(tool.parameters, { figure: "job_v" }), false);
		assert.equal(Value.Check(tool.parameters, { figure: "job_v", lookAt: [] }), false);
		assert.equal(Value.Check(tool.parameters, { figure: "job_v", lookAt: ["a", "b", "c", "d"] }), false);
		assert.equal(Value.Check(tool.parameters, { figure: "job_v", lookAt: ["the band"], caption: "c" }), true, "caption stays optional");
	});

	it("a visual needs at least ten characters of lookAt and no tryThis", async () => {
		await assert.rejects(run({ figure: "job_v", lookAt: ["band"] }), /`lookAt` is too short/);
		const out = await run({ figure: "job_v", lookAt: ["the shaded band: ε"] });
		assert.deepEqual(out.content, [{ type: "text", text: "Shown: figure job_v (visual)." }]);
	});

	it("a demo without tryThis gets one error naming the field; with it, it is shown", async () => {
		await assert.rejects(run({ figure: "job_d", lookAt: ["the overshoot peak"] }), /This figure is a demo, so `tryThis` is required/);
		const out = await run({ figure: "job_d", lookAt: ["the overshoot peak"], tryThis: "Drag damping to 0. First predict: more or less overshoot?" });
		assert.deepEqual(out.content, [{ type: "text", text: "Shown: figure job_d (demo)." }]);
		assert.deepEqual(figureNotesProblems("demo", { lookAt: ["the overshoot peak"], tryThis: "Drag it." }).length, 1, "too short to hold a prediction");
	});

	it("a figure shown again still needs lookAt, which can be shorter (one point)", async () => {
		await run({ figure: "job_v", lookAt: ["the shaded band: ε"] });
		await assert.rejects(run({ figure: "job_v" } as never), /lookAt/);
		const again = await run({ figure: "job_v", lookAt: ["the band again"] });
		assert.equal(again.content[0]!.type, "text");
	});

	it("Ask uses the same fields with its own wording, free of lesson words", () => {
		const ask = askTools({}, () => []).show_figure!;
		assert.equal(ask.description, ASK_SHOW_FIGURE_DESCRIPTION);
		assert.equal(Value.Check(ask.parameters, { figure: "job_v" }), false, "lookAt applies to Ask too");
		assert.match(ASK_SHOW_FIGURE_DESCRIPTION, /`lookAt`/);
		assert.match(ASK_SHOW_FIGURE_DESCRIPTION, /`tryThis`/);
		assert.doesNotMatch(ASK_SHOW_FIGURE_DESCRIPTION, /lesson|teach|learner's answer|question you ask/i);
	});

	it("the card's notes: tryThis only on a demo; an old call has none", () => {
		assert.deepEqual(figureNotesOf({ figure: "x", lookAt: [" a ", ""], tryThis: "t" }, "visual"), { lookAt: ["a"] });
		assert.deepEqual(figureNotesOf({ figure: "x", lookAt: ["a"], tryThis: " try " }, "demo"), { lookAt: ["a"], tryThis: "try" });
		assert.deepEqual(figureNotesOf({ figure: "x" }, "demo"), { lookAt: [] });
		assert.deepEqual(figureNotesOf(undefined, "visual"), { lookAt: [] });
	});

	it("labels follow the lesson language", () => {
		assert.equal(lessonLabels("en").lookAt, "Look at");
		assert.equal(lessonLabels("nb").lookAt, "Se på");
		assert.equal(lessonLabels("nb").tryThis, "Prøv dette");
		assert.equal(lessonLabels("nb").keyPoints, "Nøkkelpunkter");
		assert.equal(lessonLabels(undefined).keyPoints, "Key points");
	});
});

// ─── 6: the give-away option ──────────────────────────────────────────────

describe("the give-away option check (40 characters, 2.5 times the median)", () => {
	const opt = (n: number, value: string) => ({ label: "x".repeat(n), value });
	const q = (lengths: number[], correct: string | string[], extra: Record<string, unknown> = {}) => ({
		...quizArgs, options: lengths.map((n, i) => opt(n, String.fromCharCode(97 + i))), correctAnswer: correct, ...extra,
	});

	it("the boundaries: over 40 characters AND over 2.5 times the median", () => {
		assert.equal(GIVEAWAY_MIN_CHARS, 40);
		assert.equal(GIVEAWAY_MEDIAN_RATIO, 2.5);
		// median of [41, 16, 16] is 16; 41 > 40 and 41 > 40 → refused
		assert.ok(giveawayOptionProblem("quiz", q([41, 16, 16], "a")));
		// 40 characters is not over the floor, however short the others
		assert.equal(giveawayOptionProblem("quiz", q([40, 2, 2], "a")), null);
		// exactly 2.5 times the median is not over it: 50 vs median 20
		assert.equal(giveawayOptionProblem("quiz", q([50, 20, 20], "a")), null);
		assert.ok(giveawayOptionProblem("quiz", q([51, 20, 20], "a")));
		// a long wrong option is not a give-away
		assert.equal(giveawayOptionProblem("quiz", q([10, 90, 10], "a")), null);
		// with two options the correct one can never exceed 2.5 times the median
		assert.equal(giveawayOptionProblem("quiz", q([200, 1], "a")), null);
		// the median counts every option: [60, 20, 20, 30] → median 25, 60 < 62.5
		assert.equal(giveawayOptionProblem("quiz", q([60, 20, 20, 30], "a")), null);
	});

	it("multi-select: each correct option is checked", () => {
		const p = giveawayOptionProblem("quiz", q([60, 12, 12, 12, 60], ["a", "e"], { multiSelect: true }));
		assert.equal(p?.options.length, 2);
		assert.equal(giveawayOptionProblem("quiz", q([60, 12, 12, 12, 60], ["b", "c"], { multiSelect: true })), null);
	});

	it("probe, placement and ask_user_question are exempt", () => {
		for (const tool of ["probe", "recall", "ask_user_question", "explain"]) assert.equal(giveawayOptionProblem(tool, q([90, 5, 5], "a")), null, tool);
	});

	it("the refusal says exactly what to change", () => {
		const reason = giveawayOptionReason(giveawayOptionProblem("quiz", q([90, 10, 10], "a"))!);
		assert.match(reason, /90 characters/);
		assert.match(reason, /median option \(10 characters\)/);
		assert.match(reason, /cut the correct option down to its bare claim/);
		assert.match(reason, /Do not mention this to the learner/);
	});
});

// ─── 7: the refusal budget ─────────────────────────────────────────────────

describe("one refusal budget: 2 per gate, 3 per turn", () => {
	it("the constants live in one place and the narration guard shares them", () => {
		assert.equal(REFUSALS_PER_GATE, 2);
		assert.equal(REFUSALS_PER_TURN, 3);
		assert.equal(GATE_REFUSAL_CAP, REFUSALS_PER_GATE);
		assert.equal(NARRATION_GUARD_MAX_BLOCKS, REFUSALS_PER_GATE);
	});

	it("per gate, in total, and the pass after exhaustion is reported", () => {
		const refusals: string[] = [];
		const passes: string[] = [];
		const refuse = makeRefusalBudget(undefined, undefined, { onRefusal: (g) => refusals.push(g), onPass: (g) => passes.push(g) });
		assert.ok(refuse("prose", true, "r"));
		assert.ok(refuse("prose", true, "r"));
		assert.equal(refuse("prose", true, "r"), undefined, "a gate's third refusal passes");
		assert.equal(refuse("visual", false, "v"), undefined, "not blocking is not counted");
		assert.ok(refuse("visual", true, "v"), "the third refusal of the turn");
		assert.equal(refuse("lead-floor", true, "l"), undefined, "the turn's budget is spent: a fresh gate passes too");
		assert.equal(refuse("narration", true, "n"), undefined);
		assert.deepEqual(refusals, ["prose", "prose", "visual"]);
		assert.deepEqual(passes, ["prose", "lead-floor", "narration"]);
		// makeGateRefusals keeps its old signature on the same budget
		const legacy = makeGateRefusals();
		assert.ok(legacy("a", true, "x"));
		assert.ok(legacy("a", true, "x"));
		assert.equal(legacy("a", true, "x"), undefined);
	});

	it("the timeline records each refusal and each pass, gate names and counts only", () => {
		const lines: unknown[] = [];
		const timeline = new TurnTimeline({ turnId: "t", chatId: "c", provider: "p", model: "m", thinking: false }, (l) => lines.push(l), () => 0);
		const refuse = makeGateRefusals(REFUSALS_PER_GATE, (g) => timeline.refuse(g), REFUSALS_PER_TURN, (g) => timeline.passOverBudget(g));
		for (let i = 0; i < 4; i++) refuse("giveaway-option", true, "secret reason text");
		timeline.finish(false);
		const line = lines[0] as { gateRefusals: Record<string, number>; refusalBudgetPasses: Record<string, number> };
		assert.deepEqual(line.gateRefusals, { "giveaway-option": 2 });
		assert.deepEqual(line.refusalBudgetPasses, { "giveaway-option": 2 });
		assert.doesNotMatch(JSON.stringify(line), /secret/);
	});

	// A live teacher, faux provider: the narration guard and the option check spend the same budget.
	const narration = () => ({ ...fauxThinking("Narration summary."), thinkingSignature: Buffer.from("synthetic-header:narration:payload").toString("base64") });
	const giveaway = { ...quizArgs, options: [{ label: "The force is exactly ten newtons, from F = kx with x in metres", value: "a" }, { label: "Four newtons", value: "b" }, { label: "Forty newtons", value: "c" }] };
	function narrationRun() {
		const faux = createFauxCore({ provider: "anthropic", models: [{ id: "claude-sonnet-5-5" }] });
		const steps: FauxResponseStep[] = [
			fauxAssistantMessage([fauxToolCall("quiz", giveaway, { id: "g1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("quiz", giveaway, { id: "g2" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([narration(), fauxToolCall("quiz", quizArgs, { id: "n1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([narration(), fauxToolCall("quiz", quizArgs, { id: "n2" })], { stopReason: "toolUse" }),
		];
		faux.setResponses(steps);
		const refusals: string[] = [];
		const passes: string[] = [];
		const agent = createTeacherAgent(undefined, {
			engine: { model: faux.getModel(), streamFn: faux.streamSimple },
			onGateRefusal: (g) => refusals.push(g),
			onGatePass: (g) => passes.push(g),
		});
		return { agent, faux, refusals, passes };
	}

	it("the narration guard and the give-away check are counted; after 3 the call passes", async () => {
		const { agent, faux, refusals, passes } = narrationRun();
		await agent.prompt("Teach me Hooke's law.");
		assert.equal(faux.state.callCount, 4);
		assert.deepEqual(refusals, ["giveaway-option", "giveaway-option", "narration"]);
		assert.deepEqual(passes, ["narration"], "the narration guard would refuse again (its own share is not spent) but the turn's is");
		const results = agent.state.messages.filter((m) => m.role === "toolResult" && m.toolName === "quiz") as Array<{ toolCallId: string; isError: boolean; content: Array<{ text?: string }> }>;
		assert.deepEqual(results.map((r) => [r.toolCallId, r.isError]), [["g1", true], ["g2", true], ["n1", true], ["n2", false]]);
		assert.match(results[0]!.content[0]!.text!, /^Refused: the correct option/);
	});

	it("the count resets per learner turn (a new turn builds a new agent)", async () => {
		for (let turn = 0; turn < 2; turn++) {
			const { agent, refusals } = narrationRun();
			await agent.prompt("Teach me Hooke's law.");
			assert.equal(refusals.length, 3, `turn ${turn}`);
		}
	});

	it("the force-text step after a prose refusal still works when the budget ends the refusals early", async () => {
		// History: the learner answered wrong. Then: a bare quiz (prose refusal → force-text), a short text-only reply (tools
		// back), two short-lead quizzes (lead floor ×2: the budget is spent), and a third (passes, over budget).
		const wrong = [
			{ role: "user", content: "teach me", timestamp: 0 },
			{ ...assistantMsg("a1", [toolCall("q1", "quiz", quizArgs)]), id: undefined },
			{ role: "toolResult", toolCallId: "q1", toolName: "quiz", content: [{ type: "text", text: "{\"kind\":\"quiz\",\"correct\":false}" }], isError: false, timestamp: 1 },
		];
		const short = { ...quizArgs, previous: "wrong", lead: "Not quite." };
		const faux = createFauxCore({});
		faux.setResponses([
			() => fauxAssistantMessage([fauxToolCall("quiz", { ...short, lead: "   " } as ToolCall["arguments"], { id: "p1" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Close.")], { stopReason: "stop" }),
			() => fauxAssistantMessage([fauxToolCall("quiz", short as ToolCall["arguments"], { id: "l1" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxToolCall("quiz", short as ToolCall["arguments"], { id: "l2" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxToolCall("quiz", short as ToolCall["arguments"], { id: "l3" })], { stopReason: "toolUse" }),
		]);
		const declared: string[][] = [];
		const passes: string[] = [];
		const agent = createTeacherAgent(undefined, {
			engine: { model: faux.getModel(), streamFn: (m, context, options) => { declared.push(getCurrentTools(context.messages).map((t) => t.name)); return faux.streamSimple(m, context, options); } },
			tools: bareQuestionTools(),
			messages: wrong as never,
			onGatePass: (g) => passes.push(g),
		});
		await agent.continue();
		assert.equal(declared.length, 5);
		assert.ok(declared[0]!.includes("quiz"));
		assert.ok(!declared[1]!.includes("quiz"), "the request after the prose refusal is text-only");
		assert.ok(declared[2]!.includes("quiz") && declared[3]!.includes("quiz") && declared[4]!.includes("quiz"), "the tools come back and stay");
		const results = agent.state.messages.filter((m) => (m as { role?: string }).role === "toolResult") as unknown as Array<{ toolCallId: string; isError: boolean; content: Array<{ text?: string }> }>;
		assert.match(results.find((r) => r.toolCallId === "p1")!.content[0]!.text!, new RegExp(PROSE_GATE_REASON.slice(0, 40)));
		assert.deepEqual(results.filter((r) => r.toolCallId !== "q1").map((r) => [r.toolCallId, r.isError]), [["p1", true], ["l1", true], ["l2", true], ["l3", false]]);
		assert.deepEqual(passes, ["lead-floor"], "the budget-exhausted pass is reported");
	});
});

// ─── 5: the composed teacher prompt ────────────────────────────────────────

describe("the composed teacher prompt", () => {
	const teacher = composeInstructions("teacher");
	const once = (needle: string) => assert.equal(teacher.split(needle).length - 1, 1, needle);

	it("carries each new rule exactly once", () => {
		once("**The shape of an explanation.**");
		once("Never two paragraphs of prose in a row");
		once("A new term is defined in the sentence that first uses it.");
		once("**Rising difficulty.**");
		once("one level higher");
		once("No echo questions: never ask for something the text he just read states outright.");
		once("Ask for a use of it, a prediction, an edge case, or what is wrong in a given attempt.");
		once("every option is about the same length and form as the right one");
		once("**The form: a written answer by default.**");
		once("In an explanation, the sentence right after a figure says what to look at in it");
		once("a demo's `tryThis`");
	});

	it("no longer contradicts the form rule or the short shape", () => {
		assert.doesNotMatch(teacher, /Use `quiz` for predictions, and for concept/);
		assert.doesNotMatch(teacher, /a hard step deserves the paragraphs it takes/);
		assert.doesNotMatch(teacher, /needs three paragraphs/);
		once("**Never just reciting your words back.**"); // the user-locked principle stays, extended
		// the lead floor's demand and the short rule agree: a repair is still written out
		assert.match(teacher, /a repair after a miss still says what his answer shows and works the missing step out/);
	});

	it("placement and practice compose none of the teacher-only rules", () => {
		for (const kind of ["placement", "practice", "prober"] as const) {
			const text = composeInstructions(kind);
			assert.doesNotMatch(text, /Rising difficulty|The shape of an explanation|No echo questions/, kind);
		}
	});
});

describe("editable prompts: the edited fragments keep their paths and a stored override still composes", () => {
	it("no fragment was added or renamed", () => {
		const paths = allSegmentPaths();
		for (const p of ["teacher/20-teaching.md", "teacher/30-question-principles.md", "teacher/50-demos.md", "shared/20-question-tools.md", "shared/45-figures.md", "ask/32-visual.md", "ask/33-demo.md"]) {
			assert.ok(paths.includes(p), p);
		}
	});

	it("an override of an edited fragment replaces it when its switch is on", () => {
		const file = path.join(PROMPTS_OVERRIDE_DIR, "teacher", "30-question-principles.md");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "# My own question principles\n\nAsk anything.");
		const on = composeInstructions("teacher", { "teacher/30-question-principles.md": true });
		assert.match(on, /My own question principles/);
		assert.doesNotMatch(on, /\*\*Rising difficulty\.\*\*/);
		const off = composeInstructions("teacher", { "teacher/30-question-principles.md": false });
		assert.doesNotMatch(off, /My own question principles/);
		assert.match(off, /\*\*Rising difficulty\.\*\*/);
		const segment = effectivePromptSegments("teacher", { "teacher/30-question-principles.md": true }).find((s) => s.path === "teacher/30-question-principles.md")!;
		assert.equal(segment.enabled, true);
		assert.match(segment.sourceText, /\*\*Rising difficulty\.\*\*/, "the source shows the new text beside the override");
	});
});

// ─── old transcripts ────────────────────────────────────────────────────────

describe("old transcripts: every new field absent", () => {
	const oldQuiz = { type: "check", nodeId: "n1", lead: "Right.", question: "Which?", explanation: "E.", options: [{ label: "A" }, { label: "B" }], correctAnswer: "A" };
	const oldExplain = { type: "check", nodeId: "n1", lead: "Right.", question: "Why?", correctAnswer: "Because." };
	const oldProbe = { question: "Which?", explanation: "E.", options: [{ label: "A" }, { label: "B" }], correctAnswer: "A" };
	const oldRecall = { question: "Why?", correctAnswer: "Because." };

	it("each kind still parses for display (no malformed-question recovery)", () => {
		assert.ok(parseQuestionInput("quiz", oldQuiz));
		assert.ok(parseQuestionInput("explain", oldExplain));
		assert.ok(parseQuestionInput("probe", oldProbe));
		assert.ok(parseQuestionInput("recall", oldRecall));
		assert.ok(parseQuestionInput("explain", explainArgs), "and a new one too");
	});

	it("each kind is answered and graded as before", () => {
		for (const [tool, args, kind] of [["quiz", oldQuiz, "quiz"], ["explain", oldExplain, "explain"], ["probe", oldProbe, "quiz"], ["recall", oldRecall, "explain"]] as const) {
			const record = { messages: [userMsg("u1", "go"), assistantMsg("a1", [toolCall("c1", tool, args)])] as never };
			const answer = { kind, tool, questionText: "Q", dontKnow: false, answers: [], text: "t", answeredAt: "t" };
			const out = JSON.parse((inputAppends(record, { type: "answer", toolCallId: "c1", answer: answer as never })[0] as { content: Array<{ text: string }> }).content[0]!.text);
			assert.equal(out.keyPoints, undefined, tool);
			assert.deepEqual(answerForPresentation(answer as never, args).keyPoints, undefined, tool);
		}
	});

	it("an old answered explain is never marked, and an old show_figure has no notes", () => {
		const a = buildAnswer({ id: "e1", kind: "explain", question: "Why?", mode: "text", options: [], committedAnswer: "Because.", createdAt: "t" }, { text: "x" }, "explain");
		assert.equal(a.keyPoints, undefined);
		const view = projectView([userMsg("u1", "go"), assistantMsg("a1", [toolCall("e1", "explain", oldExplain)]), answerMsg("r1", "e1", "explain", a), assistantMsg("a2", [toolCall("q2", "quiz", oldQuiz)])] as never);
		assert.equal(keyPointMarksOf(view).size, 0);
		assert.deepEqual(figureNotesOf({ figure: "job_old", caption: "c" }, "demo"), { lookAt: [] });
	});
});


// ─── Review 1 (2026-11-25): fixes ──────────────────────────────────────────────

const qq = await import("../src/core/question-quality.ts");

describe("WP6 review 1", () => {

	it("finding 1: a short correct answer is graded on correctness; key points must fit the form the question asks for", () => {
		assert.match(qq.KEY_POINTS_NEXT_TEXT, /`previous` is your verdict on the answer itself against `correctAnswer`/);
		assert.match(qq.KEY_POINTS_NEXT_TEXT, /right when it is correct in the form the question asked for, even if it leaves out working the question did not ask for/);
		assert.doesNotMatch(qq.KEY_POINTS_NEXT_TEXT, /right when it has them all/);
		assert.match(qq.KEY_POINTS_NEXT_TEXT, /or when a correct result could not have been reached without it/);
		assert.match(String(qq.keyPointsField.description), /checkable in an answer of the form `question` asks for/);
	});

	it("finding 2: finish keeps its own share of refusals whatever the other gates spent, and does not use up their total", () => {
		const passes: string[] = [];
		const refuse = makeRefusalBudget(REFUSALS_PER_GATE, REFUSALS_PER_TURN, { onPass: (g) => passes.push(g) });
		// the reviewer's sequence: two give-away refusals and one verdict refusal spend the turn's total
		assert.ok(refuse("giveaway-option", true, "r"));
		assert.ok(refuse("giveaway-option", true, "r"));
		assert.ok(refuse("verdict", true, "r"));
		assert.equal(refuse("prose", true, "r"), undefined, "the total is spent for the other gates");
		assert.ok(refuse("finish", true, "r"), "finish still refuses");
		assert.ok(refuse("finish", true, "r"));
		assert.equal(refuse("finish", true, "r"), undefined, "after its own share it passes, as every gate does");
		assert.deepEqual(passes, ["prose", "finish"]);
		// and finish refusals leave the others' total alone
		const fresh = makeRefusalBudget();
		assert.ok(fresh("finish", true, "r"));
		assert.ok(fresh("finish", true, "r"));
		for (const gate of ["prose", "lead-floor", "visual"]) assert.ok(fresh(gate, true, "r"), gate);
		assert.equal(fresh("sources", true, "r"), undefined);
	});

	it("finding 3: the form rule says the example above is not a model of the form", () => {
		assert.match(QUIZ_FORM_RULE, /The example above shows the argument shape and the escaping only: by this rule a calculation like it is an `explain`\./);
	});

	it("finding 4: a final problem's answer carries the key points without asking for a next question", () => {
		const answer = { answers: [{ text: "200 N/m" }] };
		const check = JSON.stringify((newAnswerResult("c1", "explain", answer, undefined, ["a", "b"]).content[0] as { text: string }).text);
		const final = JSON.stringify((newAnswerResult("c2", "explain", answer, undefined, ["a", "b"], true).content[0] as { text: string }).text);
		assert.match(check, /previousKeyPoints/);
		assert.doesNotMatch(final, /previousKeyPoints|In `lead`, name each point/);
		assert.match(final, /This was the final problem/);
		assert.match(final, /1\. a/);
	});

	it("finding 6: a bare string is one concept id; absent stays undefined", () => {
		assert.deepEqual(qq.normalizeConceptIds("Hooke's law"), ["Hooke's law"]);
		assert.deepEqual(qq.normalizeConceptIds('["a", "a", " b "]'), ["a", "b"]);
		assert.deepEqual(qq.normalizeConceptIds("  "), undefined);
		assert.equal(qq.normalizeConceptIds(undefined), undefined);
		assert.deepEqual(qq.normalizeConceptIds([]), []);
	});

	it("finding 8: the give-away refusal does not offer padding the wrong options", () => {
		const reason = giveawayOptionReason({ options: [{ label: "x".repeat(60), length: 60 }], median: 10 } as never);
		assert.doesNotMatch(reason, /equally detailed/);
		assert.match(reason, /Do not lengthen the wrong options to match/);
	});

	it("finding 9: a question still streaming does not mark key points from its partial arguments", () => {
		const answered = { type: "tool-explain", toolCallId: "e1", state: "output-available", input: { keyPoints: ["a", "b", "c"] } };
		const streaming = { type: "tool-quiz", toolCallId: "q2", state: "input-streaming", input: { previousKeyPoints: [1] } };
		assert.equal(qq.keyPointMarksOf([{ parts: [answered, streaming] }]).size, 0);
		const complete = { ...streaming, state: "input-available", input: { previousKeyPoints: [1, 3] } };
		assert.deepEqual([...qq.keyPointMarksOf([{ parts: [answered, complete] }]).get("e1")!], [1, 3]);
	});

	it("finding 10: one short point is enough for lookAt, as its description says", () => {
		assert.deepEqual(figureNotesProblems("visual", { lookAt: ["the peak"] }), []);
		assert.equal(figureNotesProblems("visual", { lookAt: ["x"] }).length, 1);
	});
});
