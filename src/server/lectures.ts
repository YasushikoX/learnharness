import { randomUUID } from "node:crypto";
import type { CourseRecord } from "../core/contracts.ts";
import { cleanLine, cleanSkillIds, isTombstone, todayIn, upsertEntry, boundEntries } from "../core/assessments.ts";
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
	positionRecord,
	readLectureEntries,
	sanitizeClassPosition,
	sanitizeLecture,
	type ClassPosition,
	type ClearedPosition,
	type FileForLectures,
	type Lecture,
	type LectureEntry,
	type LectureSource,
	type LectureTombstone,
	type LectureView,
} from "../core/lectures.ts";
import { DEFAULT_LESSON_LANGUAGE, type LessonLanguage } from "../core/language.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { mergeSkillLines } from "../core/skills.ts";
import { piEngineForSpec } from "../agent/models.ts";
import { linkSkillsToLectures, type LinkerInput } from "../agent/subagents/lecture-linker.ts";
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

/** The stored class position as one revision (a cleared one included), or null when none is stored. */
export type PositionRevision = ClassPosition | ClearedPosition | null;

/** One change to the timeline, as the chat cards and Undo read it. */
export interface LectureChange {
	action: "added" | "updated" | "removed";
	before: Lecture | null;
	after: Lecture | null;
	id: string;
	stamp: string;
	/** The lecture was read from the class's files before this change (the card says so). */
	fromFiles?: true;
	/** The class position this change moved too (a removed lecture the position named): Undo restores it in the same
	 *  write, and only while the position is still exactly `after` (review 1, finding 1). */
	position?: { before: PositionRevision; after: PositionRevision };
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
	// review 1, finding 6: a new lecture with no skills chosen is not the learner's "no skills": the linking step places them
	if (!checked.value.skillIds?.length) delete item.skillsBy;
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

/** Delete a lecture: a tombstone (for a lecture read from the files too: it stays removed while the file is there). The
 *  lectures its files' names also read as (the same number) are hidden by the tombstone, so it does not come straight
 *  back under a file's id (review 1, finding 3); the files themselves are untouched. */
export function deleteLecture(courseId: string, id: string): Result<LectureChange> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	const view = classLectures(course).find((l) => l.id === id);
	if (!view) return { ok: false, status: 404, error: "Unknown lecture" };
	const entries = readLectureEntries(course.lectures);
	const held = entries.find((e) => e.id === id);
	const tomb: LectureTombstone = { id, deleted: true, updatedAt: stampAfter(held?.updatedAt ?? view.updatedAt), ...(view.joined?.length ? { files: view.joined } : {}) };
	const { derived, joined: _joined, ...plain } = view;
	const moved = clearedPosition(course, id);
	writeLectures(courseId, upsertEntry<LectureEntry>(entries, tomb), moved ? { classPosition: moved.after as ClassPosition } : {});
	return { ok: true, value: { action: "removed", before: sanitizeLecture(plain)!, after: null, id, stamp: tomb.updatedAt, ...(derived ? { fromFiles: true as const } : {}), ...(moved ? { position: moved } : {}) } };
}

/** A removed lecture the class position named: the position keeps the learner's words without it, or is cleared (a
 *  revision, so it wins a sync over an older statement). Null when the position does not name it. */
function clearedPosition(course: CourseRecord, lectureId: string): { before: PositionRevision; after: PositionRevision } | null {
	const before = positionRecord(course.classPosition) ?? null;
	const p = sanitizeClassPosition(course.classPosition);
	if (!before || p?.lectureId !== lectureId) return null;
	const { lectureId: _gone, ...rest } = p;
	const updatedAt = stampAfter(p.updatedAt);
	return { before, after: rest.coveredThrough || rest.note ? { ...rest, saidOn: rest.saidOn ?? todayIn(Date.parse(p.updatedAt)), updatedAt } : { updatedAt } };
}

/** A position revision written again with a fresh merge stamp (Undo): what was said keeps the day it was said
 *  (`saidOn`); "none" becomes a cleared revision. Review 1, finding 4. */
function restoredPosition(rev: PositionRevision, prev: string | undefined): ClassPosition | ClearedPosition {
	const updatedAt = stampAfter(prev);
	const said = rev ? sanitizeClassPosition(rev) : undefined;
	return said ? { ...said, saidOn: said.saidOn ?? todayIn(Date.parse(said.updatedAt)), updatedAt } : { updatedAt };
}

/** Undo a lecture change (the caller checked the timeline, and the position when the change moved it, still hold exactly
 *  what it wrote). The lecture and the position are restored in ONE write with fresh revisions, so the Undo wins a sync
 *  over the change it undoes (review 1, findings 1 and 2). A lecture read from the files comes back as it was shown,
 *  stored under its id: it does not depend on the file still being named the same. */
export function revertLectureChange(courseId: string, change: LectureChange): Result<true> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "The class was deleted" };
	const entries = readLectureEntries(course.lectures);
	const stamp = stampAfter(change.stamp);
	const position = change.position ? { classPosition: restoredPosition(change.position.before, positionRecord(course.classPosition)?.updatedAt) as ClassPosition } : {};
	if (change.action === "added") {
		writeLectures(courseId, upsertEntry<LectureEntry>(entries, { id: change.id, deleted: true, updatedAt: stamp }), position);
	} else if (change.before) {
		const restored = sanitizeLecture({ ...change.before, id: change.id, updatedAt: stamp });
		if (!restored) return { ok: false, status: 422, error: "This change cannot be undone" };
		writeLectures(courseId, upsertEntry<LectureEntry>(entries, restored), position);
	} else return { ok: false, status: 422, error: "This change cannot be undone" };
	return { ok: true, value: true };
}

// ─── the class position ─────────────────────────────────────────────────────

export interface PositionInput {
	lectureId?: unknown;
	coveredThrough?: unknown;
	note?: unknown;
}

/** One position change, as the chat card and Undo read it: what is shown (`before`, `after`) and the revisions written
 *  (`beforeRev`, `afterRev`; a clear has one too). */
export interface PositionChange {
	before: ClassPosition | null;
	after: ClassPosition | null;
	beforeRev: PositionRevision;
	afterRev: ClassPosition | ClearedPosition;
}

/** Set the class position (what the learner said), or clear it (null: back to the lecture dates). `timeZone`: the
 *  learner's (the request's X-LH-Time-Zone, the chat's), for the day it was said (review 1, finding 10). Every write is a
 *  fresh revision, a clear included (finding 4). */
export function setClassPosition(courseId: string, input: PositionInput | null, timeZone?: string): Result<PositionChange> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	const beforeRev = positionRecord(course.classPosition) ?? null;
	const before = sanitizeClassPosition(course.classPosition) ?? null;
	if (input === null) {
		const afterRev: ClearedPosition = { updatedAt: stampAfter(beforeRev?.updatedAt) };
		stores.courseStore.updateCourse(courseId, { classPosition: afterRev as ClassPosition });
		return { ok: true, value: { before, after: null, beforeRev, afterRev } };
	}
	let lectureId: string | undefined;
	if (input.lectureId !== undefined && input.lectureId !== null && input.lectureId !== "") {
		if (typeof input.lectureId !== "string" || !classLectures(course).some((l) => l.id === input.lectureId)) return { ok: false, status: 400, error: "lectureId must be a lecture of this class" };
		lectureId = input.lectureId;
	}
	const coveredThrough = cleanLine(input.coveredThrough, POSITION_TEXT_MAX);
	const note = cleanLine(input.note, POSITION_TEXT_MAX);
	if (!lectureId && !coveredThrough && !note) return { ok: false, status: 400, error: "give a lecture, what the class covered, or a note (or null to follow the lecture dates)" };
	const now = Date.now();
	const after: ClassPosition = { ...(lectureId ? { lectureId } : {}), ...(coveredThrough ? { coveredThrough } : {}), ...(note ? { note } : {}), saidOn: todayIn(now, timeZone), updatedAt: stampAfter(beforeRev?.updatedAt) };
	stores.courseStore.updateCourse(courseId, { classPosition: after });
	return { ok: true, value: { before, after, beforeRev, afterRev: after } };
}

/** Undo a position change (the caller checked the position is still exactly `afterRev`): `beforeRev` again, with a fresh
 *  revision and the day it was first said. */
export function revertPositionChange(courseId: string, change: Pick<PositionChange, "beforeRev">): Result<true> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "The class was deleted" };
	stores.courseStore.updateCourse(courseId, { classPosition: restoredPosition(change.beforeRev, positionRecord(course.classPosition)?.updatedAt) as ClassPosition });
	return { ok: true, value: true };
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

/** What one linking run reads and would write, for the class as it is now (review 1, finding 7).
 *  - `key`: the fingerprint of everything the run reads AND the placements as they stand. A run starts only when it
 *    differs from the one the last run settled with; a reply whose class changed while it ran is discarded.
 *  - `stale`: lectures whose model-placed skills were placed from evidence that has changed since (their title, date,
 *    topics, files, or the skills' names and statements): their skills are placed again. The learner's never are.
 *  - `cited`, `toModel`: the draft's cites for the skills not placed, and the rest, for the one model call. */
interface LinkPlan {
	key: string;
	lectures: LinkerInput["lectures"];
	toModel: Array<{ id: string; name: string; statement: string }>;
	cited: Map<string, string[]>;
	stale: Set<string>;
	lectureKey: (l: LectureView, skillIds: readonly string[]) => string;
}

function linkPlan(course: CourseRecord): LinkPlan {
	const files = lectureFiles(course.id);
	const byFile = new Map(files.map((f) => [f.id, f]));
	const lectures = classLectures(course);
	const own = new Set(course.skills);
	const info = new Map(
		mergeSkillLines(stores.skillStore.readSkillLines())
			.filter((s) => own.has(s.id))
			.map((s) => [s.id, { id: s.id, name: s.name, statement: s.statement }]),
	);
	const payload = (l: LectureView): LinkerInput["lectures"][number] => ({
		id: l.id,
		label: l.title,
		...(l.date ? { date: l.date } : {}),
		topics: l.topics,
		files: l.materialIds.flatMap((m) => (byFile.has(m) ? [{ name: byFile.get(m)!.name, excerpt: (byFile.get(m)!.profile ?? "").slice(0, 600) }] : [])).slice(0, 3),
	});
	const lectureKey = (l: LectureView, skillIds: readonly string[]) => lectureLinkKey({ lecture: payload(l), skills: skillIds.map((id) => info.get(id) ?? id) });
	const stale = new Set(lectures.filter((l) => l.skillsBy === "model" && l.skillsKey !== undefined && l.skillsKey !== lectureKey(l, l.skillIds)).map((l) => l.id));
	const placed = new Set(lectures.filter((l) => !stale.has(l.id)).flatMap((l) => l.skillIds));
	const cites = Object.fromEntries(Object.entries(course.skillCites ?? {}).filter(([id]) => own.has(id) && !placed.has(id)));
	const open = lectures.filter((l) => l.skillsBy !== "learner");
	const cited = linksFromCites(cites, open, files);
	const citedSkills = new Set([...cited.values()].flat());
	const toModel = course.skills.filter((id) => !placed.has(id) && !citedSkills.has(id) && info.has(id)).map((id) => info.get(id)!);
	const key = lectureLinkKey({
		lectures: lectures.map(payload),
		skills: course.skills.map((id) => info.get(id) ?? id),
		cites: Object.entries(course.skillCites ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
		placed: lectures.map((l) => [l.id, l.skillsBy ?? "", l.skillIds, l.skillsKey ?? ""]),
	});
	return { key, lectures: lectures.map(payload), toModel, cited, stale, lectureKey };
}

/** The current fingerprint (the screenshot fixture settles a class with it). */
export function lectureLinkKeyOf(courseId: string): string | null {
	const course = stores.courseStore.getCourse(courseId);
	return course ? linkPlan(course).key : null;
}

/** Start linking when anything the step reads, or the placements, changed since the last run (never in a loop: the run
 *  records the fingerprint of the class as it left it, success or not). Quiet: nothing happens for a class with no skills
 *  or no lectures. Started by the page's read of the class and by a lecture or approval write, never by Short question's
 *  read-only overview (review 1, finding 5). */
export function maybeLinkLectures(courseId: string): void {
	const course = stores.courseStore.getCourse(courseId);
	if (!course || course.skills.length === 0 || linkRuns().has(courseId)) return;
	if (classLectures(course).length === 0) return;
	if (linkPlan(course).key === course.lecturesLinkedKey) return;
	startLectureLinking(courseId);
}

/** Has anything the linking step reads changed since its last run (Short question's overview says so, read-only)? */
export function lectureLinksStale(course: CourseRecord): boolean {
	return course.skills.length > 0 && classLectures(course).length > 0 && (linkRuns().has(course.id) || linkPlan(course).key !== course.lecturesLinkedKey);
}

/** Start the step now (the page's "Place skills again"). Returns at once. A run whose reply came back for a class that has
 *  changed since starts again on the class as it is now. */
export function startLectureLinking(courseId: string): Result<CourseRecord> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	if (course.skills.length === 0) return { ok: false, status: 409, error: "Approve the skill map first" };
	if (linkRuns().has(courseId)) return { ok: false, status: 409, error: "The skills are already being placed" };
	const controller = new AbortController();
	linkRuns().set(courseId, controller);
	void runLinking(courseId, controller).then(
		(again) => {
			linkRuns().delete(courseId);
			if (again && !controller.signal.aborted) maybeLinkLectures(courseId);
		},
		() => linkRuns().delete(courseId),
	);
	return { ok: true, value: course };
}

/** Write a run's placements to the timeline as it is NOW: never to a lecture the learner set, never a skill off the map.
 *  A stale lecture's model skills are replaced (kept when the run failed: WP9 re-check 1); any other lecture's are added to. A lecture read from the files is stored
 *  under its id. Returns the entries, or null when nothing changed. */
function withLinks(course: CourseRecord, plan: LinkPlan, add: ReadonlyMap<string, readonly string[]>, keepStale = false): LectureEntry[] | null {
	const own = new Set(course.skills);
	let entries = readLectureEntries(course.lectures);
	let changed = false;
	for (const view of classLectures(course)) {
		if (view.skillsBy === "learner") continue;
		// a failed run (no model, an error) keeps a stale lecture's skills: clearing them would lose placements nothing re-makes
		const stale = !keepStale && plan.stale.has(view.id);
		const base = stale ? [] : view.skillIds;
		const next = [...new Set([...base, ...(add.get(view.id) ?? []).filter((s) => own.has(s))])];
		if (!stale && next.length === view.skillIds.length) continue;
		const { derived: _d, joined: _j, ...plain } = view;
		const held = entries.find((e) => e.id === view.id);
		const item = sanitizeLecture({ ...plain, skillIds: next, skillsBy: next.length > 0 ? "model" : undefined, skillsKey: undefined, updatedAt: stampAfter(held?.updatedAt ?? view.updatedAt) });
		if (!item) continue;
		if (item.skillIds.length > 0) item.skillsKey = plan.lectureKey(view, item.skillIds);
		if (!held && item.skillIds.length === 0) continue; // a derived lecture with nothing placed stays derived
		entries = upsertEntry<LectureEntry>(entries, item);
		changed = true;
	}
	return changed ? entries : null;
}

/** One run. Returns true when its reply was discarded because the class changed while it ran (the caller starts again). */
async function runLinking(courseId: string, controller: AbortController): Promise<boolean> {
	const start = stores.courseStore.getCourse(courseId);
	if (!start) return false;
	const plan = linkPlan(start);
	/** Write the placements (unless the class changed since the plan) and record the fingerprint the class is left with. */
	const settle = (links: ReadonlyMap<string, readonly string[]>, patch: Partial<CourseRecord>, failed = false): boolean => {
		const fresh = stores.courseStore.getCourse(courseId);
		if (!fresh) return false;
		if (linkPlan(fresh).key !== plan.key) return true; // obsolete: discarded, run again on the class as it is
		const entries = withLinks(fresh, plan, links, failed);
		const written = entries ? stores.courseStore.updateCourse(courseId, { lectures: boundEntries(entries) })! : fresh;
		stores.courseStore.updateCourse(courseId, { ...patch, lecturesLinkedKey: linkPlan(written).key, lecturesLinkedAt: new Date().toISOString() });
		return false;
	};
	const merged = (extra: ReadonlyMap<string, readonly string[]>) => {
		const out = new Map<string, string[]>([...plan.cited].map(([k, v]) => [k, [...v]]));
		for (const [id, skills] of extra) out.set(id, [...new Set([...(out.get(id) ?? []), ...skills])]);
		return out;
	};
	try {
		// 1. the draft's cites (no model call), and the stale lectures' skills, when nothing is left for the model
		if (plan.toModel.length === 0 || plan.lectures.length === 0) return settle(plan.cited, { lecturesLinkError: undefined });
		const spec = linkerOverride ? null : resolveRoleSpec("coursePlanner", stores.settingsStore.readSettings());
		if (!linkerOverride && !spec) {
			return settle(plan.cited, { lecturesLinkError: "No model is configured for the class planner (Settings → Agent: the strong slot or a Class planner override)" }, true);
		}
		// 2. one model pass for the skills still not placed
		const run = linkerOverride ?? linkSkillsToLectures;
		const links = await run(
			{ title: start.title, language: languageOf(start), lectures: plan.lectures, skills: plan.toModel },
			{ engine: spec ? piEngineForSpec(spec) : undefined, signal: controller.signal, onStep: () => {}, courseId },
		);
		if (controller.signal.aborted) return false;
		const byLecture = new Map<string, string[]>();
		for (const [skill, ids] of links) for (const id of ids) byLecture.set(id, [...(byLecture.get(id) ?? []), skill]);
		return settle(merged(byLecture), { lecturesLinkError: undefined });
	} catch (err) {
		if (controller.signal.aborted) return false;
		return settle(plan.cited, { lecturesLinkError: err instanceof Error ? err.message : String(err) }, true);
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
