/**
 * WP9 review 1 (2026-11-26): one regression test per finding. Undo restores the class position with the lecture (1); an
 * Undo of a file-derived removal survives a sync and a renamed file (2); a removed lecture does not come back under a
 * file's id (3); a clear and an Undo of the position win a sync over an earlier edit (4); class_overview writes nothing
 * and starts nothing (5); a new lecture from the page still gets its skills placed (6); an obsolete linker reply is
 * discarded and changed evidence is placed again (7); a cite for Lecture 10 is not Lecture 1 (8); the timeline order does
 * not depend on storage order (9); the position and "today" are the learner's (10); the Start is the first of Next up
 * (11); a cumulative final covers every skill past 60 (12); Short question takes back a self-report from another chat
 * and renames or redates a lecture note (13); the chat keeps a long title whole and refuses a language clear (14); the
 * page's position edit keeps the chat's note (15). Deterministic: no real model.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-wp9r1-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const L = await import("../src/core/lectures.ts");
const A = await import("../src/core/assessments.ts");
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
const notes = await import("../src/server/lecture-notes.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { createAskAgent } = await import("../src/agent/ask-agent.ts");
const { classFactsTools } = await import("../src/agent/tools/class-facts.ts");
const { classChangeLines } = await import("../components/class-change-card.tsx");
const { lectureBody } = await import("../components/lecture-list.tsx");
const { positionBody } = await import("../components/where-you-stand.tsx");
const { bodyOf } = await import("../components/upcoming-list.tsx");
const { LEDGER_FILES } = await import("../config.ts");
const courseRoute = await import("../app/api/courses/[id]/route.ts");
const positionRoute = await import("../app/api/courses/[id]/class-position/route.ts");
const undoRoute = await import("../app/api/chats/[id]/class-changes/[toolCallId]/route.ts");
const changesRoute = await import("../app/api/chats/[id]/class-changes/route.ts");

import type { CourseRecord, CourseView } from "../src/core/contracts.ts";
import type { Lecture, LectureView } from "../src/core/lectures.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

// ─── fixtures (as tests/where-you-stand.test.tsx) ────────────────────────────

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

function inDays(n: number, from = Date.now()): string {
	const d = new Date(from + n * DAY);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** An approved class of `n` independent skills, or the usual four (a → b, c, d). */
function approvedCourse(n?: number) {
	const course = courseStore.createCourse("Signals");
	const skills = n
		? Array.from({ length: n }, (_, i) => ({ key: `s${i + 1}`, name: `Skill ${i + 1}`, statement: `Do thing ${i + 1}`, requires: [] as string[], restsOn: [] as string[] }))
		: [
				{ key: "s1", name: "Laplace", statement: "Take a Laplace transform", requires: [], restsOn: [] },
				{ key: "s2", name: "Poles", statement: "Read the poles of a transfer function", requires: ["s1"], restsOn: [] },
				{ key: "s3", name: "Bode", statement: "Sketch a Bode plot", requires: [], restsOn: [] },
				{ key: "s4", name: "Nyquist", statement: "Read stability from a Nyquist plot", requires: [], restsOn: [] },
			];
	courseStore.updateCourse(course.id, { status: "draft", draft: { createdAt: "t", summary: "s", skills } });
	const approved = courses.approveCourse(course.id);
	assert.ok(approved.ok);
	const byName = Object.fromEntries(mergeSkillLines(skillStore.readSkillLines()).map((s) => [s.name, s.id]));
	return { courseId: course.id, a: byName.Laplace!, b: byName.Poles!, c: byName.Bode!, d: byName.Nyquist!, byName };
}

function addFile(courseId: string, name: string, profile = "## Scope and targets\nSlides.") {
	const m = materialStore.add(courseId, { kind: "text", name, ext: ".md", bytes: new TextEncoder().encode(`# ${name}\n`) });
	materialStore.update(courseId, m.id, { status: "ready", profile });
	return m.id;
}

function lec(over: Partial<Lecture> & { id: string; title: string }): LectureView {
	return { topics: "", materialIds: [], skillIds: [], source: "manual", updatedAt: T0, ...over };
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

const oneCall = (tool: string, args: Parameters<typeof fauxToolCall>[1], id: string, reply = "Done.") =>
	scripted([fauxAssistantMessage([fauxToolCall(tool, args, { id })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText(reply)])]);

function askChat(courseId: string) {
	const out = courses.createCourseSession(courseId, "ask");
	assert.ok(out.ok);
	pinModel(out.value.id);
	return out.value.id;
}

const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const json = (body: unknown, method = "POST", headers: Record<string, string> = {}) => new Request("http://test/x", { method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const getCourse = (id: string) => courseStore.getCourse(id)!;
const toolResults = (chatId: string) =>
	chatStore.getChat(chatId)!.messages.filter((m) => (m as { role?: string }).role === "toolResult") as unknown as Array<{ toolCallId: string; toolName: string; isError: boolean; details: unknown; content: Array<{ text?: string }> }>;
const resultText = (chatId: string, id: string) => toolResults(chatId).find((r) => r.toolCallId === id)!.content.map((c) => c.text ?? "").join("");
const changeOf = (chatId: string, id: string) => (toolResults(chatId).find((r) => r.toolCallId === id)!.details as { change: unknown }).change;
const undo = (chatId: string, toolCallId: string) => undoRoute.POST(new Request("http://x"), params({ id: chatId, toolCallId }));
const statuses = async (chatId: string) => (await (await changesRoute.GET(new Request("http://x"), params({ id: chatId }))).json()) as Record<string, string>;

async function waitLinking(courseId: string) {
	for (let i = 0; i < 400 && lectures.lectureLinking(courseId); i++) await new Promise((r) => setTimeout(r, 5));
	assert.equal(lectures.lectureLinking(courseId), false, "the linking step settled");
}

/** One device's copy of the course record, and the merge of two copies against a base. */
const copy = (id: string) => JSON.parse(JSON.stringify(getCourse(id))) as CourseRecord;
function merge(base: CourseRecord, local: CourseRecord, remote: CourseRecord): CourseRecord {
	const out = mergeFile({ path: `courses/${base.id}.json`, base: JSON.stringify(base), local: JSON.stringify(local), remote: JSON.stringify(remote), prefer: "remote" });
	return JSON.parse(out.content!) as CourseRecord;
}

// ─── the findings ────────────────────────────────────────────────────────────

describe("WP9 review 1", () => {
	beforeEach(reset);

	it("1. Undo of a removal brings the class position back with the lecture; an add the position now names offers no Undo", async () => {
		const { courseId } = approvedCourse();
		const l8 = lectures.createLecture(courseId, { n: 8, date: inDays(-2) });
		assert.ok(l8.ok);
		lectures.setClassPosition(courseId, { lectureId: l8.value.id });
		const chatId = askChat(courseId);
		await runTurn(chatId, "Lecture 8 was cancelled.", oneCall("lecture_remove", { id: l8.value.id }, "rm"));
		assert.equal(L.sanitizeClassPosition(getCourse(courseId).classPosition), undefined, "the position named it: cleared");
		assert.equal((await undo(chatId, "rm")).status, 200);
		assert.equal(L.sanitizeClassPosition(getCourse(courseId).classPosition)?.lectureId, l8.value.id, "the lecture AND the position are back");
		assert.equal(courses.courseView(courseId)!.standing!.position!.how, "explicit");
		// the other direction: the position set (on the page) to a lecture the chat added; undoing the add would dangle
		await runTurn(chatId, "Add lecture 11.", oneCall("lecture_save", { n: 11 }, "add"));
		const l11 = lectures.classLectures(getCourse(courseId)).find((l) => l.n === 11)!;
		lectures.setClassPosition(courseId, { lectureId: l11.id });
		assert.equal((await statuses(chatId)).add, "changed");
		assert.equal((await undo(chatId, "add")).status, 409);
		assert.ok(lectures.classLectures(getCourse(courseId)).some((l) => l.id === l11.id));
	});

	it("2. Undo of a removed lecture read from a file survives a sync, and does not depend on the file's name", async () => {
		const { courseId } = approvedCourse();
		const file = addFile(courseId, "Lecture 8.pdf");
		const chatId = askChat(courseId);
		await runTurn(chatId, "Lecture 8 is cancelled.", oneCall("lecture_remove", { id: "lf_lecture_8" }, "rm"));
		const synced = copy(courseId); // both devices hold the removal
		// the file is renamed before the Undo: the lecture still comes back, as it was shown
		materialStore.update(courseId, file, { name: "Signals notes.pdf" });
		assert.equal((await undo(chatId, "rm")).status, 200);
		const back = lectures.classLectures(getCourse(courseId)).find((l) => l.id === "lf_lecture_8");
		assert.ok(back, "back after the file was renamed");
		assert.deepEqual([back.n, back.title, back.materialIds], [8, "Lecture 8", [file]]);
		// the other device still has the tombstone; the base has it too; the Undo wins the merge
		const merged = merge(synced, getCourse(courseId), synced);
		assert.ok(!A.isTombstone(L.readLectureEntries(merged.lectures).find((e) => e.id === "lf_lecture_8")), "the Undo is a newer revision, not a missing entry");
	});

	it("3. a removed lecture does not reappear under the id of a file named like it; Undo lifts that, the file is kept", async () => {
		const { courseId } = approvedCourse();
		const made = lectures.createLecture(courseId, { n: 8, title: "Lecture 8: Eigenvalues", date: inDays(-1) });
		assert.ok(made.ok);
		const file = addFile(courseId, "Lecture 8.pdf");
		const before = lectures.classLectures(getCourse(courseId));
		assert.deepEqual(before.map((l) => [l.id, l.materialIds, l.joined]), [[made.value.id, [file], ["lf_lecture_8"]]], "the file joins the stored lecture");
		const removed = lectures.deleteLecture(courseId, made.value.id);
		assert.ok(removed.ok);
		assert.deepEqual(lectures.classLectures(getCourse(courseId)), [], "not back as lf_lecture_8 in the same read");
		assert.ok(materialStore.list(courseId).some((m) => m.id === file), "the file itself is untouched");
		assert.ok(lectures.revertLectureChange(courseId, removed.value).ok);
		assert.deepEqual(lectures.classLectures(getCourse(courseId)).map((l) => [l.id, l.materialIds]), [[made.value.id, [file]]], "Undo: the lecture with its file, no duplicate");
	});

	it("4. a later \"follow the dates\" and an Undo win a sync over an earlier statement on the other device", async () => {
		const { courseId } = approvedCourse();
		const l1 = lectures.createLecture(courseId, { n: 1, date: inDays(-9) });
		const l2 = lectures.createLecture(courseId, { n: 2, date: inDays(-2) });
		assert.ok(l1.ok && l2.ok);
		lectures.setClassPosition(courseId, { lectureId: l1.value.id });
		const base = copy(courseId);
		// device A states lecture 2 at noon; device B (later) chooses "follow the dates"
		const a = { ...base, classPosition: { lectureId: l2.value.id, saidOn: "2026-11-25", updatedAt: "2026-11-25T12:00:00.000Z" }, updatedAt: "2026-11-25T12:00:00.000Z" };
		const b = { ...base, classPosition: { updatedAt: "2026-11-25T13:00:00.000Z" }, updatedAt: "2026-11-25T11:00:00.000Z" } as CourseRecord;
		assert.equal(L.sanitizeClassPosition(merge(base, a as CourseRecord, b).classPosition), undefined, "the clear said later wins");
		assert.equal(L.sanitizeClassPosition(merge(base, b, a as CourseRecord).classPosition), undefined, "either side");
		// an Undo takes a fresh revision and keeps the day it was first said
		const set = lectures.setClassPosition(courseId, { lectureId: l2.value.id, note: "a week behind" });
		assert.ok(set.ok);
		const cleared = lectures.setClassPosition(courseId, null);
		assert.ok(cleared.ok);
		assert.ok(lectures.revertPositionChange(courseId, { beforeRev: cleared.value.beforeRev }).ok);
		const restored = L.sanitizeClassPosition(getCourse(courseId).classPosition)!;
		assert.equal(restored.saidOn, set.value.after!.saidOn);
		assert.ok(restored.updatedAt > cleared.value.afterRev.updatedAt, "newer than the clear it undoes");
	});

	it("5. class_overview writes nothing and starts nothing (no linking job, no healed draft), and says when placements are stale", async () => {
		const { courseId } = approvedCourse();
		addFile(courseId, "Lecture 1.pdf");
		let calls = 0;
		lectures.setLectureLinkerForTests(async () => {
			calls++;
			return new Map();
		});
		courseStore.updateCourse(courseId, { status: "drafting" }); // an interrupted draft the page would settle
		const chatId = askChat(courseId);
		const before = JSON.stringify(getCourse(courseId));
		const tools = classFactsTools(changes.classFactsPort(chatId)!);
		const out = await tools.class_overview!.execute("o1", {});
		assert.equal(JSON.stringify(getCourse(courseId)), before, "the record is byte-for-byte the same");
		assert.equal(lectures.lectureLinkCount(), 0, "no job");
		assert.equal(calls, 0, "no model call");
		assert.match((out.content[0] as { text: string }).text, /placement in the lectures is out of date/);
	});

	it("6. a lecture added on the page with no skill ticked is still placed by the linking step; an explicit clear on an existing one holds", async () => {
		const { courseId, c } = approvedCourse();
		const body = lectureBody({ n: "", title: "Lecture 5", date: "", topics: "Bode plots", skillIds: [] });
		assert.equal("skillIds" in body, false, "nothing chosen: no skills field");
		assert.deepEqual(lectureBody({ n: "5", title: "L", date: "", topics: "", skillIds: [] }, { skillIds: [c] }).skillIds, [], "clearing an existing one is sent");
		lectures.setLectureLinkerForTests(async (input) => new Map([[c, [input.lectures[0]!.id]]]));
		const made = lectures.createLecture(courseId, { ...body, skillIds: [] }); // an older page sends [] anyway
		assert.ok(made.ok);
		assert.equal(made.value.after!.skillsBy, undefined, "not the learner's empty choice");
		await waitLinking(courseId);
		assert.deepEqual(lectures.classLectures(getCourse(courseId))[0]!.skillIds, [c], "placed");
		assert.ok(lectures.updateLecture(courseId, made.value.id, { skillIds: [] }).ok);
		assert.equal(lectures.classLectures(getCourse(courseId))[0]!.skillsBy, "learner");
	});

	it("7. a linker reply for evidence that changed while it ran is discarded and the current evidence is placed; changed topics are placed again", async () => {
		const { courseId, b, c } = approvedCourse();
		const seen: string[] = [];
		let lectureId = "";
		lectures.setLectureLinkerForTests(async (input) => {
			seen.push(input.lectures[0]!.topics);
			await new Promise((r) => setTimeout(r, 1)); // the model takes a while
			// the first reply: the learner changes lecture 8's topics while the pass reads it
			if (seen.length === 1) {
				lectures.updateLecture(courseId, lectureId, { topics: "Poles" });
				return new Map([[c, [lectureId]]]);
			}
			return new Map([[b, [lectureId]]]);
		});
		const made = lectures.createLecture(courseId, { n: 8, title: "Lecture 8", topics: "Bode plots" });
		assert.ok(made.ok);
		lectureId = made.value.id;
		await waitLinking(courseId);
		assert.deepEqual(seen, ["Bode plots", "Poles"], "run again on the class as it is now");
		const l8 = () => lectures.classLectures(getCourse(courseId)).find((l) => l.id === made.value.id)!;
		assert.deepEqual(l8().skillIds, [b], "the obsolete reply (Bode for 'Bode plots') was never committed");
		// later the topics change again: the model's placement on that lecture is recomputed, not kept
		lectures.setLectureLinkerForTests(async (input) => {
			seen.push(input.lectures[0]!.topics);
			return new Map([[c, [made.value.id]]]);
		});
		lectures.updateLecture(courseId, made.value.id, { topics: "Bode plots after all" });
		courses.courseView(courseId);
		await waitLinking(courseId);
		assert.deepEqual(l8().skillIds, [c], "the stale model link is replaced");
		// the learner's own choice is never recomputed
		lectures.updateLecture(courseId, made.value.id, { skillIds: [b] });
		lectures.updateLecture(courseId, made.value.id, { topics: "Something else" });
		courses.courseView(courseId);
		await waitLinking(courseId);
		assert.deepEqual([l8().skillIds, l8().skillsBy], [[b], "learner"]);
	});

	it("re-check 1: a failed linking run keeps the model's placements; allSkills false on its own ends a cumulative final", async () => {
		const { courseId, b } = approvedCourse();
		let lectureId = "";
		lectures.setLectureLinkerForTests(async () => {
			await new Promise((r) => setTimeout(r, 1)); // lectureId is set once createLecture returns
			return new Map([[b, [lectureId]]]);
		});
		const made = lectures.createLecture(courseId, { n: 8, title: "Lecture 8", topics: "Bode plots" });
		assert.ok(made.ok);
		lectureId = made.value.id;
		await waitLinking(courseId);
		const l8 = () => lectures.classLectures(getCourse(courseId)).find((l) => l.id === made.value.id)!;
		assert.deepEqual(l8().skillIds, [b]);
		// the topics change and the next run fails: the placement stays, the error is shown
		lectures.setLectureLinkerForTests(async () => {
			throw new Error("model down");
		});
		lectures.updateLecture(courseId, made.value.id, { topics: "Bode plots and margins" });
		courses.courseView(courseId);
		await waitLinking(courseId);
		assert.deepEqual(l8().skillIds, [b], "not wiped by a failed run");
		assert.equal(getCourse(courseId).lecturesLinkError, "model down");
		// a cumulative final turned back with { allSkills: false } alone
		const fin = assess.createAssessment(courseId, { kind: "final", title: "Final", date: inDays(10), allSkills: true });
		assert.ok(fin.ok);
		assert.equal(A.liveAssessments(getCourse(courseId).assessments).find((x) => x.id === fin.value.id)!.allSkills, true);
		assert.ok(assess.updateAssessment(courseId, fin.value.id, { allSkills: false }).ok);
		assert.notEqual(A.liveAssessments(getCourse(courseId).assessments).find((x) => x.id === fin.value.id)!.allSkills, true);
	});

	it("8. a cite of Lecture 10 places the skill in Lecture 10 only, never Lecture 1", () => {
		const files = [
			{ id: "m1", name: "Lecture 1.pdf" },
			{ id: "m10", name: "Lecture 10.pdf" },
		];
		const list = [lec({ id: "l1", n: 1, title: "Lecture 1", materialIds: ["m1"] }), lec({ id: "l10", n: 10, title: "Lecture 10", materialIds: ["m10"] })];
		assert.deepEqual([...L.linksFromCites({ sk: "Lecture 10.pdf p. 4" }, list, files)], [["l10", ["sk"]]]);
		assert.deepEqual([...L.linksFromCites({ sk: "lecture 1.pdf, p. 2" }, list, files)], [["l1", ["sk"]]]);
	});

	it("9. the timeline order is the same whatever order the lectures are stored in", () => {
		const items = [lec({ id: "a", n: 1, title: "Lecture 1", date: "2026-03-03" }), lec({ id: "b", n: 2, title: "Lecture 2", date: "2026-03-01" }), lec({ id: "c", title: "Guest lecture", date: "2026-03-02" }), lec({ id: "d", title: "Guest lecture" }), lec({ id: "e", n: 2, title: "Lecture 2", date: "2026-03-01" })];
		const perms = (xs: LectureView[]): LectureView[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
		const orders = new Set(perms(items).map((p) => L.sortLectures(p).map((l) => l.id).join(",")));
		assert.equal(orders.size, 1, [...orders].join(" | "));
	});

	it("10. the position's day and every \"today\" are the learner's (X-LH-Time-Zone), on the page and in the overview", async () => {
		// pure: said on Nov 24 in the learner's zone (Nov 25 on the machine): a Nov 25 lecture supersedes it
		const list = [lec({ id: "l1", n: 1, title: "Lecture 1", date: "2026-11-17" }), lec({ id: "l2", n: 2, title: "Lecture 2", date: "2026-11-25" })];
		assert.deepEqual(L.classPositionOf(list, { lectureId: "l1", saidOn: "2026-11-24", updatedAt: "2026-11-25T04:00:00.000Z" }, "2026-11-26"), { lectureId: "l2", how: "dated" });
		// the server: two zones a day apart. A lecture dated "today" in the eastern one is the position only there
		const east = "Pacific/Kiritimati";
		const west = "Pacific/Pago_Pago";
		const eastToday = A.todayIn(Date.now(), east);
		assert.notEqual(eastToday, A.todayIn(Date.now(), west));
		const { courseId } = approvedCourse();
		const l = lectures.createLecture(courseId, { n: 1, date: eastToday });
		assert.ok(l.ok);
		const read = async (tz: string) => (await (await courseRoute.GET(new Request("http://x", { headers: { "X-LH-Time-Zone": tz } }), params({ id: courseId }))).json()) as CourseView;
		assert.equal((await read(east)).standing!.position?.lectureId, l.value.id);
		assert.equal((await read(west)).standing!.position, null, "not yet in the west");
		// the day a position is said is the learner's
		await positionRoute.PUT(json({ note: "behind" }, "PUT", { "X-LH-Time-Zone": west }), params({ id: courseId }));
		assert.equal(L.sanitizeClassPosition(getCourse(courseId).classPosition)!.saidOn, A.todayIn(Date.now(), west));
	});

	it("11. the card's Start is Next up's and Today's first: never a not-examined skill, and the weight order within a group", () => {
		const { courseId, a, c, d } = approvedCourse();
		// Nyquist: covered by the class, weight 0, nothing depends on it, no assessment: not examined, so not the Start
		courses.setCourseSkillWeights(courseId, { [d]: 0 });
		lectures.createLecture(courseId, { n: 1, date: inDays(-3), skillIds: [d] });
		let view = courses.courseView(courseId)!;
		assert.ok(view.notExamined.includes(d));
		assert.deepEqual(view.standing!.behind, [d]);
		assert.equal(view.standing!.start, null, "no Start on a skill Next up leaves out");
		// the quiz needs Laplace (lecture 2, the earlier) and Bode (lecture 3, weight 3), both covered: the old card took the
		// earliest lecture's (Laplace) while Today took the heavier (Bode); now both follow the shared order
		courses.setCourseSkillWeights(courseId, { [c]: 3 });
		lectures.createLecture(courseId, { n: 2, date: inDays(-2), skillIds: [a] });
		lectures.createLecture(courseId, { n: 3, date: inDays(-1), skillIds: [c] });
		assess.createAssessment(courseId, { kind: "quiz", title: "Quiz 1", date: inDays(3), skillIds: [a, c] });
		view = courses.courseView(courseId)!;
		assert.equal(view.nextUp[0], c);
		assert.equal(view.standing!.start!.skillId, view.nextUp[0]);
		assert.equal(view.standing!.start!.skillId, view.plan.lessons[0], "the hero is Today's first lesson");
	});

	it("12. a cumulative final covers every skill of a 61-skill map, and follows the map", async () => {
		const { courseId } = approvedCourse(61);
		assert.equal(getCourse(courseId).skills.length, 61);
		const fin = assess.createAssessment(courseId, { kind: "final", title: "Final", date: inDays(10) });
		assert.ok(fin.ok);
		const chatId = askChat(courseId);
		await runTurn(chatId, "The final is cumulative.", oneCall("assessment_save", { id: fin.value.id, allSkills: true }, "s1"));
		const stored = A.liveAssessments(getCourse(courseId).assessments)[0]!;
		assert.deepEqual([stored.allSkills, stored.skillIds], [true, []], "a flag, not a capped list");
		const next = courses.courseView(courseId)!.standing!.next!;
		assert.equal(next.needs!.length, 61, "readiness counts skill 61");
		assert.deepEqual(bodyOf({ kind: "final", title: "Final", date: "", topics: "", skillIds: [], allSkills: true }), { kind: "final", title: "Final", date: null, topics: "", allSkills: true }, "the page keeps the flag");
		assert.equal((await undo(chatId, "s1")).status, 200);
		assert.equal(A.liveAssessments(getCourse(courseId).assessments)[0]!.allSkills, undefined);
	});

	it("13. Short question takes back a self-report made in another chat, and renames and redates a lecture note; each with Undo", async () => {
		const { courseId, a, c } = approvedCourse();
		const other = askChat(courseId);
		const said = assess.recordSelfReport(courseId, { chatId: other, skillIds: [a, c], stance: "dont_know", note: "I don't get Laplace or Bode" });
		assert.ok(said.ok);
		const chatId = askChat(courseId);
		await runTurn(chatId, "Actually I do get Laplace now.", oneCall("self_report_retract", { skillIds: [a] }, "r1"));
		const live = A.liveSelfReports(getCourse(courseId).selfReports);
		assert.deepEqual(live.map((r) => r.skillIds), [[c]], "Laplace taken back, Bode kept");
		assert.deepEqual(classChangeLines(changeOf(chatId, "r1") as never), { eyebrow: "Taken back", title: "Laplace", lines: ["You had said: don't get it yet", "Your practice results decide it again."] });
		assert.equal((await undo(chatId, "r1")).status, 200);
		assert.deepEqual(A.liveSelfReports(getCourse(courseId).selfReports).map((r) => r.skillIds), [[a, c]]);
		// a lecture note: renamed and redated, then undone to its automatic title and old date
		const note = notes.createLectureNote(courseId, { date: "2026-11-24" })!;
		await runTurn(chatId, "What lectures do I have?", oneCall("lectures_list", {}, "ls"));
		assert.match(resultText(chatId, "ls"), new RegExp(`\\[${note.id}\\] ${note.title.replace(/[.]/g, "\\.")} · Tue 24 Nov 2026`));
		await runTurn(chatId, "Call that note Eigenvalues, it was Monday the 23rd.", oneCall("lecture_note_update", { noteId: note.id, title: "Eigenvalues", date: "2026-11-23" }, "n1"));
		assert.deepEqual([notes.getLectureNote(courseId, note.id)!.title, notes.getLectureNote(courseId, note.id)!.date], ["Eigenvalues", "2026-11-23"]);
		assert.equal((await statuses(chatId)).n1, "applied");
		assert.equal((await undo(chatId, "n1")).status, 200);
		const back = notes.getLectureNote(courseId, note.id)!;
		assert.deepEqual([back.title, back.titleBy, back.date], [note.title, "auto", "2026-11-24"]);
	});

	it("14. class_update keeps a long title whole through Undo and refuses a public language clear", async () => {
		const { courseId } = approvedCourse();
		const long = `Signals and systems: ${"a very long subtitle ".repeat(8)}`.trim();
		assert.ok(long.length > 120);
		assert.equal((await courseRoute.PATCH(json({ title: long }, "PATCH"), params({ id: courseId }))).status, 200);
		const chatId = askChat(courseId);
		await runTurn(chatId, "Rename it to Signals.", oneCall("class_update", { field: "title", value: "Signals" }, "t1"));
		assert.equal((await undo(chatId, "t1")).status, 200);
		assert.equal(getCourse(courseId).title, long, "restored whole");
		await runTurn(chatId, "Clear the language.", oneCall("class_update", { field: "language", value: null }, "l1"));
		assert.match(resultText(chatId, "l1"), /^Not changed: language must be en or nb/);
	});

	it("15. correcting the lecture on the page keeps the note Short question saved", async () => {
		const { courseId } = approvedCourse();
		const l1 = lectures.createLecture(courseId, { n: 1, date: inDays(-5) });
		const l2 = lectures.createLecture(courseId, { n: 2, date: inDays(-1) });
		assert.ok(l1.ok && l2.ok);
		lectures.setClassPosition(courseId, { lectureId: l2.value.id, note: "a week behind the syllabus" });
		const standing = courses.courseView(courseId)!.standing!;
		// the form opens with the note in it; changing only the lecture sends it along
		const body = positionBody({ lectureId: l1.value.id, covered: "", note: standing.position!.note ?? "" });
		assert.equal((await positionRoute.PUT(json(body, "PUT"), params({ id: courseId }))).status, 200);
		assert.deepEqual([L.sanitizeClassPosition(getCourse(courseId).classPosition)!.lectureId, L.sanitizeClassPosition(getCourse(courseId).classPosition)!.note], [l1.value.id, "a week behind the syllabus"]);
	});
});

// (a type use, so the import stays: messages are only read through the store)
export type _Unused = LhMessage;
