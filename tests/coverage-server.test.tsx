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

/** A course chat with its messages. A Learn or one-skill Practice session is stamped with the items it is listed, as
 *  createCourseSession stamps it at birth (server/course-coverage.ts listedVocabularyFor). */
function session(courseId: string, mode: "learn" | "practice" | "ask", skillIds: string[], messages: LhMessage[]): string {
	const course = courseStore.getCourse(courseId)!;
	const listed = (mode === "learn" || (mode === "practice" && skillIds.length === 1)) ? cov.listedVocabularyFor(course, skillIds[0]!) : undefined;
	const chat = chatStore.createChat(`${mode}`, mode === "practice" ? "practice" : undefined, { courseId, mode, skillIds, ...(listed ? { vocabulary: listed } : {}) });
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
		it("an older-shaped record lacking the field does not erase the base's mapping (review 1, finding 6)", () => {
			const base = rec({ coverage: mapping(["sk_a"]) });
			// this device left the approval unit unchanged; the other runs a build without coverage and wrote the record
			const older = rec({ title: "Renamed", updatedAt: "2026-11-26T00:00:00Z" }); // an older-shaped record: no `coverage` key at all
			for (const [local, remote] of [[base, older], [older, base]] as const) {
				const r = merge(base, local, remote);
				const merged = JSON.parse(r.content!);
				assert.deepEqual(merged.coverage, mapping(["sk_a"]), "kept: every skill it names is still the class's");
				assert.equal(merged.title, "Renamed");
				assert.equal(r.loser, null);
				assert.ok(r.notes.some((n) => /vocabulary mapping/.test(n)), r.notes.join("; "));
			}
			// the older side also changed the skills, so the mapping no longer fits: it is saved in a conflict copy with a note
			const olderNewSkills = { ...older, skills: ["sk_z"] };
			const r = merge(base, base, olderNewSkills);
			assert.equal(JSON.parse(r.content!).coverage, undefined);
			assert.ok(r.loser && JSON.parse(r.loser).coverage, "the side with the mapping is the conflict copy");
			assert.ok(r.notes.some((n) => /dropped the course's vocabulary mapping/.test(n)), r.notes.join("; "));
			// an explicit deletion (JSON null) is a deletion
			const deleted = rec({ coverage: null, updatedAt: "2026-11-26T00:00:00Z" });
			assert.equal(JSON.parse(merge(base, base, deleted).content!).coverage, null);
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

	it("a draft without a proposal, when the live glossary has core terms, is an empty mapping: refused with the list (review 1, finding 4)", () => {
		const c = drafted(undefined);
		const r = courses.approveCourse(c.id);
		assert.equal(r.ok, false);
		assert.equal(!r.ok && r.status, 409);
		assert.match(!r.ok ? r.error : "", /^5 core terms are neither assigned to a skill nor excluded/);
		assert.equal(courseStore.getCourse(c.id)!.status, "draft", "nothing written");
		// the draft review shows those entries with the same actions, and offers the mapping pass
		const html = renderToStaticMarkup(<CourseBody data={{ ...courses.courseView(c.id)!, drafting: false }} busy={false} error={null} onDraft={() => {}} onApprove={() => {}} onStart={() => {}} materialCount={1} onCoverage={{ edit: () => {}, map: () => {}, approveLeaving: () => {} }} />);
		assert.match(html, /data-testid="draft-coverage-empty"/);
		assert.match(html, /data-testid="draft-coverage-map"[^>]*>Map the class&#x27;s terms</);
		assert.match(html, /5 new terms are not assigned to a skill/);
		assert.match(html, /data-testid="assign-t_ring"/);
		// an edit on it starts the proposal; "leave unassigned" approves
		assert.ok(cov.editCourseCoverage(c.id, "draft", { action: "assign", key: "t_ring", skill: "s1" }).ok);
		assert.equal(courseStore.getCourse(c.id)!.draft!.coverage!.items.length, 1);
		const left = courses.approveCourse(c.id, { leaveUnassigned: true });
		assert.ok(left.ok);
		assert.equal(courseStore.getCourse(c.id)!.coverage!.items.filter((i) => i.leftAtApproval).length, 4);
	});

	it("a class whose glossary has no core term approves exactly as before (no coverage)", () => {
		const c = drafted(undefined);
		glossaries.set(c.id, glossaryOf([{ material: LEC, terms: [term("bit", { tier: "supporting" })] }]));
		const r = courses.approveCourse(c.id);
		assert.ok(r.ok, !r.ok ? r.error : "");
		assert.equal(courseStore.getCourse(c.id)!.coverage, undefined);
	});

	it("re-approval carries every still-valid decision forward and lists the ones it dropped; no stale skill id remains", () => {
		const c = mappedCourse({
			updatedAt: "2026-11-25T00:00:00Z",
			items: [
				{ entryId: "t_ring", name: "ring", skills: ["sk_rings"] },
				{ entryId: "t_ideal", name: "ideal", skills: ["sk_rings"] },
				{ entryId: "t_unit", name: "unit", excluded: "the student's call" },
				{ entryId: "t_field", name: "field", skills: ["sk_fields"] },
				{ entryId: "t_Field", name: "Field", skills: ["sk_fields"] },
			],
			links: [["t_Field", "t_field"]],
		});
		// a re-draft that keeps Rings (reused) and replaces Fields with a new skill; its planner proposes other things
		courseStore.updateCourse(c.id, {
			draft: {
				createdAt: "2026-11-26T00:00:00Z",
				summary: "s",
				skills: [
					{ key: "s1", reuse: "sk_rings", name: "Rings", statement: "Do Rings", requires: [], restsOn: [] },
					{ key: "s2", name: "Fields again", statement: "Work with fields", requires: [], restsOn: [] },
				],
				coverage: { items: [{ entryId: "t_ring", name: "ring", skills: ["s2"] }, { entryId: "t_unit", name: "unit", skills: ["s1"] }], links: [], dropped: [], incomplete: [], shown: { full: 5, names: 0, omitted: 0 } },
			},
		});
		const refused = courses.approveCourse(c.id);
		assert.equal(refused.ok, false, "field and Field lost their skill: unassigned, so listed");
		assert.match(!refused.ok ? refused.error : "", /2 core terms are neither assigned.*(field|Field)/);
		assert.ok(cov.editCourseCoverage(c.id, "draft", { action: "assign", key: "t_field", skill: "s2" }).ok);
		assert.ok(cov.editCourseCoverage(c.id, "draft", { action: "assign", key: "t_Field", skill: "s2" }).ok);
		const r = courses.approveCourse(c.id);
		assert.ok(r.ok, !r.ok ? r.error : "");
		const record = courseStore.getCourse(c.id)!;
		const by = new Map(record.coverage!.items.map((i) => [i.entryId, i]));
		assert.deepEqual(by.get("t_ring")!.skills, ["sk_rings"], "the earlier assignment wins over the re-draft's proposal");
		assert.equal(by.get("t_unit")!.excluded, "the student's call", "an earlier exclusion is kept");
		assert.deepEqual(record.coverage!.links, [["t_Field", "t_field"]], "a link whose members exist is kept");
		const live = new Set(record.skills);
		assert.ok(record.coverage!.items.every((i) => (i.skills ?? []).every((s) => live.has(s))), "no stale skill id");
		assert.deepEqual(record.coverage!.displaced!.map((d) => d.key).sort(), ["t_Field", "t_field"]);
		const html = renderToStaticMarkup(<CourseBody data={{ ...courses.courseView(c.id)!, drafting: false }} busy={false} error={null} onDraft={() => {}} onApprove={() => {}} onStart={() => {}} materialCount={1} onCoverage={{ edit: () => {}, map: () => {}, approveLeaving: () => {} }} />);
		assert.match(html, /data-testid="coverage-displaced"/);
		assert.match(html, /data-testid="displaced-t_field"[^>]*><span[^>]*>field<\/span> — its skill is not in the new class map; assign it again/);
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

	it("introduced and checked are independent: a tag alone gives 'asked about, never named'; the deferral count shows beside the term", () => {
		const c = mappedCourse();
		session(c.id, "learn", ["sk_rings"], [
			callMsg("q1", "quiz", { type: "check", nodeId: "n", lead: "Quick one.", question: "2+2?", explanation: "Four.", options: [{ label: "4" }, { label: "5" }], correctAnswer: "4", level: "recall", conceptIds: ["t_unit"] }),
			result("q1", "quiz", { kind: "quiz", questionText: "2+2?", options: [{ index: 1, label: "4" }, { index: 2, label: "5" }], answers: [{ index: 2, label: "5", value: "5" }], dontKnow: false, correct: false, answeredAt: "t" }),
			callMsg("f1", "finish_lesson", { summary: "s", deferred: [{ id: "t_ideal", why: "next week" }] }),
			result("f1", "finish_lesson", { grades: [] }),
		]);
		const v = courses.courseView(c.id)!.coverage!;
		const unit = v.skills.sk_rings!.terms.find((x) => x.name === "unit")!;
		assert.deepEqual([unit.state, unit.right], ["asked", false]);
		assert.deepEqual({ ...v.skills.sk_rings!, terms: undefined }, { total: 3, introduced: 0, checked: 1, terms: undefined });
		assert.equal(v.skills.sk_rings!.terms.find((x) => x.name === "ideal")!.deferredCount, 1);
	});

	it("a mapping pass's suggestions are shown one by one with Accept and Dismiss; accepting is the student's edit", () => {
		const c = mappedCourse();
		courseStore.updateCourse(c.id, { coverage: { ...courseStore.getCourse(c.id)!.coverage!, suggested: { excluded: [{ key: "t_ideal", reason: "not in the exam" }], links: [["t_Field", "t_field"]] } } });
		const html = renderToStaticMarkup(<CourseBody data={{ ...courses.courseView(c.id)!, drafting: false }} busy={false} error={null} onDraft={() => {}} onApprove={() => {}} onStart={() => {}} materialCount={1} onCoverage={{ edit: () => {}, map: () => {}, approveLeaving: () => {} }} />);
		assert.match(html, /data-testid="suggested-exclude-t_ideal"/);
		assert.match(html, /— Leave out: not in the exam/);
		assert.match(html, /data-testid="suggested-exclude-accept-t_ideal"[^>]*>Accept</);
		assert.match(html, /data-testid="suggested-link-accept-t_Field~t_field"[^>]*>Same thing</);
		assert.equal(courseStore.getCourse(c.id)!.coverage!.items.find((i) => i.entryId === "t_ideal")!.excluded, undefined, "nothing applied by itself");
		assert.ok(cov.editCourseCoverage(c.id, "approved", { action: "exclude", key: "t_ideal", reason: "not in the exam" }).ok);
		const after = courseStore.getCourse(c.id)!.coverage!;
		assert.equal(after.items.find((i) => i.entryId === "t_ideal")!.excluded, "not in the exam");
		assert.deepEqual(after.suggested, { excluded: [], links: [["t_Field", "t_field"]] });
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
		const made = courses.createCourseSession(c.id, "learn", "sk_rings");
		assert.ok(made.ok, !made.ok ? made.error : "");
		const learn = made.ok ? made.value.id : "";
		assert.deepEqual(chatStore.getChat(learn)!.course!.vocabulary, ["t_unit", "t_ideal", "t_ring", "t_bit"], "the listed items are stored with the session when it starts");
		const turn = courses.courseForTurn(learn)!;
		assert.match(turn.section, /VOCABULARY — the class's own terms that this lesson of "Rings" owes/);
		assert.match(turn.section, /- \[t_ideal\] ideal — introduced in an earlier session, not checked yet \(carried over\)\. The material: "a subring closed under multiplication by ring elements" \(Lecture 3\.pdf, p\. 5\)/);
		assert.match(turn.section, /- \[t_unit\] unit — new, left for later by an earlier lesson \(carried over\)\. The material uses it without defining it \(Lecture 3\.pdf, p\. 7\)\./);
		assert.match(turn.section, /- \[t_ring\] ring — new\./);
		assert.match(turn.section, /- \[t_bit\] bit \(supporting\)/);
		assert.deepEqual(turn.vocabulary!.items.map((i) => i.key).sort(), ["t_ideal", "t_ring", "t_unit"], "supporting items never block");
		assert.ok(turn.conceptIds!.has("t_ring") && turn.conceptIds!.has("[t_ring]") && turn.conceptIds!.has("ring") && !turn.conceptIds!.has("t_made_up"), "the timeline reads tags as the ledger does");
		// the live check: this lesson's own text counts
		const live = [say("A ring has two operations.")];
		assert.deepEqual([...turn.vocabulary!.introduced(live)].sort(), ["t_ideal", "t_ring"]);
	});

	it("a lesson owes only what it was listed (review 1, finding 9): 60 new terms, 12 listed and checked at finish, the next session lists the next", () => {
		const names = Array.from({ length: 60 }, (_, i) => `group axiom ${i}`);
		const big = glossaryOf([{ material: LEC, terms: names.map((n, i) => term(n, { page: 1 + i })) }]);
		const c = courses.createCourse("Big skill");
		skillStore.appendSkillLines([skillLine("sk_big", "Groups")]);
		glossaries.set(c.id, big);
		courseStore.updateCourse(c.id, { status: "active", skills: ["sk_big"], language: "en", coverage: { updatedAt: "x", items: Object.values(big.terms).map((e) => ({ entryId: e.id, name: e.term, skills: ["sk_big"] })), links: [] } });
		const first = session(c.id, "learn", ["sk_big"], []);
		const turn = courses.courseForTurn(first)!;
		assert.equal(turn.section.split("\n").filter((l) => l.startsWith("- [")).length, 12);
		assert.match(turn.section, /\(48 more terms of this skill are left for later sessions; not owed by this one\.\)/);
		assert.equal(turn.vocabulary!.items.length, 12, "the finish gate checks exactly the listed ones");
		const listed = chatStore.getChat(first)!.course!.vocabulary!;
		// that lesson defers all twelve; the next lesson lists those carried ones first, again twelve, the rest still later
		chatStore.saveMessages(first, [callMsg("f1", "finish_lesson", { summary: "s", deferred: listed.map((id) => ({ id, why: "time" })) }), result("f1", "finish_lesson", { grades: [] })]);
		const next = session(c.id, "learn", ["sk_big"], []);
		assert.deepEqual(chatStore.getChat(next)!.course!.vocabulary, listed, "carried-over items first");
		assert.match(courses.courseForTurn(next)!.section, /new, left for later by an earlier lesson \(carried over\)/);
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
	const finishInput = Type.Object({ summary: Type.String(), deferred: Type.Optional(Type.Array(Type.Object({ id: Type.String(), why: Type.String() }))) });
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
	const gates: string[] = [];
	async function runAll(vocabulary: LessonVocabulary | undefined, history: LhMessage[], steps: Array<() => ReturnType<typeof fauxAssistantMessage>>) {
		const faux = createFauxCore({});
		faux.setResponses(steps as never);
		gates.length = 0;
		const ctx = { chatId: "c", chatStore: { getChat: () => undefined }, jobStore: {}, spawn: () => {}, lesson: { skill: { id: "sk_rings", name: "Rings" }, ...(vocabulary ? { vocabulary } : {}) } };
		const agent = createTeacherAgent(ctx as never, {
			engine: { model: { ...faux.getModel(), provider: "claude-code" }, streamFn: faux.streamSimple },
			tools: { finish_lesson: finishTool },
			messages: [{ role: "user", content: "start", timestamp: 1 }, ...history] as never,
			onGateRefusal: (gate: string) => gates.push(gate),
		} as never);
		await agent.continue();
		const results = agent.state.messages.filter((m) => (m as { role?: string }).role === "toolResult") as unknown as Array<{ toolCallId: string; isError: boolean; content: Array<{ text: string }>; details?: unknown }>;
		return { by: (id: string) => results.find((r) => r.toolCallId === id)!, messages: agent.state.messages as unknown as LhMessage[] };
	}
	const run = async (...a: Parameters<typeof runAll>) => (await runAll(...a)).by;
	const lessonVocabulary = () => {
		const c = mappedCourse();
		return courses.courseForTurn(session(c.id, "learn", ["sk_rings"], []))!.vocabulary!;
	};

	it("refuses once, naming the items; the same call again goes through", async () => {
		const by = await run(lessonVocabulary(), finalProblem, [step("f1", { summary: "s", deferred: [] }), step("f2", { summary: "s", deferred: [] })]);
		assert.equal(by("f1").isError, true);
		// "ideal" is not owed: the final problem's question ("Is 2Z an ideal of Z?") introduced it in this lesson
		assert.match(by("f1").content[0]!.text, new RegExp(`^${VOCABULARY_REFUSAL_HEAD.replace(/[()]/g, "\\$&")} this lesson owes 2 core terms`));
		assert.match(by("f1").content[0]!.text, /: ring \[t_ring\], unit \[t_unit\]\. Work the next one in where it belongs/);
		assert.deepEqual(gates, ["vocabulary"], "its own gate");
		assert.equal(by("f2").isError, false, `never twice: ${by("f2").content[0]!.text}`);
	});
	it("respects deferred and what this lesson introduced", async () => {
		const by = await run(lessonVocabulary(), finalProblem, [
			step("f1", { summary: "s", deferred: [{ id: "t_ideal", why: "next lesson" }, { id: "t_unit", why: "not needed yet" }] }, "So a ring is what we built today."),
		]);
		assert.equal(by("f1").isError, false);
	});
	it("respects the budget: the final-problem gate keeps its two, the vocabulary check its own one; then the older exhausted-share pass", async () => {
		// no final problem: the final-problem gate refuses twice (its share); the third call passes it and meets the
		// vocabulary check on its own allowance (review 1: it used to share the final-problem gate's counter and got none)
		const by = await run(lessonVocabulary(), [], [step("f1", { summary: "s" }), step("f2", { summary: "s" }), step("f3", { summary: "s" }), step("f4", { summary: "s" })]);
		assert.match(by("f1").content[0]!.text, /^Refused: a lesson finishes only after ONE final problem/);
		assert.match(by("f2").content[0]!.text, /^Refused: a lesson finishes only after ONE final problem/);
		assert.match(by("f3").content[0]!.text, /^Refused \(vocabulary\)/);
		assert.deepEqual(gates, ["finish", "finish", "vocabulary"]);
		assert.equal(by("f4").isError, false, "the exhausted final-problem share passes, as before this package");
	});
	it("a class without coverage is never refused for vocabulary, and `deferred` may be left out", async () => {
		const by = await run(undefined, finalProblem, [step("f1", { summary: "s" })]);
		assert.equal(by("f1").isError, false);
	});
	it("a failed sibling in the finish's own message counts for nothing, and the gate agrees with the later scan (review 1, finding 1)", async () => {
		const vocabulary = lessonVocabulary();
		const same = () =>
			fauxAssistantMessage(
				[
					fauxToolCall("finish_lesson", { summary: "s" } as ToolCall["arguments"], { id: "f1" }),
					fauxToolCall("quiz", { type: "check", nodeId: "n", lead: "A ring and a unit.", question: "Is every unit of a ring invertible?", explanation: "yes", options: [{ label: "yes" }, { label: "no" }], correctAnswer: "yes", level: "apply", conceptIds: [] } as ToolCall["arguments"], { id: "q1" }),
				],
				{ stopReason: "toolUse" },
			);
		const { by, messages } = await runAll(vocabulary, finalProblem, [same, step("f2", { summary: "s" })]);
		assert.match(by("q1").content[0]!.text, /Tool quiz not found/);
		assert.equal(by("f1").isError, true, "refused: the quiz never reached the learner");
		assert.match(by("f1").content[0]!.text, /ring \[t_ring\], unit \[t_unit\]/);
		// the later transcript scan (the course page's) sees the same lesson the same way
		const scanned = vocabulary.introduced(messages);
		assert.equal(scanned.has("t_ring") || scanned.has("t_unit"), false);
		assert.equal(by("f2").isError, false, "once per lesson");
	});
	it("a vocabulary refusal never spends the final-problem requirement's share: refusal, grader 'again', finish without a new final", async () => {
		const { installPracticeGrader } = await import("../src/agent/practice-grade.ts");
		let graded = 0;
		installPracticeGrader(async () => (graded++ === 0 ? { grades: [{ skill: "sk_rings", grade: "again" }] } : { grades: [{ skill: "sk_rings", grade: "good" }] }));
		try {
			const { by } = await runAll(lessonVocabulary(), finalProblem, [step("f1", { summary: "s" }), step("f2", { summary: "s" }), step("f3", { summary: "s" }), step("f4", { summary: "s" }), step("f5", { summary: "s" })]);
			assert.match(by("f1").content[0]!.text, /^Refused \(vocabulary\)/);
			assert.match(by("f2").content[0]!.text, /^NOT FINISHED/, "the grader turned the finish back");
			assert.match(by("f3").content[0]!.text, /^Refused: a lesson finishes only after ONE final problem/);
			assert.match(by("f4").content[0]!.text, /^Refused: a lesson finishes only after ONE final problem/, "the requirement keeps its full share of two");
			assert.deepEqual(gates, ["vocabulary", "finish", "finish"]);
			assert.equal(by("f5").isError, false, "then the older exhausted-share pass (unchanged by this package)");
		} finally {
			installPracticeGrader(null);
		}
	});
	it("two finish calls in one message after an answered final: one attempt, refused once for vocabulary, the other goes through", async () => {
		const both = () =>
			fauxAssistantMessage([fauxToolCall("finish_lesson", { summary: "s" } as ToolCall["arguments"], { id: "fa" }), fauxToolCall("finish_lesson", { summary: "s" } as ToolCall["arguments"], { id: "fb" })], { stopReason: "toolUse" });
		const { by } = await runAll(lessonVocabulary(), finalProblem, [both]);
		assert.match(by("fa").content[0]!.text, /^Refused \(vocabulary\)/);
		assert.equal(by("fb").isError, false, "the vocabulary allowance is one; the sibling is not a stale attempt for the final-problem gate");
		assert.deepEqual(gates, ["vocabulary"]);
	});
	it("a clean finish records the lesson's coverage line, which later lessons never change", async () => {
		const c = mappedCourse();
		const made = courses.createCourseSession(c.id, "learn", "sk_rings");
		assert.ok(made.ok);
		const chatId = made.ok ? made.value.id : "";
		const vocabulary = courses.courseForTurn(chatId)!.vocabulary!;
		const { by, messages } = await runAll(vocabulary, finalProblem, [step("f1", { summary: "Showed rings.", deferred: [{ id: "t_unit", why: "later" }] }, "So a ring has two operations.")]);
		assert.equal(by("f1").isError, false);
		assert.deepEqual((by("f1").details as { coverage?: unknown }).coverage, { total: 3, covered: 2, left: ["unit"] });
		chatStore.saveMessages(chatId, [...chatStore.getChat(chatId)!.messages, ...messages.filter((m) => (m as { role?: string }).role !== "user")]);
		const r = courses.lessonResult(chatId)!;
		assert.deepEqual(r.coverage, { total: 3, covered: 2, left: ["unit"], language: "en" });
		// a later lesson introduces "unit": the earlier lesson's line stays as it was
		session(c.id, "learn", ["sk_rings"], [say("A unit has an inverse.")]);
		assert.deepEqual(courses.lessonResult(chatId)!.coverage, { total: 3, covered: 2, left: ["unit"], language: "en" });
	});
});

// ─── the lesson result ───────────────────────────────────────────────────────

describe("the lesson result", () => {
	it("says in one line what was covered and what was left, in the lesson language (read from the finish's record)", () => {
		const c = mappedCourse();
		const learn = session(c.id, "learn", ["sk_rings"], [
			say("A ring has two operations."),
			callMsg("f1", "finish_lesson", { summary: "Showed rings.", deferred: [{ id: "t_unit", why: "later" }] }),
			result("f1", "finish_lesson", { grades: [], coverage: { total: 3, covered: 1, left: ["ideal", "unit"] } }),
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
		// Markdown in every message (bold, a formula, a link), so each text goes through the renderer-faithful parse
		const paragraph = (i: number) => `In this step we use **concept${i} term** and concept${(i * 7) % 500} term with $x_${i}$ together ([notes](https://x.invalid/${i})), then a long explanation follows. `.repeat(6);
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
		// the ledger's own reader: an exact key, a bracketed id and an unambiguous spelling are known
		const c = mappedCourse();
		const known = courses.courseForTurn(session(c.id, "learn", ["sk_rings"], []))!.conceptIds!;
		watched.watchConceptIds(known);
		watched.event(start({ conceptIds: ["t_ring", "ring", "[t_unit]", "t_made_up", "unit"] }));
		watched.event(start({ conceptIds: ["t_ideal"] }, "explain"));
		watched.event(start({ conceptIds: ["t_whatever"] }, "send_to_user"));
		watched.finish(false);
		assert.deepEqual(lines[0]!.conceptIds, { tagged: 6, unknown: 1 }, "only the invented id is unknown");
		const plain = new TurnTimeline({ turnId: "t", chatId: "c", provider: "p", model: "m", thinking: false }, (l) => void lines.push(l as never));
		plain.event(start({ conceptIds: ["t_ring"] }));
		plain.finish(false);
		assert.equal("conceptIds" in lines[1]!, false, "absent without coverage");
	});
});
