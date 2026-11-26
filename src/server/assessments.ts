import { randomUUID } from "node:crypto";
import type { CourseRecord, Skill, UpcomingView } from "../core/contracts.ts";
import {
	ASSESSMENT_KINDS,
	CITE_MAX,
	cleanLine,
	cleanSkillIds,
	classifyProposal,
	courseAssessments,
	isTombstone,
	LEGACY_EXAM_ID,
	liveSelfReports,
	nextAssessment,
	NOTE_MAX,
	parseKind,
	readAssessmentEntries,
	readSelfReportEntries,
	sanitizeAssessment,
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
	type SelfReport,
	type SelfReportEntry,
	type SelfReportStance,
	type Tombstone,
} from "../core/assessments.ts";
import { parseExamDate } from "../core/exam-plan.ts";
import { materialBlock } from "../core/materials.ts";
import { DEFAULT_LESSON_LANGUAGE, type LessonLanguage } from "../core/language.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { mergeSkillLines } from "../core/skills.ts";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { piEngineForSpec } from "../agent/models.ts";
import { findAssessments } from "../agent/subagents/assessment-finder.ts";
import { materialTools } from "../agent/tools/materials.ts";
import { CLASS_CHANGE_TOOLS, type ClassChange, type ClassFactsPort } from "../agent/tools/class-facts.ts";
import { listMaterials, waitForMaterials } from "./materials.ts";
import { stores } from "./stores.ts";

/**
 * Quizzes, exams and self-reports — the service seam (WP8, 2026-11-25; core/assessments.ts; docs/courses.md). Routes
 * (app/api/courses/[id]/assessments/*, self-reports/*, app/api/chats/[id]/class-changes/*) and the Short question tools
 * (agent/tools/class-facts.ts, through `classFactsPort`) delegate here. Every write goes through the course store, which
 * stamps the record and announces courses-changed.
 */

type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

/** An ISO stamp strictly after `prev` (two writes in one millisecond still order). */
function stampAfter(prev?: string): string {
	const now = Date.now();
	const p = prev ? Date.parse(prev) : NaN;
	return new Date(Number.isNaN(p) || now > p ? now : p + 1).toISOString();
}

function courseSkills(course: CourseRecord): Array<{ id: string; name: string }> {
	const all = new Map(mergeSkillLines(stores.skillStore.readSkillLines()).map((s: Skill) => [s.id, s]));
	return course.skills.flatMap((id) => (all.has(id) ? [{ id, name: all.get(id)!.name }] : []));
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

/** Check an input's fields against the class (skills on its approved map). `partial`: only the fields present. */
function checkInput(input: AssessmentInput, course: CourseRecord, partial: boolean): Result<{ kind?: AssessmentKind; title?: string; date?: string | null; topics?: string; skillIds?: string[] }> {
	const out: { kind?: AssessmentKind; title?: string; date?: string | null; topics?: string; skillIds?: string[] } = {};
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
	}
	return { ok: true, value: out };
}

/** Add an assessment. */
export function createAssessment(courseId: string, input: AssessmentInput, source: AssessmentSource = "manual", cite?: string): Result<AssessmentChange> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	const checked = checkInput(input, course, false);
	if (!checked.ok) return checked;
	const v = checked.value;
	const entries = readAssessmentEntries(course.assessments);
	if (entries.filter((e) => !isTombstone(e)).length >= 100) return { ok: false, status: 409, error: "This class already has 100 assessments" };
	const item: Assessment = {
		id: `as_${randomUUID().replace(/-/g, "").slice(0, 10)}`,
		kind: v.kind!,
		title: v.title!,
		...(v.date ? { date: v.date } : {}),
		topics: v.topics ?? "",
		skillIds: v.skillIds ?? [],
		source,
		updatedAt: stampAfter(),
		...(cite ? { cite: cleanLine(cite, CITE_MAX) } : {}),
	};
	writeAssessments(courseId, [...entries, item]);
	return { ok: true, value: { action: "added", before: null, after: item, id: item.id, stamp: item.updatedAt } };
}

/** Change an assessment (only the fields given). The old exam date (LEGACY_EXAM_ID) becomes a real assessment carrying
 *  the edit, and `examDate` is cleared. An edit by the learner makes it theirs: a later syllabus pass keeps it. */
export function updateAssessment(courseId: string, id: string, input: AssessmentInput, source: Exclude<AssessmentSource, "syllabus"> | "syllabus" = "manual"): Result<AssessmentChange> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	const checked = checkInput(input, course, true);
	if (!checked.ok) return checked;
	const v = checked.value;
	const entries = readAssessmentEntries(course.assessments);
	const before = courseAssessments(course).find((a) => a.id === id);
	if (!before) return { ok: false, status: 404, error: "Unknown assessment" };
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
	delete merged.legacy;
	if (before.legacy) {
		const after: Assessment = { ...merged, id: `as_${randomUUID().replace(/-/g, "").slice(0, 10)}` };
		writeAssessments(courseId, [...entries, after], { examDate: undefined });
		return { ok: true, value: { action: "updated", before, after, id: after.id, stamp: after.updatedAt } };
	}
	writeAssessments(courseId, upsertEntry<AssessmentEntry>(entries, merged));
	return { ok: true, value: { action: "updated", before, after: merged, id: merged.id, stamp: merged.updatedAt } };
}

/** Delete an assessment: a tombstone, so the deletion survives a sync. The old exam date: `examDate` is cleared. */
export function deleteAssessment(courseId: string, id: string): Result<AssessmentChange> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	const before = courseAssessments(course).find((a) => a.id === id);
	if (!before) return { ok: false, status: 404, error: "Unknown assessment" };
	if (before.legacy) {
		const updated = stores.courseStore.updateCourse(courseId, { examDate: undefined })!;
		return { ok: true, value: { action: "removed", before, after: null, id: LEGACY_EXAM_ID, stamp: updated.updatedAt } };
	}
	const tomb: Tombstone = { id, deleted: true, updatedAt: stampAfter(before.updatedAt) };
	writeAssessments(courseId, upsertEntry<AssessmentEntry>(readAssessmentEntries(course.assessments), tomb));
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

/** Every course's live self-reports, for the mastery fold (core/mastery.ts applySelfReports). */
export function allSelfReports(courses: readonly CourseRecord[]): SelfReport[] {
	return courses.flatMap((c) => liveSelfReports(c.selfReports).filter((r) => r.skillIds.some((id) => c.skills.includes(id))));
}

// ─── the chat's change cards and Undo ────────────────────────────────────────

/** One tool result's change, read from the chat record (never from the client). */
function changeIn(chatId: string, toolCallId: string): { courseId: string; change: ClassChange } | null {
	const chat = stores.chatStore.getChat(chatId);
	const courseId = chat?.course?.mode === "ask" ? chat.course.courseId : null;
	if (!chat || !courseId) return null;
	const result = chat.messages.find((m) => (m as { role?: string }).role === "toolResult" && (m as ToolResultMessage).toolCallId === toolCallId) as ToolResultMessage | undefined;
	if (!result || result.isError || !CLASS_CHANGE_TOOLS.includes(result.toolName)) return null;
	const change = (result.details as { change?: ClassChange } | undefined)?.change;
	return change && typeof change === "object" ? { courseId, change } : null;
}

/** applied: the change is still what the list holds (Undo is offered) · changed: it was undone or changed since. */
export type ChangeStatus = "applied" | "changed";

function changeStatus(course: CourseRecord, change: ClassChange): ChangeStatus {
	if (change.kind === "self-report") {
		const held = readSelfReportEntries(course.selfReports).find((e) => e.id === change.report.id);
		return held && !isTombstone(held) && held.updatedAt === change.report.updatedAt ? "applied" : "changed";
	}
	if (change.id === LEGACY_EXAM_ID) return course.examDate === undefined || course.examDate === "" ? "applied" : "changed";
	const held = readAssessmentEntries(course.assessments).find((e) => e.id === change.id);
	return held && held.updatedAt === change.stamp ? "applied" : "changed";
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
		if (!change) continue;
		out[r.toolCallId] = course ? changeStatus(course, change) : "changed";
	}
	return out;
}

/** Undo exactly one change a Short question card shows. Refused (409) when the item changed since: Undo never clobbers a
 *  later edit. */
export function undoClassChange(chatId: string, toolCallId: string): Result<{ status: "undone" }> {
	const found = changeIn(chatId, toolCallId);
	if (!found) return { ok: false, status: 404, error: "No change to undo" };
	const { courseId, change } = found;
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "The class was deleted" };
	if (changeStatus(course, change) !== "applied") return { ok: false, status: 409, error: "This was already undone or changed since" };
	if (change.kind === "self-report") {
		const out = deleteSelfReport(courseId, change.report.id);
		return out.ok ? { ok: true, value: { status: "undone" } } : out;
	}
	const entries = readAssessmentEntries(course.assessments);
	if (change.before?.legacy) {
		// the old exam date comes back; the item that replaced it (an edit) is removed
		const restored = change.after ? upsertEntry<AssessmentEntry>(entries, { id: change.after.id, deleted: true, updatedAt: stampAfter(change.stamp) }) : entries;
		writeAssessments(courseId, restored, { examDate: change.before.date });
		return { ok: true, value: { status: "undone" } };
	}
	const before = change.before ? sanitizeAssessment(change.before) : null;
	if (change.action === "added") {
		writeAssessments(courseId, upsertEntry<AssessmentEntry>(entries, { id: change.id, deleted: true, updatedAt: stampAfter(change.stamp) }));
	} else if (before) {
		writeAssessments(courseId, upsertEntry<AssessmentEntry>(entries, { ...before, id: change.id, updatedAt: stampAfter(change.stamp) }));
	} else return { ok: false, status: 422, error: "This change cannot be undone" };
	return { ok: true, value: { status: "undone" } };
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

async function runFind(courseId: string, controller: AbortController): Promise<void> {
	const settle = (patch: Partial<CourseRecord>) => {
		if (stores.courseStore.getCourse(courseId)) stores.courseStore.updateCourse(courseId, patch);
	};
	try {
		await waitForMaterials(courseId);
		const course = stores.courseStore.getCourse(courseId);
		if (!course || controller.signal.aborted) return;
		const spec = finderOverride ? null : resolveRoleSpec("coursePlanner", stores.settingsStore.readSettings());
		if (!finderOverride && !spec) {
			settle({ assessmentsError: "No model is configured for the course planner (Settings → Agent: the strong slot or a Course planner override)" });
			return;
		}
		const materials = listMaterials(courseId);
		const materialsSection = `<curriculum>\n${materials.map((m) => materialBlock(m, stores.materialStore.filePath(courseId, m))).join("\n\n")}\n</curriculum>`;
		const skills = mergeSkillLines(stores.skillStore.readSkillLines()).filter((s) => course.skills.includes(s.id)).map((s) => ({ id: s.id, name: s.name, statement: s.statement }));
		const run = finderOverride ?? findAssessments;
		const found = await run(
			{ title: course.title, materialsSection, materials: materials.map((m) => ({ id: m.id, name: m.name })), skills, language: languageOf(course) },
			{ engine: spec ? piEngineForSpec(spec) : undefined, signal: controller.signal, tools: materialTools({ chatId: courseId, store: stores.materialStore }), onStep: () => {}, courseId },
		);
		const fresh = stores.courseStore.getCourse(courseId);
		if (!fresh || controller.signal.aborted) return;
		const proposal: AssessmentProposal = { createdAt: new Date().toISOString(), summary: found.summary, items: classifyProposal(found.items, courseAssessments(fresh)) };
		settle({ assessmentProposal: proposal, assessmentsScannedAt: proposal.createdAt, assessmentsError: undefined });
	} catch (err) {
		if (controller.signal.aborted) return;
		settle({ assessmentsError: err instanceof Error ? err.message : String(err), assessmentsScannedAt: new Date().toISOString() });
	}
}

/** The proposal's actions: approve (all pending items, or the listed keys; `edits` changes an item before it is written),
 *  drop one item, or discard the whole proposal. Only new and update items are written; a kept one (the learner's own)
 *  and a same one are left alone. Approving clears the proposal. */
export function actOnProposal(
	courseId: string,
	action: { action: "approve"; keys?: string[]; edits?: Record<string, AssessmentInput> } | { action: "drop"; key: string } | { action: "discard" },
): Result<CourseRecord> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	const proposal = course.assessmentProposal;
	if (!proposal || !Array.isArray(proposal.items)) return { ok: false, status: 409, error: "There is no proposal" };
	if (action.action === "discard") return { ok: true, value: stores.courseStore.updateCourse(courseId, { assessmentProposal: undefined })! };
	if (action.action === "drop") {
		if (!proposal.items.some((i) => i.key === action.key)) return { ok: false, status: 404, error: "Unknown proposal item" };
		const items = proposal.items.filter((i) => i.key !== action.key);
		return { ok: true, value: stores.courseStore.updateCourse(courseId, { assessmentProposal: items.some((i) => i.status === "new" || i.status === "update") ? { ...proposal, items } : undefined })! };
	}
	const chosen = proposal.items.filter((i) => (i.status === "new" || i.status === "update") && (!action.keys || action.keys.includes(i.key)));
	// check every item first: nothing is written when one is refused
	const own = new Set(course.skills);
	for (const item of chosen) {
		const edit = action.edits?.[item.key];
		const input: AssessmentInput = { kind: item.kind, title: item.title, date: item.date ?? null, topics: item.topics, skillIds: item.skillIds.filter((s) => own.has(s)), ...(edit ?? {}) };
		const checked = checkInput(input, course, false);
		if (!checked.ok) return { ok: false, status: checked.status, error: `${item.title}: ${checked.error}` };
	}
	// the list as it is NOW decides again: an item the learner made or edited meanwhile still wins
	for (const item of chosen) {
		const edit = action.edits?.[item.key];
		const input: AssessmentInput = { kind: item.kind, title: item.title, date: item.date ?? null, topics: item.topics, skillIds: item.skillIds.filter((s) => own.has(s)), ...(edit ?? {}) };
		const fresh = stores.courseStore.getCourse(courseId)!;
		const [now] = classifyProposal([{ ...item, ...(typeof input.title === "string" ? { title: input.title } : {}) }], courseAssessments(fresh));
		const source: AssessmentSource = edit ? "manual" : "syllabus";
		if (now?.status === "new") {
			const made = createAssessment(courseId, input, source, item.cite);
			if (!made.ok) return made;
		} else if (now?.status === "update" && now.match) {
			const made = updateAssessment(courseId, now.match, input, source);
			if (!made.ok) return made;
		}
	}
	const after = stores.courseStore.getCourse(courseId)!;
	const rest = (after.assessmentProposal?.items ?? []).filter((i) => !chosen.some((c) => c.key === i.key) && (i.status === "new" || i.status === "update"));
	return { ok: true, value: stores.courseStore.updateCourse(courseId, { assessmentProposal: rest.length > 0 ? { ...proposal, items: rest } : undefined })! };
}

// ─── the page's view ─────────────────────────────────────────────────────────

const SYLLABUS_RE = /syllab|course outline|course plan|schedule|semesterplan|emneplan|timeplan|undervisningsplan|exam dates|eksamensdato/i;

/** The Upcoming list's view (CourseView.upcoming). */
export function upcomingView(course: CourseRecord, now = Date.now()): UpcomingView {
	const items = courseAssessments(course);
	const next = nextAssessment(items, now);
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

/** The port the Ask agent's class tools use, bound to one Ask conversation. Null when the chat is not an Ask chat of a
 *  class that still exists. */
export function classFactsPort(chatId: string): ClassFactsPort | null {
	const chat = stores.chatStore.getChat(chatId);
	if (chat?.course?.mode !== "ask") return null;
	const courseId = chat.course.courseId;
	const course = () => stores.courseStore.getCourse(courseId);
	if (!course()) return null;
	const names = (c: CourseRecord) => new Map(courseSkills(c).map((s) => [s.id, s.name]));
	const withNames = (c: CourseRecord, a: Assessment | null) => (a ? a.skillIds.map((id) => names(c).get(id) ?? id) : []);
	return {
		now: () => Date.now(),
		hasSkills: () => (course()?.skills.length ?? 0) > 0,
		list: () => {
			const c = course();
			return c ? { assessments: sortAssessments(courseAssessments(c)), skills: courseSkills(c) } : { assessments: [], skills: [] };
		},
		save: (id, input) => {
			const out = id ? updateAssessment(courseId, id, input, "chat") : createAssessment(courseId, input, "chat");
			if (!out.ok) return { ok: false, error: out.error };
			const c = course()!;
			return { ok: true, change: { kind: "assessment", courseId, ...out.value, skillNames: withNames(c, out.value.after ?? out.value.before) } };
		},
		remove: (id) => {
			const out = deleteAssessment(courseId, id);
			if (!out.ok) return { ok: false, error: out.error };
			const c = course()!;
			return { ok: true, change: { kind: "assessment", courseId, ...out.value, skillNames: withNames(c, out.value.before) } };
		},
		selfReport: (input) => {
			const out = recordSelfReport(courseId, { ...input, chatId });
			if (!out.ok) return { ok: false, error: out.error };
			const n = names(course()!);
			return { ok: true, change: { kind: "self-report", courseId, report: out.value, skillNames: out.value.skillIds.map((id) => n.get(id) ?? id) } };
		},
		findInSyllabus: () => {
			const out = startAssessmentFind(courseId);
			return out.ok ? { ok: true } : { ok: false, error: out.error };
		},
	};
}
