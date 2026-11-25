/**
 * Vocabulary coverage, the ledger (WP5 — core/coverage-ledger.ts, core/learner-seen.ts, core/visible-text.ts): what the
 * learner saw (production-shaped records: real answer records, real figure deliveries), the matching rules (each with
 * a positive and a negative case, and every row of review 1's matching table that erred), checked independent of
 * introduced, the conceptIds reader, the lesson's prompt block and its listing, and the finish check. Pure: transcripts
 * are built in memory.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveCoverage } from "../src/core/coverage-items.ts";
import {
	buildMatcher,
	chatVocabularyOf,
	checksOf,
	finishVocabularyProblem,
	foldLedger,
	learnerSeenTexts,
	listVocabulary,
	matchNames,
	resolveConceptId,
	VOCABULARY_PROMPT_MAX,
	VOCABULARY_REFUSAL_HEAD,
	vocabularyRefusalText,
	vocabularySection,
	type LedgerChat,
	type VocabularyPromptItem,
} from "../src/core/coverage-ledger.ts";
import { messagesSeenAtFinish } from "../src/core/learner-seen.ts";
import { visibleMarkdownText } from "../src/core/visible-text.ts";
import type { CourseMode, CoverageItem } from "../src/core/contracts.ts";
import { buildSubagentSteer, type DemoResult, type VisualResult } from "../src/core/contracts/jobs.ts";
import { buildAnswer, dismissedAnswer, steeredAnswer, type QuestionData } from "../src/core/question-core.ts";
import { newAnswerResult, type LhMessage } from "../src/core/native-messages.ts";
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
const QUIZ_ARGS = { type: "check", nodeId: "n1", lead: "A check.", question: "Which is right?", explanation: "Because.", options: [{ label: "yes" }, { label: "no" }], correctAnswer: "yes", level: "apply", conceptIds: [] };
const EXPLAIN_ARGS = { type: "check", nodeId: "n1", lead: "In your words.", question: "Explain it.", correctAnswer: "…", keyPoints: ["a", "b"], level: "recall", conceptIds: [] };
const quiz = (id: string, args: Record<string, unknown>) => ask(id, "quiz", { ...QUIZ_ARGS, ...args });
const explain = (id: string, args: Record<string, unknown>) => ask(id, "explain", { ...EXPLAIN_ARGS, ...args });

/** The learner's real answer record to a posed call, as the dock builds it (question-core.ts buildAnswer). */
function answer(call: LhMessage, req: { values?: string[]; text?: string; dontKnow?: boolean } = {}): LhMessage {
	const block = (call as unknown as { content: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }).content.find((b) => (b as { type?: string }).type === "toolCall")!;
	const a = block.arguments;
	const kind = block.name === "explain" ? "explain" : "quiz";
	const options = ((a.options as Array<{ label: string; value?: string }> | undefined) ?? []).map((o, i) => ({ label: o.label, value: o.value ?? o.label, index: i + 1 }));
	const qd: QuestionData = {
		id: block.id,
		kind,
		question: a.question as string,
		mode: kind === "quiz" ? "single-select" : "text",
		options: options as never,
		createdAt: "t",
		...(kind === "quiz" ? { correctIndices: [options.findIndex((o) => o.value === a.correctAnswer || o.label === a.correctAnswer) + 1], explanation: a.explanation as string } : {}),
		...(kind === "explain" ? { committedAnswer: a.correctAnswer as string, keyPoints: a.keyPoints as string[] } : {}),
	};
	const record = buildAnswer(qd, req, block.name);
	return { ...newAnswerResult(block.id, block.name, record), timestamp: t++ } as LhMessage;
}

const LEC = { id: "mat_lec", name: "Lecture 3.pdf" };
const glossary = glossaryOf([
	{
		material: LEC,
		terms: [
			term("ring", { def: "a set with two operations" }),
			term("ring homomorphism"),
			term("R-module"),
			term("module"),
			term("C++"),
			term("unit"),
			term("entropy", { aliases: ["information entropy"], symbols: ["H"] }),
			term("Entropy", { def: null }),
			term("resistor"),
			term("resistors"),
			term("kernel", { page: 3, more: [{ page: 9, def: "a weight function" }] }),
			term("Ohm's law"),
			term("Laplace transform"),
			term("blå"),
			term("ærlig"),
			term("bit", { tier: "supporting" }),
		],
	},
]);
const matcher = buildMatcher(glossary);
/** What the screen shows of a Markdown text, then matched (the path learnerSeenTexts takes). */
const seen = (markdown: string) => [...matchNames(visibleMarkdownText(markdown), matcher)].sort();

// ─── what the learner saw ───────────────────────────────────────────────────

describe("what the learner saw: one definition, shared with the cards (review 1, finding 2)", () => {
	it("prose and a posed question's lead, question and details count; thinking, a refused question's lead, hidden key points and his own words do not", () => {
		const posed = explain("e1", { lead: "Now kernel.", question: "Explain the kernel.", keyPoints: ["resistor point", "b"] });
		const messages = [
			learner("what is a ring?"),
			think("I will explain entropy next"),
			say("A ring has two operations."),
			posed,
			ask("bad", "quiz", { ...QUIZ_ARGS, lead: "Refused lead mentioning Ohm's law." }),
			result("bad", "quiz", null, true, "refused"),
		];
		const texts = learnerSeenTexts(messages).join(" | ");
		assert.match(texts, /A ring has two operations/);
		assert.match(texts, /Now kernel/);
		assert.match(texts, /Explain the kernel/);
		assert.doesNotMatch(texts, /what is a ring\?/, "the learner's own words");
		assert.doesNotMatch(texts, /entropy next/, "thinking");
		assert.doesNotMatch(texts, /Refused lead/, "a refused call was never posed");
		assert.doesNotMatch(texts, /resistor point/, "key points are hidden until he answers");
	});

	it("an answered explain shows its committed answer and key points (the reveal); a dismissed one only its question", () => {
		const posed = explain("e1", { question: "Explain the unit.", correctAnswer: "A unit has an inverse in the ring.", keyPoints: ["kernel point", "b"] });
		const answered = learnerSeenTexts([posed, answer(posed, { text: "my words about resistors" })]).join(" | ");
		assert.match(answered, /A unit has an inverse in the ring/, "the committed answer is displayed");
		assert.match(answered, /kernel point/);
		assert.doesNotMatch(answered, /my words about resistors/, "his own answer is not the tutor's teaching");
		// review 1: a dismissed explain with keyPoints ["ring"] yielded ["Why?", "ring"]; the dismissed card shows the question only
		const why = explain("e2", { question: "Why?", correctAnswer: "Because of the ring.", keyPoints: ["ring", "unit"] });
		assert.deepEqual(learnerSeenTexts([why, { ...newAnswerResult("e2", "explain", dismissedAnswer("explain", "Why?")), timestamp: t++ } as LhMessage]), ["In your words.", "Why?"]);
		const steered = learnerSeenTexts([why, { ...newAnswerResult("e2", "explain", steeredAnswer("explain", "Why?", "I have a question about the ring")), timestamp: t++ } as LhMessage]);
		assert.deepEqual(steered, ["In your words.", "Why?"], "a steer is the learner's words, not seen teaching");
	});

	it("a quiz's explanation behind 'Why' and its options do not count; its question and details do", () => {
		const posed = quiz("q1", { question: "Pick one.", details: "About Ohm's law.", explanation: "Because a ring is…", options: [{ label: "the kernel" }, { label: "the unit" }], correctAnswer: "the kernel" });
		const pending = learnerSeenTexts([posed]).join(" | ");
		assert.match(pending, /Pick one/);
		assert.match(pending, /About Ohm's law/);
		assert.doesNotMatch(pending, /kernel|unit/, "options are not teaching");
		const answered = learnerSeenTexts([posed, answer(posed, { values: ["the unit"] })]).join(" | ");
		assert.doesNotMatch(answered, /Because a ring/, "the explanation sits behind the Why toggle");
		assert.doesNotMatch(answered, /kernel|unit/, "nor are the answered card's options");
	});

	const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>';
	const figure = (jobId: string, callId: string, kind: "visual" | "demo", res: VisualResult | DemoResult): LhMessage[] => [
		ask(callId, kind, kind === "visual" ? { brief: "a ring of resistors" } : { title: "t", brief: "b" }),
		result(callId, kind, { jobId, onShow: true }, false, `Dispatched (job ${jobId}).`),
		{ ...(buildSubagentSteer({ id: jobId, kind, toolCallId: callId }, res) as LhMessage), timestamp: t++ },
	];
	it("a shown figure: caption, lookAt (an array, as the schema has it) and a demo's tryThis; nothing for a missing or failed figure", () => {
		const show = (id: string, job: string, extra: Record<string, unknown>) => [ask(id, "show_figure", { figure: job, ...extra }), result(id, "show_figure", { jobId: job, kind: "visual" })];
		const visual = learnerSeenTexts([...figure("job_v", "v1", "visual", { svg: SVG, notes: "ok" }), ...show("s1", "job_v", { caption: "A circuit", lookAt: ["the kernel of the map", "the unit"], tryThis: "Drag the ring." })]);
		assert.deepEqual(visual, ["A circuit", "the kernel of the map", "the unit"], "a still figure shows no tryThis");
		const demo = learnerSeenTexts([...figure("job_d", "d1", "demo", { title: "t", html: "<html></html>", notes: "ok" } as DemoResult), ...show("s2", "job_d", { caption: "A demo", lookAt: ["the dial"], tryThis: "Drag the ring." })]);
		assert.deepEqual(demo, ["A demo", "the dial", "Drag the ring."]);
		// review 1: a clean show_figure result for a figure that is not in the chat yielded its caption and tryThis
		assert.deepEqual(learnerSeenTexts(show("s3", "job_missing", { caption: "A ring", lookAt: ["the kernel"] })), []);
		assert.deepEqual(learnerSeenTexts([...figure("job_f", "f1", "visual", { svg: "", notes: "FAILED: limit" }), ...show("s4", "job_f", { caption: "A ring", lookAt: ["the kernel"] })]), []);
		assert.deepEqual(learnerSeenTexts([...figure("job_r", "r1", "visual", { svg: SVG, notes: "ok" }), ask("s5", "show_figure", { figure: "job_r", caption: "A ring", lookAt: ["the kernel"] }), result("s5", "show_figure", null, true, "refused")]), []);
	});

	it("at finish time the calling message contributes only its prose (review 1, finding 1)", () => {
		const calling = { id: "mf", role: "assistant", content: [{ type: "text", text: "So, the ideal." }, { type: "toolCall", id: "f1", name: "finish_lesson", arguments: {} }, { type: "toolCall", id: "q9", name: "quiz", arguments: { ...QUIZ_ARGS, lead: "The ring and the unit.", question: "Ring or unit?" } }], ...STAMPS, stopReason: "toolUse", timestamp: t++ } as unknown as LhMessage;
		const texts = learnerSeenTexts(messagesSeenAtFinish([say("Hello."), calling], calling));
		assert.deepEqual(texts, ["Hello.", "So, the ideal."]);
	});
});

// ─── the matching rules ─────────────────────────────────────────────────────

describe("the matching rules (review 1's table, every row)", () => {
	it("word boundaries and digits: **ring** and ring's match; string, rings, ring2 do not", () => {
		assert.deepEqual(seen("Every **ring** has a zero."), ["ring"]);
		assert.deepEqual(seen("The ring's zero."), ["ring"]);
		assert.deepEqual(seen("A string of rings, ring2."), []);
	});
	it("a hyphen joins a word: sub-ring does not introduce ring; R-module is one word", () => {
		assert.deepEqual(seen("A sub-ring is a ring inside."), ["ring"], "the second, standalone, mention counts");
		assert.deepEqual(seen("Take a sub-ring."), []);
		assert.deepEqual(seen("Take a ring-like set."), []);
		assert.deepEqual(seen("Every R-module is a group."), ["R-module"]);
	});
	it("longest match wins: ring homomorphism does not introduce ring; C++foo is not C++", () => {
		assert.deepEqual(seen("A ring homomorphism keeps sums."), ["ring homomorphism"]);
		assert.deepEqual(seen("A ring homomorphism maps a ring."), ["ring", "ring homomorphism"]);
		assert.deepEqual(seen("Write C++foo."), []);
		assert.deepEqual(seen("Write C++ code."), ["C++"]);
	});
	it("LaTeX and Markdown as rendered: $R$-module is R-module (not module); a link's URL is not seen, its label is", () => {
		assert.deepEqual(seen("Every $R$-module is a group."), ["R-module"]);
		assert.deepEqual(seen("Every $\\mathbb{Z}$-module is a group."), [], "a formula joins the word, so no bare 'module'");
		assert.deepEqual(seen("See the [notes](https://example.invalid/ring)."), []);
		assert.deepEqual(seen("See the [ring notes](https://example.invalid/x)."), ["ring"]);
		assert.deepEqual(seen("![a ring](https://example.invalid/ring.png)"), [], "an image's alt and source are not on screen");
		assert.deepEqual(seen('<span title="ring">x</span>'), [], "an attribute is not on screen");
		assert.deepEqual(seen("<details><summary>More</summary>A ring is hidden here.</details>"), [], "a collapsed details block");
		assert.deepEqual(seen("```\na ring in code\n```"), [], "a fenced block shows no words");
	});
	it("whitespace and Unicode: NBSP, a soft line break, NFD, sentence-initial Blå and Ærlig", () => {
		assert.deepEqual(seen("A ring homomorphism."), ["ring homomorphism"]);
		assert.deepEqual(seen("A ring\nhomomorphism keeps sums."), ["ring homomorphism"], "a soft break inside a paragraph is a space");
		assert.deepEqual(seen("Hva er blå?"), ["blå"]);
		assert.deepEqual(seen("Blå er en farge. Ærlig talt."), ["blå", "ærlig"]);
	});
	it("initial capital: after a colon, in a heading, after a list dash, in a quoted sentence and in a table cell; not mid-sentence", () => {
		assert.ok(seen("Definition: Ring means this.").includes("ring"));
		assert.ok(seen("# Ring").includes("ring"));
		assert.ok(seen("- Ring of integers").includes("ring"));
		assert.ok(seen('He said: "Ring it."').includes("ring"));
		assert.ok(seen("| Term | Meaning |\n| --- | --- |\n| Ring | two operations |").includes("ring"), "a table cell starts a sentence");
		assert.ok(!seen("the word Ring here").includes("ring"));
	});
	it("stored capitals and all-caps: Laplace transform exactly; laplace transform, LAPLACE TRANSFORM and BLÅ do not", () => {
		assert.deepEqual(seen("Take the Laplace transform."), ["Laplace transform"]);
		assert.deepEqual(seen("take the laplace transform"), []);
		assert.deepEqual(seen("LAPLACE TRANSFORM"), []);
		assert.deepEqual(seen("# BLÅ"), []);
	});
	it("aliases match; a symbol alone never does; typographic apostrophes read as plain ones", () => {
		assert.ok(seen("This is information entropy.").includes("information entropy"));
		assert.deepEqual(seen("Here H is 2 bits."), [], "'bits' is not 'bit' either");
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
		const unlinked = fold(items, [], [chat("c1", [say("Here entropy grows.")])]);
		assert.equal(unlinked.get("t_entropy")!.introduced, false);
		const linked = fold(items, [["t_entropy", "t_Entropy"]], [chat("c1", [say("Here entropy grows.")])]);
		assert.equal(linked.get("t_entropy")!.introduced, true);
		assert.equal(linked.get("t_Entropy")!.introduced, true);
	});
	it("inflections are not matched unless linked", () => {
		const items = [item("t_resistor", ["sk_1"]), item("t_resistors", ["sk_1"])];
		const apart = fold(items, [], [chat("c1", [say("Two resistors in series.")])]);
		assert.deepEqual([apart.get("t_resistor")!.introduced, apart.get("t_resistors")!.introduced], [false, true]);
		const linked = fold(items, [["t_resistor", "t_resistors"]], [chat("c1", [say("Two resistors in series.")])]);
		assert.equal(linked.get("t_resistor")!.introduced, true);
	});
	it("senses of a homonym: one eligible sense is credited; two eligible senses in the session, none is (review 1, finding 5)", () => {
		const s3 = { sense: { materialId: "mat_lec", page: 3 } };
		const s9 = { sense: { materialId: "mat_lec", page: 9 } };
		const apart = fold([item("t_kernel", ["sk_1"], s3), item("t_kernel", ["sk_2"], s9)], [], [chat("c1", [say("The kernel of a map.")], "learn", ["sk_1"])]);
		assert.equal(apart.get("t_kernel#mat_lec:3")!.introduced, true);
		assert.equal(apart.get("t_kernel#mat_lec:9")!.introduced, false);
		const same = fold([item("t_kernel", ["sk_1"], s3), item("t_kernel", ["sk_1"], s9)], [], [chat("c1", [say("The kernel of a map.")], "learn", ["sk_1"])]);
		assert.deepEqual([same.get("t_kernel#mat_lec:3")!.introduced, same.get("t_kernel#mat_lec:9")!.introduced], [false, false]);
		const mixed = fold([item("t_kernel", ["sk_1"], s3), item("t_kernel", ["sk_2"], s9)], [], [chat("p1", [say("The kernel of a map.")], "practice", ["sk_1", "sk_2"])]);
		assert.deepEqual([mixed.get("t_kernel#mat_lec:3")!.introduced, mixed.get("t_kernel#mat_lec:9")!.introduced], [false, false], "a mixed session has both eligible");
		// only a check tagged with the sense key records it (as checked, not introduced)
		const tagged = explain("e1", { question: "Explain this.", conceptIds: ["t_kernel#mat_lec:9"] });
		const checked = fold([item("t_kernel", ["sk_1"], s3), item("t_kernel", ["sk_1"], s9)], [], [chat("c1", [tagged, answer(tagged, { text: "…" })])]);
		assert.deepEqual([checked.get("t_kernel#mat_lec:9")!.checked, checked.get("t_kernel#mat_lec:9")!.introduced, checked.get("t_kernel#mat_lec:3")!.checked], [true, false, false]);
	});
	it("a term met only as a multiple-choice option is not introduced (review 1, option row)", () => {
		const posed = quiz("q1", { question: "Which has an inverse?", options: [{ label: "a unit" }, { label: "a kernel" }], correctAnswer: "a unit" });
		const l = fold([item("t_unit", ["sk_1"])], [], [chat("c1", [posed, answer(posed, { values: ["a kernel"] })])]);
		assert.equal(l.get("t_unit")!.introduced, false);
	});
	it("an Ask conversation counts for nothing; hidden text never introduces; practice counts", () => {
		const items = [item("t_ring", ["sk_1"])];
		assert.equal(fold(items, [], [chat("a1", [say("A ring is…")], "ask")]).get("t_ring")!.introduced, false);
		assert.equal(fold(items, [], [chat("c1", [think("a ring is…")])]).get("t_ring")!.introduced, false);
		assert.equal(fold(items, [], [chat("p1", [say("A ring is…")], "practice")]).get("t_ring")!.introduced, true);
	});
});

describe("checked, independent of introduced (review 1, finding 3)", () => {
	it("a question '2+2?' tagged t_ring and answered wrongly checks ring (graded wrong) and does not introduce it", () => {
		const posed = quiz("q1", { lead: "Quick one.", question: "2+2?", explanation: "Four.", options: [{ label: "4" }, { label: "5" }], correctAnswer: "4", conceptIds: ["t_ring"] });
		const l = fold([item("t_ring", ["sk_1"])], [], [chat("c1", [posed, answer(posed, { values: ["5"] })])]);
		assert.deepEqual([l.get("t_ring")!.checked, l.get("t_ring")!.right, l.get("t_ring")!.introduced], [true, false, false]);
	});
	it("level and grade kept; a linked id checks the group; an unknown id is ignored; the explain's grade rides the next question", () => {
		const items = [item("t_ring", ["sk_1"]), item("t_resistor", ["sk_1"]), item("t_resistors", ["sk_1"])];
		const q1 = quiz("q1", { conceptIds: ["t_ring", "t_made_up"], level: "analyze" });
		const e1 = explain("e1", { conceptIds: ["t_resistors"], level: "apply" });
		const q2 = quiz("q2", { previous: "wrong", conceptIds: [] });
		const l = fold(items, [["t_resistor", "t_resistors"]], [chat("c1", [q1, answer(q1, { values: ["yes"] }), e1, answer(e1, { text: "…" }), q2, answer(q2, { values: ["yes"] })])]);
		assert.deepEqual([l.get("t_ring")!.checked, l.get("t_ring")!.level, l.get("t_ring")!.right], [true, "analyze", true]);
		assert.deepEqual([l.get("t_resistor")!.checked, l.get("t_resistor")!.right], [true, false]);
		assert.equal(l.has("t_made_up"), false);
	});
	it("posed but unanswered, refused, dismissed or set aside: checks nothing", () => {
		const items = [item("t_ring", ["sk_1"])];
		const q = quiz("q1", { conceptIds: ["t_ring"] });
		assert.equal(fold(items, [], [chat("c1", [q])]).get("t_ring")!.checked, false);
		assert.equal(fold(items, [], [chat("c1", [q, result("q1", "quiz", null, true, "refused")])]).get("t_ring")!.checked, false);
		assert.equal(fold(items, [], [chat("c1", [q, { ...newAnswerResult("q1", "quiz", dismissedAnswer("quiz", "Which is right?")), timestamp: t++ } as LhMessage])]).get("t_ring")!.checked, false);
		assert.equal(fold(items, [], [chat("c1", [q, { ...newAnswerResult("q1", "quiz", steeredAnswer("quiz", "Which is right?", "wait")), timestamp: t++ } as LhMessage])]).get("t_ring")!.checked, false);
	});
	it("two legacy questions sharing one call id: only the occurrence the answer belongs to is checked", () => {
		const first = quiz("call_0", { conceptIds: ["t_ring"] });
		const second = quiz("call_0", { conceptIds: ["t_unit"] });
		const checks = checksOf([first, second, answer(second, { values: ["yes"] })]);
		assert.deepEqual(checks.map((c) => c.ids), [["t_unit"]]);
	});
});

describe("reading conceptIds (review 1, finding 8): one reader for the ledger and the timeline", () => {
	const resolved = resolveCoverage({ items: [item("t_ring", ["sk_1"]), item("t_entropy", ["sk_1"]), item("t_Entropy", ["sk_1"]), item("t_resistor", ["sk_1"]), item("t_resistors", ["sk_1"])], links: [["t_resistor", "t_resistors"]] }, glossary, null);
	it("an exact key, a bracketed id, and a spelling that names one item (or one linked group)", () => {
		assert.deepEqual(resolveConceptId("t_ring", glossary, resolved), ["t_ring"]);
		assert.deepEqual(resolveConceptId("[t_ring]", glossary, resolved), ["t_ring"]);
		assert.deepEqual(resolveConceptId("ring", glossary, resolved), ["t_ring"]);
		assert.deepEqual(resolveConceptId("resistors", glossary, resolved).sort(), ["t_resistor", "t_resistors"]);
	});
	it("anything else is unknown: an ambiguous spelling, a symbol, an invented id, a term with no item", () => {
		assert.deepEqual(resolveConceptId("entropy", glossary, resolved), [], "entropy and Entropy are two entries");
		assert.deepEqual(resolveConceptId("H", glossary, resolved), []);
		assert.deepEqual(resolveConceptId("t_made_up", glossary, resolved), []);
		assert.deepEqual(resolveConceptId("[ring]", glossary, resolved), [], "brackets hold an id, never a spelling");
		assert.deepEqual(resolveConceptId("unit", glossary, resolved), [], "unit has no item in this mapping");
	});
});

// ─── the lesson's prompt section ────────────────────────────────────────────

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
	it("lists the items with ids, definitions, pages and states, carried first; done terms on one line", () => {
		const items = [promptItem(1), promptItem(2, { state: "introduced", carried: true }), promptItem(3, { state: "checked", level: "apply", right: true }), promptItem(4, { carried: true, deferredCount: 2 }), promptItem(5, { state: "asked", carried: true })];
		const listed = listVocabulary(items);
		assert.deepEqual(listed, ["t_term4", "t_term5", "t_term2", "t_term1"], "carried still-to-introduce, then carried to-check, then new; the done one is not listed");
		const byKey = new Map(items.map((i) => [i.key, i]));
		const text = vocabularySection("Entropy of a source", listed.map((k) => byKey.get(k)!), "learn", { done: [items[2]!] });
		const lines = text.split("\n");
		assert.match(lines[0]!, /^VOCABULARY — the class's own terms that this lesson of "Entropy of a source" owes/);
		assert.match(lines[1]!, /^- \[t_term4\] term 4 — new, left for later by 2 earlier lessons \(carried over\)\. The material: "definition 4" \(Lecture 3\.pdf, p\. 4\)$/);
		assert.match(lines[2]!, /^- \[t_term5\] term 5 — asked about in an earlier session but never named, so not introduced yet \(carried over\)\./);
		assert.match(lines[3]!, /^- \[t_term2\] term 2 — introduced in an earlier session, not checked yet \(carried over\)\./);
		assert.match(text, /Already introduced and checked in earlier sessions: term 3 \[t_term3\] \(apply, right\)\./);
		assert.match(text, /a question tagged with it does not introduce it, and neither do multiple-choice options/);
		assert.match(text, /Before `finish_lesson`, every core term listed above must have been introduced/);
		assert.doesNotMatch(vocabularySection("X", [promptItem(1)], "practice"), /finish_lesson/);
	});
	it("a large skill lists at most VOCABULARY_PROMPT_MAX and says how many are left for later (review 1, finding 9)", () => {
		const items = [...Array.from({ length: 60 }, (_, i) => promptItem(i + 1)), promptItem(99, { tier: "supporting" })];
		const listed = listVocabulary(items);
		assert.equal(listed.length, VOCABULARY_PROMPT_MAX);
		const byKey = new Map(items.map((i) => [i.key, i]));
		const text = vocabularySection("X", listed.map((k) => byKey.get(k)!), "learn", { later: items.length - listed.length });
		assert.equal(text.split("\n").filter((l) => l.startsWith("- [")).length, VOCABULARY_PROMPT_MAX);
		assert.match(text, /\(49 more terms of this skill are left for later sessions; not owed by this one\.\)/);
		assert.doesNotMatch(text, /t_term99/, "supporting after core, cut first");
		assert.equal(vocabularySection("X", [], "learn"), "");
	});
	it("bounds the linked names, and says which sense key is which when the lesson has two senses of a word", () => {
		const text = vocabularySection("X", [promptItem(1, { linked: ["a", "b", "c", "d", "e", "f"] }), promptItem(2, { key: "t_kernel#mat_lec:9", name: "kernel", page: 9, senses: 2 })], "learn");
		assert.match(text, /Also named: a, b, c, d \(\+2 more\)\./);
		assert.match(text, /- \[t_kernel#mat_lec:9\] kernel — new\..*One of 2 senses of "kernel" in this lesson \(this one: Lecture 3\.pdf, p\. 9\)/);
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
	it("names every item it checks that is neither introduced nor deferred with a reason", () => {
		assert.deepEqual(finishVocabularyProblem(lesson([]), [], {}), [
			{ key: "t_ring", name: "ring" },
			{ key: "t_entropy", name: "entropy" },
		], "`deferred` absent reads as empty");
		assert.equal(finishVocabularyProblem(lesson(["t_ring", "t_Entropy"]), [], {}), null);
		assert.equal(finishVocabularyProblem(lesson(["t_ring"]), [], { deferred: [{ id: "t_entropy", why: "next week" }] }), null);
		assert.deepEqual(finishVocabularyProblem(lesson(["t_ring"]), [], { deferred: [{ id: "t_entropy", why: "  " }] }), [{ key: "t_entropy", name: "entropy" }], "a deferral needs a reason");
		assert.deepEqual(finishVocabularyProblem(lesson(["t_ring"]), [], { deferred: ["t_entropy"] }), [{ key: "t_entropy", name: "entropy" }]);
	});
	it("the refusal reads: work the next one in, defer the others with why; it names all of them", () => {
		const many = Array.from({ length: 12 }, (_, i) => ({ key: `t_${i}`, name: `term ${i}` }));
		const text = vocabularyRefusalText(many);
		assert.match(text, /^Refused \(vocabulary\): this lesson owes 12 core terms of the class that have not been introduced yet/);
		assert.match(text, /term 11 \[t_11\]\./, "every checked item is named");
		assert.match(text, /Work the next one in where it belongs to what you just taught, and list the others in `deferred` with a few words of why each waits/);
		assert.doesNotMatch(text, /Introduce each one now/);
	});
	it("fires once per lesson, and never without items", () => {
		const refused = [ask("f1", "finish_lesson", { summary: "s" }), result("f1", "finish_lesson", null, true, `${VOCABULARY_REFUSAL_HEAD} …`)];
		assert.equal(finishVocabularyProblem(lesson([]), refused, {}), null);
		assert.equal(finishVocabularyProblem(undefined, [], {}), null);
		assert.equal(finishVocabularyProblem({ items: [], introduced: () => new Set() }, [], {}), null);
	});
});

describe("the vocabulary refusal and the final-problem gate", () => {
	it("a finish refused only for vocabulary is not a finish attempt; a sibling in the same message is not an earlier attempt", async () => {
		const { finishGateProblem } = await import("../src/core/final-problem.ts");
		const final = [ask("x1", "explain", { type: "final", nodeId: "g", lead: "Last.", question: "q", correctAnswer: "a" }), result("x1", "explain", { kind: "explain", dontKnow: false, text: "a" })];
		const vocab = [...final, ask("f1", "finish_lesson", { summary: "s" }), result("f1", "finish_lesson", null, true, vocabularyRefusalText([{ key: "t_ring", name: "ring" }]))];
		assert.equal(finishGateProblem(vocab, "finish_lesson", "f2"), null);
		const notPassed = [...final, ask("f1", "finish_lesson", { summary: "s" }), result("f1", "finish_lesson", null, true, "NOT FINISHED: …")];
		assert.equal(finishGateProblem(notPassed, "finish_lesson", "f2"), "none", "any other failed finish still needs a new final problem");
		const both = { id: "mb", role: "assistant", content: [{ type: "toolCall", id: "fa", name: "finish_lesson", arguments: {} }, { type: "toolCall", id: "fb", name: "finish_lesson", arguments: {} }], ...STAMPS, stopReason: "toolUse", timestamp: t++ } as unknown as LhMessage;
		assert.equal(finishGateProblem([...final, both], "finish_lesson", "fa"), null);
		assert.equal(finishGateProblem([...final, both], "finish_lesson", "fb"), null);
	});
});
