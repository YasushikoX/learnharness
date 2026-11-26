/**
 * The Short question agent's class tools (WP8, 2026-11-25; docs/courses.md "Quizzes, exams and what you say you know").
 * The learner states a fact about the class ("quiz 3 is next Friday, chapters 4 and 5") or about themselves ("I don't get
 * the chain rule"), and the agent writes it straight away; each write returns a `change` the transcript shows as a card
 * with Undo (components/class-change-card.tsx). These are the ONLY Ask tools that change anything, and a self-report is
 * the only way an Ask conversation reaches understanding (core/mastery.ts applySelfReports): never graded evidence.
 *
 *   assessments_list            the class's assessments (ids, dates, topics, skills), its skills with ids, and today
 *   assessment_save             add one, or change one by id (or the one matching kind and title)
 *   assessment_remove           delete one by id
 *   assessments_find_in_syllabus  start the syllabus pass; its proposal waits for approval on the class page
 *   record_self_report          "I know / I'm not sure about / I don't get" these skills
 *
 * The writes go through a port (server/assessments.ts classFactsPort) so the agent layer never touches a store. Dates
 * the learner says are resolved here, against today in the learner's time zone (core/assessments.ts readLearnerDate).
 * Ambiguity is refused with a message telling the agent to ask: two items match, no date for a new one, a date that
 * cannot be read, words that admit two dates ("next Friday" on a Wednesday: "Friday 27 Nov or Friday 4 Dec?").
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

/** The tools whose result carries a change card (and an Undo). */
export const CLASS_CHANGE_TOOLS: readonly string[] = [ASSESSMENT_SAVE_TOOL, ASSESSMENT_REMOVE_TOOL, SELF_REPORT_TOOL];

/** One change, as the card shows it and Undo reads it (server/assessments.ts undoClassChange). */
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
	| { kind: "self-report"; courseId: string; report: SelfReport; skillNames: string[] };

/** What a save may carry (fields present = fields changed). */
export interface ClassFactsSaveInput {
	kind?: string;
	title?: string;
	date?: string | null;
	topics?: string;
	skillIds?: string[];
}

export interface ClassFactsPort {
	now(): number;
	/** The learner's time zone (the client's), or undefined for the machine's own. */
	timeZone(): string | undefined;
	hasSkills(): boolean;
	list(): { assessments: Assessment[]; skills: Array<{ id: string; name: string }> };
	save(id: string | undefined, input: ClassFactsSaveInput): { ok: true; change: ClassChange } | { ok: false; error: string };
	remove(id: string): { ok: true; change: ClassChange } | { ok: false; error: string };
	selfReport(input: { skillIds: string[]; stance: string; note: string }): { ok: true; change: ClassChange } | { ok: false; error: string };
	findInSyllabus(): { ok: true } | { ok: false; error: string };
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

function changeLine(change: ClassChange): string {
	if (change.kind === "self-report") return `Recorded: "${change.report.stance}" for ${change.skillNames.join(", ")}. The learner sees it as a card with Undo.`;
	const a = change.after ?? change.before!;
	const when = a.date ? dateWithWeekday(a.date) : "no date";
	return `${change.action === "added" ? "Added" : change.action === "updated" ? "Updated" : "Removed"}: ${a.title} (${a.kind}), ${when}${a.topics ? `, topics: ${a.topics}` : ""}. The learner sees it as a card with Undo; state it in one short sentence.`;
}

const listInput = Type.Object({});

const saveInput = Type.Object({
	id: Type.Optional(Type.String({ description: "The id of the assessment to change, from assessments_list. Leave out to add one (or to change the one with the same kind and title)." })),
	kind: Type.Optional(Type.String({ enum: [...ASSESSMENT_KINDS], description: "quiz, exam, midterm, final, assignment or other (required to add)" })),
	title: Type.Optional(Type.String({ description: "As the learner names it: \"Quiz 3\", \"Midterm\" (required to add)" })),
	date: Type.Optional(Type.String({ description: "When, as YYYY-MM-DD or in the learner's words, keeping their \"this\" or \"next\": \"today\", \"tomorrow\", \"Friday\", \"this Friday\", \"next Friday\", \"Friday next week\", \"in 2 weeks\", \"12 March\". Resolved against today in the learner's time zone; refused as ambiguous when the words admit two dates." })),
	noDate: Type.Optional(Type.Boolean({ description: "true only when the learner said the date is not known yet (adding without a date is refused otherwise)" })),
	clearDate: Type.Optional(Type.Boolean({ description: "true to remove the date of an existing one" })),
	topics: Type.Optional(Type.String({ description: "What it covers, in the learner's words (\"chapters 4 and 5\")" })),
	skillIds: Type.Optional(Type.Array(Type.String(), { description: "The class's skill ids (from assessments_list) the topics clearly cover; leave out or [] when unclear" })),
});

const removeInput = Type.Object({ id: Type.String({ description: "The id from assessments_list" }) });

const selfReportInput = Type.Object({
	skillIds: Type.Array(Type.String(), { minItems: 1, description: "The skill ids (from assessments_list) the learner's words are about" }),
	stance: Type.String({ enum: [...SELF_REPORT_STANCES], description: "know: they already know it · shaky: they are not sure about it · dont_know: they do not get it" }),
	note: Type.String({ description: "The learner's words, short" }),
});

/** The Ask agent's class tools over a port. `record_self_report` only when the class has an approved skill map. */
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
			"Add a quiz, exam or assignment the learner told you about, or change one (by id, or the one with the same kind and title). Write it as soon as they state it; do not ask them to confirm. " +
			"It is refused when the fact is ambiguous (two match, no date for a new one, a date that cannot be read): then ask the learner, in one short question.",
		parameters: saveInput,
		execute: async (_id, input: Static<typeof saveInput>) => {
			const now = port.now();
			let date: string | null | undefined;
			if (input.clearDate) date = null;
			else if (input.date !== undefined && input.date.trim() !== "") {
				const read = readLearnerDate(input.date, now, port.timeZone());
				if (read.kind === "unreadable") return refuse(`Could not read the date "${input.date}". Ask the learner for the date (a weekday, "next Friday" or a calendar date), then save again.`);
				if (read.kind === "ambiguous") {
					const [a, b] = read.options.map(spokenDate) as [string, string];
					return refuse(`Ambiguous: "${input.date}" could be ${a} or ${b}. Nothing was saved. Ask the learner in one short question: "${a} or ${b}?", then save again with the date as YYYY-MM-DD.`);
				}
				date = read.date;
			}
			let id = input.id;
			const { assessments } = port.list();
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
			const fields = {
				...(input.kind ? { kind: input.kind } : {}),
				...(input.title?.trim() ? { title: input.title } : {}),
				...(date !== undefined ? { date } : {}),
				...(input.topics !== undefined ? { topics: input.topics } : {}),
				...(input.skillIds !== undefined ? { skillIds: input.skillIds } : {}),
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
			"Start reading the class's syllabus for its quizzes and exams, when the learner asks for it (\"check the syllabus for exam dates\"). It runs in the background; what it finds waits for the learner's approval under Upcoming on the class page. Tell them that.",
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

	return {
		[ASSESSMENTS_LIST_TOOL]: list,
		[ASSESSMENT_SAVE_TOOL]: save,
		[ASSESSMENT_REMOVE_TOOL]: remove,
		[ASSESSMENTS_FIND_TOOL]: find,
		...(port.hasSkills() ? { [SELF_REPORT_TOOL]: selfReport } : {}),
	};
}
