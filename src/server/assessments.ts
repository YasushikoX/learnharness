import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import type { CourseRecord, Skill, UpcomingView } from "../core/contracts.ts";
import {
	ASSESSMENT_KINDS,
	ASSESSMENTS_MAX,
	CITE_MAX,
	cleanLine,
	cleanSkillIds,
	cleanTimeZone,
	classifyProposal,
	courseAssessments,
	isTombstone,
	LEGACY_ITEM_ID,
	liveSelfReports,
	nextAssessment,
	NOTE_MAX,
	parseKind,
	PROPOSAL_ITEMS_MAX,
	PROPOSAL_SUMMARY_MAX,
	readAssessmentEntries,
	readSelfReportEntries,
	sameAssessment,
	sameEntry,
	sanitizeAssessment,
	sanitizeSelfReport,
	SELF_REPORT_STANCES,
	sortAssessments,
	TITLE_MAX,
	TOPICS_MAX,
	boundAssessments,
	boundSelfReports,
	upsertEntry,
	type Assessment,
	type AssessmentEntry,
	type AssessmentKind,
	type AssessmentProposal,
	type AssessmentSource,
	type ProposedAssessment,
	type SelfReport,
	type SelfReportEntry,
	type SelfReportStance,
	type Tombstone,
} from "../core/assessments.ts";
import { parseExamDate } from "../core/exam-plan.ts";
import { materialBlock, type LessonMaterial } from "../core/materials.ts";
import { callUsage } from "../agent/subagents/extraction.ts";
import { pdfExtract } from "../agent/subagents/pdf-ops.ts";
import { readConvertedPages } from "../agent/tools/material-content.ts";
import { DEFAULT_LESSON_LANGUAGE, type LessonLanguage } from "../core/language.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { mergeSkillLines } from "../core/skills.ts";
import { piEngineForSpec } from "../agent/models.ts";
import { findAssessments, type MaterialSource } from "../agent/subagents/assessment-finder.ts";
import { materialTools } from "../agent/tools/materials.ts";
import { listMaterials, waitForMaterials } from "./materials.ts";
import { stores } from "./stores.ts";
import { boundEntries } from "../core/assessments.ts";
import { classifyLectures, LECTURES_MAX, liveLectures, PROPOSAL_LECTURES_MAX, readLectureEntries, type LectureEntry, type ProposedLecture } from "../core/lectures.ts";
import { lectureFromProposal, lectureUpdateFromProposal, maybeLinkLectures } from "./lectures.ts";

/**
 * Quizzes, exams and self-reports — the service seam (WP8, 2026-11-25; core/assessments.ts; docs/courses.md). Routes
 * (app/api/courses/[id]/assessments/*, self-reports/*, app/api/chats/[id]/class-changes/*) and the Short question tools
 * (agent/tools/class-facts.ts, through `classFactsPort`) delegate here. Every write goes through the course store, which
 * stamps the record and announces courses-changed.
 */

type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

/** An ISO stamp strictly after `prev` (two writes in one millisecond still order). */
export function stampAfter(prev?: string): string {
	const now = Date.now();
	const p = prev ? Date.parse(prev) : NaN;
	return new Date(Number.isNaN(p) || now > p ? now : p + 1).toISOString();
}

function courseSkills(course: CourseRecord): Array<{ id: string; name: string }> {
	const all = new Map(mergeSkillLines(stores.skillStore.readSkillLines()).map((s: Skill) => [s.id, s]));
	return course.skills.flatMap((id) => (all.has(id) ? [{ id, name: all.get(id)!.name }] : []));
}

/** Write the list (bounded) with any other fields in the same update (server/class-changes.ts Undo uses it too). */
export function writeAssessmentEntries(courseId: string, entries: readonly AssessmentEntry[], extra: Partial<CourseRecord> = {}): CourseRecord {
	return writeAssessments(courseId, entries, extra);
}

function writeAssessments(courseId: string, entries: readonly AssessmentEntry[], extra: Partial<CourseRecord> = {}): CourseRecord {
	return stores.courseStore.updateCourse(courseId, { assessments: boundAssessments(entries), ...extra })!;
}

function writeSelfReports(courseId: string, entries: readonly SelfReportEntry[]): CourseRecord {
	return stores.courseStore.updateCourse(courseId, { selfReports: boundSelfReports(entries) })!;
}

// ─── assessments: create, update, delete ─────────────────────────────────────

/** What a create or update may carry (the API body, the chat tool, an approved proposal item). */
export interface AssessmentInput {
	kind?: unknown;
	title?: unknown;
	/** "YYYY-MM-DD", or null to clear. */
	date?: unknown;
	topics?: unknown;
	skillIds?: unknown;
	/** true: it covers every approved skill of the class (a cumulative final; WP9 review 1, finding 12), stored as a flag.
	 *  Giving `skillIds` instead makes it a list again. */
	allSkills?: unknown;
}

/** One change to the list, as the chat cards and Undo read it. */
export interface AssessmentChange {
	action: "added" | "updated" | "removed";
	/** The item before (null when added); `legacy` when it was the old exam date. */
	before: Assessment | null;
	/** The item after (null when removed). */
	after: Assessment | null;
	/** The entry the change wrote: its id and stamp (a removal's tombstone, or the cleared exam date's). */
	id: string;
	stamp: string;
}

type CheckedInput = { kind?: AssessmentKind; title?: string; date?: string | null; topics?: string; skillIds?: string[]; allSkills?: boolean };

/** Check an input's fields against the class (skills on its approved map). `partial`: only the fields present. */
function checkInput(input: AssessmentInput, course: CourseRecord, partial: boolean): Result<CheckedInput> {
	const out: CheckedInput = {};
	if (input.kind !== undefined || !partial) {
		const kind = parseKind(input.kind);
		if (!kind) return { ok: false, status: 400, error: `kind must be one of ${ASSESSMENT_KINDS.join(", ")}` };
		out.kind = kind;
	}
	if (input.title !== undefined || !partial) {
		const title = cleanLine(input.title, TITLE_MAX);
		if (!title) return { ok: false, status: 400, error: `title must be 1 to ${TITLE_MAX} characters` };
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
		out.topics = input.topics.trim().slice(0, TOPICS_MAX);
	}
	if (input.skillIds !== undefined) {
		if (!Array.isArray(input.skillIds)) return { ok: false, status: 400, error: "skillIds must be a list of skill ids" };
		const ids = cleanSkillIds(input.skillIds);
		const own = new Set(course.skills);
		const stranger = ids.find((id) => !own.has(id));
		if (stranger) return { ok: false, status: 400, error: `${stranger} is not a skill on this class's approved map` };
		out.skillIds = ids;
		out.allSkills = false;
	}
	if (input.allSkills !== undefined && input.allSkills !== false) {
		if (input.allSkills !== true) return { ok: false, status: 400, error: "allSkills must be true or false" };
		if (course.skills.length === 0) return { ok: false, status: 409, error: "The class has no approved skill map yet" };
		out.allSkills = true;
		out.skillIds = [];
	}
	return { ok: true, value: out };
}

const newId = () => `as_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const liveCount = (entries: readonly AssessmentEntry[]) => entries.filter((e) => !isTombstone(e)).length;
const FULL = `This class already has ${ASSESSMENTS_MAX} assessments: remove one first`;

/** A new item from checked fields. Pure. */
function newItem(v: CheckedInput, source: AssessmentSource, cite?: string, prevStamp?: string): Assessment {
	return {
		id: newId(),
		kind: v.kind!,
		title: v.title!,
		...(v.date ? { date: v.date } : {}),
		topics: v.topics ?? "",
		skillIds: v.skillIds ?? [],
		...(v.allSkills ? { allSkills: true as const } : {}),
		source,
		updatedAt: stampAfter(prevStamp),
		...(cite ? { cite: cleanLine(cite, CITE_MAX) } : {}),
	};
}

/** An item with checked fields applied over it (only the fields present). Pure. */
function applyInput(before: Assessment, v: CheckedInput, source: AssessmentSource): Assessment {
	const merged: Assessment = {
		...before,
		...(v.kind ? { kind: v.kind } : {}),
		...(v.title ? { title: v.title } : {}),
		...(v.topics !== undefined ? { topics: v.topics } : {}),
		...(v.skillIds ? { skillIds: v.skillIds } : {}),
		source,
		updatedAt: stampAfter(before.legacy ? undefined : before.updatedAt),
	};
	if (v.date === null) delete merged.date;
	else if (v.date) merged.date = v.date;
	if (v.allSkills === true) merged.allSkills = true;
	else if (v.allSkills === false) delete merged.allSkills;
	delete merged.legacy;
	return merged;
}

/** Add an assessment. Refused (409) when the class already has ASSESSMENTS_MAX: nothing is ever dropped to make room. */
export function createAssessment(courseId: string, input: AssessmentInput, source: AssessmentSource = "manual", cite?: string): Result<AssessmentChange> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	const checked = checkInput(input, course, false);
	if (!checked.ok) return checked;
	const entries = readAssessmentEntries(course.assessments);
	if (liveCount(entries) >= ASSESSMENTS_MAX) return { ok: false, status: 409, error: FULL };
	const item = newItem(checked.value, source, cite);
	writeAssessments(courseId, [...entries, item]);
	return { ok: true, value: { action: "added", before: null, after: item, id: item.id, stamp: item.updatedAt } };
}

/** Change an assessment (only the fields given). An edit by the learner makes it theirs: a later syllabus pass keeps it.
 *
 *  The old exam date (LEGACY_EXAM_ID) becomes a real assessment carrying the edit, and `examDate` is cleared. It takes the
 *  stable id LEGACY_ITEM_ID (review 1, finding 4), so two devices converting it write one item that merges by id; only
 *  when that id already holds a live item (converted before, and an older device set a new exam date since) does the
 *  new one get a fresh id, so the earlier item is never overwritten. */
export function updateAssessment(courseId: string, id: string, input: AssessmentInput, source: AssessmentSource = "manual"): Result<AssessmentChange> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	const checked = checkInput(input, course, true);
	if (!checked.ok) return checked;
	const entries = readAssessmentEntries(course.assessments);
	const before = courseAssessments(course).find((a) => a.id === id);
	if (!before) return { ok: false, status: 404, error: "Unknown assessment" };
	const merged = applyInput(before, checked.value, source);
	if (before.legacy) {
		const held = entries.find((e) => e.id === LEGACY_ITEM_ID);
		const stableFree = !held || isTombstone(held);
		const after: Assessment = { ...merged, id: stableFree ? LEGACY_ITEM_ID : newId(), updatedAt: stampAfter(held?.updatedAt) };
		if (!stableFree && liveCount(entries) >= ASSESSMENTS_MAX) return { ok: false, status: 409, error: FULL };
		writeAssessments(courseId, upsertEntry<AssessmentEntry>(entries, after), { examDate: undefined });
		return { ok: true, value: { action: "updated", before, after, id: after.id, stamp: after.updatedAt } };
	}
	writeAssessments(courseId, upsertEntry<AssessmentEntry>(entries, merged));
	return { ok: true, value: { action: "updated", before, after: merged, id: merged.id, stamp: merged.updatedAt } };
}

/** Delete an assessment: a tombstone, so the deletion survives a sync. The old exam date: `examDate` is cleared and the
 *  deletion is recorded as a tombstone on LEGACY_ITEM_ID, its revision (review 1, finding 4): the card's Undo holds
 *  only while exactly that tombstone does, so a later clearing of the field never revives it. When LEGACY_ITEM_ID holds
 *  a live item, the field is cleared with no tombstone and the change offers no Undo (`stamp` ""). */
export function deleteAssessment(courseId: string, id: string): Result<AssessmentChange> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	const before = courseAssessments(course).find((a) => a.id === id);
	if (!before) return { ok: false, status: 404, error: "Unknown assessment" };
	const entries = readAssessmentEntries(course.assessments);
	if (before.legacy) {
		const held = entries.find((e) => e.id === LEGACY_ITEM_ID);
		if (held && !isTombstone(held)) {
			stores.courseStore.updateCourse(courseId, { examDate: undefined });
			return { ok: true, value: { action: "removed", before, after: null, id: LEGACY_ITEM_ID, stamp: "" } };
		}
		const tomb: Tombstone = { id: LEGACY_ITEM_ID, deleted: true, updatedAt: stampAfter(held?.updatedAt) };
		writeAssessments(courseId, upsertEntry<AssessmentEntry>(entries, tomb), { examDate: undefined });
		return { ok: true, value: { action: "removed", before, after: null, id: LEGACY_ITEM_ID, stamp: tomb.updatedAt } };
	}
	const tomb: Tombstone = { id, deleted: true, updatedAt: stampAfter(before.updatedAt) };
	writeAssessments(courseId, upsertEntry<AssessmentEntry>(entries, tomb));
	return { ok: true, value: { action: "removed", before, after: null, id, stamp: tomb.updatedAt } };
}

// ─── self-reports ────────────────────────────────────────────────────────────

/** Record what the learner said about some skills (Short question's record_self_report). Only skills on the approved map. */
export function recordSelfReport(courseId: string, input: { chatId?: string; skillIds: unknown; stance: unknown; note?: unknown }): Result<SelfReport> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	if (course.skills.length === 0) return { ok: false, status: 409, error: "The class has no approved skill map yet" };
	const stance = typeof input.stance === "string" && (SELF_REPORT_STANCES as readonly string[]).includes(input.stance) ? (input.stance as SelfReportStance) : null;
	if (!stance) return { ok: false, status: 400, error: `stance must be one of ${SELF_REPORT_STANCES.join(", ")}` };
	const ids = cleanSkillIds(input.skillIds);
	if (ids.length === 0) return { ok: false, status: 400, error: "name at least one skill id" };
	const own = new Set(course.skills);
	const stranger = ids.filter((id) => !own.has(id));
	if (stranger.length > 0) return { ok: false, status: 400, error: `${stranger.join(", ")} ${stranger.length === 1 ? "is" : "are"} not on this class's approved skill map` };
	const now = stampAfter();
	const report: SelfReport = {
		id: `sr_${randomUUID().replace(/-/g, "").slice(0, 10)}`,
		...(input.chatId ? { chatId: input.chatId } : {}),
		at: now,
		skillIds: ids,
		stance,
		note: cleanLine(input.note, NOTE_MAX),
		updatedAt: now,
	};
	writeSelfReports(courseId, [...readSelfReportEntries(course.selfReports), report]);
	return { ok: true, value: report };
}

/** Remove a self-report (the page's Remove, a card's Undo): a tombstone. */
export function deleteSelfReport(courseId: string, id: string): Result<Tombstone> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	const entries = readSelfReportEntries(course.selfReports);
	const held = entries.find((e) => e.id === id);
	if (!held || isTombstone(held)) return { ok: false, status: 404, error: "Unknown self-report" };
	const tomb: Tombstone = { id, deleted: true, updatedAt: stampAfter(held.updatedAt) };
	writeSelfReports(courseId, upsertEntry<SelfReportEntry>(entries, tomb));
	return { ok: true, value: tomb };
}

/** One retraction (Short question's self_report_retract, WP9 review 1 finding 13): the class's reports it changed as
 *  they were (`before`) and the entries it wrote (`after`: the report without those skills, or its tombstone). */
export interface SelfReportRetraction {
	before: SelfReport[];
	after: SelfReportEntry[];
}

/** Take back what the learner said about some skills ("actually I do get X now"): every live report of this class about
 *  them, whichever chat (or none) made it, loses those skills; a report left with none is removed (a tombstone). 404 when
 *  no report of the class is about them. */
export function retractSelfReports(courseId: string, skillIds: unknown): Result<SelfReportRetraction> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	const ids = new Set(cleanSkillIds(skillIds));
	if (ids.size === 0) return { ok: false, status: 400, error: "name at least one skill id" };
	let entries = readSelfReportEntries(course.selfReports);
	const before: SelfReport[] = [];
	const after: SelfReportEntry[] = [];
	for (const e of entries) {
		if (isTombstone(e) || !e.skillIds.some((s) => ids.has(s))) continue;
		before.push(e);
		const rest = e.skillIds.filter((s) => !ids.has(s));
		const next: SelfReportEntry = rest.length > 0 ? { ...e, skillIds: rest, updatedAt: stampAfter(e.updatedAt) } : { id: e.id, deleted: true, updatedAt: stampAfter(e.updatedAt) };
		after.push(next);
		entries = upsertEntry<SelfReportEntry>(entries, next);
	}
	if (before.length === 0) return { ok: false, status: 404, error: "The learner has said nothing in this class about those skills" };
	writeSelfReports(courseId, entries);
	return { ok: true, value: { before, after } };
}

/** Undo a retraction (the caller checked the list still holds exactly what it wrote): each report as it was, with a
 *  fresh revision so the Undo wins a sync. */
export function revertSelfReportRetraction(courseId: string, change: SelfReportRetraction): Result<true> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "The class was deleted" };
	let entries = readSelfReportEntries(course.selfReports);
	for (const r of change.before) {
		const held = entries.find((e) => e.id === r.id);
		entries = upsertEntry<SelfReportEntry>(entries, { ...r, updatedAt: stampAfter(held?.updatedAt ?? r.updatedAt) });
	}
	writeSelfReports(courseId, entries);
	return { ok: true, value: true };
}

/** Is the stored self-report entry exactly this one? */
export function sameSelfReportEntry(held: unknown, expected: SelfReportEntry): boolean {
	if (!held) return false;
	if (isTombstone(expected) || isTombstone(held)) return isTombstone(held) && isTombstone(expected) && (held as Tombstone).updatedAt === expected.updatedAt;
	const a = sanitizeSelfReport(held);
	const b = sanitizeSelfReport(expected);
	return a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b);
}

/** Every course's live self-reports with the class that holds them, for the mastery fold (core/mastery.ts
 *  applySelfReports). */
export function allSelfReports(courses: readonly CourseRecord[]): Array<SelfReport & { courseId: string }> {
	return courses.flatMap((c) => liveSelfReports(c.selfReports).filter((r) => r.skillIds.some((id) => c.skills.includes(id))).map((r) => ({ ...r, courseId: c.id })));
}

// ─── "Find quizzes and exams" (agent/subagents/assessment-finder.ts) ─────────

const FIND_KEY = Symbol.for("lh.courseAssessmentFindRuns");
function findRuns(): Map<string, AbortController> {
	const g = globalThis as Record<symbol, Map<string, AbortController> | undefined>;
	g[FIND_KEY] ??= new Map();
	return g[FIND_KEY];
}

/** How many syllabus passes are running (the idle check reads this). */
export function assessmentFindCount(): number {
	return findRuns().size;
}

export function assessmentFinding(courseId: string): boolean {
	return findRuns().has(courseId);
}

function languageOf(course: CourseRecord): LessonLanguage {
	return course.language ?? stores.settingsStore.readSettings()?.general?.language ?? DEFAULT_LESSON_LANGUAGE;
}

/** Start the pass. Returns at once; the run parks its proposal on the record and announces it. */
export function startAssessmentFind(courseId: string): Result<CourseRecord> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	if (findRuns().has(courseId)) return { ok: false, status: 409, error: "The syllabus is already being read" };
	if (listMaterials(courseId).length === 0) return { ok: false, status: 400, error: "Add the syllabus or another class file first" };
	const controller = new AbortController();
	findRuns().set(courseId, controller);
	const updated = stores.courseStore.updateCourse(courseId, { assessmentsError: undefined })!;
	void runFind(courseId, controller).finally(() => findRuns().delete(courseId));
	return { ok: true, value: updated };
}

/** Abort a class's pass (the class is being deleted). */
export function abortAssessmentFind(courseId: string): void {
	findRuns().get(courseId)?.abort();
}

/** Test seam: the pass with an injected finder (no model). */
export type AssessmentFinder = typeof findAssessments;
let finderOverride: AssessmentFinder | null = null;
export function setAssessmentFinderForTests(f: AssessmentFinder | null): void {
	finderOverride = f;
}

/** Per material, the text the finder's quote and page checks read (agent/subagents/assessment-finder.ts): a PDF's pages
 *  (its converted content.md, else pdfjs on the original), a text's body (an image's transcription); null when it cannot
 *  be read on this device. Bounded per material. */
const SOURCE_CHARS_MAX = 400_000;
async function loadSources(courseId: string, materials: readonly LessonMaterial[]): Promise<Map<string, MaterialSource>> {
	const out = new Map<string, MaterialSource>();
	for (const m of materials) {
		try {
			if (m.kind === "pdf") {
				const converted = await readConvertedPages(stores.materialStore.auxPath(courseId, m.id, "content.md"));
				const pages = new Map<number, string>();
				if (converted) for (const p of converted) pages.set(p.page, `${pages.get(p.page) ?? ""}\n${p.text}`.slice(0, SOURCE_CHARS_MAX));
				else {
					const text = await pdfExtract(stores.materialStore.filePath(courseId, m), "all");
					for (const part of text.split(/^--- Page (\d+) ---$/m).slice(1).reduce<Array<[number, string]>>((acc, s, i, arr) => (i % 2 === 0 ? [...acc, [Number(s), arr[i + 1] ?? ""]] : acc), [])) {
						pages.set(part[0], part[1].slice(0, SOURCE_CHARS_MAX));
					}
				}
				out.set(m.id, pages.size > 0 ? { kind: "pages", pages } : null);
			} else {
				const file = m.kind === "image" ? stores.materialStore.auxPath(courseId, m.id, "content.md") : stores.materialStore.filePath(courseId, m);
				out.set(m.id, { kind: "text", text: (await fs.readFile(file, "utf8")).slice(0, SOURCE_CHARS_MAX) });
			}
		} catch {
			out.set(m.id, null); // the original is on another device, or unreadable: no date can be checked from it
		}
	}
	return out;
}

async function runFind(courseId: string, controller: AbortController): Promise<void> {
	const startedAt = Date.now();
	const steps: ReturnType<typeof callUsage>[] = [];
	let model = "unknown";
	// every model call's usage is kept on the course's planner log, as the planner's is (review 1, finding 10)
	const settle = (patch: Partial<CourseRecord>) => {
		const current = stores.courseStore.getCourse(courseId);
		if (!current) return;
		const usage = steps.length > 0 ? [...(current.drafts ?? []), { startedAt, at: new Date().toISOString(), durationMs: Date.now() - startedAt, pass: "find-assessments" as const, planner: { model, steps } }] : undefined;
		stores.courseStore.updateCourse(courseId, { ...patch, ...(usage ? { drafts: usage } : {}) });
	};
	try {
		await waitForMaterials(courseId);
		const course = stores.courseStore.getCourse(courseId);
		if (!course || controller.signal.aborted) return;
		const spec = finderOverride ? null : resolveRoleSpec("coursePlanner", stores.settingsStore.readSettings());
		if (!finderOverride && !spec) {
			settle({ assessmentsError: "No model is configured for the class planner (Settings → Agent: the strong slot or a Class planner override)" });
			return;
		}
		const materials = listMaterials(courseId);
		const materialsSection = `<curriculum>\n${materials.map((m) => materialBlock(m, stores.materialStore.filePath(courseId, m))).join("\n\n")}\n</curriculum>`;
		const skills = mergeSkillLines(stores.skillStore.readSkillLines()).filter((s) => course.skills.includes(s.id)).map((s) => ({ id: s.id, name: s.name, statement: s.statement }));
		const run = finderOverride ?? findAssessments;
		const sources = await loadSources(courseId, materials);
		const found = await run(
			{ title: course.title, materialsSection, materials: materials.map((m) => ({ id: m.id, name: m.name, kind: m.kind })), sources, skills, language: languageOf(course) },
			{
				engine: spec ? piEngineForSpec(spec) : undefined,
				signal: controller.signal,
				tools: materialTools({ chatId: courseId, store: stores.materialStore }),
				onStep: (usage, m) => {
					model = m;
					steps.push(callUsage(usage));
				},
				courseId,
			},
		);
		const fresh = stores.courseStore.getCourse(courseId);
		if (!fresh || controller.signal.aborted) return;
		// capped before it is stored, whatever the finder returned
		const items = found.items.slice(0, PROPOSAL_ITEMS_MAX).map((it, i) => ({ ...it, key: `p${i + 1}` }));
		// WP9: the lecture schedule the same run read, classified against the stored lectures
		const lectures = (found.lectures ?? []).slice(0, PROPOSAL_LECTURES_MAX).map((it, i) => ({ ...it, key: `l${i + 1}` }));
		const proposal: AssessmentProposal = {
			id: `ap_${randomUUID().replace(/-/g, "").slice(0, 10)}`,
			createdAt: new Date().toISOString(),
			summary: cleanLine(found.summary, PROPOSAL_SUMMARY_MAX),
			...(found.partial ? { partial: true as const } : {}),
			items: classifyProposal(items, courseAssessments(fresh)),
			...(lectures.length > 0 ? { lectures: classifyLectures(lectures, liveLectures(fresh.lectures)) } : {}),
		};
		settle({ assessmentProposal: proposal, assessmentsScannedAt: proposal.createdAt, assessmentsError: undefined });
	} catch (err) {
		if (controller.signal.aborted) return;
		settle({ assessmentsError: err instanceof Error ? err.message : String(err), assessmentsScannedAt: new Date().toISOString() });
	}
}

/** What the proposal actions may carry. `proposalId` is the proposal the learner was shown: required whenever the stored
 *  proposal has an id, and a different one is refused (409) so the page refreshes (review 1, finding 1). */
export type ProposalAction = ({ action: "approve"; keys?: string[]; edits?: Record<string, AssessmentInput> } | { action: "drop"; key: string } | { action: "discard" }) & { proposalId?: string };

/** The proposal's actions: approve (all pending items, or the listed keys; `edits` changes an item before it is written),
 *  drop one item, or discard the whole proposal. Only new and update items are written; a kept one (the learner's own)
 *  and a same one are left alone.
 *
 *  An approval is staged against ONE snapshot of the list and written in ONE update together with what is left of the
 *  proposal (review 1, finding 7): when any item is refused, or the additions would take the class over ASSESSMENTS_MAX,
 *  nothing is written. An update is bound to the item it matched when the pass ran (`match` and `matchStamp`, review 1
 *  finding 6): deleted or edited since, it is left alone, never recreated or re-matched by its old fields. A new item
 *  that the learner has meanwhile entered themselves (same kind and title, or kind and date) is left alone too. */
export function actOnProposal(courseId: string, action: ProposalAction): Result<{ course: CourseRecord; skipped: number }> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	const proposal = course.assessmentProposal;
	if (!proposal || !Array.isArray(proposal.items)) return { ok: false, status: 409, error: "There is no proposal" };
	if (proposal.id && action.proposalId !== proposal.id) return { ok: false, status: 409, error: "The proposal changed since this page showed it: look again" };
	if (action.action === "discard") return { ok: true, value: { course: stores.courseStore.updateCourse(courseId, { assessmentProposal: undefined })!, skipped: 0 } };
	const pendingOf = <T extends { status: ProposedAssessment["status"] }>(items: readonly T[]) => items.filter((i) => i.status === "new" || i.status === "update");
	// WP9: the lecture schedule rides the same proposal; its keys are "l1", "l2", …
	const proposedLectures: ProposedLecture[] = Array.isArray(proposal.lectures) ? proposal.lectures : [];
	const known = (k: string) => proposal.items.some((i) => i.key === k) || proposedLectures.some((l) => l.key === k);
	/** What is left of the proposal: undefined when nothing is pending in either list. */
	const leftOver = (items: readonly ProposedAssessment[], lectures: readonly ProposedLecture[]) =>
		pendingOf(items).length + pendingOf(lectures).length > 0 ? { ...proposal, items: [...items], ...(lectures.length > 0 ? { lectures: [...lectures] } : { lectures: undefined }) } : undefined;
	if (action.action === "drop") {
		if (!known(action.key)) return { ok: false, status: 404, error: "Unknown proposal item" };
		const items = proposal.items.filter((i) => i.key !== action.key);
		const lectures = proposedLectures.filter((l) => l.key !== action.key);
		return { ok: true, value: { course: stores.courseStore.updateCourse(courseId, { assessmentProposal: leftOver(items, lectures) })!, skipped: 0 } };
	}
	if (action.keys?.some((k) => !known(k))) return { ok: false, status: 404, error: "Unknown proposal item" };
	const chosen = pendingOf(proposal.items).filter((i) => !action.keys || action.keys.includes(i.key));
	const chosenLectures = pendingOf(proposedLectures).filter((l) => !action.keys || action.keys.includes(l.key));
	const own = new Set(course.skills);
	let entries = readAssessmentEntries(course.assessments);
	const startLive = liveCount(entries);
	let prevStamp: string | undefined;
	// items left alone because the learner changed the list since the pass ran: the page says how many (re-check 1, N4)
	let skipped = 0;
	for (const item of chosen) {
		const edit = action.edits?.[item.key];
		const input: AssessmentInput = { kind: item.kind, title: item.title, date: item.date ?? null, topics: item.topics, skillIds: item.skillIds.filter((s) => own.has(s)), ...(edit ?? {}) };
		const checked = checkInput(input, course, false);
		if (!checked.ok) return { ok: false, status: checked.status, error: `${item.title}: ${checked.error}` };
		const source: AssessmentSource = edit ? "manual" : "syllabus";
		const live = entries.filter((e): e is Assessment => !isTombstone(e));
		if (item.status === "update" && item.match) {
			const held = entries.find((e) => e.id === item.match);
			// deleted, or changed since the pass saw it: the learner's later edit or deletion wins
			if (!held || isTombstone(held) || (item.matchStamp !== undefined && held.updatedAt !== item.matchStamp)) {
				skipped++;
				continue;
			}
			const merged = applyInput(held, checked.value, source);
			entries = upsertEntry<AssessmentEntry>(entries, merged);
			continue;
		}
		// new: unless the learner has entered it meanwhile
		if (sameAssessment(live, { kind: checked.value.kind!, title: checked.value.title!, ...(checked.value.date ? { date: checked.value.date } : {}) }).length > 0) {
			skipped++;
			continue;
		}
		const made = newItem(checked.value, source, item.cite, prevStamp);
		prevStamp = made.updatedAt;
		entries = [...entries, made];
	}
	const endLive = liveCount(entries);
	if (endLive > startLive && endLive > ASSESSMENTS_MAX) {
		return { ok: false, status: 409, error: `Adding ${endLive - startLive} would take this class over ${ASSESSMENTS_MAX} assessments: remove some first, or add fewer` };
	}
	// WP9: the lectures, staged on the same snapshot and written in the same update; the same binding rules
	let lectureEntries: LectureEntry[] = readLectureEntries(course.lectures);
	const startLectures = lectureEntries.filter((e) => !isTombstone(e)).length;
	let lectureStamp: string | undefined;
	for (const item of chosenLectures) {
		const live = liveLectures(lectureEntries);
		if (item.status === "update" && item.match) {
			const held = lectureEntries.find((e) => e.id === item.match);
			if (!held || isTombstone(held) || (item.matchStamp !== undefined && held.updatedAt !== item.matchStamp)) {
				skipped++;
				continue;
			}
			lectureEntries = upsertEntry<LectureEntry>(lectureEntries, lectureUpdateFromProposal(held, item, own));
			continue;
		}
		// new: unless the learner has entered it meanwhile (classifyLectures against the list as it is now)
		if (classifyLectures([item], live)[0]!.status !== "new") {
			skipped++;
			continue;
		}
		const made = lectureFromProposal(item, own, lectureStamp);
		lectureStamp = made.updatedAt;
		lectureEntries = [...lectureEntries, made];
	}
	const endLectures = lectureEntries.filter((e) => !isTombstone(e)).length;
	if (endLectures > startLectures && endLectures > LECTURES_MAX) {
		return { ok: false, status: 409, error: `Adding ${endLectures - startLectures} lectures would take this class over ${LECTURES_MAX}: remove some first, or add fewer` };
	}
	const rest = pendingOf(proposal.items).filter((i) => !chosen.some((c) => c.key === i.key));
	const restLectures = pendingOf(proposedLectures).filter((l) => !chosenLectures.some((c) => c.key === l.key));
	const lecturesChanged = chosenLectures.length > 0;
	const written = writeAssessments(courseId, entries, { assessmentProposal: leftOver(rest, restLectures), ...(lecturesChanged ? { lectures: boundEntries(lectureEntries) } : {}) });
	if (lecturesChanged) maybeLinkLectures(courseId);
	return { ok: true, value: { course: written, skipped } };
}

// ─── the page's view ─────────────────────────────────────────────────────────

const SYLLABUS_RE = /syllab|course outline|course plan|schedule|semesterplan|emneplan|timeplan|undervisningsplan|exam dates|eksamensdato/i;

/** The Upcoming list's view (CourseView.upcoming). */
export function upcomingView(course: CourseRecord, now = Date.now(), timeZone?: string): UpcomingView {
	const items = courseAssessments(course);
	const next = nextAssessment(items, now, timeZone);
	const proposal = course.assessmentProposal && Array.isArray(course.assessmentProposal.items) ? course.assessmentProposal : undefined;
	// a newly added file that reads like a syllabus, added since the last pass: suggested once (the page can dismiss it)
	let syllabusHint: UpcomingView["syllabusHint"];
	if (!proposal && !assessmentFinding(course.id)) {
		const since = course.assessmentsScannedAt ?? "";
		const m = stores.materialStore
			.list(course.id)
			.find((x) => x.status === "ready" && x.addedAt > since && (SYLLABUS_RE.test(x.name) || SYLLABUS_RE.test((x.profile ?? "").slice(0, 1500))));
		if (m) syllabusHint = { materialId: m.id, name: m.name };
	}
	return {
		items,
		...(next ? { nextId: next.id } : {}),
		finding: assessmentFinding(course.id),
		...(course.assessmentsError ? { error: course.assessmentsError } : {}),
		...(proposal ? { proposal } : {}),
		...(syllabusHint ? { syllabusHint } : {}),
	};
}

// ─── the Short question tools' port (agent/tools/class-facts.ts) ────────────

// ─── the learner's time zone (review 1, finding 3) ──────────────────────────

const TZ_KEY = Symbol.for("lh.clientTimeZones");
function zones(): Map<string, string> {
	const g = globalThis as Record<symbol, Map<string, string> | undefined>;
	g[TZ_KEY] ??= new Map();
	return g[TZ_KEY];
}

/** Remember the time zone a chat request carried (the browser's: `timeZone` in POST /api/chat). Unknown names are
 *  ignored. In memory only: the next request carries it again. */
export function noteClientTimeZone(chatId: string, raw: unknown): void {
	const tz = cleanTimeZone(raw);
	if (tz) zones().set(chatId, tz);
}

/** The learner's time zone for a chat's dates: the client's when its requests carry it, else undefined (the machine's
 *  own zone, which is the learner's when the app runs on their machine). */
export function learnerTimeZone(chatId: string): string | undefined {
	return zones().get(chatId);
}

/** The learner's time zone a page request carries (the X-LH-Time-Zone header, as the chat's), or undefined (the
 *  machine's). The class page's read, its position edit and the Today list use it (WP9 review 1, finding 10). */
export function requestTimeZone(req: Request): string | undefined {
	return cleanTimeZone(req.headers.get("x-lh-time-zone"));
}
