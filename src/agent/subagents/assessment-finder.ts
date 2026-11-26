/**
 * "Find quizzes and exams" (WP8, 2026-11-25; docs/courses.md): one background pass over a class's materials that finds
 * the syllabus, schedule or course outline and lists every assessment in it (kind, title, date, topics), mapped onto the
 * approved skills where it can, each citing its file and page. Built like the exam weigher: the material lookup tools
 * and ONE submit call (runSubmitAgent), role `coursePlanner` (the slot the weigher and the planner use). Its output is a
 * PROPOSAL: server/assessments.ts parks it on the course and nothing is written to the class's list until the learner
 * approves.
 *
 * A FEW MODEL CALLS, BOUNDED (review 1, finding 10; the owner's ruling): searching, reading and submitting are successive
 * turns, so the loop stays, capped at FINDER_MAX_TURNS model turns and FINDER_TOKEN_BUDGET tokens in all. At the cap the
 * pass returns what its last submission held, marked partial; with no submission at all it fails. The submitted list
 * and summary are capped (PROPOSAL_ITEMS_MAX, PROPOSAL_SUMMARY_MAX), and every call's usage is reported (`onStep`).
 *
 * IT NEVER INVENTS A DATE, AND THE CODE CHECKS THE SOURCE (review 1, finding 2). Every item quotes the syllabus's own
 * words for when it is (`dateText`) and cites the material and, for a PDF, the page. The code reads the cited page
 * (`sources`, loaded by the server before the run) and:
 *   - refuses a PDF citation with no page, a page the PDF does not have, or a quote that is not on the cited page or
 *     text (the model fixes and submits again);
 *   - keeps a calendar date only when the quote itself states that day and month (a valid date with "TBA" is dropped);
 *   - resolves "Week 7 Friday" in CODE (core/assessments.ts weekDate) only when the quote names that week and weekday
 *     AND the term's start date is anchored the same way: quoted, cited, found on the page and stating that date;
 *   - otherwise leaves the date empty and keeps the syllabus's words in the topics. A source that cannot be read on this
 *     device (the original is elsewhere) gives no date either.
 * The quote is kept on the proposal item and shown with its citation.
 */

import { Type, type Static } from "typebox";
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { ASSESSMENT_KINDS, cleanLine, parseKind, PROPOSAL_ITEMS_MAX, PROPOSAL_SUMMARY_MAX, TITLE_MAX, TOPICS_MAX, weekDate, type ProposedAssessment } from "../../core/assessments.ts";
import { parseExamDate } from "../../core/exam-plan.ts";
import { LECTURE_TITLE_MAX, LECTURE_TOPICS_MAX, parseLectureNumber, PROPOSAL_LECTURES_MAX, type ProposedLecture } from "../../core/lectures.ts";
import { withLanguageDirective, type LessonLanguage } from "../../core/language.ts";
import type { PiEngine } from "../models.ts";
import { runSubmitAgent } from "./submit-agent.ts";

/** Model turns at most (search, read, submit, and a correction or two). */
export const FINDER_MAX_TURNS = 6;
/** Tokens at most over the whole pass (input, output and cache, every call): six turns of a prompt the size of the
 *  exam weigher's (the class's material profiles and skills, ~50k tokens) — the weigher itself has no explicit budget. */
export const FINDER_TOKEN_BUDGET = 300_000;

const INSTRUCTIONS = `You find a university class's assessments: every quiz, exam, midterm, final and graded assignment. You get the class's materials and its approved skill list. Find the syllabus, schedule, course outline or course plan among the materials and read it with the lookup tools (material_search, material_read); do not rely on the profiles alone. Be quick: search for the schedule, read its pages, then submit. You have only a few turns.

For each assessment give:
- kind: quiz, exam, midterm, final, assignment, or other;
- title as the syllabus names it ("Quiz 3", "Midterm exam");
- material and page: the id of the material it is in and, for a PDF, the page where it says when it is;
- dateText: the syllabus's own words for when it is, copied EXACTLY from that page ("Friday 6 February", "Week 7, Friday", "TBA"); "" when it says nothing. The app checks the words are on that page;
- WHEN, only as the syllabus states it. NEVER guess or invent a date:
  * a calendar date written there: give "date" (YYYY-MM-DD); dateText must contain that day and month;
  * a week and a weekday ("Week 7, Friday"): give "week" (1 = the term's first week) and "weekday" (1 Monday .. 7 Sunday); dateText must contain both;
  * anything else ("late October", "TBA", no date): leave date, week and weekday out;
- topics: what it covers, in the syllabus's words (chapters, sections, topics);
- skills: the ids of the approved skills those topics cover, only when the match is clear ([] otherwise, and always [] when the list is empty).

The term's start: give "termStart" (YYYY-MM-DD) ONLY when the syllabus writes the date week 1 starts, with "termStartText" (its exact words, containing that date), "termStartMaterial" and "termStartPage".

THE LECTURE SCHEDULE, in the same run: when the syllabus or schedule lists the lectures, list each one (at most ${PROPOSAL_LECTURES_MAX}) with its number ("n"), title, topics, the approved skills those topics clearly cover, material and page, and when it is under the SAME date rules as above (dateText quoted exactly; a date or a week and weekday only as written there). Leave "lectures" out when there is no schedule.

If no material is a syllabus, schedule or outline, submit an empty list and say so in the summary.

DELIVERABLE: ONE submit_assessments call: a short summary (1-2 sentences: which material you read, what you found or did not find), the term's start when the syllabus gives it, the list (at most ${PROPOSAL_ITEMS_MAX}) and the lectures.`;

const itemSchema = Type.Object({
	kind: Type.String({ enum: [...ASSESSMENT_KINDS], description: "quiz, exam, midterm, final, assignment or other" }),
	title: Type.String({ minLength: 1, description: "As the syllabus names it" }),
	date: Type.Optional(Type.String({ description: "YYYY-MM-DD, only when the syllabus writes the date" })),
	week: Type.Optional(Type.Integer({ minimum: 1, maximum: 60, description: "The term week the syllabus gives (1 = first week)" })),
	weekday: Type.Optional(Type.Integer({ minimum: 1, maximum: 7, description: "1 Monday .. 7 Sunday, with week" })),
	dateText: Type.String({ description: "The syllabus's exact words for when it is, copied from the cited page (\"Friday 12 March\", \"Week 7\", \"TBA\"); \"\" when it says nothing" }),
	topics: Type.String({ description: "What it covers, in the syllabus's words" }),
	skills: Type.Array(Type.String(), { description: "Approved skill ids the topics clearly cover; [] when unclear" }),
	material: Type.String({ minLength: 1, description: "The id of the material it is in" }),
	page: Type.Optional(Type.Integer({ minimum: 1, description: "The page where it says when it is (required for PDFs)" })),
});

const lectureSchema = Type.Object({
	n: Type.Optional(Type.Integer({ minimum: 0, maximum: 999, description: "The lecture's number in the schedule" })),
	title: Type.String({ minLength: 1, description: "As the schedule names it (\"Lecture 8: Eigenvalues\")" }),
	date: Type.Optional(Type.String({ description: "YYYY-MM-DD, only when the schedule writes the date" })),
	week: Type.Optional(Type.Integer({ minimum: 1, maximum: 60, description: "The term week the schedule gives" })),
	weekday: Type.Optional(Type.Integer({ minimum: 1, maximum: 7, description: "1 Monday .. 7 Sunday, with week" })),
	dateText: Type.String({ description: "The schedule's exact words for when it is, copied from the cited page; \"\" when it says nothing" }),
	topics: Type.String({ description: "What it covers, in the schedule's words" }),
	skills: Type.Array(Type.String(), { description: "Approved skill ids the topics clearly cover; [] when unclear" }),
	material: Type.String({ minLength: 1, description: "The id of the material the schedule is in" }),
	page: Type.Optional(Type.Integer({ minimum: 1, description: "The page (required for PDFs)" })),
});

const submitSchema = Type.Object({
	summary: Type.String({ minLength: 1, description: "1-2 sentences: the material read, what was found" }),
	termStart: Type.Optional(Type.String({ description: "YYYY-MM-DD: the date the syllabus gives for the start of week 1; only when it gives one" })),
	termStartText: Type.Optional(Type.String({ description: "The syllabus's exact words for the term's start, containing that date" })),
	termStartMaterial: Type.Optional(Type.String({ description: "The id of the material that says when the term starts" })),
	termStartPage: Type.Optional(Type.Integer({ minimum: 1, description: "Its page (PDFs)" })),
	assessments: Type.Array(itemSchema, { description: `Every assessment found (at most ${PROPOSAL_ITEMS_MAX}); [] when there is no syllabus` }),
	lectures: Type.Optional(Type.Array(lectureSchema, { description: `WP9: the lecture schedule (at most ${PROPOSAL_LECTURES_MAX}); leave out when there is none` })),
});

type SubmitInput = Static<typeof submitSchema>;

export interface FoundAssessments {
	summary: string;
	items: Array<Omit<ProposedAssessment, "status" | "match" | "matchStamp">>;
	/** WP9: the lecture schedule found in the same run (absent from a finder that does not read lectures). */
	lectures?: Array<Omit<ProposedLecture, "status" | "match" | "matchStamp">>;
	/** Raw problems the submit check found (empty when fine). */
	problems: string[];
}

/** A material's text as the code checks quotes against it: a PDF's pages, or a text's whole body; null when it cannot be
 *  read on this device. */
export type MaterialSource = { kind: "pages"; pages: ReadonlyMap<number, string> } | { kind: "text"; text: string } | null;

export interface AssessmentFinderInput {
	title: string;
	/** The material profiles block (core/materials.ts materialBlock, wrapped as in the planner). */
	materialsSection: string;
	materials: ReadonlyArray<{ id: string; name: string; kind?: string }>;
	/** Each material's text by id, for the quote and page checks (absent id: cannot be read here). */
	sources: ReadonlyMap<string, MaterialSource>;
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

// ─── the source checks ──────────────────────────────────────────────────────

/** Text folded for quote matching: width, case, markup and spacing ignored. */
function fold(s: string): string {
	return s.normalize("NFKC").toLowerCase().replace(/[\s*_`|#>~]+/g, " ").replace(/[‐-―]/g, "-").trim();
}

const MONTH_WORDS: readonly (readonly string[])[] = [
	["january", "jan", "januar"],
	["february", "feb", "februar"],
	["march", "mar", "mars"],
	["april", "apr"],
	["may", "mai"],
	["june", "jun", "juni"],
	["july", "jul", "juli"],
	["august", "aug"],
	["september", "sep", "sept"],
	["october", "oct", "oktober", "okt"],
	["november", "nov"],
	["december", "dec", "desember", "des"],
];
const WEEKDAY_WORDS: readonly (readonly string[])[] = [
	["monday", "mon", "mandag", "man"],
	["tuesday", "tue", "tues", "tirsdag", "tir"],
	["wednesday", "wed", "onsdag", "ons"],
	["thursday", "thu", "thur", "thurs", "torsdag", "tor"],
	["friday", "fri", "fredag", "fre"],
	["saturday", "sat", "lørdag", "lør"],
	["sunday", "sun", "søndag", "søn"],
];
const word = (w: string) => new RegExp(`(^|[^\\p{L}])${w}([^\\p{L}]|$)`, "u");

/** Does the quote itself state this calendar date (its day and month; a year, when it has one, the same)? Pure.
 *  The day and the month must stand together ("6 February", "Feb 6th", "6. februar", "20/2"): a day number elsewhere in
 *  the quote ("Week 6, Feb 20", "Quiz 3: 12 March") does not count. A numeric date that reads both ways ("6/2": 6 Feb or
 *  2 Jun) is never taken as checked (WP8 re-check 1, N1). */
export function quoteStatesDate(quote: string, date: string): boolean {
	const q = fold(quote);
	if (q.includes(date)) return true;
	const [y, m, d] = date.split("-").map(Number) as [number, number, number];
	const years = q.match(/(?<!\d)(19|20)\d{2}(?!\d)/g) ?? [];
	if (years.some((yr) => Number(yr) !== y)) return false;
	const months = MONTH_WORDS[m - 1]!.join("|");
	const day = `0?${d}(?:st|nd|rd|th)?\\.?`;
	if (new RegExp(`(^|[^\\d])${day}\\s*(?:of\\s+)?(?:${months})\\.?([^\\p{L}]|$)`, "u").test(q)) return true;
	if (new RegExp(`(^|[^\\p{L}])(?:${months})\\.?\\s*${day}([^\\d]|$)`, "u").test(q)) return true;
	for (const [, a, b] of q.matchAll(/(?<!\d)(\d{1,2})[./-](\d{1,2})(?!\d)/g)) {
		const x = Number(a);
		const z = Number(b);
		if (!((x === d && z === m) || (x === m && z === d))) continue;
		if (x !== z && x <= 12 && z <= 12) continue; // reads both ways: unchecked
		return true;
	}
	return false;
}

/** Does the quote name this term week and weekday (1 Monday .. 7 Sunday)? Pure. */
export function quoteStatesWeek(quote: string, week: number, weekday: number): boolean {
	const q = fold(quote);
	const wk = new RegExp(`(^|[^\\p{L}])(week|wk|uke|veke)\\s*0?${week}([^\\d]|$)`, "u").test(q);
	return wk && WEEKDAY_WORDS[weekday - 1]!.some((w) => word(w).test(q));
}

/** The text a citation points at, or a problem: a PDF needs a page it has. */
function citedText(source: MaterialSource | undefined, page: number | undefined, isPdf: boolean): { text: string | null } | { problem: string } {
	if (isPdf && page === undefined) return { problem: "a PDF citation needs the page" };
	if (source === undefined || source === null) return { text: null }; // cannot be read here: no date, no problem
	if (source.kind === "pages") {
		if (page === undefined) return { problem: "a PDF citation needs the page" };
		const text = source.pages.get(page);
		return text === undefined ? { problem: `page ${page} is not in that material (it has ${source.pages.size} pages)` } : { text };
	}
	return { text: source.text };
}

/** The submitted list turned into proposal items, and what is wrong with it. Pure (exported for tests). */
export function fillFound(input: SubmitInput, materials: AssessmentFinderInput["materials"], skillIds: readonly string[], sources: AssessmentFinderInput["sources"]): FoundAssessments {
	const problems: string[] = [];
	const byId = new Map(materials.map((m) => [m.id, m]));
	const allowed = new Set(skillIds);
	const isPdf = (id: string) => byId.get(id)?.kind === "pdf" || sources.get(id)?.kind === "pages";
	// the term's start: only when its own words are on the cited page and state that date
	let termStart: string | undefined;
	if (input.termStart !== undefined && input.termStart !== "") {
		const parsed = parseExamDate(input.termStart);
		const text = cleanLine(input.termStartText, 200);
		const mat = input.termStartMaterial ?? "";
		if (!parsed) problems.push(`termStart "${input.termStart}" is not a date like 2026-01-12`);
		else if (!text || !byId.has(mat)) problems.push("termStart needs termStartText (the syllabus's exact words) and termStartMaterial (a material id from the list)");
		else {
			const cited = citedText(sources.get(mat), input.termStartPage, isPdf(mat));
			if ("problem" in cited) problems.push(`termStart: ${cited.problem}`);
			else if (cited.text !== null && !fold(cited.text).includes(fold(text))) problems.push(`termStart: "${text}" is not on the cited ${input.termStartPage ? `page ${input.termStartPage}` : "material"}; copy the words exactly`);
			else if (cited.text !== null && quoteStatesDate(text, parsed)) termStart = parsed;
		}
	}
	/** One item's citation and when (WP9: shared by assessments and lectures): the same quote and page checks for both. */
	const when = (a: WhenFields, n: string) => {
		const material = byId.get(a.material);
		if (!material) problems.push(`${n}: "${a.material}" is not a material id from the list`);
		const dateText = cleanLine(a.dateText, 120);
		let date: string | undefined;
		let cited: { text: string | null } | { problem: string } = { text: null };
		if (material) {
			cited = citedText(sources.get(a.material), a.page, isPdf(a.material));
			if ("problem" in cited) problems.push(`${n}: ${cited.problem}`);
			else if (dateText && cited.text !== null && !fold(cited.text).includes(fold(dateText))) {
				problems.push(`${n}: "${dateText}" is not on the cited ${a.page ? `page ${a.page}` : "material"}; copy the syllabus's words exactly, or fix the page`);
			}
		}
		const verified = "text" in cited && cited.text !== null && !!dateText && fold(cited.text).includes(fold(dateText));
		if (a.date !== undefined && a.date !== "") {
			const parsed = parseExamDate(a.date);
			if (!parsed) problems.push(`${n}: date "${a.date}" is not a date like 2026-03-12`);
			else if (!dateText) problems.push(`${n}: a date needs the syllabus's own words for it in dateText; leave the date out if the syllabus does not write it`);
			else if (verified && quoteStatesDate(dateText, parsed)) date = parsed;
		} else if (a.week !== undefined || a.weekday !== undefined) {
			if (a.week === undefined || a.weekday === undefined) problems.push(`${n}: give both week and weekday, or neither`);
			else if (!dateText) problems.push(`${n}: a week needs the syllabus's own words for it in dateText`);
			else if (verified && termStart && quoteStatesWeek(dateText, a.week, a.weekday)) date = weekDate(termStart, a.week, a.weekday) ?? undefined;
		}
		const unknown = a.skills.filter((s) => !allowed.has(s));
		if (unknown.length > 0) problems.push(`${n}: ${unknown.map((s) => `"${s}"`).join(", ")} ${unknown.length === 1 ? "is" : "are"} not an approved skill id`);
		return { material, date, dateText, verified, failed: "problem" in cited };
	};
	const items: FoundAssessments["items"] = [];
	input.assessments.slice(0, PROPOSAL_ITEMS_MAX).forEach((a, i) => {
		const n = `item ${i + 1} ("${a.title}")`;
		const kind = parseKind(a.kind);
		if (!kind) problems.push(`${n}: kind must be one of ${ASSESSMENT_KINDS.join(", ")}`);
		const { material, date, dateText, verified, failed } = when(a, n);
		if (!kind || !material || failed) return;
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
			cite: `${material.name}${a.page ? ` p. ${a.page}` : ""}`,
			...(dateText && verified ? { quote: dateText } : {}),
		});
	});
	// WP9: the lecture schedule, with the same checks; a date the syllabus does not state is left out
	const lectures: NonNullable<FoundAssessments["lectures"]> = [];
	(input.lectures ?? []).slice(0, PROPOSAL_LECTURES_MAX).forEach((l, i) => {
		const n = `lecture ${i + 1} ("${l.title}")`;
		const { material, date, dateText, verified, failed } = when(l, n);
		if (!material || failed) return;
		const num = l.n === undefined ? undefined : parseLectureNumber(l.n);
		lectures.push({
			key: `l${lectures.length + 1}`,
			...(num !== undefined ? { n: num } : {}),
			title: cleanLine(l.title, LECTURE_TITLE_MAX) || (num !== undefined ? `Lecture ${num}` : "Lecture"),
			...(date ? { date } : {}),
			topics: l.topics.trim().slice(0, LECTURE_TOPICS_MAX),
			skillIds: [...new Set(l.skills.filter((s) => allowed.has(s)))],
			cite: `${material.name}${l.page ? ` p. ${l.page}` : ""}`,
			...(dateText && verified ? { quote: dateText } : {}),
		});
	});
	return { summary: cleanLine(input.summary, PROPOSAL_SUMMARY_MAX), items, lectures, problems };
}

/** The fields an item's "when" check reads (an assessment or a lecture). */
interface WhenFields {
	material: string;
	page?: number;
	dateText: string;
	date?: string;
	week?: number;
	weekday?: number;
	skills: string[];
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

const tokensOf = (u: Usage) => (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);

/** Find a class's assessments. At the turn or token cap: what the last submission held, `partial`. Throws when the pass
 *  never submits anything usable, or when the caller aborts. */
export async function findAssessments(input: AssessmentFinderInput, deps: AssessmentFinderDeps): Promise<Omit<FoundAssessments, "problems"> & { partial?: true }> {
	const ids = input.skills.map((s) => s.id);
	const neverSubmitted = "the syllabus pass never submitted its list";
	let last: FoundAssessments | undefined;
	let spent = 0;
	let overBudget = false;
	// the budget stops the run through its own abort, linked to the caller's
	const stop = new AbortController();
	const onOuterAbort = () => stop.abort();
	deps.signal?.addEventListener("abort", onOuterAbort, { once: true });
	try {
		const found = await runSubmitAgent({
			role: "coursePlanner",
			chatId: deps.courseId,
			toolName: "submit_assessments",
			toolDescription: "Submit every assessment the syllabus lists, each with when it is (only as the syllabus states it, quoted exactly from the cited page), its topics, skills and where it says so.",
			parameters: submitSchema,
			fill: (value: SubmitInput) => {
				last = fillFound(value, input.materials, ids, input.sources);
				return last;
			},
			systemPrompt: withLanguageDirective(INSTRUCTIONS, input.language, "course"),
			prompt: finderPrompt(input),
			engine: deps.engine,
			signal: stop.signal,
			onStep: (usage, model, step, finish, tools) => {
				deps.onStep(usage, model, step, finish, tools);
				spent += tokensOf(usage);
				if (spent >= FINDER_TOKEN_BUDGET && !stop.signal.aborted) {
					overBudget = true;
					stop.abort();
				}
			},
			neverSubmitted,
			extraTools: deps.tools,
			maxTurns: FINDER_MAX_TURNS,
			validate: (value) => (value.problems.length > 0 ? `Fix these and submit again:\n- ${value.problems.join("\n- ")}` : null),
		});
		return { summary: found.summary, items: found.items, lectures: found.lectures };
	} catch (err) {
		if (deps.signal?.aborted) throw err;
		const capped = overBudget || (err instanceof Error && err.message === neverSubmitted);
		if (!capped) throw err;
		if (!last) throw new Error(overBudget ? "the syllabus pass ran out of its token budget before submitting a list" : neverSubmitted);
		return { summary: last.summary, items: last.items, lectures: last.lectures, partial: true };
	} finally {
		deps.signal?.removeEventListener("abort", onOuterAbort);
	}
}
