import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { PATHS } from "../../config.ts";
import type {
	ChatCourseLink,
	ChatRecord,
	CourseDeletionImpact,
	LessonResult,
	RatingChange,
	CourseDraft,
	CourseMode,
	CourseRecord,
	CourseSkillView,
	CourseStandingView,
	CourseSummary,
	CourseView,
	GraphEdge,
	GraphSkillLayer,
	GraphSkillNode,
	MissedProblemView,
	Skill,
	TodayCourse,
} from "../core/contracts.ts";
import { FOLDER_NAME_MAX, canonicalFolderName, normalizeFolderName, removeFolderChanges, renameFolderChanges } from "../core/course-folders.ts";
import {
	daysUntil,
	examInstant,
	examReviewScore,
	forecast,
	lessonsPerDay,
	lessonsToday,
	mergeModelWeights,
	orderNextUp,
	parseExamDate,
	parseWeightValue,
	priorities,
	sanitizeWeights,
	weightOf,
	type CoursePlan,
	type SkillWeights,
} from "../core/exam-plan.ts";
import { approveDraft, draftProblems, type DraftCheckContext } from "../core/course-draft.ts";
import {
	finishSummaryOf,
	courseFirstMessage,
	coursePromptSection,
	courseSessionTitle,
	newCourseContextMessage,
	type SessionSkill,
} from "../core/course-session.ts";
import { chainsForSelection, formatChainLine } from "../core/chains.ts";
import { getGraph } from "../core/graph.ts";
import {
	applySelfReports,
	courseProgressPercent,
	foldSkills,
	inCourseEvidence,
	isKnown,
	needsReview,
	retrievability,
	partitionSkills,
	pickReviewSkills,
	retestSkills,
	REVIEW_SESSION_SIZE,
	reviewAt,
	skillEventsOf,
	understandingOf,
	type ActiveSelfReport,
	type SkillState,
	type SkillEvent,
	type SkillPartition,
} from "../core/mastery.ts";
import { DEFAULT_LESSON_LANGUAGE, type LessonLanguage } from "../core/language.ts";
import { materialBlock } from "../core/materials.ts";
import { concludedProblemsOf, missesForSession, openMisses, recentSolvedForSession, type ConcludedProblem, type MissedProblem } from "../core/missed-problems.ts";
import type { PlacementSkillInfo } from "../core/placement-frontier.ts";
import { normalizePaceNote, type Pace } from "../core/pace.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { mergeSkillLines } from "../core/skills.ts";
import { piEngineForSpec } from "../agent/models.ts";
import { draftCourse } from "../agent/subagents/course-planner.ts";
import { weighCourse } from "../agent/subagents/exam-weigher.ts";
import { callUsage } from "../agent/subagents/extraction.ts";
import { materialTools } from "../agent/tools/materials.ts";
import { plannerGraphTools } from "../agent/tools/planner-graph.ts";
import { approveCoverage, carryForward, hasCoreEntries, pruneStaleSkills, readCourseCoverage } from "../core/coverage-items.ts";
import type { LessonVocabulary } from "../core/coverage-ledger.ts";
import {
	abortCourseTermMapping,
	approvalProposal,
	carriedStamp,
	courseTermMapping,
	coverageGlossary,
	coverageView,
	draftUnassigned,
	leftAtApprovalReason,
	lessonCoverage,
	listedVocabularyFor,
	sessionVocabulary,
	startCourseTermMapping,
	type ConceptIdReader,
} from "./course-coverage.ts";
import { stampNewSession, titleFromPrompt } from "./chats.ts";
import { abortAssessmentFind, allSelfReports, upcomingView } from "./assessments.ts";
import { assessmentWhen, boundAssessments, countdownAssessment, courseAssessments, focusSkills, isTombstone, LEGACY_ITEM_ID, liveSelfReports, nextAssessment, readAssessmentEntries, targetDateFor, upsertEntry, type AssessmentEntry } from "../core/assessments.ts";
import { removeCourseLectureNotes } from "./lecture-notes.ts";
import { lectureToday, sanitizeClassPosition, standingGaps, whereYouStand } from "../core/lectures.ts";
import { abortLectureLinking, classLectures, lectureLinking, maybeLinkLectures } from "./lectures.ts";
import { listMaterials, removeMaterial, waitForMaterials } from "./materials.ts";
import { effectiveSettings, stores } from "./stores.ts";

/**
 * Courses — the service seam (fork addition, 2026-10-24; spec:
 * docs/courses.md). Routes (app/api/courses/*) delegate here.
 *
 *   - READS derive everything: skills merge from the ledger, boxes fold
 *     from every course practice session's concluded problems (a skill's
 *     box is global — practice in one course counts in every course that
 *     shares the skill), the route partitions from boxes + requires.
 *   - DRAFTING runs the course planner in the background (one run per
 *     course, through the shared background-LLM permits) and parks its
 *     output on the record for the owner to review.
 *   - APPROVAL is the skills ledger's ONLY writer.
 *   - SESSIONS start from a course with the course link stamped at birth
 *     and a context marker as message[0].
 */

type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

// ─── derived reads ───────────────────────────────────────────────────────────

/** Every skill in the graph (merged; dead proposition links dropped). */
function allSkills(nodeIds: ReadonlySet<string>): Map<string, Skill> {
	return new Map(mergeSkillLines(stores.skillStore.readSkillLines(), nodeIds).map((s) => [s.id, s]));
}

/** A skill's lesson note: the summary its newest finished lesson gave (core/course-session.ts finishSummaryOf). */
interface LessonNote {
	summary: string;
	at: number;
	chatId: string;
}

/** Derived course evidence for one chat file (never holds ChatRecord or messages). */
interface ChatCourseEvidence {
	readonly link: ChatCourseLink;
	readonly events: readonly SkillEvent[];
	readonly note: LessonNote | null;
	readonly problems: readonly ConcludedProblem[];
	readonly concludeCalls: ReadonlyArray<{ readonly callId: string; readonly at: number }>;
}

interface EvidenceCacheEntry {
	readonly mtimeMs: number;
	readonly size: number;
	readonly ino: number;
	readonly evidence: ChatCourseEvidence | null;
}

interface EvidenceCacheState {
	entries: Map<string, EvidenceCacheEntry>;
	floor: number;
	ceiling: number;
	maxEntries: number;
}

/** Bump whenever `extractChatCourseEvidence` or `ChatCourseEvidence` changes so dev hot reloads never serve stale cached extractions. */
export const COURSE_EVIDENCE_CACHE_VERSION = 1;
export const COURSE_EVIDENCE_CACHE_KEY = Symbol.for(`lh.courseEvidenceCache.v${COURSE_EVIDENCE_CACHE_VERSION}`);
/** Minimum LRU capacity even for small data directories. */
export const COURSE_EVIDENCE_CACHE_FLOOR = 1_000;
/** Hard memory-minded ceiling (~2–5 KB/entry -> ~40–100 MB worst-case). */
export const COURSE_EVIDENCE_CACHE_CEILING = 20_000;
const EVIDENCE_CACHE_HEADROOM = 1.25;

function computeEvidenceCacheLimit(scannedCourseChats: number, floor: number, ceiling: number): number {
	const target = Math.max(floor, Math.ceil(scannedCourseChats * EVIDENCE_CACHE_HEADROOM));
	return Math.min(ceiling, Math.max(1, target));
}

function evictOverflow(state: EvidenceCacheState): void {
	while (state.entries.size > state.maxEntries) {
		const oldest = state.entries.keys().next().value;
		if (oldest === undefined) break;
		state.entries.delete(oldest);
	}
}

/** Process-shared bounded LRU cache across Next.js route bundles (same pattern as draftRuns/weighRuns). */
function evidenceCacheState(): EvidenceCacheState {
	const g = globalThis as Record<symbol, EvidenceCacheState | undefined>;
	g[COURSE_EVIDENCE_CACHE_KEY] ??= {
		entries: new Map(),
		floor: COURSE_EVIDENCE_CACHE_FLOOR,
		ceiling: COURSE_EVIDENCE_CACHE_CEILING,
		maxEntries: COURSE_EVIDENCE_CACHE_FLOOR,
	};
	return g[COURSE_EVIDENCE_CACHE_KEY];
}

/** Test/diagnostic seam: clear the per-chat course evidence cache. */
export function clearCourseEvidenceCache(): void {
	evidenceCacheState().entries.clear();
}

/** Test/diagnostic seam: current number of cached chat evidence entries. */
export function courseEvidenceCacheSize(): number {
	return evidenceCacheState().entries.size;
}

/** Test/diagnostic seam: active effective cache entry limit. */
export function courseEvidenceCacheLimit(): number {
	return evidenceCacheState().maxEntries;
}

/** Test/diagnostic seam: configure floor and ceiling bounds (restoring defaults when omitted). */
export function setCourseEvidenceCacheBounds(bounds?: { floor?: number; ceiling?: number }): void {
	const state = evidenceCacheState();
	const ceiling = Math.max(1, Math.floor(bounds?.ceiling ?? COURSE_EVIDENCE_CACHE_CEILING));
	const floor = Math.min(ceiling, Math.max(1, Math.floor(bounds?.floor ?? COURSE_EVIDENCE_CACHE_FLOOR)));
	state.ceiling = ceiling;
	state.floor = floor;
	state.maxEntries = Math.min(ceiling, Math.max(floor, state.maxEntries));
	evictOverflow(state);
}

/** Test/diagnostic seam: pin the hard ceiling (or restore default floor/ceiling when omitted). */
export function setCourseEvidenceCacheLimit(maxEntries?: number): void {
	const state = evidenceCacheState();
	if (maxEntries === undefined) {
		state.floor = COURSE_EVIDENCE_CACHE_FLOOR;
		state.ceiling = COURSE_EVIDENCE_CACHE_CEILING;
		state.maxEntries = COURSE_EVIDENCE_CACHE_FLOOR;
		evictOverflow(state);
		return;
	}
	const cap = Math.max(1, Math.floor(maxEntries));
	state.ceiling = cap;
	state.floor = Math.min(state.floor, cap);
	state.maxEntries = Math.min(state.maxEntries, cap);
	evictOverflow(state);
}

function chatEvidenceFile(id: string): string | null {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
	return path.join(/* turbopackIgnore: true */ PATHS.chats, `${id}.json`);
}

function extractChatCourseEvidence(chat: ChatRecord | null): ChatCourseEvidence | null {
	const link = chat?.course;
	if (!chat || !link) return null;
	const events = skillEventsOf(chat.messages, link);
	const problems = link.mode === "practice" || link.mode === "review" || link.mode === "check" ? concludedProblemsOf(chat.messages, chat.id) : [];
	const rawNote = link.mode === "learn" ? finishSummaryOf(chat.messages) : null;
	const note = rawNote ? { summary: rawNote.summary, at: rawNote.at, chatId: chat.id } : null;
	const concludeCalls: Array<{ callId: string; at: number }> = [];
	// an Ask conversation (2026-11-25) concludes nothing, whatever its transcript holds
	if (link.mode !== "learn" && link.mode !== "placement" && link.mode !== "ask") {
		const clean = new Set<string>();
		for (const m of chat.messages) {
			const r = m as { role?: string; toolCallId?: string; isError?: boolean };
			if (r.role === "toolResult" && !r.isError && r.toolCallId) clean.add(r.toolCallId);
		}
		for (const m of chat.messages) {
			if ((m as { role?: string }).role !== "assistant") continue;
			const at = (m as { timestamp: number }).timestamp;
			for (const block of (m as unknown as { content: Array<{ type: string; id?: string; name?: string }> }).content) {
				if (block.type !== "toolCall" || block.name !== "conclude" || !block.id || !clean.has(block.id)) continue;
				concludeCalls.push({ callId: block.id, at });
			}
		}
	}
	return { link, events, note, problems, concludeCalls };
}

/** Read one chat's derived course evidence, reusing the cached extraction while the file's mtime, size, and inode match. */
function chatCourseEvidence(id: string): ChatCourseEvidence | null {
	const file = chatEvidenceFile(id);
	if (!file) return null;
	const state = evidenceCacheState();
	let st: fs.Stats;
	try {
		st = fs.statSync(/* turbopackIgnore: true */ file);
	} catch {
		state.entries.delete(file);
		// Fallback for non-filesystem chat stores in tests without caching.
		return extractChatCourseEvidence(stores.chatStore.getChat(id));
	}
	const hit = state.entries.get(file);
	if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && hit.ino === st.ino) {
		state.entries.delete(file);
		state.entries.set(file, hit);
		return hit.evidence;
	}
	const evidence = extractChatCourseEvidence(stores.chatStore.getChat(id));
	state.entries.delete(file);
	state.entries.set(file, { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, evidence });
	evictOverflow(state);
	return evidence;
}

/** The course page's list of open misses: newest first, the skills that still exist in the course map, at most 20. */
function missedViews(open: readonly MissedProblem[], ctx: ReadContext): MissedProblemView[] {
	const out: MissedProblemView[] = [];
	for (const m of open) {
		const skills = m.skills.filter((id) => ctx.skills.has(id)).map((id) => ({ id, name: ctx.skills.get(id)!.name }));
		if (skills.length === 0) continue;
		out.push({ id: m.id, at: new Date(m.at).toISOString(), statement: m.statement, how: MISS_HOW[m.outcome] ?? "missed it", skills });
		if (out.length >= 20) break;
	}
	return out;
}

/** How a miss is put to the tutor. */
const MISS_HOW: Partial<Record<string, string>> = { surrendered: "gave up", movedOn: "moved on", taught: "was taught the answer", solvedWithHints: "needed hints" };

/** Every course session's skill evidence, by course, and each skill's lesson note, in one pass over the chats. */
function courseEvidence(): { byCourse: Map<string, SkillEvent[]>; notes: Map<string, LessonNote>; problems: Map<string, ConcludedProblem[]> } {
	const byCourse = new Map<string, SkillEvent[]>();
	const problems = new Map<string, ConcludedProblem[]>();
	const notes = new Map<string, LessonNote>();
	const presentFiles = new Set<string>();
	// an Ask conversation is never evidence: it is not opened, cached or counted
	const courseChats = stores.chatStore.listChats().filter((summary) => Boolean(summary.course) && summary.course?.mode !== "ask");
	const state = evidenceCacheState();
	// Size the LRU cap from the number of course chats in this scan (bounded by [floor, ceiling])
	// so scanning more chats than the floor never thrashes the cache.
	state.maxEntries = computeEvidenceCacheLimit(courseChats.length, state.floor, state.ceiling);
	for (const summary of courseChats) {
		const file = chatEvidenceFile(summary.id);
		if (file) presentFiles.add(file);
		const ev = chatCourseEvidence(summary.id);
		// an Ask conversation is never evidence: it does not even open an (empty) entry for its course
		if (!ev || ev.link.mode === "ask") continue;
		const { link, events, note, problems: chatProblems } = ev;
		byCourse.set(link.courseId, [...(byCourse.get(link.courseId) ?? []), ...events]);
		if (link.mode === "practice" || link.mode === "review" || link.mode === "check") {
			problems.set(link.courseId, [...(problems.get(link.courseId) ?? []), ...chatProblems]);
		}
		if (link.mode !== "learn" || !note) continue;
		for (const skillId of link.skillIds) {
			const held = notes.get(skillId);
			if (!held || held.at < note.at) notes.set(skillId, { ...note });
		}
	}
	const chatsPrefix = PATHS.chats.endsWith(path.sep) ? PATHS.chats : `${PATHS.chats}${path.sep}`;
	for (const key of [...state.entries.keys()]) {
		if (key.startsWith(chatsPrefix) && !presentFiles.has(key)) {
			// Pruning deleted/non-course files keeps memory tight.
			state.entries.delete(key);
		}
	}
	evictOverflow(state);
	return { byCourse, notes, problems };
}

interface ReadContext {
	graph: ReturnType<typeof getGraph>;
	nodeIds: Set<string>;
	skills: Map<string, Skill>;
	/** A skill's memory state is global: evidence from every course counts. */
	skillStates: Map<string, SkillState>;
	byCourse: Map<string, SkillEvent[]>;
	/** Each skill's newest lesson note. */
	notes: Map<string, LessonNote>;
	/** Per course: its concluded practice, review and check problems (core/missed-problems.ts). */
	problems: Map<string, ConcludedProblem[]>;
	/** WP8: skills the learner said they do not get, not learned yet: first among their peers in Next up. */
	needsWork: Set<string>;
	/** WP8: each skill's self-report in force (core/mastery.ts applySelfReports). */
	selfReports: Map<string, ActiveSelfReport & { chatId?: string; courseId?: string }>;
	now: number;
}

function readContext(): ReadContext {
	const graph = getGraph(stores.graphStore);
	const nodeIds = new Set(graph.nodes.map((n) => n.id));
	const skills = allSkills(nodeIds);
	const { byCourse, notes, problems } = courseEvidence();
	const events = [...byCourse.values()].flat();
	const folded = foldSkills(events, (id) => skills.get(id)?.requires ?? []);
	// WP8: what the learner said in a Short question conversation moves a skill a little; real evidence always wins
	const reports = allSelfReports(stores.courseStore.listCourses());
	const applied = applySelfReports(folded, reports.map((r) => ({ id: r.id, at: Date.parse(r.at), skillIds: r.skillIds, stance: r.stance })), events);
	const byReport = new Map(reports.map((r) => [r.id, r]));
	// review 1, finding 9: each report carries the class that holds it (a shared skill shows it in every class, and only
	// that class can remove it), and its chat only while that chat still exists (no dead "where" link)
	const liveChats = new Set(stores.chatStore.listChats().map((c) => c.id));
	const selfReports = new Map(
		[...applied.active].map(([id, a]) => {
			const r = byReport.get(a.id);
			return [id, { ...a, ...(r ? { courseId: r.courseId } : {}), ...(r?.chatId && liveChats.has(r.chatId) ? { chatId: r.chatId } : {}) }];
		}),
	);
	return { graph, nodeIds, skills, skillStates: applied.states, byCourse, notes, problems, needsWork: applied.needsWork, selfReports, now: Date.now() };
}

function checkContext(ctx = readContext()): DraftCheckContext {
	return { skills: ctx.skills, nodeIds: ctx.nodeIds };
}

/** A skill's propositions: the planner's stored links ∪ every proposition
 *  extracted from a Learn session on the skill (derived, not stored). */
function skillPropositionIds(skill: Skill, ctx: ReadContext, learnChats: ReadonlyMap<string, Set<string>>): string[] {
	const ids = new Set(skill.restsOn);
	const chats = learnChats.get(skill.id);
	if (chats && chats.size > 0) {
		for (const node of ctx.graph.nodes) {
			if (node.provenance.some((pt) => chats.has(pt.chatId))) ids.add(node.id);
		}
	}
	return [...ids].filter((id) => ctx.nodeIds.has(id));
}

/** skill id → the Learn sessions started on it. */
function learnChatsBySkill(): Map<string, Set<string>> {
	const out = new Map<string, Set<string>>();
	for (const chat of stores.chatStore.listChats()) {
		if (chat.course?.mode !== "learn") continue;
		for (const id of chat.course.skillIds) {
			if (!out.has(id)) out.set(id, new Set());
			out.get(id)!.add(chat.id);
		}
	}
	return out;
}

function partitionOf(course: CourseRecord, ctx: ReadContext): SkillPartition {
	const inCourse = inCourseEvidence(ctx.byCourse.get(course.id) ?? [], (id) => ctx.skills.get(id)?.requires ?? []);
	// WP8: a skill the learner reported on in THIS class is this class's (never "from another course")
	for (const r of liveSelfReports(course.selfReports)) for (const id of r.skillIds) if (ctx.selfReports.get(id)?.id === r.id) inCourse.add(id);
	return partitionSkills(course.skills, ctx.skills, ctx.skillStates, ctx.now, inCourse, examTargetOf(course, ctx));
}

/** WP8: each skill's review is timed for the nearest upcoming assessment that covers it (core/assessments.ts targetDateFor;
 *  the old exam date covers every skill, as before). */
function examTargetOf(course: CourseRecord, ctx: ReadContext): (skillId: string) => number | undefined {
	const list = courseAssessments(course);
	return (id) => examInstant(targetDateFor(id, list, ctx.now), ctx.now);
}

export function listCourseSummaries(): CourseSummary[] {
	const courses = stores.courseStore.listCourses().map(healOrphanDraft);
	if (courses.length === 0) return [];
	const ctx = readContext();
	return courses.map((course) => {
		const p = partitionOf(course, ctx);
		return {
			id: course.id,
			title: course.title,
			status: course.status,
			updatedAt: course.updatedAt,
			total: p.order.length,
			known: p.known.length,
			progress: courseProgressPercent(p.order.map((id) => {
				const state = p.states.get(id)?.state;
				return state ? understandingOf(state) : 0;
			})),
			needsReview: p.review.length,
			// WP8: the sidebar's days column counts down to the next assessment
			...((next) => (next ? { examDate: next.date } : {}))(countdownAssessment(courseAssessments(course), ctx.now)),
			...(course.folder ? { folder: course.folder } : {}),
		};
	});
}

/** The knowledge graph's skills layer (owner, 2026-10-25): every skill the
 *  learner holds (learned or known), its prerequisite arrows among the
 *  held skills, an arrow from each proposition it rests on (the course
 *  page's derivation), and one region per course. Undefined when nothing
 *  is held. */
export function graphSkillLayer(): GraphSkillLayer | undefined {
	const ctx = readContext();
	const courses = stores.courseStore.listCourses();
	const coursesOf = new Map<string, Array<{ id: string; title: string }>>();
	for (const course of courses) {
		for (const id of course.skills) coursesOf.set(id, [...(coursesOf.get(id) ?? []), { id: course.id, title: course.title }]);
	}
	const learnChats = learnChatsBySkill();
	const nodes: GraphSkillNode[] = [];
	for (const [id, state] of ctx.skillStates) {
		const skill = ctx.skills.get(id);
		if (!skill) continue;
		nodes.push({
			id,
			name: skill.name,
			statement: skill.statement,
			understanding: understandingOf(state),
			known: isKnown(state),
			needsReview: needsReview(state, ctx.now),
			courses: coursesOf.get(id) ?? [],
			propositions: skillPropositionIds(skill, ctx, learnChats),
		});
	}
	if (nodes.length === 0) return undefined;
	nodes.sort((a, b) => b.understanding - a.understanding || a.name.localeCompare(b.name));
	const held = new Set(nodes.map((n) => n.id));
	const edges: GraphEdge[] = [];
	for (const n of nodes) {
		for (const req of ctx.skills.get(n.id)!.requires) if (held.has(req)) edges.push({ from: req, to: n.id });
		for (const p of n.propositions) edges.push({ from: p, to: n.id });
	}
	const regions = courses
		.map((course) => ({ id: course.id, label: course.title, members: nodes.filter((n) => n.courses[0]?.id === course.id).map((n) => n.id) }))
		.filter((r) => r.members.length > 0);
	return { nodes, edges, regions };
}

/** The exam plan of a course (core/exam-plan.ts): priorities, the ordered Next up, the countdown, the forecast and today's
 *  lessons. `ids` are the course's skills in topological order. */
/** WP9: "Where you stand" (core/lectures.ts whereYouStand): the lecture timeline (stored, plus what the files name), the
 *  class's position, what the learner has learned of it, and the next assessment's readiness. Null before a skill map. */
function standingOf(course: CourseRecord, p: SkillPartition, ctx: ReadContext): CourseStandingView | null {
	if (course.skills.length === 0) return null;
	const lectures = classLectures(course);
	const standing = whereYouStand({
		lectures,
		explicit: sanitizeClassPosition(course.classPosition),
		today: lectureToday(ctx.now),
		skills: p.order.map((id) => ({ id, learned: p.states.get(id)?.learned ?? false, requires: ctx.skills.get(id)?.requires ?? [] })),
		startable: new Set(p.nextUp),
		next: nextAssessment(courseAssessments(course), ctx.now),
	});
	const files: Record<string, string> = {};
	for (const m of stores.materialStore.list(course.id)) files[m.id] = m.name;
	return { ...standing, linking: lectureLinking(course.id), ...(course.lecturesLinkError ? { linkError: course.lecturesLinkError } : {}), files };
}

function examPlanOf(course: CourseRecord, p: SkillPartition, ctx: ReadContext): { plan: CoursePlan; nextUp: string[]; notExamined: string[]; priority: Map<string, number>; standing: CourseStandingView | null } {
	const weights = sanitizeWeights(course.skillWeights);
	const priority = priorities(p.order, (id) => ctx.skills.get(id)?.requires ?? [], weights);
	// WP8: the next dated assessment's skills come first; a skill the learner said they do not get leads its peers
	const assessments = courseAssessments(course);
	// the countdown's assessment: the next one, or the latest passed one when nothing dated is coming ("passed")
	const next = countdownAssessment(assessments, ctx.now);
	// WP9: the gaps lead: (1) what the next assessment needs (its skills, else its lectures' skills), (2) what the class
	// has covered; then the old order. With no lectures this is exactly WP8's focus and nothing covered.
	const standing = standingOf(course, p, ctx);
	const gaps = standingGaps(standing);
	const focus = standing?.next?.needs ? gaps.needs : focusSkills(assessments, ctx.now);
	const { nextUp, notExamined } = orderNextUp(p.nextUp, priority, { focus, needsWork: ctx.needsWork, covered: gaps.covered });
	// the skills left: the next assessment's own when it maps some, else every examined one
	const skillsLeft = focus.size > 0
		? p.order.filter((id) => focus.has(id) && !(p.states.get(id)?.learned ?? false)).length
		: nextUp.length + p.locked.filter((id) => (priority.get(id) ?? 1) > 0).length;
	const events = ctx.byCourse.get(course.id) ?? [];
	const finishes = events.filter((e) => e.outcome === "finished").map((e) => e.at);
	const firstActivity = events.length > 0 ? Math.min(...events.map((e) => e.at)) : undefined;
	const daysLeft = next ? daysUntil(next.date, ctx.now) : undefined;
	const f = daysLeft === undefined ? undefined : forecast({ skillsLeft, daysLeft, pacePerDay: lessonsPerDay(finishes, ctx.now, firstActivity) });
	const lessons = nextUp.slice(0, lessonsToday(f ? f.neededPerDay : null, nextUp.length));
	// review 1, finding 12: what the fading skills fade before. Each is timed for its own nearest assessment; only when
	// every one of them is timed for the next one does the page name it
	const target = examTargetOf(course, ctx);
	const upcomingNext = next && daysUntil(next.date, ctx.now) >= 0 ? next : undefined;
	const allForNext = upcomingNext !== undefined && p.fading.length > 0 && p.fading.every((id) => target(id) === examInstant(upcomingNext.date, ctx.now));
	const reviewFadingBefore = p.fading.length === 0 ? undefined : allForNext ? (upcomingNext.legacy ? "the exam" : upcomingNext.title) : "upcoming tests";
	const plan: CoursePlan = {
		...(next ? { examDate: next.date, next: { id: next.id, kind: next.kind, title: next.title, date: next.date, topics: next.topics, skillIds: next.skillIds, ...(next.legacy ? { legacy: true as const } : {}) } } : {}),
		...(daysLeft !== undefined ? { daysLeft } : {}),
		skillsLeft,
		...(f ? { forecast: f } : {}),
		reviewDue: p.review.length,
		reviewFading: p.fading.length,
		...(reviewFadingBefore ? { reviewFadingBefore } : {}),
		retestCount: p.order.some((id) => p.states.get(id)?.learned) ? retestSkills(p).length : 0,
		reviewBatch: Math.min(p.review.length, REVIEW_SESSION_SIZE),
		lessons,
	};
	return { plan, nextUp, notExamined, priority, standing };
}

/** The review pick's ranking for a course with an upcoming exam (core/exam-plan.ts examReviewScore); undefined without one,
 *  which leaves the pick exactly as it was (the lowest understanding first). */
function examReviewScoreOf(course: CourseRecord, p: SkillPartition, ctx: ReadContext): ((id: string) => number) | undefined {
	const target = examTargetOf(course, ctx);
	if (!p.order.some((id) => target(id) !== undefined)) return undefined;
	const priority = priorities(p.order, (id) => ctx.skills.get(id)?.requires ?? [], sanitizeWeights(course.skillWeights));
	return (id) => {
		const state = p.states.get(id)?.state;
		const examAt = target(id);
		return state && examAt !== undefined ? examReviewScore(priority.get(id) ?? 1, course.pastExams, retrievability(state, examAt)) : 0;
	};
}

/** The sidebar's Today list (GET /api/today, owner 2026-11-13): per active course with something to do, the reviews
 *  that are due and the lessons to take today. Courses with the soonest exam first, then the rest by recent use. */
export function todayCourses(): TodayCourse[] {
	const courses = stores.courseStore.listCourses().filter((c) => c.status === "active" && c.skills.length > 0);
	if (courses.length === 0) return [];
	const ctx = readContext();
	const out: Array<TodayCourse & { updatedAt: string }> = [];
	for (const course of courses) {
		const p = partitionOf(course, ctx);
		const { plan } = examPlanOf(course, p, ctx);
		if (plan.reviewDue === 0 && plan.lessons.length === 0) continue;
		const weights = sanitizeWeights(course.skillWeights);
		out.push({
			courseId: course.id,
			title: course.title,
			...(plan.examDate ? { examDate: plan.examDate } : {}),
			...(plan.daysLeft !== undefined ? { daysLeft: plan.daysLeft } : {}),
			reviewDue: plan.reviewDue,
			reviewBatch: plan.reviewBatch,
			lessons: plan.lessons.map((id) => ({ skillId: id, name: ctx.skills.get(id)?.name ?? id, weight: weightOf(weights, id) })),
			updatedAt: course.updatedAt,
		});
	}
	const upcoming = (c: TodayCourse): boolean => c.daysLeft !== undefined && c.daysLeft >= 0;
	out.sort((a, b) => {
		if (upcoming(a) !== upcoming(b)) return upcoming(a) ? -1 : 1;
		if (upcoming(a) && upcoming(b)) return (a.daysLeft ?? 0) - (b.daysLeft ?? 0);
		return b.updatedAt.localeCompare(a.updatedAt);
	});
	return out.map(({ updatedAt: _updatedAt, ...rest }) => rest);
}

export function courseView(courseId: string): CourseView | null {
	// WP9: a lecture or a file added (here or by sync) places the skills again, in the background (before the read, so a
	// run that settles at once shows)
	maybeLinkLectures(courseId);
	const found = stores.courseStore.getCourse(courseId);
	if (!found) return null;
	const course = healOrphanDraft(found);
	const ctx = readContext();
	const p = partitionOf(course, ctx);
	const learnChats = learnChatsBySkill();
	const titles = new Map(stores.chatStore.listChats().map((c) => [c.id, c.title]));
	const nodes = new Map(ctx.graph.nodes.map((n) => [n.id, n]));
	const exam = examPlanOf(course, p, ctx);
	const weights = sanitizeWeights(course.skillWeights);
	const skills: CourseSkillView[] = p.order.map((id) => {
		const skill = ctx.skills.get(id)!;
		const s = p.states.get(id)!;
		return {
			id,
			name: skill.name,
			statement: skill.statement,
			requires: skill.requires.filter((r) => ctx.skills.has(r)),
			understanding: s.state ? understandingOf(s.state) : 0,
			learned: s.learned,
			known: s.known,
			needsReview: s.needsReview,
			reviewAt: s.state ? new Date(reviewAt(s.state)).toISOString() : null,
			stability: s.state ? s.state.stability : null,
			lastReview: s.state ? new Date(s.state.lastReview).toISOString() : null,
			missing: s.missing,
			...(ctx.notes.get(id) ? { lessonNote: { summary: ctx.notes.get(id)!.summary, at: new Date(ctx.notes.get(id)!.at).toISOString(), chatId: ctx.notes.get(id)!.chatId } } : {}),
			// WP8: what the learner said about it, while no real evidence has overridden it
			...((r) => (r ? { selfReport: { id: r.id, stance: r.stance, at: new Date(r.at).toISOString(), ...(r.chatId ? { chatId: r.chatId } : {}), ...(r.courseId ? { courseId: r.courseId } : {}) } } : {}))(ctx.selfReports.get(id)),
			weight: weightOf(weights, id),
			...(weights?.[id] ? { weightBy: weights[id]!.by } : {}),
			...(weights?.[id]?.reason ? { weightReason: weights[id]!.reason } : {}),
			priority: exam.priority.get(id) ?? weightOf(weights, id),
			propositions: skillPropositionIds(skill, ctx, learnChats).map((nid) => {
				const node = nodes.get(nid)!;
				const sessions = [...new Set(node.provenance.map((pt) => pt.chatId))]
					.filter((cid) => titles.has(cid))
					.map((cid) => ({ id: cid, title: titles.get(cid)! }));
				return { id: nid, name: node.name, statement: node.statement, sessions };
			}),
		};
	});
	const sessions = stores.chatStore
		.listChats()
		.filter((c) => c.course?.courseId === courseId)
		.map((c) => ({
			id: c.id,
			title: c.title,
			mode: c.course!.mode,
			updatedAt: c.updatedAt,
			// listChats already folded this (sessionFinishOf over the record) while it had the
			// record open — re-reading the chat file here only to ask again cost a full parse.
			...(c.finished ? { finished: true } : {}),
		}));
	const reused: CourseView["reused"] = {};
	for (const d of course.draft?.skills ?? []) {
		const existing = d.reuse ? ctx.skills.get(d.reuse) : undefined;
		if (existing) reused[existing.id] = { name: existing.name, statement: existing.statement };
	}
	return {
		course,
		skills,
		review: p.review,
		reviewBatch: Math.min(p.review.length, REVIEW_SESSION_SIZE),
		nextUp: exam.nextUp,
		notExamined: exam.notExamined,
		plan: exam.plan,
		learning: p.learning,
		locked: p.locked,
		known: p.known,
		contextCheck: p.contextCheck,
		missed: missedViews(openMisses(ctx.problems.get(courseId) ?? []), ctx),
		sessions,
		reused,
		// vocabulary coverage (WP5): absent when the class has no indexed core term and no mapping
		...((v) => (v ? { coverage: v } : {}))(coverageView(course, courseLanguage(course), courseTermMapping(courseId))),
		// WP8: the Upcoming list (the old exam date included as "Exam")
		upcoming: upcomingView(course, ctx.now),
		// WP9: the lectures, the class's position and where the learner stands
		...(exam.standing ? { standing: exam.standing } : {}),
	};
}

// ─── create / rename / delete ────────────────────────────────────────────────

/** A course's language: its own stamp, else the CURRENT default language (a course made before
 *  languages has none) — unlike a lesson, whose missing stamp means English. */
function courseLanguage(course: CourseRecord): LessonLanguage {
	return course.language ?? stores.settingsStore.readSettings()?.general?.language ?? DEFAULT_LESSON_LANGUAGE;
}

/** A new course, stamped with the default language (fork addition, 2026-11-02). */
export function createCourse(title: string): CourseRecord {
	const created = stores.courseStore.createCourse(title);
	return stores.courseStore.updateCourse(created.id, { language: courseLanguage(created) }) ?? created;
}

/** Set a course's language: read by its next draft and stamped on the sessions started from it. */
export function setCourseLanguage(courseId: string, language: LessonLanguage): CourseRecord | null {
	return stores.courseStore.updateCourse(courseId, { language });
}

export function renameCourse(courseId: string, title: string): CourseRecord | null {
	return stores.courseStore.updateCourse(courseId, { title: title.trim() || "Untitled course" });
}

/** Set or clear (undefined) a course's default pace (fork addition, 2026-11-09 — core/pace.ts). Cleared = the global default. */
export function setCoursePace(courseId: string, pace: Pace | undefined): CourseRecord | null {
	return stores.courseStore.updateCourse(courseId, { pace });
}

/** Parse the PATCH body's `folder`: a valid name, or null (or blank text) to take the course out of its folder. */
export function parseFolderField(raw: unknown): { ok: true; folder: string | undefined } | { ok: false; error: string } {
	if (raw === null || (typeof raw === "string" && raw.trim() === "")) return { ok: true, folder: undefined };
	const name = normalizeFolderName(raw);
	return name ? { ok: true, folder: name } : { ok: false, error: `folder must be 1 to ${FOLDER_NAME_MAX} characters, or null` };
}

/** Put a course in a folder, or take it out (undefined). The name takes the spelling an existing folder already has
 *  (core/course-folders.ts), so two devices never make two folders of "2026 Høst" and "2026 høst". */
export function setCourseFolder(courseId: string, folder: string | undefined): CourseRecord | null {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return null;
	const named = folder === undefined ? undefined : canonicalFolderName(folder, stores.courseStore.listCourses().flatMap((c) => (c.folder ? [c.folder] : [])));
	return stores.courseStore.updateCourse(courseId, { folder: named });
}

/** Rename a folder (every course in it moves, merging into a folder of the new name) or remove it (its courses leave it;
 *  none is deleted). Returns how many courses changed. */
export function changeCourseFolders(action: { action: "rename"; from: string; to: string } | { action: "remove"; name: string }): Result<{ changed: number }> {
	const courses = stores.courseStore.listCourses();
	const changes = action.action === "rename" ? renameFolderChanges(courses, action.from, action.to) : removeFolderChanges(courses, action.name);
	if (changes === null) return { ok: false, status: 400, error: `a folder name is 1 to ${FOLDER_NAME_MAX} characters` };
	for (const change of changes) stores.courseStore.updateCourse(change.id, { folder: change.folder });
	return { ok: true, value: { changed: changes.length } };
}

/** Parse the PATCH body's `examDate`: a real calendar date, or null to clear it. */
export function parseExamDateField(raw: unknown): { ok: true; date: string | undefined } | { ok: false; error: string } {
	if (raw === null || raw === "") return { ok: true, date: undefined };
	const date = parseExamDate(raw);
	return date ? { ok: true, date } : { ok: false, error: "examDate must be a date like 2026-12-12, or null" };
}

/** Set or clear a course's exam date (fork addition, 2026-11-13 — core/exam-plan.ts). */
export function setCourseExamDate(courseId: string, examDate: string | undefined): CourseRecord | null {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return null;
	// The old exam date's item (LEGACY_ITEM_ID) is absent or deleted: a fresh tombstone stamp, so a chat card that removed
	// it earlier no longer reads as current once this date is cleared again (WP8 re-check 1, N2).
	const entries = readAssessmentEntries(course.assessments);
	const held = entries.find((e) => e.id === LEGACY_ITEM_ID);
	if (held && !isTombstone(held)) return stores.courseStore.updateCourse(courseId, { examDate });
	const stamp = new Date(Math.max(Date.now(), held ? Date.parse(held.updatedAt) + 1 : 0)).toISOString();
	const assessments = boundAssessments(upsertEntry<AssessmentEntry>(entries, { id: LEGACY_ITEM_ID, deleted: true, updatedAt: stamp }));
	return stores.courseStore.updateCourse(courseId, { examDate, assessments });
}

/** Parse the PATCH body's `weights`: { skillId: 0-3 | null }, null clearing a skill's entry. */
export function parseWeightsField(raw: unknown): { ok: true; weights: Record<string, number | null> } | { ok: false; error: string } {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "weights must be an object of skill id to 0-3 or null" };
	const out: Record<string, number | null> = {};
	for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
		if (value === null) out[id] = null;
		else if (parseWeightValue(value) !== null) out[id] = value as number;
		else return { ok: false, error: `the weight of ${id} must be 0, 1, 2, 3 or null` };
	}
	return { ok: true, weights: out };
}

/** The learner sets (or clears) skills' exam weights by hand; a hand edit survives a re-weigh. Only the course's own skills. */
export function setCourseSkillWeights(courseId: string, edits: Record<string, number | null>): Result<CourseRecord> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	const own = new Set(course.skills);
	const stranger = Object.keys(edits).find((id) => !own.has(id));
	if (stranger) return { ok: false, status: 400, error: `${stranger} is not a skill of this course` };
	const next: SkillWeights = { ...(sanitizeWeights(course.skillWeights) ?? {}) };
	for (const [id, value] of Object.entries(edits)) {
		if (value === null) delete next[id];
		else next[id] = { w: parseWeightValue(value)!, by: "learner" };
	}
	const updated = stores.courseStore.updateCourse(courseId, { skillWeights: Object.keys(next).length > 0 ? next : undefined })!;
	return { ok: true, value: updated };
}

/** Set or clear a course's time note (fork addition, 2026-11-01 — core/pace.ts). Blank clears it. */
export function setCourseNote(courseId: string, note: string | undefined): CourseRecord | null {
	return stores.courseStore.updateCourse(courseId, { note: normalizePaceNote(note) });
}

/** Delete a course: its record and its material. Its skills stay in the
 *  graph (shared, with their history); its sessions stay, unlabelled. */
export function deleteCourse(courseId: string): boolean {
	if (!stores.courseStore.getCourse(courseId)) return false;
	draftRuns().get(courseId)?.abort();
	weighRuns().get(courseId)?.abort();
	abortCourseTermMapping(courseId);
	abortAssessmentFind(courseId);
	abortLectureLinking(courseId);
	for (const m of stores.materialStore.list(courseId)) removeMaterial(courseId, m.id);
	stores.materialStore.removeAll(courseId);
	removeCourseLectureNotes(courseId);
	return stores.courseStore.deleteCourse(courseId);
}

// ─── drafting ────────────────────────────────────────────────────────────────

const RUNS_KEY = Symbol.for("lh.courseDraftRuns");
function draftRuns(): Map<string, AbortController> {
	const g = globalThis as Record<symbol, Map<string, AbortController> | undefined>;
	g[RUNS_KEY] ??= new Map();
	return g[RUNS_KEY];
}

/** How many courses are being drafted right now (the idle check reads this). */
export function courseDraftCount(): number {
	return draftRuns().size;
}

/** Is a drafting run live for this course? */
export function courseDrafting(courseId: string): boolean {
	return draftRuns().has(courseId);
}

// ─── weighing by exams (owner, 2026-11-13 — agent/subagents/exam-weigher.ts) ─

const WEIGH_KEY = Symbol.for("lh.courseWeighRuns");
function weighRuns(): Map<string, AbortController> {
	const g = globalThis as Record<symbol, Map<string, AbortController> | undefined>;
	g[WEIGH_KEY] ??= new Map();
	return g[WEIGH_KEY];
}

/** How many weighing passes are running (the idle check reads this, so the Android shell does not rest the server mid-pass). */
export function courseWeighCount(): number {
	return weighRuns().size;
}

/** Is a weighing pass live for this course? */
export function courseWeighing(courseId: string): boolean {
	return weighRuns().has(courseId);
}

/** Start the "Weigh by exams" pass. Returns at once; the run writes the weights on the record and announces it. */
export function startCourseWeighing(courseId: string): Result<CourseRecord> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	if (course.skills.length === 0) return { ok: false, status: 400, error: "Approve the skill map first" };
	if (weighRuns().has(courseId)) return { ok: false, status: 409, error: "The skills are already being weighed" };
	if (listMaterials(courseId).length === 0) return { ok: false, status: 400, error: "Add the curriculum first (past exams count most)" };
	const controller = new AbortController();
	weighRuns().set(courseId, controller);
	const updated = stores.courseStore.updateCourse(courseId, { weightsError: undefined })!;
	void runWeigh(courseId, controller).finally(() => weighRuns().delete(courseId));
	return { ok: true, value: updated };
}

async function runWeigh(courseId: string, controller: AbortController): Promise<void> {
	const settle = (patch: Partial<CourseRecord>) => {
		if (stores.courseStore.getCourse(courseId)) stores.courseStore.updateCourse(courseId, patch);
	};
	try {
		await waitForMaterials(courseId);
		const course = stores.courseStore.getCourse(courseId);
		if (!course || controller.signal.aborted) return;
		const spec = resolveRoleSpec("coursePlanner", stores.settingsStore.readSettings());
		if (!spec) {
			settle({ weightsError: "No model is configured for the course planner (Settings → Agent: the strong slot or a Course planner override)" });
			return;
		}
		const materials = listMaterials(courseId);
		const materialsSection = `<curriculum>\n${materials.map((m) => materialBlock(m, stores.materialStore.filePath(courseId, m))).join("\n\n")}\n</curriculum>`;
		const ctx = readContext();
		const skills = course.skills
			.map((id) => ctx.skills.get(id))
			.filter((s): s is Skill => s !== undefined)
			.map((s) => ({ id: s.id, name: s.name, statement: s.statement }));
		const result = await weighCourse(
			{ title: course.title, materialsSection, skills, language: courseLanguage(course) },
			{
				engine: piEngineForSpec(spec),
				signal: controller.signal,
				tools: materialTools({ chatId: courseId, store: stores.materialStore }),
				onStep: () => {},
				courseId,
			},
		);
		const fresh = stores.courseStore.getCourse(courseId);
		if (!fresh) return; // deleted mid-run
		// a hand edit made while the pass ran (or before it) stays: the pass only fills in the model's weights
		const merged = mergeModelWeights(sanitizeWeights(fresh.skillWeights), result.weights, fresh.skills);
		settle({ skillWeights: merged, weightsSummary: result.summary, weightsAt: new Date().toISOString(), pastExams: result.pastExams, weightsError: undefined });
	} catch (err) {
		if (controller.signal.aborted) return;
		settle({ weightsError: err instanceof Error ? err.message : String(err) });
	}
}

/** A course left "drafting" by a run that no longer exists (the process
 *  restarted or crashed mid-draft — the status is on disk, the run only in
 *  memory) would spin forever with its Draft button disabled. Settle it
 *  the way a failed draft settles, and say what happened. */
function healOrphanDraft(course: CourseRecord): CourseRecord {
	if (course.status !== "drafting" || draftRuns().has(course.id)) return course;
	return (
		stores.courseStore.updateCourse(course.id, {
			status: course.skills.length > 0 ? "active" : course.draft ? "draft" : "error",
			error: "Drafting was interrupted (the app restarted) — draft again.",
		}) ?? course
	);
}

/** Start drafting (or re-drafting with the owner's feedback). Returns at
 *  once; the run parks its draft on the record and announces it. */
export function startCourseDraft(courseId: string, feedback?: string): Result<CourseRecord> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	if (draftRuns().has(courseId)) return { ok: false, status: 409, error: "The skill map is already being drafted" };
	if (listMaterials(courseId).length === 0) return { ok: false, status: 400, error: "Add the curriculum first (PDFs, notes or links)" };
	const changeRequest = feedback?.trim();
	if (changeRequest && !course.draft) return { ok: false, status: 400, error: "There is no draft to change — draft the skill map first" };
	const controller = new AbortController();
	draftRuns().set(courseId, controller);
	const updated = stores.courseStore.updateCourse(courseId, { status: "drafting", error: undefined })!;
	void runDraft(courseId, changeRequest || undefined, controller).finally(() => draftRuns().delete(courseId));
	return { ok: true, value: updated };
}

async function runDraft(courseId: string, feedback: string | undefined, controller: AbortController): Promise<void> {
	const startedAt = Date.now();
	const steps: ReturnType<typeof callUsage>[] = [];
	let model = "unknown";
	const settle = (patch: Partial<CourseRecord>) => {
		const current = stores.courseStore.getCourse(courseId);
		if (!current) return; // deleted mid-run
		const usage = steps.length > 0
			? [...(current.drafts ?? []), { startedAt, at: new Date().toISOString(), durationMs: Date.now() - startedAt, planner: { model, steps } }]
			: current.drafts;
		stores.courseStore.updateCourse(courseId, { ...patch, ...(usage ? { drafts: usage } : {}) });
	};
	try {
		await waitForMaterials(courseId);
		const course = stores.courseStore.getCourse(courseId);
		if (!course || controller.signal.aborted) return;
		const spec = resolveRoleSpec("coursePlanner", stores.settingsStore.readSettings());
		if (!spec) {
			settle({ status: course.skills.length > 0 ? "active" : "error", error: "No model is configured for the course planner (Settings → Agent: the strong slot or a Course planner override)" });
			return;
		}
		const materials = listMaterials(courseId);
		const materialsSection = `<curriculum>\n${materials
			.map((m) => materialBlock(m, stores.materialStore.filePath(courseId, m)))
			.join("\n\n")}\n</curriculum>`;
		const ctx = readContext();
		const approved = course.skills
			.map((id) => ctx.skills.get(id))
			.filter((s): s is Skill => s !== undefined)
			.map((s) => ({ id: s.id, name: s.name, statement: s.statement }));
		const tools: Record<string, AgentTool<any>> = {
			...materialTools({ chatId: courseId, store: stores.materialStore }),
			...plannerGraphTools({ chatStore: stores.chatStore, graphStore: stores.graphStore }),
		};
		// The planner's model requests pass the process-wide worker-request admission (agent/worker-request-admission.ts),
		// the one background-LLM pool: no wrapper of its own.
		const result = await draftCourse(
			{
				title: course.title,
				materials: materials.map((m) => ({ id: m.id, name: m.name })),
				materialsSection,
				...(feedback && course.draft ? { previous: { draft: course.draft, feedback } } : {}),
				...(approved.length > 0 ? { approved } : {}),
				language: courseLanguage(course),
				// the class glossary (WP5): the planner maps its core terms when it has any
				glossary: coverageGlossary(courseId),
			},
			{
				engine: piEngineForSpec(spec),
				signal: controller.signal,
				checkContext: () => checkContext(),
				tools,
				courseId,
				onStep: (usage, m) => {
					model = m;
					steps.push(callUsage(usage));
				},
			},
		);
		// WP5: a re-draft keeps the class's earlier vocabulary decisions (carried into the proposal the student reviews)
		const glossaryNow = coverageGlossary(courseId);
		const before = readCourseCoverage(stores.courseStore.getCourse(courseId)?.coverage);
		const coverage =
			before && (result.coverage || hasCoreEntries(glossaryNow))
				? {
						dropped: result.coverage?.dropped ?? [],
						incomplete: result.coverage?.incomplete ?? (glossaryNow?.incomplete ?? []).map((m) => m.name),
						shown: result.coverage?.shown ?? { full: 0, names: 0, omitted: 0 },
						...carryForward(before, result.coverage, result.skills, glossaryNow),
						// the carry is advice for the page: approval carries again if the approved map changes (review 2, finding 7)
						...carriedStamp(before),
					}
				: result.coverage;
		const draft: CourseDraft = {
			createdAt: new Date().toISOString(),
			summary: result.summary,
			...(feedback ? { feedback } : {}),
			skills: result.skills,
			...(coverage ? { coverage } : {}),
		};
		const fresh = stores.courseStore.getCourse(courseId);
		settle({ status: (fresh?.skills.length ?? 0) > 0 ? "active" : "draft", draft, error: undefined });
	} catch (err) {
		if (controller.signal.aborted) return;
		const current = stores.courseStore.getCourse(courseId);
		settle({
			status: (current?.skills.length ?? 0) > 0 ? "active" : current?.draft ? "draft" : "error",
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

// ─── approval (the skills ledger's ONLY writer) ──────────────────────────────

/** A draft of the shape approval reads: an object whose skills each have a key, a name, a statement and their lists. */
function readableDraft(draft: unknown): draft is CourseDraft {
	if (!draft || typeof draft !== "object" || Array.isArray(draft)) return false;
	const skills = (draft as { skills?: unknown }).skills;
	return (
		Array.isArray(skills) &&
		skills.every((s) => {
			const r = s as Record<string, unknown> | null;
			return !!r && typeof r === "object" && typeof r.key === "string" && typeof r.name === "string" && typeof r.statement === "string" && Array.isArray(r.requires) && Array.isArray(r.restsOn) && (r.reuse === undefined || typeof r.reuse === "string");
		})
	);
}

/** Approve the pending draft. When the class glossary has core terms NOW (WP5), every one must be assigned or excluded,
 *  whether or not the draft carries a proposal (none reads as an empty mapping): otherwise approval is refused (409) and
 *  lists them, unless `leaveUnassigned` (the student's explicit "leave N terms unassigned") makes each one excluded with
 *  the reason "left out at approval". The class's earlier decisions are carried forward (core/coverage-items.ts
 *  carryForward) and the ones that could not be kept are listed on the page. A class whose glossary has no core term
 *  approves as before, its stored mapping (if any) only cleared of skills no longer in the map. */
export function approveCourse(courseId: string, opts: { leaveUnassigned?: boolean } = {}): Result<CourseRecord> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	if (draftRuns().has(courseId)) return { ok: false, status: 409, error: "The skill map is still being drafted" };
	if (!course.draft) return { ok: false, status: 409, error: "There is no draft to approve" };
	// a synced or hand-edited draft of the wrong shape is refused, never a thrown request (WP5 review 3)
	if (!readableDraft(course.draft)) return { ok: false, status: 422, error: "The draft cannot be read — ask for changes to re-draft it" };
	const ctx = checkContext();
	const problems = draftProblems(course.draft.skills, ctx);
	if (problems.length > 0) {
		return { ok: false, status: 422, error: `The draft no longer fits the graph — ask for changes to re-draft it: ${problems.join("; ")}` };
	}
	// refused BEFORE anything is written (no silent drop in either direction); the vocabulary part never throws out of
	// approval (WP5 review 3): a proposal that cannot be read refuses it
	let unassigned: ReturnType<typeof draftUnassigned>;
	try {
		unassigned = draftUnassigned(course);
	} catch {
		return { ok: false, status: 409, error: "The draft's vocabulary mapping could not be read — ask for changes to re-draft it" };
	}
	if (unassigned.length > 0 && !opts.leaveUnassigned) {
		const names = unassigned.slice(0, 12).map((e) => e.name).join(", ");
		return {
			ok: false,
			status: 409,
			error: `${unassigned.length} core term${unassigned.length === 1 ? " is" : "s are"} neither assigned to a skill nor excluded: ${names}${unassigned.length > 12 ? ` and ${unassigned.length - 12} more` : ""}. Assign or exclude ${unassigned.length === 1 ? "it" : "them"}, or choose "Leave ${unassigned.length} unassigned".`,
		};
	}
	const now = new Date().toISOString();
	const mint = () => `sk_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
	const { lines, skillIds, idOf } = approveDraft(course.draft, ctx, mint, now);
	let coverage = readCourseCoverage(course.coverage);
	const glossary = coverageGlossary(courseId);
	if (hasCoreEntries(glossary)) {
		let proposal: ReturnType<typeof approvalProposal>;
		try {
			proposal = approvalProposal(course, glossary);
		} catch {
			return { ok: false, status: 409, error: "The draft's vocabulary mapping could not be read — ask for changes to re-draft it" };
		}
		const approved = approveCoverage(proposal, (key) => idOf[key], glossary, opts.leaveUnassigned ? leftAtApprovalReason(courseLanguage(course)) : null, now);
		if (!approved.ok) return { ok: false, status: 409, error: `Core terms are unassigned: ${approved.unassigned.map((e) => e.term).join(", ")}` };
		coverage = approved.coverage;
	}
	// no stale skill id stays in a stored mapping after an approval
	if (coverage) {
		const pruned = pruneStaleSkills(coverage, new Set(skillIds));
		const displaced = [...(coverage.displaced ?? []), ...pruned.displaced];
		coverage = { ...coverage, ...pruned.mapping, updatedAt: now, ...(displaced.length > 0 ? { displaced } : {}) };
	}
	stores.skillStore.appendSkillLines(lines);
	// WP9: each skill's cite outlives the draft, for the "link skills to lectures" step
	const skillCites: Record<string, string> = {};
	for (const d of course.draft.skills) {
		const id = idOf[d.key];
		if (id && typeof d.cite === "string" && d.cite.trim()) skillCites[id] = d.cite.trim().slice(0, 200);
	}
	const updated = stores.courseStore.updateCourse(courseId, { skills: skillIds, draft: undefined, status: "active", error: undefined, skillCites: Object.keys(skillCites).length > 0 ? skillCites : undefined, ...(coverage ? { coverage } : {}) })!;
	// WP9: place the new map's skills in the lectures (in the background; it never blocks anything)
	maybeLinkLectures(courseId);
	return { ok: true, value: updated };
}

/** "Map the class's terms" (WP5): the planner's mapping-only pass on the approved map, or on the pending draft
 *  (`target`), in the class's language. It only adds assignments for terms with no decision; its exclusions and links
 *  become suggestions. Returns at once (server/course-coverage.ts). */
export function startCourseTermMap(courseId: string, target: "approved" | "draft" = "approved"): Result<CourseRecord> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	if (draftRuns().has(courseId)) return { ok: false, status: 409, error: "The skill map is being drafted" };
	return startCourseTermMapping(courseId, courseLanguage(course), target);
}

// ─── sessions from a course ──────────────────────────────────────────────────

function sessionSkill(id: string, ctx: ReadContext): SessionSkill {
	const skill = ctx.skills.get(id)!;
	const state = ctx.skillStates.get(id);
	return {
		id,
		name: skill.name,
		statement: skill.statement,
		understanding: state ? understandingOf(state) : 0,
		learned: state !== undefined,
		known: state !== undefined && isKnown(state),
		needsReview: state !== undefined && needsReview(state, ctx.now),
		...(ctx.notes.get(id) ? { note: ctx.notes.get(id)!.summary } : {}),
	};
}

/** What each concluded problem of a course practice, review or check session did to its skills' understanding
 *  (owner, 2026-11-13): the memory model folded over every course's evidence before the problem and with it. Null for
 *  any other session. */
export function ratingChanges(chatId: string): RatingChange[] | null {
	const ev = chatCourseEvidence(chatId);
	const link = ev?.link;
	if (!ev || !link || link.mode === "learn" || link.mode === "placement" || link.mode === "ask") return null;
	const ctx = readContext();
	const requiresOf = (id: string) => ctx.skills.get(id)?.requires ?? [];
	const all = [...ctx.byCourse.values()].flat();
	const own = ev.events;
	const out: RatingChange[] = [];
	for (const { callId, at } of ev.concludeCalls) {
		const ids = [...new Set(own.filter((e) => e.at === at).map((e) => e.skillId))];
		if (ids.length === 0) continue;
		const before = foldSkills(all.filter((e) => e.at < at), requiresOf);
		const after = foldSkills(all.filter((e) => e.at <= at), requiresOf);
		out.push({
			callId,
			skills: ids.map((id) => {
				const b = before.get(id);
				const a = after.get(id);
				return {
					id,
					name: ctx.skills.get(id)?.name ?? id,
					before: b ? understandingOf(b) : 0,
					after: a ? understandingOf(a) : 0,
					reviewAt: a ? new Date(reviewAt(a)).toISOString() : null,
				};
			}),
		});
	}
	return out;
}

/** The card under a finished lesson (GET /api/chats/[id]/lesson-result, owner 2026-11-13): the skill, its new
 *  understanding and review date, the teacher's summary, and the next skill in the course's order. Null when the chat is
 *  not a course Learn session. */
export function lessonResult(chatId: string): LessonResult | null {
	const ev = chatCourseEvidence(chatId);
	const link = ev?.link;
	if (!ev || !link || link.mode !== "learn") return null;
	const course = stores.courseStore.getCourse(link.courseId);
	const skillId = link.skillIds[0];
	if (!course || !skillId) return null;
	const ctx = readContext();
	const skill = ctx.skills.get(skillId);
	if (!skill) return null;
	const state = ctx.skillStates.get(skillId);
	const p = partitionOf(course, ctx);
	const { nextUp } = examPlanOf(course, p, ctx);
	const next = nextUp.find((id) => id !== skillId);
	return {
		courseId: course.id,
		skill: { id: skillId, name: skill.name },
		understanding: state ? understandingOf(state) : 0,
		learned: state !== undefined,
		reviewAt: state ? new Date(reviewAt(state)).toISOString() : null,
		summary: ev.note?.summary ?? null,
		next: next ? { id: next, name: ctx.skills.get(next)?.name ?? next } : null,
		// what the lesson covered of the skill's core terms (WP5)
		// (read from the clean finish's record; only a class with a vocabulary mapping has one, so others never read the chat)
		...((c) => (c ? { coverage: c } : {}))(course.coverage ? lessonCoverage(stores.chatStore.getChat(chatId)?.messages ?? [], courseLanguage(course)) : undefined),
	};
}

/** A random order of `ids` (Fisher-Yates); a copy, never the input. */
export function shuffled<T>(ids: readonly T[], random: () => number = Math.random): T[] {
	const out = [...ids];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[out[i], out[j]] = [out[j]!, out[i]!];
	}
	return out;
}

/** Create a session from a course (docs/courses.md §4). The client sends
 *  `prompt` as the first learner message. */
export function createCourseSession(
	courseId: string,
	mode: CourseMode,
	skillId?: string,
	/** The Learn dialog's pick (fork addition, 2026-11-09): this session's pace. Else the course's, else the global default. */
	pace?: Pace,
	/** A chosen set to practice (2026-11-14): learned or next-up skills, known ones too; locked skills are refused. */
	skillIds?: readonly string[],
	/** A placement RETEST (2026-11-16): only skills not learned yet or learned and due or fading before the exam. */
	retest = false,
): Result<{ id: string; title: string; prompt: string }> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	// Ask (2026-11-25) needs no skill map: right after an upload the learner can ask about the PDF.
	if (mode === "ask") return createAskSession(course, skillId, skillIds, retest);
	if (course.skills.length === 0) return { ok: false, status: 409, error: "Approve the course's skill map first" };
	const ctx = readContext();
	const p = partitionOf(course, ctx);
	if (skillId !== undefined && !p.order.includes(skillId)) return { ok: false, status: 400, error: "That skill is not in this course" };
	if (retest && mode !== "placement") return { ok: false, status: 400, error: "retest is only for the placement test" };
	let chosen: string[] | undefined;
	if (skillIds !== undefined) {
		if (mode !== "practice") return { ok: false, status: 400, error: "skillIds is only for practice" };
		chosen = [...new Set(skillIds)];
		if (chosen.length === 0) return { ok: false, status: 400, error: "Choose at least one skill to practice" };
		if (chosen.some((id) => !p.order.includes(id))) return { ok: false, status: 400, error: "A chosen skill is not in this course" };
		// a locked skill cannot be taught from its prerequisites: it has to be learned first
		if (chosen.some((id) => p.locked.includes(id))) return { ok: false, status: 409, error: "A locked skill cannot be practiced — learn what it builds on first" };
	}
	let ids: string[];
	switch (mode) {
		case "learn":
			if (skillId === undefined) return { ok: false, status: 400, error: "Learn needs a skill" };
			ids = [skillId];
			break;
		case "practice":
			// "Practice all" practices what is learned but not known yet
			// "Practice all" mixes its order (owner, 2026-11-13): practice that interleaves skills holds better than a block
			// a chosen set (any learned or next-up skill) is mixed the same way
			ids = chosen !== undefined ? shuffled(chosen) : skillId !== undefined ? [skillId] : shuffled(p.learning);
			if (ids.length === 0) return { ok: false, status: 409, error: "Nothing to practice yet — finish a lesson first" };
			break;
		case "review":
			// one session's worth: the weakest, the stalest, a morale skill;
			// the rest stay due for the next session
			ids = pickReviewSkills(p, undefined, examReviewScoreOf(course, p, ctx));
			if (ids.length === 0) return { ok: false, status: 409, error: "Nothing needs review right now" };
			break;
		case "placement":
			if (retest) {
				// a retest asks only about what is not learned or needs review (owner, 2026-11-16)
				if (!p.order.some((id) => p.states.get(id)?.learned)) return { ok: false, status: 409, error: "Nothing to retest yet — take the placement test or finish a lesson first" };
				ids = retestSkills(p);
				if (ids.length === 0) return { ok: false, status: 409, error: "Nothing to retest — every skill is held well" };
				break;
			}
			// skills already had from another course get their own context
			// check — the placement test does not spend questions on them
			ids = p.order.filter((id) => !p.contextCheck.includes(id));
			if (ids.length === 0) return { ok: false, status: 409, error: "Every skill is already known from another course — use the context checks" };
			break;
		case "check":
			if (skillId === undefined) return { ok: false, status: 400, error: "A context check needs a skill" };
			if (!ctx.skillStates.has(skillId)) return { ok: false, status: 409, error: "Learn this skill first — a context check is for skills you already have" };
			ids = [skillId];
			break;
	}
	const idSet = new Set(ids);
	const placementWeights = mode === "placement" ? sanitizeWeights(course.skillWeights) : undefined;
	const placementPriorities = placementWeights ? priorities(ids, (id) => ctx.skills.get(id)?.requires ?? [], placementWeights) : undefined;
	const skills = ids.map((id) => {
		const base = sessionSkill(id, ctx);
		if (mode !== "placement") return base;
		const requires = (ctx.skills.get(id)?.requires ?? []).filter((r) => idSet.has(r));
		return {
			...base,
			...(requires.length > 0 ? { requires } : {}),
			...(placementPriorities ? { priority: placementPriorities.get(id) } : {}),
		};
	});
	const background =
		mode === "learn" ? (ctx.skills.get(ids[0]!)?.requires ?? []).filter((r) => ctx.skills.has(r)).map((r) => sessionSkill(r, ctx)) : [];
	const learnChats = learnChatsBySkill();
	const propIds = [...new Set(ids.flatMap((id) => skillPropositionIds(ctx.skills.get(id)!, ctx, learnChats)))].slice(0, 64);
	const byId = new Map(ctx.graph.nodes.map((n) => [n.id, n]));
	const picked = propIds.map((id) => byId.get(id)!).filter(Boolean);
	const chains = chainsForSelection(picked, ctx.graph.chains).map((c) => formatChainLine(c, Object.fromEntries(byId)));
	// WP5: the vocabulary items this session is listed (and, for Learn, owes) are fixed now and stored with it
	const vocabSkill = mode === "learn" || (mode === "practice" && ids.length === 1) ? ids[0] : undefined;
	const listed = vocabSkill ? listedVocabularyFor(course, vocabSkill) : undefined;
	const link: ChatCourseLink = { courseId, mode, skillIds: ids, ...(retest ? { retest: true } : {}), ...(listed ? { vocabulary: listed } : {}) };
	const title = courseSessionTitle(mode, course.title, skills, retest);
	// Learn and the placement test are conversation sessions (the teacher;
	// the placement tester); practice and review are practice sessions.
	const chat = stores.chatStore.createChat(title, mode === "learn" || mode === "placement" ? undefined : "practice", link);
	// pace: the dialog's pick, else the course's default; absent, stampNewSession falls back to the global default
	const sessionPace = pace ?? course.pace;
	stampNewSession(chat.id, { language: courseLanguage(course), ...(sessionPace ? { pace: sessionPace } : {}), learnerProfile: mode !== "placement" });
	stores.chatStore.saveMessages(chat.id, [
		newCourseContextMessage({
			courseTitle: course.title,
			mode,
			skills,
			background,
			propositions: picked.map((n) => ({ id: n.id, name: n.name, statement: n.statement })),
			chains,
		}),
	]);
	// a course's activity order follows its sessions
	stores.courseStore.updateCourse(courseId, {});
	return { ok: true, value: { id: chat.id, title: chat.title, prompt: courseFirstMessage(mode, course.title, skills, courseLanguage(course), retest) } };
}

/** An Ask conversation on the course (2026-11-25, agent/ask-agent.ts): an ordinary chat linked to the course with no
 *  skills and NO messages: no context marker and no generated first message, so it opens on an empty composer. */
function createAskSession(course: CourseRecord, skillId?: string, skillIds?: readonly string[], retest = false): Result<{ id: string; title: string; prompt: string }> {
	if (skillId !== undefined || skillIds !== undefined || retest) return { ok: false, status: 400, error: "An Ask conversation takes no skills" };
	const link: ChatCourseLink = { courseId: course.id, mode: "ask", skillIds: [] };
	const chat = stores.chatStore.createChat(courseSessionTitle("ask", course.title, []), undefined, link);
	// the course's language; no learner profile (the Ask agent reads none)
	stampNewSession(chat.id, { language: courseLanguage(course), learnerProfile: false });
	// The course record is NOT touched (review 1 finding 3): its updatedAt orders Today and the course list, and an Ask
	// conversation is not studying. createChat already announces the new chat.
	return { ok: true, value: { id: chat.id, title: chat.title, prompt: courseFirstMessage("ask", course.title, [], courseLanguage(course)) } };
}

/** An Ask conversation's title (2026-11-25): "Questions: <course>" until the learner asks something, then their first
 *  question, trimmed, so several conversations can be told apart. Only while the default title stands and no question
 *  has been asked yet (a title the learner chose is kept). Called by the chat handler once the input is saved. */
export function titleAskConversation(chatId: string, priorMessages: readonly { role?: string }[], text: string): void {
	const record = stores.chatStore.getChat(chatId);
	if (record?.course?.mode !== "ask") return;
	if (priorMessages.some((m) => m.role === "user")) return;
	// Only the untouched default, "Questions: <course>", is replaced. An exact match, not a prefix: the learner may have
	// named it "Questions: Week 3" themselves. (A course renamed since leaves the old default standing; that is the
	// safe side.)
	const course = stores.courseStore.getCourse(record.course.courseId);
	if (!course || record.title !== courseSessionTitle("ask", course.title, [])) return;
	const title = titleFromPrompt(text);
	if (title) stores.chatStore.renameChat(chatId, title);
}

/** What deleting these sessions takes from the courses (merge review finding 1): skill progress is derived from the
 *  course sessions' transcripts through the same three channels as courseEvidence (skill events, a learn session's
 *  lesson note, concluded practice/review/check problems), so a session that recorded any of them takes that progress
 *  with it in either delete mode. Unknown ids and sessions without a course are ignored. */
export function courseDeletionImpact(chatIds: readonly string[]): CourseDeletionImpact {
	const byCourse = new Map<string, number>();
	const skills = new Set<string>();
	let sessions = 0;
	for (const id of new Set(chatIds)) {
		const ev = chatCourseEvidence(id);
		if (!ev) continue;
		const { link, events, note, problems } = ev;
		if (events.length === 0 && !note && problems.length === 0) continue;
		sessions++;
		byCourse.set(link.courseId, (byCourse.get(link.courseId) ?? 0) + 1);
		for (const e of events) skills.add(e.skillId);
		if (note) for (const s of link.skillIds) skills.add(s);
		for (const p of problems) for (const s of p.skills) skills.add(s);
	}
	const courses = [...byCourse].map(([courseId, count]) => ({ id: courseId, title: stores.courseStore.getCourse(courseId)?.title ?? null, sessions: count }));
	return { sessions, courses, skills: skills.size };
}

/** A review or practice course session's course and skills (id + name), for
 *  the tutor's "Learn <skill>" buttons on a concluded problem. Null for any
 *  other session, or when the chat is unknown. */
export function courseSessionSkillNames(chatId: string): { courseId: string; skills: Array<{ id: string; name: string }> } | null {
	const link = chatCourseEvidence(chatId)?.link;
	if (!link || (link.mode !== "review" && link.mode !== "practice")) return null;
	const graph = getGraph(stores.graphStore);
	const nodeIds = new Set(graph.nodes.map((n) => n.id));
	const all = allSkills(nodeIds);
	const skills = link.skillIds.filter((id) => all.has(id)).map((id) => ({ id, name: all.get(id)!.name }));
	return { courseId: link.courseId, skills };
}

/** Is the vocabulary finish refusal on (Settings → General → Lessons; off by default, and off when the settings cannot
 *  be read)? */
function refuseFinishSetting(): boolean {
	try {
		return effectiveSettings().general.refuseFinishWithUnintroducedTerms === true;
	} catch {
		return false;
	}
}

/** A course session's per-turn pieces: the prompt section, its mode, and
 *  (practice modes, the placement test) the skills its question/problem
 *  tool may tag. Undefined for other sessions, or when the course is gone. */
export function courseForTurn(
	chatId: string,
): {
	section: string;
	mode: CourseMode;
	exam?: string;
	skills?: () => ReadonlyArray<{ id: string; name: string }>;
	placementSkills?: readonly PlacementSkillInfo[];
	lessonSkill?: { id: string; name: string };
	openerSkills?: Array<{ id: string; name: string }>;
	/** WP5: a Learn session's vocabulary finish check (absent without coverage). */
	vocabulary?: LessonVocabulary;
	/** WP5: reads a question's tags against the class's items (core/coverage-ledger.ts resolveConceptId); a tag it does
	 *  not know is counted as unknown in the turn timeline. */
	conceptIds?: ConceptIdReader;
} | undefined {
	const link = stores.chatStore.getChat(chatId)?.course;
	if (!link) return undefined;
	const course = stores.courseStore.getCourse(link.courseId);
	// Ask (2026-11-25): the course's name only. No skills, no evidence read, no exam line (nothing here is paced).
	if (link.mode === "ask") return { section: coursePromptSection("ask", course?.title ?? "(deleted course)", []), mode: "ask" };
	const ctx = readContext();
	const idSet = new Set(link.skillIds);
	const weights = link.mode === "placement" ? sanitizeWeights(course?.skillWeights) : undefined;
	const placementPriorities = link.mode === "placement" ? priorities(link.skillIds, (id) => ctx.skills.get(id)?.requires ?? [], weights) : undefined;
	const skills = link.skillIds.filter((id) => ctx.skills.has(id)).map((id) => {
		const base = sessionSkill(id, ctx);
		if (link.mode !== "placement") return base;
		const requires = (ctx.skills.get(id)?.requires ?? []).filter((r) => idSet.has(r));
		return {
			...base,
			...(requires.length > 0 ? { requires } : {}),
			...(weights && placementPriorities ? { priority: placementPriorities.get(id) } : {}),
		};
	});
	// open misses on this session's skills: practice and review retest each as a variant (owner, 2026-11-16)
	const courseProblems = link.mode === "practice" || link.mode === "review" ? (ctx.problems.get(link.courseId) ?? []) : [];
	const missed = link.mode === "practice" || link.mode === "review" ? missesForSession(openMisses(courseProblems), link.skillIds) : [];
	const recentSolved = link.mode === "practice" || link.mode === "review" ? recentSolvedForSession(courseProblems, link.skillIds) : [];
	const nameOf = (id: string) => ctx.skills.get(id)?.name ?? id;
	// WP5: a Learn session, or a Practice session on one skill, is told the vocabulary its skill owes
	const vocabSkill = (link.mode === "learn" || (link.mode === "practice" && skills.length === 1)) ? skills[0] : undefined;
	// the finish refusal is a setting, off by default, read as the turn's agent is built: a change applies from the next turn
	const refuseFinish = link.mode === "learn" && vocabSkill !== undefined && refuseFinishSetting();
	const vocabulary = course && vocabSkill ? sessionVocabulary(course, chatId, { id: vocabSkill.id, name: vocabSkill.name }, link.mode, link.vocabulary, { refuseFinish }) : undefined;
	const coverageParts = vocabulary ? { ...(vocabulary.lesson ? { vocabulary: vocabulary.lesson } : {}), conceptIds: vocabulary.known } : {};
	const section = coursePromptSection(
		link.mode,
		course?.title ?? "(deleted course)",
		skills,
		link.retest === true,
		missed.map((m) => ({
			statement: m.statement,
			skillNames: m.skills.filter((s) => link.skillIds.includes(s)).map(nameOf),
			how: MISS_HOW[m.outcome] ?? "missed it",
			date: new Date(m.at).toISOString().slice(0, 10),
		})),
		recentSolved.map((s) => ({
			statement: s.statement,
			skillNames: s.skills.filter((id) => link.skillIds.includes(id)).map(nameOf),
			date: new Date(s.at).toISOString().slice(0, 10),
		})),
		vocabulary?.section,
	);
	// The exam date becomes the teacher's exam line ("12 Dec 2026, 30 days left"), read fresh every turn so a changed
	// date, and each passing day, reach the sessions already running. The course's stored time note is no longer read.
	// WP8: the NEXT assessment (the old exam date reads exactly as before)
	const exam = course ? assessmentWhen(nextAssessment(courseAssessments(course), Date.now()), Date.now()) : undefined;
	// a lesson's one skill: the final problem is graded for it (core/final-problem.ts)
	const lessonSkill = skills[0] ? { id: skills[0].id, name: skills[0].name } : undefined;
	// the learned prerequisites of the lesson's skill: what its recall opener may test (core/final-problem.ts)
	const openerSkills = link.mode === "learn" && skills[0]
		? (ctx.skills.get(skills[0].id)?.requires ?? []).filter((r) => ctx.skillStates.has(r) && ctx.skills.has(r)).map((r) => ({ id: r, name: ctx.skills.get(r)!.name }))
		: [];
	if (link.mode === "learn") return { section, mode: link.mode, ...(exam ? { exam } : {}), ...(lessonSkill ? { lessonSkill } : {}), ...(openerSkills.length > 0 ? { openerSkills } : {}), ...coverageParts };
	const tags = skills.map((s) => ({ id: s.id, name: s.name }));
	if (link.mode === "placement") {
		const placementSkills: PlacementSkillInfo[] = skills.map((s) => ({
			id: s.id,
			name: s.name,
			requires: s.requires ?? [],
			priority: placementPriorities?.get(s.id) ?? 1,
		}));
		return { section, mode: link.mode, ...(exam ? { exam } : {}), skills: () => tags, placementSkills };
	}
	return { section, mode: link.mode, ...(exam ? { exam } : {}), skills: () => tags, ...coverageParts };
}
