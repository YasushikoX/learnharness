/**
 * The lecture timeline and "where you stand" (WP9, 2026-11-25; docs/courses.md "Lectures and where you stand"). PURE,
 * browser-safe.
 *
 * A class carries a list of LECTURES (`CourseRecord.lectures`): a number, a title, a date, the topics, the class files
 * that belong to it and the approved skills it teaches. They come from four places: the syllabus pass ("syllabus",
 * approved by the learner with the assessments), the class's own file names ("files", read here without a model call),
 * Short question ("chat") and the class page ("manual"). The list follows WP8's assessment rules exactly
 * (core/assessments.ts): sanitized on read, capped, one entry per id with the later `updatedAt` winning, deletions kept
 * as tombstones capped by count, and a three-way sync against the last synced copy (`mergeEntries`).
 *
 * LECTURES FROM FILES are DERIVED on read, never written by a read (`lecturesFromFiles`): "Lecture 8.pdf", "L08 slides",
 * "Week 5", "Forelesning 3" and a date in the name ("2026-11-24", "24.11.2026"), or the same at the start of the file's
 * profile. Each gets a stable id from what it is (`lf_lecture_8`, `lf_week_5`, `lf_d_2026-11-24`), the same on every
 * device, so the learner removes one with an ordinary tombstone and edits one by storing an item under that id, as the
 * old exam date works in WP8. A derived lecture whose number (or date) a stored lecture already has is not shown twice:
 * its files join that lecture.
 *
 * THE CLASS POSITION (`classPosition`) is how far the CLASS has got, not the learner. Explicit when the learner says it
 * ("we covered chapter 6 today", "we're on lecture 9"); otherwise derived (`classPositionOf`): the last lecture whose date
 * is on or before today; with no dated lecture, the highest-numbered lecture that has a file.
 *
 * WHERE YOU STAND (`whereYouStand`) puts the two together with the learner's mastery: what the class has covered, the
 * longest run of lectures whose skills are all learned, the next assessment's readiness, and the most urgent gap.
 */

import {
	addDays,
	cleanLine,
	cleanSkillIds,
	isTombstone,
	readEntries,
	todayIn,
	type Assessment,
	type Tombstone,
} from "./assessments.ts";
import { examDateLabel, parseExamDate } from "./exam-plan.ts";
import { dayLabel } from "./dates.ts";

export type LectureSource = "syllabus" | "files" | "chat" | "manual";

/** One lecture. */
export interface Lecture {
	/** "lc_" + random; "lf_…" for a lecture first read from the class's file names. */
	id: string;
	/** Its number in the class ("Lecture 8" → 8), when it has one. */
	n?: number;
	title: string;
	/** "YYYY-MM-DD"; absent when nobody knows it. */
	date?: string;
	/** Free text, as the syllabus or the learner put it. */
	topics: string;
	/** The class files that belong to it (material ids). */
	materialIds: string[];
	/** The approved skills it teaches (WP9 "link skills to lectures"); [] = none placed yet. */
	skillIds: string[];
	/** Who set `skillIds`: the linking pass ("model") or the learner (the page, or Short question). The pass never changes
	 *  a lecture the learner set. Absent = nobody yet. */
	skillsBy?: "model" | "learner";
	/** With `skillsBy` "model" from the linking pass: the fingerprint of what the pass read for this lecture (its title,
	 *  date, topics, files, and its skills' names and statements). When that changes, the pass places this lecture's skills
	 *  again (review 1, finding 7). Absent (the syllabus's, or from before): kept as they are. */
	skillsKey?: string;
	source: LectureSource;
	/** ISO — the last write; the sync merge keeps the later one per id. */
	updatedAt: string;
	/** Where the syllabus says it ("Syllabus.pdf p. 2"). */
	cite?: string;
}

/** A lecture's deletion. `files`: the ids of the lectures read from the class's file names that had joined it (the same
 *  number, or date) when it was removed: they stay hidden while this tombstone holds, so the removed lecture does not
 *  come straight back under a file's id (WP9 review 1, finding 3). Restoring the lecture (Undo) replaces the tombstone
 *  and lifts them with it. An older build drops `files` and shows them, as it did. */
export interface LectureTombstone extends Tombstone {
	files?: string[];
}

export type LectureEntry = Lecture | LectureTombstone;

/** How far the class has got, when the learner said so. */
export interface ClassPosition {
	/** The lecture the class is at (the last one it has had). */
	lectureId?: string;
	/** The learner's words for what the class covered ("chapter 6"). */
	coveredThrough?: string;
	/** Anything else they said about it ("a week behind the syllabus"). */
	note?: string;
	/** "YYYY-MM-DD": the day the learner said it, in THEIR time zone (WP9 review 1, finding 10). Kept when Undo restores
	 *  it. Absent on a position from before: the day of `updatedAt` on this machine. */
	saidOn?: string;
	/** ISO — the merge revision: every write (a new position, a correction, a clear, an Undo) takes a fresh one, and a
	 *  sync keeps the later (WP9 review 1, finding 4). */
	updatedAt: string;
}

/** A cleared position, stored as a revision with nothing said (`{ updatedAt }`), so a later "follow the dates" wins a
 *  sync over an earlier statement on another device. Every reader (and an older build) reads it as no position. */
export interface ClearedPosition {
	updatedAt: string;
}

/** A lecture as the page and the tools read it: stored, derived from the files, or both merged. */
export interface LectureView extends Lecture {
	/** Read from the class's file names and not stored (yet). */
	derived?: true;
	/** The ids of the lectures read from the file names that joined this one (their files are its files). */
	joined?: string[];
}

export const LECTURES_MAX = 200;
export const LECTURE_TITLE_MAX = 120;
export const LECTURE_TOPICS_MAX = 1000;
export const LECTURE_MATERIALS_MAX = 20;
export const POSITION_TEXT_MAX = 200;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;
const isIso = (v: unknown): v is string => typeof v === "string" && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));

function cleanText(raw: unknown, max: number): string {
	return typeof raw === "string" ? raw.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, max) : "";
}

/** A lecture number: a whole number 0-999, else undefined. */
export function parseLectureNumber(raw: unknown): number | undefined {
	const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
	return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 999 ? n : undefined;
}

/** One stored or foreign lecture with every field checked; null when it cannot be read. */
export function sanitizeLecture(raw: unknown): Lecture | null {
	if (!isObj(raw)) return null;
	const title = cleanLine(raw.title, LECTURE_TITLE_MAX);
	if (typeof raw.id !== "string" || raw.id === "" || raw.id.length > 80 || !title || !isIso(raw.updatedAt)) return null;
	const n = parseLectureNumber(raw.n);
	const date = raw.date === undefined ? undefined : parseExamDate(raw.date);
	const source: LectureSource = raw.source === "syllabus" || raw.source === "files" || raw.source === "chat" ? raw.source : "manual";
	const cite = cleanLine(raw.cite, 200);
	const skillsBy = raw.skillsBy === "model" || raw.skillsBy === "learner" ? raw.skillsBy : undefined;
	const skillsKey = skillsBy === "model" && typeof raw.skillsKey === "string" && raw.skillsKey.length <= 80 ? raw.skillsKey : undefined;
	return {
		id: raw.id,
		...(n !== undefined ? { n } : {}),
		title,
		...(date ? { date } : {}),
		topics: cleanText(raw.topics, LECTURE_TOPICS_MAX),
		materialIds: cleanSkillIds(raw.materialIds).slice(0, LECTURE_MATERIALS_MAX),
		skillIds: cleanSkillIds(raw.skillIds),
		...(skillsBy ? { skillsBy } : {}),
		...(skillsKey ? { skillsKey } : {}),
		source,
		updatedAt: raw.updatedAt,
		...(cite ? { cite } : {}),
	};
}

/** A lecture tombstone keeps the file-derived ids it hides (`files`). */
function lectureTombstone(t: Tombstone, raw: Record<string, unknown>): LectureTombstone {
	const files = Array.isArray(raw.files) ? [...new Set(raw.files.filter((f): f is string => typeof f === "string" && f.startsWith("lf_") && f.length <= 80))].slice(0, 20) : [];
	return files.length > 0 ? { ...t, files } : t;
}

export const readLectureEntries = (raw: unknown): LectureEntry[] => readEntries<Lecture, LectureTombstone>(raw, sanitizeLecture, lectureTombstone);

/** The live lectures of a stored list (tombstones dropped). */
export function liveLectures(raw: unknown): Lecture[] {
	return readLectureEntries(raw).filter((e): e is Lecture => !isTombstone(e));
}

/** Is the stored entry exactly this one (every field)? Undo compares the whole entry, as WP8's `sameEntry`. */
export function sameLectureEntry(held: unknown, expected: unknown): boolean {
	if (held == null || expected == null) return false;
	if (isTombstone(held) || isTombstone(expected)) {
		return isTombstone(held) && isTombstone(expected) && held.id === expected.id && held.updatedAt === expected.updatedAt;
	}
	const a = sanitizeLecture(held);
	const b = sanitizeLecture(expected);
	return a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b);
}

/** The stored class position read defensively; undefined when it cannot be read or says nothing (a cleared one too). */
export function sanitizeClassPosition(raw: unknown): ClassPosition | undefined {
	const rec = positionRecord(raw);
	return rec && ("lectureId" in rec || "coveredThrough" in rec || "note" in rec) ? (rec as ClassPosition) : undefined;
}

/** The stored position as a revision: what was said, a cleared revision (`{ updatedAt }`), or undefined (none, or
 *  unreadable). Undo and the change cards compare these, so a clear has a revision too. Pure. */
export function positionRecord(raw: unknown): ClassPosition | ClearedPosition | undefined {
	if (!isObj(raw) || !isIso(raw.updatedAt)) return undefined;
	const lectureId = typeof raw.lectureId === "string" && raw.lectureId !== "" && raw.lectureId.length <= 80 ? raw.lectureId : undefined;
	const coveredThrough = cleanLine(raw.coveredThrough, POSITION_TEXT_MAX);
	const note = cleanLine(raw.note, POSITION_TEXT_MAX);
	if (!lectureId && !coveredThrough && !note) return { updatedAt: raw.updatedAt };
	const saidOn = raw.saidOn === undefined ? null : parseExamDate(raw.saidOn);
	return { ...(lectureId ? { lectureId } : {}), ...(coveredThrough ? { coveredThrough } : {}), ...(note ? { note } : {}), ...(saidOn ? { saidOn } : {}), updatedAt: raw.updatedAt };
}

// ─── lectures from the class's files (no model call) ───────────────────────

/** A class file as the reader needs it. */
export interface FileForLectures {
	id: string;
	name: string;
	profile?: string;
	addedAt: string;
}

/** Files that are not lectures even when their name has a number or a week: exams, solutions, the syllabus, exercises. */
const NOT_A_LECTURE = /exam|eksamen|solution|løsning|losning|fasit|syllab|schedule|timeplan|semesterplan|exercise|øving|oving|assignment|oblig|problem.?set|homework|quiz/i;
const B = "(?<![\\p{L}\\d])";
const E = "(?![\\p{L}\\d])";
const LECTURE_WORDS = new RegExp(`${B}(?:lecture|lect|lec|forelesning|forelesing|fl)[\\s._-]*0*(\\d{1,3})${E}`, "iu");
const L_TOKEN = new RegExp(`${B}L[\\s._-]?0*(\\d{1,2})${E}`, "u");
const WEEK_WORDS = new RegExp(`${B}(?:week|wk|uke|veke)[\\s._-]*0*(\\d{1,2})${E}`, "iu");
const ISO_IN_NAME = /(?<!\d)(20\d\d)[-_.](\d\d)[-_.](\d\d)(?!\d)/;
const DMY_IN_NAME = /(?<!\d)(\d\d)[._-](\d\d)[._-](20\d\d)(?!\d)/;

/** What one file name (or the start of a profile) says: a lecture or week number, and a date. Pure. */
export function readLectureMarks(text: string): { kind?: "lecture" | "week"; n?: number; date?: string } {
	const out: { kind?: "lecture" | "week"; n?: number; date?: string } = {};
	const lec = LECTURE_WORDS.exec(text) ?? L_TOKEN.exec(text);
	const week = lec ? null : WEEK_WORDS.exec(text);
	const num = lec ?? week;
	if (num) {
		const n = parseLectureNumber(Number(num[1]));
		if (n !== undefined && n > 0) {
			out.kind = lec ? "lecture" : "week";
			out.n = n;
		}
	}
	const iso = ISO_IN_NAME.exec(text);
	const dmy = iso ? null : DMY_IN_NAME.exec(text);
	const date = iso ? parseExamDate(`${iso[1]}-${iso[2]}-${iso[3]}`) : dmy ? parseExamDate(`${dmy[3]}-${dmy[2]}-${dmy[1]}`) : null;
	if (date) out.date = date;
	return out;
}

const LABELS: Record<"en" | "nb", { lecture: string; week: string }> = { en: { lecture: "Lecture", week: "Week" }, nb: { lecture: "Forelesning", week: "Uke" } };

/**
 * The lectures the class's file names say there are, with no model call: one per lecture (or week) number, or per date
 * when a file has a date and no number. The name is read first, then the first 400 characters of the profile. Files that
 * read as exams, solutions, exercises or the syllabus are skipped. Ids are stable (`lf_lecture_8`, `lf_week_5`,
 * `lf_d_2026-11-24`): two devices derive the same lecture, and the learner's removal (a tombstone) or edit (a stored item)
 * under that id holds. Pure.
 */
export function lecturesFromFiles(files: readonly FileForLectures[], language: "en" | "nb" = "en"): Lecture[] {
	const label = LABELS[language] ?? LABELS.en;
	const byId = new Map<string, Lecture>();
	for (const f of files) {
		const base = f.name.replace(/\.[a-z0-9]{1,5}$/i, "");
		if (NOT_A_LECTURE.test(base)) continue;
		let marks = readLectureMarks(base);
		if (marks.n === undefined && marks.date === undefined && f.profile) marks = readLectureMarks(f.profile.slice(0, 400));
		if (marks.n === undefined && marks.date === undefined) continue;
		const id = marks.n !== undefined ? `lf_${marks.kind}_${marks.n}` : `lf_d_${marks.date}`;
		const title = marks.n !== undefined ? `${label[marks.kind!]} ${marks.n}` : `${label.lecture} ${examDateLabel(marks.date!)}`;
		const held = byId.get(id);
		if (held) {
			if (!held.materialIds.includes(f.id) && held.materialIds.length < LECTURE_MATERIALS_MAX) held.materialIds.push(f.id);
			if (marks.date && (!held.date || marks.date < held.date)) held.date = marks.date;
			if (f.addedAt > held.updatedAt) held.updatedAt = f.addedAt;
			continue;
		}
		byId.set(id, {
			id,
			...(marks.n !== undefined ? { n: marks.n } : {}),
			title,
			...(marks.date ? { date: marks.date } : {}),
			topics: "",
			materialIds: [f.id],
			skillIds: [],
			source: "files",
			updatedAt: isIso(f.addedAt) ? f.addedAt : new Date(0).toISOString(),
		});
	}
	return [...byId.values()];
}

// ─── the merged timeline ────────────────────────────────────────────────────

/**
 * Timeline order (WP9 review 1, finding 9: the same on every device, whatever order the list is stored in). Two runs, each
 * totally ordered: the numbered lectures by number (then date, title, id), and the unnumbered ones by date, undated last
 * (then title, id). They are merged by date: an unnumbered lecture goes before the next numbered one only when both have
 * dates and its date is earlier. The result depends only on the set, never on the input order. Pure.
 */
export function sortLectures<T extends Pick<Lecture, "n" | "date" | "title"> & { id?: string }>(list: readonly T[]): T[] {
	const tie = (a: T, b: T) => (a.title < b.title ? -1 : a.title > b.title ? 1 : (a.id ?? "") < (b.id ?? "") ? -1 : (a.id ?? "") > (b.id ?? "") ? 1 : 0);
	const byDate = (a: T, b: T) => (a.date && b.date ? (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) : a.date ? -1 : b.date ? 1 : 0);
	const numbered = list.filter((l) => l.n !== undefined).sort((a, b) => a.n! - b.n! || byDate(a, b) || tie(a, b));
	const loose = list.filter((l) => l.n === undefined).sort((a, b) => byDate(a, b) || tie(a, b));
	const out: T[] = [];
	let i = 0;
	let j = 0;
	while (i < numbered.length || j < loose.length) {
		const n = numbered[i];
		const u = loose[j];
		if (u && (!n || (u.date && n.date && u.date < n.date))) {
			out.push(u);
			j++;
		} else {
			out.push(n!);
			i++;
		}
	}
	return out;
}

/**
 * A class's lectures as read: the stored ones, plus those its files name that nothing stored covers. A derived lecture
 * whose id holds a stored entry (an edit, or a removal's tombstone) is that entry; one whose number (or, with no number,
 * date) a stored lecture has joins its files to that lecture. Timeline order. Pure.
 */
export function courseLectures(course: { lectures?: unknown; language?: string }, files: readonly FileForLectures[]): LectureView[] {
	const entries = readLectureEntries(course.lectures);
	const byId = new Map(entries.map((e) => [e.id, e]));
	const live: LectureView[] = entries.filter((e): e is Lecture => !isTombstone(e)).map((l) => ({ ...l, materialIds: [...l.materialIds] }));
	// review 1, finding 3: a removed lecture's tombstone hides the file-derived lectures that had joined it
	const hidden = new Set(entries.flatMap((e) => (isTombstone(e) ? ((e as LectureTombstone).files ?? []) : [])));
	const liveFiles = new Set(files.map((f) => f.id));
	for (const d of lecturesFromFiles(files, course.language === "nb" ? "nb" : "en")) {
		const held = byId.get(d.id);
		if (held && isTombstone(held)) continue;
		const into = held ? live.find((l) => l.id === d.id) : live.find((l) => (d.n !== undefined ? l.n === d.n : l.n === undefined && !!d.date && l.date === d.date));
		if (into) {
			for (const m of d.materialIds) if (!into.materialIds.includes(m)) into.materialIds.push(m);
			if (into.id !== d.id) into.joined = [...(into.joined ?? []), d.id];
			continue;
		}
		if (hidden.has(d.id)) continue;
		live.push({ ...d, derived: true });
	}
	// a file deleted since it was linked no longer counts as the lecture's file
	for (const l of live) l.materialIds = l.materialIds.filter((m) => liveFiles.has(m));
	return sortLectures(live);
}

// ─── the class position ─────────────────────────────────────────────────────

export interface PositionView {
	/** The lecture the class is at; absent when only the learner's words say where ("chapter 6"). */
	lectureId?: string;
	/** explicit: the learner said so · dated: the last lecture dated on or before today · files: the highest-numbered
	 *  lecture with a file (no lecture has a date). */
	how: "explicit" | "dated" | "files";
	coveredThrough?: string;
	note?: string;
	/** "YYYY-MM-DD" — the day the learner said it, in their zone (explicit only). */
	at?: string;
}

/**
 * THE CLASS POSITION RULE (one function, tested). Explicit when the learner said it, while no lecture dated after the day
 * they said it has passed (the class has moved on since; then the dates rule again). Otherwise: the last lecture whose
 * date is on or before today; when no lecture has a date, the highest-numbered lecture that has a file. Null when none of
 * these says anything (no lectures; dated lectures all in the future). `lectures` in timeline order; `today` "YYYY-MM-DD"
 * in the learner's zone. Pure.
 */
export function classPositionOf(lectures: readonly LectureView[], explicit: ClassPosition | undefined, today: string): PositionView | null {
	const dated = lectures.filter((l) => !!l.date);
	// the latest of the timeline (already in a stable order) that qualifies
	const lastDated = dated.filter((l) => l.date! <= today).reduce<LectureView | undefined>((best, l) => (!best || l.date! >= best.date! ? l : best), undefined);
	const withFile = lectures.filter((l) => l.n !== undefined && l.materialIds.length > 0).reduce<LectureView | undefined>((best, l) => (!best || l.n! >= best.n! ? l : best), undefined);
	const derived: PositionView | null = dated.length > 0 ? (lastDated ? { lectureId: lastDated.id, how: "dated" } : null) : withFile ? { lectureId: withFile.id, how: "files" } : null;
	if (explicit) {
		// the day the learner said it, in their zone (review 1, finding 10); a position from before: this machine's day
		const said = explicit.saidOn ?? todayIn(Date.parse(explicit.updatedAt));
		const at = explicit.lectureId ? lectures.find((l) => l.id === explicit.lectureId) : undefined;
		const idx = at ? lectures.indexOf(at) : -1;
		// the class moved on: a lecture after the stated one (or any, with no stated lecture) was dated after that day and
		// has passed
		const movedOn = dated.some((l) => l.date! > said && l.date! <= today && (idx === -1 || lectures.indexOf(l) > idx));
		if (!movedOn && (at || explicit.coveredThrough || explicit.note)) {
			// only words ("chapter 6"): the lecture stays what the dates say, with the learner's words beside it
			const lectureId = at?.id ?? derived?.lectureId;
			return {
				...(lectureId ? { lectureId } : {}),
				how: "explicit",
				...(explicit.coveredThrough ? { coveredThrough: explicit.coveredThrough } : {}),
				...(explicit.note ? { note: explicit.note } : {}),
				at: said,
			};
		}
	}
	return derived;
}

/** The lectures the class has covered: every lecture up to and including the position's, in timeline order. Pure. */
export function coveredLectures(lectures: readonly LectureView[], position: PositionView | null): LectureView[] {
	if (!position?.lectureId) return [];
	const idx = lectures.findIndex((l) => l.id === position.lectureId);
	return idx === -1 ? [] : lectures.slice(0, idx + 1);
}

// ─── where you stand ────────────────────────────────────────────────────────

/** A range of lectures in words: "Lecture 1", "Lectures 1–6", or "Lecture 1 – Intro". Pure. */
export function lectureRangeLabel(from: Pick<Lecture, "n" | "title">, to: Pick<Lecture, "n" | "title">): string {
	if (from === to || (from.title === to.title && from.n === to.n)) return lectureShortLabel(from);
	const a = lectureWord(from);
	if (a && a === lectureWord(to)) return `${a}${/s$/.test(a) ? "" : "s"} ${from.n}–${to.n}`;
	return `${lectureShortLabel(from)} – ${lectureShortLabel(to)}`;
}

/** The word a numbered title starts with ("Lecture 4: The proton gradient" → "Lecture"), or null. Pure. */
function lectureWord(l: Pick<Lecture, "n" | "title">): string | null {
	if (l.n === undefined) return null;
	const m = new RegExp(`^(\\p{L}+)\\s*0*${l.n}(?![\\d])`, "u").exec(l.title);
	return m ? m[1]! : null;
}

/** A lecture's short name for one-line places (the card, "(Lecture 7)"): "Lecture 4" for "Lecture 4: The proton
 *  gradient", else the title. Pure. */
export function lectureShortLabel(l: Pick<Lecture, "n" | "title">): string {
	const w = lectureWord(l);
	return w ? `${w} ${l.n}` : l.title;
}

/** "Tue 24 Nov" for the card ("Tue 24 Nov 2027" in another year): the one on-screen date (SPEC §9). Pure. */
export function shortDate(date: string, now: number = Date.now()): string {
	return dayLabel(date, now);
}

/** What an assessment needs, and how much of it is learned. */
export interface AssessmentReadiness {
	id: string;
	title: string;
	kind: Assessment["kind"];
	date: string;
	/** The skills it needs: its own list, else the skills of the lectures up to its date; null when neither says. */
	needs: string[] | null;
	/** Where `needs` came from. */
	basis: "assessment" | "lectures" | null;
	learned: string[];
	/** Not learned yet, each with the lectures that teach it. */
	missing: Array<{ skillId: string; lectureIds: string[] }>;
}

/** The lectures that teach each skill, in timeline order. Pure. */
export function lecturesBySkill(lectures: readonly LectureView[]): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const l of lectures) for (const s of l.skillIds) out.set(s, [...(out.get(s) ?? []), l.id]);
	return out;
}

/**
 * An assessment's readiness. Its needs are its own `skillIds`; when it lists none, the skills of the lectures dated up to
 * its date (with no dated lecture, those the class has covered); null when neither gives any. Learned is the mastery the
 * course view computes (self-reports included). `order` is the class's skill order (topological): the lists follow it.
 * Pure.
 */
export function assessmentReadiness(
	a: Assessment & { date: string },
	lectures: readonly LectureView[],
	covered: readonly LectureView[],
	learned: (skillId: string) => boolean,
	order: readonly string[],
): AssessmentReadiness {
	const inClass = new Set(order);
	let needs: string[] | null = null;
	let basis: AssessmentReadiness["basis"] = null;
	if (a.allSkills) {
		// cumulative: every skill of the class, however many (review 1, finding 12)
		needs = [...order];
		basis = "assessment";
	} else if (a.skillIds.length > 0) {
		needs = a.skillIds.filter((s) => inClass.has(s));
		basis = "assessment";
	} else {
		const dated = lectures.filter((l) => l.date);
		const upTo = dated.length > 0 ? lectures.filter((l) => l.date && l.date <= a.date) : covered;
		const ids = new Set(upTo.flatMap((l) => l.skillIds).filter((s) => inClass.has(s)));
		if (ids.size > 0) {
			needs = order.filter((s) => ids.has(s));
			basis = "lectures";
		}
	}
	const where = lecturesBySkill(lectures);
	const sorted = needs ? order.filter((s) => needs!.includes(s)) : [];
	// the gaps in timeline order: the skill of the earliest lecture first (a skill in no lecture last), then the class's
	const at = new Map(lectures.map((l, i) => [l.id, i]));
	const firstLecture = (s: string) => Math.min(...(where.get(s) ?? []).map((id) => at.get(id) ?? Infinity), Infinity);
	const missing = sorted.filter((s) => !learned(s)).sort((x, y) => firstLecture(x) - firstLecture(y) || order.indexOf(x) - order.indexOf(y));
	return {
		id: a.id,
		title: a.title,
		kind: a.kind,
		date: a.date,
		needs: needs ? sorted : null,
		basis,
		learned: sorted.filter(learned),
		missing: missing.map((skillId) => ({ skillId, lectureIds: where.get(skillId) ?? [] })),
	};
}

/** "Where you stand" (CourseView.standing). */
export interface StandingView {
	lectures: LectureView[];
	position: (PositionView & { label?: string; date?: string }) | null;
	/** The lectures the class has covered (ids). */
	covered: string[];
	/** The longest run of lectures from the first whose linked skills are all learned: the last lecture of it that has
	 *  skills. Null when the first lecture with skills is not all learned, or no lecture has skills. */
	learnedThrough: { fromId: string; toId: string; label: string } | null;
	/** The next dated assessment (WP8 `nextAssessment`) and its readiness. */
	next: AssessmentReadiness | null;
	/** Not learned skills from the lectures the class has covered, in timeline order. */
	behind: string[];
	/** on_track: nothing the class has covered is unlearned · behind: `behind` is not empty · unknown: no position. */
	verdict: "on_track" | "behind" | "unknown";
	/** The one Start: a skill that can be started now (its prerequisites learned) for the most urgent gap. */
	start: { skillId: string; gapId: string; why: "assessment" | "covered" } | null;
	/** Approved skills no lecture teaches yet ("not placed"). */
	unplaced: number;
}

export interface StandingInput {
	lectures: readonly LectureView[];
	explicit: ClassPosition | undefined;
	today: string;
	/** The class's skills in topological order, with learned and their prerequisites. */
	skills: ReadonlyArray<{ id: string; learned: boolean; requires: readonly string[] }>;
	/** Skills that can be started now (Next up, unordered). */
	startable: ReadonlySet<string>;
	/** The next dated assessment, if any. */
	next: (Assessment & { date: string }) | undefined;
}

/** The skill to start for a gap: the gap itself when it can start, else its first unlearned prerequisite (in the class's
 *  order) that can. Pure. */
export function startFor(gap: string, input: Pick<StandingInput, "skills" | "startable">): string | null {
	if (input.startable.has(gap)) return gap;
	const byId = new Map(input.skills.map((s) => [s.id, s]));
	const ancestors = new Set<string>();
	const walk = (id: string) => {
		for (const r of byId.get(id)?.requires ?? []) {
			if (ancestors.has(r) || !byId.has(r)) continue;
			ancestors.add(r);
			walk(r);
		}
	};
	walk(gap);
	return input.skills.find((s) => ancestors.has(s.id) && !s.learned && input.startable.has(s.id))?.id ?? null;
}

/**
 * WHERE YOU STAND. Pure.
 *   class      the position (classPositionOf) and the lectures it covers;
 *   you        "you've learned what Lectures 1–6 cover": the longest run of lectures from the first, each of whose linked
 *              skills is learned (a lecture with no linked skill is passed over: it neither ends nor makes the run);
 *   next       the next dated assessment's needs (assessmentReadiness);
 *   verdict    behind with N skills from covered lectures, or on track; unknown without a position;
 *   start      the most urgent gap: first a skill the next assessment needs that is not learned (the earliest lecture's
 *              first), then the earliest covered lecture's unlearned skill; started through its first startable
 *              prerequisite when it is locked.
 */
export function whereYouStand(input: StandingInput): StandingView {
	const { lectures } = input;
	const learnedSet = new Set(input.skills.filter((s) => s.learned).map((s) => s.id));
	const inClass = new Set(input.skills.map((s) => s.id));
	const order = input.skills.map((s) => s.id);
	const learned = (id: string) => learnedSet.has(id);
	const position = classPositionOf(lectures, input.explicit, input.today);
	const covered = coveredLectures(lectures, position);
	const at = position?.lectureId ? lectures.find((l) => l.id === position.lectureId) : undefined;
	// you: the run of lectures whose skills are all learned
	let from: LectureView | undefined;
	let to: LectureView | undefined;
	for (const l of lectures) {
		const skills = l.skillIds.filter((s) => inClass.has(s));
		if (skills.length === 0) continue;
		if (!skills.every(learned)) break;
		from ??= l;
		to = l;
	}
	const next = input.next ? assessmentReadiness(input.next, lectures, covered, learned, order) : null;
	const behindSet = new Set<string>();
	const behind: string[] = [];
	for (const l of covered) {
		for (const s of order.filter((id) => l.skillIds.includes(id))) {
			if (!learned(s) && !behindSet.has(s)) {
				behindSet.add(s);
				behind.push(s);
			}
		}
	}
	let start: StandingView["start"] = null;
	for (const m of next?.missing ?? []) {
		const s = startFor(m.skillId, input);
		if (s) {
			start = { skillId: s, gapId: m.skillId, why: "assessment" };
			break;
		}
	}
	if (!start) {
		for (const g of behind) {
			const s = startFor(g, input);
			if (s) {
				start = { skillId: s, gapId: g, why: "covered" };
				break;
			}
		}
	}
	const placed = new Set(lectures.flatMap((l) => l.skillIds));
	return {
		lectures: lectures.map((l) => ({ ...l })),
		position: position ? { ...position, ...(at ? { label: at.title } : {}), ...(at?.date ? { date: at.date } : {}) } : null,
		covered: covered.map((l) => l.id),
		learnedThrough: from && to ? { fromId: from.id, toId: to.id, label: lectureRangeLabel(from, to) } : null,
		next,
		behind,
		verdict: !position ? "unknown" : behind.length > 0 ? "behind" : "on_track",
		start,
		unplaced: order.filter((s) => !placed.has(s)).length,
	};
}

/** Next up's gap sets (core/exam-plan.ts orderNextUp): the skills the next assessment needs, and those of the lectures
 *  the class has covered. Both empty when the class has no lectures and the next assessment maps no skills. With `input`,
 *  each set also holds the startable prerequisite a locked gap starts through (startFor), so the shared order puts it with
 *  its gap (review 1, finding 11). Pure. */
export function standingGaps(standing: Pick<StandingView, "next" | "covered" | "lectures" | "behind"> | null, input?: Pick<StandingInput, "skills" | "startable">): { needs: Set<string>; covered: Set<string> } {
	if (!standing) return { needs: new Set(), covered: new Set() };
	const coveredIds = new Set(standing.covered);
	const needs = new Set(standing.next?.needs ?? []);
	const covered = new Set(standing.lectures.filter((l) => coveredIds.has(l.id)).flatMap((l) => l.skillIds));
	if (input) {
		for (const m of standing.next?.missing ?? []) ((s) => s && needs.add(s))(startFor(m.skillId, input));
		for (const g of standing.behind) ((s) => s && covered.add(s))(startFor(g, input));
	}
	return { needs, covered };
}

/**
 * The card's one primary Start, from the SAME order Next up and Today use (review 1, finding 11): the first skill of the
 * ordered Next up (core/exam-plan.ts orderNextUp over `standingGaps(standing, input)`) that is a gap of the next
 * assessment, else one of what the class has covered. Next up holds only eligible skills (startable, and examined unless
 * the next assessment needs them), so the Start never contradicts Today or "not examined". Null when no gap is in it.
 * Pure.
 */
export function startInOrder(standing: Pick<StandingView, "next" | "covered" | "lectures" | "behind">, nextUp: readonly string[], input: Pick<StandingInput, "skills" | "startable">): StandingView["start"] {
	const gaps = standingGaps(standing, input);
	const pick = nextUp.find((id) => gaps.needs.has(id) || gaps.covered.has(id));
	if (!pick) return null;
	const viaNeeds = gaps.needs.has(pick);
	const pool = viaNeeds ? (standing.next?.missing ?? []).map((m) => m.skillId) : standing.behind;
	const gapId = pool.includes(pick) ? pick : (pool.find((g) => startFor(g, input) === pick) ?? pick);
	return { skillId: pick, gapId, why: viaNeeds ? "assessment" : "covered" };
}

// ─── the syllabus pass's lectures ───────────────────────────────────────────

/** One lecture the syllabus pass found (proposal-local key "l1"). */
export interface ProposedLecture {
	key: string;
	n?: number;
	title: string;
	date?: string;
	topics: string;
	skillIds: string[];
	cite: string;
	quote?: string;
	/** As WP8's items: new · update (a syllabus lecture it changes) · same · kept (the learner's own lecture wins). */
	status: "new" | "update" | "same" | "kept";
	match?: string;
	matchStamp?: string;
}

/** Lecture proposal items at most. */
export const PROPOSAL_LECTURES_MAX = 80;

/** Each found lecture against the stored list: the same number, else the same title, else the same date. Pure. */
export function classifyLectures(found: ReadonlyArray<Omit<ProposedLecture, "status" | "match" | "matchStamp">>, list: readonly Lecture[]): ProposedLecture[] {
	const claimed = new Set<string>();
	const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
	return found.map((f) => {
		const free = list.filter((l) => !claimed.has(l.id));
		const match =
			(f.n !== undefined ? free.find((l) => l.n === f.n) : undefined) ??
			free.find((l) => fold(l.title) !== "" && fold(l.title) === fold(f.title)) ??
			(f.date ? free.find((l) => l.n === undefined && l.date === f.date) : undefined);
		if (!match) return { ...f, status: "new" };
		claimed.add(match.id);
		if (match.source !== "syllabus") return { ...f, status: "kept", match: match.id };
		const same = match.title === f.title && match.date === f.date && match.topics === f.topics && match.n === f.n;
		return same ? { ...f, status: "same", match: match.id } : { ...f, status: "update", match: match.id, matchStamp: match.updatedAt };
	});
}

// ─── linking skills to lectures ─────────────────────────────────────────────

/** The linking pass's fingerprint: EVERYTHING it reads (review 1, finding 7): the lectures as sent (titles, dates, topics,
 *  file names and excerpts), the skills (names and statements), the draft's cites, and the learner's own placements. It
 *  never includes the pass's own output, so a run is started again only when an input changes, never in a loop. A reply
 *  whose inputs changed while it ran is discarded and the current inputs are placed instead. Pure (a short stable hash). */
export function lectureLinkKey(evidence: unknown): string {
	const text = JSON.stringify(evidence);
	// FNV-1a, two lanes: short, stable on every device, no crypto import in core
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193 ^ text.length;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
		h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
	}
	return `v2:${text.length.toString(36)}:${h1.toString(36)}:${h2.toString(36)}`;
}

/**
 * The draft's `cite` reused (no model call): a skill whose cite names a lecture's file ("L08 slides.pdf p. 4") or the
 * lecture itself ("Lecture 8", "L08", "Forelesning 8", "Week 5") is linked to that lecture. Returns lecture id → skill ids
 * to add. Pure.
 */
export function linksFromCites(cites: Readonly<Record<string, string>>, lectures: readonly LectureView[], files: readonly Pick<FileForLectures, "id" | "name">[]): Map<string, string[]> {
	const out = new Map<string, string[]>();
	const fold = (s: string) => s.normalize("NFKC").toLowerCase();
	const fileName = new Map(files.map((f) => [f.id, fold(f.name.replace(/\.[a-z0-9]{1,5}$/i, ""))]));
	const add = (lectureId: string, skillId: string) => {
		const held = out.get(lectureId) ?? [];
		if (!held.includes(skillId)) out.set(lectureId, [...held, skillId]);
	};
	const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	/** The file name as a whole word in the cite: "lecture 1" is not in "lecture 10.pdf" (review 1, finding 8). */
	const named = (cite: string, name: string) => name.length >= 3 && new RegExp(`(?<![\\p{L}\\p{N}])${escape(name)}(?![\\p{L}\\p{N}])`, "u").test(cite);
	for (const [skillId, cite] of Object.entries(cites)) {
		const c = fold(cite);
		const marks = readLectureMarks(cite);
		// a file match wins over a number; among file matches, the longest name (the most specific) wins
		let best = 0;
		let byFile: string[] = [];
		for (const l of lectures) {
			for (const m of l.materialIds) {
				const name = fileName.get(m);
				if (!name || !named(c, name)) continue;
				if (name.length > best) {
					best = name.length;
					byFile = [l.id];
				} else if (name.length === best && !byFile.includes(l.id)) byFile.push(l.id);
			}
		}
		if (byFile.length > 0) {
			for (const id of byFile) add(id, skillId);
			continue;
		}
		for (const l of lectures) {
			if (marks.n !== undefined && l.n === marks.n && (marks.kind === "week") === l.id.startsWith("lf_week_")) add(l.id, skillId);
		}
	}
	return out;
}

/** "today" for a lecture rule, in the learner's zone ("YYYY-MM-DD"). */
export const lectureToday = (now: number, timeZone?: string): string => todayIn(now, timeZone);

/** The day `n` days before a date (for "a week behind"). */
export const daysBefore = (date: string, n: number): string => addDays(date, -n);
