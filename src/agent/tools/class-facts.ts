/**
 * The Short question agent's class tools (WP8, 2026-11-25; WP9 the same day; docs/courses.md "Quizzes, exams and what
 * you say you know" and "Lectures and where you stand"). The learner states a fact about the class ("quiz 3 is next
 * Friday, chapters 4 and 5", "we covered chapter 6 today", "the chain rule won't be on the exam") or about themselves
 * ("I don't get the chain rule"), and the agent writes it straight away; each write returns a `change` the transcript
 * shows as a card with Undo (components/class-change-card.tsx). These are the ONLY Ask tools that change anything, and a
 * self-report is the only way an Ask conversation reaches understanding (core/mastery.ts applySelfReports): never graded
 * evidence.
 *
 *   assessments_list              the class's assessments (ids, dates, topics, skills), its skills with ids, and today
 *   assessment_save               add one, or change one by id (or the one matching kind and title); `allSkills` for a
 *                                 cumulative one
 *   assessment_remove             delete one by id
 *   assessments_find_in_syllabus  start the syllabus pass; its proposal waits for approval on the class page
 *   record_self_report            "I know / I'm not sure about / I don't get" these skills
 *   WP9:
 *   lectures_list                 the lecture timeline (ids, numbers, dates, topics, skills, files) and where the class is
 *   lecture_save                  add a lecture, or change one by id or by number (a moved date, its topics, its skills)
 *   lecture_remove                delete one by id
 *   class_position_set            how far the class has got ("we're on lecture 9", "we covered chapter 6"), or back to
 *                                 the lecture dates
 *   skill_weights_set             how much the exams use each skill, 0-3 (set by the learner)
 *   class_update                  one class setting: title, language, pace or folder
 *   class_overview                READ-ONLY: where the learner stands (the class page's card) and each upcoming
 *                                 assessment's readiness ("am I ready for Friday?")
 *
 * Grouping: the four class settings are one tool with a typed `field` (they are one-value edits with the same shape);
 * lectures and the position keep their own tools, as assessments do, because their inputs differ. What Short question
 * may NOT do has no tool at all: deleting the class or its files, approving or re-drafting the skill map, and anything
 * in Settings outside the class (the prompt says where on the page those are).
 *
 * The writes go through a port (server/class-changes.ts classFactsPort) so the agent layer never touches a store. Dates
 * the learner says are resolved here, against today in the learner's time zone (core/assessments.ts readLearnerDate).
 * Ambiguity is refused with a message telling the agent to ask: two items match, no date for a new assessment, a date
 * that cannot be read, words that admit two dates ("next Friday" on a Wednesday: "Friday 27 Nov or Friday 4 Dec?").
 */

import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	ASSESSMENT_KINDS,
	dateWithWeekday,
	readLearnerDate,
	sameTitle,
	SELF_REPORT_STANCES,
	todayLine,
	type Assessment,
	type SelfReport,
} from "../../core/assessments.ts";
import type { AssessmentReadiness, ClassPosition, Lecture, LectureView, StandingView } from "../../core/lectures.ts";
import { daysUntil } from "../../core/exam-plan.ts";

/** "Friday 27 Nov" for the question the agent asks. */
function spokenDate(date: string): string {
	const [y, m, d] = date.split("-").map(Number) as [number, number, number];
	const t = new Date(Date.UTC(y, m - 1, d));
	return `${t.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" })} ${d} ${t.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })}`;
}

export const ASSESSMENTS_LIST_TOOL = "assessments_list";
export const ASSESSMENT_SAVE_TOOL = "assessment_save";
export const ASSESSMENT_REMOVE_TOOL = "assessment_remove";
export const ASSESSMENTS_FIND_TOOL = "assessments_find_in_syllabus";
export const SELF_REPORT_TOOL = "record_self_report";
export const LECTURES_LIST_TOOL = "lectures_list";
export const LECTURE_SAVE_TOOL = "lecture_save";
export const LECTURE_REMOVE_TOOL = "lecture_remove";
export const CLASS_POSITION_TOOL = "class_position_set";
export const SKILL_WEIGHTS_TOOL = "skill_weights_set";
export const CLASS_UPDATE_TOOL = "class_update";
export const CLASS_OVERVIEW_TOOL = "class_overview";

/** The tools whose result carries a change card (and an Undo). */
export const CLASS_CHANGE_TOOLS: readonly string[] = [ASSESSMENT_SAVE_TOOL, ASSESSMENT_REMOVE_TOOL, SELF_REPORT_TOOL, LECTURE_SAVE_TOOL, LECTURE_REMOVE_TOOL, CLASS_POSITION_TOOL, SKILL_WEIGHTS_TOOL, CLASS_UPDATE_TOOL];

/** The class settings Short question may change (one tool, a typed field). */
export const CLASS_FIELDS = ["title", "language", "pace", "folder"] as const;
export type ClassField = (typeof CLASS_FIELDS)[number];

/** A skill's weight entry as stored (null: none, so it counts as 1). */
export type WeightEntry = { w: 0 | 1 | 2 | 3; by: "model" | "learner"; reason?: string } | null;

/** One change, as the card shows it and Undo reads it (server/class-changes.ts undoClassChange). */
export type ClassChange =
	| {
			kind: "assessment";
			courseId: string;
			action: "added" | "updated" | "removed";
			before: Assessment | null;
			after: Assessment | null;
			/** The entry written, and its stamp: Undo is offered while the list still holds exactly this. */
			id: string;
			stamp: string;
			skillNames: string[];
	  }
	| { kind: "self-report"; courseId: string; report: SelfReport; skillNames: string[] }
	| {
			kind: "lecture";
			courseId: string;
			action: "added" | "updated" | "removed";
			before: Lecture | null;
			after: Lecture | null;
			id: string;
			stamp: string;
			/** It was read from the class's files before: Undo returns it to that. */
			fromFiles?: true;
			skillNames: string[];
	  }
	| {
			kind: "position";
			courseId: string;
			before: ClassPosition | null;
			after: ClassPosition | null;
			/** The lecture titles, for the card. */
			label: string | null;
			beforeLabel: string | null;
	  }
	| { kind: "weights"; courseId: string; before: Record<string, WeightEntry>; after: Record<string, WeightEntry>; names: Record<string, string> }
	| { kind: "setting"; courseId: string; field: ClassField; before: string | null; after: string | null };

/** What a save may carry (fields present = fields changed). */
export interface ClassFactsSaveInput {
	kind?: string;
	title?: string;
	date?: string | null;
	topics?: string;
	skillIds?: string[];
}

export interface LectureSaveInput {
	n?: number | null;
	title?: string;
	date?: string | null;
	topics?: string;
	skillIds?: string[];
}

type Out = { ok: true; change: ClassChange } | { ok: false; error: string };

/** "Where you stand" as the overview tool reads it. */
export interface ClassOverview {
	standing: StandingView | null;
	/** The upcoming dated assessments (at most 3), each with its readiness. */
	upcoming: AssessmentReadiness[];
	names: Record<string, string>;
}

export interface ClassFactsPort {
	now(): number;
	/** The learner's time zone (the client's), or undefined for the machine's own. */
	timeZone(): string | undefined;
	hasSkills(): boolean;
	list(): { assessments: Assessment[]; skills: Array<{ id: string; name: string }> };
	save(id: string | undefined, input: ClassFactsSaveInput): Out;
	remove(id: string): Out;
	selfReport(input: { skillIds: string[]; stance: string; note: string }): Out;
	findInSyllabus(): { ok: true } | { ok: false; error: string };
	// WP9 (optional in the type so a WP8-only port still builds the WP8 tools)
	lectures?(): { lectures: LectureView[]; position: StandingView["position"]; files: Record<string, string>; skills: Array<{ id: string; name: string }> };
	saveLecture?(id: string | undefined, input: LectureSaveInput): Out;
	removeLecture?(id: string): Out;
	setPosition?(input: { lectureId?: string; coveredThrough?: string; note?: string } | null): Out;
	setWeights?(edits: Record<string, number | null>): Out;
	update?(field: ClassField, value: string | null): Out;
	overview?(): ClassOverview;
}

function text(t: string, details?: unknown): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: t }], details: details ?? null };
}

function refuse(t: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: t }], details: { refused: t }, isError: true } as AgentToolResult<unknown>;
}

function line(a: Assessment, names: ReadonlyMap<string, string>): string {
	const skills = a.skillIds.length > 0 ? ` · skills: ${a.skillIds.map((id) => `${names.get(id) ?? id} [${id}]`).join(", ")}` : "";
	return `- [${a.id}] ${a.title} (${a.kind}) · ${a.date ? dateWithWeekday(a.date) : "no date"}${a.topics ? ` · topics: ${a.topics}` : ""}${skills}${a.legacy ? " · (the class's exam date)" : ""}`;
}

const CARD = "The learner sees it as a card with Undo; state it in one short sentence.";

function changeLine(change: ClassChange): string {
	switch (change.kind) {
		case "self-report":
			return `Recorded: "${change.report.stance}" for ${change.skillNames.join(", ")}. The learner sees it as a card with Undo.`;
		case "assessment": {
			const a = change.after ?? change.before!;
			const when = a.date ? dateWithWeekday(a.date) : "no date";
			return `${change.action === "added" ? "Added" : change.action === "updated" ? "Updated" : "Removed"}: ${a.title} (${a.kind}), ${when}${a.topics ? `, topics: ${a.topics}` : ""}. ${CARD}`;
		}
		case "lecture": {
			const l = change.after ?? change.before!;
			return `${change.action === "added" ? "Added" : change.action === "updated" ? "Updated" : "Removed"} lecture: ${l.title}, ${l.date ? dateWithWeekday(l.date) : "no date"}${l.topics ? `, topics: ${l.topics}` : ""}${change.skillNames.length > 0 ? `, skills: ${change.skillNames.join(", ")}` : ""}. ${CARD}`;
		}
		case "position":
			return change.after
				? `Set: the class is at ${change.label ?? "(no lecture)"}${change.after.coveredThrough ? `, covered ${change.after.coveredThrough}` : ""}${change.after.note ? ` (${change.after.note})` : ""}. ${CARD}`
				: `Cleared: the class position follows the lecture dates again. ${CARD}`;
		case "weights":
			return `Set exam weights: ${Object.entries(change.after)
				.map(([id, e]) => `${change.names[id] ?? id} ${e ? e.w : "default"}`)
				.join(", ")}. ${CARD}`;
		case "setting":
			return `Changed the class's ${change.field}: ${change.before ?? "(none)"} → ${change.after ?? "(none)"}. ${CARD}`;
	}
}

/** One date the learner said, or a refusal telling the agent to ask. */
function resolveDate(raw: string, port: ClassFactsPort): { date: string } | { refused: AgentToolResult<unknown> } {
	const read = readLearnerDate(raw, port.now(), port.timeZone());
	if (read.kind === "unreadable") return { refused: refuse(`Could not read the date "${raw}". Ask the learner for the date (a weekday, "next Friday" or a calendar date), then save again.`) };
	if (read.kind === "ambiguous") {
		const [a, b] = read.options.map(spokenDate) as [string, string];
		return { refused: refuse(`Ambiguous: "${raw}" could be ${a} or ${b}. Nothing was saved. Ask the learner in one short question: "${a} or ${b}?", then save again with the date as YYYY-MM-DD.`) };
	}
	return { date: read.date };
}

const listInput = Type.Object({});

const DATE_WORDS = "as YYYY-MM-DD or in the learner's words, keeping their \"this\" or \"next\": \"today\", \"tomorrow\", \"Friday\", \"this Friday\", \"next Friday\", \"Friday next week\", \"in 2 weeks\", \"12 March\". Resolved against today in the learner's time zone; refused as ambiguous when the words admit two dates.";

const saveInput = Type.Object({
	id: Type.Optional(Type.String({ description: "The id of the assessment to change, from assessments_list. Leave out to add one (or to change the one with the same kind and title)." })),
	kind: Type.Optional(Type.String({ enum: [...ASSESSMENT_KINDS], description: "quiz, exam, midterm, final, assignment or other (required to add)" })),
	title: Type.Optional(Type.String({ description: "As the learner names it: \"Quiz 3\", \"Midterm\" (required to add)" })),
	date: Type.Optional(Type.String({ description: `When, ${DATE_WORDS}` })),
	noDate: Type.Optional(Type.Boolean({ description: "true only when the learner said the date is not known yet (adding without a date is refused otherwise)" })),
	clearDate: Type.Optional(Type.Boolean({ description: "true to remove the date of an existing one" })),
	topics: Type.Optional(Type.String({ description: "What it covers, in the learner's words (\"chapters 4 and 5\"). This REPLACES the topics: to add to them (\"also covers chapter 6\"), pass the old topics with the new." })),
	skillIds: Type.Optional(Type.Array(Type.String(), { description: "The class's skill ids (from assessments_list) the topics clearly cover; leave out or [] when unclear. Replaces the list: to add, pass the old ids with the new." })),
	allSkills: Type.Optional(Type.Boolean({ description: "true when the learner says it covers the whole class (\"the final is cumulative\"): every skill on the map" })),
});

const removeInput = Type.Object({ id: Type.String({ description: "The id from assessments_list" }) });

const selfReportInput = Type.Object({
	skillIds: Type.Array(Type.String(), { minItems: 1, description: "The skill ids (from assessments_list) the learner's words are about" }),
	stance: Type.String({ enum: [...SELF_REPORT_STANCES], description: "know: they already know it · shaky: they are not sure about it · dont_know: they do not get it" }),
	note: Type.String({ description: "The learner's words, short" }),
});

const lectureSaveInput = Type.Object({
	id: Type.Optional(Type.String({ description: "The id of the lecture to change, from lectures_list. Leave out to add one, or to change the one with the same number (n)." })),
	n: Type.Optional(Type.Integer({ minimum: 0, maximum: 999, description: "Its number in the class (\"lecture 9\" → 9)" })),
	title: Type.Optional(Type.String({ description: "As the learner names it (\"Lecture 9: Eigenvalues\"); defaults to \"Lecture <n>\"" })),
	date: Type.Optional(Type.String({ description: `When, ${DATE_WORDS}` })),
	clearDate: Type.Optional(Type.Boolean({ description: "true to remove its date" })),
	topics: Type.Optional(Type.String({ description: "What it covers, in the learner's words. Replaces the topics: to add, pass the old with the new." })),
	skillIds: Type.Optional(Type.Array(Type.String(), { description: "The skill ids it teaches (from lectures_list). Replaces the list: to add, pass the old ids with the new." })),
});

const lectureRemoveInput = Type.Object({ id: Type.String({ description: "The id from lectures_list" }) });

const positionInput = Type.Object({
	lectureId: Type.Optional(Type.String({ description: "The lecture the class is at (the last one it has had), from lectures_list" })),
	lectureNumber: Type.Optional(Type.Integer({ minimum: 0, maximum: 999, description: "Or its number (\"we're on lecture 9\" → 9)" })),
	coveredThrough: Type.Optional(Type.String({ description: "What the class has covered, in the learner's words (\"chapter 6\")" })),
	note: Type.Optional(Type.String({ description: "Anything else they said about it (\"a week behind the syllabus\")" })),
	followSchedule: Type.Optional(Type.Boolean({ description: "true to forget what was said and follow the lecture dates again" })),
});

const weightsInput = Type.Object({
	weights: Type.Array(
		Type.Object({
			skillId: Type.String({ description: "A skill id from lectures_list or assessments_list" }),
			weight: Type.Union([Type.Integer({ minimum: 0, maximum: 3 }), Type.Null()], { description: "0 never on the exam · 1 sometimes · 2 often · 3 nearly always; null clears it (back to 1)" }),
		}),
		{ minItems: 1 },
	),
});

const updateInput = Type.Object({
	field: Type.String({ enum: [...CLASS_FIELDS], description: "title, language (en or nb), pace (thorough, efficient or crash) or folder (a sidebar folder name)" }),
	value: Type.Union([Type.String(), Type.Null()], { description: "The new value; null clears pace (back to the default) or takes the class out of its folder" }),
});

function lectureLine(l: LectureView, names: ReadonlyMap<string, string>, files: Readonly<Record<string, string>>, position: StandingView["position"]): string {
	const skills = l.skillIds.length > 0 ? ` · skills: ${l.skillIds.map((id) => `${names.get(id) ?? id} [${id}]`).join(", ")}` : " · skills: none placed";
	const fileNames = l.materialIds.map((m) => files[m]).filter(Boolean);
	return `- [${l.id}] ${l.title}${l.n !== undefined ? ` (n ${l.n})` : ""} · ${l.date ? dateWithWeekday(l.date) : "no date"}${l.topics ? ` · topics: ${l.topics}` : ""}${skills}${fileNames.length > 0 ? ` · files: ${fileNames.join(", ")}` : ""}${l.derived ? " · (read from the file names)" : ""}${position?.lectureId === l.id ? " · ← the class is here" : ""}`;
}

function positionLine(position: StandingView["position"]): string {
	if (!position) return "The class position: unknown (no lecture dated on or before today, no lecture with a file, and the learner has not said).";
	const how = position.how === "explicit" ? `the learner said so${position.at ? ` on ${position.at.slice(0, 10)}` : ""}` : position.how === "dated" ? "from the lecture dates" : "the highest-numbered lecture with a file";
	return `The class is at ${position.label ?? "(no lecture)"}${position.date ? `, ${dateWithWeekday(position.date)}` : ""}${position.coveredThrough ? `, covered ${position.coveredThrough}` : ""}${position.note ? ` (${position.note})` : ""} — ${how}.`;
}

function readinessLine(r: AssessmentReadiness, names: Readonly<Record<string, string>>, lectureTitle: (id: string) => string, now: number): string {
	const days = daysUntil(r.date, now);
	const head = `${r.title} (${r.kind}) · ${dateWithWeekday(r.date)} · ${days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`}`;
	if (!r.needs) return `${head} · what it needs is not known (it lists no skills and no lecture before it has skills placed).`;
	const missing = r.missing.map((m) => `${names[m.skillId] ?? m.skillId}${m.lectureIds.length > 0 ? ` (${m.lectureIds.map(lectureTitle).join(", ")})` : ""}`);
	return `${head} · needs ${r.needs.length} skill${r.needs.length === 1 ? "" : "s"}${r.basis === "lectures" ? " (those of the lectures before it)" : ""}: ${r.learned.length} learned${r.learned.length > 0 ? ` (${r.learned.map((id) => names[id] ?? id).join(", ")})` : ""}, ${r.missing.length} not yet${missing.length > 0 ? `: ${missing.join(", ")}` : ""}.`;
}

/** The Ask agent's class tools over a port. `record_self_report` only when the class has an approved skill map; the WP9
 *  tools when the port offers them (skill weights only with a map). */
export function classFactsTools(port: ClassFactsPort): Record<string, AgentTool<any>> {
	const list: AgentTool<typeof listInput> = {
		name: ASSESSMENTS_LIST_TOOL,
		label: ASSESSMENTS_LIST_TOOL,
		description:
			"List the class's quizzes, exams and assignments (ids, dates, topics, mapped skills), the class's skills with their ids, and today's date. Call it before changing or removing one, and to find skill ids.",
		parameters: listInput,
		execute: async () => {
			const { assessments, skills } = port.list();
			const names = new Map(skills.map((s) => [s.id, s.name]));
			const today = todayLine(port.now(), port.timeZone());
			return text(
				[
					`Today: ${today.weekday} ${today.date}.`,
					assessments.length > 0 ? `Assessments:\n${assessments.map((a) => line(a, names)).join("\n")}` : "Assessments: none yet.",
					skills.length > 0 ? `Skills (id :: name):\n${skills.map((s) => `- ${s.id} :: ${s.name}`).join("\n")}` : "The class has no approved skill map yet: no skill ids.",
				].join("\n\n"),
			);
		},
	};

	const save: AgentTool<typeof saveInput> = {
		name: ASSESSMENT_SAVE_TOOL,
		label: ASSESSMENT_SAVE_TOOL,
		description:
			"Add a quiz, exam or assignment the learner told you about, or change one (by id, or the one with the same kind and title): a moved date, what it covers, its skills, or that it covers everything (allSkills). Write it as soon as they state it; do not ask them to confirm. " +
			"It is refused when the fact is ambiguous (two match, no date for a new one, a date that cannot be read): then ask the learner, in one short question.",
		parameters: saveInput,
		execute: async (_id, input: Static<typeof saveInput>) => {
			let date: string | null | undefined;
			if (input.clearDate) date = null;
			else if (input.date !== undefined && input.date.trim() !== "") {
				const read = resolveDate(input.date, port);
				if ("refused" in read) return read.refused;
				date = read.date;
			}
			let id = input.id;
			const { assessments, skills } = port.list();
			if (id !== undefined && !assessments.some((a) => a.id === id)) return refuse(`No assessment has the id "${id}". Call assessments_list for the ids.`);
			if (id === undefined) {
				if (!input.kind || !input.title?.trim()) return refuse("To add an assessment give its kind and title (and its date). To change one, give its id from assessments_list.");
				// a title with no letters or numbers matches nothing (review 1, finding 11)
				const same = assessments.filter((a) => a.kind === input.kind && sameTitle(a.title, input.title!));
				if (same.length > 1) {
					return refuse(`Ambiguous: ${same.length} assessments match "${input.title}" (${same.map((a) => `[${a.id}] ${a.title}, ${a.date ?? "no date"}`).join("; ")}). Nothing was saved. Ask the learner which one they mean.`);
				}
				if (same.length === 1) id = same[0]!.id;
				else if (date === undefined && !input.noDate) {
					return refuse(`No date for "${input.title}". Nothing was saved. Ask the learner when it is (or, if they said it is not known yet, save again with noDate: true).`);
				}
			}
			if (input.allSkills && skills.length === 0) return refuse("The class has no approved skill map yet, so there are no skills to cover. Save it without allSkills.");
			const fields = {
				...(input.kind ? { kind: input.kind } : {}),
				...(input.title?.trim() ? { title: input.title } : {}),
				...(date !== undefined ? { date } : {}),
				...(input.topics !== undefined ? { topics: input.topics } : {}),
				...(input.allSkills ? { skillIds: skills.map((s) => s.id) } : input.skillIds !== undefined ? { skillIds: input.skillIds } : {}),
			};
			const out = port.save(id, fields);
			if (!out.ok) return refuse(`Not saved: ${out.error}.`);
			return text(changeLine(out.change), { change: out.change });
		},
	};

	const remove: AgentTool<typeof removeInput> = {
		name: ASSESSMENT_REMOVE_TOOL,
		label: ASSESSMENT_REMOVE_TOOL,
		description: "Delete a quiz, exam or assignment the learner says is cancelled or wrong, by its id from assessments_list. When two could be meant, ask first.",
		parameters: removeInput,
		execute: async (_id, input: Static<typeof removeInput>) => {
			const out = port.remove(input.id);
			if (!out.ok) return refuse(`Not removed: ${out.error}. Call assessments_list for the ids.`);
			return text(changeLine(out.change), { change: out.change });
		},
	};

	const find: AgentTool<typeof listInput> = {
		name: ASSESSMENTS_FIND_TOOL,
		label: ASSESSMENTS_FIND_TOOL,
		description:
			"Start reading the class's syllabus for its quizzes, exams and lecture schedule, when the learner asks for it (\"check the syllabus for exam dates\"). It runs in the background; what it finds waits for the learner's approval under Upcoming on the class page. Tell them that.",
		parameters: listInput,
		execute: async () => {
			const out = port.findInSyllabus();
			if (!out.ok) return refuse(`Not started: ${out.error}.`);
			return text("Started. What it finds will be listed under Upcoming on the class page, for the learner to approve, drop or edit; nothing is added before that. Tell the learner where to look, in one sentence.", { started: true });
		},
	};

	const selfReport: AgentTool<typeof selfReportInput> = {
		name: SELF_REPORT_TOOL,
		label: SELF_REPORT_TOOL,
		description:
			"Record what the learner says about their own grasp of some of the class's skills: \"I already know X\" (know), \"I'm not sure about Y\" (shaky), \"I don't get Z\" (dont_know). Only skills on the class's map (ids from assessments_list), mapped from their words; only when they say it, never as a question. " +
			"It moves their plan a little (know: a short check soon; dont_know: it comes first; shaky: an earlier review); real practice results always win.",
		parameters: selfReportInput,
		execute: async (_id, input: Static<typeof selfReportInput>) => {
			const out = port.selfReport({ skillIds: input.skillIds, stance: input.stance, note: input.note });
			if (!out.ok) return refuse(`Not recorded: ${out.error}. Call assessments_list for the skill ids.`);
			return text(changeLine(out.change), { change: out.change });
		},
	};

	const tools: Record<string, AgentTool<any>> = {
		[ASSESSMENTS_LIST_TOOL]: list,
		[ASSESSMENT_SAVE_TOOL]: save,
		[ASSESSMENT_REMOVE_TOOL]: remove,
		[ASSESSMENTS_FIND_TOOL]: find,
		...(port.hasSkills() ? { [SELF_REPORT_TOOL]: selfReport } : {}),
	};

	// ─── WP9 ───────────────────────────────────────────────────────────────
	const { lectures, saveLecture, removeLecture, setPosition, setWeights, update, overview } = port;
	if (lectures && saveLecture && removeLecture && setPosition) {
		tools[LECTURES_LIST_TOOL] = {
			name: LECTURES_LIST_TOOL,
			label: LECTURES_LIST_TOOL,
			description:
				"List the class's lectures in order (ids, numbers, dates, topics, the skills each teaches, its files), where the class is now, the class's skills with ids, and today. Call it before changing a lecture or the class position.",
			parameters: listInput,
			execute: async () => {
				const l = lectures();
				const names = new Map(l.skills.map((s) => [s.id, s.name]));
				const today = todayLine(port.now(), port.timeZone());
				return text(
					[
						`Today: ${today.weekday} ${today.date}.`,
						positionLine(l.position),
						l.lectures.length > 0 ? `Lectures:\n${l.lectures.map((x) => lectureLine(x, names, l.files, l.position)).join("\n")}` : "Lectures: none yet.",
						l.skills.length > 0 ? `Skills (id :: name):\n${l.skills.map((s) => `- ${s.id} :: ${s.name}`).join("\n")}` : "The class has no approved skill map yet: no skill ids.",
					].join("\n\n"),
				);
			},
		} satisfies AgentTool<typeof listInput>;

		tools[LECTURE_SAVE_TOOL] = {
			name: LECTURE_SAVE_TOOL,
			label: LECTURE_SAVE_TOOL,
			description:
				"Add a lecture the learner tells you about, or change one (by id, or the one with the same number): \"lecture 9 got moved to Thursday\", \"lecture 4 was on eigenvalues\", which skills a lecture teaches. Write it at once, without asking to confirm. Refused when the date cannot be read or admits two dates: then ask, in one short question.",
			parameters: lectureSaveInput,
			execute: async (_id, input: Static<typeof lectureSaveInput>) => {
				let date: string | null | undefined;
				if (input.clearDate) date = null;
				else if (input.date !== undefined && input.date.trim() !== "") {
					const read = resolveDate(input.date, port);
					if ("refused" in read) return read.refused;
					date = read.date;
				}
				const all = lectures().lectures;
				let id = input.id;
				if (id !== undefined && !all.some((l) => l.id === id)) return refuse(`No lecture has the id "${id}". Call lectures_list for the ids.`);
				if (id === undefined && input.n !== undefined) {
					const same = all.filter((l) => l.n === input.n);
					if (same.length > 1) return refuse(`Ambiguous: ${same.length} lectures have number ${input.n} (${same.map((l) => `[${l.id}] ${l.title}`).join("; ")}). Nothing was saved. Ask the learner which one they mean.`);
					if (same.length === 1) id = same[0]!.id;
				}
				if (id === undefined && input.n === undefined && !input.title?.trim()) return refuse("To add a lecture give its number or title. To change one, give its id from lectures_list.");
				const fields: LectureSaveInput = {
					...(input.n !== undefined ? { n: input.n } : {}),
					...(input.title?.trim() ? { title: input.title } : {}),
					...(date !== undefined ? { date } : {}),
					...(input.topics !== undefined ? { topics: input.topics } : {}),
					...(input.skillIds !== undefined ? { skillIds: input.skillIds } : {}),
				};
				const out = saveLecture(id, fields);
				if (!out.ok) return refuse(`Not saved: ${out.error}.`);
				return text(changeLine(out.change), { change: out.change });
			},
		} satisfies AgentTool<typeof lectureSaveInput>;

		tools[LECTURE_REMOVE_TOOL] = {
			name: LECTURE_REMOVE_TOOL,
			label: LECTURE_REMOVE_TOOL,
			description: "Delete a lecture the learner says is cancelled or wrong, by its id from lectures_list (one read from the file names too: it stays removed). When two could be meant, ask first.",
			parameters: lectureRemoveInput,
			execute: async (_id, input: Static<typeof lectureRemoveInput>) => {
				const out = removeLecture(input.id);
				if (!out.ok) return refuse(`Not removed: ${out.error}. Call lectures_list for the ids.`);
				return text(changeLine(out.change), { change: out.change });
			},
		} satisfies AgentTool<typeof lectureRemoveInput>;

		tools[CLASS_POSITION_TOOL] = {
			name: CLASS_POSITION_TOOL,
			label: CLASS_POSITION_TOOL,
			description:
				"Record how far the CLASS has got (not the learner) when the learner says it: \"we're on lecture 9\" (lectureNumber), \"we covered chapter 6 today\" (coveredThrough, plus the lecture whose topics clearly hold it), \"the class is a week behind the syllabus\" (the lecture the dates put a week earlier, and a note). followSchedule goes back to the lecture dates. Write it at once.",
			parameters: positionInput,
			execute: async (_id, input: Static<typeof positionInput>) => {
				if (input.followSchedule) {
					const out = setPosition(null);
					if (!out.ok) return refuse(`Not changed: ${out.error}.`);
					return text(changeLine(out.change), { change: out.change });
				}
				let lectureId = input.lectureId;
				const all = lectures().lectures;
				if (lectureId !== undefined && !all.some((l) => l.id === lectureId)) return refuse(`No lecture has the id "${lectureId}". Call lectures_list for the ids.`);
				if (lectureId === undefined && input.lectureNumber !== undefined) {
					const same = all.filter((l) => l.n === input.lectureNumber);
					if (same.length === 0) return refuse(`No lecture has number ${input.lectureNumber}. Add it first with lecture_save (n ${input.lectureNumber}), or give what the class covered as coveredThrough.`);
					if (same.length > 1) return refuse(`Ambiguous: ${same.length} lectures have number ${input.lectureNumber}. Ask the learner which one they mean.`);
					lectureId = same[0]!.id;
				}
				if (!lectureId && !input.coveredThrough?.trim() && !input.note?.trim()) return refuse("Give the lecture (lectureId or lectureNumber), what the class covered (coveredThrough), or a note.");
				const out = setPosition({ ...(lectureId ? { lectureId } : {}), ...(input.coveredThrough ? { coveredThrough: input.coveredThrough } : {}), ...(input.note ? { note: input.note } : {}) });
				if (!out.ok) return refuse(`Not saved: ${out.error}.`);
				return text(changeLine(out.change), { change: out.change });
			},
		} satisfies AgentTool<typeof positionInput>;
	}

	if (setWeights && port.hasSkills()) {
		tools[SKILL_WEIGHTS_TOOL] = {
			name: SKILL_WEIGHTS_TOOL,
			label: SKILL_WEIGHTS_TOOL,
			description:
				"Set how much the class's exams use some skills, when the learner says so: \"the chain rule won't be on the exam\" (0), \"the final is mostly integration\" (3 for the integration skills). 0 never · 1 sometimes · 2 often · 3 nearly always; null clears one. Only the skills their words are about. It marks them as set by the learner (a later \"Weigh by exams\" keeps them).",
			parameters: weightsInput,
			execute: async (_id, input: Static<typeof weightsInput>) => {
				const edits: Record<string, number | null> = {};
				for (const w of input.weights) edits[w.skillId] = w.weight;
				const out = setWeights(edits);
				if (!out.ok) return refuse(`Not saved: ${out.error}. Call lectures_list or assessments_list for the skill ids.`);
				return text(changeLine(out.change), { change: out.change });
			},
		} satisfies AgentTool<typeof weightsInput>;
	}

	if (update) {
		tools[CLASS_UPDATE_TOOL] = {
			name: CLASS_UPDATE_TOOL,
			label: CLASS_UPDATE_TOOL,
			description:
				"Change one class setting when the learner asks: its title, its language (en or nb: what the next skill-map draft and new sessions are written in), its default pace (thorough, efficient or crash), or its sidebar folder. One field per call.",
			parameters: updateInput,
			execute: async (_id, input: Static<typeof updateInput>) => {
				if (!(CLASS_FIELDS as readonly string[]).includes(input.field)) return refuse(`Not changed: "${input.field}" is not a class setting Short question can change (${CLASS_FIELDS.join(", ")}).`);
				const out = update(input.field as ClassField, input.value);
				if (!out.ok) return refuse(`Not changed: ${out.error}.`);
				return text(changeLine(out.change), { change: out.change });
			},
		} satisfies AgentTool<typeof updateInput>;
	}

	if (overview) {
		tools[CLASS_OVERVIEW_TOOL] = {
			name: CLASS_OVERVIEW_TOOL,
			label: CLASS_OVERVIEW_TOOL,
			description:
				"Read where the learner stands (the class page's \"Where you stand\"): where the class is, what the learner has learned of it, whether they are behind, and each upcoming assessment's readiness. Read-only. Use it for \"what should I know by now?\" and \"am I ready for Friday?\".",
			parameters: listInput,
			execute: async () => {
				const o = overview();
				const today = todayLine(port.now(), port.timeZone());
				const s = o.standing;
				if (!s) return text(`Today: ${today.weekday} ${today.date}.\n\nThe class has no approved skill map yet, so there is nothing to stand on: the learner drafts and approves it on the class page first.`);
				const titleOf = (id: string) => s.lectures.find((l) => l.id === id)?.title ?? id;
				const names = o.names;
				return text(
					[
						`Today: ${today.weekday} ${today.date}.`,
						positionLine(s.position),
						s.learnedThrough ? `The learner has learned what ${s.learnedThrough.label} cover${/^Lectures|–/.test(s.learnedThrough.label) ? "" : "s"}.` : s.lectures.some((l) => l.skillIds.length > 0) ? `The learner has not yet learned everything the first lecture with placed skills covers.` : "No skill is placed in a lecture yet, so what the learner has learned cannot be read against the lectures.",
						s.verdict === "behind"
							? `Behind: ${s.behind.length} skill${s.behind.length === 1 ? "" : "s"} from lectures the class has covered ${s.behind.length === 1 ? "is" : "are"} not learned: ${s.behind.map((id) => names[id] ?? id).join(", ")}.`
							: s.verdict === "on_track"
								? "On track: every skill placed in the lectures the class has covered is learned."
								: "On track or behind: unknown (the class position is unknown).",
						o.upcoming.length > 0 ? `Upcoming:\n${o.upcoming.map((r) => `- ${readinessLine(r, names, titleOf, port.now())}`).join("\n")}` : "Upcoming: no dated quiz or exam.",
						s.start ? `The most urgent gap: ${names[s.start.gapId] ?? s.start.gapId}${s.start.skillId !== s.start.gapId ? ` (start with ${names[s.start.skillId] ?? s.start.skillId}, which it builds on)` : ""}; the class page's Start begins it.` : "",
						s.unplaced > 0 ? `${s.unplaced} skill${s.unplaced === 1 ? " is" : "s are"} not placed in any lecture.` : "",
					]
						.filter(Boolean)
						.join("\n\n"),
				);
			},
		} satisfies AgentTool<typeof listInput>;
	}

	return tools;
}
