/**
 * "Find quizzes and exams" (WP8, 2026-11-25; docs/courses.md): one background pass over a class's materials that finds
 * the syllabus, schedule or course outline and lists every assessment in it (kind, title, date, topics), mapped onto the
 * approved skills where it can, each citing its file and page. Built like the exam weigher: the material lookup tools
 * and ONE submit call (runSubmitAgent), role `coursePlanner` (the slot the weigher and the planner use). Its output is a
 * PROPOSAL: server/assessments.ts parks it on the course and nothing is written to the class's list until the learner
 * approves.
 *
 * It never invents a date. A date is taken only when the model also quotes the syllabus's own words for it
 * (`dateText`), and "Week 7 Friday" is resolved in CODE from the term's start date the syllabus gives (core/assessments.ts
 * weekDate), never by the model. With no date, the syllabus's words go into the topics.
 */

import { Type, type Static } from "typebox";
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { ASSESSMENT_KINDS, cleanLine, parseKind, TITLE_MAX, TOPICS_MAX, weekDate, type ProposedAssessment } from "../../core/assessments.ts";
import { parseExamDate } from "../../core/exam-plan.ts";
import { withLanguageDirective, type LessonLanguage } from "../../core/language.ts";
import type { PiEngine } from "../models.ts";
import { runSubmitAgent } from "./submit-agent.ts";

const INSTRUCTIONS = `You find a university class's assessments: every quiz, exam, midterm, final and graded assignment. You get the class's materials and its approved skill list. Find the syllabus, schedule, course outline or course plan among the materials and read it with the lookup tools (material_search, material_read); do not rely on the profiles alone.

For each assessment give:
- kind: quiz, exam, midterm, final, assignment, or other;
- title as the syllabus names it ("Quiz 3", "Midterm exam");
- WHEN, only as the syllabus states it. NEVER guess or invent a date:
  * a calendar date written in the syllabus: give "date" (YYYY-MM-DD) and quote the syllabus's own words in "dateText";
  * a week and a weekday ("Week 7, Friday"): give "week" (1 = the term's first week) and "weekday" (1 Monday .. 7 Sunday) and quote the words in "dateText"; and give "termStart", the date the syllabus gives for the start of week 1, ONLY when it gives one;
  * anything else ("late October", "TBA", no date): leave date, week and weekday out and quote the words in "dateText" (or "" when it says nothing);
- topics: what it covers, in the syllabus's words (chapters, sections, topics);
- skills: the ids of the approved skills those topics cover, only when the match is clear ([] otherwise, and always [] when the list is empty);
- material and page: the id of the material it is in and the page (PDF) where it says so.

If no material is a syllabus, schedule or outline, submit an empty list and say so in the summary.

DELIVERABLE: ONE submit_assessments call: a short summary (1-2 sentences: which material you read, what you found or did not find), termStart when the syllabus gives it, and the list.`;

const itemSchema = Type.Object({
	kind: Type.String({ enum: [...ASSESSMENT_KINDS], description: "quiz, exam, midterm, final, assignment or other" }),
	title: Type.String({ minLength: 1, description: "As the syllabus names it" }),
	date: Type.Optional(Type.String({ description: "YYYY-MM-DD, only when the syllabus writes the date" })),
	week: Type.Optional(Type.Integer({ minimum: 1, maximum: 60, description: "The term week the syllabus gives (1 = first week)" })),
	weekday: Type.Optional(Type.Integer({ minimum: 1, maximum: 7, description: "1 Monday .. 7 Sunday, with week" })),
	dateText: Type.String({ description: "The syllabus's own words for when it is (\"Friday 12 March\", \"Week 7\", \"TBA\"); \"\" when it says nothing" }),
	topics: Type.String({ description: "What it covers, in the syllabus's words" }),
	skills: Type.Array(Type.String(), { description: "Approved skill ids the topics clearly cover; [] when unclear" }),
	material: Type.String({ minLength: 1, description: "The id of the material it is in" }),
	page: Type.Optional(Type.Integer({ minimum: 1, description: "The page where it says so (PDFs)" })),
});

const submitSchema = Type.Object({
	summary: Type.String({ minLength: 1, description: "1-2 sentences: the material read, what was found" }),
	termStart: Type.Optional(Type.String({ description: "YYYY-MM-DD: the date the syllabus gives for the start of week 1; only when it gives one" })),
	assessments: Type.Array(itemSchema, { description: "Every assessment found; [] when there is no syllabus" }),
});

type SubmitInput = Static<typeof submitSchema>;

export interface FoundAssessments {
	summary: string;
	items: Array<Omit<ProposedAssessment, "status" | "match">>;
	/** Raw problems the submit check found (empty when fine). */
	problems: string[];
}

export interface AssessmentFinderInput {
	title: string;
	/** The material profiles block (core/materials.ts materialBlock, wrapped as in the planner). */
	materialsSection: string;
	materials: ReadonlyArray<{ id: string; name: string }>;
	skills: ReadonlyArray<{ id: string; name: string; statement: string }>;
	language: LessonLanguage;
}

export interface AssessmentFinderDeps {
	engine: PiEngine | undefined;
	signal?: AbortSignal;
	tools: Record<string, AgentTool<any>>;
	onStep: (usage: Usage, model: string, step: number, finishReason: string, tools: string) => void;
	courseId: string;
}

/** The submitted list turned into proposal items, and what is wrong with it. Pure (exported for tests). */
export function fillFound(input: SubmitInput, materials: AssessmentFinderInput["materials"], skillIds: readonly string[]): FoundAssessments {
	const problems: string[] = [];
	const nameOf = new Map(materials.map((m) => [m.id, m.name]));
	const allowed = new Set(skillIds);
	const termStart = input.termStart === undefined || input.termStart === "" ? undefined : parseExamDate(input.termStart);
	if (input.termStart && !termStart) problems.push(`termStart "${input.termStart}" is not a date like 2026-01-12`);
	const items: FoundAssessments["items"] = [];
	input.assessments.forEach((a, i) => {
		const n = `item ${i + 1} ("${a.title}")`;
		const kind = parseKind(a.kind);
		if (!kind) problems.push(`${n}: kind must be one of ${ASSESSMENT_KINDS.join(", ")}`);
		const material = nameOf.get(a.material);
		if (!material) problems.push(`${n}: "${a.material}" is not a material id from the list`);
		const dateText = cleanLine(a.dateText, 120);
		let date: string | undefined;
		if (a.date !== undefined && a.date !== "") {
			const parsed = parseExamDate(a.date);
			if (!parsed) problems.push(`${n}: date "${a.date}" is not a date like 2026-03-12`);
			else if (!dateText) problems.push(`${n}: a date needs the syllabus's own words for it in dateText; leave the date out if the syllabus does not write it`);
			else date = parsed;
		} else if (a.week !== undefined || a.weekday !== undefined) {
			if (a.week === undefined || a.weekday === undefined) problems.push(`${n}: give both week and weekday, or neither`);
			else if (!dateText) problems.push(`${n}: a week needs the syllabus's own words for it in dateText`);
			else if (termStart) date = weekDate(termStart, a.week, a.weekday) ?? undefined;
		}
		const unknown = a.skills.filter((s) => !allowed.has(s));
		if (unknown.length > 0) problems.push(`${n}: ${unknown.map((s) => `"${s}"`).join(", ")} ${unknown.length === 1 ? "is" : "are"} not an approved skill id`);
		if (!kind || !material) return;
		let topics = a.topics.trim();
		// a date the syllabus gives only in words stays in the topics, so nothing it said is lost
		if (!date && dateText) topics = topics ? `${topics} (when: ${dateText})` : `When: ${dateText}`;
		items.push({
			key: `p${items.length + 1}`,
			kind,
			title: cleanLine(a.title, TITLE_MAX),
			...(date ? { date } : {}),
			topics: topics.slice(0, TOPICS_MAX),
			skillIds: [...new Set(a.skills.filter((s) => allowed.has(s)))],
			cite: `${material}${a.page ? ` p. ${a.page}` : ""}`,
		});
	});
	return { summary: input.summary.trim(), items, problems };
}

export function finderPrompt(input: AssessmentFinderInput): string {
	return [
		`Class: ${input.title}`,
		"",
		input.materialsSection,
		"",
		"Material ids (id :: name):",
		...input.materials.map((m) => `- ${m.id} :: ${m.name}`),
		"",
		input.skills.length > 0 ? "The approved skills (id :: name — statement):" : "The class has no approved skill map yet: give skills: [] everywhere.",
		...input.skills.map((s) => `- ${s.id} :: ${s.name} — ${s.statement}`),
	].join("\n");
}

/** Find a class's assessments. Throws when the pass never submits a list that passes the check. */
export async function findAssessments(input: AssessmentFinderInput, deps: AssessmentFinderDeps): Promise<Omit<FoundAssessments, "problems">> {
	const ids = input.skills.map((s) => s.id);
	const found = await runSubmitAgent({
		role: "coursePlanner",
		chatId: deps.courseId,
		toolName: "submit_assessments",
		toolDescription: "Submit every assessment the syllabus lists, each with when it is (only as the syllabus states it), its topics, skills and where it says so.",
		parameters: submitSchema,
		fill: (value: SubmitInput) => fillFound(value, input.materials, ids),
		systemPrompt: withLanguageDirective(INSTRUCTIONS, input.language, "course"),
		prompt: finderPrompt(input),
		engine: deps.engine,
		signal: deps.signal,
		onStep: deps.onStep,
		neverSubmitted: "the syllabus pass never submitted its list",
		extraTools: deps.tools,
		maxTurns: 16,
		validate: (value) => (value.problems.length > 0 ? `Fix these and submit again:\n- ${value.problems.join("\n- ")}` : null),
	});
	return { summary: found.summary, items: found.items };
}
