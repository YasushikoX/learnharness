/**
 * Assessments and self-reports (WP8, 2026-11-25; docs/courses.md "Quizzes, exams and what you say you know"). PURE,
 * browser-safe.
 *
 * A class carries a list of ASSESSMENTS (quizzes, exams, midterms, finals, assignments) with a date, the topics as the
 * learner or the syllabus put them, and the approved skills they map onto. They come from three places: the learner's
 * own edit on the class page ("manual"), a Short question conversation ("chat"), or the "Find quizzes and exams" pass
 * over the syllabus ("syllabus", approved by the learner first).
 *
 * THE OLD EXAM DATE. `CourseRecord.examDate` stays what it was, and is READ as one more assessment: a virtual "Exam"
 * with the id LEGACY_EXAM_ID (`courseAssessments`). Nothing is migrated on read. Editing that item on the page or in a
 * chat turns it into a real assessment and clears `examDate` (server/assessments.ts); deleting it clears `examDate`.
 * Why derive and not migrate: a read never writes; a device on an older build keeps its countdown until the learner
 * touches the item; the field keeps syncing field by field as before.
 *
 * THE NEXT ASSESSMENT is the nearest one with a date today or later (`nextAssessment`). The countdown, readiness, the
 * forecast, the Today list, the sidebar's days column and the teacher's exam line read it instead of `examDate`. Its
 * skills, when mapped, come first in Next up (core/exam-plan.ts orderNextUp), and every skill's review is timed for the
 * nearest dated assessment that covers it (`targetDateFor`: one that lists it, or one that lists no skills at all, as
 * the old exam date did).
 *
 * SYNC. Both lists merge per item by id, the later `updatedAt` winning (`mergeEntries`); a deletion is a TOMBSTONE
 * (`{ id, deleted: true, updatedAt }`) kept in the list, so it survives a merge with a device that still has the item.
 *
 * SELF-REPORTS ("I already know X", "I don't get Y") are stored on the course too, so deleting the chat they were said
 * in keeps them. Their effect on understanding is one rule in core/mastery.ts (applySelfReports).
 */

import { daysUntil, examDateLabel, parseExamDate } from "./exam-plan.ts";

export type AssessmentKind = "quiz" | "exam" | "midterm" | "final" | "assignment" | "other";
export const ASSESSMENT_KINDS: readonly AssessmentKind[] = ["quiz", "exam", "midterm", "final", "assignment", "other"];
export type AssessmentSource = "syllabus" | "chat" | "manual";

/** One assessment. */
export interface Assessment {
	/** "as_" + random; LEGACY_EXAM_ID for the old exam date read as an item. */
	id: string;
	kind: AssessmentKind;
	title: string;
	/** "YYYY-MM-DD"; absent when nobody knows it yet. */
	date?: string;
	/** Free text, as the learner or the syllabus put it ("chapters 4 and 5"). */
	topics: string;
	/** The approved skills it covers; [] before a skill map exists or when nothing maps. */
	skillIds: string[];
	source: AssessmentSource;
	/** ISO — the last write; the sync merge keeps the later one per id. */
	updatedAt: string;
	/** Where the syllabus says it ("syllabus.pdf p. 2"); syllabus items only. */
	cite?: string;
	/** The old `examDate`, read as an item (never stored in the list). */
	legacy?: true;
}

/** A deleted item: kept in the list so the deletion survives a sync. */
export interface Tombstone {
	id: string;
	deleted: true;
	updatedAt: string;
}

export type AssessmentEntry = Assessment | Tombstone;

export type SelfReportStance = "know" | "shaky" | "dont_know";
export const SELF_REPORT_STANCES: readonly SelfReportStance[] = ["know", "shaky", "dont_know"];

/** What the learner said about some skills, in a Short question conversation. */
export interface SelfReport {
	/** "sr_" + random. */
	id: string;
	/** The conversation it was said in (kept after that chat is deleted). */
	chatId?: string;
	/** ISO — when it was said: the moment its effect starts. */
	at: string;
	skillIds: string[];
	stance: SelfReportStance;
	/** The learner's words, short. */
	note: string;
	updatedAt: string;
}

export type SelfReportEntry = SelfReport | Tombstone;

export const LEGACY_EXAM_ID = "exam-date";
export const TITLE_MAX = 120;
export const TOPICS_MAX = 1000;
export const NOTE_MAX = 300;
export const CITE_MAX = 200;
export const SKILLS_PER_ITEM_MAX = 60;
/** Live items a class holds at most (the oldest by date are dropped first on write). */
export const ASSESSMENTS_MAX = 100;
export const SELF_REPORTS_MAX = 300;
/** Tombstones kept per list (the oldest go first: by then every device has long seen the deletion). */
export const TOMBSTONES_MAX = 200;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;
const isIso = (v: unknown): v is string => typeof v === "string" && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));

/** One line of text: trimmed, inner whitespace collapsed, cut to `max`. */
export function cleanLine(raw: unknown, max: number): string {
	return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** Free text: trimmed, at most two blank lines in a row, cut to `max`. */
function cleanText(raw: unknown, max: number): string {
	return typeof raw === "string" ? raw.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, max) : "";
}

export function cleanSkillIds(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return [...new Set(raw.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim()))].slice(0, SKILLS_PER_ITEM_MAX);
}

export const isTombstone = (e: unknown): e is Tombstone => isObj(e) && e.deleted === true;

export function parseKind(raw: unknown): AssessmentKind | null {
	return typeof raw === "string" && (ASSESSMENT_KINDS as readonly string[]).includes(raw) ? (raw as AssessmentKind) : null;
}

function sanitizeTombstone(raw: Record<string, unknown>): Tombstone | null {
	return typeof raw.id === "string" && raw.id !== "" && isIso(raw.updatedAt) ? { id: raw.id, deleted: true, updatedAt: raw.updatedAt } : null;
}

/** One stored or foreign assessment with every field checked; null when it cannot be read. */
export function sanitizeAssessment(raw: unknown): Assessment | null {
	if (!isObj(raw)) return null;
	const kind = parseKind(raw.kind);
	const title = cleanLine(raw.title, TITLE_MAX);
	if (typeof raw.id !== "string" || raw.id === "" || raw.id === LEGACY_EXAM_ID || !kind || !title || !isIso(raw.updatedAt)) return null;
	const date = raw.date === undefined ? undefined : parseExamDate(raw.date);
	const source: AssessmentSource = raw.source === "syllabus" || raw.source === "chat" ? raw.source : "manual";
	const cite = cleanLine(raw.cite, CITE_MAX);
	return {
		id: raw.id,
		kind,
		title,
		...(date ? { date } : {}),
		topics: cleanText(raw.topics, TOPICS_MAX),
		skillIds: cleanSkillIds(raw.skillIds),
		source,
		updatedAt: raw.updatedAt,
		...(cite ? { cite } : {}),
	};
}

export function sanitizeSelfReport(raw: unknown): SelfReport | null {
	if (!isObj(raw)) return null;
	const stance = typeof raw.stance === "string" && (SELF_REPORT_STANCES as readonly string[]).includes(raw.stance) ? (raw.stance as SelfReportStance) : null;
	const skillIds = cleanSkillIds(raw.skillIds);
	if (typeof raw.id !== "string" || raw.id === "" || !stance || skillIds.length === 0 || !isIso(raw.at) || !isIso(raw.updatedAt)) return null;
	return {
		id: raw.id,
		...(typeof raw.chatId === "string" && raw.chatId !== "" ? { chatId: raw.chatId } : {}),
		at: raw.at,
		skillIds,
		stance,
		note: cleanLine(raw.note, NOTE_MAX),
		updatedAt: raw.updatedAt,
	};
}

/** A stored list read defensively: each entry a valid item or a tombstone, one per id (the later write wins). */
function readEntries<T extends { id: string; updatedAt: string }>(raw: unknown, item: (r: unknown) => T | null): Array<T | Tombstone> {
	if (!Array.isArray(raw)) return [];
	const byId = new Map<string, T | Tombstone>();
	for (const r of raw) {
		const e = isTombstone(r) ? sanitizeTombstone(r as unknown as Record<string, unknown>) : item(r);
		if (!e) continue;
		const held = byId.get(e.id);
		if (!held || held.updatedAt < e.updatedAt) byId.set(e.id, e);
	}
	return [...byId.values()];
}

export const readAssessmentEntries = (raw: unknown): AssessmentEntry[] => readEntries(raw, sanitizeAssessment);
export const readSelfReportEntries = (raw: unknown): SelfReportEntry[] => readEntries(raw, sanitizeSelfReport);

/** The live items of a stored list (tombstones dropped). */
export function liveAssessments(raw: unknown): Assessment[] {
	return readAssessmentEntries(raw).filter((e): e is Assessment => !isTombstone(e));
}

export function liveSelfReports(raw: unknown): SelfReport[] {
	return readSelfReportEntries(raw).filter((e): e is SelfReport => !isTombstone(e));
}

/** A list bounded for writing: live items capped (assessments: the undated and the latest dates kept; reports: the
 *  newest), tombstones capped (the newest kept). */
export function boundEntries<T extends { id: string; updatedAt: string }>(entries: ReadonlyArray<T | Tombstone>, liveMax: number, rank: (t: T) => string): Array<T | Tombstone> {
	const live = entries.filter((e): e is T => !isTombstone(e));
	const dead = entries.filter(isTombstone);
	const keptLive = live.length > liveMax ? [...live].sort((a, b) => rank(b).localeCompare(rank(a))).slice(0, liveMax) : live;
	const keptDead = dead.length > TOMBSTONES_MAX ? [...dead].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, TOMBSTONES_MAX) : dead;
	const keep = new Set<unknown>([...keptLive, ...keptDead]);
	return entries.filter((e) => keep.has(e));
}

export const boundAssessments = (entries: readonly AssessmentEntry[]): AssessmentEntry[] =>
	boundEntries(entries, ASSESSMENTS_MAX, (a: Assessment) => a.date ?? "9999");
export const boundSelfReports = (entries: readonly SelfReportEntry[]): SelfReportEntry[] =>
	boundEntries(entries, SELF_REPORTS_MAX, (r: SelfReport) => r.at);

/** Put one entry (an item or a tombstone) in a list by id, replacing what was there. */
export function upsertEntry<T extends { id: string }>(entries: readonly T[], entry: T): T[] {
	const at = entries.findIndex((e) => e.id === entry.id);
	return at === -1 ? [...entries, entry] : entries.map((e, i) => (i === at ? entry : e));
}

/** The sync merge of one list: per id, the later `updatedAt` wins (a tombstone included); a tie keeps `prefer`'s. Order:
 *  `prefer`'s entries first, then the other side's new ones. */
export function mergeEntries(prefer: unknown, other: unknown): unknown[] {
	const a = Array.isArray(prefer) ? prefer : [];
	const b = Array.isArray(other) ? other : [];
	const stamp = (e: unknown): string => (isObj(e) && typeof e.updatedAt === "string" ? e.updatedAt : "");
	const idOf = (e: unknown): string | null => (isObj(e) && typeof e.id === "string" ? e.id : null);
	const out: unknown[] = [];
	const index = new Map<string, number>();
	for (const e of [...a, ...b]) {
		const id = idOf(e);
		if (id === null) continue;
		const at = index.get(id);
		if (at === undefined) {
			index.set(id, out.length);
			out.push(e);
		} else if (stamp(e) > stamp(out[at])) out[at] = e;
	}
	return out;
}

// ─── reading a class's assessments ──────────────────────────────────────────

const EXAM_KINDS: ReadonlySet<AssessmentKind> = new Set(["exam", "midterm", "final"]);

/** Every live assessment of a class, the old exam date included as a virtual "Exam" (LEGACY_EXAM_ID) unless an exam-type
 *  item already sits on that date. Sorted: dated first by date, then undated by title. */
export function courseAssessments(course: { assessments?: unknown; examDate?: string; updatedAt?: string }): Assessment[] {
	const live = liveAssessments(course.assessments);
	const legacyDate = course.examDate ? parseExamDate(course.examDate) : null;
	if (legacyDate && !live.some((a) => a.date === legacyDate && EXAM_KINDS.has(a.kind))) {
		live.push({ id: LEGACY_EXAM_ID, kind: "exam", title: "Exam", date: legacyDate, topics: "", skillIds: [], source: "manual", updatedAt: course.updatedAt ?? new Date(0).toISOString(), legacy: true });
	}
	return sortAssessments(live);
}

export function sortAssessments(list: readonly Assessment[]): Assessment[] {
	return [...list].sort((a, b) => {
		if (a.date && b.date) return a.date.localeCompare(b.date) || kindRank(a.kind) - kindRank(b.kind) || a.title.localeCompare(b.title);
		if (a.date) return -1;
		if (b.date) return 1;
		return a.title.localeCompare(b.title);
	});
}

/** On one day, the bigger assessment is "the next" one. */
function kindRank(kind: AssessmentKind): number {
	return ["final", "exam", "midterm", "quiz", "assignment", "other"].indexOf(kind);
}

/** Is this assessment today or later? */
export function isUpcoming(a: Pick<Assessment, "date">, now: number): a is Assessment & { date: string } {
	return !!a.date && daysUntil(a.date, now) >= 0;
}

/** The nearest assessment with a date today or later; undefined when none. */
export function nextAssessment(list: readonly Assessment[], now: number): (Assessment & { date: string }) | undefined {
	return sortAssessments(list.filter((a) => isUpcoming(a, now)))[0] as (Assessment & { date: string }) | undefined;
}

/** What the countdown shows: the next upcoming dated assessment, or, when none is coming, the latest one that has passed
 *  (the card says "passed" until the learner adds the next, as it did for the old exam date). Undefined with no dates. */
export function countdownAssessment(list: readonly Assessment[], now: number): (Assessment & { date: string }) | undefined {
	const next = nextAssessment(list, now);
	if (next) return next;
	const past = sortAssessments(list.filter((a) => !!a.date)) as Array<Assessment & { date: string }>;
	return past.at(-1);
}

/** The date a skill's review is timed for: the nearest upcoming dated assessment that lists it, or that lists no skills
 *  (it covers the whole class, as the old exam date did). Undefined when none. */
export function targetDateFor(skillId: string, list: readonly Assessment[], now: number): string | undefined {
	return sortAssessments(list.filter((a) => isUpcoming(a, now) && (a.skillIds.length === 0 || a.skillIds.includes(skillId))))[0]?.date;
}

/** The skills that come first in Next up: the next dated assessment's mapped skills (empty when it maps none). */
export function focusSkills(list: readonly Assessment[], now: number): Set<string> {
	return new Set(nextAssessment(list, now)?.skillIds ?? []);
}

export const KIND_LABELS: Record<AssessmentKind, string> = { quiz: "Quiz", exam: "Exam", midterm: "Midterm", final: "Final", assignment: "Assignment", other: "Other" };

/** The teacher's line about the next assessment (core/pace.ts paceSection): the old exam date reads exactly as it always
 *  did ("14 Dec 2026, 30 days left"); a named one adds its title and topics. Undefined when none is upcoming. */
export function assessmentWhen(a: (Assessment & { date: string }) | undefined, now: number): string | undefined {
	if (!a) return undefined;
	const days = daysUntil(a.date, now);
	if (days < 0) return undefined;
	const left = days === 0 ? "today" : days === 1 ? "tomorrow" : `${days} days left`;
	const when = `${examDateLabel(a.date)}, ${left}`;
	if (a.legacy) return when;
	const topics = cleanLine(a.topics, 200);
	return `${a.title} (${a.kind}), ${when}${topics ? `, covering ${topics}` : ""}`;
}

// ─── relative dates ("next Friday") ─────────────────────────────────────────

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAYS_NB = ["søndag", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** "YYYY-MM-DD" of a local calendar day. */
function ymd(d: Date): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Today in the local time zone (the machine the app runs on: the learner's), as "YYYY-MM-DD" and a weekday name. */
export function todayLine(now: number): { date: string; weekday: string } {
	const d = new Date(now);
	const name = WEEKDAYS[d.getDay()]!;
	return { date: ymd(d), weekday: name[0]!.toUpperCase() + name.slice(1) };
}

/**
 * A date the learner said, resolved against today in the local time zone. Accepts "YYYY-MM-DD"; "today", "tomorrow";
 * "in N days/weeks"; "Friday", "this Friday", "next Friday" (all the coming Friday: the first one after today);
 * "Friday next week" / "Friday in two weeks" (that weekday in next week's / the week after's Monday-to-Sunday week); "12
 * March", "March 12" (this year, or next year when that day has passed). English, and the Norwegian weekdays. Null when
 * it cannot be read: the caller asks instead of guessing.
 */
export function resolveDateText(raw: string, now: number): string | null {
	const text = raw.trim().toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
	if (!text) return null;
	const iso = parseExamDate(text);
	if (iso) return iso;
	const base = new Date(now);
	base.setHours(12, 0, 0, 0);
	const plus = (days: number) => {
		const d = new Date(base);
		d.setDate(d.getDate() + days);
		return ymd(d);
	};
	if (text === "today" || text === "i dag") return plus(0);
	if (text === "tomorrow" || text === "i morgen") return plus(1);
	const inN = /^in (\d{1,3}|a|one|two|three|four) (day|days|week|weeks)$/.exec(text);
	if (inN) {
		const n = ({ a: 1, one: 1, two: 2, three: 3, four: 4 } as Record<string, number>)[inN[1]!] ?? Number(inN[1]);
		return plus(inN[2]!.startsWith("week") ? n * 7 : n);
	}
	const dayIndex = (word: string): number => {
		const en = WEEKDAYS.indexOf(word);
		return en !== -1 ? en : WEEKDAYS_NB.indexOf(word);
	};
	const weekday = /^(?:(?:this|next|on|neste|på) )?([a-zø]+)$/.exec(text);
	if (weekday && dayIndex(weekday[1]!) !== -1) {
		const target = dayIndex(weekday[1]!);
		const ahead = (target - base.getDay() + 7) % 7 || 7;
		return plus(ahead);
	}
	const weekOut = /^([a-zø]+) (?:next week|in (two|2) weeks|neste uke)$/.exec(text);
	if (weekOut && dayIndex(weekOut[1]!) !== -1) {
		const mondayOffset = (base.getDay() + 6) % 7; // days since this week's Monday
		const weeks = weekOut[2] ? 2 : 1;
		const target = (dayIndex(weekOut[1]!) + 6) % 7; // Monday = 0
		return plus(-mondayOffset + weeks * 7 + target);
	}
	const dm = /^(\d{1,2}) ([a-z]+)$/.exec(text);
	const md = /^([a-z]+) (\d{1,2})$/.exec(text);
	const dayMonth = dm ? { day: dm[1]!, month: dm[2]! } : md ? { day: md[2]!, month: md[1]! } : null;
	if (dayMonth) {
		const month = MONTHS.findIndex((m) => m === dayMonth.month || (dayMonth.month.length >= 3 && m.slice(0, 3) === dayMonth.month));
		const day = Number(dayMonth.day);
		if (month !== -1) {
			for (const year of [base.getFullYear(), base.getFullYear() + 1]) {
				const s = parseExamDate(`${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
				if (s && daysUntil(s, now) >= 0) return s;
			}
		}
	}
	return null;
}

/** "Fri 4 Dec 2026" for a card. */
export function dateWithWeekday(date: string): string {
	const [y, m, d] = date.split("-").map(Number) as [number, number, number];
	const day = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
	return `${day} ${examDateLabel(date)}`;
}

/** Monday of the week that holds `date` + `weeks` weeks + the weekday (1 Monday .. 7 Sunday): "Week 7 Friday" when the
 *  term's week 1 starts in the week of `termStart`. Null for a bad input. */
export function weekDate(termStart: string, week: number, weekday: number): string | null {
	const start = parseExamDate(termStart);
	if (!start || !Number.isInteger(week) || week < 1 || week > 60 || !Number.isInteger(weekday) || weekday < 1 || weekday > 7) return null;
	const [y, m, d] = start.split("-").map(Number) as [number, number, number];
	const t = new Date(Date.UTC(y, m - 1, d));
	const monday = new Date(t.getTime() - ((t.getUTCDay() + 6) % 7) * 86_400_000);
	const out = new Date(monday.getTime() + ((week - 1) * 7 + (weekday - 1)) * 86_400_000);
	return out.toISOString().slice(0, 10);
}

// ─── matching (the chat's save, the syllabus pass's re-run) ─────────────────

/** A title folded for matching: case, punctuation and spacing ignored ("Quiz #3" = "quiz 3"). */
export function titleKey(title: string): string {
	return title.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9æøå]+/g, " ").trim();
}

/** The existing items one proposed item is the same as: the same kind and title, or the same kind and date. */
export function sameAssessment(list: readonly Assessment[], item: Pick<Assessment, "kind" | "title" | "date">): Assessment[] {
	const key = titleKey(item.title);
	return list.filter((a) => a.kind === item.kind && (titleKey(a.title) === key || (!!item.date && a.date === item.date)));
}

// ─── the syllabus pass's proposal ───────────────────────────────────────────

/** One item the syllabus pass found. */
export interface ProposedAssessment {
	/** Proposal-local key ("p1"). */
	key: string;
	kind: AssessmentKind;
	title: string;
	date?: string;
	topics: string;
	skillIds: string[];
	/** Where it came from: "<file> p. N". */
	cite: string;
	/** new: not in the list · update: a syllabus item it changes · same: already in the list as it is · kept: the learner
	 *  entered or edited the matching item, which wins. Only new and update are applied on approval. */
	status: "new" | "update" | "same" | "kept";
	/** The existing item it matches (update, same, kept). */
	match?: string;
}

/** The proposal parked on the course until the learner approves it. */
export interface AssessmentProposal {
	createdAt: string;
	summary: string;
	items: ProposedAssessment[];
}

/** Each found item against the class's list: new, an update of a syllabus item, the same, or kept (the learner's own
 *  item wins). Pure. */
export function classifyProposal(found: ReadonlyArray<Omit<ProposedAssessment, "status" | "match">>, list: readonly Assessment[]): ProposedAssessment[] {
	const real = list.filter((a) => !a.legacy);
	const claimed = new Set<string>();
	return found.map((f) => {
		const match = sameAssessment(real, f).find((a) => !claimed.has(a.id));
		if (!match) return { ...f, status: "new" };
		claimed.add(match.id);
		if (match.source !== "syllabus") return { ...f, status: "kept", match: match.id };
		const same = match.title === f.title && match.date === f.date && match.topics === f.topics && sameSet(match.skillIds, f.skillIds);
		return { ...f, status: same ? "same" : "update", match: match.id };
	});
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((x) => b.includes(x));
}
