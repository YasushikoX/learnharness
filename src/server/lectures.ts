import { randomUUID } from "node:crypto";
import type { CourseRecord } from "../core/contracts.ts";
import { cleanLine, cleanSkillIds, isTombstone, upsertEntry, boundEntries, type Tombstone } from "../core/assessments.ts";
import { parseExamDate } from "../core/exam-plan.ts";
import {
	courseLectures,
	LECTURE_MATERIALS_MAX,
	LECTURE_TITLE_MAX,
	LECTURE_TOPICS_MAX,
	LECTURES_MAX,
	lectureLinkKey,
	linksFromCites,
	parseLectureNumber,
	POSITION_TEXT_MAX,
	readLectureEntries,
	sanitizeClassPosition,
	sanitizeLecture,
	type ClassPosition,
	type FileForLectures,
	type Lecture,
	type LectureEntry,
	type LectureSource,
	type LectureView,
} from "../core/lectures.ts";
import { DEFAULT_LESSON_LANGUAGE, type LessonLanguage } from "../core/language.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { mergeSkillLines } from "../core/skills.ts";
import { piEngineForSpec } from "../agent/models.ts";
import { linkSkillsToLectures } from "../agent/subagents/lecture-linker.ts";
import { stores } from "./stores.ts";

/**
 * The lecture timeline, the class position and the "link skills to lectures" step — the service seam (WP9, 2026-11-25;
 * core/lectures.ts; docs/courses.md "Lectures and where you stand"). The page's routes (app/api/courses/[id]/lectures/*,
 * class-position) and Short question's tools (through server/class-changes.ts) delegate here. Every write goes through
 * the course store, which stamps the record and announces courses-changed.
 */

type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

/** An ISO stamp strictly after `prev` (two writes in one millisecond still order), as server/assessments.ts's. */
function stampAfter(prev?: string): string {
	const now = Date.now();
	const p = prev ? Date.parse(prev) : NaN;
	return new Date(Number.isNaN(p) || now > p ? now : p + 1).toISOString();
}

/** A class's files as the lecture reader needs them. */
export function lectureFiles(courseId: string): FileForLectures[] {
	return stores.materialStore.list(courseId).map((m) => ({ id: m.id, name: m.name, ...(m.profile ? { profile: m.profile } : {}), addedAt: m.addedAt }));
}

/** A class's lectures as read (stored, plus those its files name). */
export function classLectures(course: CourseRecord): LectureView[] {
	return courseLectures(course, lectureFiles(course.id));
}

function writeLectures(courseId: string, entries: readonly LectureEntry[], extra: Partial<CourseRecord> = {}): CourseRecord {
	return stores.courseStore.updateCourse(courseId, { lectures: boundEntries(entries), ...extra })!;
}

// ─── lectures: create, update, delete ───────────────────────────────────────

/** What a create or update may carry (the API body, the chat tool, an approved proposal item). */
export interface LectureInput {
	n?: unknown;
	title?: unknown;
	/** "YYYY-MM-DD", or null to clear. */
	date?: unknown;
	topics?: unknown;
	materialIds?: unknown;
	skillIds?: unknown;
}

/** One change to the timeline, as the chat cards and Undo read it. */
export interface LectureChange {
	action: "added" | "updated" | "removed";
	before: Lecture | null;
	after: Lecture | null;
	id: string;
	stamp: string;
	/** The lecture was read from the class's files before this change: Undo returns it to that (the stored entry goes). */
	fromFiles?: true;
}

type CheckedLecture = { n?: number | null; title?: string; date?: string | null; topics?: string; materialIds?: string[]; skillIds?: string[] };

function checkLectureInput(input: LectureInput, course: CourseRecord, partial: boolean): Result<CheckedLecture> {
	const out: CheckedLecture = {};
	if (input.n !== undefined) {
		if (input.n === null || input.n === "") out.n = null;
		else {
			const n = parseLectureNumber(input.n);
			if (n === undefined) return { ok: false, status: 400, error: "n must be a whole number 0-999, or null" };
			out.n = n;
		}
	}
	if (input.title !== undefined || !partial) {
		const title = cleanLine(input.title, LECTURE_TITLE_MAX) || (typeof out.n === "number" ? `Lecture ${out.n}` : "");
		if (!title) return { ok: false, status: 400, error: `title must be 1 to ${LECTURE_TITLE_MAX} characters (or give n)` };
		out.title = title;
	}
	if (input.date !== undefined) {
		if (input.date === null || input.date === "") out.date = null;
		else {
			const date = parseExamDate(input.date);
			if (!date) return { ok: false, status: 400, error: "date must be a date like 2026-12-04, or null" };
			out.date = date;
		}
	}
	if (input.topics !== undefined) {
		if (typeof input.topics !== "string") return { ok: false, status: 400, error: "topics must be text" };
		out.topics = input.topics.trim().slice(0, LECTURE_TOPICS_MAX);
	}
	if (input.materialIds !== undefined) {
		if (!Array.isArray(input.materialIds)) return { ok: false, status: 400, error: "materialIds must be a list of file ids" };
		const own = new Set(stores.materialStore.list(course.id).map((m) => m.id));
		const ids = cleanSkillIds(input.materialIds).slice(0, LECTURE_MATERIALS_MAX);
		const stranger = ids.find((id) => !own.has(id));
		if (stranger) return { ok: false, status: 400, error: `${stranger} is not a file of this class` };
		out.materialIds = ids;
	}
	if (input.skillIds !== undefined) {
		if (!Array.isArray(input.skillIds)) return { ok: false, status: 400, error: "skillIds must be a list of skill ids" };
		const ids = cleanSkillIds(input.skillIds);
		const own = new Set(course.skills);
		const stranger = ids.find((id) => !own.has(id));
		if (stranger) return { ok: false, status: 400, error: `${stranger} is not a skill on this class's approved map` };
		out.skillIds = ids;
	}
	return { ok: true, value: out };
}

const newId = () => `lc_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const liveCount = (entries: readonly LectureEntry[]) => entries.filter((e) => !isTombstone(e)).length;
const FULL = `This class already has ${LECTURES_MAX} lectures: remove one first`;

function applyLecture(before: Lecture, v: CheckedLecture, source: LectureSource, prevStamp?: string): Lecture {
	const merged: Lecture = {
		...before,
		...(v.title ? { title: v.title } : {}),
		...(v.topics !== undefined ? { topics: v.topics } : {}),
		...(v.materialIds ? { materialIds: v.materialIds } : {}),
		...(v.skillIds ? { skillIds: v.skillIds, skillsBy: "learner" as const } : {}),
		source,
		updatedAt: stampAfter(prevStamp ?? before.updatedAt),
	};
	if (v.n === null) delete merged.n;
	else if (typeof v.n === "number") merged.n = v.n;
	if (v.date === null) delete merged.date;
	else if (v.date) merged.date = v.date;
	delete (merged as LectureView).derived;
	return sanitizeLecture(merged)!;
}

/** Add a lecture. Refused (409) when the class already has LECTURES_MAX. */
export function createLecture(courseId: string, input: LectureInput, source: LectureSource = "manual", cite?: string): Result<LectureChange> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	const checked = checkLectureInput(input, course, false);
	if (!checked.ok) return checked;
	const entries = readLectureEntries(course.lectures);
	if (liveCount(entries) >= LECTURES_MAX) return { ok: false, status: 409, error: FULL };
	const base: Lecture = { id: newId(), title: checked.value.title!, topics: "", materialIds: [], skillIds: [], source, updatedAt: stampAfter(), ...(cite ? { cite: cleanLine(cite, 200) } : {}) };
	const item = applyLecture(base, checked.value, source, base.updatedAt);
	if (!checked.value.skillIds) delete item.skillsBy;
	writeLectures(courseId, [...entries, item]);
	maybeLinkLectures(courseId);
	return { ok: true, value: { action: "added", before: null, after: item, id: item.id, stamp: item.updatedAt } };
}

/** Change a lecture (only the fields given). A lecture read from the files is stored under its own id from then on. */
export function updateLecture(courseId: string, id: string, input: LectureInput, source: LectureSource = "manual"): Result<LectureChange> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	const checked = checkLectureInput(input, course, true);
	if (!checked.ok) return checked;
	const view = classLectures(course).find((l) => l.id === id);
	if (!view) return { ok: false, status: 404, error: "Unknown lecture" };
	const entries = readLectureEntries(course.lectures);
	const held = entries.find((e) => e.id === id);
	const { derived: _derived, ...plain } = view;
	const before: Lecture = sanitizeLecture(plain)!;
	if (view.derived && held === undefined && liveCount(entries) >= LECTURES_MAX) return { ok: false, status: 409, error: FULL };
	// a lecture read from the files keeps "files" as its source; any other edit makes it the editor's
	const after = applyLecture(before, checked.value, view.source === "files" ? "files" : source, held?.updatedAt ?? before.updatedAt);
	writeLectures(courseId, upsertEntry<LectureEntry>(entries, after));
	return { ok: true, value: { action: "updated", before, after, id, stamp: after.updatedAt, ...(view.derived ? { fromFiles: true as const } : {}) } };
}

/** Delete a lecture: a tombstone (for a lecture read from the files too: it stays removed while the file is there). */
export function deleteLecture(courseId: string, id: string): Result<LectureChange> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	const view = classLectures(course).find((l) => l.id === id);
	if (!view) return { ok: false, status: 404, error: "Unknown lecture" };
	const entries = readLectureEntries(course.lectures);
	const held = entries.find((e) => e.id === id);
	const tomb: Tombstone = { id, deleted: true, updatedAt: stampAfter(held?.updatedAt ?? view.updatedAt) };
	const { derived, ...plain } = view;
	writeLectures(courseId, upsertEntry<LectureEntry>(entries, tomb), clearedPosition(course, id));
	return { ok: true, value: { action: "removed", before: sanitizeLecture(plain)!, after: null, id, stamp: tomb.updatedAt, ...(derived ? { fromFiles: true as const } : {}) } };
}

/** A removed lecture the class position named: the position goes back to the dates. */
function clearedPosition(course: CourseRecord, lectureId: string): Partial<CourseRecord> {
	const p = sanitizeClassPosition(course.classPosition);
	if (p?.lectureId !== lectureId) return {};
	const { lectureId: _gone, ...rest } = p;
	return { classPosition: rest.coveredThrough || rest.note ? { ...rest, updatedAt: stampAfter(p.updatedAt) } : undefined };
}

/** Undo a lecture change (the caller checked the timeline still holds exactly what it wrote). `fromFiles`: the lecture
 *  was read from the files, so undoing restores that by removing the stored entry. */
export function revertLectureChange(courseId: string, change: LectureChange): Result<true> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "The class was deleted" };
	const entries = readLectureEntries(course.lectures);
	const stamp = stampAfter(change.stamp);
	if (change.action === "added") {
		writeLectures(courseId, upsertEntry<LectureEntry>(entries, { id: change.id, deleted: true, updatedAt: stamp }));
	} else if (change.fromFiles) {
		// back to "read from the files": the stored entry (an edit or the removal's tombstone) goes
		writeLectures(courseId, entries.filter((e) => e.id !== change.id));
	} else if (change.before) {
		const restored = sanitizeLecture({ ...change.before, id: change.id, updatedAt: stamp });
		if (!restored) return { ok: false, status: 422, error: "This change cannot be undone" };
		writeLectures(courseId, upsertEntry<LectureEntry>(entries, restored));
	} else return { ok: false, status: 422, error: "This change cannot be undone" };
	return { ok: true, value: true };
}

// ─── the class position ─────────────────────────────────────────────────────

export interface PositionInput {
	lectureId?: unknown;
	coveredThrough?: unknown;
	note?: unknown;
}

/** Set the class position (what the learner said), or clear it (null: back to the lecture dates). */
export function setClassPosition(courseId: string, input: PositionInput | null): Result<{ before: ClassPosition | null; after: ClassPosition | null }> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	const before = sanitizeClassPosition(course.classPosition) ?? null;
	if (input === null) {
		stores.courseStore.updateCourse(courseId, { classPosition: undefined });
		return { ok: true, value: { before, after: null } };
	}
	let lectureId: string | undefined;
	if (input.lectureId !== undefined && input.lectureId !== null && input.lectureId !== "") {
		if (typeof input.lectureId !== "string" || !classLectures(course).some((l) => l.id === input.lectureId)) return { ok: false, status: 400, error: "lectureId must be a lecture of this class" };
		lectureId = input.lectureId;
	}
	const coveredThrough = cleanLine(input.coveredThrough, POSITION_TEXT_MAX);
	const note = cleanLine(input.note, POSITION_TEXT_MAX);
	if (!lectureId && !coveredThrough && !note) return { ok: false, status: 400, error: "give a lecture, what the class covered, or a note (or null to follow the lecture dates)" };
	const after: ClassPosition = { ...(lectureId ? { lectureId } : {}), ...(coveredThrough ? { coveredThrough } : {}), ...(note ? { note } : {}), updatedAt: stampAfter(before?.updatedAt) };
	stores.courseStore.updateCourse(courseId, { classPosition: after });
	return { ok: true, value: { before, after } };
}

// ─── "link skills to lectures" ──────────────────────────────────────────────

const LINK_KEY = Symbol.for("lh.courseLectureLinkRuns");
function linkRuns(): Map<string, AbortController> {
	const g = globalThis as Record<symbol, Map<string, AbortController> | undefined>;
	g[LINK_KEY] ??= new Map();
	return g[LINK_KEY];
}

/** How many linking runs are going (the idle check reads this). */
export const lectureLinkCount = (): number => linkRuns().size;
export const lectureLinking = (courseId: string): boolean => linkRuns().has(courseId);
export function abortLectureLinking(courseId: string): void {
	linkRuns().get(courseId)?.abort();
}

/** Test seam: the model step with an injected linker (no model). */
export type LectureLinker = typeof linkSkillsToLectures;
let linkerOverride: LectureLinker | null = null;
export function setLectureLinkerForTests(f: LectureLinker | null): void {
	linkerOverride = f;
}

function languageOf(course: CourseRecord): LessonLanguage {
	return course.language ?? stores.settingsStore.readSettings()?.general?.language ?? DEFAULT_LESSON_LANGUAGE;
}

/** Start linking when the lectures, their files or the skills changed since the last run (never in a loop: the run
 *  records what it saw, success or not). Quiet: nothing happens for a class with no skills or no lectures. */
export function maybeLinkLectures(courseId: string): void {
	const course = stores.courseStore.getCourse(courseId);
	if (!course || course.skills.length === 0 || linkRuns().has(courseId)) return;
	const lectures = classLectures(course);
	if (lectures.length === 0) return;
	if (lectureLinkKey(lectures, course.skills) === course.lecturesLinkedKey) return;
	startLectureLinking(courseId);
}

/** Start the step now (the page's "Place skills again"). Returns at once. */
export function startLectureLinking(courseId: string): Result<CourseRecord> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	if (course.skills.length === 0) return { ok: false, status: 409, error: "Approve the skill map first" };
	if (linkRuns().has(courseId)) return { ok: false, status: 409, error: "The skills are already being placed" };
	const controller = new AbortController();
	linkRuns().set(courseId, controller);
	void runLinking(courseId, controller).finally(() => linkRuns().delete(courseId));
	return { ok: true, value: course };
}

/** Add links (lecture id → skill ids) to the timeline as it is NOW: never to a lecture the learner set, never a skill off
 *  the map. A lecture read from the files is stored under its id. Returns the entries, or null when nothing changed. */
function withLinks(course: CourseRecord, add: ReadonlyMap<string, readonly string[]>): LectureEntry[] | null {
	const own = new Set(course.skills);
	let entries = readLectureEntries(course.lectures);
	let changed = false;
	for (const view of classLectures(course)) {
		const extra = (add.get(view.id) ?? []).filter((s) => own.has(s) && !view.skillIds.includes(s));
		if (extra.length === 0 || view.skillsBy === "learner") continue;
		const { derived: _d, ...plain } = view;
		const held = entries.find((e) => e.id === view.id);
		const next = sanitizeLecture({ ...plain, skillIds: [...view.skillIds, ...extra], skillsBy: "model", updatedAt: stampAfter(held?.updatedAt ?? view.updatedAt) });
		if (!next) continue;
		entries = upsertEntry<LectureEntry>(entries, next);
		changed = true;
	}
	return changed ? entries : null;
}

async function runLinking(courseId: string, controller: AbortController): Promise<void> {
	const start = stores.courseStore.getCourse(courseId);
	if (!start) return;
	const key = lectureLinkKey(classLectures(start), start.skills);
	const settle = (patch: Partial<CourseRecord>) => {
		if (stores.courseStore.getCourse(courseId)) stores.courseStore.updateCourse(courseId, { ...patch, lecturesLinkedKey: key, lecturesLinkedAt: new Date().toISOString() });
	};
	try {
		// 1. the draft's cites (no model call)
		const files = lectureFiles(courseId);
		const cited = linksFromCites(start.skillCites ?? {}, classLectures(start), files);
		const afterCites = withLinks(start, cited);
		if (afterCites) stores.courseStore.updateCourse(courseId, { lectures: boundEntries(afterCites) });
		// 2. one model pass for the skills still not placed
		const course = stores.courseStore.getCourse(courseId);
		if (!course || controller.signal.aborted) return;
		const lectures = classLectures(course);
		const placed = new Set(lectures.flatMap((l) => l.skillIds));
		const skills = mergeSkillLines(stores.skillStore.readSkillLines()).filter((s) => course.skills.includes(s.id) && !placed.has(s.id));
		if (skills.length === 0 || lectures.length === 0) {
			settle({ lecturesLinkError: undefined });
			return;
		}
		const spec = linkerOverride ? null : resolveRoleSpec("coursePlanner", stores.settingsStore.readSettings());
		if (!linkerOverride && !spec) {
			settle({ lecturesLinkError: "No model is configured for the class planner (Settings → Agent: the strong slot or a Class planner override)" });
			return;
		}
		const byFile = new Map(files.map((f) => [f.id, f]));
		const run = linkerOverride ?? linkSkillsToLectures;
		const links = await run(
			{
				title: course.title,
				language: languageOf(course),
				lectures: lectures.map((l) => ({
					id: l.id,
					label: l.title,
					...(l.date ? { date: l.date } : {}),
					topics: l.topics,
					files: l.materialIds.flatMap((m) => (byFile.has(m) ? [{ name: byFile.get(m)!.name, excerpt: (byFile.get(m)!.profile ?? "").slice(0, 600) }] : [])).slice(0, 3),
				})),
				skills: skills.map((s) => ({ id: s.id, name: s.name, statement: s.statement })),
			},
			{ engine: spec ? piEngineForSpec(spec) : undefined, signal: controller.signal, onStep: () => {}, courseId },
		);
		const fresh = stores.courseStore.getCourse(courseId);
		if (!fresh || controller.signal.aborted) return;
		const byLecture = new Map<string, string[]>();
		for (const [skill, ids] of links) for (const id of ids) byLecture.set(id, [...(byLecture.get(id) ?? []), skill]);
		const entries = withLinks(fresh, byLecture);
		settle({ ...(entries ? { lectures: boundEntries(entries) } : {}), lecturesLinkError: undefined });
	} catch (err) {
		if (controller.signal.aborted) return;
		settle({ lecturesLinkError: err instanceof Error ? err.message : String(err) });
	}
}

// ─── the syllabus proposal's lectures (approval: server/assessments.ts actOnProposal) ──

/** A new lecture from an approved proposal item (pure besides the id and stamp). */
export function lectureFromProposal(item: { n?: number; title: string; date?: string; topics: string; skillIds: string[]; cite: string }, own: ReadonlySet<string>, prevStamp?: string): Lecture {
	const skillIds = item.skillIds.filter((s) => own.has(s));
	return sanitizeLecture({
		id: newId(),
		...(item.n !== undefined ? { n: item.n } : {}),
		title: item.title,
		...(item.date ? { date: item.date } : {}),
		topics: item.topics,
		materialIds: [],
		skillIds,
		...(skillIds.length > 0 ? { skillsBy: "model" } : {}),
		source: "syllabus",
		updatedAt: stampAfter(prevStamp),
		cite: item.cite,
	})!;
}

/** An update of a syllabus lecture from an approved proposal item (its skills only when the item names some). */
export function lectureUpdateFromProposal(held: Lecture, item: { n?: number; title: string; date?: string; topics: string; skillIds: string[] }, own: ReadonlySet<string>): Lecture {
	const skillIds = item.skillIds.filter((s) => own.has(s));
	const next: Lecture = { ...held, title: item.title, topics: item.topics, updatedAt: stampAfter(held.updatedAt), ...(skillIds.length > 0 && held.skillsBy !== "learner" ? { skillIds, skillsBy: "model" as const } : {}) };
	if (item.n !== undefined) next.n = item.n;
	if (item.date) next.date = item.date;
	else delete next.date;
	return sanitizeLecture(next)!;
}
