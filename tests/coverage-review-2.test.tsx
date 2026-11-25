/**
 * Vocabulary coverage, review 2 (WP5 fix round 2): a regression test for each of the reviewer's nine findings, built
 * from the reviewer's cases, and both reviews' matching tables re-run row by row. The rule behind every case: a false
 * "introduced" is the costly error, and nothing in one chat may break the class. LH_DATA_DIR isolates; the glossary
 * comes through the test seam, built by the real merge.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-coverage-r2-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { courseStore } = await import("../src/store/courses.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { skillStore } = await import("../src/store/skills.ts");
const courses = await import("../src/server/courses.ts");
const cov = await import("../src/server/course-coverage.ts");
const { mergeFile } = await import("../src/core/sync-merge.ts");
import { readCourseCoverage, readListedVocabulary, resolveCoverage } from "../src/core/coverage-items.ts";
import { buildMatcher, chatVocabularyOf, finishVocabularyProblem, foldLedger, learnerSeenTexts, matchNames, vocabularySection, type LedgerChat } from "../src/core/coverage-ledger.ts";
import { readVisibleMarkdown, visibleMarkdownText, VISIBLE_TEXT_MAX_CHARS, VISIBLE_TEXT_MAX_CHARS_TEX } from "../src/core/visible-text.ts";
import type { CourseMode, CourseRecord, CoverageItem, SkillLine } from "../src/core/contracts.ts";
import type { CoverageGlossary } from "../src/core/coverage-items.ts";
import { buildAnswer, type QuestionData } from "../src/core/question-core.ts";
import { newAnswerResult, type LhMessage } from "../src/core/native-messages.ts";
import { glossaryOf, term } from "./coverage-fixtures.ts";

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const STAMPS = { api: "faux", provider: "test", model: "faux", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
let t = 1;
type Stop = "stop" | "toolUse" | "error" | "aborted" | "length";
const say = (text: string, stopReason: Stop = "stop"): LhMessage => ({ id: `m${t}`, role: "assistant", content: [{ type: "text", text }], ...STAMPS, stopReason, timestamp: t++ }) as unknown as LhMessage;
const call = (id: string, name: string, args: Record<string, unknown>, stopReason: Stop = "toolUse"): LhMessage =>
	({ id: `m${t}`, role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], ...STAMPS, stopReason, timestamp: t++ }) as unknown as LhMessage;
const result = (toolCallId: string, toolName: string, details: unknown, isError = false, text = "ok"): LhMessage =>
	({ id: `m${t}`, role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], details, isError, timestamp: t++ }) as unknown as LhMessage;
const QUIZ = { type: "check", nodeId: "n1", lead: "A check.", question: "Which is right?", explanation: "Because.", options: [{ label: "yes" }, { label: "no" }], correctAnswer: "yes", level: "apply", conceptIds: [] };
const EXPLAIN = { type: "check", nodeId: "n1", lead: "In your words.", question: "Explain it.", correctAnswer: "…", keyPoints: ["a", "b"], level: "recall", conceptIds: [] };

/** The learner's real answer record to a posed call (question-core.ts buildAnswer). */
function answer(posed: LhMessage, req: { values?: string[]; text?: string } = {}): LhMessage {
	const block = (posed as unknown as { content: Array<{ type: string; id: string; name: string; arguments: Record<string, unknown> }> }).content.find((b) => b.type === "toolCall")!;
	const a = block.arguments;
	const kind = block.name === "explain" ? "explain" : "quiz";
	const options = ((a.options as Array<{ label: string }> | undefined) ?? []).map((o, i) => ({ label: o.label, value: o.label, index: i + 1 }));
	const qd: QuestionData = {
		id: block.id,
		kind,
		question: a.question as string,
		mode: kind === "quiz" ? "single-select" : "text",
		options: options as never,
		createdAt: "t",
		...(kind === "quiz" ? { correctIndices: [1], explanation: a.explanation as string } : { committedAnswer: a.correctAnswer as string, keyPoints: a.keyPoints as string[] }),
	};
	return { ...newAnswerResult(block.id, block.name, buildAnswer(qd, req, block.name)), timestamp: t++ } as LhMessage;
}

/** Growth, not wall-clock (the pattern of tests/speech-text.test.ts assertLinearTime): n/16 and n, best of three. */
function assertBoundedGrowth(what: string, run: (n: number) => void, n: number): void {
	const best = (size: number) => {
		let ms = Infinity;
		for (let i = 0; i < 3; i++) {
			const t0 = performance.now();
			run(size);
			ms = Math.min(ms, performance.now() - t0);
		}
		return ms;
	};
	const small = best(Math.floor(n / 16));
	const large = best(n);
	assert.ok(large < Math.max(small, 5) * 64, `${what}: ${Math.floor(n / 16)} took ${small.toFixed(1)}ms, ${n} took ${large.toFixed(1)}ms (more than 64 times as long)`);
}

// ─── a mapped class through the server ──────────────────────────────────────

const LEC = { id: "mat_lec", name: "Lecture 3.pdf" };
let glossaries = new Map<string, CoverageGlossary | null>();
beforeEach(() => {
	glossaries = new Map();
	cov.setCoverageGlossarySource((id) => glossaries.get(id) ?? null);
	cov.clearCourseVocabularyCache();
});
afterEach(() => cov.setCoverageGlossarySource());

const skillLine = (id: string, name: string): SkillLine => ({ id, name, statement: `Do ${name}`, requires: [], restsOn: [], createdAt: "2026-11-01T00:00:00Z" });
let skillN = 0;

/** A class with one skill and the given terms all assigned to it. */
function classOf(glossary: CoverageGlossary, items?: CoverageItem[]): { course: CourseRecord; skill: string } {
	const skill = `sk_r2_${skillN++}`;
	const c = courses.createCourse("Review 2");
	skillStore.appendSkillLines([skillLine(skill, "Rings")]);
	glossaries.set(c.id, glossary);
	const course = courseStore.updateCourse(c.id, {
		status: "active",
		skills: [skill],
		language: "en",
		coverage: { updatedAt: "2026-11-25T00:00:00Z", items: items ?? Object.values(glossary.terms).map((e) => ({ entryId: e.id, name: e.term, skills: [skill] })), links: [] },
	})!;
	return { course, skill };
}

/** A session as createCourseSession makes it: stamped with its listing at birth. */
function session(courseId: string, mode: CourseMode, skillIds: string[], messages: LhMessage[] = [], createdAt?: string): string {
	const course = courseStore.getCourse(courseId)!;
	const listed = mode === "learn" || (mode === "practice" && skillIds.length === 1) ? cov.listedVocabularyFor(course, skillIds[0]!) : undefined;
	const chat = chatStore.createChat(mode, mode === "practice" ? "practice" : undefined, { courseId, mode, skillIds, ...(listed ? { vocabulary: listed } : {}) });
	chatStore.saveMessages(chat.id, messages);
	if (createdAt) fs.writeFileSync(path.join(TMP_DATA, "chats", `${chat.id}.json`), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(TMP_DATA, "chats", `${chat.id}.json`), "utf8")), createdAt }));
	return chat.id;
}
const listedOf = (chatId: string) => chatStore.getChat(chatId)!.course!.vocabulary!;

const RINGS = glossaryOf([{ material: LEC, terms: [term("ring", { page: 2 }), term("unit", { page: 3 }), term("ideal", { page: 4 })] }]);

// ─── finding 1: no crash, bounded cost ──────────────────────────────────────

describe("finding 1: one tutor message cannot break the class, and its cost is bounded", () => {
	const hostile: Array<[string, (n: number) => string, number]> = [
		["5,000 '>'", (n) => ">".repeat(n), 5_000],
		["5,000 nested <div>", (n) => "<div>".repeat(n), 5_000],
		["a 240 KB table", (n) => `| h | i | j | k |\n|---|---|---|---|\n${"| a | b | c | d |\n".repeat(Math.ceil(n / 18))}`, 240_000],
		["40 KB of \\(", (n) => "\\(".repeat(Math.ceil(n / 2)), 40_000],
	];
	for (const [what, make, n] of hostile) {
		it(`${what}: courseView, courseForTurn and a session start do not throw; the text counts nothing; the rest of the chat still counts; cost grows boundedly`, () => {
			const { course, skill } = classOf(RINGS);
			const lesson = session(course.id, "learn", [skill], [say(`${make(n)} ring`), say("A unit has an inverse.")]);
			const view = courses.courseView(course.id)!;
			const terms = view.coverage!.skills[skill]!.terms;
			assert.equal(terms.find((x) => x.key === "t_unit")!.state, "introduced", "the other message of the chat still counts");
			assert.equal(terms.find((x) => x.key === "t_ring")!.state, "new", "the hostile text counts nothing");
			assert.ok(courses.courseForTurn(lesson), "a lesson turn of the class");
			assert.ok(courses.createCourseSession(course.id, "learn", skill).ok, "a session start");
			// growth through the page (the reviewer: 16 s and 11 s, or a stack overflow, at these sizes)
			const sized = new Map<number, string>();
			const classFor = (size: number) => {
				if (!sized.has(size)) {
					const k = classOf(RINGS);
					session(k.course.id, "learn", [k.skill], [say(make(size))]);
					sized.set(size, k.course.id);
				}
				return sized.get(size)!;
			};
			assertBoundedGrowth(`courseView(${what})`, (size) => {
				const id = classFor(size);
				cov.clearCourseVocabularyCache();
				assert.ok(courses.courseView(id)!.coverage);
			}, n);
		});
	}

	it("the limits: over VISIBLE_TEXT_MAX_CHARS (or the TeX tier) a text is not read; ordinary long Markdown within it is", () => {
		const ordinary = "A **ring** has two operations; see [the notes](https://x.invalid).\n\n".repeat(80).slice(0, VISIBLE_TEXT_MAX_CHARS - 10);
		assert.ok(readVisibleMarkdown(ordinary)!.includes("A ring has two operations"));
		assert.equal(readVisibleMarkdown(`${ordinary}${"x".repeat(20)}`), null);
		assert.equal(readVisibleMarkdown(`ring ${"\\(x ".repeat(VISIBLE_TEXT_MAX_CHARS_TEX / 4 + 10)}`), null, "a legacy-delimiter text over the TeX tier");
		assert.ok(readVisibleMarkdown(`ring ${"$x$ ".repeat(VISIBLE_TEXT_MAX_CHARS_TEX / 4 + 10)}`), "dollar math is not in the TeX tier");
		assert.equal(readVisibleMarkdown(`${"- ".repeat(150)}ring`), null, "nesting deeper than the bound");
		assert.ok(readVisibleMarkdown("> - 1. a ring")!.includes("a ring"));
	});

	it("a chat whose record cannot be read, or whose fold fails, counts nothing and the others still count", () => {
		const matcher = buildMatcher(RINGS);
		const broken = chatVocabularyOf([{ role: "assistant", content: "not an array" } as unknown as LhMessage, null as unknown as LhMessage], matcher);
		assert.deepEqual(broken.forms, []);
		const resolved = resolveCoverage({ items: [{ entryId: "t_ring", name: "ring", skills: ["sk"] }, { entryId: "t_unit", name: "unit", skills: ["sk"] }], links: [] }, RINGS, null);
		const errors: string[] = [];
		const good: LedgerChat = { chatId: "good", mode: "learn", skillIds: ["sk"], vocabulary: chatVocabularyOf([say("A unit.")], matcher) };
		const bad = { chatId: "bad", mode: "learn", skillIds: ["sk"], vocabulary: { forms: null, checks: [], deferred: [] } } as unknown as LedgerChat;
		const half = { chatId: "half", mode: "learn", skillIds: ["sk"], vocabulary: { forms: ["ring"], checks: [{ ids: null }], deferred: [] } } as unknown as LedgerChat;
		const ledger = foldLedger(resolved, RINGS, [bad, half, good], undefined, (id) => errors.push(id));
		assert.deepEqual(errors, ["bad", "half"]);
		assert.equal(ledger.get("t_unit")!.introduced, true);
		assert.equal(ledger.get("t_ring")!.introduced, false, "a chat whose fold failed half-way counts nothing at all");
		// and a stored record with malformed answers through the page
		const { course, skill } = classOf(RINGS);
		const q = call("q1", "quiz", { ...QUIZ, question: "Is a unit invertible?", conceptIds: ["t_unit"] });
		session(course.id, "learn", [skill], [say("A ring."), q, result("q1", "quiz", "not an answer record"), { role: "assistant", content: 7 } as unknown as LhMessage]);
		assert.ok(courses.courseView(course.id)!.coverage);
	});
});

// ─── finding 2 and the first concern: no term is starved ────────────────────

describe("finding 2: no term is starved", () => {
	const names = (n: number) => Array.from({ length: n }, (_, i) => `axiom ${String(i).padStart(2, "0")}`);
	const big = (n: number) => glossaryOf([{ material: LEC, terms: names(n).map((x, i) => term(x, { page: 1 + i })) }]);
	const nameOf = (g: CoverageGlossary) => (k: string) => g.terms[k]!.term;
	let day = 1;
	const at = () => `2026-11-${String(day++ % 28 + 1).padStart(2, "0")}T00:00:00.000Z`;

	it("the reviewer's 20-term case: each lesson names its listed terms and tags no check; all 20 are introduced by lesson 2 and every term is listed within five", () => {
		const g = big(20);
		const { course, skill } = classOf(g);
		const lists: string[][] = [];
		for (let lesson = 0; lesson < 5; lesson++) {
			const id = session(course.id, "learn", [skill], [], at());
			const listed = listedOf(id);
			lists.push(listed);
			chatStore.saveMessages(id, [say(`Today: ${listed.map(nameOf(g)).join(", ")}.`)]);
		}
		const n = (k: string) => Number(k.slice(-2));
		assert.deepEqual(lists[0]!.map(n), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], "lesson 1: the first twelve in the material's order");
		assert.deepEqual(lists[1]!.map(n), [12, 13, 14, 15, 16, 17, 18, 19, 0, 1, 2, 3], "lesson 2: the eight never listed, then four to check (oldest first)");
		const view = courses.courseView(course.id)!.coverage!.skills[skill]!;
		assert.equal(view.introduced, 20, "the page reaches 20 of 20 (review 2: it stayed at 12)");
		assert.equal(new Set(lists.flat()).size, 20);
	});

	it("a tutor that defers everything still sees every term listed within two sessions; the second session's count of later terms is right", () => {
		const g = big(20);
		const { course, skill } = classOf(g);
		const first = session(course.id, "learn", [skill], [], at());
		const l1 = listedOf(first);
		chatStore.saveMessages(first, [call("f1", "finish_lesson", { summary: "s", deferred: l1.map((id) => ({ id, why: "time" })) }), result("f1", "finish_lesson", { grades: [] })]);
		const second = session(course.id, "learn", [skill], [], at());
		const l2 = listedOf(second);
		assert.equal(new Set([...l1, ...l2]).size, 20);
		assert.equal(l2.filter((k) => !l1.includes(k)).length, 8, "the eight never listed come first");
		assert.match(courses.courseForTurn(second)!.section, /\(8 more terms of this skill are left for later sessions; not owed by this one\.\)/);
	});

	it("a skill with 60 terms cycles through all of them (a tutor that names nothing and defers nothing); Practice sessions take part", () => {
		const g = big(60);
		const { course, skill } = classOf(g);
		const lists: string[][] = [];
		for (let i = 0; i < 5; i++) lists.push(listedOf(session(course.id, i === 2 ? "practice" : "learn", [skill], [], at())));
		assert.equal(new Set(lists.flat()).size, 60, "five sessions, one of them Practice, list all 60");
		const sixth = listedOf(session(course.id, "learn", [skill], [], at()));
		assert.deepEqual(sixth, lists[0], "then the cycle starts again with the fewest listings, in the material's order");
	});

	it("at most four places go to terms to check while new ones wait", () => {
		const g = big(30);
		const { course, skill } = classOf(g);
		const first = session(course.id, "learn", [skill], [], at());
		chatStore.saveMessages(first, [say(listedOf(first).map(nameOf(g)).join(", "))]);
		const second = listedOf(session(course.id, "learn", [skill], [], at()));
		assert.equal(second.filter((k) => listedOf(first).includes(k)).length, 4);
	});
});

// ─── finding 3 is in tests/coverage-server.test.tsx (the teacher agent) ─────

// ─── findings 4 and 9: matching (both reviews' tables, every row) ───────────

describe("findings 4 and 9: matching, both reviews' tables re-run row by row", () => {
	const g = glossaryOf([
		{
			material: LEC,
			terms: [
				"ring", "ring homomorphism", "homomorphism", "R-module", "module", "C++", "group", "subgroup", "value", "eigenvalue", "buffer", "unit",
				"Laplace transform", "blå", "ærlig",
			].map((x, i) => term(x, { page: 1 + i })),
		},
	]);
	const m = buildMatcher(g);
	const seen = (markdown: string) => [...matchNames(visibleMarkdownText(markdown), m)].sort();
	const rows: Array<[string, string, string[]]> = [
		// review 1
		["r1 word boundary: bold", "Every **ring** has a zero.", ["ring"]],
		["r1 word boundary: possessive", "The ring's zero.", ["ring"]],
		["r1 word boundary: string, rings, ring2", "A string of rings, ring2.", []],
		["r1 hyphen: sub-ring", "Take a sub-ring.", []],
		["r1 overlapping: ring homomorphism", "A ring homomorphism keeps sums.", ["ring homomorphism"]],
		["r1 overlapping: C++foo", "Write C++foo.", []],
		["r1 LaTeX: $R$-module", "Every $R$-module is a group.", ["R-module", "group"]],
		["r1 Markdown: a link's URL", "See the [notes](https://example.invalid/ring).", []],
		["r1 whitespace: NBSP", "A ring homomorphism.", ["ring homomorphism"]],
		["r1 whitespace: soft line break", "A ring\nhomomorphism keeps sums.", ["ring homomorphism"]],
		["r1 Unicode: NFD", "Hva er blå?", ["blå"]],
		["r1 Unicode: sentence-initial Blå, Ærlig", "Blå er en farge. Ærlig talt.", ["blå", "ærlig"]],
		["r1 initial capital: after a colon", "Definition: Ring means this.", ["ring"]],
		["r1 initial capital: heading", "# Ring", ["ring"]],
		["r1 initial capital: list dash", "- Ring of integers", ["ring"]],
		["r1 initial capital: quoted sentence", 'He said: "Ring it."', ["ring"]],
		["r1 initial capital: table cell", "| Term | Meaning |\n| --- | --- |\n| Ring | two operations |", ["ring"]],
		["r1 stored capitals: exact", "Take the Laplace transform.", ["Laplace transform"]],
		["r1 stored capitals: lower case", "take the laplace transform", []],
		["r1 all-caps", "LAPLACE TRANSFORM and BLÅ", []],
		// review 2
		["r2 emphasis: **sub**group", "Take a **sub**group.", ["subgroup"]],
		["r2 emphasis: **eigen**value", "An **eigen**value.", ["eigenvalue"]],
		["r2 emphasis: A **ring** homomorphism", "A **ring** homomorphism keeps sums.", ["ring homomorphism"]],
		["r2 emphasis: *ring*s", "Two *ring*s.", []],
		["r2 emphasis: __ring__ and _ring_", "A __ring__ and a _ring_.", ["ring"]],
		["r2 joiner: en dash", "Take a sub–ring.", []],
		["r2 joiner: em dash without spaces", "Take a sub—ring.", []],
		["r2 joiner: em dash with spaces", "Take a sub — ring.", ["ring"]],
		["r2 joiner: minus sign", "Take a sub−ring.", []],
		["r2 joiner: non-breaking hyphen", "Take a sub‑ring.", []],
		["r2 joiner: soft hyphen (removed)", "Take a sub­ring.", []],
		["r2 joiner: underscore", "A ring_buffer.", []],
		["r2 line-break hyphen in a quoted PDF line", "> a ring homo-\n> morphism maps sums", ["ring homomorphism"]],
		["r2 line-break hyphen, next line upper-case: two words", "a ring homo-\nMorphism", ["ring"]],
		["r2 inline code counts nothing", "Call `ring.unit()` and `ring` now.", []],
		["r2 inline code beside prose", "The `unit` of a ring.", ["ring"]],
	];
	for (const [name, input, expected] of rows) it(name, () => assert.deepEqual(seen(input), [...expected].sort()));

	const item = (entryId: string, skills: string[], extra: Partial<CoverageItem> = {}): CoverageItem => ({ entryId, name: entryId.slice(2), skills, ...extra });
	const fold = (glossary: CoverageGlossary, items: CoverageItem[], links: string[][], messages: LhMessage[], skillIds = ["sk_1"]) => {
		const matcher = buildMatcher(glossary);
		return foldLedger(resolveCoverage({ items, links }, glossary, null), glossary, [{ chatId: "c1", mode: "learn", skillIds, vocabulary: chatVocabularyOf(messages, matcher) }]);
	};
	it("r1 ambiguity: bit as one entry's name and another's alias: neither until linked, then both", () => {
		const bits = glossaryOf([{ material: LEC, terms: [term("bit"), term("binary digit", { aliases: ["bit"] })] }]);
		const items = [item("t_bit", ["sk_1"]), item("t_binary~20~digit", ["sk_1"])];
		const keys = Object.keys(bits.terms);
		const unlinked = fold(bits, items.map((i, n) => ({ ...i, entryId: keys[n]! })), [], [say("One bit.")]);
		assert.deepEqual([...unlinked.values()].map((l) => l.introduced), [false, false]);
		const linked = fold(bits, items.map((i, n) => ({ ...i, entryId: keys[n]! })), [keys], [say("One bit.")]);
		assert.deepEqual([...linked.values()].map((l) => l.introduced), [true, true]);
	});
	it("r1 inflections and symbols: an unlisted plural does not match; a linked plural does; a symbol never", () => {
		const r = glossaryOf([{ material: LEC, terms: [term("resistor"), term("resistors"), term("entropy", { symbols: ["H"] })] }]);
		const items = [item("t_resistor", ["sk_1"]), item("t_resistors", ["sk_1"]), item("t_entropy", ["sk_1"])];
		assert.equal(fold(r, items, [], [say("Two resistors. H is 2.")]).get("t_resistor")!.introduced, false);
		assert.equal(fold(r, items, [], [say("Two resistors. H is 2.")]).get("t_entropy")!.introduced, false);
		assert.equal(fold(r, items, [["t_resistor", "t_resistors"]], [say("Two resistors.")]).get("t_resistor")!.introduced, true);
	});
	it("r1 multiple-choice option: a term met only as an option is not introduced", () => {
		const posed = call("q1", "quiz", { ...QUIZ, question: "Which has an inverse?", options: [{ label: "a unit" }, { label: "a ring" }], correctAnswer: "a unit" });
		assert.equal(fold(g, [item("t_unit", ["sk_1"])], [], [posed, answer(posed, { values: ["a ring"] })]).get("t_unit")!.introduced, false);
	});
});

// ─── finding 5: only a question the learner could see counts ────────────────

describe("finding 5: an unanswered question counts only when it is the dock's pending question", () => {
	const q = (id: string, stop: Stop = "toolUse") => call(id, "quiz", { ...QUIZ, lead: "Next.", question: "Is every unit of a ring invertible?" }, stop);
	const texts = (messages: LhMessage[]) => learnerSeenTexts(messages).join(" | ");
	for (const stop of ["error", "aborted", "length"] as const) {
		it(`a quiz in a generation that stopped with ${stop} counts nothing`, () => {
			assert.doesNotMatch(texts([say("Hello."), q("q1", stop)]), /unit/);
		});
	}
	it("a dangling quiz behind a later message counts nothing; the pending one counts", () => {
		assert.doesNotMatch(texts([q("q1"), say("Let me rephrase.")]), /unit/);
		assert.match(texts([say("Hello."), q("q1")]), /Is every unit of a ring invertible\?/);
	});
	it("a retry that poses the question successfully afterwards counts it once", () => {
		const all = learnerSeenTexts([q("q1", "error"), q("q2")]);
		assert.equal(all.filter((x) => x.includes("Is every unit of a ring invertible?")).length, 1);
	});
	it("a practice problem in an aborted generation counts nothing; one that went through counts", () => {
		const problem = (id: string, stop: Stop) => call(id, "problem", { statement: "Show that the unit group of a ring is a group." }, stop);
		assert.doesNotMatch(texts([problem("p1", "aborted")]), /unit group/);
		assert.match(texts([problem("p2", "toolUse"), result("p2", "problem", { ok: true })]), /unit group/);
	});
	it("through the page: the terms of a never-posed question stay new", () => {
		const { course, skill } = classOf(RINGS);
		session(course.id, "learn", [skill], [say("Hello."), q("q1", "error")]);
		const terms = courses.courseView(course.id)!.coverage!.skills[skill]!.terms;
		assert.deepEqual(terms.filter((x) => x.state !== "new").map((x) => x.key), []);
	});
});

// ─── finding 6: two senses of one word in one skill ─────────────────────────

describe("finding 6: two senses of one word in one skill can be satisfied", () => {
	const g = glossaryOf([{ material: LEC, terms: [term("kernel", { page: 3, more: [{ page: 9, def: "a weight function" }] })] }]);
	const s3 = "t_kernel#mat_lec:3";
	const s9 = "t_kernel#mat_lec:9";
	const both = (skill: string): CoverageItem[] => [
		{ entryId: "t_kernel", name: "kernel", sense: { materialId: "mat_lec", page: 3 }, skills: [skill] },
		{ entryId: "t_kernel", name: "kernel", sense: { materialId: "mat_lec", page: 9 }, skills: [skill] },
	];
	// review 3: the check's own message must name the word (here its question does)
	const tagged = (id: string, key: string, question = "Explain this meaning of the kernel.") => call(id, "explain", { ...EXPLAIN, question, conceptIds: [key] });
	const ledger = (messages: LhMessage[]) => {
		const resolved = resolveCoverage({ items: both("sk_1"), links: [] }, g, null);
		return foldLedger(resolved, g, [{ chatId: "c1", mode: "learn", skillIds: ["sk_1"], vocabulary: chatVocabularyOf(messages, buildMatcher(g)) }]);
	};
	it("the reviewer's case: the tutor names kernel, explains both senses and checks each with its sense key: both introduced and checked", () => {
		const a = tagged("e1", s3);
		const b = tagged("e2", s9);
		const l = ledger([say("The kernel has two meanings here: the null space of a map, and a weight function."), a, answer(a, { text: "…" }), b, answer(b, { text: "…" })]);
		assert.deepEqual([l.get(s3)!.introduced, l.get(s3)!.checked, l.get(s9)!.introduced, l.get(s9)!.checked], [true, true, true, true]);
	});
	it("its halves: the name alone introduces neither; the tag alone introduces nothing; one sense checked introduces only that one", () => {
		const named = ledger([say("The kernel of a map.")]);
		assert.deepEqual([named.get(s3)!.introduced, named.get(s9)!.introduced], [false, false]);
		const a = tagged("e1", s3, "Explain this meaning.");
		const tagOnly = ledger([a, answer(a, { text: "…" })]);
		assert.deepEqual([tagOnly.get(s3)!.introduced, tagOnly.get(s3)!.checked], [false, true]);
		const b = tagged("e2", s9);
		const one = ledger([say("The kernel."), b, answer(b, { text: "…" })]);
		assert.deepEqual([one.get(s3)!.introduced, one.get(s9)!.introduced], [false, true]);
		const posedOnly = ledger([say("The kernel."), tagged("e3", s9)]);
		assert.equal(posedOnly.get(s9)!.introduced, false, "an unanswered check does not count");
	});
	it("through a lesson: the finish check passes when both senses were named and checked; the prompt says exactly how", () => {
		const skill = `sk_r2_${skillN++}`;
		const c = courses.createCourse("Kernels");
		skillStore.appendSkillLines([skillLine(skill, "Kernels")]);
		glossaries.set(c.id, g);
		courseStore.updateCourse(c.id, { status: "active", skills: [skill], language: "en", coverage: { updatedAt: "x", items: both(skill), links: [] } });
		const id = session(c.id, "learn", [skill]);
		const turn = courses.courseForTurn(id)!;
		assert.match(turn.section, /naming the word alone introduces none of them\. Explain this sense and check it with a question tagged with this exact id \(not also with another sense's id\) that names the word in its own text or in the message that poses it: that answered check introduces this sense and checks it\./);
		const a = tagged("e1", s3);
		const b = tagged("e2", s9);
		const messages = [say("The kernel, in both senses."), a, answer(a, { text: "…" }), b, answer(b, { text: "…" })];
		assert.equal(finishVocabularyProblem(turn.vocabulary, messages, {}), null);
		assert.equal(finishVocabularyProblem(turn.vocabulary, [say("The kernel, in both senses.")], {})!.length, 2, "without the checks both are still owed");
	});
	it("the section's sense note", () => {
		const text = vocabularySection("K", [{ key: s9, name: "kernel", tier: "core", definition: null, page: 9, material: "L.pdf", state: "new", carried: false, senses: 2 }], "learn");
		assert.match(text, /One of 2 senses of "kernel" in this lesson \(this one: L\.pdf, p\. 9\)/);
	});
});

// ─── finding 7: approval carries again from the approved map ────────────────

describe("finding 7: an edit on the approved map is not lost behind a carried draft", () => {
	const GL = glossaryOf([{ material: LEC, terms: [term("ring", { page: 2 }), term("unit", { page: 7 })] }]);
	function redrafted(stamped: boolean): CourseRecord {
		const c = courses.createCourse("Algebra r2");
		skillStore.appendSkillLines([skillLine(`sk_rr${skillN}`, "Rings")]);
		const sk = `sk_rr${skillN++}`;
		glossaries.set(c.id, GL);
		courseStore.updateCourse(c.id, {
			status: "active",
			skills: [sk],
			language: "en",
			coverage: { updatedAt: "2026-11-25T00:00:00Z", items: [{ entryId: "t_ring", name: "ring", skills: [sk] }, { entryId: "t_unit", name: "unit", skills: [sk] }], links: [] },
			draft: {
				createdAt: "2026-11-26T00:00:00Z",
				summary: "s",
				skills: [{ key: "s1", reuse: sk, name: "Rings", statement: "Do Rings", requires: [], restsOn: [] }],
				coverage: { items: [], links: [], dropped: [], incomplete: [], shown: { full: 2, names: 0, omitted: 0 } },
			},
		});
		// the draft gets its carry: by an edit on the draft (stamped), or as a rework-era draft (carried, no stamp)
		if (stamped) assert.ok(cov.editCourseCoverage(c.id, "draft", { action: "assign", key: "t_ring", skill: "s1" }).ok);
		else courseStore.updateCourse(c.id, { draft: { ...courseStore.getCourse(c.id)!.draft!, coverage: { items: [{ entryId: "t_ring", name: "ring", skills: ["s1"] }, { entryId: "t_unit", name: "unit", skills: ["s1"] }], links: [], dropped: [], incomplete: [], shown: { full: 2, names: 0, omitted: 0 }, carried: true } } });
		assert.equal(courseStore.getCourse(c.id)!.draft!.coverage!.carried, true);
		return courseStore.getCourse(c.id)!;
	}
	for (const stamped of [true, false]) {
		it(`the reviewer's sequence (${stamped ? "a draft carried and edited by this build" : "a carried draft from the rework"}): unit excluded on the approved map, then the draft approved: unit stays excluded`, () => {
			const c = redrafted(stamped);
			assert.ok(cov.editCourseCoverage(c.id, "approved", { action: "exclude", key: "t_unit", reason: "not in this course" }).ok);
			const r = courses.approveCourse(c.id);
			assert.ok(r.ok, !r.ok ? r.error : "");
			const by = new Map(courseStore.getCourse(c.id)!.coverage!.items.map((i) => [i.entryId, i]));
			assert.equal(by.get("t_unit")!.excluded, "not in this course");
			assert.equal(by.get("t_unit")!.skills, undefined);
			assert.ok(by.get("t_ring")!.skills?.length === 1, "the draft's own edit and the carried assignment stay");
		});
	}
	it("an edit on the draft still wins over the approved map's item for the same term", () => {
		const c = redrafted(true);
		assert.ok(cov.editCourseCoverage(c.id, "draft", { action: "exclude", key: "t_ring", reason: "the draft says so" }).ok);
		assert.ok(cov.editCourseCoverage(c.id, "approved", { action: "exclude", key: "t_unit", reason: "approved says so" }).ok);
		assert.ok(courses.approveCourse(c.id).ok);
		const by = new Map(courseStore.getCourse(c.id)!.coverage!.items.map((i) => [i.entryId, i]));
		assert.equal(by.get("t_ring")!.excluded, "the draft says so");
		assert.equal(by.get("t_unit")!.excluded, "approved says so");
	});
});

// ─── finding 8: stored values read defensively ──────────────────────────────

describe("finding 8: a malformed stored value never throws; it reads as absent", () => {
	it("ChatCourseLink.vocabulary: a string, an object, a number inside: the session owes nothing and its turn works", () => {
		const { course, skill } = classOf(RINGS);
		for (const bad of ["t_ring", { 0: "t_ring" }, ["t_ring", 3], [""], null]) {
			const chat = chatStore.createChat("learn", undefined, { courseId: course.id, mode: "learn", skillIds: [skill], vocabulary: bad as never });
			const turn = courses.courseForTurn(chat.id)!;
			assert.ok(turn, JSON.stringify(bad));
			assert.equal(turn.vocabulary, undefined, "owes nothing");
			assert.doesNotMatch(turn.section, /VOCABULARY — the class's own terms/);
			assert.ok(courses.courseView(course.id)!.coverage);
			assert.ok(courses.createCourseSession(course.id, "learn", skill).ok);
		}
		assert.deepEqual(readListedVocabulary(["t_ring", "t_unit"]), ["t_ring", "t_unit"]);
		assert.deepEqual(readListedVocabulary([]), []);
	});
	it("a course link with malformed skill ids, a malformed mapping and a malformed draft proposal", () => {
		const { course, skill } = classOf(RINGS);
		chatStore.createChat("learn", undefined, { courseId: course.id, mode: "learn", skillIds: "sk" as never });
		assert.ok(courses.courseView(course.id)!.coverage);
		courseStore.updateCourse(course.id, { coverage: { updatedAt: 3, items: [{ entryId: "t_ring", name: "ring", skills: "x" }, 7, { entryId: "" }, { entryId: "t_unit", name: "unit", skills: [skill, 4] }], links: "x", suggested: { excluded: [1], links: [[1, 2]] }, displaced: {} } as never });
		const view = courses.courseView(course.id)!;
		assert.deepEqual(view.coverage!.skills[skill]!.terms.map((x) => x.key), ["t_unit"], "only the well-formed item that names this skill");
		courseStore.updateCourse(course.id, { coverage: "corrupt" as never });
		assert.ok(courses.courseView(course.id), "a mapping that is not an object reads as none");
		courseStore.updateCourse(course.id, { coverage: undefined, draft: { createdAt: "x", summary: "s", skills: [{ key: "s1", name: "R", statement: "r", requires: [], restsOn: [] }], coverage: { items: "x" } as never } });
		assert.ok(courses.courseView(course.id));
		assert.equal(readCourseCoverage({ items: "x" }), undefined);
	});
	it("a lesson result's stored coverage line of the wrong shape shows no line", () => {
		const messages = [call("f1", "finish_lesson", { summary: "s" }), result("f1", "finish_lesson", { coverage: { total: "3", covered: 1, left: "x" } })];
		assert.equal(cov.lessonCoverage(messages, "en"), undefined);
		assert.equal(cov.lessonCoverage([call("f1", "finish_lesson", { summary: "s" }), result("f1", "finish_lesson", { coverage: "x" })], "en"), undefined);
	});
});

// ─── concern: the chat merge keeps a session's listing ──────────────────────

describe("the chat merge keeps a session's vocabulary listing when the newer side lacks it", () => {
	it("an older build's newer copy without `vocabulary` does not erase it", () => {
		const base = { id: "chat_1", title: "learn", createdAt: "2026-11-25T00:00:00Z", updatedAt: "2026-11-25T00:00:00Z", messages: [], course: { courseId: "course_1", mode: "learn", skillIds: ["sk"], vocabulary: ["t_ring"] } };
		const newerOld = { ...base, title: "renamed", updatedAt: "2026-11-26T00:00:00Z", course: { courseId: "course_1", mode: "learn", skillIds: ["sk"] } };
		const merged = JSON.parse(mergeFile({ path: "chats/chat_1.json", base: JSON.stringify(base), local: JSON.stringify(base), remote: JSON.stringify(newerOld), prefer: "local" }).content!);
		assert.equal(merged.title, "renamed");
		assert.deepEqual(merged.course.vocabulary, ["t_ring"]);
	});
});
