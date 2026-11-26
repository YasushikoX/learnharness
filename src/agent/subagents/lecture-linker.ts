/**
 * "Link skills to lectures" (WP9, 2026-11-25; docs/courses.md "Lectures and where you stand"): one background pass that
 * places each approved skill the draft's cites did not place in the lecture(s) that teach it, in the style of WP5's term
 * map: one submit call (runSubmitAgent), role `coursePlanner`, capped model turns and tokens, approval-free (the learner
 * corrects a lecture's skills on the class page or in Short question, and the pass never changes a lecture they set).
 *
 * The input is small on purpose: the lectures (number, title, date, topics, and the start of each of their files'
 * profiles) and the skills to place (name and statement). No lookup tools: the pass decides from what it is shown, in one
 * or two turns. A skill it cannot place stays "not placed"; nothing blocks on it.
 */

import { Type, type Static } from "typebox";
import type { Usage } from "@earendil-works/pi-ai";
import { withLanguageDirective, type LessonLanguage } from "../../core/language.ts";
import type { PiEngine } from "../models.ts";
import { runSubmitAgent } from "./submit-agent.ts";

/** Model turns at most (the submit and a correction or two). */
export const LINKER_MAX_TURNS = 3;
/** Tokens at most over the whole pass. */
export const LINKER_TOKEN_BUDGET = 150_000;

const INSTRUCTIONS = `You place a university class's skills in its lecture timeline. You get the lectures (number, title, date, topics, and the start of the profile of each lecture's files) and the skills to place (name and the checkable ability).

For each skill, give the lecture(s) where it is TAUGHT: where the class first explains it, not every lecture that uses it. Usually one lecture, at most three. Only when the lecture's title, topics or files clearly show it; when nothing shows where a skill is taught, leave it out. Never invent a lecture id.

DELIVERABLE: ONE submit_lecture_links call.`;

const submitSchema = Type.Object({
	links: Type.Array(
		Type.Object({
			skill: Type.String({ description: "A skill id from the list, copied exactly" }),
			lectures: Type.Array(Type.String(), { description: "The id(s) of the lecture(s) that teach it, copied exactly" }),
		}),
		{ description: "One entry per skill you can place; leave out a skill you cannot" },
	),
});

type SubmitInput = Static<typeof submitSchema>;

export interface LinkerInput {
	title: string;
	language: LessonLanguage;
	lectures: ReadonlyArray<{ id: string; label: string; date?: string; topics: string; files: ReadonlyArray<{ name: string; excerpt: string }> }>;
	skills: ReadonlyArray<{ id: string; name: string; statement: string }>;
}

export interface LinkerDeps {
	engine: PiEngine | undefined;
	signal?: AbortSignal;
	onStep: (usage: Usage, model: string, step: number, finishReason: string, tools: string) => void;
	courseId: string;
}

export interface LinkerResult {
	/** skill id → lecture ids (only ids that exist; at most three each). */
	links: Map<string, string[]>;
	problems: string[];
}

/** The submitted links checked against the real ids. Pure (exported for tests). */
export function checkLinks(input: SubmitInput, lectureIds: readonly string[], skillIds: readonly string[]): LinkerResult {
	const lectures = new Set(lectureIds);
	const skills = new Set(skillIds);
	const problems: string[] = [];
	const links = new Map<string, string[]>();
	for (const l of input.links) {
		if (!skills.has(l.skill)) {
			problems.push(`"${l.skill}" is not a skill id from the list`);
			continue;
		}
		const unknown = l.lectures.filter((id) => !lectures.has(id));
		if (unknown.length > 0) problems.push(`${l.skill}: ${unknown.map((id) => `"${id}"`).join(", ")} ${unknown.length === 1 ? "is" : "are"} not a lecture id from the list`);
		const ok = [...new Set(l.lectures.filter((id) => lectures.has(id)))].slice(0, 3);
		if (ok.length > 0) links.set(l.skill, [...new Set([...(links.get(l.skill) ?? []), ...ok])].slice(0, 3));
	}
	return { links, problems };
}

export function linkerPrompt(input: LinkerInput): string {
	return [
		`Class: ${input.title}`,
		"",
		"Lectures (id :: label · date · topics), with their files:",
		...input.lectures.flatMap((l) => [
			`- ${l.id} :: ${l.label}${l.date ? ` · ${l.date}` : ""}${l.topics ? ` · ${l.topics}` : ""}`,
			...l.files.map((f) => `    file "${f.name}": ${f.excerpt.replace(/\s+/g, " ").slice(0, 600)}`),
		]),
		"",
		"Skills to place (id :: name — statement):",
		...input.skills.map((s) => `- ${s.id} :: ${s.name} — ${s.statement}`),
	].join("\n");
}

const tokensOf = (u: Usage) => (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);

/** Place skills in lectures. Throws when the pass never submits, runs out of its budget first, or the caller aborts. */
export async function linkSkillsToLectures(input: LinkerInput, deps: LinkerDeps): Promise<Map<string, string[]>> {
	const lectureIds = input.lectures.map((l) => l.id);
	const skillIds = input.skills.map((s) => s.id);
	let spent = 0;
	let overBudget = false;
	let last: LinkerResult | undefined;
	const stop = new AbortController();
	const onOuterAbort = () => stop.abort();
	deps.signal?.addEventListener("abort", onOuterAbort, { once: true });
	const neverSubmitted = "the linking pass never submitted its links";
	try {
		const out = await runSubmitAgent({
			role: "coursePlanner",
			chatId: deps.courseId,
			toolName: "submit_lecture_links",
			toolDescription: "Submit which lecture(s) teach each skill you can place.",
			parameters: submitSchema,
			fill: (value: SubmitInput) => {
				last = checkLinks(value, lectureIds, skillIds);
				return last;
			},
			systemPrompt: withLanguageDirective(INSTRUCTIONS, input.language, "course"),
			prompt: linkerPrompt(input),
			engine: deps.engine,
			signal: stop.signal,
			onStep: (usage, model, step, finish, tools) => {
				deps.onStep(usage, model, step, finish, tools);
				spent += tokensOf(usage);
				if (spent >= LINKER_TOKEN_BUDGET && !stop.signal.aborted) {
					overBudget = true;
					stop.abort();
				}
			},
			neverSubmitted,
			maxTurns: LINKER_MAX_TURNS,
			validate: (value) => (value.problems.length > 0 ? `Fix these and submit again:\n- ${value.problems.join("\n- ")}` : null),
		});
		return out.links;
	} catch (err) {
		if (deps.signal?.aborted) throw err;
		// at a cap, what the last submission held that checks out is kept
		if ((overBudget || (err instanceof Error && err.message === neverSubmitted)) && last && last.links.size > 0) return last.links;
		throw overBudget ? new Error("the linking pass ran out of its token budget") : err;
	} finally {
		deps.signal?.removeEventListener("abort", onOuterAbort);
	}
}
