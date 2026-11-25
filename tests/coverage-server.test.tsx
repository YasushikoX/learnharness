/**
 * Vocabulary coverage through the server (WP5 — server/course-coverage.ts and its hooks in server/courses.ts): the
 * record field (store, sync merge, the course view), the planner with a scripted model, approval and its "leave
 * unassigned" path, reconciliation when the glossary changes, the session's prompt block and finish check, the finish
 * refusal through the real teacher agent, the lesson result, the cache against the uncached path (with a measurement),
 * and old data. LH_DATA_DIR isolates; the glossary comes through the test seam, built by the real merge.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { renderToStaticMarkup as renderBare } from "react-dom/server";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { InteractionLayersProvider } from "../components/interaction-layers";
const renderToStaticMarkup = (node: React.ReactElement) => renderBare(<InteractionLayersProvider>{node}</InteractionLayersProvider>);

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-coverage-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { courseStore } = await import("../src/store/courses.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { skillStore } = await import("../src/store/skills.ts");
const courses = await import("../src/server/courses.ts");
const cov = await import("../src/server/course-coverage.ts");
const { mergeFile } = await import("../src/core/sync-merge.ts");
const { draftCourse } = await import("../src/agent/subagents/course-planner.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { CourseBody } = await import("../components/course-page.tsx");
const { LessonResultView } = await import("../components/lesson-result-card.tsx");
const { VOCABULARY_REFUSAL_HEAD } = await import("../src/core/coverage-ledger.ts");
import type { CourseRecord, SkillLine } from "../src/core/contracts.ts";
import type { CoverageGlossary } from "../src/core/coverage-items.ts";
import type { LessonVocabulary } from "../src/core/coverage-ledger.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { glossaryOf, term } from "./coverage-fixtures.ts";

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const LEC = { id: "mat_lec", name: "Lecture 3.pdf" };
const GLOSSARY = glossaryOf([
	{
		material: LEC,
		terms: [
			term("ring", { page: 2, def: "a set with two operations" }),
			term("ideal", { page: 5, def: "a subring closed under multiplication by ring elements" }),
			term("unit", { page: 7, def: null }),
			term("field", { page: 9 }),
			term("Field", { page: 1, def: null }),
			term("bit", { tier: "supporting" }),
		],
	},
]);

let glossaries = new Map<string, CoverageGlossary | null>();
beforeEach(() => {
	glossaries = new Map();
	cov.setCoverageGlossarySource((id) => glossaries.get(id) ?? null);
	cov.clearCourseVocabularyCache();
});
afterEach(() => cov.setCoverageGlossarySource());

const skillLine = (id: string, name: string): SkillLine => ({ id, name, statement: `Do ${name}`, requires: [], restsOn: [], createdAt: "2026-11-01T00:00:00Z" });

/** An approved course with two skills (sk_rings, sk_fields), a mapping, and the glossary above. */
function mappedCourse(coverage: CourseRecord["coverage"] = undefined): CourseRecord {
	const c = courses.createCourse("Algebra");
	skillStore.appendSkillLines([skillLine("sk_rings", "Rings"), skillLine("sk_fields", "Fields")]);
	glossaries.set(c.id, GLOSSARY);
	return courseStore.updateCourse(c.id, {
		status: "active",
		skills: ["sk_rings", "sk_fields"],
		language: "en",
		coverage: coverage ?? {
			updatedAt: "2026-11-25T00:00:00Z",
			items: [
				{ entryId: "t_ring", name: "ring", skills: ["sk_rings"] },
				{ entryId: "t_ideal", name: "ideal", skills: ["sk_rings"] },
				{ entryId: "t_unit", name: "unit", skills: ["sk_rings"] },
				{ entryId: "t_field", name: "field", skills: ["sk_fields"] },
				{ entryId: "t_Field", name: "Field", excluded: "the heading form" },
				{ entryId: "t_bit", name: "bit", skills: ["sk_rings"] },
			],
			links: [],
		},
	})!;
}

const STAMPS = { api: "faux", provider: "test", model: "faux", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
let t = 1;
const say = (text: string): LhMessage => ({ id: `m${t}`, role: "assistant", content: [{ type: "text", text }], ...STAMPS, stopReason: "stop", timestamp: t++ }) as unknown as LhMessage;
const callMsg = (id: string, name: string, args: Record<string, unknown>, text?: string): LhMessage =>
	({ id: `m${t}`, role: "assistant", content: [...(text ? [{ type: "text", text }] : []), { type: "toolCall", id, name, arguments: args }], ...STAMPS, stopReason: "toolUse", timestamp: t++ }) as unknown as LhMessage;
const result = (toolCallId: string, toolName: string, details: unknown, isError = false, text = "ok"): LhMessage =>
	({ id: `m${t}`, role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], details, isError, timestamp: t++ }) as unknown as LhMessage;

function session(courseId: string, mode: "learn" | "practice" | "ask", skillIds: string[], messages: LhMessage[]): string {
	const chat = chatStore.createChat(`${mode}`, mode === "practice" ? "practice" : undefined, { courseId, mode, skillIds });
	chatStore.saveMessages(chat.id, messages);
	return chat.id;
}

// ─── the record field ────────────────────────────────────────────────────────

describe("CourseRecord.coverage rides the record", () => {
	it("is stored, read back, served by the course view, and written by edits", () => {
		const c = mappedCourse();
		assert.equal(courseStore.getCourse(c.id)!.coverage!.items.length, 6);
		const view = courses.courseView(c.id)!;
		assert.equal(view.course.coverage!.items.length, 6, "the GET payload (and so any export of it) carries the field");
		const edited = cov.editCourseCoverage(c.id, "approved", { action: "assign", key: "t_unit", skill: "sk_fields" });
		assert.ok(edited.ok);
		assert.deepEqual(courseStore.getCourse(c.id)!.coverage!.items.find((i) => i.entryId === "t_unit")!.skills, ["sk_rings", "sk_fields"]);
		assert.equal(courses.deleteCourse(c.id), true, "deleting the course takes the field with the record");
		assert.equal(courseStore.getCourse(c.id), null);
	});

	describe("sync merge", () => {
		const j = (o: unknown) => JSON.stringify(o);
		const rec = (over: Record<string, unknown> = {}) => ({ id: "course_1", title: "T", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", status: "active", skills: ["sk_a"], version: 1, ...over });
		const mapping = (skills: string[]) => ({ updatedAt: "2026-11-25T00:00:00Z", items: [{ entryId: "t_ring", name: "ring", skills }], links: [] });
		const merge = (base: unknown, local: unknown, remote: unknown, prefer: "local" | "remote" = "local") =>
			mergeFile({ path: "courses/course_1.json", base: base === null ? null : j(base), local: j(local), remote: j(remote), prefer });
		it("a mapping made on one device reaches the other, in both directions, including an older-shaped record", () => {
			const base = rec();
			const withMap = rec({ coverage: mapping(["sk_a"]), updatedAt: "2026-11-25T00:00:00Z" });
			assert.deepEqual(JSON.parse(merge(base, withMap, base).content!).coverage, mapping(["sk_a"]));
			assert.deepEqual(JSON.parse(merge(base, base, withMap).content!).coverage, mapping(["sk_a"]));
			// the other device runs a build without coverage and renamed the course later: the mapping stays
			const olderRenamed = rec({ title: "Renamed", updatedAt: "2026-11-26T00:00:00Z" });
			const merged = JSON.parse(merge(base, withMap, olderRenamed).content!);
			assert.equal(merged.title, "Renamed");
			assert.deepEqual(merged.coverage, mapping(["sk_a"]));
			// no base (a first sync): the two approval units differ, so the newer side's unit is kept and the other is saved
			// as a conflict copy with a note: never dropped silently
			const first = merge(null, olderRenamed, withMap);
			assert.equal(JSON.parse(first.content!).coverage, undefined);
			assert.ok(first.loser && JSON.parse(first.loser).coverage, "the side with the mapping is the conflict copy");
			assert.ok(first.notes.some((n) => /approval state/.test(n)));
		});
		it("an approval on one device and a mapping edit on the other cannot lose either silently: the newer wins, the other is a conflict copy", () => {
			const base = rec({ coverage: mapping(["sk_a"]) });
			const approvedHere = rec({ skills: ["sk_a", "sk_b"], coverage: mapping(["sk_b"]), updatedAt: "2026-11-27T00:00:00Z" });
			const editedThere = rec({ coverage: mapping(["sk_a", "sk_c"]), updatedAt: "2026-11-26T00:00:00Z" });
			const r = merge(base, approvedHere, editedThere);
			assert.deepEqual(JSON.parse(r.content!).coverage, mapping(["sk_b"]));
			assert.deepEqual(JSON.parse(r.content!).skills, ["sk_a", "sk_b"], "skills and mapping move together");
			assert.ok(r.loser, "the other side is kept as a conflict copy");
			assert.ok(r.notes.some((n) => /approval state/.test(n)), r.notes.join("; "));
		});
	});
});

// ─── the planner (scripted model) ────────────────────────────────────────────

describe("the planner maps the glossary (scripted model)", () => {
	function engine(steps: FauxResponseStep[]) {
		const faux = createFauxCore({});
		faux.setResponses(steps);
		return { model: faux.getModel(), streamFn: faux.streamSimple };
	}
	it("sees the core entries and pairs, and its mapping comes back checked against the glossary", async () => {
		let prompt = "";
		const submitted = {
			summary: "Two skills.",
			skills: [
				{ key: "s1", name: "Rings", statement: "Work with rings", requires: [], restsOn: [], cite: "Lecture 3.pdf, p. 2", terms: ["t_ring", "t_ideal", "t_unit", "t_made_up"] },
				{ key: "s2", name: "Fields", statement: "Work with fields", requires: ["s1"], restsOn: [], cite: "Lecture 3.pdf, p. 9", terms: ["t_field", "t_ring"] },
			],
			excludeTerms: [{ id: "t_Field", reason: "the slide-title form of field" }],
			linkTerms: [],
		};
		const out = await draftCourse(
			{ title: "Algebra", materials: [{ id: "mat_lec", name: "Lecture 3.pdf" }], materialsSection: "<curriculum/>", language: "en", glossary: GLOSSARY },
			{
				engine: engine([
					(ctx) => {
						prompt = JSON.stringify(ctx.messages);
						return fauxAssistantMessage([fauxToolCall("submit_draft", submitted as unknown as ToolCall["arguments"], { id: "c1" })], { stopReason: "toolUse" });
					},
				]),
				checkContext: () => ({ skills: new Map(), nodeIds: new Set() }),
				tools: {},
				courseId: "course_t",
				onStep: () => {},
			},
		);
		assert.match(prompt, /t_ideal :: ideal/);
		assert.match(prompt, /t_Field \(Field\) ~ t_field \(field\): similar name/);
		assert.match(prompt, /THE CLASS'S VOCABULARY/);
		assert.deepEqual(out.skills.map((s) => s.key), ["s1", "s2"]);
		assert.ok(!("terms" in out.skills[0]!), "the terms live in the proposal, not on the skills");
		assert.deepEqual(out.coverage, {
			items: [
				{ entryId: "t_ring", name: "ring", skills: ["s1", "s2"] },
				{ entryId: "t_ideal", name: "ideal", skills: ["s1"] },
				{ entryId: "t_unit", name: "unit", skills: ["s1"] },
				{ entryId: "t_field", name: "field", skills: ["s2"] },
				{ entryId: "t_Field", name: "Field", excluded: "the slide-title form of field" },
			],
			links: [],
			dropped: ["t_made_up"],
			incomplete: [],
			shown: { full: 5, names: 0, omitted: 0 },
		});
	});
	it("without a glossary the draft is as before: no proposal", async () => {
		const good = { summary: "s", skills: [{ key: "s1", name: "A", statement: "Do a", requires: [], restsOn: [], cite: "Book.pdf, p. 1" }] };
		const out = await draftCourse(
			{ title: "T", materials: [{ id: "m", name: "Book.pdf" }], materialsSection: "", language: "en" },
			{ engine: engine([() => fauxAssistantMessage([fauxToolCall("submit_draft", good as ToolCall["arguments"], { id: "c1" })], { stopReason: "toolUse" })]), checkContext: () => ({ skills: new Map(), nodeIds: new Set() }), tools: {}, courseId: "x", onStep: () => {} },
		);
		assert.equal(out.coverage, undefined);
	});
});

// ─── approval ────────────────────────────────────────────────────────────────

describe("approval with a vocabulary proposal", () => {
	function drafted(items: NonNullable<CourseRecord["draft"]>["coverage"]): CourseRecord {
		const c = courses.createCourse("Algebra draft");
		glossaries.set(c.id, GLOSSARY);
		return courseStore.updateCourse(c.id, {
			status: "draft",
			language: "en",
			draft: {
				createdAt: "2026-11-25T00:00:00Z",
				summary: "s",
				skills: [
					{ key: "s1", name: "Rings", statement: "Work with rings", requires: [], restsOn: [] },
					{ key: "s2", name: "Fields", statement: "Work with fields", requires: [], restsOn: [] },
				],
				coverage: items,
			},
		})!;
	}
	const proposal = () => ({
		items: [
			{ entryId: "t_ring", name: "ring", skills: ["s1"] },
			{ entryId: "t_field", name: "field", skills: ["s2"] },
		],
		links: [],
		dropped: [],
		incomplete: [],
		shown: { full: 5, names: 0, omitted: 0 },
	});

	it("refuses while core terms are unassigned, listing them, and writes nothing", () => {
		const c = drafted(proposal());
		const before = skillStore.readSkillLines().length;
		const r = courses.approveCourse(c.id);
		assert.equal(r.ok, false);
		assert.equal(!r.ok && r.status, 409);
		assert.match(!r.ok ? r.error : "", /^3 core terms are neither assigned to a skill nor excluded: (ideal|unit|Field)/);
		assert.match(!r.ok ? r.error : "", /Leave 3 unassigned/);
		assert.equal(skillStore.readSkillLines().length, before, "no skill written");
		assert.equal(courseStore.getCourse(c.id)!.status, "draft");
	});

	it("the student assigns and excludes on the draft, then approval goes through with skill ids", () => {
		const c = drafted(proposal());
		for (const edit of [
			{ action: "assign", key: "t_ideal", skill: "s1" },
			{ action: "exclude", key: "t_unit", reason: "never used" },
			{ action: "link", keys: ["t_field", "t_Field"] },
		] as const) assert.ok(cov.editCourseCoverage(c.id, "draft", edit as never).ok);
		const r = courses.approveCourse(c.id);
		assert.ok(r.ok, !r.ok ? r.error : "");
		const record = courseStore.getCourse(c.id)!;
		const ring = record.coverage!.items.find((i) => i.entryId === "t_ring")!;
		assert.ok(ring.skills![0]!.startsWith("sk_") && record.skills.includes(ring.skills![0]!), "draft keys became skill ids");
		assert.deepEqual(record.coverage!.links, [["t_Field", "t_field"]]);
		assert.equal(record.draft, undefined);
	});

	it("'leave N terms unassigned' approves with each one excluded as left out at approval", () => {
		const c = drafted(proposal());
		const r = courses.approveCourse(c.id, { leaveUnassigned: true });
		assert.ok(r.ok);
		const left = courseStore.getCourse(c.id)!.coverage!.items.filter((i) => i.leftAtApproval);
		assert.deepEqual(left.map((i) => [i.entryId, i.excluded]).sort(), [["t_Field", "left out at approval"], ["t_ideal", "left out at approval"], ["t_unit", "left out at approval"]]);
	});

	it("a draft without a proposal approves exactly as before (no coverage)", () => {
		const c = drafted(undefined);
		const r = courses.approveCourse(c.id);
		assert.ok(r.ok);
		assert.equal(courseStore.getCourse(c.id)!.coverage, undefined);
	});
});

// ─── the course view: states, reconciliation ─────────────────────────────────

describe("the course page's coverage view", () => {
	it("per skill: core terms introduced and checked; class-wide: unassigned and flagged after the glossary changes", () => {
		const c = mappedCourse();
		session(c.id, "learn", ["sk_rings"], [
			say("A ring is a set with two operations."),
			callMsg("q1", "quiz", { type: "check", nodeId: "n", lead: "Check.", question: "Is Z a ring?", explanation: "Yes.", options: [{ label: "yes" }, { label: "no" }], correctAnswer: "yes", level: "apply", conceptIds: ["t_ring"] }),
			result("q1", "quiz", { kind: "quiz", correct: true }),
		]);
		const v = courses.courseView(c.id)!.coverage!;
		assert.equal(v.status, "mapped");
		assert.deepEqual({ ...v.skills.sk_rings!, terms: undefined }, { total: 3, introduced: 1, checked: 1, terms: undefined });
		assert.deepEqual(v.skills.sk_rings!.terms.map((x) => [x.name, x.state, x.tier]), [["ideal", "new", "core"], ["ring", "checked", "core"], ["unit", "new", "core"], ["bit", "new", "supporting"]]);
		assert.equal(v.skills.sk_rings!.terms.find((x) => x.name === "ring")!.level, "apply");
		assert.deepEqual(v.unassigned, []);
		// re-index: "unit" is gone and "module" is new
		glossaries.set(c.id, glossaryOf([{ material: LEC, terms: [term("ring", { page: 2, def: "a set with two operations" }), term("ideal", { page: 5 }), term("field", { page: 9 }), term("Field", { page: 1, def: null }), term("module", { page: 11 })] }]));
		const after = courses.courseView(c.id)!.coverage!;
		assert.deepEqual(after.flagged.map((f) => f.key), ["t_unit", "t_bit"]);
		assert.deepEqual(after.unassigned.map((u) => u.name), ["module"]);
		assert.equal(after.skills.sk_rings!.total, 2, "a flagged item counts toward nothing");
	});

	it("an approved class with indexed terms and no mapping offers the mapping pass; a class with neither has no coverage at all", () => {
		const c = courses.createCourse("Old class");
		skillStore.appendSkillLines([skillLine("sk_old", "Old")]);
		courseStore.updateCourse(c.id, { status: "active", skills: ["sk_old"] });
		assert.equal(courses.courseView(c.id)!.coverage, undefined, "no glossary: unchanged");
		glossaries.set(c.id, GLOSSARY);
		const v = courses.courseView(c.id)!.coverage!;
		assert.equal(v.status, "unmapped");
		assert.equal(v.unassigned.length, 5);
		const html = renderToStaticMarkup(<CourseBody data={{ ...courses.courseView(c.id)!, drafting: false }} busy={false} error={null} onDraft={() => {}} onApprove={() => {}} onStart={() => {}} materialCount={1} onCoverage={{ edit: () => {}, map: () => {}, approveLeaving: () => {} }} />);
		assert.match(html, /data-testid="coverage-map"[^>]*>Map the class&#x27;s terms</);
	});

	it("the draft review shows each skill's terms, the unassigned ones, the pairs side by side and the leave button", () => {
		const c = courses.createCourse("Draft view");
		glossaries.set(c.id, GLOSSARY);
		courseStore.updateCourse(c.id, {
			status: "draft",
			language: "en",
			draft: {
				createdAt: "2026-11-25T00:00:00Z",
				summary: "s",
				skills: [{ key: "s1", name: "Rings", statement: "Work with rings", requires: [], restsOn: [] }],
				coverage: { items: [{ entryId: "t_ring", name: "ring", skills: ["s1"] }], links: [], dropped: ["t_ghost"], incomplete: [], shown: { full: 5, names: 0, omitted: 0 } },
			},
		});
		const html = renderToStaticMarkup(<CourseBody data={{ ...courses.courseView(c.id)!, drafting: false }} busy={false} error={null} onDraft={() => {}} onApprove={() => {}} onStart={() => {}} materialCount={1} onCoverage={{ edit: () => {}, map: () => {}, approveLeaving: () => {} }} />);
		assert.match(html, /data-testid="draft-terms-s1"[^>]*>Terms: ring</);
		assert.match(html, /4 new terms are not assigned to a skill/);
		assert.match(html, /data-testid="draft-leave-unassigned"[^>]*>Leave 4 terms unassigned</);
		assert.match(html, /data-testid="duplicate-t_Field~t_field"/);
		assert.match(html, /data-testid="same-t_Field~t_field"[^>]*>Same thing</);
		assert.match(html, /a set with two operations|subring closed under multiplication/);
		assert.match(html, /data-testid="draft-dropped"[^>]*>The planner named 1 term id that is not in the glossary; dropped: t_ghost/);
	});
});

// ─── the session: prompt block and finish check ──────────────────────────────

describe("a Learn session on a mapped class", () => {
	it("gets the skill's vocabulary in its course section, with carried items, and a finish check over core items only", () => {
		const c = mappedCourse();
		// an earlier lesson introduced "ideal" and deferred "unit"
		session(c.id, "learn", ["sk_rings"], [
			say("An ideal absorbs multiplication."),
			callMsg("f0", "finish_lesson", { summary: "s", deferred: [{ id: "t_unit", why: "next week" }] }),
			result("f0", "finish_lesson", { grades: [] }),
		]);
		const learn = session(c.id, "learn", ["sk_rings"], []);
		const turn = courses.courseForTurn(learn)!;
		assert.match(turn.section, /VOCABULARY — the class's own terms that "Rings" owes/);
		assert.match(turn.section, /- \[t_ideal\] ideal — introduced in an earlier session, not checked yet \(carried over\)\. The material: "a subring closed under multiplication by ring elements" \(Lecture 3\.pdf, p\. 5\)/);
		assert.match(turn.section, /- \[t_unit\] unit — new, left for later by an earlier lesson \(carried over\)\. The material uses it without defining it \(Lecture 3\.pdf, p\. 7\)\./);
		assert.match(turn.section, /- \[t_ring\] ring — new\./);
		assert.match(turn.section, /- \[t_bit\] bit \(supporting\)/);
		assert.deepEqual(turn.vocabulary!.items.map((i) => i.key).sort(), ["t_ideal", "t_ring", "t_unit"], "supporting items never block");
		assert.ok(turn.conceptIds!.has("t_ring") && !turn.conceptIds!.has("t_made_up"));
		// the live check: this lesson's own text counts
		const live = [say("A ring has two operations.")];
		assert.deepEqual([...turn.vocabulary!.introduced(live)].sort(), ["t_ideal", "t_ring"]);
	});

	it("a class without coverage, and an Ask conversation, get no vocabulary", () => {
		const c = courses.createCourse("Plain");
		skillStore.appendSkillLines([skillLine("sk_plain", "Plain")]);
		courseStore.updateCourse(c.id, { status: "active", skills: ["sk_plain"] });
		const learn = session(c.id, "learn", ["sk_plain"], []);
		const turn = courses.courseForTurn(learn)!;
		assert.doesNotMatch(turn.section, /VOCABULARY/);
		assert.equal(turn.vocabulary, undefined);
		assert.equal(turn.conceptIds, undefined);
		const m = mappedCourse();
		const askId = session(m.id, "ask", [], []);
		assert.doesNotMatch(courses.courseForTurn(askId)!.section, /VOCABULARY/);
	});
});

describe("the finish refusal through the teacher agent (scripted model)", () => {
	const finishInput = Type.Object({ summary: Type.String(), deferred: Type.Array(Type.Object({ id: Type.String(), why: Type.String() })) });
	const finishTool: AgentTool<typeof finishInput> = {
		name: "finish_lesson",
		label: "finish_lesson",
		description: "finish",
		parameters: finishInput,
		execute: async () => ({ content: [{ type: "text", text: "Logged." }], details: null }),
	};
	const finalProblem = [
		callMsg("x1", "explain", { type: "final", nodeId: "goal", lead: "Last one.", question: "Is 2Z an ideal of Z?", correctAnswer: "yes", keyPoints: ["a", "b"], level: "apply", conceptIds: [] }),
		result("x1", "explain", { kind: "explain", tool: "explain", dontKnow: false, text: "yes" }),
	];
	const step = (id: string, args: Record<string, unknown>, text?: string) => () =>
		fauxAssistantMessage([...(text ? [{ type: "text" as const, text }] : []), fauxToolCall("finish_lesson", args as ToolCall["arguments"], { id })], { stopReason: "toolUse" });
	async function run(vocabulary: LessonVocabulary | undefined, history: LhMessage[], steps: Array<() => ReturnType<typeof fauxAssistantMessage>>) {
		const faux = createFauxCore({});
		faux.setResponses(steps as never);
		const ctx = { chatId: "c", chatStore: { getChat: () => undefined }, jobStore: {}, spawn: () => {}, lesson: { skill: { id: "sk_rings", name: "Rings" }, ...(vocabulary ? { vocabulary } : {}) } };
		const agent = createTeacherAgent(ctx as never, {
			engine: { model: { ...faux.getModel(), provider: "claude-code" }, streamFn: faux.streamSimple },
			tools: { finish_lesson: finishTool },
			messages: [{ role: "user", content: "start", timestamp: 1 }, ...history] as never,
		});
		await agent.continue();
		const results = agent.state.messages.filter((m) => (m as { role?: string }).role === "toolResult") as unknown as Array<{ toolCallId: string; isError: boolean; content: Array<{ text: string }> }>;
		return (id: string) => results.find((r) => r.toolCallId === id)!;
	}
	const lessonVocabulary = () => {
		const c = mappedCourse();
		return courses.courseForTurn(session(c.id, "learn", ["sk_rings"], []))!.vocabulary!;
	};

	it("refuses once, naming the items; the same call again goes through", async () => {
		const by = await run(lessonVocabulary(), finalProblem, [step("f1", { summary: "s", deferred: [] }), step("f2", { summary: "s", deferred: [] })]);
		assert.equal(by("f1").isError, true);
		// "ideal" is not owed: the final problem's question ("Is 2Z an ideal of Z?") introduced it in this lesson
		assert.match(by("f1").content[0]!.text, new RegExp(`^${VOCABULARY_REFUSAL_HEAD.replace(/[()]/g, "\\$&")} this lesson's skill owes 2 core terms`));
		assert.match(by("f1").content[0]!.text, /: ring \[t_ring\], unit \[t_unit\]\./);
		assert.equal(by("f2").isError, false, `never twice: ${by("f2").content[0]!.text}`);
	});
	it("respects deferred and what this lesson introduced", async () => {
		const by = await run(lessonVocabulary(), finalProblem, [
			step("f1", { summary: "s", deferred: [{ id: "t_ideal", why: "next lesson" }, { id: "t_unit", why: "not needed yet" }] }, "So a ring is what we built today."),
		]);
		assert.equal(by("f1").isError, false);
	});
	it("respects the budget: after the finish gate's share is spent the call passes unrefused", async () => {
		// no final problem: the final-problem gate refuses twice (the finish gate's share), the third call passes both checks
		const by = await run(lessonVocabulary(), [], [step("f1", { summary: "s", deferred: [] }), step("f2", { summary: "s", deferred: [] }), step("f3", { summary: "s", deferred: [] })]);
		assert.equal(by("f1").isError, true);
		assert.equal(by("f2").isError, true);
		assert.equal(by("f3").isError, false);
	});
	it("a class without coverage is never refused for vocabulary", async () => {
		const by = await run(undefined, finalProblem, [step("f1", { summary: "s", deferred: [] })]);
		assert.equal(by("f1").isError, false);
	});
});

// ─── the lesson result ───────────────────────────────────────────────────────

describe("the lesson result", () => {
	it("says in one line what was covered and what was left, in the lesson language", () => {
		const c = mappedCourse();
		const learn = session(c.id, "learn", ["sk_rings"], [
			say("A ring has two operations."),
			callMsg("f1", "finish_lesson", { summary: "Showed rings.", deferred: [{ id: "t_unit", why: "later" }] }),
			result("f1", "finish_lesson", { grades: [] }),
		]);
		const r = courses.lessonResult(learn)!;
		assert.deepEqual(r.coverage, { total: 3, covered: 1, left: ["ideal", "unit"], language: "en" });
		const html = renderToStaticMarkup(<LessonResultView result={r} now={Date.now()} onPractice={() => {}} onNext={() => {}} onCourse={() => {}} />);
		assert.match(html, /Covered 1 of 3 terms; 2 left for next time: ideal, unit/);
		const nb = renderToStaticMarkup(<LessonResultView result={{ ...r, coverage: { ...r.coverage!, language: "nb" } }} now={Date.now()} onPractice={() => {}} onNext={() => {}} onCourse={() => {}} />);
		assert.match(nb, /Gikk gjennom 1 av 3 begreper; 2 til neste gang: ideal, unit/);
	});
	it("a class without coverage shows no line (old data unchanged)", () => {
		const c = courses.createCourse("Plain 2");
		skillStore.appendSkillLines([skillLine("sk_p2", "P2")]);
		courseStore.updateCourse(c.id, { status: "active", skills: ["sk_p2"] });
		const learn = session(c.id, "learn", ["sk_p2"], [callMsg("f1", "finish_lesson", { summary: "s" }), result("f1", "finish_lesson", { grades: [] })]);
		assert.equal(courses.lessonResult(learn)!.coverage, undefined);
	});
});

// ─── the cache ───────────────────────────────────────────────────────────────

describe("the per-chat vocabulary cache", () => {
	it("gives the uncached result, scans each chat once, rescans a changed chat, and rescans all when the names change; measured on 50 sessions and 500 items", () => {
		const names = Array.from({ length: 500 }, (_, i) => `concept${i} term`);
		const big = glossaryOf([{ material: LEC, terms: names.map((n, i) => term(n, { page: 1 + (i % 40) })) }]);
		const c = courses.createCourse("Big class");
		const skills = Array.from({ length: 10 }, (_, i) => skillLine(`sk_big${i}`, `Skill ${i}`));
		skillStore.appendSkillLines(skills);
		glossaries.set(c.id, big);
		courseStore.updateCourse(c.id, {
			status: "active",
			skills: skills.map((s) => s.id),
			coverage: { updatedAt: "2026-11-25T00:00:00Z", items: Object.values(big.terms).map((e, i) => ({ entryId: e.id, name: e.term, skills: [skills[i % 10]!.id] })), links: [] },
		});
		const paragraph = (i: number) => `In this step we use concept${i} term and concept${(i * 7) % 500} term together, then a long explanation follows. `.repeat(6);
		const ids: string[] = [];
		for (let s = 0; s < 50; s++) {
			const messages: LhMessage[] = [];
			for (let k = 0; k < 40; k++) messages.push(say(paragraph(s * 10 + k)));
			ids.push(session(c.id, "learn", [skills[s % 10]!.id], messages));
		}
		const course = courseStore.getCourse(c.id)!;
		cov.clearCourseVocabularyCache();
		const scans0 = cov.courseVocabularyScans();
		let t0 = performance.now();
		const cold = cov.coverageView(course, "en", false)!;
		const coldMs = performance.now() - t0;
		assert.equal(cov.courseVocabularyScans() - scans0, 50, "each chat scanned once");
		t0 = performance.now();
		const warm = cov.coverageView(course, "en", false)!;
		const warmMs = performance.now() - t0;
		assert.equal(cov.courseVocabularyScans() - scans0, 50, "a warm page load scans nothing");
		const uncached = cov.coverageView(course, "en", false, { cache: false })!;
		assert.deepEqual(warm, cold);
		assert.deepEqual(uncached, cold, "the cache gives the uncached result");
		// a changed chat is scanned again (its file stamp changed)
		chatStore.saveMessages(ids[0]!, [...chatStore.getChat(ids[0]!)!.messages, say("Finally concept499 term.")]);
		const before = cov.courseVocabularyScans();
		cov.coverageView(course, "en", false);
		assert.equal(cov.courseVocabularyScans() - before, 1);
		// new names (a re-index): every chat once more
		glossaries.set(c.id, glossaryOf([{ material: LEC, terms: [...names, "brand new term"].map((n) => term(n)) }]));
		const before2 = cov.courseVocabularyScans();
		cov.coverageView(courseStore.getCourse(c.id)!, "en", false);
		assert.equal(cov.courseVocabularyScans() - before2, 50);
		const introduced = Object.values(cold.skills).reduce((n, s) => n + s.introduced, 0);
		assert.ok(introduced > 400, `${introduced} introduced`);
		console.log(`[coverage perf] 50 sessions x 40 messages, 500 items: cold ${coldMs.toFixed(0)} ms, warm ${warmMs.toFixed(1)} ms`);
	});
});

// ─── the turn timeline ───────────────────────────────────────────────────────

describe("the turn timeline counts concept ids that are not an item of the class", () => {
	it("tagged and unknown on quiz/explain calls, only when the session has coverage", async () => {
		const { TurnTimeline } = await import("../src/server/turn-timeline.ts");
		const lines: Array<Record<string, unknown>> = [];
		const start = (args: unknown, toolName = "quiz") => ({ type: "tool_execution_start", toolCallId: `c${t++}`, toolName, args }) as never;
		const watched = new TurnTimeline({ turnId: "t", chatId: "c", provider: "p", model: "m", thinking: false }, (l) => void lines.push(l as never));
		watched.watchConceptIds(new Set(["t_ring", "t_ideal"]));
		watched.event(start({ conceptIds: ["t_ring", "ring", "t_made_up"] }));
		watched.event(start({ conceptIds: ["t_ideal"] }, "explain"));
		watched.event(start({ conceptIds: ["t_whatever"] }, "send_to_user"));
		watched.finish(false);
		assert.deepEqual(lines[0]!.conceptIds, { tagged: 4, unknown: 2 });
		const plain = new TurnTimeline({ turnId: "t", chatId: "c", provider: "p", model: "m", thinking: false }, (l) => void lines.push(l as never));
		plain.event(start({ conceptIds: ["t_ring"] }));
		plain.finish(false);
		assert.equal("conceptIds" in lines[1]!, false, "absent without coverage");
	});
});
