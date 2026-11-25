/**
 * Vocabulary coverage, the ledger (WP5 — core/coverage-ledger.ts): what the learner saw, the matching rules (each with a
 * positive and a negative case), checked via conceptIds (a linked id, an unknown id), the lesson's prompt block and its
 * ceiling, and the finish check. Pure: transcripts are built in memory.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveCoverage } from "../src/core/coverage-items.ts";
import {
	buildMatcher,
	chatVocabularyOf,
	finishVocabularyProblem,
	foldLedger,
	learnerSeenTexts,
	matchNames,
	unknownConceptIds,
	VOCABULARY_PROMPT_MAX,
	VOCABULARY_REFUSAL_HEAD,
	vocabularyRefusalText,
	vocabularySection,
	type LedgerChat,
	type VocabularyPromptItem,
} from "../src/core/coverage-ledger.ts";
import type { CourseMode, CoverageItem } from "../src/core/contracts.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { glossaryOf, term } from "./coverage-fixtures.ts";

const STAMPS = { api: "faux", provider: "test", model: "faux", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
let t = 1;
const say = (text: string): LhMessage => ({ id: `m${t}`, role: "assistant", content: [{ type: "text", text }], ...STAMPS, stopReason: "stop", timestamp: t++ }) as unknown as LhMessage;
const think = (thinking: string): LhMessage => ({ id: `m${t}`, role: "assistant", content: [{ type: "thinking", thinking }], ...STAMPS, stopReason: "stop", timestamp: t++ }) as unknown as LhMessage;
const learner = (text: string): LhMessage => ({ id: `m${t}`, role: "user", content: text, timestamp: t++ }) as unknown as LhMessage;
const ask = (id: string, name: string, args: Record<string, unknown>): LhMessage =>
	({ id: `m${t}`, role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], ...STAMPS, stopReason: "toolUse", timestamp: t++ }) as unknown as LhMessage;
const result = (toolCallId: string, toolName: string, details: unknown, isError = false, text = "ok"): LhMessage =>
	({ id: `m${t}`, role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], details, isError, timestamp: t++ }) as unknown as LhMessage;
const quiz = (id: string, args: Record<string, unknown>) =>
	ask(id, "quiz", { type: "check", nodeId: "n1", lead: "A check.", question: "Which is right?", explanation: "Because.", options: [{ label: "yes" }, { label: "no" }], correctAnswer: "yes", level: "apply", conceptIds: [], ...args });
const explain = (id: string, args: Record<string, unknown>) =>
	ask(id, "explain", { type: "check", nodeId: "n1", lead: "In your words.", question: "Explain it.", correctAnswer: "…", keyPoints: ["a", "b"], level: "recall", conceptIds: [], ...args });

const LEC = { id: "mat_lec", name: "Lecture 3.pdf" };
const glossary = glossaryOf([
	{
		material: LEC,
		terms: [
			term("ring", { def: "a set with two operations" }),
			term("entropy", { aliases: ["information entropy"], symbols: ["H"] }),
			term("Entropy", { def: null }),
			term("resistor"),
			term("resistors"),
			term("kernel", { page: 3, more: [{ page: 9, def: "a weight function" }] }),
			term("Ohm's law"),
			term("bit", { tier: "supporting" }),
		],
	},
]);
const matcher = buildMatcher(glossary);
const seen = (text: string) => [...matchNames(text, matcher)].sort();

describe("what the learner saw (the view's own definition)", () => {
	it("prose, posed questions and shown figures count; thinking, a refused question's lead, hidden key points and his own words do not", () => {
		const messages = [
			learner("what is a ring?"),
			think("I will explain entropy next"),
			say("A ring has two operations."),
			explain("e1", { lead: "Now kernel.", question: "Explain the kernel.", keyPoints: ["resistor point"] }),
			ask("bad", "quiz", { type: "check", nodeId: "n1", lead: "Refused lead mentioning Ohm's law.", question: "q", options: [{ label: "a" }], correctAnswer: "a", level: "recall", conceptIds: [] }),
			result("bad", "quiz", null, true, "refused"),
			ask("f1", "show_figure", { figure: "job1", caption: "A circuit", lookAt: "the resistors in series" }),
			result("f1", "show_figure", { ok: true }),
		];
		const texts = learnerSeenTexts(messages).join(" | ");
		assert.match(texts, /A ring has two operations/);
		assert.match(texts, /Now kernel/);
		assert.match(texts, /Explain the kernel/);
		assert.match(texts, /the resistors in series/);
		assert.doesNotMatch(texts, /what is a ring\?/, "the learner's own words");
		assert.doesNotMatch(texts, /entropy next/, "thinking");
		assert.doesNotMatch(texts, /Refused lead/, "a refused call was never posed");
		assert.doesNotMatch(texts, /resistor point/, "key points are hidden until he answers");
		// once answered, the key points are shown
		const answered = [...messages, result("e1", "explain", { kind: "explain", text: "…" })];
		assert.match(learnerSeenTexts(answered).join(" | "), /resistor point/);
	});
});

describe("the matching rules", () => {
	it("word boundary: 'ring' is in 'a ring' but not in 'string' or 'rings'", () => {
		assert.deepEqual(seen("Every ring has a zero."), ["ring"]);
		assert.deepEqual(seen("A string of rings."), []);
	});
	it("sentence-initial capital: 'Entropy is' introduces the running-text form; mid-sentence 'Entropy' and 'ENTROPY' do not", () => {
		assert.ok(seen("Entropy is a measure.").includes("entropy"));
		assert.ok(seen("We said. Entropy grows.").includes("entropy"));
		assert.ok(seen("- **Entropy** grows").includes("entropy"), "a list item starts a sentence");
		assert.ok(!seen("the word Entropy here").includes("entropy"));
		assert.deepEqual(seen("ENTROPY"), []);
	});
	it("alias: 'information entropy' matches the alias; a symbol alone ('H') never matches", () => {
		assert.ok(seen("This is information entropy.").includes("information entropy"));
		assert.deepEqual(seen("Here H is 2 bits."), [], "'bits' is not 'bit' either");
	});
	it("typographic apostrophes read as plain ones", () => {
		assert.ok(seen("By Ohm’s law, V = IR.").includes("Ohm's law"));
		assert.ok(!seen("By Ohms law").includes("Ohm's law"));
	});
});

const item = (entryId: string, skills: string[], extra: Partial<CoverageItem> = {}): CoverageItem => ({ entryId, name: entryId.slice(2), skills, ...extra });
const chat = (chatId: string, messages: LhMessage[], mode: CourseMode = "learn", skillIds = ["sk_1"]): LedgerChat => ({ chatId, mode, skillIds, vocabulary: chatVocabularyOf(messages, matcher) });
const fold = (items: CoverageItem[], links: string[][], chats: LedgerChat[]) => foldLedger(resolveCoverage({ items, links }, glossary, null), glossary, chats);

describe("introduced", () => {
	it("an ambiguous name introduces nothing; linked as one concept, it introduces both", () => {
		const items = [item("t_entropy", ["sk_1"]), item("t_Entropy", ["sk_1"])];
		// "entropy" has two candidates (entropy, Entropy): ambiguous while unlinked
		const unlinked = fold(items, [], [chat("c1", [say("Here entropy grows.")])]);
		assert.equal(unlinked.get("t_entropy")!.introduced, false);
		const linked = fold(items, [["t_entropy", "t_Entropy"]], [chat("c1", [say("Here entropy grows.")])]);
		assert.equal(linked.get("t_entropy")!.introduced, true);
		assert.equal(linked.get("t_Entropy")!.introduced, true);
	});
	it("inflections are not matched unless linked: 'resistors' introduces 'resistors' only, or both when linked", () => {
		const items = [item("t_resistor", ["sk_1"]), item("t_resistors", ["sk_1"])];
		const apart = fold(items, [], [chat("c1", [say("Two resistors in series.")])]);
		assert.deepEqual([apart.get("t_resistor")!.introduced, apart.get("t_resistors")!.introduced], [false, true]);
		const linked = fold(items, [["t_resistor", "t_resistors"]], [chat("c1", [say("Two resistors in series.")])]);
		assert.equal(linked.get("t_resistor")!.introduced, true);
	});
	it("a sense of a homonym is introduced only in a session of a skill it is assigned to", () => {
		const items = [item("t_kernel", ["sk_1"], { sense: { materialId: "mat_lec", page: 3 } }), item("t_kernel", ["sk_2"], { sense: { materialId: "mat_lec", page: 9 } })];
		const l = fold(items, [], [chat("c1", [say("The kernel of a map.")], "learn", ["sk_1"])]);
		assert.equal(l.get("t_kernel#mat_lec:3")!.introduced, true);
		assert.equal(l.get("t_kernel#mat_lec:9")!.introduced, false);
	});
	it("an Ask conversation counts for nothing; hidden text never introduces", () => {
		const items = [item("t_ring", ["sk_1"])];
		assert.equal(fold(items, [], [chat("a1", [say("A ring is…")], "ask")]).get("t_ring")!.introduced, false);
		assert.equal(fold(items, [], [chat("c1", [think("a ring is…")])]).get("t_ring")!.introduced, false);
		assert.equal(fold(items, [], [chat("p1", [say("A ring is…")], "practice")]).get("t_ring")!.introduced, true, "practice counts");
	});
});

describe("checked via conceptIds", () => {
	it("an answered quiz tagged with an item's id checks it (level and grade kept); a linked id checks the group; an unknown id is ignored", () => {
		const items = [item("t_ring", ["sk_1"]), item("t_resistor", ["sk_1"]), item("t_resistors", ["sk_1"])];
		const messages = [
			quiz("q1", { conceptIds: ["t_ring", "t_made_up"], level: "analyze" }),
			result("q1", "quiz", { kind: "quiz", correct: true }),
			explain("e1", { conceptIds: ["t_resistors"], level: "apply" }),
			result("e1", "explain", { kind: "explain", text: "…" }),
			// the explain's grade rides the next teach question's `previous`
			quiz("q2", { previous: "wrong", conceptIds: [] }),
			result("q2", "quiz", { kind: "quiz", correct: true }),
		];
		const l = fold(items, [["t_resistor", "t_resistors"]], [chat("c1", messages)]);
		assert.deepEqual([l.get("t_ring")!.checked, l.get("t_ring")!.level, l.get("t_ring")!.right], [true, "analyze", true]);
		assert.deepEqual([l.get("t_resistor")!.checked, l.get("t_resistor")!.right], [true, false], "checked through the link, graded wrong");
		assert.equal(l.has("t_made_up"), false);
		assert.equal(unknownConceptIds(["t_ring", "t_made_up"], new Set(["t_ring"])), 1);
	});
	it("a posed but unanswered, or refused, question checks nothing", () => {
		const items = [item("t_ring", ["sk_1"])];
		const l = fold(items, [], [chat("c1", [quiz("q1", { conceptIds: ["t_ring"] }), result("q1", "quiz", null, true, "refused")])]);
		assert.equal(l.get("t_ring")!.checked, false);
	});
});

const promptItem = (i: number, over: Partial<VocabularyPromptItem> = {}): VocabularyPromptItem => ({
	key: `t_term${i}`,
	name: `term ${i}`,
	tier: "core",
	definition: `definition ${i}`,
	page: i,
	material: "Lecture 3.pdf",
	state: "new",
	carried: false,
	...over,
});

describe("the lesson's prompt section", () => {
	it("lists new, carried and checked items with ids, definitions and pages; carried first", () => {
		const text = vocabularySection(
			"Entropy of a source",
			[promptItem(1), promptItem(2, { state: "introduced", carried: true }), promptItem(3, { state: "checked", level: "apply", right: true }), promptItem(4, { state: "new", carried: true, deferred: true })],
			"learn",
		);
		const lines = text.split("\n");
		assert.match(lines[0]!, /VOCABULARY — the class's own terms that "Entropy of a source" owes/);
		assert.match(lines[1]!, /^- \[t_term2\] term 2 — introduced in an earlier session, not checked yet \(carried over\)\. The material: "definition 2" \(Lecture 3\.pdf, p\. 2\)$/);
		assert.match(text, /- \[t_term4\] term 4 — new, left for later by an earlier lesson \(carried over\)/);
		assert.match(text, /- \[t_term1\] term 1 — new\. The material: "definition 1" \(Lecture 3\.pdf, p\. 1\)/);
		assert.match(text, /Already checked in earlier sessions: term 3 \[t_term3\] \(apply, right\)\./);
		assert.match(text, /Before `finish_lesson`, every core term above must have been introduced/);
		assert.doesNotMatch(vocabularySection("X", [promptItem(1)], "practice"), /finish_lesson/);
	});
	it("is bounded: at most VOCABULARY_PROMPT_MAX with definitions, core before supporting, the rest counted", () => {
		const items = [...Array.from({ length: 15 }, (_, i) => promptItem(i + 1)), promptItem(99, { tier: "supporting" })];
		const text = vocabularySection("X", items, "learn");
		assert.equal(text.split("\n").filter((l) => l.startsWith("- [")).length, VOCABULARY_PROMPT_MAX);
		assert.match(text, /\(\+4 more terms of this skill not listed here\)/);
		assert.doesNotMatch(text, /t_term99/, "supporting after core, cut first");
		assert.equal(vocabularySection("X", [], "learn"), "");
	});
});

describe("the finish check", () => {
	const lesson = (introduced: string[]) => ({
		items: [
			{ key: "t_ring", name: "ring", group: ["t_ring"] },
			{ key: "t_entropy", name: "entropy", group: ["t_entropy", "t_Entropy"] },
		],
		introduced: () => new Set(introduced),
	});
	it("names the items neither introduced nor deferred; a linked introduction or a deferral satisfies", () => {
		assert.deepEqual(finishVocabularyProblem(lesson([]), [], { deferred: [] }), [
			{ key: "t_ring", name: "ring" },
			{ key: "t_entropy", name: "entropy" },
		]);
		assert.equal(finishVocabularyProblem(lesson(["t_ring", "t_Entropy"]), [], { deferred: [] }), null);
		assert.equal(finishVocabularyProblem(lesson(["t_ring"]), [], { deferred: [{ id: "t_entropy", why: "next week" }] }), null);
		assert.match(vocabularyRefusalText([{ key: "t_ring", name: "ring" }]), /^Refused \(vocabulary\): this lesson's skill owes 1 core term .*ring \[t_ring\]/);
	});
	it("fires once per lesson, and never without items", () => {
		const refused = [ask("f1", "finish_lesson", { summary: "s", deferred: [] }), result("f1", "finish_lesson", null, true, `${VOCABULARY_REFUSAL_HEAD} …`)];
		assert.equal(finishVocabularyProblem(lesson([]), refused, { deferred: [] }), null);
		assert.equal(finishVocabularyProblem(undefined, [], {}), null);
		assert.equal(finishVocabularyProblem({ items: [], introduced: () => new Set() }, [], {}), null);
	});
});

describe("the vocabulary refusal and the final-problem gate", () => {
	it("a finish refused only for vocabulary is not a finish attempt: the answered final problem still stands", async () => {
		const { finishGateProblem } = await import("../src/core/final-problem.ts");
		const final = [ask("x1", "explain", { type: "final", nodeId: "g", lead: "Last.", question: "q", correctAnswer: "a" }), result("x1", "explain", { kind: "explain", dontKnow: false, text: "a" })];
		const vocab = [...final, ask("f1", "finish_lesson", { summary: "s", deferred: [] }), result("f1", "finish_lesson", null, true, vocabularyRefusalText([{ key: "t_ring", name: "ring" }]))];
		assert.equal(finishGateProblem(vocab, "finish_lesson", "f2"), null);
		const notPassed = [...final, ask("f1", "finish_lesson", { summary: "s", deferred: [] }), result("f1", "finish_lesson", null, true, "NOT FINISHED: …")];
		assert.equal(finishGateProblem(notPassed, "finish_lesson", "f2"), "none", "any other failed finish still needs a new final problem");
	});
});
