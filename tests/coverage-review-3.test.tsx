/**
 * Vocabulary coverage, review 3 (WP5 fix round 3): a regression test for each finding, built from the reviewer's cases.
 * The rules behind every case: a false "introduced" is the costly error, and nothing in one chat or one record may break
 * the class. LH_DATA_DIR isolates; the glossary comes through the test seam, built by the real merge.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-coverage-r3-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { courseStore } = await import("../src/store/courses.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { skillStore } = await import("../src/store/skills.ts");
const courses = await import("../src/server/courses.ts");
const cov = await import("../src/server/course-coverage.ts");
const { mergeFile } = await import("../src/core/sync-merge.ts");
const { LessonSection } = await import("../components/settings/lesson-section.tsx");
import { resolveCoverage } from "../src/core/coverage-items.ts";
import { buildMatcher, chatVocabularyOf, foldLedger, learnerSeenTexts } from "../src/core/coverage-ledger.ts";
import { readVisibleMarkdown, visibleMarkdownText, VISIBLE_TEXT_MAX_CHARS, VISIBLE_TEXT_MAX_CHARS_TEX } from "../src/core/visible-text.ts";
import type { CourseMode, CourseRecord, CoverageItem, SkillLine } from "../src/core/contracts.ts";
import type { CoverageGlossary } from "../src/core/coverage-items.ts";
import { buildAnswer, dismissedAnswer, type QuestionData } from "../src/core/question-core.ts";
import { newAnswerResult, type LhMessage } from "../src/core/native-messages.ts";
import { buildSubagentSteer } from "../src/core/contracts/jobs.ts";
import { displayedMarkdownHast } from "../src/core/speech-text.ts";
import { glossaryOf, term } from "./coverage-fixtures.ts";

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const STAMPS = { api: "faux", provider: "test", model: "faux", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
let t = 1;
type Stop = "stop" | "toolUse" | "error" | "aborted" | "length";
type Block = { type: "text"; text: string } | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
const msg = (content: Block[], stopReason: Stop): LhMessage => ({ id: `m${t}`, role: "assistant", content, ...STAMPS, stopReason, timestamp: t++ }) as unknown as LhMessage;
const say = (text: string, stopReason: Stop = "stop"): LhMessage => msg([{ type: "text", text }], stopReason);
const call = (id: string, name: string, args: Record<string, unknown>, stopReason: Stop = "toolUse", text?: string): LhMessage =>
	msg([...(text ? [{ type: "text" as const, text }] : []), { type: "toolCall", id, name, arguments: args }], stopReason);
const QUIZ = { type: "check", nodeId: "n1", lead: "A check.", question: "Which is right?", explanation: "Because.", options: [{ label: "yes" }, { label: "no" }], correctAnswer: "yes", level: "apply", conceptIds: [] };
const EXPLAIN = { type: "check", nodeId: "n1", lead: "In your words.", question: "Explain it.", correctAnswer: "…", keyPoints: ["a", "b"], level: "recall", conceptIds: [] };

/** The learner's real answer record to a posed call (question-core.ts buildAnswer). */
function answer(posed: LhMessage, req: { values?: string[]; text?: string } = {}, callId?: string): LhMessage {
	const block = (posed as unknown as { content: Array<{ type: string; id: string; name: string; arguments: Record<string, unknown> }> }).content.find((b) => b.type === "toolCall" && (!callId || b.id === callId))!;
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
const dismiss = (id: string, tool: "quiz" | "explain", questionText: string): LhMessage => ({ ...newAnswerResult(id, tool, dismissedAnswer(tool, questionText)), timestamp: t++ }) as LhMessage;

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
function classOf(glossary: CoverageGlossary, items?: (skill: string) => CoverageItem[]): { course: CourseRecord; skill: string } {
	const skill = `sk_r3_${skillN++}`;
	const c = courses.createCourse("Review 3");
	skillStore.appendSkillLines([skillLine(skill, "Rings")]);
	glossaries.set(c.id, glossary);
	const course = courseStore.updateCourse(c.id, {
		status: "active",
		skills: [skill],
		language: "en",
		coverage: { updatedAt: "2026-11-25T00:00:00Z", items: items ? items(skill) : Object.values(glossary.terms).map((e) => ({ entryId: e.id, name: e.term, skills: [skill] })), links: [] },
	})!;
	return { course, skill };
}

/** A session as createCourseSession makes it: stamped with its listing at birth. */
function session(courseId: string, mode: CourseMode, skillIds: string[], messages: LhMessage[] = []): string {
	const course = courseStore.getCourse(courseId)!;
	const listed = mode === "learn" || (mode === "practice" && skillIds.length === 1) ? cov.listedVocabularyFor(course, skillIds[0]!) : undefined;
	const chat = chatStore.createChat(mode, mode === "practice" ? "practice" : undefined, { courseId, mode, skillIds, ...(listed ? { vocabulary: listed } : {}) });
	chatStore.saveMessages(chat.id, messages);
	return chat.id;
}

const RINGS = glossaryOf([{ material: LEC, terms: [term("ring", { page: 2 }), term("unit", { page: 3 }), term("field", { page: 4 }), term("group", { page: 5 })] }]);
const MATCHER = buildMatcher(RINGS);
/** The names a chat of these messages introduces (what the ledger reads, variants included). */
const namesOf = (messages: LhMessage[], matcher = MATCHER) => chatVocabularyOf(messages, matcher).forms;
const namesIn = (text: string, matcher = MATCHER) => namesOf([say(text)], matcher);

// ─── A: the finish refusal is a setting ─────────────────────────────────────

describe("A: the refusal's setting row", () => {
	it("one switch in Settings → General, off unless the setting is on, with its help line", () => {
		const off = renderToStaticMarkup(<LessonSection general={{}} onChange={() => {}} />);
		assert.match(off, /Refuse finishing a lesson while listed class terms were not introduced/);
		assert.match(off, /Experimental\. Term tracking and the term lists work without it/);
		assert.match(off, /aria-checked="false"/);
		const on = renderToStaticMarkup(<LessonSection general={{ refuseFinishWithUnintroducedTerms: true }} onChange={() => {}} />);
		assert.match(on, /aria-checked="true"/);
	});
});

// ─── B1: the lead of a question that was never posed ────────────────────────

describe("B1: a question's lead counts only when the question counts", () => {
	const LEAD = "Let us introduce ring now.";
	const q = (id: string, stop: Stop = "toolUse") => call(id, "quiz", { ...QUIZ, lead: LEAD, question: "Is it?" }, stop);
	for (const stop of ["error", "aborted", "length"] as const) {
		it(`a quiz in a generation that stopped with ${stop}: its lead counts nothing`, () => {
			assert.deepEqual(namesOf([say("Hello."), q("q1", stop)]), []);
			assert.doesNotMatch(learnerSeenTexts([say("Hello."), q("q1", stop)]).join(" | "), /introduce ring/);
		});
	}
	it("a dangling quiz a later message superseded: its lead counts nothing", () => {
		assert.deepEqual(namesOf([q("q1"), say("Let me rephrase.")]), []);
	});
	it("a second sibling question in one message: only the pending one's lead counts", () => {
		const both = msg(
			[
				{ type: "toolCall", id: "qa", name: "quiz", arguments: { ...QUIZ, lead: "First.", question: "Is it?" } },
				{ type: "toolCall", id: "qb", name: "quiz", arguments: { ...QUIZ, lead: LEAD, question: "Is it?" } },
			],
			"toolUse",
		);
		const texts = learnerSeenTexts([both]);
		assert.equal(texts.filter((x) => x === "First." || x === LEAD).length, 1, `exactly one lead, the pending one's: ${JSON.stringify(texts)}`);
		// whichever is pending, the other's lead does not count; with the ring lead on the one that is not pending, ring is new
		if (texts.includes("First.")) assert.deepEqual(namesOf([both]), []);
	});
	it("the pending question's lead counts; an answered one's and a dismissed one's lead count", () => {
		assert.deepEqual(namesOf([say("Hello."), q("q1")]), ["ring"]);
		const posed = q("q2");
		assert.deepEqual(namesOf([posed, answer(posed, { values: ["yes"] })]), ["ring"]);
		const skipped = q("q3");
		assert.deepEqual(namesOf([skipped, dismiss("q3", "quiz", "Is it?")]), ["ring"]);
	});
	it("a retry after a failed generation counts the lead once, from the question that was posed", () => {
		const texts = learnerSeenTexts([q("q1", "error"), q("q2")]);
		assert.equal(texts.filter((x) => x === LEAD).length, 1);
	});
	it("through the page: the lead of a never-posed question leaves its term new", () => {
		const { course, skill } = classOf(RINGS);
		session(course.id, "learn", [skill], [say("Hello."), q("q1", "aborted")]);
		const terms = courses.courseView(course.id)!.coverage!.skills[skill]!.terms;
		assert.equal(terms.find((x) => x.key === "t_ring")!.state, "new");
	});
});

// ─── B2: a dismissed question's text is Markdown ────────────────────────────

describe("B2: a dismissed question's text is reduced as Markdown", () => {
	const cases: Array<[string, string]> = [
		["What is a **sub**group?", "group"],
		["What does `ring` return?", "ring"],
		["Compute $ring + 1$.", "ring"],
	];
	for (const [text, name] of cases) {
		it(`${JSON.stringify(text)} does not credit ${name}`, () => {
			const posed = call("e1", "explain", { ...EXPLAIN, lead: "Next.", question: text });
			assert.deepEqual(namesOf([posed, dismiss("e1", "explain", text)]), []);
		});
	}
	it("a plain dismissed question still counts", () => {
		const posed = call("e1", "explain", { ...EXPLAIN, lead: "Next.", question: "What is a ring?" });
		assert.deepEqual(namesOf([posed, dismiss("e1", "explain", "What is a ring?")]), ["ring"]);
	});
});

// ─── B3–B5: matching ────────────────────────────────────────────────────────

describe("B3/B4: joiners and exclusions (false 'introduced')", () => {
	const none: string[] = [
		"foo__ring",
		"sub--ring",
		"ring--field",
		"sub\u2013\u2013ring",
		"sub\u2014\u2014ring",
		"ring\u2014\u2014field",
		"Call obj.ring() first.",
		"the sub/ring case",
		"See http://example.com/ring for more.",
		"See https://ring.example.com today.",
		"See www.example.com/ring today.",
		"Open src/ring/index.ts here.",
		"in l'ring",
		"Ask Dr. Ring today.",
		"See Fig. Field.",
		"This is ~~ring~~ not it.",
		"This is ~ring~ not it.",
		"This is <del>ring</del> not it.",
		"This is <s>ring</s> not it.",
	];
	for (const text of none) {
		it(`${JSON.stringify(text)} introduces nothing`, () => assert.deepEqual(namesIn(text), []));
	}
	it("still introduced: plain mentions, a sentence end, a possessive, a quoted name, a real sentence start", () => {
		assert.deepEqual(namesIn("A ring has two operations."), ["ring"]);
		assert.deepEqual(namesIn("This is a ring."), ["ring"]);
		assert.deepEqual(namesIn("The ring's unit."), ["ring", "unit"]);
		assert.deepEqual(namesIn("The term 'ring' is next."), ["ring"]);
		assert.deepEqual(namesIn("We built a group. Ring theory comes next."), ["group", "ring"]);
		assert.deepEqual(namesIn("Why? Ring theory."), ["ring"]);
		assert.deepEqual(namesIn("Ring theory first."), ["ring"]);
	});
	it("the chosen sentence-start rule misses a short word before a real full stop (a false 'new', documented)", () => {
		assert.deepEqual(namesIn("It is a set. Ring theory."), []);
	});
	it("a figure caption with Markdown markers is reduced like any text", () => {
		const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>';
		const result = (toolCallId: string, toolName: string, details: unknown, text = "ok"): LhMessage =>
			({ id: `m${t}`, role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], details, isError: false, timestamp: t++ }) as unknown as LhMessage;
		const messages = [
			call("v1", "visual", { brief: "a ring" }),
			result("v1", "visual", { jobId: "job_v", onShow: true }, "Dispatched (job job_v)."),
			{ ...(buildSubagentSteer({ id: "job_v", kind: "visual", toolCallId: "v1" }, { svg: SVG, notes: "ok" }) as LhMessage), timestamp: t++ },
			call("s1", "show_figure", { figure: "job_v", caption: "A **sub**group drawn", lookAt: ["the dots"] }),
			result("s1", "show_figure", { jobId: "job_v", kind: "visual" }),
		];
		assert.deepEqual(learnerSeenTexts(messages), ["A subgroup drawn", "the dots"]);
		assert.deepEqual(namesOf(messages), []);
	});
});

describe("B5: false 'new' cases fixed cheaply", () => {
	it("a term containing * is matched against the text with its markers kept", () => {
		const g = glossaryOf([{ material: LEC, terms: [term("C*-algebra"), term("ring")] }]);
		const m = buildMatcher(g);
		assert.deepEqual(namesIn("A C*-algebra is a ring with more.", m), ["C*-algebra", "ring"]);
		assert.deepEqual(namesIn("A C*-algebra is a C*-algebra too.", m), ["C*-algebra"], "two stars pair as emphasis in the main reading");
		// the marked reading credits only names that contain a marker: "**sub**group" never introduces group there
		assert.deepEqual(namesIn("A **sub**group of a C*-algebra.", buildMatcher(glossaryOf([{ material: LEC, terms: [term("C*-algebra"), term("group")] }]))), ["C*-algebra"]);
	});
	it("the intraword test of emphasis stripping is Unicode-aware", () => {
		assert.equal(visibleMarkdownText("Let ε_μ and δ_μ be given."), "Let ε_μ and δ_μ be given.");
		const g = glossaryOf([{ material: LEC, terms: [term("størrelse")] }]);
		assert.deepEqual(namesIn("Her er ø_størrelse_ø og størrelse.", buildMatcher(g)), ["størrelse"]);
		assert.deepEqual(namesIn("Her er ø_størrelse_ø.", buildMatcher(g)), [], "joined by underscores, not a mention");
	});
	it("a line-break hyphen joins the halves and the hyphenated form is tried too", () => {
		const g = glossaryOf([{ material: LEC, terms: [term("well-defined"), term("non-abelian"), term("R-module"), term("homomorphism")] }]);
		const m = buildMatcher(g);
		assert.deepEqual(namesIn("The map is well-\ndefined here.", m), ["well-defined"]);
		assert.deepEqual(namesIn("A non-\nabelian group.", m), ["non-abelian"]);
		assert.deepEqual(namesIn("An R-\nmodule here.", m), ["R-module"]);
		assert.deepEqual(namesIn("A homo-\nmorphism here.", m), ["homomorphism"]);
		const joined = buildMatcher(glossaryOf([{ material: LEC, terms: [term("welldefined")] }]));
		assert.deepEqual(namesIn("The map is well-\ndefined here.", joined), ["welldefined"]);
	});
});

// ─── B6: senses ─────────────────────────────────────────────────────────────

describe("B6: a sense is introduced only by a check whose own message names the word, and never by a check of two senses", () => {
	const g = glossaryOf([{ material: LEC, terms: [term("kernel", { page: 3, more: [{ page: 9, def: "a weight function" }] })] }]);
	const s3 = "t_kernel#mat_lec:3";
	const s9 = "t_kernel#mat_lec:9";
	const both: CoverageItem[] = [
		{ entryId: "t_kernel", name: "kernel", sense: { materialId: "mat_lec", page: 3 }, skills: ["sk_1"] },
		{ entryId: "t_kernel", name: "kernel", sense: { materialId: "mat_lec", page: 9 }, skills: ["sk_1"] },
	];
	const ledger = (messages: LhMessage[]) => {
		const resolved = resolveCoverage({ items: both, links: [] }, g, null);
		return foldLedger(resolved, g, [{ chatId: "c1", mode: "learn", skillIds: ["sk_1"], vocabulary: chatVocabularyOf(messages, buildMatcher(g)) }]);
	};
	it("a question tagged with both senses of the word introduces neither, even when it names the word", () => {
		const e = call("e1", "explain", { ...EXPLAIN, question: "Explain both meanings of kernel.", conceptIds: [s3, s9] });
		const l = ledger([e, answer(e, { text: "…" })]);
		assert.deepEqual([l.get(s3)!.introduced, l.get(s9)!.introduced], [false, false]);
		assert.deepEqual([l.get(s3)!.checked, l.get(s9)!.checked], [true, true], "the tags still record the check");
	});
	it("a tagged question that never names the word does not pair with a name in an earlier message", () => {
		const e = call("e1", "explain", { ...EXPLAIN, question: "Explain this meaning.", conceptIds: [s9] });
		const l = ledger([say("The kernel has two meanings."), e, answer(e, { text: "…" })]);
		assert.equal(l.get(s9)!.introduced, false);
	});
	it("the word in the same tutor message (its prose, or the question's own text or lead) pairs with the check", () => {
		const prose = call("e1", "explain", { ...EXPLAIN, question: "Explain this meaning.", conceptIds: [s9] }, "toolUse", "Here the kernel is a weight function.");
		assert.equal(ledger([prose, answer(prose, { text: "…" })]).get(s9)!.introduced, true);
		const lead = call("e2", "explain", { ...EXPLAIN, lead: "Now the kernel as a weight.", question: "Explain this meaning.", conceptIds: [s9] });
		assert.equal(ledger([lead, answer(lead, { text: "…" })]).get(s9)!.introduced, true);
	});
	it("a wrong answer still introduces the sense (the learner saw it explained and asked)", () => {
		const q = call("q1", "quiz", { ...QUIZ, lead: "The kernel as a weight.", question: "Which is right?", conceptIds: [s9] });
		const l = ledger([q, answer(q, { values: ["no"] })]);
		assert.equal(l.get(s9)!.introduced, true);
		assert.equal(l.get(s9)!.right, false);
	});
});

// ─── C: limits and cost ─────────────────────────────────────────────────────

describe("C: the limits", () => {
	it("the reviewer's quadratic input now grows linearly: \"$\\n\" + \"*_\" repeated (the parse stage, measured beyond the limit)", () => {
		assertBoundedGrowth("$ and *_", (n) => displayedMarkdownHast("$\n" + "*_".repeat(n / 2)), 20_000);
		assert.notEqual(readVisibleMarkdown("$\n" + "*_".repeat(2_495)), null, "read within the limit");
	});
	it("an ordinary 2,284-character explanation with one cases block is read (a bare \\\\ is no longer a TeX trigger)", () => {
		const prose = "A ring is a set with two operations, and a unit is an element with an inverse. ".repeat(28);
		const text = `${prose}\n\n$$f(x) = \\begin{cases} 1 & x \\in R \\\\ 0 & \\text{otherwise} \\end{cases}$$\n`;
		assert.ok(text.length > 2_200 && text.length < VISIBLE_TEXT_MAX_CHARS, String(text.length));
		assert.deepEqual(namesIn(text), ["ring", "unit"]);
	});
	it("a reply with \\( between the old 2,000 and the new limit is read; one beyond it is not", () => {
		assert.equal(VISIBLE_TEXT_MAX_CHARS_TEX, 3_000);
		const within = `A ring \\(R\\) here. ${"Some words about it. ".repeat(120)}`;
		assert.ok(within.length > 2_000 && within.length < VISIBLE_TEXT_MAX_CHARS_TEX);
		assert.deepEqual(namesIn(within), ["ring"]);
		assert.equal(readVisibleMarkdown(`ring ${"\\(x ".repeat(VISIBLE_TEXT_MAX_CHARS_TEX / 4 + 10)}`), null);
	});
	it("unclosed \\( up to the TeX limit and stacked container markers stay bounded; deep HTML is read", () => {
		assertBoundedGrowth("\\( to the TeX limit", (n) => readVisibleMarkdown("\\(".repeat(n / 2)), VISIBLE_TEXT_MAX_CHARS_TEX);
		assert.equal(readVisibleMarkdown("1. ".repeat(1_600)), null, "stacked markers beyond the depth bound are not parsed");
		assert.equal(readVisibleMarkdown(`${"<div>".repeat(900)}ring`), "ring", "a deep HTML nest under the length limit is read (no estimate cuts it)");
	});
});

// ─── D: robustness ──────────────────────────────────────────────────────────

describe("D: a malformed record never throws out of approval, an edit, the page or a turn", () => {
	const malformed: Array<[string, unknown]> = [
		["a string", "not-an-object"],
		["skills: null", { createdAt: "x", summary: "s", skills: null }],
		["skills: [null]", { createdAt: "x", summary: "s", skills: [null] }],
		["coverage with junk", { createdAt: "x", summary: "s", skills: [{ key: "s1", name: "R", statement: "S", requires: [], restsOn: [] }], coverage: { items: [null, 5, { entryId: 3 }], links: "x", linkEdits: [null, { link: "x" }, { unlink: 5 }] } }],
	];
	for (const [what, draft] of malformed) {
		it(`draft ${what}: approval answers, an edit answers, the page renders, a turn and a session start work`, () => {
			const { course, skill } = classOf(RINGS);
			const lesson = session(course.id, "learn", [skill], [say("A ring.")]);
			courseStore.updateCourse(course.id, { draft: draft as never });
			const approved = courses.approveCourse(course.id);
			if (!approved.ok) assert.ok([409, 422].includes(approved.status), approved.error);
			for (const target of ["draft", "approved"] as const) {
				const edit = cov.editCourseCoverage(course.id, target, { action: "assign", key: "t_unit", skill: target === "draft" ? "s1" : skill });
				assert.equal(typeof edit.ok, "boolean");
			}
			const fresh = courseStore.getCourse(course.id)!;
			assert.ok(cov.coverageView(fresh, "en", false) !== null);
			assert.ok(cov.draftUnassigned(fresh));
			cov.approvalProposal(fresh, RINGS);
			assert.ok(courses.courseForTurn(lesson));
			assert.ok(courses.createCourseSession(course.id, "learn", skill).ok);
		});
	}
	it("a malformed course record (skills, coverage) and a malformed chat link and message", () => {
		const { course, skill } = classOf(RINGS);
		session(course.id, "learn", [skill], [say("A ring."), { role: "assistant", content: "junk" } as unknown as LhMessage, null as unknown as LhMessage]);
		const lesson = chatStore.createChat("learn", undefined, { courseId: course.id, mode: "learn", skillIds: [skill, 5 as never], vocabulary: ["t_ring", null as never] }).id;
		chatStore.saveMessages(lesson, [say("A unit."), { role: "assistant", content: "junk" } as unknown as LhMessage]);
		courseStore.updateCourse(course.id, { coverage: { updatedAt: 5, items: [null, { entryId: "t_ring", name: "ring", skills: [skill, null] }], links: [[1, 2]] } as never });
		assert.ok(cov.safeCourse({ ...courseStore.getCourse(course.id)!, skills: "x" as never, draft: 7 as never }));
		assert.ok(courses.courseView(course.id));
		assert.ok(courses.courseForTurn(lesson));
		assert.ok(cov.editCourseCoverage(course.id, "approved", { action: "exclude", key: "t_unit", reason: "r" }).ok);
	});
});

describe("D: draft links and unlinks survive a re-carry at approval", () => {
	const GL = glossaryOf([{ material: LEC, terms: [term("ring", { page: 2 }), term("unit", { page: 7 }), term("field", { page: 9 }), term("ideal", { page: 11 }), term("module", { page: 13 })] }]);
	/** An approved class with ring, unit and field assigned (and ring–unit linked when `linked`), and a carried draft. */
	function redrafted(linked = false): { id: string; sk: string } {
		const c = courses.createCourse("Algebra r3");
		const sk = `sk_rl${skillN++}`;
		skillStore.appendSkillLines([skillLine(sk, "Rings")]);
		glossaries.set(c.id, GL);
		courseStore.updateCourse(c.id, {
			status: "active",
			skills: [sk],
			language: "en",
			coverage: {
				updatedAt: "2026-11-25T00:00:00Z",
				items: ["ring", "unit", "field", "ideal", "module"].map((n) => ({ entryId: `t_${n}`, name: n, skills: [sk] })),
				links: linked ? [["t_ring", "t_unit"]] : [],
			},
			draft: {
				createdAt: "2026-11-26T00:00:00Z",
				summary: "s",
				skills: [{ key: "s1", reuse: sk, name: "Rings", statement: "Do Rings", requires: [], restsOn: [] }],
				coverage: { items: [], links: [], dropped: [], incomplete: [], shown: { full: 5, names: 0, omitted: 0 } },
			},
		});
		return { id: c.id, sk };
	}
	const approvedLinks = (id: string) => courseStore.getCourse(id)!.coverage!.links;
	const suggestedLinks = (id: string) => courseStore.getCourse(id)!.coverage!.suggested?.links ?? [];
	it("a link of two carried terms stays a link after an unrelated change on the approved map", () => {
		const { id } = redrafted();
		assert.ok(cov.editCourseCoverage(id, "draft", { action: "link", keys: ["t_ring", "t_unit"] }).ok);
		assert.ok(cov.editCourseCoverage(id, "approved", { action: "exclude", key: "t_field", reason: "not here" }).ok);
		const r = courses.approveCourse(id);
		assert.ok(r.ok, !r.ok ? r.error : "");
		assert.deepEqual(approvedLinks(id), [["t_ring", "t_unit"]]);
		assert.deepEqual(suggestedLinks(id), []);
	});
	it("an unlink on the draft stays an unlink", () => {
		const { id } = redrafted(true);
		assert.ok(cov.editCourseCoverage(id, "draft", { action: "unlink", key: "t_unit" }).ok);
		assert.ok(cov.editCourseCoverage(id, "approved", { action: "exclude", key: "t_field", reason: "not here" }).ok);
		assert.ok(courses.approveCourse(id).ok);
		assert.deepEqual(approvedLinks(id), []);
	});
	it("a link between a carried term and a term new to the draft stays", () => {
		const { id, sk } = redrafted();
		courseStore.updateCourse(id, { coverage: { ...courseStore.getCourse(id)!.coverage!, items: courseStore.getCourse(id)!.coverage!.items.filter((i) => i.entryId !== "t_module") } });
		assert.ok(cov.editCourseCoverage(id, "draft", { action: "assign", key: "t_module", skill: "s1" }).ok);
		assert.ok(cov.editCourseCoverage(id, "draft", { action: "link", keys: ["t_ring", "t_module"] }).ok);
		assert.ok(cov.editCourseCoverage(id, "approved", { action: "exclude", key: "t_field", reason: "not here" }).ok);
		assert.ok(courses.approveCourse(id).ok);
		assert.deepEqual(approvedLinks(id), [["t_module", "t_ring"]]);
		assert.ok(courseStore.getCourse(id)!.coverage!.items.find((i) => i.entryId === "t_module")!.skills!.length > 0, sk);
	});
	it("a link of two carried terms the student also edited stays a link, not a suggestion", () => {
		const { id } = redrafted();
		assert.ok(cov.editCourseCoverage(id, "draft", { action: "exclude", key: "t_ideal", reason: "later" }).ok);
		assert.ok(cov.editCourseCoverage(id, "draft", { action: "exclude", key: "t_module", reason: "later" }).ok);
		assert.ok(cov.editCourseCoverage(id, "draft", { action: "link", keys: ["t_ideal", "t_module"] }).ok);
		assert.ok(cov.editCourseCoverage(id, "approved", { action: "exclude", key: "t_field", reason: "not here" }).ok);
		assert.ok(courses.approveCourse(id).ok);
		assert.deepEqual(approvedLinks(id), [["t_ideal", "t_module"]]);
		assert.deepEqual(suggestedLinks(id), []);
	});
	it("a removed item's links do not come back", () => {
		const { id } = redrafted();
		assert.ok(cov.editCourseCoverage(id, "draft", { action: "link", keys: ["t_ring", "t_unit", "t_ideal"] }).ok);
		assert.ok(cov.editCourseCoverage(id, "draft", { action: "remove", key: "t_ideal" }).ok);
		assert.ok(cov.editCourseCoverage(id, "approved", { action: "exclude", key: "t_field", reason: "not here" }).ok);
		const r = courses.approveCourse(id, { leaveUnassigned: true });
		assert.ok(r.ok, !r.ok ? r.error : "");
		assert.deepEqual(approvedLinks(id), [["t_ring", "t_unit"]]);
	});
	it("a remap renames the key in the recorded links", () => {
		const { id } = redrafted();
		courseStore.updateCourse(id, { coverage: { ...courseStore.getCourse(id)!.coverage!, items: courseStore.getCourse(id)!.coverage!.items.filter((i) => i.entryId !== "t_module") } });
		assert.ok(cov.editCourseCoverage(id, "draft", { action: "link", keys: ["t_ring", "t_unit"] }).ok);
		assert.ok(cov.editCourseCoverage(id, "draft", { action: "remap", key: "t_unit", to: "t_module" }).ok);
		assert.ok(cov.editCourseCoverage(id, "approved", { action: "exclude", key: "t_field", reason: "not here" }).ok);
		const r = courses.approveCourse(id, { leaveUnassigned: true });
		assert.ok(r.ok, !r.ok ? r.error : "");
		assert.deepEqual(approvedLinks(id), [["t_module", "t_ring"]]);
	});
});

describe("D: the chat merge keeps a valid vocabulary listing", () => {
	const chatFile = (course: Record<string, unknown>, updatedAt: string, title = "learn") => JSON.stringify({ id: "chat_1", title, createdAt: "2026-11-25T00:00:00Z", updatedAt, messages: [], course });
	const merged = (newer: unknown) => {
		const base = chatFile({ courseId: "course_1", mode: "learn", skillIds: ["sk"], vocabulary: ["t_ring", "t_unit"] }, "2026-11-25T00:00:00Z");
		const newerFile = chatFile({ courseId: "course_1", mode: "learn", skillIds: ["sk"], ...(newer === "absent" ? {} : { vocabulary: newer }) }, "2026-11-26T00:00:00Z", "renamed");
		const out = mergeFile({ path: "chats/chat_1.json", base, local: base, remote: newerFile, prefer: "local" });
		return (JSON.parse(out.content!) as { course: { vocabulary?: unknown } }).course.vocabulary;
	};
	for (const [what, newer] of [["absent", "absent"], ["null", null], ["a string", "t_ring"], ["with a number inside", ["t_ring", 5]], ["with a blank inside", ["t_ring", " "]]] as const) {
		it(`the newer side's listing ${what}: the valid one is kept`, () => assert.deepEqual(merged(newer), ["t_ring", "t_unit"]));
	}
	it("a newer valid listing wins as before", () => assert.deepEqual(merged(["t_field"]), ["t_field"]));
});
