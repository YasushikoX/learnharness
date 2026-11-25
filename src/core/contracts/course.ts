/**
 * Course contracts — skills, courses, and the session's course link
 * (fork addition, 2026-10-24; spec: docs/courses.md).
 *
 * A course turns a curriculum into SKILLS: checkable abilities that live
 * in the knowledge graph beside the propositions (data/graph/skills.jsonl
 * — one skill shared by every course that needs it), joined by `requires`
 * edges and linked to the propositions they rest on. How well each skill
 * is known is DERIVED (core/mastery.ts — the Leitner stand-in), never
 * stored. Pure types + tiny pure helpers.
 */

import type { LessonLanguage } from "../language.ts";
import type { Pace } from "../pace.ts";
import type { CoursePlan, SkillWeights } from "../exam-plan.ts";
import type { ExtractionStageUsage } from "./chat.ts";

// ─── Skills (the graph's second node kind) ──────────────────────────────────

/** One skills.jsonl line. The FIRST line for an id defines name/statement/
 *  createdAt; later lines for the same id are LINK-APPENDS whose
 *  `requires`/`restsOn` union in (a second course reusing the skill). */
export interface SkillLine {
	/** "sk_" + random — store-assigned at approval. */
	id: string;
	/** A short handle, like a proposition's name ("Chain rule"). */
	name: string;
	/** The checkable ability, at full precision ("Differentiate a
	 *  composition f(g(x)) with the chain rule"). */
	statement: string;
	/** Skill ids that must be known before this one. */
	requires: string[];
	/** Proposition ids (n_…) this skill rests on — the planner's links. */
	restsOn: string[];
	createdAt: string;
	/** A re-wording line (fork addition, 2026-11-02): `name`/`statement` replace
	 *  the earlier wording — the LAST reworded line wins. Set when a course's
	 *  language differs from the one the skill was written in. */
	reworded?: boolean;
}

/** A skill as read: its lines merged by id (core/skills.ts mergeSkillLines). */
export type Skill = SkillLine;

// ─── Courses (data/courses/<id>.json) ───────────────────────────────────────

/** new: no draft yet · drafting: the planner is running · draft: a draft
 *  awaits approval · active: approved (a later draft may also be waiting)
 *  · error: the last drafting run failed (see `error`). */
export type CourseStatus = "new" | "drafting" | "draft" | "active" | "error";

/** One skill of a planner draft. `requires` names other draft KEYS. */
export interface DraftSkill {
	/** Draft-local key ("s1", "s2", …). */
	key: string;
	/** An EXISTING skill id this IS (the identity judgment) — approval
	 *  link-appends to it instead of minting a new skill. */
	reuse?: string;
	name: string;
	statement: string;
	requires: string[];
	/** Existing proposition ids the skill rests on. */
	restsOn: string[];
	/** Where the curriculum asks for it ("Ch. 3, p. 41"). */
	cite?: string;
}

/** The planner's output, waiting for the owner's approval. */
export interface CourseDraft {
	createdAt: string;
	/** Short prose: the approach, and which skills it reused. */
	summary: string;
	/** The owner's change request this draft answered. */
	feedback?: string;
	skills: DraftSkill[];
	/** The proposed vocabulary mapping (WP5, 2026-11-25; core/coverage-items.ts): present only on a draft made while the
	 *  class glossary had core entries. Its items' `skills` are DRAFT KEYS ("s1"); approval turns them into skill ids. */
	coverage?: DraftCoverage;
}

// ─── Vocabulary coverage (WP5, 2026-11-25; core/coverage-items.ts, core/coverage-ledger.ts) ─────────────────────────

/** One cited sense of a glossary entry, for a word the class uses in two meanings: the material and the page of the
 *  occurrence that defines this sense. */
export interface CoverageSense {
	materialId: string;
	page: number;
}

/**
 * One coverage item: one class-glossary entry (by its exact id, `t_…` or `c_…`), or one cited sense of it, in exactly
 * one of two states: ASSIGNED to one or more skills (`skills`, non-empty), or EXCLUDED with a short reason (`excluded`).
 * Its key is the entry id, or `<entryId>#<materialId>:<page>` for a sense (core/coverage-items.ts itemKey; "#" never
 * appears in an entry id).
 */
export interface CoverageItem {
	entryId: string;
	sense?: CoverageSense;
	/** The entry's name when the item was made: shown when the entry is no longer in the material. */
	name: string;
	/** Assigned: the skills that owe it (skill ids on the record, draft keys in a draft). */
	skills?: string[];
	/** Excluded: why (a few words). */
	excluded?: string;
	/** Excluded by the student's "leave N terms unassigned" at approval. */
	leftAtApproval?: true;
}

/** One link decision a student made on a draft (DraftCoverage.linkEdits). */
export type CoverageLinkEdit = { link: string[] } | { unlink: string };

/** `CourseRecord.coverage`: the approved vocabulary mapping. Absent on every class approved without an indexed glossary.
 *  JSON `null` is an EXPLICIT deletion (sync keeps a mapping a side merely lacks; see core/sync-merge.ts). */
export interface CourseCoverage {
	/** ISO — when the mapping was approved, mapped or last edited. */
	updatedAt: string;
	items: CoverageItem[];
	/** Groups of item keys confirmed as ONE concept under several names (each group two or more keys, no key in two
	 *  groups): introducing or checking one satisfies the group. Unlinked suggested duplicates stay separate items. */
	links: string[][];
	/** A mapping pass's proposals that would change a decision (an exclusion, a link): shown for the student to accept one
	 *  by one; never applied by the pass itself. */
	suggested?: CoverageSuggestions;
	/** Earlier decisions an approval (or a removed skill) could not keep, with why: shown on the page after approval. */
	displaced?: CoverageDropped[];
}

/** A mapping pass's proposals awaiting the student. */
export interface CoverageSuggestions {
	excluded: Array<{ key: string; reason: string }>;
	links: string[][];
}

/** One earlier decision that could not be kept. */
export interface CoverageDropped {
	key: string;
	name: string;
	reason: string;
}

/** `CourseDraft.coverage`: the planner's proposal, validated against the real glossary (unknown ids dropped, listed). */
export interface DraftCoverage {
	items: CoverageItem[];
	links: string[][];
	/** Ids the planner named that are not in the class glossary: dropped, never invented. */
	dropped: string[];
	/** The materials whose index was incomplete when the draft was made (names). */
	incomplete: string[];
	/** How many core entries the planner was shown with their definition, by name only, and not at all (the input bound). */
	shown: { full: number; names: number; omitted: number };
	/** A mapping pass's proposals on the draft that would change a decision (see CourseCoverage.suggested). */
	suggested?: CoverageSuggestions;
	/** The class's earlier approved decisions were carried into this proposal (core/coverage-items.ts carryForward). That
	 *  carry is advice for the page: approval carries again from the approved map as it is then (review 2, finding 7). */
	carried?: true;
	/** The approved map's fingerprint when it was carried in (core/coverage-items.ts mappingFingerprint). */
	carriedFrom?: string;
	/** The item keys that came from the approved map when it was carried in. */
	carriedKeys?: string[];
	/** The item keys the student changed on this draft (assign, unassign, exclude, remove, remap): they win over the
	 *  approved map's item when approval carries again. */
	edited?: string[];
	/** The links and unlinks the student made on this draft, in order (WP5 review 3): replayed after approval carries
	 *  again, so a link stays a link and an unlink stays an unlink whatever changed on the approved map. A removed item
	 *  is recorded as an unlink of its key; a remap renames the key in the earlier entries. */
	linkEdits?: CoverageLinkEdit[];
	/** Earlier decisions the carrying could not keep, with why (moved to CourseCoverage.displaced at approval). */
	displaced?: CoverageDropped[];
}

/** One drafting run's usage (the money channel — like ExtractionRunUsage). */
export interface CourseDraftUsage {
	startedAt: number;
	at: string;
	durationMs: number;
	planner: ExtractionStageUsage;
}

export interface CourseRecord {
	/** "course_" + random. */
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	status: CourseStatus;
	/** The APPROVED skill set ([] until the first approval). */
	skills: string[];
	/** The pending planner output (cleared on approval). */
	draft?: CourseDraft;
	/** The course's language (fork addition, 2026-11-02): what the planner writes the skill map in and
	 *  what its sessions are taught in. Stamped from the default language at creation; absent (a
	 *  course made before languages) = the current default language. */
	language?: LessonLanguage;
	/** The learner's time note for this course ("exam Thursday, 4 concepts", fork addition 2026-11-01). The page no
	 *  longer edits it and the teacher no longer reads it (2026-11-14): the exam date is what a course session is
	 *  told (core/exam-plan.ts examWhen). Kept stored and synced so nothing already written is lost. */
	note?: string;
	/** The course's default pace (fork addition, 2026-11-09, core/pace.ts): stamped on sessions started from
	 *  the course (a Learn start's own pick wins). Absent = the global default (general.pace). */
	pace?: Pace;
	/** The sidebar folder this course sits in (fork addition, 2026-11-14, core/course-folders.ts): a name, one level, absent =
	 *  no folder. Case-insensitive; syncs field by field like the title. */
	folder?: string;
	/** The exam date, "YYYY-MM-DD" (fork addition, 2026-11-13, core/exam-plan.ts): the course page counts down to it and
	 *  says whether the recent pace gets through the remaining skills. */
	examDate?: string;
	/** How much the course's exams use each skill (0-3), from a "Weigh by exams" pass or the learner's own edit.
	 *  Absent skill = weight 1. Moves with the next four fields as one unit in a sync. */
	skillWeights?: SkillWeights;
	/** The weighing pass's own summary (it says when it found no past exams). */
	weightsSummary?: string;
	/** ISO — when the weighing pass last finished. */
	weightsAt?: string;
	/** How many past exams the weighing pass found and used (2026-11-14, core/exam-plan.ts examReadiness). Absent on a
	 *  weighing from before it was recorded: the readiness score then assumes DEFAULT_PAST_EXAMS. */
	pastExams?: number;
	/** Why the last weighing pass failed. */
	weightsError?: string;
	/** Why the last drafting run failed. */
	error?: string;
	/** Append-only planner usage log. */
	drafts?: CourseDraftUsage[];
	/** The approved vocabulary mapping (WP5, 2026-11-25): every core term of the class's material assigned to a skill or
	 *  excluded. Absent = the class has no coverage behaviour at all. Moves with the approval unit in a sync. */
	coverage?: CourseCoverage;
	/** Why the last "Map the class's terms" pass failed. */
	coverageError?: string;
	/** Schema stamp — lazy v1, same rule as chat records. */
	version?: number;
}

export const CURRENT_COURSE_VERSION = 1;

// ─── The session's course link (ChatRecord.course) ──────────────────────────

/** learn: a teach session aimed at one skill · practice/review/placement:
 *  practice sessions whose concluded problems move the skills' boxes ·
 *  check: the context check (owner) — a SHORT practice session
 *  on a skill the learner already has from another course, confirming it
 *  works in this one. ask: an open conversation about the class (agent/ask-agent.ts) — no skills, no
 *  questions, no grades; it is never course evidence and never feeds the knowledge graph. */
export type CourseMode = "learn" | "practice" | "review" | "placement" | "check" | "ask";

export const COURSE_MODES: readonly CourseMode[] = ["learn", "practice", "review", "placement", "check", "ask"];

/** Stamped at creation by the course-session route; never changed. */
export interface ChatCourseLink {
	courseId: string;
	mode: CourseMode;
	/** The skills the session works on. */
	skillIds: string[];
	/** A placement session that is a RETEST: it asks only about skills not learned yet and learned skills that are due
	 *  or fading before the exam, and a miss on a learned skill is a lapse (core/mastery.ts). */
	retest?: boolean;
	/** The vocabulary items LISTED to this session when it started (WP5, core/coverage-ledger.ts listVocabulary): the item
	 *  keys its prompt shows and, for a Learn session, its whole vocabulary obligation at finish. Absent: the class had no
	 *  vocabulary mapping when the session started, and the session owes none. */
	vocabulary?: string[];
}

// ─── The API payloads ───────────────────────────────────────────────────────

/** The sidebar's course row. */
export interface CourseSummary {
	id: string;
	title: string;
	status: CourseStatus;
	updatedAt: string;
	total: number;
	known: number;
	/** 0–100: the average of each skill's understanding over the known line, capped (core/mastery.ts courseProgressPercent). */
	progress: number;
	/** Skills that need review now (retrievability below the FSRS target). */
	needsReview: number;
	/** The exam date, when set. */
	examDate?: string;
	/** The sidebar folder, when the course is in one. */
	folder?: string;
}

/** What deleting some sessions takes from the courses (POST /api/courses/deletion-impact): skill progress is derived
 *  from the course sessions' transcripts (server/courses.ts courseEvidence), so it goes with them in either delete mode.
 *  Only sessions that recorded evidence count. */
export interface CourseDeletionImpact {
	/** How many of the sessions recorded course progress. */
	sessions: number;
	/** The courses they belong to; title null when the course itself is gone (its skills still lose the progress). */
	courses: Array<{ id: string; title: string | null; sessions: number }>;
	/** How many distinct skills the lost progress was about. */
	skills: number;
}

/** One line of the sidebar's Today list (GET /api/today): a course with something to do. */
export interface TodayCourse {
	courseId: string;
	title: string;
	examDate?: string;
	daysLeft?: number;
	/** Reviews due, and how many the next review takes (0 = none due). */
	reviewDue: number;
	reviewBatch: number;
	/** The lessons to take today, in order. */
	lessons: Array<{ skillId: string; name: string; weight: number }>;
}

/** One skill's state in a course view. */
export interface CourseSkillView {
	id: string;
	name: string;
	statement: string;
	requires: string[];
	/** 0–10, how long the skill lasts (core/mastery.ts); 0 = not learned. */
	understanding: number;
	/** A finished lesson or any credit; unlocks what builds on it. */
	learned: boolean;
	/** understanding ≥ KNOWN_UNDERSTANDING. */
	known: boolean;
	/** Recall now is below the FSRS target (90%). */
	needsReview: boolean;
	/** ISO — when recall reaches the target; null = not learned. */
	reviewAt: string | null;
	/** FSRS stability in days (recall falls to 90% this long after `lastReview`); null = not learned. Lets the page
	 *  compute recall now without a refetch (core/mastery.ts recallAt). */
	stability: number | null;
	/** ISO — the last review; null = not learned. */
	lastReview: string | null;
	/** The prerequisites not learned yet (locked skills). */
	missing: string[];
	/** The skill's exam weight in this course (0-3; 1 = unknown) and who set it; `priority` also counts what it unlocks. */
	weight: number;
	weightBy?: "model" | "learner";
	weightReason?: string;
	priority: number;
	/** What its last finished lesson said the learner showed and should practice (the finish_lesson summary). */
	lessonNote?: { summary: string; at: string; chatId: string };
	/** The propositions it rests on: stored links ∪ derived from Learn sessions. */
	propositions: Array<{ id: string; name: string; statement: string; sessions: Array<{ id: string; title: string }> }>;
}

/** One concluded problem's effect on its skills (GET /api/chats/[id]/rating-changes, owner 2026-11-13). */
export interface RatingChange {
	/** The conclude call's id. */
	callId: string;
	skills: Array<{ id: string; name: string; before: number; after: number; reviewAt: string | null }>;
}

/** GET /api/chats/[id]/lesson-result: the card under a finished lesson (owner, 2026-11-13). */
export interface LessonResult {
	courseId: string;
	skill: { id: string; name: string };
	understanding: number;
	learned: boolean;
	/** ISO — when recall reaches the review target. */
	reviewAt: string | null;
	summary: string | null;
	/** The next skill in the course's order, when one is ready (not this skill). */
	next: { id: string; name: string } | null;
	/** The skill's core terms (WP5): how many it owes, how many were introduced, and the names of those left for next
	 *  time. Absent when the class has no coverage or the skill owes no core term. */
	coverage?: { total: number; covered: number; left: string[]; language: LessonLanguage };
}

// ─── The coverage views (WP5, 2026-11-25; server/course-coverage.ts) ─────────────────────────────────────────────────

/** new: never introduced; introduced: named where the learner saw it, not checked; checked: introduced, and an answered
 *  question tagged it; asked: an answered question tagged it but it was never named (not introduced). */
export type CoverageTermState = "new" | "introduced" | "checked" | "asked";

/** A glossary entry as the coverage screens show it. */
export interface CoverageEntryView {
	/** The item key (entry id, or entry id + sense). */
	key: string;
	name: string;
	tier: "core" | "supporting";
	/** The material's definition (of this sense, for a sense), or null when the material uses it without defining it. */
	definition: string | null;
	page: number | null;
	/** The material the definition (or the first use) is in. */
	material: string | null;
}

export interface CoverageTermView extends CoverageEntryView {
	state: CoverageTermState;
	/** The best level an answered question on it reached, and whether any answer was graded right. */
	level?: "recall" | "apply" | "analyze" | "transfer";
	right?: boolean;
	/** The names it is linked with (one concept). */
	linked?: string[];
	/** How many finished lessons left it for later (`deferred`). */
	deferredCount?: number;
}

/** One suggested duplicate pair, side by side, for the "same thing" action. */
export interface CoverageDuplicateView {
	a: CoverageEntryView;
	b: CoverageEntryView;
	reasons: ("alias" | "plural" | "similar_name")[];
	linked: boolean;
}

/** GET /api/courses/[id]: `coverage`. */
export interface CourseCoverageView {
	/** none: the class has no indexed core term (no coverage behaviour); unmapped: it has, but no mapping was approved
	 *  (offer "Map the class's terms"); mapped: the record carries a mapping. */
	status: "none" | "unmapped" | "mapped";
	/** A "Map the class's terms" pass is running. */
	mapping: boolean;
	error?: string;
	language: LessonLanguage;
	/** Per approved skill: its terms with their state, core first. */
	skills: Record<string, { total: number; introduced: number; checked: number; terms: CoverageTermView[] }>;
	/** Core entries of the glossary with no item (new since approval, or never mapped). */
	unassigned: CoverageEntryView[];
	/** Items whose entry (or sense) is no longer in the material: they count toward nothing until removed or remapped. */
	flagged: Array<{ key: string; name: string; skills: string[] }>;
	excluded: Array<{ key: string; name: string; reason: string }>;
	/** A mapping pass's proposals awaiting the student, one by one. */
	suggested?: { excluded: Array<{ key: string; name: string; reason: string }>; links: Array<{ keys: string[]; names: string[] }> };
	/** Earlier decisions the last approval (or a removed skill) could not keep, with why. */
	displaced?: CoverageDropped[];
	/** Materials whose index is missing or out of date. */
	incomplete: string[];
	/** The pending draft's proposal, for the approval screen. */
	draft?: {
		/** The draft carries no proposal yet (indexing finished after drafting): every core term is unassigned. */
		empty?: boolean;
		/** Per draft key: its terms. */
		skills: Record<string, CoverageEntryView[]>;
		unassigned: CoverageEntryView[];
		excluded: Array<{ key: string; name: string; reason: string }>;
		duplicates: CoverageDuplicateView[];
		dropped: string[];
		incomplete: string[];
		shown: DraftCoverage["shown"];
		suggested?: { excluded: Array<{ key: string; name: string; reason: string }>; links: Array<{ keys: string[]; names: string[] }> };
		/** Earlier decisions the draft could not carry, with why. */
		displaced?: CoverageDropped[];
	};
}

/** One open missed problem on the course page (owner, 2026-11-16). */
export interface MissedProblemView {
	id: string;
	/** ISO — when the problem was concluded. */
	at: string;
	statement: string;
	/** "gave up", "moved on", "was taught the answer", "needed hints" */
	how: string;
	skills: Array<{ id: string; name: string }>;
}

/** GET /api/courses/[id]. */
export interface CourseView {
	course: CourseRecord;
	/** Every approved skill, in topological order (prerequisites first). */
	skills: CourseSkillView[];
	/** Ids, topological order. */
	review: string[];
	/** How many of `review` the next Review session takes (the session cap). */
	reviewBatch: number;
	/** Not learned, prerequisites learned — what to learn next, by exam priority (core/exam-plan.ts). */
	nextUp: string[];
	/** Next-up skills the exams never use and that unlock nothing examined (weight 0): kept apart, still learnable. */
	notExamined: string[];
	/** The exam countdown, forecast and today's lessons. */
	plan: CoursePlan;
	/** Learned, not known yet — what to practice. */
	learning: string[];
	locked: string[];
	known: string[];
	/** Learned or known from ANOTHER course, never yet shown in this one —
	 *  offered a short context check, never forced (they also stay in
	 *  `known` / `learning`, which the counts read). */
	contextCheck: string[];
	/** Open missed problems, newest first (core/missed-problems.ts): problems given up, moved on from, taught or solved only
	 *  with hints, not yet followed by a clean solve of a problem covering the same skills. At most 20. */
	missed?: MissedProblemView[];
	/** Course sessions, newest first. `finished`: a Learn session's finish. */
	sessions: Array<{ id: string; title: string; mode: CourseMode; updatedAt: string; finished?: boolean }>;
	/** Existing skills a draft reuses, by id (to show their names). */
	reused: Record<string, { name: string; statement: string }>;
	/** The class's vocabulary coverage (WP5). Absent when the class has no indexed core term and no mapping. */
	coverage?: CourseCoverageView;
}
