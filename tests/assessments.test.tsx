/**
 * WP8 (2026-11-25): a class's quizzes and exams (read from the syllabus, edited from Short question) and what the learner
 * says they know. The data (sanitizing, the old exam date read as an "Exam", the next assessment, the sync merge with
 * deletions, the API routes), Next up and review timing following the next assessment, the syllabus pass (a fake finder:
 * the proposal with citations, approval, dropping, re-running without duplicates, the learner's edits winning, no
 * invented dates), Ask turns driven by a scripted model (a save whose date resolves, a removal, Undo, an ambiguous case
 * that asks), self-reports (each stance's effect, real evidence overriding, Undo, deleting the chat, sync), isolation (no
 * graded evidence, no graph), and the class page's Upcoming list in each state. Deterministic: no real model.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-assess-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const A = await import("../src/core/assessments.ts");
const mastery = await import("../src/core/mastery.ts");
const plan = await import("../src/core/exam-plan.ts");
const { mergeFile } = await import("../src/core/sync-merge.ts");
const { mergeSkillLines } = await import("../src/core/skills.ts");
const { skillStore } = await import("../src/store/skills.ts");
const { courseStore } = await import("../src/store/courses.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { materialStore } = await import("../src/store/materials.ts");
const courses = await import("../src/server/courses.ts");
const assess = await import("../src/server/assessments.ts");
// WP9: the change cards, Undo and the tools' port moved to server/class-changes.ts
const changes = await import("../src/server/class-changes.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { createAskAgent, ASK_TOOL_NAMES } = await import("../src/agent/ask-agent.ts");
const { classFactsTools } = await import("../src/agent/tools/class-facts.ts");
const { fillFound } = await import("../src/agent/subagents/assessment-finder.ts");
const { askSystemPrompt } = await import("../src/agent/ask-prompt.ts");
const { partShows } = await import("../components/transcript-rows.ts");
const { UpcomingList, countdownLabel, upcomingRows } = await import("../components/upcoming-list.tsx");
const { ClassChangeView, classChangeLines } = await import("../components/class-change-card.tsx");
const { ClassPanel } = await import("../components/class-panel.tsx");
const { InteractionLayersProvider } = await import("../components/interaction-layers.tsx");
const { LEDGER_FILES } = await import("../config.ts");
const listRoute = await import("../app/api/courses/[id]/assessments/route.ts");
const itemRoute = await import("../app/api/courses/[id]/assessments/[assessmentId]/route.ts");
const proposalRoute = await import("../app/api/courses/[id]/assessments/proposal/route.ts");
const findRoute = await import("../app/api/courses/[id]/assessments/find/route.ts");
const reportRoute = await import("../app/api/courses/[id]/self-reports/[reportId]/route.ts");
const changesRoute = await import("../app/api/chats/[id]/class-changes/route.ts");
const undoRoute = await import("../app/api/chats/[id]/class-changes/[toolCallId]/route.ts");

import type { Assessment, AssessmentProposal, ProposedAssessment, SelfReport } from "../src/core/assessments.ts";
import type { CourseRecord, UpcomingView } from "../src/core/contracts.ts";
import type { SkillWeightValue } from "../src/core/exam-plan.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { MaterialsApi } from "../components/use-materials";

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

// ─── fixtures ────────────────────────────────────────────────────────────────

const DAY = 86_400_000;

function reset() {
	assess.setAssessmentFinderForTests(null);
	for (const c of courseStore.listCourses()) courseStore.deleteCourse(c.id);
	for (const c of chatStore.listChats()) chatStore.deleteChat(c.id);
	fs.rmSync(LEDGER_FILES.skills, { force: true });
	fs.rmSync(LEDGER_FILES.nodes, { force: true });
}

/** "YYYY-MM-DD" of the local day `n` days from now. */
function inDays(n: number, from = Date.now()): string {
	const d = new Date(from + n * DAY);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** An approved course a → b, c (c independent). */
function approvedCourse(title = "Signals") {
	const course = courseStore.createCourse(title);
	courseStore.updateCourse(course.id, {
		status: "draft",
		draft: {
			createdAt: "t",
			summary: "s",
			skills: [
				{ key: "s1", name: "Laplace", statement: "Take a Laplace transform", requires: [], restsOn: [] },
				{ key: "s2", name: "Poles", statement: "Read the poles of a transfer function", requires: ["s1"], restsOn: [] },
				{ key: "s3", name: "Bode", statement: "Sketch a Bode plot", requires: [], restsOn: [] },
			],
		},
	});
	const approved = courses.approveCourse(course.id);
	assert.ok(approved.ok);
	const byName = Object.fromEntries(mergeSkillLines(skillStore.readSkillLines()).map((s) => [s.name, s.id]));
	return { courseId: course.id, a: byName.Laplace!, b: byName.Poles!, c: byName.Bode! };
}

function addSyllabus(courseId: string, name = "Syllabus.md") {
	const m = materialStore.add(courseId, { kind: "text", name, ext: ".md", bytes: new TextEncoder().encode("# Schedule\nQuiz 1: Friday week 3, chapters 1-2.\n") });
	materialStore.update(courseId, m.id, { status: "ready", profile: "## Scope and targets\nThe course schedule and exam dates." });
	return m;
}

const ASSISTANT_BASE = { api: "faux", provider: "faux", model: "faux", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse" } as const;

/** A course practice session with one concluded problem on `skill` at `at` (graded `grade`). */
function practiceEvidence(courseId: string, skill: string, at: number, grade: "again" | "hard" | "good" | "easy" = "good") {
	const created = courses.createCourseSession(courseId, "practice", skill);
	if (!created.ok) {
		// a locked skill cannot start a practice session: write the chat directly
		const chat = chatStore.createChat("p", "practice", { courseId, mode: "practice", skillIds: [skill] });
		return writeProblem(chat.id, skill, at, grade);
	}
	return writeProblem(created.value.id, skill, at, grade);
}

function writeProblem(chatId: string, skill: string, at: number, grade: string) {
	const messages = [
		{ id: `p1${at}`, role: "assistant", content: [{ type: "toolCall", id: `pose${at}`, name: "problem", arguments: { statement: "x", skills: [skill] } }], ...ASSISTANT_BASE, timestamp: at },
		{ id: `p2${at}`, role: "toolResult", toolCallId: `pose${at}`, toolName: "problem", content: [{ type: "text", text: "ok" }], isError: false, timestamp: at },
		{ id: `p3${at}`, role: "assistant", content: [{ type: "toolCall", id: `done${at}`, name: "conclude", arguments: { outcome: "solved" } }], ...ASSISTANT_BASE, timestamp: at + 1000 },
		{ id: `p4${at}`, role: "toolResult", toolCallId: `done${at}`, toolName: "conclude", content: [{ type: "text", text: "ok" }], isError: false, details: { grades: [{ skill, grade }] }, timestamp: at + 1000 },
	] as unknown as LhMessage[];
	chatStore.saveMessages(chatId, [...(chatStore.getChat(chatId)!.messages), ...messages]);
	courses.clearCourseEvidenceCache();
	return chatId;
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

function askChat(courseId: string) {
	const out = courses.createCourseSession(courseId, "ask");
	assert.ok(out.ok);
	pinModel(out.value.id);
	return out.value.id;
}

const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const json = (body: unknown, method = "POST") => new Request("http://test/x", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const getCourse = (id: string) => courseStore.getCourse(id)!;
const live = (c: CourseRecord) => A.liveAssessments(c.assessments);
const toolResults = (chatId: string) =>
	chatStore.getChat(chatId)!.messages.filter((m) => (m as { role?: string }).role === "toolResult") as unknown as Array<{ toolCallId: string; toolName: string; isError: boolean; details: unknown; content: Array<{ text?: string }> }>;

async function waitFinding(courseId: string) {
	for (let i = 0; i < 200 && assess.assessmentFinding(courseId); i++) await new Promise((r) => setTimeout(r, 5));
	assert.equal(assess.assessmentFinding(courseId), false, "the pass settled");
}

// ─── the data ────────────────────────────────────────────────────────────────

describe("assessments: the data", () => {
	it("sanitizes on read: bad entries dropped, fields capped and cleaned, one entry per id (the later write wins)", () => {
		const t = "2026-11-25T10:00:00.000Z";
		const list = A.readAssessmentEntries([
			{ id: "as_1", kind: "quiz", title: "  Quiz   3 ", date: "2026-12-04", topics: "ch 4\n\n\n\nch 5", skillIds: ["sk_a", "sk_a", "", 3], source: "chat", updatedAt: t },
			{ id: "as_1", kind: "quiz", title: "Older", updatedAt: "2026-11-24T10:00:00.000Z", topics: "" },
			{ id: "as_2", kind: "lecture", title: "x", updatedAt: t },
			{ id: "as_3", kind: "exam", title: "", updatedAt: t },
			{ id: "as_4", kind: "exam", title: "x".repeat(500), date: "2026-02-31", topics: "y".repeat(5000), skillIds: [], updatedAt: t, source: "weird" },
			{ id: "as_5", deleted: true, updatedAt: t },
			{ id: "exam-date", kind: "exam", title: "Spoof", updatedAt: t },
			"junk",
		]);
		assert.deepEqual(list.map((e) => e.id), ["as_1", "as_4", "as_5"]);
		const q = list[0] as Assessment;
		assert.equal(q.title, "Quiz 3");
		assert.equal(q.topics, "ch 4\n\nch 5");
		assert.deepEqual(q.skillIds, ["sk_a"]);
		const big = list[1] as Assessment;
		assert.equal(big.title.length, A.TITLE_MAX);
		assert.equal(big.topics.length, A.TOPICS_MAX);
		assert.equal(big.date, undefined, "not a real calendar date");
		assert.equal(big.source, "manual");
		assert.ok(A.isTombstone(list[2]));
	});

	it("bounds a list for writing: tombstones capped by count (the oldest go); live items never dropped", () => {
		const t = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
		const items = Array.from({ length: 130 }, (_, i) => ({ id: `as_${i}`, kind: "quiz" as const, title: `Q${i}`, date: `2027-01-${String((i % 28) + 1).padStart(2, "0")}`, topics: "", skillIds: [], source: "manual" as const, updatedAt: t(i) }));
		const dead = Array.from({ length: A.TOMBSTONES_MAX + 50 }, (_, i) => ({ id: `d_${i}`, deleted: true as const, updatedAt: t(i) }));
		const bounded = A.boundAssessments([...items, ...dead]);
		assert.equal(bounded.filter((e) => !A.isTombstone(e)).length, 130, "a write never drops a live item (review 1, finding 5)");
		assert.equal(bounded.filter(A.isTombstone).length, A.TOMBSTONES_MAX);
		assert.ok(!bounded.some((e) => e.id === "d_0") && bounded.some((e) => e.id === `d_${A.TOMBSTONES_MAX + 49}`), "the oldest tombstones go first");
	});

	it("the old exam date is read as an \"Exam\" (no write), hidden when an exam-type item sits on that date", () => {
		const course = { examDate: "2026-12-14", updatedAt: "2026-11-25T10:00:00.000Z", assessments: [] };
		const read = A.courseAssessments(course);
		assert.deepEqual(read.map((a) => [a.id, a.kind, a.title, a.date, a.legacy]), [[A.LEGACY_EXAM_ID, "exam", "Exam", "2026-12-14", true]]);
		const withFinal = A.courseAssessments({ ...course, assessments: [{ id: "as_f", kind: "final", title: "Final", date: "2026-12-14", topics: "", skillIds: [], source: "manual", updatedAt: course.updatedAt }] });
		assert.deepEqual(withFinal.map((a) => a.id), ["as_f"]);
		const withQuiz = A.courseAssessments({ ...course, assessments: [{ id: "as_q", kind: "quiz", title: "Quiz", date: "2026-12-14", topics: "", skillIds: [], source: "manual", updatedAt: course.updatedAt }] });
		assert.deepEqual(withQuiz.map((a) => a.id).sort(), ["as_q", A.LEGACY_EXAM_ID].sort(), "a quiz that day does not hide the exam");
		// the teacher's line for the old exam date is word for word what it was
		const now = new Date(2026, 10, 14, 12).getTime();
		assert.equal(A.assessmentWhen(A.nextAssessment(read, now), now), plan.examWhen("2026-12-14", now));
	});

	it("the next assessment is the nearest dated one today or later; a passed one only for the countdown", () => {
		const now = new Date(2026, 10, 25, 12).getTime();
		const mk = (id: string, kind: Assessment["kind"], date?: string, skillIds: string[] = []): Assessment => ({ id, kind, title: id, ...(date ? { date } : {}), topics: "", skillIds, source: "manual", updatedAt: "2026-11-01T00:00:00.000Z" });
		const list = [mk("past", "quiz", "2026-11-20"), mk("undated", "exam"), mk("later", "final", "2026-12-20"), mk("soon", "quiz", "2026-12-01", ["sk_a"]), mk("today", "assignment", "2026-11-25")];
		assert.equal(A.nextAssessment(list, now)?.id, "today");
		assert.equal(A.nextAssessment(list.filter((a) => a.id !== "today"), now)?.id, "soon");
		// on one day the bigger one is "the next"
		assert.equal(A.nextAssessment([mk("q", "quiz", "2026-12-01"), mk("f", "final", "2026-12-01")], now)?.id, "f");
		assert.equal(A.nextAssessment([mk("past", "quiz", "2026-11-20")], now), undefined);
		assert.equal(A.countdownAssessment([mk("old", "quiz", "2026-10-01"), mk("past", "quiz", "2026-11-20")], now)?.id, "past");
		// a skill's review target: the nearest that lists it, or one that lists no skills
		const noToday = list.filter((a) => a.id !== "today");
		assert.equal(A.targetDateFor("sk_a", noToday, now), "2026-12-01");
		assert.equal(A.targetDateFor("sk_b", noToday, now), "2026-12-20");
		assert.deepEqual([...A.focusSkills(noToday, now)], ["sk_a"]);
	});

	it("resolves the learner's dates against today in the local time zone, and refuses what it cannot read", () => {
		const wed = new Date(2026, 10, 25, 9).getTime(); // Wednesday 25 Nov 2026
		assert.equal(A.resolveDateText("next Friday", wed), null, "ambiguous on a Wednesday (review 1, finding 3)");
		assert.equal(A.resolveDateText("Friday", wed), "2026-11-27");
		assert.equal(A.resolveDateText("on wednesday", wed), null, "said on that weekday: today or a week from today, so it asks (re-check 1, N3)");
		assert.equal(A.resolveDateText("friday next week", wed), "2026-12-04");
		assert.equal(A.resolveDateText("tomorrow", wed), "2026-11-26");
		assert.equal(A.resolveDateText("in 2 weeks", wed), "2026-12-09");
		assert.equal(A.resolveDateText("12 March", wed), "2027-03-12");
		assert.equal(A.resolveDateText("December 4", wed), "2026-12-04");
		assert.equal(A.resolveDateText("2026-12-04", wed), "2026-12-04");
		assert.equal(A.resolveDateText("fredag", wed), "2026-11-27", "Norwegian weekdays");
		for (const bad of ["soon", "after the break", "31 February", "week 7"]) assert.equal(A.resolveDateText(bad, wed), null, bad);
		assert.equal(A.weekDate("2026-01-12", 7, 5), "2026-02-27", "week 7 Friday of a term starting Monday 12 Jan");
		assert.equal(A.weekDate("2026-01-14", 1, 1), "2026-01-12", "week 1 is the week the term starts in");
		assert.equal(A.weekDate("nope", 1, 1), null);
	});

	it("sync: per item by id, the later write winning; a deletion survives the other device's copy", () => {
		const t = (h: number) => `2026-11-25T${String(h).padStart(2, "0")}:00:00.000Z`;
		const q = (title: string, h: number) => ({ id: "as_q", kind: "quiz", title, topics: "", skillIds: [], source: "manual", updatedAt: t(h) });
		const base = { id: "c1", title: "T", createdAt: t(1), updatedAt: t(1), status: "active", skills: [], assessments: [q("Quiz", 1)], version: 1 };
		const local = { ...base, updatedAt: t(3), assessments: [{ id: "as_q", deleted: true, updatedAt: t(3) }, { id: "as_new", kind: "exam", title: "Final", topics: "", skillIds: [], source: "manual", updatedAt: t(3) }] };
		const remote = { ...base, updatedAt: t(2), title: "Renamed", assessments: [q("Quiz", 1), { id: "as_r", kind: "quiz", title: "Quiz 2", topics: "", skillIds: [], source: "chat", updatedAt: t(2) }] };
		const out = mergeFile({ path: "courses/c1.json", base: JSON.stringify(base), local: JSON.stringify(local), remote: JSON.stringify(remote), prefer: "local" });
		const merged = JSON.parse(out.content!) as CourseRecord;
		assert.equal(merged.title, "Renamed");
		assert.deepEqual(live(merged).map((a) => a.id).sort(), ["as_new", "as_r"], "the deletion stays, both additions arrive");
		assert.ok(A.readAssessmentEntries(merged.assessments).some((e) => e.id === "as_q" && A.isTombstone(e)), "the tombstone travels on");
		// an edit made after the deletion wins over it
		const edited = { ...remote, updatedAt: t(4), assessments: [q("Quiz (moved)", 4)] };
		const again = JSON.parse(mergeFile({ path: "courses/c1.json", base: JSON.stringify(base), local: JSON.stringify(local), remote: JSON.stringify(edited), prefer: "local" }).content!) as CourseRecord;
		assert.equal(live(again).find((a) => a.id === "as_q")?.title, "Quiz (moved)");
		// a copy from an older build (no list) neither adds nor removes
		const older = { ...base, updatedAt: t(5) } as Record<string, unknown>;
		delete older.assessments;
		const kept = JSON.parse(mergeFile({ path: "courses/c1.json", base: JSON.stringify(base), local: JSON.stringify(local), remote: JSON.stringify(older), prefer: "remote" }).content!) as CourseRecord;
		assert.deepEqual(live(kept).map((a) => a.id), ["as_new"]);
	});
});

// ─── the service and the routes ──────────────────────────────────────────────

describe("assessments: the service and the API", () => {
	beforeEach(reset);

	it("POST, PATCH and DELETE, with validation and a body cap; the old exam date becomes a real item when edited", async () => {
		const { courseId, a } = approvedCourse();
		const made = await listRoute.POST(json({ kind: "quiz", title: "Quiz 1", date: inDays(3), topics: "ch 1", skillIds: [a] }), params({ id: courseId }));
		assert.equal(made.status, 200);
		const quiz = ((await made.json()) as { assessment: Assessment }).assessment;
		assert.equal(quiz.source, "manual");
		for (const bad of [{ kind: "lecture", title: "x" }, { kind: "quiz", title: "" }, { kind: "quiz", title: "x", date: "soon" }, { kind: "quiz", title: "x", skillIds: ["sk_other"] }]) {
			assert.equal((await listRoute.POST(json(bad), params({ id: courseId }))).status, 400, JSON.stringify(bad));
		}
		assert.equal((await listRoute.POST(json({ kind: "quiz", title: "x", topics: "y".repeat(20_000) }), params({ id: courseId }))).status, 413);
		assert.equal((await listRoute.POST(json({ kind: "quiz", title: "x" }), params({ id: "course_nope" }))).status, 404);

		const patched = await itemRoute.PATCH(json({ date: null, topics: "ch 1-2" }, "PATCH"), params({ id: courseId, assessmentId: quiz.id }));
		assert.equal(patched.status, 200);
		assert.deepEqual([live(getCourse(courseId))[0]!.date, live(getCourse(courseId))[0]!.topics], [undefined, "ch 1-2"]);

		courses.setCourseExamDate(courseId, inDays(30));
		const view = (await (await listRoute.GET(new Request("http://x"), params({ id: courseId }))).json()) as UpcomingView;
		assert.ok(view.items.some((i) => i.id === A.LEGACY_EXAM_ID && i.legacy));
		const legacy = await itemRoute.PATCH(json({ title: "Final exam", topics: "everything" }, "PATCH"), params({ id: courseId, assessmentId: A.LEGACY_EXAM_ID }));
		assert.equal(legacy.status, 200);
		const after = getCourse(courseId);
		assert.equal(after.examDate, undefined, "the old field is cleared");
		assert.deepEqual(live(after).filter((x) => x.kind === "exam").map((x) => [x.title, x.date]), [["Final exam", inDays(30)]]);

		assert.equal((await itemRoute.DELETE(new Request("http://x"), params({ id: courseId, assessmentId: quiz.id }))).status, 200);
		assert.ok(A.readAssessmentEntries(getCourse(courseId).assessments).some((e) => e.id === quiz.id && A.isTombstone(e)), "a tombstone");
		assert.equal((await itemRoute.DELETE(new Request("http://x"), params({ id: courseId, assessmentId: quiz.id }))).status, 404);
	});

	it("the countdown, Today, the sidebar and the teacher read the next assessment; a passed exam still says passed", () => {
		const { courseId, a, b } = approvedCourse();
		courses.setCourseExamDate(courseId, inDays(40));
		assert.equal(courses.courseView(courseId)!.plan.examDate, inDays(40));
		const quiz = assess.createAssessment(courseId, { kind: "quiz", title: "Quiz 3", date: inDays(5), topics: "poles", skillIds: [b] });
		assert.ok(quiz.ok);
		const view = courses.courseView(courseId)!;
		assert.equal(view.plan.examDate, inDays(5));
		assert.equal(view.plan.daysLeft, 5);
		assert.deepEqual(view.plan.next && [view.plan.next.title, view.plan.next.skillIds], ["Quiz 3", [b]]);
		assert.equal(view.upcoming?.nextId, quiz.value.id);
		assert.equal(courses.listCourseSummaries().find((c) => c.id === courseId)?.examDate, inDays(5));
		assert.equal(courses.todayCourses().find((c) => c.courseId === courseId)?.daysLeft, 5);
		const learn = courses.createCourseSession(courseId, "learn", a);
		assert.ok(learn.ok);
		assert.match(courses.courseForTurn(learn.value.id)!.exam!, /^Quiz 3 \(quiz\), .*5 days left, covering poles$/);
		// only passed dates: the card says passed, as before
		courses.setCourseExamDate(courseId, inDays(-3));
		assess.deleteAssessment(courseId, quiz.value.id);
		assert.equal(courses.courseView(courseId)!.plan.forecast?.status, "past");
	});
});

// ─── priorities and review timing ────────────────────────────────────────────

describe("Next up and review timing follow the next assessment", () => {
	beforeEach(reset);

	it("orderNextUp: the next assessment's skills first, a skill the learner does not get first among its peers; without either, as before", () => {
		const p = new Map<string, SkillWeightValue>([["a", 1], ["b", 3], ["c", 0], ["d", 1]]);
		assert.deepEqual(plan.orderNextUp(["a", "b", "c", "d"], p), { nextUp: ["b", "a", "d"], notExamined: ["c"] });
		assert.deepEqual(plan.orderNextUp(["a", "b", "c", "d"], p, { focus: new Set(["d", "c"]) }), { nextUp: ["d", "c", "b", "a"], notExamined: [] }, "the quiz's skills first (by priority among them); a quiz examines c, so c is not 'not examined'");
		assert.deepEqual(plan.orderNextUp(["a", "b", "c", "d"], p, { needsWork: new Set(["d"]) }).nextUp, ["b", "d", "a"], "d leads its priority-1 peers, not the heavier b");
	});

	it("in the course view: a quiz mapped to a skill moves it to the front; the nearest dated one wins", () => {
		const { courseId, a, c } = approvedCourse();
		assert.deepEqual(courses.courseView(courseId)!.nextUp, [a, c], "topological order before");
		assess.createAssessment(courseId, { kind: "quiz", title: "Bode quiz", date: inDays(4), skillIds: [c] });
		assess.createAssessment(courseId, { kind: "quiz", title: "Laplace quiz", date: inDays(9), skillIds: [a] });
		assert.deepEqual(courses.courseView(courseId)!.nextUp, [c, a]);
		assert.equal(courses.courseView(courseId)!.plan.skillsLeft, 1, "the next quiz's own skills left");
	});

	it("a skill's review is timed for the nearest assessment that covers it, not for an unrelated one", () => {
		const { courseId, a, c } = approvedCourse();
		// both learned a day ago with a few days of stability
		practiceEvidence(courseId, a, Date.now() - DAY);
		practiceEvidence(courseId, c, Date.now() - DAY);
		const before = courses.courseView(courseId)!;
		assert.deepEqual(before.review, [], "nothing due without an assessment");
		// a quiz on c in 60 days (c's recall will have faded by then); nothing about a
		assess.createAssessment(courseId, { kind: "quiz", title: "Bode quiz", date: inDays(60), skillIds: [c] });
		const view = courses.courseView(courseId)!;
		assert.deepEqual(view.review, [c]);
		assert.equal(view.plan.reviewFading, 1);
		// a final over everything (no skills mapped) times every skill, as the old exam date did
		assess.createAssessment(courseId, { kind: "final", title: "Final", date: inDays(90) });
		assert.deepEqual(courses.courseView(courseId)!.review.sort(), [a, c].sort());
	});
});

// ─── the syllabus pass ───────────────────────────────────────────────────────

describe("Find quizzes and exams (the syllabus pass)", () => {
	beforeEach(reset);

	it("fillFound: citations, dates only with the syllabus's words, weeks resolved in code, nothing invented", () => {
		const mats = [{ id: "mat_s", name: "Syllabus.pdf", kind: "pdf" }];
		const sources = new Map([["mat_s", { kind: "pages" as const, pages: new Map([[1, "Term starts Monday 12 January 2026."], [2, "Quiz 1: **Friday 6 February**, chapter 1."], [3, "Midterm: Week 7, Friday. Final: TBA in the exam period. Quiz 3: week 3"]]) }]]);
		const out = fillFound(
			{
				summary: "Read the syllabus.",
				termStart: "2026-01-12",
				termStartText: "Monday 12 January 2026",
				termStartMaterial: "mat_s",
				termStartPage: 1,
				assessments: [
					{ kind: "quiz", title: "Quiz 1", date: "2026-02-06", dateText: "Friday 6 February", topics: "Ch 1", skills: ["sk_a"], material: "mat_s", page: 2 },
					{ kind: "midterm", title: "Midterm", week: 7, weekday: 5, dateText: "Week 7, Friday", topics: "Ch 1-4", skills: [], material: "mat_s", page: 3 },
					{ kind: "final", title: "Final", dateText: "TBA in the exam period", topics: "Everything", skills: [], material: "mat_s", page: 3 },
				],
			},
			mats,
			["sk_a"],
			sources,
		);
		assert.deepEqual(out.problems, []);
		assert.deepEqual(out.items.map((i) => [i.title, i.date, i.cite, i.quote]), [["Quiz 1", "2026-02-06", "Syllabus.pdf p. 2", "Friday 6 February"], ["Midterm", "2026-02-27", "Syllabus.pdf p. 3", "Week 7, Friday"], ["Final", undefined, "Syllabus.pdf p. 3", "TBA in the exam period"]]);
		assert.equal(out.items[2]!.topics, "Everything (when: TBA in the exam period)", "an unresolved date stays in the topics");
		const bad = fillFound(
			{ summary: "s", assessments: [
				{ kind: "quiz", title: "Q", date: "2026-02-06", dateText: "", topics: "", skills: ["sk_x"], material: "mat_s", page: 2 },
				{ kind: "quiz", title: "R", week: 3, weekday: 5, dateText: "week 3", topics: "", skills: [], material: "mat_nope" },
				{ kind: "quiz", title: "S", week: 3, weekday: 5, dateText: "week 3", topics: "", skills: [], material: "mat_s", page: 3 },
			] },
			mats,
			["sk_a"],
			sources,
		);
		assert.equal(bad.problems.length, 3, bad.problems.join(" | "));
		assert.match(bad.problems.join("\n"), /needs the syllabus's own words/);
		assert.match(bad.problems.join("\n"), /not an approved skill id/);
		assert.match(bad.problems.join("\n"), /not a material id/);
		assert.equal(bad.items.find((i) => i.title === "S")?.date, undefined, "a week with no term start gets no date");
	});

	it("a fake finder's result becomes a proposal; approve, drop, re-run without duplicates, the learner's edits win", async () => {
		const { courseId, a, b } = approvedCourse();
		const syllabus = addSyllabus(courseId);
		let calls = 0;
		const found = (items: Array<Omit<ProposedAssessment, "status" | "match">>) => {
			assess.setAssessmentFinderForTests(async () => {
				calls++;
				return { summary: "Read Syllabus.md.", items };
			});
		};
		const quiz1 = { key: "p1", kind: "quiz" as const, title: "Quiz 1", date: inDays(10), topics: "Ch 1", skillIds: [a], cite: "Syllabus.md p. 1" };
		const quiz2 = { key: "p2", kind: "quiz" as const, title: "Quiz 2", date: inDays(20), topics: "Ch 2", skillIds: [b], cite: "Syllabus.md p. 1" };
		const final = { key: "p3", kind: "final" as const, title: "Final", topics: "When: exam period", skillIds: [], cite: "Syllabus.md p. 2" };
		found([quiz1, quiz2, final]);
		assert.equal(courses.courseView(courseId)!.upcoming?.syllabusHint?.materialId, syllabus.id, "a syllabus-looking file is suggested");
		assert.equal((await findRoute.POST(new Request("http://x"), params({ id: courseId }))).status, 200);
		await waitFinding(courseId);
		let view = courses.courseView(courseId)!.upcoming!;
		assert.equal(view.syllabusHint, undefined, "suggested once: not after a pass");
		assert.deepEqual(view.proposal!.items.map((i) => [i.title, i.status, i.cite]), [["Quiz 1", "new", "Syllabus.md p. 1"], ["Quiz 2", "new", "Syllabus.md p. 1"], ["Final", "new", "Syllabus.md p. 2"]]);
		assert.deepEqual(live(getCourse(courseId)), [], "nothing written before approval");

		// every action names the proposal the page shows (review 1, finding 1)
		const pid = () => getCourse(courseId).assessmentProposal!.id;
		assert.match(pid()!, /^ap_/);
		assert.equal((await proposalRoute.POST(json({ action: "drop", key: "p2", proposalId: pid() }), params({ id: courseId }))).status, 200);
		assert.equal((await proposalRoute.POST(json({ action: "approve", proposalId: pid() }), params({ id: courseId }))).status, 200);
		const approved = live(getCourse(courseId));
		assert.deepEqual(approved.map((x) => [x.title, x.source, x.cite]).sort(), [["Final", "syllabus", "Syllabus.md p. 2"], ["Quiz 1", "syllabus", "Syllabus.md p. 1"]]);
		assert.equal(getCourse(courseId).assessmentProposal, undefined);

		// the learner edits Quiz 1; a re-run finds it again with another date, Quiz 2 again, and the Final unchanged
		const q1 = approved.find((x) => x.title === "Quiz 1")!;
		assess.updateAssessment(courseId, q1.id, { date: inDays(11) });
		found([{ ...quiz1, date: inDays(12) }, quiz2, final]);
		assert.ok(assess.startAssessmentFind(courseId).ok);
		await waitFinding(courseId);
		view = courses.courseView(courseId)!.upcoming!;
		assert.deepEqual(view.proposal!.items.map((i) => [i.title, i.status]), [["Quiz 1", "kept"], ["Quiz 2", "new"], ["Final", "same"]]);
		assert.equal((await proposalRoute.POST(json({ action: "approve", proposalId: pid() }), params({ id: courseId }))).status, 200);
		const after = live(getCourse(courseId));
		assert.equal(after.length, 3, "no duplicates");
		assert.equal(after.find((x) => x.title === "Quiz 1")!.date, inDays(11), "the learner's edit wins");

		// an approval with an edit makes that item the learner's own
		found([{ ...quiz2, key: "p9", title: "Quiz 4", date: inDays(30) }]);
		assert.ok(assess.startAssessmentFind(courseId).ok);
		await waitFinding(courseId);
		// the stored proposal keys its items afresh (p1..): the key the page shows is the stored one
		assert.deepEqual(getCourse(courseId).assessmentProposal!.items.map((i) => i.key), ["p1"]);
		assert.equal((await proposalRoute.POST(json({ action: "approve", keys: ["p1"], edits: { p1: { title: "Quiz 4 (take-home)" } }, proposalId: pid() }), params({ id: courseId }))).status, 200);
		assert.equal(live(getCourse(courseId)).find((x) => x.title === "Quiz 4 (take-home)")?.source, "manual");
		assert.equal(calls, 3);
	});

	it("no syllabus: an empty proposal that says so; a failing pass records why; no file: refused", async () => {
		const { courseId } = approvedCourse();
		assert.equal((await findRoute.POST(new Request("http://x"), params({ id: courseId }))).status, 400);
		addSyllabus(courseId, "Lecture 1.md");
		assess.setAssessmentFinderForTests(async () => ({ summary: "No material is a syllabus or schedule.", items: [] }));
		assert.ok(assess.startAssessmentFind(courseId).ok);
		await waitFinding(courseId);
		const view = courses.courseView(courseId)!.upcoming!;
		assert.deepEqual(view.proposal?.items, []);
		assert.match(view.proposal!.summary, /No material is a syllabus/);
		assess.setAssessmentFinderForTests(async () => {
			throw new Error("the syllabus pass never submitted its list");
		});
		assert.ok(assess.startAssessmentFind(courseId).ok);
		await waitFinding(courseId);
		assert.match(courses.courseView(courseId)!.upcoming!.error!, /never submitted/);
	});
});

// ─── Short question turns ────────────────────────────────────────────────────

describe("Short question writes what the learner states", () => {
	beforeEach(reset);

	it("offers the class tools (self-reports only with a skill map) and tells the prompt today's date", () => {
		const { courseId } = approvedCourse();
		const chatId = askChat(courseId);
		const tools = classFactsTools(changes.classFactsPort(chatId)!);
		// WP9 added the rest of the class page's edits (tests/where-you-stand.test.tsx pins those)
		assert.deepEqual(
			Object.keys(tools).filter((n) => !["lectures_list", "lecture_save", "lecture_remove", "class_position_set", "skill_weights_set", "class_update", "class_overview"].includes(n)).sort(),
			["assessment_remove", "assessment_save", "assessments_find_in_syllabus", "assessments_list", "record_self_report"],
		);
		for (const name of Object.keys(tools)) assert.ok((ASK_TOOL_NAMES as readonly string[]).includes(name), name);
		const bare = courseStore.createCourse("No map");
		const early = askChat(bare.id);
		assert.ok(!("record_self_report" in classFactsTools(changes.classFactsPort(early)!)));
		const agent = createAskAgent({ classFacts: tools }, { engine: scripted([]) });
		assert.match(agent.state.systemPrompt, /## Quizzes and exams the learner tells you about/);
		assert.match(agent.state.systemPrompt, /## What the learner says they know/);
		assert.match(agent.state.systemPrompt, /<today>\nToday is \w+day \d{4}-\d{2}-\d{2}\.\n<\/today>/);
		const plain = askSystemPrompt({ caps: { tools: ["material_search"], sources: { pdf: true, other: false, notes: false } } });
		assert.doesNotMatch(plain, /Quizzes and exams the learner|<today>/, "without the tools: no fragment, no date");
		assert.equal(changes.classFactsPort("chat_nope"), null);
	});

	it("\"quiz 3 is next Friday on chapters 4 and 5\": saved at once, the date resolved, shown as a card; Undo removes it", async () => {
		const { courseId, b } = approvedCourse();
		const chatId = askChat(courseId);
		// "next Friday" is ambiguous on some weekdays (review 1, finding 3: tested with a fixed day below); "Friday next
		// week" resolves on every day
		await runTurn(
			chatId,
			"Quiz 3 is Friday next week and covers chapters 4 and 5 (poles).",
			scripted([
				fauxAssistantMessage([fauxToolCall("assessment_save", { kind: "quiz", title: "Quiz 3", date: "Friday next week", topics: "chapters 4 and 5", skillIds: [b] }, { id: "save1" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText("Saved Quiz 3 for Friday.")]),
			]),
		);
		const saved = live(getCourse(courseId));
		assert.equal(saved.length, 1);
		assert.deepEqual([saved[0]!.title, saved[0]!.kind, saved[0]!.date, saved[0]!.topics, saved[0]!.skillIds, saved[0]!.source], ["Quiz 3", "quiz", A.resolveDateText("Friday next week", Date.now()), "chapters 4 and 5", [b], "chat"]);
		assert.equal(new Date(`${saved[0]!.date}T12:00:00`).getDay(), 5, "a Friday");
		const result = toolResults(chatId).find((r) => r.toolCallId === "save1")!;
		assert.equal(result.isError, false);
		assert.equal((result.details as { change: { action: string } }).change.action, "added");
		assert.ok(partShows({ type: "tool-assessment_save", state: "output-available" }), "the card shows");
		assert.deepEqual((await (await changesRoute.GET(new Request("http://x"), params({ id: chatId }))).json()) as Record<string, string>, { save1: "applied" });
		// Undo reverts exactly that change, once
		assert.equal((await undoRoute.POST(new Request("http://x"), params({ id: chatId, toolCallId: "save1" }))).status, 200);
		assert.deepEqual(live(getCourse(courseId)), []);
		assert.deepEqual((await (await changesRoute.GET(new Request("http://x"), params({ id: chatId }))).json()) as Record<string, string>, { save1: "changed" });
		assert.equal((await undoRoute.POST(new Request("http://x"), params({ id: chatId, toolCallId: "save1" }))).status, 409);
		assert.equal((await undoRoute.POST(new Request("http://x"), params({ id: chatId, toolCallId: "nope" }))).status, 404);
	});

	it("a removal, and Undo brings it back; a change Undo would clobber is refused", async () => {
		const { courseId } = approvedCourse();
		const made = assess.createAssessment(courseId, { kind: "quiz", title: "Quiz 2", date: inDays(6) });
		assert.ok(made.ok);
		const chatId = askChat(courseId);
		await runTurn(
			chatId,
			"Quiz 2 is cancelled.",
			scripted([
				fauxAssistantMessage([fauxToolCall("assessment_remove", { id: made.value.id }, { id: "rm1" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText("Removed Quiz 2.")]),
			]),
		);
		assert.deepEqual(live(getCourse(courseId)), []);
		assert.equal((await undoRoute.POST(new Request("http://x"), params({ id: chatId, toolCallId: "rm1" }))).status, 200);
		assert.deepEqual(live(getCourse(courseId)).map((x) => [x.id, x.title, x.date]), [[made.value.id, "Quiz 2", inDays(6)]]);
		// an update, then the learner edits the item on the page: Undo on the chat's card is refused
		await runTurn(
			chatId,
			"Actually it moved to tomorrow.",
			scripted([
				fauxAssistantMessage([fauxToolCall("assessment_save", { id: made.value.id, date: "tomorrow" }, { id: "up1" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText("Moved.")]),
			]),
		);
		assert.equal(live(getCourse(courseId))[0]!.date, inDays(1));
		assess.updateAssessment(courseId, made.value.id, { topics: "ch 3" });
		assert.equal((await undoRoute.POST(new Request("http://x"), params({ id: chatId, toolCallId: "up1" }))).status, 409);
		assert.equal(live(getCourse(courseId))[0]!.topics, "ch 3");
	});

	it("ambiguous: two items match, or a new one has no date: nothing is written and the agent is told to ask", async () => {
		const { courseId } = approvedCourse();
		assess.createAssessment(courseId, { kind: "quiz", title: "Quiz 3", date: inDays(3) });
		assess.createAssessment(courseId, { kind: "quiz", title: "Quiz #3", date: inDays(10) });
		const before = JSON.stringify(getCourse(courseId).assessments);
		const chatId = askChat(courseId);
		await runTurn(
			chatId,
			"Quiz 3 covers chapter 6.",
			scripted([
				fauxAssistantMessage([fauxToolCall("assessment_save", { kind: "quiz", title: "Quiz 3", topics: "chapter 6" }, { id: "amb" }), fauxToolCall("assessment_save", { kind: "midterm", title: "Midterm" }, { id: "nodate" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText("Which Quiz 3 do you mean, the one in 3 days or in 10? And when is the midterm?")]),
			]),
		);
		assert.equal(JSON.stringify(getCourse(courseId).assessments), before, "nothing written");
		const results = toolResults(chatId);
		assert.match(results.find((r) => r.toolCallId === "amb")!.content[0]!.text!, /^Ambiguous: 2 assessments match[\s\S]*Ask the learner which/);
		assert.match(results.find((r) => r.toolCallId === "nodate")!.content[0]!.text!, /^No date for "Midterm"[\s\S]*Ask the learner when it is/);
		assert.ok(results.every((r) => r.isError));
		assert.equal(partShows({ type: "tool-assessment_save", state: "output-error" }), false, "a refused call shows no card");
		const last = chatStore.getChat(chatId)!.messages.at(-1) as unknown as { content: Array<{ text?: string }> };
		assert.match(last.content.map((c) => c.text ?? "").join(""), /Which Quiz 3/);
		// a date it cannot read is refused too
		const port = changes.classFactsPort(chatId)!;
		const save = classFactsTools(port).assessment_save!;
		const refused = (await save.execute("x", { kind: "quiz", title: "Quiz 9", date: "after the break" }, undefined as never)) as { isError?: boolean; content: Array<{ text: string }> };
		assert.equal(refused.isError, true);
		assert.match(refused.content[0]!.text, /Could not read the date "after the break"/);
	});
});

// ─── self-reports ────────────────────────────────────────────────────────────

describe("self-reports: the rule", () => {
	const T = Date.UTC(2026, 10, 25, 12);
	const ev = (skillId: string, at: number) => ({ skillId, at, outcome: "solved" as const });

	it("know: an unlearned skill becomes learned with low stability (due soon); a learned one is unchanged", () => {
		const out = mastery.applySelfReports(new Map(), [{ id: "r1", at: T, skillIds: ["a"], stance: "know" }], []);
		const s = out.states.get("a")!;
		assert.equal(s.stability, mastery.SELF_KNOW_DAYS);
		assert.equal(s.lastReview, T);
		assert.ok(!mastery.needsReview(s, T + DAY) && mastery.needsReview(s, T + 3 * DAY), "a short check falls due within days");
		assert.ok(mastery.understandingOf(s) < 3 && !mastery.isKnown(s));
		const held = { stability: 30, difficulty: 5, lastReview: T - DAY };
		assert.deepEqual(mastery.applySelfReports(new Map([["a", held]]), [{ id: "r1", at: T, skillIds: ["a"], stance: "know" }], []).states.get("a"), held);
	});

	it("shaky: the review falls due twice as soon from the report, nothing else changes; dont_know: due now, or first in Next up", () => {
		const held = { stability: 10, difficulty: 5, lastReview: T - 2 * DAY };
		const shaky = mastery.applySelfReports(new Map([["a", held]]), [{ id: "r", at: T, skillIds: ["a"], stance: "shaky" }], []).states.get("a")!;
		assert.equal(shaky.stability, held.stability);
		assert.equal(mastery.reviewAt(shaky), T + 4 * DAY, "8 days left become 4");
		const dont = mastery.applySelfReports(new Map([["a", held]]), [{ id: "r", at: T, skillIds: ["a", "b"], stance: "dont_know" }], []);
		assert.ok(mastery.needsReview(dont.states.get("a")!, T + 1), "a learned skill is due from the report on");
		assert.ok(!dont.states.has("b") && dont.needsWork.has("b"), "an unlearned one stays unlearned and needs work");
		assert.equal(mastery.applySelfReports(new Map(), [{ id: "r", at: T, skillIds: ["b"], stance: "shaky" }], []).states.has("b"), false);
	});

	it("real evidence at or after the report overrides it; the newest report counts", () => {
		const reports = [{ id: "old", at: T - DAY, skillIds: ["a"], stance: "dont_know" as const }, { id: "new", at: T, skillIds: ["a"], stance: "know" as const }];
		assert.equal(mastery.applySelfReports(new Map(), reports, []).active.get("a")?.id, "new");
		const overridden = mastery.applySelfReports(new Map(), reports, [ev("a", T + 1000)]);
		assert.equal(overridden.active.size, 0);
		assert.equal(overridden.states.has("a"), false, "only the fold's own state remains (none here)");
		assert.equal(mastery.applySelfReports(new Map(), reports, [ev("a", T - 2 * DAY)]).active.get("a")?.id, "new", "older evidence does not");
	});
});

describe("self-reports: through Short question, the page and sync", () => {
	beforeEach(reset);

	it("know / shaky / dont_know through a turn; the view, Next up and the marker; Undo; a real result overrides", async () => {
		const { courseId, a, b, c } = approvedCourse();
		const chatId = askChat(courseId);
		await runTurn(
			chatId,
			"I already know Laplace transforms, but I don't get Bode plots.",
			scripted([
				fauxAssistantMessage(
					[
						fauxToolCall("record_self_report", { skillIds: [a], stance: "know", note: "I already know Laplace transforms" }, { id: "k1" }),
						fauxToolCall("record_self_report", { skillIds: [c], stance: "dont_know", note: "I don't get Bode plots" }, { id: "d1" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage([fauxText("Noted both.")]),
			]),
		);
		let view = courses.courseView(courseId)!;
		const sa = view.skills.find((s) => s.id === a)!;
		assert.equal(sa.learned, true);
		assert.equal(sa.stability, mastery.SELF_KNOW_DAYS);
		assert.equal(sa.selfReport?.stance, "know");
		assert.equal(sa.selfReport?.chatId, chatId);
		assert.ok(!view.contextCheck.includes(a), "this class's own report, not 'from another course'");
		assert.ok(!view.nextUp.includes(a), "it left Next up");
		assert.equal(view.nextUp[0], c, "the skill the learner does not get leads");
		assert.equal(view.skills.find((s) => s.id === c)!.selfReport?.stance, "dont_know");
		// Undo the know: the skill is back to unlearned
		assert.equal((await undoRoute.POST(new Request("http://x"), params({ id: chatId, toolCallId: "k1" }))).status, 200);
		view = courses.courseView(courseId)!;
		assert.equal(view.skills.find((s) => s.id === a)!.learned, false);
		assert.equal(view.skills.find((s) => s.id === a)!.selfReport, undefined);
		// a real graded result after the report overrides it: the marker goes, the state is the evidence's
		practiceEvidence(courseId, c, Date.now() + 5_000, "hard");
		view = courses.courseView(courseId)!;
		const sc = view.skills.find((s) => s.id === c)!;
		assert.equal(sc.selfReport, undefined);
		assert.equal(sc.learned, true);
		// the page's Remove (a tombstone), on a skill with no evidence since
		const shaky = assess.recordSelfReport(courseId, { skillIds: [b], stance: "shaky" });
		assert.ok(shaky.ok);
		assert.equal(courses.courseView(courseId)!.skills.find((s) => s.id === b)!.selfReport?.stance, "shaky");
		assert.equal(courses.courseView(courseId)!.skills.find((s) => s.id === b)!.learned, false, "shaky changes no learned status");
		assert.equal((await reportRoute.DELETE(new Request("http://x"), params({ id: courseId, reportId: shaky.value.id }))).status, 200);
		assert.equal(courses.courseView(courseId)!.skills.find((s) => s.id === b)!.selfReport, undefined);
		assert.equal((await reportRoute.DELETE(new Request("http://x"), params({ id: courseId, reportId: shaky.value.id }))).status, 404);
	});

	it("refuses skills off the approved map; deleting the Ask chat keeps the report (and costs no progress)", async () => {
		const { courseId, b } = approvedCourse();
		const chatId = askChat(courseId);
		const port = changes.classFactsPort(chatId)!;
		assert.equal(port.selfReport({ skillIds: ["sk_stranger"], stance: "know", note: "" }).ok, false);
		assert.equal(port.selfReport({ skillIds: [b], stance: "maybe", note: "" }).ok, false);
		assert.ok(port.selfReport({ skillIds: [b], stance: "dont_know", note: "poles confuse me" }).ok);
		assert.deepEqual(courses.courseDeletionImpact([chatId]), { sessions: 0, courses: [], skills: 0 }, "an Ask chat records no evidence");
		chatStore.deleteChat(chatId);
		const reports = A.liveSelfReports(getCourse(courseId).selfReports);
		assert.deepEqual(reports.map((r) => [r.stance, r.chatId, r.note]), [["dont_know", chatId, "poles confuse me"]]);
		assert.equal(courses.courseView(courseId)!.skills.find((s) => s.id === b)!.selfReport?.stance, "dont_know");
	});

	it("sync: reports merge per item; a removal on one device survives", () => {
		const t = (h: number) => `2026-11-25T${String(h).padStart(2, "0")}:00:00.000Z`;
		const r = (id: string, h: number): SelfReport => ({ id, at: t(h), skillIds: ["sk_a"], stance: "know", note: "", updatedAt: t(h) });
		const base = { id: "c1", title: "T", createdAt: t(1), updatedAt: t(1), status: "active", skills: ["sk_a"], selfReports: [r("sr_1", 1)], version: 1 };
		const local = { ...base, updatedAt: t(3), selfReports: [{ id: "sr_1", deleted: true, updatedAt: t(3) }] };
		const remote = { ...base, updatedAt: t(2), selfReports: [r("sr_1", 1), r("sr_2", 2)] };
		const merged = JSON.parse(mergeFile({ path: "courses/c1.json", base: JSON.stringify(base), local: JSON.stringify(local), remote: JSON.stringify(remote), prefer: "remote" }).content!) as CourseRecord;
		assert.deepEqual(A.liveSelfReports(merged.selfReports).map((x) => x.id), ["sr_2"]);
	});
});

// ─── isolation ───────────────────────────────────────────────────────────────

describe("isolation: an Ask conversation is still never graded evidence and never feeds the graph", () => {
	beforeEach(reset);

	it("a turn that saves an assessment and a self-report adds no skill event, rating or graph node", async () => {
		const { courseId, a } = approvedCourse();
		const chatId = askChat(courseId);
		const nodesBefore = graphStore.readNodes().length;
		await runTurn(
			chatId,
			"I know Laplace. Quiz 1 is tomorrow.",
			scripted([
				fauxAssistantMessage([fauxToolCall("record_self_report", { skillIds: [a], stance: "know", note: "I know Laplace" }, { id: "k" }), fauxToolCall("assessment_save", { kind: "quiz", title: "Quiz 1", date: "tomorrow" }, { id: "s" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText("Noted, and saved Quiz 1.")]),
			]),
		);
		const chat = chatStore.getChat(chatId)!;
		assert.deepEqual(mastery.skillEventsOf(chat.messages, chat.course!), []);
		assert.equal(courses.ratingChanges(chatId), null);
		assert.equal(graphStore.readNodes().length, nodesBefore);
		assert.equal(chat.extractions?.length ?? 0, 0, "no extraction ran");
		assert.equal(chatStore.listChats().find((x) => x.id === chatId)?.finished, undefined);
	});
});

// ─── the class page ──────────────────────────────────────────────────────────

describe("the class page: the Upcoming list in each state", () => {
	const NOW = new Date(2026, 10, 25, 12).getTime();
	const item = (over: Partial<Assessment> = {}): Assessment => ({ id: "as_1", kind: "quiz", title: "Quiz 3", date: "2026-12-04", topics: "chapters 4 and 5", skillIds: ["sk_p"], source: "chat", updatedAt: "2026-11-25T10:00:00.000Z", ...over });
	const view = (over: Partial<UpcomingView> = {}): UpcomingView => ({ items: [], finding: false, ...over });
	const render = (upcoming: UpcomingView, canFind = true) => renderToStaticMarkup(<UpcomingList courseId="course_1" upcoming={upcoming} skills={[{ id: "sk_p", name: "Poles" }]} canFind={canFind} onChanged={() => {}} now={NOW} />);

	it("countdown and grouping helpers", () => {
		assert.deepEqual(["2026-11-25", "2026-11-26", "2026-12-04", "2026-11-20"].map((d) => countdownLabel(d, NOW)), ["today", "tomorrow", "in 9 d", "passed"]);
		const rows = upcomingRows([item({ id: "p", date: "2026-11-01" }), item({ id: "u", date: undefined }), item({ id: "n" })], NOW);
		assert.deepEqual([rows.coming.map((a) => a.id), rows.undated.map((a) => a.id), rows.past.map((a) => a.id)], [["n"], ["u"], ["p"]]);
	});

	it("empty: says how to add one, Find in syllabus (off without a file)", () => {
		const html = render(view());
		assert.match(html, /data-testid="upcoming"[\s\S]*Upcoming/);
		assert.match(html, /data-testid="upcoming-empty"[^>]*>No quizzes or exams yet\. Add one, find them in the syllabus, or tell Short question\./);
		assert.match(html, /data-testid="upcoming-add"/);
		assert.match(render(view(), false), /<button[^>]*disabled=""[^>]*data-testid="upcoming-find"/);
	});

	it("items: the next one marked, date with countdown, kind, topics and skills; undated; past folded", () => {
		const html = render(view({ items: [item(), item({ id: "as_2", title: "Final", kind: "final", date: undefined, topics: "", skillIds: [] }), item({ id: "as_0", title: "Quiz 1", date: "2026-11-01" })], nextId: "as_1" }));
		assert.match(html, /data-testid="upcoming-item-as_1"[\s\S]*aria-label="next"[\s\S]*Quiz 3[\s\S]*4 Dec 2026 · in 9 d[\s\S]*Quiz · chapters 4 and 5 · Poles/);
		assert.match(html, /data-testid="upcoming-when-as_2"[^>]*>no date</);
		assert.match(html, /data-testid="upcoming-past-toggle"[^>]*>Past · 1</);
		assert.doesNotMatch(html, /upcoming-item-as_0/, "past items folded");
	});

	it("finding, failure, a syllabus hint, and the proposal with citations and its actions", () => {
		assert.match(render(view({ finding: true })), /data-testid="upcoming-finding"[\s\S]*Reading the syllabus…/);
		assert.doesNotMatch(render(view({ finding: true })), /upcoming-find"/, "no second start while running");
		assert.match(render(view({ error: "no model" })), /Finding failed: no model/);
		assert.match(render(view({ syllabusHint: { materialId: "mat_s", name: "Syllabus.pdf" } })), /data-testid="upcoming-syllabus-hint"[\s\S]*Syllabus\.pdf[\s\S]*looks like a syllabus[\s\S]*Find quizzes and exams/);
		const proposal: AssessmentProposal = {
			createdAt: "t",
			summary: "Read Syllabus.pdf.",
			items: [
				{ key: "p1", kind: "quiz", title: "Quiz 1", date: "2026-12-01", topics: "Ch 1", skillIds: [], cite: "Syllabus.pdf p. 2", status: "new" },
				{ key: "p2", kind: "final", title: "Final", topics: "When: exam period", skillIds: [], cite: "Syllabus.pdf p. 3", status: "new" },
				{ key: "p3", kind: "quiz", title: "Quiz 3", date: "2026-12-04", topics: "", skillIds: [], cite: "Syllabus.pdf p. 2", status: "kept", match: "as_1" },
			],
		};
		const html = render(view({ items: [item()], proposal }));
		assert.match(html, /data-testid="upcoming-proposal"[\s\S]*From the syllabus · 2 to add[\s\S]*Read Syllabus\.pdf\. 1 already in your list\./);
		assert.match(html, /data-testid="proposal-item-p1"[\s\S]*Quiz 1[\s\S]*data-testid="proposal-cite-p1"[^>]*>Syllabus\.pdf p\. 2</);
		assert.match(html, /data-testid="proposal-item-p2"[\s\S]*no date[\s\S]*When: exam period/);
		assert.doesNotMatch(html, /proposal-item-p3/, "the learner's own item is not offered again");
		assert.match(html, /data-testid="proposal-drop-p1"/);
		assert.match(html, /data-testid="proposal-approve"[^>]*>Add all 2</);
		assert.match(html, /data-testid="proposal-discard"[^>]*>Discard</);
	});

	it("the side panel holds Upcoming instead of the exam-date field", () => {
		const files: MaterialsApi = { materials: [], draft: [], reading: 0, busy: false, error: null, clearError: () => {}, addFiles: async () => {}, addUrl: async () => true, remove: async () => {}, pickFiles: () => {}, camera: { available: false, open: () => {} }, node: null };
		const html = renderToStaticMarkup(
			<InteractionLayersProvider>
				<ClassPanel courseId="course_1" courseTitle="Signals" pace={undefined} files={files} hasSkills hasDraft={false} drafting={false} error={null} busy={false} onDraft={() => {}} onPlacement={() => {}} onDeleted={() => {}} exam={{ examDate: "2026-12-14", hasWeights: false, weighing: false, canWeigh: true }} upcoming={view({ items: [item()] })} />
			</InteractionLayersProvider>,
		);
		assert.match(html, /data-testid="course-curriculum"[\s\S]*data-testid="upcoming"[\s\S]*data-testid="class-settings"/);
		assert.doesNotMatch(html, /data-testid="course-exam-date"/, "the single date field is gone");
	});

	it("the transcript card: what changed, its date and topics, Undo while it still holds", () => {
		const after = item();
		const added = { kind: "assessment" as const, courseId: "c", action: "added" as const, before: null, after, skillNames: ["Poles"] };
		assert.deepEqual(classChangeLines(added), { eyebrow: "Added · Quiz", title: "Quiz 3", lines: ["Fri 4 Dec 2026", "chapters 4 and 5", "Skills: Poles"] });
		const moved = { ...added, action: "updated" as const, before: item({ date: "2026-12-01" }) };
		assert.equal(classChangeLines(moved).lines[0], "Fri 4 Dec 2026 (was Tue 1 Dec 2026)");
		const html = renderToStaticMarkup(<ClassChangeView change={added} status="applied" onUndo={() => {}} />);
		assert.match(html, /data-testid="class-change"[\s\S]*Added · Quiz[\s\S]*Quiz 3[\s\S]*data-testid="class-change-undo"[^>]*>Undo</);
		const changed = renderToStaticMarkup(<ClassChangeView change={added} status="changed" onUndo={() => {}} />);
		assert.doesNotMatch(changed, /class-change-undo/);
		assert.match(changed, /undone or changed since/);
		const report = { kind: "self-report" as const, courseId: "c", report: { stance: "dont_know" as const, note: "", at: "t" }, skillNames: ["Bode"] };
		assert.match(renderToStaticMarkup(<ClassChangeView change={report} status="applied" onUndo={() => {}} />), /Noted[\s\S]*Don&#x27;t get yet: Bode/);
	});
});

// ─── review 1 (2026-11-25): one regression per finding ──────────────────────

const finder = await import("../src/agent/subagents/assessment-finder.ts");
const { composerPlaceholder } = await import("../components/composer.tsx");
const { removeSelfReport } = await import("../components/course-page.tsx");
const { proposalBody } = await import("../components/upcoming-list.tsx");

describe("review 1 fixes", () => {
	beforeEach(reset);

	/** Park a proposal on the course as a pass would (through the injected finder). */
	async function propose(courseId: string, items: Array<Omit<ProposedAssessment, "status" | "match" | "matchStamp">>) {
		if (materialStore.list(courseId).length === 0) addSyllabus(courseId);
		assess.setAssessmentFinderForTests(async () => ({ summary: "Read the syllabus.", items }));
		assert.ok(assess.startAssessmentFind(courseId).ok);
		await waitFinding(courseId);
		return getCourse(courseId).assessmentProposal!;
	}

	it("1: an action names the proposal it was shown; another proposal (a second pass, a sync) is refused with 409", async () => {
		const { courseId } = approvedCourse();
		const first = await propose(courseId, [{ key: "p1", kind: "quiz", title: "Quiz 1", date: inDays(5), topics: "", skillIds: [], cite: "Syllabus.md" }]);
		const second = await propose(courseId, [{ key: "p1", kind: "exam", title: "Final", date: inDays(50), topics: "", skillIds: [], cite: "Syllabus.md" }]);
		assert.notEqual(first.id, second.id);
		// the tab still shows the first proposal: approve, drop and discard are all refused, nothing written
		for (const action of [{ action: "approve" }, { action: "drop", key: "p1" }, { action: "discard" }]) {
			const res = await proposalRoute.POST(new Request("http://x", { method: "POST", body: proposalBody(first, action) }), params({ id: courseId }));
			assert.equal(res.status, 409, JSON.stringify(action));
		}
		assert.equal((await proposalRoute.POST(json({ action: "approve" }), params({ id: courseId }))).status, 409, "no proposal named: refused");
		assert.deepEqual(live(getCourse(courseId)), []);
		assert.equal(getCourse(courseId).assessmentProposal?.id, second.id);
		// what every action of the list sends (components/upcoming-list.tsx; a 409 there refreshes the page)
		assert.deepEqual(JSON.parse(proposalBody(second, { action: "approve" })), { action: "approve", proposalId: second.id });
		assert.equal((await proposalRoute.POST(new Request("http://x", { method: "POST", body: proposalBody(second, { action: "approve" }) }), params({ id: courseId }))).status, 200);
		assert.deepEqual(live(getCourse(courseId)).map((a) => a.title), ["Final"]);
	});

	it("2: a date needs the cited page to hold the quote and the quote to state it; a week needs an anchored term start", () => {
		const mats = [{ id: "mat_s", name: "Syllabus.pdf", kind: "pdf" }, { id: "mat_t", name: "Plan.md", kind: "text" }];
		const sources = new Map<string, import("../src/agent/subagents/assessment-finder.ts").MaterialSource>([
			["mat_s", { kind: "pages", pages: new Map([[1, "Quiz 1: TBA"], [2, "Midterm: Week 7, Friday"]]) }],
			["mat_t", { kind: "text", text: "Week 1 starts on 12 January 2026." }],
		]);
		const fill = (assessments: Parameters<typeof fillFound>[0]["assessments"], extra: Partial<Parameters<typeof fillFound>[0]> = {}) => fillFound({ summary: "s", assessments, ...extra }, mats, [], sources);
		// a contradictory quote: a valid date paired with "TBA" (which IS on the page) keeps no date, and the words stay
		const tba = fill([{ kind: "quiz", title: "Quiz 1", date: "2026-02-06", dateText: "TBA", topics: "", skills: [], material: "mat_s", page: 1 }]);
		assert.deepEqual(tba.problems, []);
		assert.equal(tba.items[0]!.date, undefined);
		assert.equal(tba.items[0]!.topics, "When: TBA");
		// a wrong page: the quote is not on page 1; a page the PDF does not have; a PDF citation with no page
		assert.match(fill([{ kind: "midterm", title: "Midterm", week: 7, weekday: 5, dateText: "Week 7, Friday", topics: "", skills: [], material: "mat_s", page: 1 }]).problems.join(), /is not on the cited page 1/);
		assert.match(fill([{ kind: "quiz", title: "Quiz 1", dateText: "TBA", topics: "", skills: [], material: "mat_s", page: 9 }]).problems.join(), /page 9 is not in that material/);
		assert.match(fill([{ kind: "quiz", title: "Quiz 1", dateText: "TBA", topics: "", skills: [], material: "mat_s" }]).problems.join(), /needs the page/);
		// a missing anchor: a model-supplied term start with no quote dates nothing
		const midterm = { kind: "midterm", title: "Midterm", week: 7, weekday: 5, dateText: "Week 7, Friday", topics: "", skills: [], material: "mat_s", page: 2 };
		const unanchored = fill([midterm], { termStart: "2026-01-12" });
		assert.match(unanchored.problems.join(), /termStart needs termStartText/);
		assert.equal(unanchored.items[0]!.date, undefined);
		// a term start whose quote states another date: no date either
		const wrong = fill([midterm], { termStart: "2026-01-19", termStartText: "Week 1 starts on 12 January 2026", termStartMaterial: "mat_t" });
		assert.deepEqual(wrong.problems, []);
		assert.equal(wrong.items[0]!.date, undefined);
		// anchored: the week resolves in code
		const anchored = fill([midterm], { termStart: "2026-01-12", termStartText: "Week 1 starts on 12 January 2026", termStartMaterial: "mat_t" });
		assert.equal(anchored.items[0]!.date, "2026-02-27");
		// the quote check itself
		assert.ok(finder.quoteStatesDate("Friday 6 February", "2026-02-06"));
		assert.ok(finder.quoteStatesDate("fredag 6. februar", "2026-02-06"));
		assert.ok(finder.quoteStatesDate("20/2", "2026-02-20"), "a numeric date that reads one way only");
		assert.ok(finder.quoteStatesDate("Feb 6th", "2026-02-06"));
		assert.ok(!finder.quoteStatesDate("Friday 13 February", "2026-02-06"));
		assert.ok(!finder.quoteStatesDate("6 February 2025", "2026-02-06"), "another year");
		// a source this device cannot read gives no date and no problem
		const elsewhere = fillFound({ summary: "s", assessments: [{ kind: "quiz", title: "Q", date: "2026-02-06", dateText: "6 February", topics: "", skills: [], material: "mat_s", page: 1 }] }, mats, [], new Map([["mat_s", null]]));
		assert.deepEqual([elsewhere.problems, elsewhere.items[0]!.date], [[], undefined]);
	});

	it("3: the date rule, in the learner's time zone; \"next <weekday>\" in this week asks which", async () => {
		const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
		const read = (text: string, now: number, tz?: string) => A.readLearnerDate(text, now, tz);
		const wed = at(2026, 11, 25);
		const fri = at(2026, 11, 27);
		const sat = at(2026, 11, 28);
		assert.deepEqual(read("next Friday", wed), { kind: "ambiguous", options: ["2026-11-27", "2026-12-04"] });
		assert.deepEqual(read("next Friday", sat), { kind: "date", date: "2026-12-04" }, "the coming Friday is in next week: no doubt");
		assert.deepEqual(read("next Friday", fri), { kind: "date", date: "2026-12-04" });
		assert.deepEqual(read("this Friday", fri), { kind: "date", date: "2026-11-27" }, "\"this Friday\" on a Friday is today");
		assert.deepEqual(read("this Friday", wed), { kind: "date", date: "2026-11-27" });
		assert.deepEqual(read("Friday", wed), { kind: "date", date: "2026-11-27" });
		assert.deepEqual(read("neste fredag", wed), { kind: "ambiguous", options: ["2026-11-27", "2026-12-04"] });
		assert.deepEqual(read("25 November", wed), { kind: "date", date: "2026-11-25" }, "a yearless date: the next occurrence, today included");
		assert.deepEqual(read("24 November", wed), { kind: "date", date: "2027-11-24" });
		// the time zone: 05:00 UTC on Thu 26 Nov is still Wednesday evening in Los Angeles
		const utcMorning = Date.UTC(2026, 10, 26, 5);
		assert.equal(A.todayIn(utcMorning, "America/Los_Angeles"), "2026-11-25");
		assert.equal(A.todayIn(utcMorning, "Europe/Oslo"), "2026-11-26");
		assert.deepEqual(read("tomorrow", utcMorning, "America/Los_Angeles"), { kind: "date", date: "2026-11-26" });
		assert.deepEqual(read("tomorrow", utcMorning, "Europe/Oslo"), { kind: "date", date: "2026-11-27" });
		assert.equal(A.todayLine(utcMorning, "America/Los_Angeles").weekday, "Wednesday");
		assert.equal(A.cleanTimeZone("Mars/Olympus"), undefined);
		// the tool refuses the ambiguous date and tells the agent the question to ask, naming both dates
		const { courseId } = approvedCourse();
		const chatId = askChat(courseId);
		const port = changes.classFactsPort(chatId)!;
		const save = classFactsTools({ ...port, now: () => wed, timeZone: () => undefined }).assessment_save!;
		const out = (await save.execute("x", { kind: "quiz", title: "Quiz 3", date: "next Friday" }, undefined as never)) as { isError?: boolean; content: Array<{ text: string }> };
		assert.equal(out.isError, true);
		assert.match(out.content[0]!.text, /"Friday 27 Nov or Friday 4 Dec\?"/);
		assert.deepEqual(live(getCourse(courseId)), [], "nothing saved");
		// the browser's time zone rides the chat request and reaches the class tools and the prompt
		const req = new Request("http://test/api/chat", { method: "POST", headers: { "Content-Type": "application/json", "X-LH-Time-Zone": "America/Los_Angeles" }, body: JSON.stringify({ chatId, input: { type: "text", text: "hi" } }) });
		const ack = await handleChatRequest(req, (opts) => createAskAgent({ classFacts: classFactsTools(changes.classFactsPort(chatId)!) }, { ...opts, engine: scripted([fauxAssistantMessage([fauxText("Hi.")])]) }));
		assert.equal(ack.status, 200);
		const handle = runningTurn(chatId);
		if (handle) await new Response(handle.subscribe()).text();
		assert.equal(assess.learnerTimeZone(chatId), "America/Los_Angeles");
		assert.equal(changes.classFactsPort(chatId)!.timeZone(), "America/Los_Angeles");
		assert.match(askSystemPrompt({ caps: { tools: ["assessment_save"], sources: { pdf: false, other: false, notes: false } }, now: utcMorning, timeZone: "America/Los_Angeles" }), /Today is Wednesday 2026-11-25\./);
	});

	it("re-check 1: day and month stand together; a cleared exam date keeps a removal card stale; a weekday said on that day asks; skipped approvals are counted", async () => {
		// N1: a day number elsewhere in the quote, or a numeric date that reads both ways, is not a stated date
		assert.ok(!finder.quoteStatesDate("Week 6, Feb 20", "2026-02-06"));
		assert.ok(!finder.quoteStatesDate("Quiz 3: 12 March", "2026-03-03"));
		assert.ok(!finder.quoteStatesDate("6/2", "2026-02-06"), "6 Feb or 2 Jun");
		assert.ok(!finder.quoteStatesDate("6/2", "2026-06-02"));
		assert.ok(finder.quoteStatesDate("Quiz 3: 12 March", "2026-03-12"));
		// N2: Ask removes the old exam date; the page then sets a date and clears it: the card stays stale
		const { courseId } = approvedCourse();
		courses.setCourseExamDate(courseId, inDays(30));
		const removed = assess.deleteAssessment(courseId, A.LEGACY_EXAM_ID);
		assert.ok(removed.ok);
		const chatId = askChat(courseId);
		chatStore.saveMessages(chatId, [
			{ id: "rma", role: "assistant", content: [{ type: "toolCall", id: "rm", name: "assessment_remove", arguments: {} }], ...ASSISTANT_BASE, timestamp: Date.now() },
			{ id: "rmr", role: "toolResult", toolCallId: "rm", toolName: "assessment_remove", content: [{ type: "text", text: "ok" }], isError: false, details: { change: { kind: "assessment", courseId, ...removed.value, skillNames: [] } }, timestamp: Date.now() },
		] as unknown as LhMessage[]);
		assert.equal(changes.classChangeStatuses(chatId).rm, "applied");
		courses.setCourseExamDate(courseId, inDays(40));
		courses.setCourseExamDate(courseId, undefined);
		assert.equal(changes.classChangeStatuses(chatId).rm, "changed");
		assert.equal(changes.undoClassChange(chatId, "rm").ok, false);
		assert.equal(getCourse(courseId).examDate, undefined, "the old date does not come back");
		// N3: a bare weekday said on that weekday could be today or a week from today
		const fri = new Date(2026, 10, 27, 12).getTime();
		assert.deepEqual(A.readLearnerDate("Friday", fri), { kind: "ambiguous", options: ["2026-11-27", "2026-12-04"] });
		assert.deepEqual(A.readLearnerDate("this Friday", fri), { kind: "date", date: "2026-11-27" });
		// N4: an approval that leaves an item alone says how many
		const other = approvedCourse().courseId;
		const made = assess.createAssessment(other, { kind: "quiz", title: "Quiz 1", date: inDays(5), topics: "ch 1" }, "syllabus");
		assert.ok(made.ok);
		const p = await propose(other, [{ key: "p1", kind: "quiz", title: "Quiz 1", date: inDays(6), topics: "ch 1", skillIds: [], cite: "Syllabus.md" }]);
		assert.equal(p.items[0]!.status, "update");
		assess.deleteAssessment(other, made.value.id);
		const res = await proposalRoute.POST(json({ action: "approve", proposalId: p.id }), params({ id: other }));
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { ok: true, skipped: 1 });
	});

	it("4: the old exam date converts to one stable id on every device; Undo checks every field it restores", async () => {
		const { courseId } = approvedCourse();
		courses.setCourseExamDate(courseId, inDays(30));
		const before = JSON.stringify(getCourse(courseId));
		const edited = assess.updateAssessment(courseId, A.LEGACY_EXAM_ID, { title: "Final exam" });
		assert.ok(edited.ok);
		assert.equal(edited.value.id, A.LEGACY_ITEM_ID);
		// a second device converts the same exam date: the same id, so a sync merges them into one
		const other = JSON.parse(before) as CourseRecord;
		const otherItem = { id: A.LEGACY_ITEM_ID, kind: "exam", title: "Exam", date: inDays(30), topics: "everything", skillIds: [], source: "chat", updatedAt: new Date(Date.now() + 60_000).toISOString() };
		const remote = { ...other, examDate: undefined, assessments: [otherItem], updatedAt: otherItem.updatedAt };
		const merged = JSON.parse(mergeFile({ path: `courses/${courseId}.json`, base: before, local: JSON.stringify(getCourse(courseId)), remote: JSON.stringify(remote), prefer: "local" }).content!) as CourseRecord;
		assert.equal(live(merged).filter((a) => a.kind === "exam").length, 1, "one exam, not two");
		// an older device sets a new exam date after the conversion: Undo of the conversion is refused (it would clobber it)
		const chatId = askChat(courseId);
		const toolCall = (id: string, change: unknown) => [
			{ id: `${id}a`, role: "assistant", content: [{ type: "toolCall", id, name: "assessment_save", arguments: {} }], ...ASSISTANT_BASE, timestamp: Date.now() },
			{ id: `${id}r`, role: "toolResult", toolCallId: id, toolName: "assessment_save", content: [{ type: "text", text: "ok" }], isError: false, details: { change }, timestamp: Date.now() },
		];
		chatStore.saveMessages(chatId, toolCall("conv", { kind: "assessment", courseId, ...edited.value, skillNames: [] }) as unknown as LhMessage[]);
		assert.deepEqual(changes.classChangeStatuses(chatId), { conv: "applied" });
		courseStore.updateCourse(courseId, { examDate: inDays(35) });
		assert.deepEqual(changes.classChangeStatuses(chatId), { conv: "changed" });
		assert.equal(changes.undoClassChange(chatId, "conv").ok, false);
		assert.equal(getCourse(courseId).examDate, inDays(35), "the synced date stays");
		// removing the (new) legacy exam: its card holds only while its own tombstone does
		courseStore.updateCourse(courseId, { assessments: [] });
		const removed = assess.deleteAssessment(courseId, A.LEGACY_EXAM_ID);
		assert.ok(removed.ok);
		chatStore.saveMessages(chatId, [...chatStore.getChat(chatId)!.messages, ...(toolCall("rm", { kind: "assessment", courseId, ...removed.value, skillNames: [] }) as unknown as LhMessage[])]);
		assert.equal(changes.classChangeStatuses(chatId).rm, "applied");
		assert.ok(changes.undoClassChange(chatId, "rm").ok);
		assert.equal(getCourse(courseId).examDate, inDays(35));
		courseStore.updateCourse(courseId, { examDate: undefined }); // the field becomes empty again some other way
		assert.equal(changes.classChangeStatuses(chatId).rm, "changed", "the removal card does not come back to life");
		// an ordinary item: a write with the same stamp but other values (another device, the same millisecond) is a change
		const made = assess.createAssessment(courseId, { kind: "quiz", title: "Quiz 1", date: inDays(3) });
		assert.ok(made.ok);
		chatStore.saveMessages(chatId, [...chatStore.getChat(chatId)!.messages, ...(toolCall("add", { kind: "assessment", courseId, ...made.value, skillNames: [] }) as unknown as LhMessage[])]);
		const entries = A.readAssessmentEntries(getCourse(courseId).assessments).map((e) => (e.id === made.value.id ? { ...e, title: "Quiz 1 (moved)" } : e));
		courseStore.updateCourse(courseId, { assessments: entries });
		assert.equal(changes.classChangeStatuses(chatId).add, "changed");
		assert.ok(A.sameEntry(made.value.after, made.value.after) && !A.sameEntry({ ...made.value.after!, title: "x" }, made.value.after));
	});

	it("5: a deletion survives an offline copy after its tombstone is gone; a sync over 100 items drops none", () => {
		const t = (h: number) => `2026-11-25T${String(h).padStart(2, "0")}:00:00.000Z`;
		const q = (id: string, h: number) => ({ id, kind: "quiz", title: id, topics: "", skillIds: [], source: "manual", updatedAt: t(h) });
		const base = { id: "c1", title: "T", createdAt: t(1), updatedAt: t(1), status: "active", skills: [], assessments: [q("as_old", 1)], version: 1 };
		// this device deleted as_old and, many deletions later, dropped its tombstone; the other still holds the item
		const local = { ...base, updatedAt: t(5), assessments: [q("as_new", 5)] };
		const remote = { ...base, updatedAt: t(2), assessments: [q("as_old", 1)] };
		for (const prefer of ["local", "remote"] as const) {
			const merged = JSON.parse(mergeFile({ path: "courses/c1.json", base: JSON.stringify(base), local: JSON.stringify(local), remote: JSON.stringify(remote), prefer }).content!) as CourseRecord;
			assert.deepEqual(live(merged).map((a) => a.id), ["as_new"], prefer);
		}
		// with no base (a first sync) nothing is taken as deleted
		const first = JSON.parse(mergeFile({ path: "courses/c1.json", base: null, local: JSON.stringify(local), remote: JSON.stringify(remote), prefer: "local" }).content!) as CourseRecord;
		assert.deepEqual(live(first).map((a) => a.id).sort(), ["as_new", "as_old"]);
		// a merged list over the cap: every live item stays through an unrelated write; only an addition is refused
		const { courseId } = approvedCourse();
		const many = Array.from({ length: A.ASSESSMENTS_MAX + 5 }, (_, i) => q(`as_${i}`, 3));
		courseStore.updateCourse(courseId, { assessments: many as Assessment[] });
		assert.ok(assess.updateAssessment(courseId, "as_0", { topics: "ch 1" }).ok);
		assert.equal(live(getCourse(courseId)).length, A.ASSESSMENTS_MAX + 5);
		const refused = assess.createAssessment(courseId, { kind: "quiz", title: "One more" });
		assert.equal(refused.ok, false);
		assert.equal(!refused.ok && refused.status, 409);
	});

	it("6: an update bound to a quiz the learner deleted or renamed meanwhile never recreates it; an edited title updates the same quiz", async () => {
		const { courseId } = approvedCourse();
		const quiz = (title: string, date?: string) => ({ key: "p1", kind: "quiz" as const, title, ...(date ? { date } : {}), topics: "ch 1", skillIds: [], cite: "Syllabus.md" });
		await propose(courseId, [quiz("Quiz 1", inDays(5))]);
		assert.equal((await proposalRoute.POST(json({ action: "approve", proposalId: getCourse(courseId).assessmentProposal!.id }), params({ id: courseId }))).status, 200);
		const q1 = live(getCourse(courseId))[0]!;
		// a re-run proposes a change; meanwhile the learner deletes the quiz
		let p = await propose(courseId, [quiz("Quiz 1", inDays(6))]);
		assert.deepEqual(p.items.map((i) => [i.status, i.match, i.matchStamp]), [["update", q1.id, q1.updatedAt]]);
		assess.deleteAssessment(courseId, q1.id);
		assert.equal((await proposalRoute.POST(json({ action: "approve", proposalId: p.id }), params({ id: courseId }))).status, 200);
		assert.deepEqual(live(getCourse(courseId)), [], "the deleted quiz is not recreated");
		// again, and the learner renames it and moves its date (it was syllabus-sourced: the learner's edit wins)
		const made = assess.createAssessment(courseId, { kind: "quiz", title: "Quiz 2", date: inDays(8), topics: "ch 2" }, "syllabus");
		assert.ok(made.ok);
		p = await propose(courseId, [quiz("Quiz 2", inDays(9))]);
		assert.equal(p.items[0]!.status, "update");
		assess.updateAssessment(courseId, made.value.id, { title: "Quiz 2b", date: inDays(10) }, "syllabus");
		assert.equal((await proposalRoute.POST(json({ action: "approve", proposalId: p.id }), params({ id: courseId }))).status, 200);
		assert.deepEqual(live(getCourse(courseId)).map((a) => [a.title, a.date]), [["Quiz 2b", inDays(10)]], "no second quiz; the rename stays");
		// an undated proposed update whose title the learner edits on approval updates the matched quiz, not a new one
		const undated = assess.createAssessment(courseId, { kind: "quiz", title: "Quiz 3", topics: "" }, "syllabus");
		assert.ok(undated.ok);
		p = await propose(courseId, [quiz("Quiz 3")]);
		const key = p.items.find((i) => i.status === "update")!.key;
		assert.equal((await proposalRoute.POST(json({ action: "approve", keys: [key], edits: { [key]: { title: "Quiz 3 (take-home)" } }, proposalId: p.id }), params({ id: courseId }))).status, 200);
		const quizzes = live(getCourse(courseId)).filter((a) => a.title.startsWith("Quiz 3"));
		assert.deepEqual(quizzes.map((a) => [a.id, a.title]), [[undated.value.id, "Quiz 3 (take-home)"]]);
	});

	it("7: approve-all over the item cap writes nothing and keeps the whole proposal", async () => {
		const { courseId } = approvedCourse();
		const t = new Date().toISOString();
		courseStore.updateCourse(courseId, { assessments: Array.from({ length: A.ASSESSMENTS_MAX - 1 }, (_, i) => ({ id: `as_${i}`, kind: "quiz" as const, title: `Old ${i}`, topics: "", skillIds: [], source: "manual" as const, updatedAt: t })) });
		const p = await propose(courseId, [
			{ key: "p1", kind: "quiz", title: "New A", date: inDays(5), topics: "", skillIds: [], cite: "Syllabus.md" },
			{ key: "p2", kind: "quiz", title: "New B", date: inDays(6), topics: "", skillIds: [], cite: "Syllabus.md" },
		]);
		const before = JSON.stringify(getCourse(courseId).assessments);
		const res = await proposalRoute.POST(json({ action: "approve", proposalId: p.id }), params({ id: courseId }));
		assert.equal(res.status, 409);
		assert.match(((await res.json()) as { error: string }).error, /over 100 assessments/);
		assert.equal(JSON.stringify(getCourse(courseId).assessments), before, "not even the first one");
		assert.deepEqual(getCourse(courseId).assessmentProposal!.items.map((i) => i.key), ["p1", "p2"], "both still pending");
		// one fits
		assert.equal((await proposalRoute.POST(json({ action: "approve", keys: ["p1"], proposalId: p.id }), params({ id: courseId }))).status, 200);
		assert.equal(live(getCourse(courseId)).length, A.ASSESSMENTS_MAX);
		assert.deepEqual(getCourse(courseId).assessmentProposal!.items.map((i) => i.key), ["p2"]);
	});

	it("8: placement credit on a prerequisite overrides its self-report", () => {
		const T = Date.UTC(2026, 10, 25, 12);
		const requiresOf = (id: string) => (id === "b" ? ["a"] : []);
		// "I don't get a" at T; then placement shows the learner knows b (which requires a) at T + 1 h
		const events = [{ skillId: "b", at: T + 3_600_000, outcome: "placementKnown" as const, placement: false }];
		const folded = mastery.foldSkills(events, requiresOf);
		assert.ok(folded.has("a"), "the fold credits the prerequisite");
		const out = mastery.applySelfReports(folded, [{ id: "r", at: T, skillIds: ["a"], stance: "dont_know" }], events);
		assert.equal(out.active.has("a"), false, "the report is overridden");
		assert.deepEqual(out.states.get("a"), folded.get("a"), "a keeps its fresh credit, not shifted back to due");
		assert.ok(!out.needsWork.has("a"));
		// a direct miss with no FSRS state is evidence too
		const miss = [{ skillId: "c", at: T + 1000, outcome: "placementMiss" as const, placement: false }];
		assert.equal(mastery.applySelfReports(mastery.foldSkills(miss, requiresOf), [{ id: "r2", at: T, skillIds: ["c"], stance: "know" }], miss).active.has("c"), false);
	});

	it("9: a shared skill's report removes in the class that holds it; failures show; no link to a deleted chat", async () => {
		const { courseId, b } = approvedCourse("Class A");
		const other = courseStore.createCourse("Class B");
		courseStore.updateCourse(other.id, { status: "active", skills: [b] });
		const chatId = askChat(courseId);
		assert.ok(changes.classFactsPort(chatId)!.selfReport({ skillIds: [b], stance: "dont_know", note: "" }).ok);
		const inB = courses.courseView(other.id)!.skills.find((s) => s.id === b)!.selfReport!;
		assert.equal(inB.courseId, courseId, "B shows A's report and knows it is A's");
		assert.equal(inB.chatId, chatId);
		const urls: string[] = [];
		const ok = (async (url: string) => {
			urls.push(url);
			return reportRoute.DELETE(new Request("http://x"), params({ id: url.split("/")[3]!, reportId: url.split("/")[5]! }));
		}) as unknown as typeof fetch;
		assert.equal(await removeSelfReport(inB, other.id, ok), null);
		assert.deepEqual(urls, [`/api/courses/${courseId}/self-reports/${inB.id}`]);
		assert.equal(courses.courseView(other.id)!.skills.find((s) => s.id === b)!.selfReport, undefined);
		// a refused removal says why
		assert.equal(await removeSelfReport({ id: "sr_gone" }, other.id, ok), "Unknown self-report");
		assert.equal(await removeSelfReport({ id: "x" }, other.id, (async () => { throw new Error("offline"); }) as unknown as typeof fetch), "Could not reach the server — try again.");
		// the chat it was said in is deleted: the report stays, its "where" link goes
		assert.ok(changes.classFactsPort(chatId)!.selfReport({ skillIds: [b], stance: "shaky", note: "" }).ok);
		chatStore.deleteChat(chatId);
		const kept = courses.courseView(courseId)!.skills.find((s) => s.id === b)!.selfReport!;
		assert.equal(kept.stance, "shaky");
		assert.equal(kept.chatId, undefined);
	});

	it("10: the finder stops at 6 model turns with what it found (partial), at its token budget too, and records usage", async () => {
		const mats = [{ id: "mat_t", name: "Plan.md", kind: "text" }];
		const sources = new Map([["mat_t", { kind: "text" as const, text: "Quiz 1: TBA" }]]);
		const input = { title: "C", materialsSection: "<curriculum/>", materials: mats, sources, skills: [], language: "en" as const };
		// every submission has one fixable problem (an unknown material) beside a good item: the model never gets it right
		const submit = fauxToolCall("submit_assessments", { summary: "Read Plan.md.", assessments: [{ kind: "quiz", title: "Quiz 1", dateText: "TBA", topics: "", skills: [], material: "mat_t" }, { kind: "quiz", title: "Quiz 2", dateText: "", topics: "", skills: [], material: "mat_nope" }] });
		let steps = 0;
		const found = await finder.findAssessments(input, { engine: scripted(Array.from({ length: 20 }, () => fauxAssistantMessage([submit], { stopReason: "toolUse" }))), tools: {}, onStep: () => steps++, courseId: "c" });
		assert.equal(steps, finder.FINDER_MAX_TURNS);
		assert.equal(found.partial, true);
		assert.deepEqual(found.items.map((i) => i.title), ["Quiz 1"]);
		// the token budget: the second call's prompt carries a huge tool result
		const big: import("@earendil-works/pi-agent-core").AgentTool<any> = { name: "big", label: "big", description: "x", parameters: { type: "object", properties: {} } as never, execute: async () => ({ content: [{ type: "text", text: "x".repeat(finder.FINDER_TOKEN_BUDGET * 4 + 4000) }], details: null }) };
		steps = 0;
		const capped = await finder.findAssessments(input, { engine: scripted([fauxAssistantMessage([submit, fauxToolCall("big", {})], { stopReason: "toolUse" }), ...Array.from({ length: 5 }, () => fauxAssistantMessage([submit], { stopReason: "toolUse" }))]), tools: { big }, onStep: () => steps++, courseId: "c" });
		assert.equal(steps, 2, "stopped right after the call that went over");
		assert.equal(capped.partial, true);
		// with nothing submitted at all it fails, saying why
		await assert.rejects(finder.findAssessments(input, { engine: scripted(Array.from({ length: 8 }, () => fauxAssistantMessage([fauxToolCall("big", {})], { stopReason: "toolUse" }))), tools: { big }, onStep: () => {}, courseId: "c" }), /token budget/);
		// the server caps what it stores, marks it partial, and logs every call's usage on the course
		const { courseId } = approvedCourse();
		addSyllabus(courseId);
		assess.setAssessmentFinderForTests(async (_in, deps) => {
			deps.onStep({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, "faux:faux", 1, "toolUse", "submit_assessments");
			return { summary: "s".repeat(2000), partial: true, items: Array.from({ length: 90 }, (_, i) => ({ key: `k${i}`, kind: "quiz" as const, title: `Quiz ${i}`, topics: "", skillIds: [], cite: "Syllabus.md" })) };
		});
		assert.ok(assess.startAssessmentFind(courseId).ok);
		await waitFinding(courseId);
		const stored = getCourse(courseId);
		assert.equal(stored.assessmentProposal!.items.length, A.PROPOSAL_ITEMS_MAX);
		assert.equal(stored.assessmentProposal!.summary.length, A.PROPOSAL_SUMMARY_MAX);
		assert.equal(stored.assessmentProposal!.partial, true);
		assert.deepEqual(stored.drafts?.map((d) => [d.pass, d.planner.steps.length, d.planner.steps[0]!.inputTokens]), [["find-assessments", 1, 100]]);
		assert.match(render(stored.assessmentProposal!), /stopped early/);
	});

	it("11: titles in any script match only themselves; a title with no letters or numbers matches nothing", async () => {
		assert.equal(A.titleKey("小テスト 1"), "小テスト 1");
		assert.notEqual(A.titleKey("小テスト1"), A.titleKey("中間試験"));
		assert.equal(A.titleKey("Quiz #3"), A.titleKey("quiz 3"));
		assert.equal(A.titleKey("Exposé 2"), A.titleKey("expose 2"), "accents folded as before");
		assert.equal(A.titleKey("Prøve 2"), "prøve 2", "Norwegian letters kept as before");
		assert.ok(!A.sameTitle("???", "!!!"));
		const { courseId } = approvedCourse();
		const made = assess.createAssessment(courseId, { kind: "quiz", title: "小テスト1", date: inDays(4) });
		assert.ok(made.ok);
		// Ask: naming another all-Japanese quiz adds it, never overwrites the one there
		const chatId = askChat(courseId);
		const save = classFactsTools(changes.classFactsPort(chatId)!).assessment_save!;
		const out = (await save.execute("x", { kind: "quiz", title: "中間試験", date: inDays(9) }, undefined as never)) as { isError?: boolean };
		assert.notEqual(out.isError, true);
		assert.deepEqual(live(getCourse(courseId)).map((a) => [a.title, a.date]).sort(), [["中間試験", inDays(9)], ["小テスト1", inDays(4)]]);
		// the syllabus pass: a differently named item is new, not an update of the existing one
		const classified = A.classifyProposal([{ key: "p1", kind: "quiz", title: "期末試験", topics: "", skillIds: [], cite: "s" }], live(getCourse(courseId)));
		assert.equal(classified[0]!.status, "new");
	});

	it("12: the fading line names an assessment only when every fading skill is timed for it", () => {
		const { courseId, a, c } = approvedCourse();
		practiceEvidence(courseId, a, Date.now() - DAY);
		practiceEvidence(courseId, c, Date.now() - DAY);
		// Friday's quiz covers a (fine by then); a later final covers c (faded by then)
		assess.createAssessment(courseId, { kind: "quiz", title: "Friday quiz", date: inDays(1), skillIds: [a] });
		assess.createAssessment(courseId, { kind: "final", title: "Final", date: inDays(60), skillIds: [c] });
		let plan = courses.courseView(courseId)!.plan;
		assert.equal(plan.next?.title, "Friday quiz");
		assert.equal(plan.reviewFading, 1);
		assert.equal(plan.reviewFadingBefore, "upcoming tests", "c fades before the final, not before Friday's quiz");
		// only the final left: it is named
		const quiz = live(getCourse(courseId)).find((x) => x.title === "Friday quiz")!;
		assess.deleteAssessment(courseId, quiz.id);
		plan = courses.courseView(courseId)!.plan;
		assert.equal(plan.reviewFadingBefore, "Final");
	});

	it("13: a Short question's composer asks about the class, not the lesson", () => {
		assert.equal(composerPlaceholder({ nextReady: false, askSession: true }), "Ask a question about this class…");
		assert.equal(composerPlaceholder({ nextReady: false, askSession: false }), undefined, "the lesson default");
		assert.equal(composerPlaceholder({ nextReady: true, askSession: false }), "Ask anything, or press Enter for the next one.");
	});

	function render(proposal: AssessmentProposal) {
		return renderToStaticMarkup(<UpcomingList courseId="course_1" upcoming={{ items: [], finding: false, proposal }} skills={[]} canFind onChanged={() => {}} />);
	}
});
