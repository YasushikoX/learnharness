import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { CourseRecord } from "../core/contracts.ts";
import { courseAssessments, isTombstone, readAssessmentEntries, readSelfReportEntries, sameEntry, sanitizeAssessment, sortAssessments, upsertEntry, isUpcoming, type Assessment, type AssessmentEntry } from "../core/assessments.ts";
import { assessmentReadiness, classPositionOf, coveredLectures, lectureToday, readLectureEntries, sameLectureEntry, sanitizeClassPosition, type ClassPosition } from "../core/lectures.ts";
import { isLessonLanguage } from "../core/language.ts";
import { PACES, type Pace } from "../core/pace.ts";
import { sanitizeWeights, type SkillWeights } from "../core/exam-plan.ts";
import { mergeSkillLines } from "../core/skills.ts";
import { CLASS_CHANGE_TOOLS, type ClassChange, type ClassFactsPort, type ClassField, type WeightEntry } from "../agent/tools/class-facts.ts";
import { createAssessment, deleteAssessment, deleteSelfReport, learnerTimeZone, recordSelfReport, startAssessmentFind, updateAssessment, writeAssessmentEntries } from "./assessments.ts";
import { courseView, parseFolderField, renameCourse, setCourseFolder, setCourseLanguage, setCoursePace, setCourseSkillWeights } from "./courses.ts";
import { classLectures, createLecture, deleteLecture, revertLectureChange, setClassPosition, updateLecture } from "./lectures.ts";
import { stores } from "./stores.ts";

/**
 * Short question's class changes — the port its tools write through, the change cards' status and Undo (WP8; generalized
 * in WP9, 2026-11-25: lectures, the class position, skill weights and class settings; docs/courses.md). Every change is
 * read from the chat record (the tool result's `details.change`), never from the client, and Undo is offered only while
 * the class still holds exactly what the change wrote.
 */

type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

function courseSkills(course: CourseRecord): Array<{ id: string; name: string }> {
	const all = new Map(mergeSkillLines(stores.skillStore.readSkillLines()).map((s) => [s.id, s]));
	return course.skills.flatMap((id) => (all.has(id) ? [{ id, name: all.get(id)!.name }] : []));
}

/** A class setting's current value, as a change records it. */
function settingOf(course: CourseRecord, field: ClassField): string | null {
	switch (field) {
		case "title":
			return course.title;
		case "language":
			return course.language ?? null;
		case "pace":
			return course.pace ?? null;
		case "folder":
			return course.folder ?? null;
	}
}

/** Write one class setting through the class page's own setter. */
function writeSetting(courseId: string, field: ClassField, value: string | null): Result<CourseRecord> {
	const fail = (error: string): Result<CourseRecord> => ({ ok: false, status: 400, error });
	let out: CourseRecord | null;
	switch (field) {
		case "title":
			if (typeof value !== "string" || value.trim() === "") return fail("a title cannot be empty");
			out = renameCourse(courseId, value.trim().slice(0, 120));
			break;
		case "language":
			if (value === null) out = stores.courseStore.updateCourse(courseId, { language: undefined });
			else if (!isLessonLanguage(value)) return fail("language must be en or nb");
			else out = setCourseLanguage(courseId, value);
			break;
		case "pace":
			if (value !== null && !PACES.some((p) => p.id === value)) return fail(`pace must be ${PACES.map((p) => p.id).join(", ")}, or null for the default`);
			out = setCoursePace(courseId, (value ?? undefined) as Pace | undefined);
			break;
		case "folder": {
			const parsed = parseFolderField(value);
			if (!parsed.ok) return fail(parsed.error);
			out = setCourseFolder(courseId, parsed.folder);
			break;
		}
	}
	return out ? { ok: true, value: out } : { ok: false, status: 404, error: "Unknown course" };
}

const weightEntry = (weights: SkillWeights | undefined, id: string): WeightEntry => {
	const e = weights?.[id];
	return e ? { w: e.w, by: e.by, ...(e.reason ? { reason: e.reason } : {}) } : null;
};

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// ─── status and Undo ─────────────────────────────────────────────────────────

/** applied: the change is still what the class holds (Undo is offered) · changed: it was undone or changed since. */
export type ChangeStatus = "applied" | "changed";

/** Is the change still exactly what the class holds? Every field Undo would restore is compared. */
export function changeStatus(course: CourseRecord, change: ClassChange): ChangeStatus {
	switch (change.kind) {
		case "self-report": {
			const held = readSelfReportEntries(course.selfReports).find((e) => e.id === change.report.id);
			return held && !isTombstone(held) && held.updatedAt === change.report.updatedAt ? "applied" : "changed";
		}
		case "assessment": {
			if (!change.stamp) return "changed";
			const held = readAssessmentEntries(course.assessments).find((e) => e.id === change.id);
			const expected: AssessmentEntry | null = change.after ?? { id: change.id, deleted: true, updatedAt: change.stamp };
			if (!sameEntry(held, expected)) return "changed";
			if (change.before?.legacy && course.examDate) return "changed";
			return "applied";
		}
		case "lecture": {
			const held = readLectureEntries(course.lectures).find((e) => e.id === change.id);
			return sameLectureEntry(held, change.after ?? { id: change.id, deleted: true, updatedAt: change.stamp }) ? "applied" : "changed";
		}
		case "position":
			return same(sanitizeClassPosition(course.classPosition), change.after) ? "applied" : "changed";
		case "weights": {
			const weights = sanitizeWeights(course.skillWeights);
			return Object.entries(change.after).every(([id, e]) => same(weightEntry(weights, id), e)) ? "applied" : "changed";
		}
		case "setting":
			return settingOf(course, change.field) === change.after ? "applied" : "changed";
	}
}

/** One tool result's change, read from the chat record (never from the client). */
function changeIn(chatId: string, toolCallId: string): { courseId: string; change: ClassChange } | null {
	const chat = stores.chatStore.getChat(chatId);
	const courseId = chat?.course?.mode === "ask" ? chat.course.courseId : null;
	if (!chat || !courseId) return null;
	const result = chat.messages.find((m) => (m as { role?: string }).role === "toolResult" && (m as ToolResultMessage).toolCallId === toolCallId) as ToolResultMessage | undefined;
	if (!result || result.isError || !CLASS_CHANGE_TOOLS.includes(result.toolName)) return null;
	const change = (result.details as { change?: ClassChange } | undefined)?.change;
	return change && typeof change === "object" && typeof change.kind === "string" ? { courseId, change } : null;
}

/** GET /api/chats/[id]/class-changes: every change card's status in one request. */
export function classChangeStatuses(chatId: string): Record<string, ChangeStatus> {
	const chat = stores.chatStore.getChat(chatId);
	if (chat?.course?.mode !== "ask") return {};
	const course = stores.courseStore.getCourse(chat.course.courseId);
	const out: Record<string, ChangeStatus> = {};
	for (const m of chat.messages) {
		const r = m as ToolResultMessage;
		if ((m as { role?: string }).role !== "toolResult" || r.isError || !CLASS_CHANGE_TOOLS.includes(r.toolName)) continue;
		const change = (r.details as { change?: ClassChange } | undefined)?.change;
		if (!change || typeof change.kind !== "string") continue;
		out[r.toolCallId] = course ? changeStatus(course, change) : "changed";
	}
	return out;
}

/** Undo exactly one change a Short question card shows. Refused (409) when the class changed since: Undo never clobbers a
 *  later edit. */
export function undoClassChange(chatId: string, toolCallId: string): Result<{ status: "undone" }> {
	const found = changeIn(chatId, toolCallId);
	if (!found) return { ok: false, status: 404, error: "No change to undo" };
	const { courseId, change } = found;
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "The class was deleted" };
	if (changeStatus(course, change) !== "applied") return { ok: false, status: 409, error: "This was already undone or changed since" };
	const done = { ok: true as const, value: { status: "undone" as const } };
	switch (change.kind) {
		case "self-report": {
			const out = deleteSelfReport(courseId, change.report.id);
			return out.ok ? done : out;
		}
		case "lecture": {
			const out = revertLectureChange(courseId, change);
			return out.ok ? done : out;
		}
		case "position":
			stores.courseStore.updateCourse(courseId, { classPosition: change.before ?? undefined });
			return done;
		case "weights": {
			const next: SkillWeights = { ...(sanitizeWeights(course.skillWeights) ?? {}) };
			for (const [id, e] of Object.entries(change.before)) {
				if (e === null) delete next[id];
				else next[id] = { w: e.w, by: e.by, ...(e.reason ? { reason: e.reason } : {}) };
			}
			stores.courseStore.updateCourse(courseId, { skillWeights: Object.keys(next).length > 0 ? next : undefined });
			return done;
		}
		case "setting": {
			const out = writeSetting(courseId, change.field, change.before);
			return out.ok ? done : out;
		}
		case "assessment":
			break;
	}
	const entries = readAssessmentEntries(course.assessments);
	const stampAfter = (prev: string) => new Date(Math.max(Date.now(), Date.parse(prev) + 1)).toISOString();
	if (change.before?.legacy) {
		// the old exam date comes back; the entry the change wrote (the item that replaced it, or the deletion's
		// tombstone) is superseded by a newer tombstone, so this card no longer holds
		writeAssessmentEntries(courseId, upsertEntry<AssessmentEntry>(entries, { id: change.id, deleted: true, updatedAt: stampAfter(change.stamp) }), { examDate: change.before.date });
		return done;
	}
	const before = change.before ? sanitizeAssessment(change.before) : null;
	if (change.action === "added") {
		writeAssessmentEntries(courseId, upsertEntry<AssessmentEntry>(entries, { id: change.id, deleted: true, updatedAt: stampAfter(change.stamp) }));
	} else if (before) {
		writeAssessmentEntries(courseId, upsertEntry<AssessmentEntry>(entries, { ...before, id: change.id, updatedAt: stampAfter(change.stamp) }));
	} else return { ok: false, status: 422, error: "This change cannot be undone" };
	return done;
}

// ─── the port Short question's tools write through ───────────────────────────

/** The port the Ask agent's class tools use, bound to one Ask conversation. Null when the chat is not an Ask chat of a
 *  class that still exists. */
export function classFactsPort(chatId: string): ClassFactsPort | null {
	const chat = stores.chatStore.getChat(chatId);
	if (chat?.course?.mode !== "ask") return null;
	const courseId = chat.course.courseId;
	const course = () => stores.courseStore.getCourse(courseId);
	if (!course()) return null;
	const names = (c: CourseRecord) => new Map(courseSkills(c).map((s) => [s.id, s.name]));
	const withNames = (c: CourseRecord, ids: readonly string[]) => ids.map((id) => names(c).get(id) ?? id);
	const today = () => lectureToday(Date.now(), learnerTimeZone(chatId));
	const lectureTitle = (c: CourseRecord, id: string | undefined) => (id ? (classLectures(c).find((l) => l.id === id)?.title ?? null) : null);
	return {
		now: () => Date.now(),
		timeZone: () => learnerTimeZone(chatId),
		hasSkills: () => (course()?.skills.length ?? 0) > 0,
		list: () => {
			const c = course();
			return c ? { assessments: sortAssessments(courseAssessments(c)), skills: courseSkills(c) } : { assessments: [], skills: [] };
		},
		save: (id, input) => {
			const out = id ? updateAssessment(courseId, id, input, "chat") : createAssessment(courseId, input, "chat");
			if (!out.ok) return { ok: false, error: out.error };
			const a: Assessment | null = out.value.after ?? out.value.before;
			return { ok: true, change: { kind: "assessment", courseId, ...out.value, skillNames: withNames(course()!, a?.skillIds ?? []) } };
		},
		remove: (id) => {
			const out = deleteAssessment(courseId, id);
			if (!out.ok) return { ok: false, error: out.error };
			return { ok: true, change: { kind: "assessment", courseId, ...out.value, skillNames: withNames(course()!, out.value.before?.skillIds ?? []) } };
		},
		selfReport: (input) => {
			const out = recordSelfReport(courseId, { ...input, chatId });
			if (!out.ok) return { ok: false, error: out.error };
			return { ok: true, change: { kind: "self-report", courseId, report: out.value, skillNames: withNames(course()!, out.value.skillIds) } };
		},
		findInSyllabus: () => {
			const out = startAssessmentFind(courseId);
			return out.ok ? { ok: true } : { ok: false, error: out.error };
		},
		// WP9
		lectures: () => {
			const c = course();
			if (!c) return { lectures: [], position: null, files: {}, skills: [] };
			const lectures = classLectures(c);
			const position = classPositionOf(lectures, sanitizeClassPosition(c.classPosition), today());
			const at = position?.lectureId ? lectures.find((l) => l.id === position.lectureId) : undefined;
			const files: Record<string, string> = {};
			for (const m of stores.materialStore.list(courseId)) files[m.id] = m.name;
			return { lectures, position: position ? { ...position, ...(at ? { label: at.title } : {}), ...(at?.date ? { date: at.date } : {}) } : null, files, skills: courseSkills(c) };
		},
		saveLecture: (id, input) => {
			const out = id ? updateLecture(courseId, id, input, "chat") : createLecture(courseId, input, "chat");
			if (!out.ok) return { ok: false, error: out.error };
			const l = out.value.after ?? out.value.before;
			return { ok: true, change: { kind: "lecture", courseId, ...out.value, skillNames: withNames(course()!, l?.skillIds ?? []) } };
		},
		removeLecture: (id) => {
			const out = deleteLecture(courseId, id);
			if (!out.ok) return { ok: false, error: out.error };
			return { ok: true, change: { kind: "lecture", courseId, ...out.value, skillNames: withNames(course()!, out.value.before?.skillIds ?? []) } };
		},
		setPosition: (input) => {
			const out = setClassPosition(courseId, input);
			if (!out.ok) return { ok: false, error: out.error };
			const c = course()!;
			const { before, after } = out.value as { before: ClassPosition | null; after: ClassPosition | null };
			return { ok: true, change: { kind: "position", courseId, before, after, label: lectureTitle(c, after?.lectureId), beforeLabel: lectureTitle(c, before?.lectureId) } };
		},
		setWeights: (edits) => {
			const c = course()!;
			const weights = sanitizeWeights(c.skillWeights);
			const before: Record<string, WeightEntry> = {};
			for (const id of Object.keys(edits)) before[id] = weightEntry(weights, id);
			const out = setCourseSkillWeights(courseId, edits);
			if (!out.ok) return { ok: false, error: out.error };
			const now = sanitizeWeights(out.value.skillWeights);
			const after: Record<string, WeightEntry> = {};
			for (const id of Object.keys(edits)) after[id] = weightEntry(now, id);
			return { ok: true, change: { kind: "weights", courseId, before, after, names: Object.fromEntries(names(c)) } };
		},
		update: (field, value) => {
			const before = settingOf(course()!, field);
			const out = writeSetting(courseId, field, value);
			if (!out.ok) return { ok: false, error: out.error };
			return { ok: true, change: { kind: "setting", courseId, field, before, after: settingOf(out.value, field) } };
		},
		overview: () => {
			const view = courseView(courseId);
			const standing = view?.standing ?? null;
			const learned = new Set((view?.skills ?? []).filter((s) => s.learned).map((s) => s.id));
			const order = (view?.skills ?? []).map((s) => s.id);
			const names = Object.fromEntries((view?.skills ?? []).map((s) => [s.id, s.name]));
			const c = course();
			if (!c || !standing) return { standing, upcoming: [], names };
			const covered = coveredLectures(standing.lectures, standing.position);
			const upcoming = courseAssessments(c)
				.filter((a): a is Assessment & { date: string } => isUpcoming(a, Date.now()))
				.slice(0, 3)
				.map((a) => assessmentReadiness(a, standing.lectures, covered, (id) => learned.has(id), order));
			return { standing, upcoming, names };
		},
	};
}
