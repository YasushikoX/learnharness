/**
 * WP9 (2026-11-25): the lecture timeline, the class's position, "Where you stand", and Short question editing everything
 * about the class. The data (sanitizing, the sync merge with deletions, lectures read from file names), the syllabus pass
 * proposing lectures with checked dates, the "link skills to lectures" step on a fake model reply and the learner's
 * correction, the class position (derived and explicit), "Where you stand" in each state (no lectures, no assessments, on
 * track, behind), the Next up order following the gaps, Short question (one scripted turn per new tool, Undo for each
 * change kind, the refusals, class_overview answering "am I ready for Friday"), and the class page's card and lecture
 * list in each state. Deterministic: no real model.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-wys-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const L = await import("../src/core/lectures.ts");
const A = await import("../src/core/assessments.ts");
const plan = await import("../src/core/exam-plan.ts");
const { mergeFile } = await import("../src/core/sync-merge.ts");
const { mergeSkillLines } = await import("../src/core/skills.ts");
const { skillStore } = await import("../src/store/skills.ts");
const { courseStore } = await import("../src/store/courses.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { materialStore } = await import("../src/store/materials.ts");
const courses = await import("../src/server/courses.ts");
const assess = await import("../src/server/assessments.ts");
const lectures = await import("../src/server/lectures.ts");
const changes = await import("../src/server/class-changes.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { createAskAgent, ASK_TOOL_NAMES } = await import("../src/agent/ask-agent.ts");
const { classFactsTools } = await import("../src/agent/tools/class-facts.ts");
const { fillFound } = await import("../src/agent/subagents/assessment-finder.ts");
const { checkLinks } = await import("../src/agent/subagents/lecture-linker.ts");
const { partShows } = await import("../components/transcript-rows.ts");
const { ClassChangeView, classChangeLines } = await import("../components/class-change-card.tsx");
const { standingLines, showsStanding, WhereYouStand } = await import("../components/where-you-stand.tsx");
const { LectureList, lectureBody } = await import("../components/lecture-list.tsx");
const { ExamPlanSection } = await import("../components/exam-plan.tsx");
const { ClassPanel } = await import("../components/class-panel.tsx");
const { UpcomingList } = await import("../components/upcoming-list.tsx");
const { InteractionLayersProvider } = await import("../components/interaction-layers.tsx");
const { LEDGER_FILES } = await import("../config.ts");
const lecturesRoute = await import("../app/api/courses/[id]/lectures/route.ts");
const lectureRoute = await import("../app/api/courses/[id]/lectures/[lectureId]/route.ts");
const positionRoute = await import("../app/api/courses/[id]/class-position/route.ts");
const undoRoute = await import("../app/api/chats/[id]/class-changes/[toolCallId]/route.ts");
const changesRoute = await import("../app/api/chats/[id]/class-changes/route.ts");

import type { CourseRecord, CourseStandingView } from "../src/core/contracts.ts";
import type { CoursePlan } from "../src/core/exam-plan.ts";
import type { Lecture, LectureView, ProposedLecture } from "../src/core/lectures.ts";
import type { Assessment } from "../src/core/assessments.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { MaterialsApi } from "../components/use-materials";

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

// ─── fixtures ────────────────────────────────────────────────────────────────

const DAY = 86_400_000;
const T0 = "2026-11-25T10:00:00.000Z";

function reset() {
	assess.setAssessmentFinderForTests(null);
	lectures.setLectureLinkerForTests(null);
	for (const c of courseStore.listCourses()) courseStore.deleteCourse(c.id);
	for (const c of chatStore.listChats()) chatStore.deleteChat(c.id);
	fs.rmSync(LEDGER_FILES.skills, { force: true });
	fs.rmSync(LEDGER_FILES.nodes, { force: true });
	courses.clearCourseEvidenceCache();
}

/** "YYYY-MM-DD" of the local day `n` days from now. */
function inDays(n: number, from = Date.now()): string {
	const d = new Date(from + n * DAY);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** An approved class: a → b (b requires a), c, d (independent). Draft cites name lecture files for a and c. */
function approvedCourse(title = "Signals") {
	const course = courseStore.createCourse(title);
	courseStore.updateCourse(course.id, {
		status: "draft",
		draft: {
			createdAt: "t",
			summary: "s",
			skills: [
				{ key: "s1", name: "Laplace", statement: "Take a Laplace transform", requires: [], restsOn: [], cite: "L01 Laplace.pdf p. 3" },
				{ key: "s2", name: "Poles", statement: "Read the poles of a transfer function", requires: ["s1"], restsOn: [] },
				{ key: "s3", name: "Bode", statement: "Sketch a Bode plot", requires: [], restsOn: [], cite: "Lecture 3" },
				{ key: "s4", name: "Nyquist", statement: "Read stability from a Nyquist plot", requires: [], restsOn: [] },
			],
		},
	});
	const approved = courses.approveCourse(course.id);
	assert.ok(approved.ok);
	const byName = Object.fromEntries(mergeSkillLines(skillStore.readSkillLines()).map((s) => [s.name, s.id]));
	return { courseId: course.id, a: byName.Laplace!, b: byName.Poles!, c: byName.Bode!, d: byName.Nyquist! };
}

function addFile(courseId: string, name: string, profile = "## Scope and targets\nSlides.") {
	const m = materialStore.add(courseId, { kind: "text", name, ext: ".md", bytes: new TextEncoder().encode(`# ${name}\n`) });
	materialStore.update(courseId, m.id, { status: "ready", profile });
	return m.id;
}

/** A stored lecture. */
function lec(over: Partial<Lecture> & { id: string; title: string }): Lecture {
	return { topics: "", materialIds: [], skillIds: [], source: "manual", updatedAt: T0, ...over };
}

const ASSISTANT_BASE = { api: "faux", provider: "faux", model: "faux", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse" } as const;

/** A course practice session with one solved problem on `skill` (graded `good`): the skill becomes learned. */
function learn(courseId: string, skill: string, at = Date.now() - DAY) {
	const chat = chatStore.createChat("p", "practice", { courseId, mode: "practice", skillIds: [skill] });
	const messages = [
		{ id: `p1${at}${skill}`, role: "assistant", content: [{ type: "toolCall", id: `pose${at}${skill}`, name: "problem", arguments: { statement: "x", skills: [skill] } }], ...ASSISTANT_BASE, timestamp: at },
		{ id: `p2${at}${skill}`, role: "toolResult", toolCallId: `pose${at}${skill}`, toolName: "problem", content: [{ type: "text", text: "ok" }], isError: false, timestamp: at },
		{ id: `p3${at}${skill}`, role: "assistant", content: [{ type: "toolCall", id: `done${at}${skill}`, name: "conclude", arguments: { outcome: "solved" } }], ...ASSISTANT_BASE, timestamp: at + 1000 },
		{ id: `p4${at}${skill}`, role: "toolResult", toolCallId: `done${at}${skill}`, toolName: "conclude", content: [{ type: "text", text: "ok" }], isError: false, details: { grades: [{ skill, grade: "good" }] }, timestamp: at + 1000 },
	] as unknown as LhMessage[];
	chatStore.saveMessages(chat.id, messages);
	courses.clearCourseEvidenceCache();
}

function pinModel(chatId: string) {
	const settings = chatStore.getChat(chatId)!.settings ?? {};
	chatStore.saveSettings(chatId, { ...settings, model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
}

function scripted(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

async function runTurn(chatId: string, text: string, engine: PiEngine) {
	const req = new Request("http://test/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, input: { type: "text", text } }) });
	const ack = await handleChatRequest(req, (opts) => createAskAgent({ classFacts: classFactsTools(changes.classFactsPort(chatId)!) }, { ...opts, engine }));
	if (ack.status !== 200) assert.fail(`expected 200 ack, got ${ack.status}: ${await ack.text()}`);
	const handle = runningTurn(chatId);
	if (handle) await new Response(handle.subscribe()).text();
}

/** One scripted turn: the tool call, then a short reply. */
const oneCall = (tool: string, args: Parameters<typeof fauxToolCall>[1], id: string, reply = "Done.") =>
	scripted([fauxAssistantMessage([fauxToolCall(tool, args, { id })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText(reply)])]);

function askChat(courseId: string) {
	const out = courses.createCourseSession(courseId, "ask");
	assert.ok(out.ok);
	pinModel(out.value.id);
	return out.value.id;
}

const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const json = (body: unknown, method = "POST") => new Request("http://test/x", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const getCourse = (id: string) => courseStore.getCourse(id)!;
const toolResults = (chatId: string) =>
	chatStore.getChat(chatId)!.messages.filter((m) => (m as { role?: string }).role === "toolResult") as unknown as Array<{ toolCallId: string; toolName: string; isError: boolean; details: unknown; content: Array<{ text?: string }> }>;
const resultText = (chatId: string, id: string) => toolResults(chatId).find((r) => r.toolCallId === id)!.content.map((c) => c.text ?? "").join("");
const undo = (chatId: string, toolCallId: string) => undoRoute.POST(new Request("http://x"), params({ id: chatId, toolCallId }));
const statuses = async (chatId: string) => (await (await changesRoute.GET(new Request("http://x"), params({ id: chatId }))).json()) as Record<string, string>;

async function waitLinking(courseId: string) {
	for (let i = 0; i < 200 && lectures.lectureLinking(courseId); i++) await new Promise((r) => setTimeout(r, 5));
	assert.equal(lectures.lectureLinking(courseId), false, "the linking step settled");
}

// ─── the data ────────────────────────────────────────────────────────────────

describe("lectures: the data", () => {
	beforeEach(reset);

	it("sanitizes on read: bad entries dropped, fields capped and cleaned, one entry per id (the later write wins)", () => {
		const list = L.readLectureEntries([
			{ id: "lc_1", n: 8, title: "  Lecture   8 ", date: "2026-11-24", topics: "ch 6\n\n\n\nch 7", materialIds: ["m1", "m1", ""], skillIds: ["sk_a", 3], skillsBy: "learner", source: "chat", updatedAt: T0 },
			{ id: "lc_1", title: "Older", updatedAt: "2026-11-24T10:00:00.000Z" },
			{ id: "lc_2", title: "", updatedAt: T0 },
			{ id: "lc_3", title: "Bad date", date: "2026-02-31", n: -1, source: "weird", skillsBy: "robot", updatedAt: T0 },
			{ id: "lc_4", deleted: true, updatedAt: T0 },
			{ id: "lc_5", title: "x".repeat(400), topics: "y".repeat(5000), updatedAt: T0 },
			"junk",
			null,
		]);
		const byId = Object.fromEntries(list.map((e) => [e.id, e]));
		assert.deepEqual(Object.keys(byId).sort(), ["lc_1", "lc_3", "lc_4", "lc_5"]);
		assert.deepEqual(byId.lc_1, { id: "lc_1", n: 8, title: "Lecture 8", date: "2026-11-24", topics: "ch 6\n\nch 7", materialIds: ["m1"], skillIds: ["sk_a"], skillsBy: "learner", source: "chat", updatedAt: T0 });
		assert.deepEqual(byId.lc_3, { id: "lc_3", title: "Bad date", topics: "", materialIds: [], skillIds: [], source: "manual", updatedAt: T0 }, "an impossible date, a negative number and unknown enums are dropped");
		assert.ok(A.isTombstone(byId.lc_4));
		assert.equal((byId.lc_5 as Lecture).title.length, L.LECTURE_TITLE_MAX);
		assert.equal((byId.lc_5 as Lecture).topics.length, L.LECTURE_TOPICS_MAX);
		assert.equal(L.sanitizeClassPosition({ lectureId: "lc_1", coveredThrough: "  chapter   6 ", updatedAt: T0 })?.coveredThrough, "chapter 6");
		assert.equal(L.sanitizeClassPosition({ updatedAt: T0 }), undefined, "a position that says nothing is none");
		assert.equal(L.sanitizeClassPosition({ lectureId: "lc_1", updatedAt: "yesterday" }), undefined);
	});

	it("reads lectures from file names (and the start of a profile) without a model call; skips exams, exercises and the syllabus", () => {
		assert.deepEqual(L.readLectureMarks("Lecture 8 - Eigenvalues"), { kind: "lecture", n: 8 });
		assert.deepEqual(L.readLectureMarks("L08 slides"), { kind: "lecture", n: 8 });
		assert.deepEqual(L.readLectureMarks("slides_lecture_08"), { kind: "lecture", n: 8 }, "an underscore is not a letter");
		assert.deepEqual(L.readLectureMarks("Forelesning3"), { kind: "lecture", n: 3 });
		assert.deepEqual(L.readLectureMarks("Week 5 notes"), { kind: "week", n: 5 });
		assert.deepEqual(L.readLectureMarks("2026-11-24 notes"), { date: "2026-11-24" });
		assert.deepEqual(L.readLectureMarks("Notes 24.11.2026"), { date: "2026-11-24" });
		assert.deepEqual(L.readLectureMarks("Electrical circuits"), {}, "'lec' inside a word is not a lecture");
		assert.deepEqual(L.readLectureMarks("TL1 handout"), {}, "L1 inside a word is not a lecture");
		const files = [
			{ id: "m1", name: "Lecture 8.pdf", addedAt: T0 },
			{ id: "m2", name: "L08 notes 2026-11-24.pdf", addedAt: T0 },
			{ id: "m3", name: "Week 5.pdf", addedAt: T0 },
			{ id: "m4", name: "Exam 2024 lecture 3.pdf", addedAt: T0 },
			{ id: "m5", name: "Exercise 4.pdf", addedAt: T0 },
			{ id: "m6", name: "Syllabus week 1-14.pdf", addedAt: T0 },
			{ id: "m7", name: "slides.pdf", profile: "## Scope and targets\nLecture 2 of the course: transforms.", addedAt: T0 },
			{ id: "m8", name: "2026-12-01 board photos.png", addedAt: T0 },
		];
		const read = L.lecturesFromFiles(files);
		assert.deepEqual(
			read.map((l) => [l.id, l.title, l.n, l.date, l.materialIds, l.source]),
			[
				["lf_lecture_8", "Lecture 8", 8, "2026-11-24", ["m1", "m2"], "files"],
				["lf_week_5", "Week 5", 5, undefined, ["m3"], "files"],
				["lf_lecture_2", "Lecture 2", 2, undefined, ["m7"], "files"],
				["lf_d_2026-12-01", "Lecture 1 Dec 2026", undefined, "2026-12-01", ["m8"], "files"],
			],
		);
		assert.equal(L.lecturesFromFiles([{ id: "m1", name: "Forelesning 3.pdf", addedAt: T0 }], "nb")[0]!.title, "Forelesning 3");
	});

	it("the timeline: stored lectures plus those the files name; a file joins the stored lecture of its number; a removal or edit under the file's id holds", () => {
		const files = [
			{ id: "m1", name: "Lecture 1.pdf", addedAt: T0 },
			{ id: "m2", name: "Lecture 2.pdf", addedAt: T0 },
			{ id: "m3", name: "Lecture 3.pdf", addedAt: T0 },
			{ id: "m4", name: "Lecture 4.pdf", addedAt: T0 },
		];
		const stored = [
			lec({ id: "lc_syl2", n: 2, title: "Lecture 2: Poles", date: "2026-11-10", source: "syllabus" }),
			{ id: "lf_lecture_3", deleted: true, updatedAt: T0 },
			lec({ id: "lf_lecture_4", n: 4, title: "Lecture 4 (moved)", date: "2026-11-20", materialIds: ["m4"], source: "files" }),
			lec({ id: "lc_x", n: 9, title: "Lecture 9", materialIds: ["m_gone"] }),
		];
		const view = L.courseLectures({ lectures: stored }, files);
		assert.deepEqual(
			view.map((l) => [l.id, l.title, l.materialIds, l.derived ?? false]),
			[
				["lf_lecture_1", "Lecture 1", ["m1"], true],
				["lc_syl2", "Lecture 2: Poles", ["m2"], false],
				["lf_lecture_4", "Lecture 4 (moved)", ["m4"], false],
				["lc_x", "Lecture 9", [], false],
			],
			"lecture 3's removal holds; a deleted file no longer counts",
		);
		assert.deepEqual(L.sortLectures([{ title: "b", date: "2026-01-02" }, { title: "a", n: 3 }, { title: "c" }, { title: "d", n: 1 }]).map((l) => l.title), ["d", "a", "b", "c"]);
	});

	it("sync: lectures merge per item (a deletion survives, three-way against the base); the class position keeps the one said later", () => {
		const base: Partial<CourseRecord> = { id: "course_s", title: "S", createdAt: T0, updatedAt: T0, status: "active", skills: [], lectures: [lec({ id: "lc_1", title: "Lecture 1" }), lec({ id: "lc_2", title: "Lecture 2" })] };
		const local = { ...base, updatedAt: "2026-11-25T11:00:00.000Z", lectures: [{ id: "lc_1", deleted: true, updatedAt: "2026-11-25T11:00:00.000Z" }, lec({ id: "lc_2", title: "Lecture 2" })], classPosition: { lectureId: "lc_2", updatedAt: "2026-11-25T11:00:00.000Z" } };
		const remote = { ...base, updatedAt: "2026-11-25T12:00:00.000Z", lectures: [lec({ id: "lc_1", title: "Lecture 1" }), lec({ id: "lc_2", title: "Lecture 2b", updatedAt: "2026-11-25T12:00:00.000Z" }), lec({ id: "lc_3", title: "Lecture 3" })], classPosition: { coveredThrough: "chapter 6", updatedAt: "2026-11-25T10:30:00.000Z" } };
		const out = mergeFile({ path: "courses/course_s.json", base: JSON.stringify(base), local: JSON.stringify(local), remote: JSON.stringify(remote), prefer: "remote" });
		const merged = JSON.parse(out.content!) as CourseRecord;
		const entries = L.readLectureEntries(merged.lectures);
		assert.ok(A.isTombstone(entries.find((e) => e.id === "lc_1")), "the deletion survives the other device's copy");
		assert.equal((entries.find((e) => e.id === "lc_2") as Lecture).title, "Lecture 2b", "the later edit wins");
		assert.ok(entries.some((e) => e.id === "lc_3"));
		assert.deepEqual(merged.classPosition, local.classPosition, "both changed the position: the one said later wins, no conflict copy");
		// past the tombstone cap: the base had it, one side no longer lists it at all → it stays deleted
		const dropped = mergeFile({ path: "courses/course_s.json", base: JSON.stringify(base), local: JSON.stringify({ ...base, updatedAt: "2026-11-25T11:00:00.000Z", lectures: [lec({ id: "lc_2", title: "Lecture 2" })] }), remote: JSON.stringify(base), prefer: "remote" });
		assert.ok(!L.liveLectures(JSON.parse(dropped.content!).lectures).some((l) => l.id === "lc_1"));
		// an older build without the list removes nothing
		const older = mergeFile({ path: "courses/course_s.json", base: JSON.stringify(base), local: JSON.stringify(base), remote: JSON.stringify({ ...base, lectures: undefined, updatedAt: "2026-11-25T13:00:00.000Z" }), prefer: "remote" });
		assert.equal(L.liveLectures(JSON.parse(older.content!).lectures).length, 2);
	});

	it("the API: POST, PATCH and DELETE with validation; a lecture read from the files is stored under its id when edited", async () => {
		const { courseId, a } = approvedCourse();
		const m1 = addFile(courseId, "Lecture 1.pdf");
		const bad = await lecturesRoute.POST(json({ n: "x" }), params({ id: courseId }));
		assert.equal(bad.status, 400);
		assert.equal((await lecturesRoute.POST(json({ title: "L", skillIds: ["sk_nope"] }), params({ id: courseId }))).status, 400);
		assert.equal((await lecturesRoute.POST(json({ title: "L", materialIds: ["mat_nope"] }), params({ id: courseId }))).status, 400);
		const made = (await (await lecturesRoute.POST(json({ n: 2, date: "2026-12-01", topics: "poles" }), params({ id: courseId }))).json()) as { lecture: Lecture };
		assert.deepEqual([made.lecture.title, made.lecture.n, made.lecture.date, made.lecture.source, made.lecture.skillsBy], ["Lecture 2", 2, "2026-12-01", "manual", undefined]);
		const listed = (await (await lecturesRoute.GET(new Request("http://x"), params({ id: courseId }))).json()) as { lectures: LectureView[] };
		assert.deepEqual(listed.lectures.map((l) => l.id), ["lf_lecture_1", made.lecture.id]);
		// editing the file's lecture: stored under lf_lecture_1, still "files", its skills now the learner's
		const edited = (await (await lectureRoute.PATCH(json({ date: "2026-11-24", skillIds: [a] }, "PATCH"), params({ id: courseId, lectureId: "lf_lecture_1" }))).json()) as { lecture: Lecture };
		assert.deepEqual([edited.lecture.id, edited.lecture.date, edited.lecture.source, edited.lecture.skillsBy, edited.lecture.materialIds], ["lf_lecture_1", "2026-11-24", "files", "learner", [m1]]);
		assert.equal((await lectureRoute.DELETE(new Request("http://x"), params({ id: courseId, lectureId: "lf_lecture_1" }))).status, 200);
		assert.ok(!lectures.classLectures(getCourse(courseId)).some((l) => l.id === "lf_lecture_1"), "it stays removed while the file is there");
		assert.equal((await lectureRoute.DELETE(new Request("http://x"), params({ id: courseId, lectureId: "lc_nope" }))).status, 404);
	});
});

// ─── the syllabus pass ───────────────────────────────────────────────────────

describe("the syllabus pass proposes the lecture schedule with checked dates", () => {
	beforeEach(reset);

	it("fillFound: lectures with the same quote and page checks; a date the page does not state is left out", () => {
		const mats = [{ id: "mat_s", name: "Syllabus.pdf", kind: "pdf" }];
		const sources = new Map([["mat_s", { kind: "pages" as const, pages: new Map([[1, "Term starts Monday 12 January 2026."], [2, "Lecture 1, Tue 13 January: Laplace. Lecture 2, Week 2, Tuesday: poles. Lecture 3: TBA"]]) }]]);
		const out = fillFound(
			{
				summary: "Read the schedule.",
				termStart: "2026-01-12",
				termStartText: "Monday 12 January 2026",
				termStartMaterial: "mat_s",
				termStartPage: 1,
				assessments: [],
				lectures: [
					{ n: 1, title: "Lecture 1: Laplace", date: "2026-01-13", dateText: "Tue 13 January", topics: "Laplace", skills: ["sk_a"], material: "mat_s", page: 2 },
					{ n: 2, title: "Lecture 2", week: 2, weekday: 2, dateText: "Week 2, Tuesday", topics: "poles", skills: [], material: "mat_s", page: 2 },
					{ n: 3, title: "Lecture 3", date: "2026-01-27", dateText: "TBA", topics: "", skills: [], material: "mat_s", page: 2 },
				],
			},
			mats,
			["sk_a"],
			sources,
		);
		assert.deepEqual(out.problems, []);
		assert.deepEqual(
			out.lectures!.map((l) => [l.key, l.n, l.title, l.date, l.skillIds, l.cite, l.quote]),
			[
				["l1", 1, "Lecture 1: Laplace", "2026-01-13", ["sk_a"], "Syllabus.pdf p. 2", "Tue 13 January"],
				["l2", 2, "Lecture 2", "2026-01-20", [], "Syllabus.pdf p. 2", "Week 2, Tuesday"],
				["l3", 3, "Lecture 3", undefined, [], "Syllabus.pdf p. 2", "TBA"],
			],
			"a date only when the quote states it; a week resolved in code from the anchored term start",
		);
		const bad = fillFound({ summary: "s", assessments: [], lectures: [{ n: 4, title: "Lecture 4", date: "2026-02-03", dateText: "3 February", topics: "", skills: ["sk_x"], material: "mat_s", page: 2 }] }, mats, ["sk_a"], sources);
		assert.match(bad.problems.join("\n"), /lecture 1 \("Lecture 4"\): "3 February" is not on the cited page 2/);
		assert.match(bad.problems.join("\n"), /not an approved skill id/);
	});

	it("a fake finder's lectures ride the proposal; approving adds the assessments and the lectures together; a re-run does not duplicate", async () => {
		const { courseId, a } = approvedCourse();
		const syllabus = materialStore.add(courseId, { kind: "text", name: "Syllabus.md", ext: ".md", bytes: new TextEncoder().encode("schedule") });
		materialStore.update(courseId, syllabus.id, { status: "ready", profile: "schedule" });
		const found = { summary: "Read Syllabus.md.", items: [{ key: "p1", kind: "quiz" as const, title: "Quiz 1", date: inDays(10), topics: "Laplace", skillIds: [a], cite: "Syllabus.md" }], lectures: [
			{ key: "l1", n: 1, title: "Lecture 1", date: inDays(-7), topics: "Laplace", skillIds: [a], cite: "Syllabus.md" },
			{ key: "l2", n: 2, title: "Lecture 2", date: inDays(-1), topics: "Poles", skillIds: [], cite: "Syllabus.md" },
			{ key: "l3", n: 3, title: "Lecture 3", date: inDays(6), topics: "Bode", skillIds: [], cite: "Syllabus.md" },
		] };
		assess.setAssessmentFinderForTests(async () => found);
		assert.ok(assess.startAssessmentFind(courseId).ok);
		for (let i = 0; i < 200 && assess.assessmentFinding(courseId); i++) await new Promise((r) => setTimeout(r, 5));
		const proposal = getCourse(courseId).assessmentProposal!;
		assert.deepEqual(proposal.lectures!.map((l) => [l.key, l.status]), [["l1", "new"], ["l2", "new"], ["l3", "new"]]);
		// drop one lecture, then approve everything else in one write
		assert.ok(assess.actOnProposal(courseId, { action: "drop", key: "l3", proposalId: proposal.id }).ok);
		const approved = assess.actOnProposal(courseId, { action: "approve", proposalId: proposal.id });
		assert.ok(approved.ok);
		const course = getCourse(courseId);
		assert.equal(course.assessmentProposal, undefined);
		assert.deepEqual(A.liveAssessments(course.assessments).map((x) => x.title), ["Quiz 1"]);
		assert.deepEqual(L.liveLectures(course.lectures).map((l) => [l.title, l.source, l.skillIds, l.skillsBy]), [["Lecture 1", "syllabus", [a], "model"], ["Lecture 2", "syllabus", [], undefined]]);
		// the same pass again: the lectures are the same now, nothing to add
		assert.ok(assess.startAssessmentFind(courseId).ok);
		for (let i = 0; i < 200 && assess.assessmentFinding(courseId); i++) await new Promise((r) => setTimeout(r, 5));
		const again = getCourse(courseId).assessmentProposal!;
		assert.deepEqual(again.lectures!.map((l) => l.status), ["same", "same", "new"]);
		assert.equal(assess.actOnProposal(courseId, { action: "drop", key: "nope", proposalId: again.id }).ok, false);
		// the learner's own lecture of that number wins over the syllabus
		lectures.updateLecture(courseId, L.liveLectures(getCourse(courseId).lectures)[1]!.id, { topics: "my words" });
		assert.ok(assess.startAssessmentFind(courseId).ok);
		for (let i = 0; i < 200 && assess.assessmentFinding(courseId); i++) await new Promise((r) => setTimeout(r, 5));
		assert.deepEqual(getCourse(courseId).assessmentProposal!.lectures!.map((l) => l.status), ["same", "kept", "new"]);
	});
});

// ─── link skills to lectures ─────────────────────────────────────────────────

describe("link skills to lectures", () => {
	beforeEach(reset);

	it("checkLinks: only real ids, at most three lectures a skill, problems named for the model to fix", () => {
		const out = checkLinks({ links: [{ skill: "sk_a", lectures: ["lc_1", "lc_1", "lc_x"] }, { skill: "sk_z", lectures: ["lc_1"] }, { skill: "sk_b", lectures: ["lc_1", "lc_2", "lc_3", "lc_4"] }] }, ["lc_1", "lc_2", "lc_3", "lc_4"], ["sk_a", "sk_b"]);
		assert.deepEqual([...out.links], [["sk_a", ["lc_1"]], ["sk_b", ["lc_1", "lc_2", "lc_3"]]]);
		assert.equal(out.problems.length, 2);
		assert.match(out.problems.join("\n"), /"lc_x" is not a lecture id/);
		assert.match(out.problems.join("\n"), /"sk_z" is not a skill id/);
	});

	it("the draft's cites place skills with no model call; one fake model pass places the rest; the learner's correction is never overwritten; no loop", async () => {
		const { courseId, a, b, c, d } = approvedCourse();
		assert.deepEqual(getCourse(courseId).skillCites, { [a]: "L01 Laplace.pdf p. 3", [c]: "Lecture 3" }, "approval keeps each skill's cite");
		addFile(courseId, "L01 Laplace.pdf");
		addFile(courseId, "Lecture 2.pdf");
		addFile(courseId, "Lecture 3.pdf");
		let seen: string[] = [];
		lectures.setLectureLinkerForTests(async (input) => {
			seen = input.skills.map((s) => s.id);
			return new Map([[b, ["lf_lecture_2"]], [d, ["lf_lecture_nope"]]]);
		});
		courses.courseView(courseId); // a file added: the view starts the step
		await waitLinking(courseId);
		assert.deepEqual(seen.sort(), [b, d].sort(), "the model only sees what the cites did not place");
		const view = lectures.classLectures(getCourse(courseId));
		assert.deepEqual(view.map((l) => [l.id, l.skillIds, l.skillsBy]), [["lf_lecture_1", [a], "model"], ["lf_lecture_2", [b], "model"], ["lf_lecture_3", [c], "model"]]);
		assert.equal(getCourse(courseId).lecturesLinkError, undefined);
		// nothing changed: no second run
		let runs = 0;
		lectures.setLectureLinkerForTests(async () => {
			runs++;
			return new Map();
		});
		courses.courseView(courseId);
		await waitLinking(courseId);
		assert.equal(runs, 0, "the same lectures and skills: no run");
		// the learner corrects lecture 2: d, not b. A new file starts the step again, which leaves that lecture alone
		lectures.updateLecture(courseId, "lf_lecture_2", { skillIds: [d] });
		lectures.setLectureLinkerForTests(async () => {
			runs++;
			return new Map([[b, ["lf_lecture_2", "lf_lecture_4"]]]);
		});
		addFile(courseId, "Lecture 4.pdf");
		courses.courseView(courseId);
		await waitLinking(courseId);
		assert.equal(runs, 1);
		const after = lectures.classLectures(getCourse(courseId));
		assert.deepEqual(after.find((l) => l.id === "lf_lecture_2")!.skillIds, [d], "the learner's correction holds");
		assert.deepEqual(after.find((l) => l.id === "lf_lecture_4")!.skillIds, [b]);
		// a failing pass records why, and never loops (the learner clears lecture 4, so Poles is not placed anywhere)
		lectures.updateLecture(courseId, "lf_lecture_4", { skillIds: [] });
		lectures.setLectureLinkerForTests(async () => {
			throw new Error("model down");
		});
		addFile(courseId, "Lecture 5.pdf");
		courses.courseView(courseId);
		await waitLinking(courseId);
		assert.equal(getCourse(courseId).lecturesLinkError, "model down");
		const view2 = courses.courseView(courseId)!;
		assert.equal(view2.standing!.linkError, "model down");
		assert.equal(lectures.lectureLinking(courseId), false, "no new run for the same key");
	});
});

// ─── the class position ──────────────────────────────────────────────────────

describe("the class position", () => {
	const today = "2026-11-25";
	const view = (over: Partial<LectureView> & { id: string; title: string }): LectureView => lec(over);

	it("derived: the last lecture dated on or before today; with no dates, the highest-numbered lecture with a file", () => {
		const dated = [view({ id: "l1", n: 1, title: "Lecture 1", date: "2026-11-10" }), view({ id: "l2", n: 2, title: "Lecture 2", date: "2026-11-25" }), view({ id: "l3", n: 3, title: "Lecture 3", date: "2026-11-30" })];
		assert.deepEqual(L.classPositionOf(dated, undefined, today), { lectureId: "l2", how: "dated" }, "today's lecture counts");
		assert.equal(L.classPositionOf(dated, undefined, "2026-11-01"), null, "nothing yet");
		const undated = [view({ id: "l1", n: 1, title: "Lecture 1", materialIds: ["m1"] }), view({ id: "l2", n: 2, title: "Lecture 2", materialIds: ["m2"] }), view({ id: "l3", n: 3, title: "Lecture 3" })];
		assert.deepEqual(L.classPositionOf(undated, undefined, today), { lectureId: "l2", how: "files" });
		assert.equal(L.classPositionOf([], undefined, today), null);
		assert.deepEqual(L.coveredLectures(undated, { lectureId: "l2", how: "files" }).map((l) => l.id), ["l1", "l2"]);
	});

	it("explicit: what the learner said holds until a later lecture dated after that day has passed; words alone keep the dated lecture", () => {
		const list = [view({ id: "l1", n: 1, title: "Lecture 1", date: "2026-11-10" }), view({ id: "l2", n: 2, title: "Lecture 2", date: "2026-11-17" }), view({ id: "l3", n: 3, title: "Lecture 3", date: "2026-11-24" }), view({ id: "l4", n: 4, title: "Lecture 4", date: "2026-12-01" })];
		const said = { lectureId: "l2", note: "a week behind the syllabus", updatedAt: "2026-11-25T09:00:00.000Z" };
		assert.deepEqual(L.classPositionOf(list, said, "2026-11-25"), { lectureId: "l2", how: "explicit", note: "a week behind the syllabus", at: said.updatedAt });
		assert.deepEqual(L.classPositionOf(list, said, "2026-12-02"), { lectureId: "l4", how: "dated" }, "lecture 4 (dated after it was said) has passed: the dates rule again");
		assert.deepEqual(L.classPositionOf(list, { coveredThrough: "chapter 6", updatedAt: "2026-11-25T09:00:00.000Z" }, "2026-11-25"), { lectureId: "l3", how: "explicit", coveredThrough: "chapter 6", at: "2026-11-25T09:00:00.000Z" });
		assert.deepEqual(L.classPositionOf(list, { lectureId: "l_gone", updatedAt: "2026-11-25T09:00:00.000Z" }, "2026-11-25"), { lectureId: "l3", how: "dated" }, "a position naming a removed lecture falls back to the dates");
	});

	it("the route: set it, refuse a stranger lecture, and clear it back to the dates", async () => {
		reset();
		const { courseId } = approvedCourse();
		const made = lectures.createLecture(courseId, { n: 1, date: inDays(-3) });
		assert.ok(made.ok);
		assert.equal((await positionRoute.PUT(json({ lectureId: "lc_nope" }, "PUT"), params({ id: courseId }))).status, 400);
		assert.equal((await positionRoute.PUT(json({}, "PUT"), params({ id: courseId }))).status, 400);
		const set = (await (await positionRoute.PUT(json({ lectureId: made.value.id, coveredThrough: "chapter 2" }, "PUT"), params({ id: courseId }))).json()) as { classPosition: { lectureId: string; coveredThrough: string } };
		assert.deepEqual([set.classPosition.lectureId, set.classPosition.coveredThrough], [made.value.id, "chapter 2"]);
		assert.equal(courses.courseView(courseId)!.standing!.position!.how, "explicit");
		assert.equal((await positionRoute.DELETE(new Request("http://x"), params({ id: courseId }))).status, 200);
		assert.equal(getCourse(courseId).classPosition, undefined);
		assert.equal(courses.courseView(courseId)!.standing!.position!.how, "dated");
		// removing the lecture the position names clears that part of it
		lectures.setClassPosition(courseId, { lectureId: made.value.id });
		lectures.deleteLecture(courseId, made.value.id);
		assert.equal(getCourse(courseId).classPosition, undefined);
	});
});

// ─── where you stand ─────────────────────────────────────────────────────────

describe("where you stand: the numbers in each state", () => {
	const skills = (learned: string[]) =>
		["a", "b", "c", "d"].map((id) => ({ id, learned: learned.includes(id), requires: id === "b" ? ["a"] : [] }));
	const startable = (learned: string[]) => new Set(skills(learned).filter((s) => !s.learned && s.requires.every((r) => learned.includes(r))).map((s) => s.id));
	const lectures4 = [
		lec({ id: "l1", n: 1, title: "Lecture 1", date: "2026-11-03", skillIds: ["a"] }),
		lec({ id: "l2", n: 2, title: "Lecture 2", date: "2026-11-10", skillIds: ["b"] }),
		lec({ id: "l3", n: 3, title: "Lecture 3", date: "2026-11-17", skillIds: ["c"] }),
		lec({ id: "l4", n: 4, title: "Lecture 4", date: "2026-12-01", skillIds: ["d"] }),
	];
	const quiz = (over: Partial<Assessment> = {}) => ({ id: "as_q", kind: "quiz" as const, title: "Quiz 3", date: "2026-11-27", topics: "", skillIds: [] as string[], source: "chat" as const, updatedAt: T0, ...over });
	const stand = (opts: { lectures?: LectureView[]; learned?: string[]; next?: ReturnType<typeof quiz>; today?: string; explicit?: { lectureId?: string; updatedAt: string } }) =>
		L.whereYouStand({ lectures: opts.lectures ?? lectures4, explicit: opts.explicit, today: opts.today ?? "2026-11-25", skills: skills(opts.learned ?? []), startable: startable(opts.learned ?? []), next: opts.next });

	it("no lectures: no position and no verdict; the next assessment's own skills still count", () => {
		const s = stand({ lectures: [], learned: ["a"], next: quiz({ skillIds: ["a", "b"] }) });
		assert.deepEqual([s.position, s.covered, s.learnedThrough, s.verdict, s.behind, s.unplaced], [null, [], null, "unknown", [], 4]);
		assert.deepEqual([s.next!.needs, s.next!.basis, s.next!.learned, s.next!.missing], [["a", "b"], "assessment", ["a"], [{ skillId: "b", lectureIds: [] }]]);
		assert.deepEqual(s.start, { skillId: "b", gapId: "b", why: "assessment" });
		assert.equal(stand({ lectures: [], next: quiz() }).next!.needs, null, "a quiz with no skills and no lectures: needs unknown");
	});

	it("no assessments: the class and you, and the verdict from what the class has covered", () => {
		const s = stand({ learned: ["a", "b"] });
		assert.equal(s.next, null);
		assert.deepEqual([s.position?.lectureId, s.position?.label, s.covered], ["l3", "Lecture 3", ["l1", "l2", "l3"]]);
		assert.deepEqual(s.learnedThrough, { fromId: "l1", toId: "l2", label: "Lectures 1–2" });
		assert.deepEqual([s.verdict, s.behind, s.start], ["behind", ["c"], { skillId: "c", gapId: "c", why: "covered" }]);
	});

	it("on track: everything the class covered is learned; the quiz needs the lectures before its date when it lists no skills", () => {
		const s = stand({ learned: ["a", "b", "c"], next: quiz({ date: "2026-12-02" }) });
		assert.deepEqual([s.verdict, s.behind], ["on_track", []]);
		assert.deepEqual(s.learnedThrough!.label, "Lectures 1–3");
		assert.deepEqual([s.next!.basis, s.next!.needs, s.next!.learned, s.next!.missing], ["lectures", ["a", "b", "c", "d"], ["a", "b", "c"], [{ skillId: "d", lectureIds: ["l4"] }]]);
		assert.deepEqual(s.start, { skillId: "d", gapId: "d", why: "assessment" }, "the quiz's gap is the most urgent");
	});

	it("behind: N skills from covered lectures; a locked gap starts at its first startable prerequisite; the run stops at the first gap", () => {
		const s = stand({ learned: ["c"], next: quiz({ skillIds: ["b"] }) });
		assert.deepEqual([s.verdict, s.behind], ["behind", ["a", "b"]]);
		assert.equal(s.learnedThrough, null, "lecture 1 is not all learned: no run");
		assert.deepEqual(s.start, { skillId: "a", gapId: "b", why: "assessment" }, "b is locked behind a: Start goes to a");
		assert.deepEqual(L.standingGaps(s), { needs: new Set(["b"]), covered: new Set(["a", "b", "c"]) });
		// a lecture with no skills is passed over by the run
		const gap = stand({ lectures: [lectures4[0]!, lec({ id: "lx", n: 2, title: "Lecture 2", date: "2026-11-08" }), lec({ ...lectures4[1]!, n: 3, title: "Lecture 3" })], learned: ["a", "b"] });
		assert.deepEqual(gap.learnedThrough, { fromId: "l1", toId: "l2", label: "Lectures 1–3" });
	});
});

// ─── the Next up order ───────────────────────────────────────────────────────

describe("Next up follows the gaps", () => {
	beforeEach(reset);

	it("orderNextUp: the next assessment's needs, then what the class covered, then the old order; unchanged without lectures", () => {
		const p = new Map<string, 0 | 1 | 2 | 3>([["a", 1], ["b", 3], ["c", 1], ["d", 2]]);
		assert.deepEqual(plan.orderNextUp(["a", "b", "c", "d"], p).nextUp, ["b", "d", "a", "c"], "the old order: priority, then topological");
		assert.deepEqual(plan.orderNextUp(["a", "b", "c", "d"], p, { covered: new Set() }).nextUp, ["b", "d", "a", "c"], "no lectures: the same");
		assert.deepEqual(plan.orderNextUp(["a", "b", "c", "d"], p, { covered: new Set(["c", "a"]) }).nextUp, ["a", "c", "b", "d"], "covered first, in the old order among them");
		assert.deepEqual(plan.orderNextUp(["a", "b", "c", "d"], p, { focus: new Set(["d"]), covered: new Set(["c", "a"]) }).nextUp, ["d", "a", "c", "b"]);
	});

	it("in the course view: Next up and Today put what the class covered first, and the quiz's lectures before that", () => {
		const { courseId, a, c, d } = approvedCourse();
		const before = courses.courseView(courseId)!.nextUp;
		assert.deepEqual(before, [a, c, d], "topological, before any lecture");
		lectures.createLecture(courseId, { n: 1, date: inDays(-7), skillIds: [d] });
		lectures.createLecture(courseId, { n: 2, date: inDays(14), skillIds: [c] });
		assert.deepEqual(courses.courseView(courseId)!.nextUp, [d, a, c], "lecture 1 (covered) teaches d");
		assess.createAssessment(courseId, { kind: "quiz", title: "Quiz 3", date: inDays(20) });
		const view = courses.courseView(courseId)!;
		assert.deepEqual(view.nextUp, [d, c, a], "the quiz (no skills of its own) needs the lectures before it: d and c");
		assert.deepEqual(view.standing!.start, { skillId: d, gapId: d, why: "assessment" });
		assert.equal(view.plan.lessons[0], d);
	});
});

// ─── Short question edits everything ─────────────────────────────────────────

describe("Short question edits everything about the class", () => {
	beforeEach(reset);

	const NEW_TOOLS = ["lectures_list", "lecture_save", "lecture_remove", "class_position_set", "skill_weights_set", "class_update", "class_overview"];

	it("offers the new tools (weights only with a map); none deletes the class or its files, approves or re-drafts the map, or reaches Settings", () => {
		const { courseId } = approvedCourse();
		const chatId = askChat(courseId);
		const tools = classFactsTools(changes.classFactsPort(chatId)!);
		for (const name of NEW_TOOLS) assert.ok(name in tools, name);
		for (const name of Object.keys(tools)) assert.ok((ASK_TOOL_NAMES as readonly string[]).includes(name), name);
		assert.deepEqual(
			Object.keys(tools).filter((n) => /delete|approve|draft|setting|file|material_remove/i.test(n)),
			[],
			"no tool for the disallowed actions",
		);
		const early = askChat(courseStore.createCourse("No map").id);
		assert.ok(!("skill_weights_set" in classFactsTools(changes.classFactsPort(early)!)));
		const agent = createAskAgent({ classFacts: tools }, { engine: scripted([]) });
		assert.match(agent.state.systemPrompt, /## The rest of the class page/);
		assert.match(agent.state.systemPrompt, /You cannot delete the class or its files, approve or re-draft the skill map, or change Settings\. When asked, say where: deleting the class is "Delete class…"/);
	});

	it("lecture_save (by number, a spoken date) and lecture_remove, each a card with Undo; a lecture read from the files comes back on Undo", async () => {
		const { courseId, b } = approvedCourse();
		addFile(courseId, "Lecture 9.pdf");
		const chatId = askChat(courseId);
		await runTurn(chatId, "What lectures are there?", oneCall("lectures_list", {}, "ls1", "Lecture 9."));
		assert.match(resultText(chatId, "ls1"), /Today: \w+day \d{4}-\d{2}-\d{2}\.[\s\S]*\[lf_lecture_9\] Lecture 9 \(n 9\) · no date · skills: none placed · files: Lecture 9\.pdf · \(read from the file names\)/);
		await runTurn(chatId, "Lecture 9 got moved to tomorrow, it's on poles.", oneCall("lecture_save", { n: 9, date: "tomorrow", topics: "poles", skillIds: [b] }, "lsave"));
		const moved = lectures.classLectures(getCourse(courseId)).find((l) => l.id === "lf_lecture_9")!;
		assert.deepEqual([moved.date, moved.topics, moved.skillIds, moved.skillsBy, moved.derived], [inDays(1), "poles", [b], "learner", undefined]);
		assert.ok(partShows({ type: "tool-lecture_save", state: "output-available" }));
		await runTurn(chatId, "Add lecture 10 next Tuesday? No — lecture 10 is on the 2nd of next month.", oneCall("lecture_save", { n: 10, title: "Lecture 10" }, "ladd"));
		const added = lectures.classLectures(getCourse(courseId)).find((l) => l.n === 10)!;
		assert.equal(added.source, "chat");
		await runTurn(chatId, "Lecture 10 is cancelled.", oneCall("lecture_remove", { id: added.id }, "lrm"));
		assert.ok(!lectures.classLectures(getCourse(courseId)).some((l) => l.n === 10));
		assert.deepEqual(await statuses(chatId), { lsave: "applied", ladd: "changed", lrm: "applied" }, "the add was removed since");
		// Undo, newest first: the removal brings lecture 10 back; the edit returns lecture 9 to what the files say
		assert.equal((await undo(chatId, "lrm")).status, 200);
		assert.ok(lectures.classLectures(getCourse(courseId)).some((l) => l.id === added.id));
		assert.equal((await undo(chatId, "ladd")).status, 409, "restored with a newer stamp: the add's card stays stale (WP8's rule)");
		assert.equal((await undo(chatId, "lsave")).status, 200);
		const back = lectures.classLectures(getCourse(courseId)).find((l) => l.id === "lf_lecture_9")!;
		assert.deepEqual([back.derived, back.date, back.skillIds], [true, undefined, []]);
		assert.equal((await undo(chatId, "lsave")).status, 409, "once");
		// an unreadable date asks
		await runTurn(chatId, "Lecture 9 is after the break.", oneCall("lecture_save", { n: 9, date: "after the break" }, "lbad", "When exactly?"));
		assert.match(resultText(chatId, "lbad"), /^Could not read the date "after the break"/);
	});

	it("class_position_set: \"we're on lecture 9\", \"we covered chapter 6\", back to the dates; Undo", async () => {
		const { courseId } = approvedCourse();
		const l8 = lectures.createLecture(courseId, { n: 8, date: inDays(-2) });
		const l9 = lectures.createLecture(courseId, { n: 9, date: inDays(5) });
		assert.ok(l8.ok && l9.ok);
		const chatId = askChat(courseId);
		await runTurn(chatId, "We're on lecture 9 already.", oneCall("class_position_set", { lectureNumber: 9 }, "pos1"));
		assert.deepEqual([getCourse(courseId).classPosition?.lectureId, courses.courseView(courseId)!.standing!.position!.label], [l9.value.id, "Lecture 9"]);
		await runTurn(chatId, "We covered chapter 6 today.", oneCall("class_position_set", { lectureId: l9.value.id, coveredThrough: "chapter 6" }, "pos2"));
		assert.equal(getCourse(courseId).classPosition?.coveredThrough, "chapter 6");
		assert.deepEqual(await statuses(chatId), { pos1: "changed", pos2: "applied" });
		const change = (toolResults(chatId).find((r) => r.toolCallId === "pos2")!.details as { change: unknown }).change;
		assert.deepEqual(classChangeLines(change as never), { eyebrow: "Class position", title: "Class is at Lecture 9", lines: ["Covered chapter 6"] });
		assert.equal((await undo(chatId, "pos2")).status, 200);
		assert.equal(getCourse(courseId).classPosition?.coveredThrough, undefined, "back to lecture 9 without the chapter");
		await runTurn(chatId, "Actually just follow the schedule.", oneCall("class_position_set", { followSchedule: true }, "pos3"));
		assert.equal(getCourse(courseId).classPosition, undefined);
		assert.equal(courses.courseView(courseId)!.standing!.position!.lectureId, l8.value.id, "the dates: lecture 8");
		assert.equal((await undo(chatId, "pos3")).status, 200);
		assert.equal(getCourse(courseId).classPosition?.lectureId, l9.value.id);
		await runTurn(chatId, "We're on lecture 12.", oneCall("class_position_set", { lectureNumber: 12 }, "pos4", "There is no lecture 12 yet."));
		assert.match(resultText(chatId, "pos4"), /No lecture has number 12/);
	});

	it("skill_weights_set: \"the chain rule won't be on the exam\" marks it the learner's; Undo restores the model's weight", async () => {
		const { courseId, c, d } = approvedCourse();
		courseStore.updateCourse(courseId, { skillWeights: { [d]: { w: 2, by: "model", reason: "two past exams" } } });
		const chatId = askChat(courseId);
		await runTurn(chatId, "Nyquist won't be on the exam, and Bode is on every exam.", oneCall("skill_weights_set", { weights: [{ skillId: d, weight: 0 }, { skillId: c, weight: 3 }] }, "w1"));
		assert.deepEqual(getCourse(courseId).skillWeights, { [d]: { w: 0, by: "learner" }, [c]: { w: 3, by: "learner" } });
		assert.ok(courses.courseView(courseId)!.notExamined.includes(d), "Nyquist now sits under Not examined");
		const change = (toolResults(chatId).find((r) => r.toolCallId === "w1")!.details as { change: unknown }).change;
		assert.deepEqual(classChangeLines(change as never), { eyebrow: "Exam weights", title: "Nyquist, Bode", lines: ["Nyquist: never on the exam (was 2)", "Bode: nearly always on the exam"] });
		assert.equal((await undo(chatId, "w1")).status, 200);
		assert.deepEqual(getCourse(courseId).skillWeights, { [d]: { w: 2, by: "model", reason: "two past exams" } });
		await runTurn(chatId, "x", oneCall("skill_weights_set", { weights: [{ skillId: "sk_nope", weight: 1 }] }, "w2"));
		assert.match(resultText(chatId, "w2"), /^Not saved: sk_nope is not a skill of this course/);
	});

	it("class_update: title, language, pace and folder through the page's setters; a bad value is refused; Undo", async () => {
		const { courseId } = approvedCourse();
		const chatId = askChat(courseId);
		await runTurn(chatId, "Rename the class to Control systems.", oneCall("class_update", { field: "title", value: "Control systems" }, "u1"));
		await runTurn(chatId, "Make it Norwegian.", oneCall("class_update", { field: "language", value: "nb" }, "u2"));
		await runTurn(chatId, "Crash course pace please.", oneCall("class_update", { field: "pace", value: "crash" }, "u3"));
		await runTurn(chatId, "Put it in 2026 Høst.", oneCall("class_update", { field: "folder", value: "2026 Høst" }, "u4"));
		const c = getCourse(courseId);
		assert.deepEqual([c.title, c.language, c.pace, c.folder], ["Control systems", "nb", "crash", "2026 Høst"]);
		const change = (toolResults(chatId).find((r) => r.toolCallId === "u2")!.details as { change: unknown }).change;
		assert.deepEqual(classChangeLines(change as never), { eyebrow: "Class language", title: "Norwegian", lines: ["Was: default"] }, "this class had no language stamp");
		await runTurn(chatId, "Pace: turbo.", oneCall("class_update", { field: "pace", value: "turbo" }, "u5"));
		assert.match(resultText(chatId, "u5"), /^Not changed: pace must be thorough, efficient, crash/);
		await runTurn(chatId, "Delete the class.", oneCall("class_update", { field: "deleted", value: "yes" }, "u6", "You can delete it with Delete class… at the bottom of the side panel."));
		assert.equal(toolResults(chatId).find((r) => r.toolCallId === "u6")!.isError, true, "no such field: refused by the schema");
		assert.ok(courseStore.getCourse(courseId), "the class is still there");
		for (const id of ["u4", "u3", "u2", "u1"]) assert.equal((await undo(chatId, id)).status, 200, id);
		const back = getCourse(courseId);
		assert.deepEqual([back.title, back.language, back.pace, back.folder], ["Signals", undefined, undefined, undefined]);
		// a later edit on the page makes the card stale
		await runTurn(chatId, "Rename it again.", oneCall("class_update", { field: "title", value: "Signals 2" }, "u7"));
		courses.renameCourse(courseId, "Signals 3");
		assert.equal((await undo(chatId, "u7")).status, 409);
	});

	it("assessments: \"move quiz 3 to Monday\", \"quiz 3 also covers chapter 6\", \"the final is cumulative\", \"the midterm got cancelled\"", async () => {
		const { courseId, a, b, c, d } = approvedCourse();
		const q3 = assess.createAssessment(courseId, { kind: "quiz", title: "Quiz 3", date: inDays(3), topics: "chapters 4 and 5" });
		const mid = assess.createAssessment(courseId, { kind: "midterm", title: "Midterm", date: inDays(12) });
		const fin = assess.createAssessment(courseId, { kind: "final", title: "Final", date: inDays(40) });
		assert.ok(q3.ok && mid.ok && fin.ok);
		const chatId = askChat(courseId);
		await runTurn(chatId, "Quiz 3 moved to Monday next week.", oneCall("assessment_save", { id: q3.value.id, date: "Monday next week" }, "s1"));
		const resolved = A.resolveDateText("Monday next week", Date.now())!;
		assert.equal(A.liveAssessments(getCourse(courseId).assessments).find((x) => x.id === q3.value.id)!.date, resolved);
		await runTurn(chatId, "Quiz 3 also covers chapter 6.", oneCall("assessment_save", { id: q3.value.id, topics: "chapters 4 and 5, and chapter 6" }, "s2"));
		assert.equal(A.liveAssessments(getCourse(courseId).assessments).find((x) => x.id === q3.value.id)!.topics, "chapters 4 and 5, and chapter 6");
		await runTurn(chatId, "The final is cumulative.", oneCall("assessment_save", { id: fin.value.id, allSkills: true }, "s3"));
		assert.deepEqual(A.liveAssessments(getCourse(courseId).assessments).find((x) => x.id === fin.value.id)!.skillIds.sort(), [a, b, c, d].sort());
		await runTurn(chatId, "The midterm got cancelled.", oneCall("assessment_remove", { id: mid.value.id }, "s4"));
		assert.ok(!A.liveAssessments(getCourse(courseId).assessments).some((x) => x.id === mid.value.id));
		assert.deepEqual(await statuses(chatId), { s1: "changed", s2: "applied", s3: "applied", s4: "applied" }, "s2 changed the same quiz after s1");
		assert.equal((await undo(chatId, "s3")).status, 200);
		assert.deepEqual(A.liveAssessments(getCourse(courseId).assessments).find((x) => x.id === fin.value.id)!.skillIds, []);
	});

	it("class_overview answers \"am I ready for Friday\": the class, what is learned, the quiz's needs with its lectures, the gap", async () => {
		const { courseId, a, b, c } = approvedCourse();
		lectures.createLecture(courseId, { n: 1, date: inDays(-14), skillIds: [a] });
		lectures.createLecture(courseId, { n: 2, date: inDays(-7), skillIds: [b] });
		lectures.createLecture(courseId, { n: 3, date: inDays(-1), skillIds: [c] });
		assess.createAssessment(courseId, { kind: "quiz", title: "Quiz 3", date: inDays(2), skillIds: [a, b, c] });
		learn(courseId, a);
		const chatId = askChat(courseId);
		const before = JSON.stringify(getCourse(courseId));
		await runTurn(chatId, "Am I ready for Friday?", oneCall("class_overview", {}, "ov1", "Not quite: Poles and Bode are still open."));
		const text = resultText(chatId, "ov1");
		assert.match(text, /The class is at Lecture 3, \w{3} \d{1,2} \w{3} \d{4} — from the lecture dates\./);
		assert.match(text, /The learner has learned what Lecture 1 covers\./);
		assert.match(text, /Behind: 2 skills from lectures the class has covered are not learned: Poles, Bode\./);
		assert.match(text, /- Quiz 3 \(quiz\) · \w{3} \d{1,2} \w{3} \d{4} · in 2 days · needs 3 skills: 1 learned \(Laplace\), 2 not yet: Poles \(Lecture 2\), Bode \(Lecture 3\)\./);
		assert.match(text, /The most urgent gap: Poles; the class page's Start begins it\./);
		assert.equal(toolResults(chatId).find((r) => r.toolCallId === "ov1")!.details, null, "read-only: no change card");
		assert.equal(partShows({ type: "tool-class_overview", state: "output-available" }), false);
		const after = getCourse(courseId);
		assert.equal(JSON.stringify({ ...after, updatedAt: "" , lecturesLinkedKey: "", lecturesLinkedAt: "", lecturesLinkError: "" }), JSON.stringify({ ...JSON.parse(before), updatedAt: "", lecturesLinkedKey: "", lecturesLinkedAt: "", lecturesLinkError: "" }), "the overview writes nothing about the class");
	});
});

// ─── the class page ──────────────────────────────────────────────────────────

describe("the class page: the card and the lecture list in each state", () => {
	const NOW = new Date(2026, 10, 25, 12).getTime();
	const names = new Map([["a", "Laplace"], ["b", "Poles"], ["c", "Bode"], ["d", "Nyquist"]]);
	const base: CourseStandingView = { lectures: [], position: null, covered: [], learnedThrough: null, next: null, behind: [], verdict: "unknown", start: null, unplaced: 4, linking: false, files: {} };
	const L4 = [
		lec({ id: "l1", n: 1, title: "Lecture 1", date: "2026-11-03", skillIds: ["a"], source: "syllabus" }),
		lec({ id: "l2", n: 2, title: "Lecture 2", date: "2026-11-10", skillIds: ["b"] }),
		{ ...lec({ id: "lf_lecture_3", n: 3, title: "Lecture 3", date: "2026-11-24", skillIds: [], materialIds: ["m3"], source: "files" }), derived: true as const },
		lec({ id: "l4", n: 4, title: "Lecture 4", date: "2026-12-01", skillIds: ["d"] }),
	];
	const behind: CourseStandingView = {
		...base,
		lectures: L4,
		position: { lectureId: "lf_lecture_3", how: "dated", label: "Lecture 3", date: "2026-11-24" },
		covered: ["l1", "l2", "lf_lecture_3"],
		learnedThrough: { fromId: "l1", toId: "l1", label: "Lecture 1" },
		next: { id: "as_q", title: "Quiz 3", kind: "quiz", date: "2026-11-27", needs: ["a", "b", "d"], basis: "assessment", learned: ["a"], missing: [{ skillId: "b", lectureIds: ["l2"] }, { skillId: "d", lectureIds: ["l4"] }] },
		behind: ["b"],
		verdict: "behind",
		start: { skillId: "b", gapId: "b", why: "assessment" },
		unplaced: 1,
		files: { m3: "Lecture 3.pdf" },
	};
	const planOf = (over: Partial<CoursePlan> = {}): CoursePlan => ({ skillsLeft: 2, reviewDue: 0, reviewBatch: 0, lessons: ["d", "b"], ...over });
	const section = (standing: CourseStandingView | undefined, over: Partial<CoursePlan> = {}) =>
		renderToStaticMarkup(
			<InteractionLayersProvider>
				<ExamPlanSection courseId="course_1" plan={planOf(over)} names={names} weightOf={() => 1} nextUp={["b", "d"]} learningCount={0} readiness={null} hasWeights={false} weighing={false} canWeigh busy={false} onStart={() => {}} onChanged={() => {}} {...(standing ? { standing } : {})} />
			</InteractionLayersProvider>,
		);

	it("standingLines: each line in each state", () => {
		assert.equal(showsStanding(base), false, "no lectures, no assessment, no position: no block");
		assert.deepEqual(standingLines(behind, NOW), {
			classLine: "Class is at Lecture 3 · Tue 24 Nov",
			youLine: "You've learned what Lecture 1 covers",
			nextLine: "Quiz 3 · Fri · needs 3 skills: 1 learned, 2 not yet (Lecture 2, Lecture 4)",
			verdict: { text: "Behind · 1 skill from lectures the class has covered", behind: true },
		});
		const onTrack = { ...behind, learnedThrough: { fromId: "l1", toId: "l2", label: "Lectures 1–2" }, behind: [], verdict: "on_track" as const, next: null };
		assert.deepEqual(standingLines(onTrack, NOW), { classLine: "Class is at Lecture 3 · Tue 24 Nov", youLine: "You've learned what Lectures 1–2 cover", nextLine: null, verdict: { text: "On track", behind: false } });
		const unplaced = { ...base, lectures: L4.map((l) => ({ ...l, skillIds: [] })) };
		assert.deepEqual(standingLines(unplaced, NOW), { classLine: "Where the class is: not known yet", youLine: "Skills aren't placed in lectures yet", nextLine: null, verdict: null });
		assert.equal(standingLines({ ...unplaced, linking: true }, NOW).youLine, "Placing the skills in the lectures…");
		const noLectures = { ...base, next: { ...behind.next!, needs: null, basis: null, learned: [], missing: [], date: "2026-12-10" } };
		assert.equal(standingLines(noLectures, NOW).nextLine, "Quiz 3 · Thu 10 Dec", "far off: the date; needs unknown: no count");
		assert.equal(standingLines({ ...behind, position: { lectureId: "l2", how: "explicit", label: "Lecture 2", coveredThrough: "chapter 6" } }, NOW).classLine, "Class is at Lecture 2 · covered chapter 6");
	});

	it("the Next up card: the block above the one primary Start on the most urgent gap; without lectures it is as before", () => {
		const html = section(behind);
		assert.match(html, /data-testid="course-next-up"[\s\S]*Next up[\s\S]*data-testid="where-you-stand"[\s\S]*data-testid="standing-class"[\s\S]*Class is at Lecture 3 · Tue 24 Nov[\s\S]*data-testid="standing-you"[\s\S]*You&#x27;ve learned what Lecture 1 covers[\s\S]*data-testid="standing-next"[\s\S]*Quiz 3[\s\S]*data-testid="standing-verdict"[^>]*>Behind · 1 skill/);
		assert.match(html, /data-testid="course-gap-b"[\s\S]*For Quiz 3[\s\S]*Poles[\s\S]*aria-label="Start learning Poles"/);
		assert.equal((html.match(/lh-touch/g) ?? []).length >= 1, true);
		const reviewToo = section(behind, { reviewDue: 2, reviewBatch: 2 });
		assert.match(reviewToo, /data-testid="course-today-review"[\s\S]*data-testid="course-gap-b"/, "a review due keeps its row; the gap holds the primary");
		const plain = section(undefined);
		assert.doesNotMatch(plain, /where-you-stand|course-gap/);
		assert.match(plain, /data-testid="course-today-lesson-d"/, "no lectures: today's first lesson as before");
		assert.doesNotMatch(section(base), /where-you-stand/, "nothing to stand on: no block");
		const locked = section({ ...behind, start: { skillId: "a", gapId: "b", why: "assessment" } });
		assert.match(locked, /First, for Poles[\s\S]*Laplace/);
		// the block alone, the class line as a button to correct it
		assert.match(renderToStaticMarkup(<WhereYouStand courseId="c" standing={behind} now={NOW} />), /<button[^>]*title="Correct where the class is"[^>]*data-testid="standing-class-edit"/);
	});

	it("the lecture list: empty, items with the class's position and where they came from, linking, unplaced, failure", () => {
		const render = (standing: CourseStandingView) => renderToStaticMarkup(<LectureList courseId="course_1" standing={standing} skills={[...names].map(([id, name]) => ({ id, name }))} onChanged={() => {}} />);
		assert.match(render(base), /data-testid="lectures"[\s\S]*Lectures[\s\S]*data-testid="lecture-add"[\s\S]*data-testid="lectures-empty"[^>]*>No lectures yet\. Name files like “Lecture 8” or “L08”, find them in the syllabus, add one, or tell Short question\./);
		const html = render(behind);
		assert.match(html, /data-testid="lecture-item-l1"[^>]*data-covered="true"[\s\S]*Lecture 1[\s\S]*Tue 3 Nov[\s\S]*from the syllabus · 1 skill/);
		assert.match(html, /data-testid="lecture-item-lf_lecture_3"[\s\S]*data-testid="lecture-here-lf_lecture_3"[\s\S]*from your files · no skills placed/);
		assert.match(html, /data-testid="lecture-item-l4"[^>]*data-covered="false"/);
		assert.match(html, /data-testid="lectures-unplaced"[\s\S]*1 skill is not placed in a lecture\.[\s\S]*Place skills/);
		assert.match(render({ ...behind, linking: true }), /data-testid="lectures-linking"[\s\S]*Placing the skills in the lectures…/);
		assert.match(render({ ...behind, linkError: "model down" }), /Placing skills failed: model down/);
		assert.doesNotMatch(render({ ...behind, unplaced: 0 }), /lectures-unplaced/);
		// long titles stay short in one-line places (screenshot round r6)
		const t1 = { n: 1, title: "Lecture 1: ATP and energy coupling" };
		const t4 = { n: 4, title: "Lecture 4: The proton gradient" };
		assert.equal(L.lectureRangeLabel(t1, t4), "Lectures 1–4");
		assert.equal(L.lectureShortLabel(t4), "Lecture 4");
		assert.equal(L.lectureShortLabel({ title: "Guest talk" }), "Guest talk");
		assert.equal(L.lectureRangeLabel({ n: 1, title: "Intro" }, t4), "Intro – Lecture 4");
		const titled = { ...behind, lectures: behind.lectures.map((l) => (l.id === "lf_lecture_3" ? { ...l, title: "Lecture 3: Fermentation and the citric acid cycle" } : l)) };
		assert.equal(standingLines(titled, NOW).classLine, "Class is at Lecture 3 · Tue 24 Nov");
		assert.deepEqual(lectureBody({ n: "8", title: " Lecture 8 ", date: "", topics: "x", skillIds: ["a"] }, { skillIds: ["a"] }), { n: 8, title: "Lecture 8", date: null, topics: "x" }, "unchanged skills are not sent (they stay the model's)");
		assert.deepEqual(lectureBody({ n: "", title: "T", date: "2026-12-01", topics: "", skillIds: ["b"] }, { skillIds: ["a"] }).skillIds, ["b"]);
	});

	it("the side panel holds the lectures under Upcoming; the syllabus proposal shows its lecture schedule", () => {
		const files: MaterialsApi = { materials: [], draft: [], reading: 0, busy: false, error: null, clearError: () => {}, addFiles: async () => {}, addUrl: async () => true, remove: async () => {}, pickFiles: () => {}, camera: { available: false, open: () => {} }, node: null };
		const html = renderToStaticMarkup(
			<InteractionLayersProvider>
				<ClassPanel courseId="course_1" courseTitle="Signals" pace={undefined} files={files} hasSkills hasDraft={false} drafting={false} error={null} busy={false} onDraft={() => {}} onPlacement={() => {}} onDeleted={() => {}} upcoming={{ items: [], finding: false }} standing={behind} />
			</InteractionLayersProvider>,
		);
		assert.match(html, /data-testid="upcoming"[\s\S]*data-testid="lectures"[\s\S]*data-testid="class-settings"/);
		const proposalLectures: ProposedLecture[] = [
			{ key: "l1", n: 1, title: "Lecture 1", date: "2026-11-03", topics: "", skillIds: [], cite: "Syllabus.pdf p. 2", status: "new" },
			{ key: "l2", n: 2, title: "Lecture 2", topics: "", skillIds: [], cite: "Syllabus.pdf p. 2", status: "same", match: "lc_2" },
		];
		const up = renderToStaticMarkup(<UpcomingList courseId="course_1" upcoming={{ items: [], finding: false, proposal: { id: "ap_1", createdAt: "t", summary: "Read Syllabus.pdf.", items: [{ key: "p1", kind: "quiz", title: "Quiz 1", topics: "", skillIds: [], cite: "Syllabus.pdf p. 2", status: "new" }], lectures: proposalLectures } }} skills={[]} canFind onChanged={() => {}} now={NOW} />);
		assert.match(up, /From the syllabus · 2 to add[\s\S]*1 already in your list\./);
		assert.match(up, /data-testid="proposal-lectures"[\s\S]*Lecture schedule · 1 lecture[\s\S]*data-testid="proposal-lecture-l1"[\s\S]*Tue 3 Nov[\s\S]*data-testid="proposal-drop-l1"/);
		assert.doesNotMatch(up, /proposal-lecture-l2/);
		assert.match(up, /data-testid="proposal-approve"[^>]*>Add all 2</);
	});

	it("the transcript cards for each new change kind", () => {
		const lecture = { kind: "lecture" as const, courseId: "c", action: "updated" as const, before: lec({ id: "l9", n: 9, title: "Lecture 9", date: "2026-11-26" }), after: lec({ id: "l9", n: 9, title: "Lecture 9", date: "2026-11-27", topics: "poles" }), skillNames: ["Poles"] };
		assert.deepEqual(classChangeLines(lecture), { eyebrow: "Changed · Lecture", title: "Lecture 9", lines: ["Fri 27 Nov 2026 (was Thu 26 Nov 2026)", "poles", "Skills: Poles"] });
		const setting = { kind: "setting" as const, courseId: "c", field: "folder" as const, before: null, after: "2026 Høst" };
		assert.deepEqual(classChangeLines(setting), { eyebrow: "Folder", title: "2026 Høst", lines: ["Was: no folder"] });
		const cleared = { kind: "position" as const, courseId: "c", before: { lectureId: "l9", updatedAt: T0 }, after: null, label: null, beforeLabel: "Lecture 9" };
		assert.deepEqual(classChangeLines(cleared), { eyebrow: "Class position", title: "Follows the lecture dates", lines: ["Was: Lecture 9"] });
		const removed = renderToStaticMarkup(<ClassChangeView change={{ ...lecture, action: "removed", after: null }} status="applied" onUndo={() => {}} />);
		assert.match(removed, /Removed · Lecture[\s\S]*line-through[\s\S]*Lecture 9[\s\S]*data-testid="class-change-undo"/);
	});
});
