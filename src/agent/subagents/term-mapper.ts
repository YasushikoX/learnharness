/**
 * "Map the class's terms" (WP5, 2026-11-25; spec: docs/courses.md "Vocabulary coverage"): the course planner's pass for
 * the vocabulary mapping ONLY, for a class approved before its material was indexed (or before coverage existed). The
 * approved skills are fixed: the pass assigns the class glossary's core entries to them, excludes what no skill teaches
 * and links confirmed duplicates; it changes no skill. Same rules and the same validation against the real glossary as a
 * full draft (core/coverage-items.ts draftCoverageFrom): unknown ids are dropped and reported, never invented.
 *
 * The only model work coverage ever does, and only when the student starts it.
 */

import { Type, type Static } from "typebox";
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { DraftCoverage } from "../../core/contracts.ts";
import { draftCoverageFrom, plannerGlossaryBlock, type CoverageGlossary, type PlannerTermOutput } from "../../core/coverage-items.ts";
import { withLanguageDirective, type LessonLanguage } from "../../core/language.ts";
import type { PiEngine } from "../models.ts";
import { VOCABULARY_INSTRUCTIONS } from "./course-planner.ts";
import { runSubmitAgent } from "./submit-agent.ts";

const INSTRUCTIONS = `You are the course planner of a learning application. The class's skill map is already approved: you do NOT change it. Your only job is to map the class's own vocabulary onto those skills, so no term the material treats as core is silently skipped in the lessons.

For each approved skill, list the glossary entries its lessons must teach. Check the material with material_search / material_read when an entry's place is unclear.

${VOCABULARY_INSTRUCTIONS}

DELIVERABLE: ONE submit_term_map call.`;

const mapSchema = Type.Object({
	skills: Type.Array(
		Type.Object({
			id: Type.String({ description: "An approved skill id, copied exactly" }),
			terms: Type.Array(Type.String(), { description: "The ids (or sense keys) of the glossary entries this skill teaches" }),
		}),
	),
	excludeTerms: Type.Optional(Type.Array(Type.Object({ id: Type.String(), reason: Type.String({ description: "A few words: why no skill teaches it" }) }))),
	linkTerms: Type.Optional(Type.Array(Type.Array(Type.String()), { description: "Groups of entry ids confirmed to be ONE concept under several names" })),
});

export interface TermMapperInput {
	title: string;
	/** The approved skills (the mapping's only targets). */
	skills: ReadonlyArray<{ id: string; name: string; statement: string }>;
	glossary: CoverageGlossary;
	language: LessonLanguage;
}

export interface TermMapperDeps {
	engine: PiEngine | undefined;
	signal?: AbortSignal;
	tools: Record<string, AgentTool<any>>;
	onStep: (usage: Usage, model: string, step: number, finishReason: string, tools: string) => void;
	courseId: string;
}

/** Map an approved class's vocabulary onto its skills. Throws when the planner never submits or the class has no core term. */
export async function mapCourseTerms(input: TermMapperInput, deps: TermMapperDeps): Promise<DraftCoverage> {
	const block = plannerGlossaryBlock(input.glossary);
	if (!block) throw new Error("the class glossary has no core term to map");
	const known = new Set(input.skills.map((s) => s.id));
	const prompt = [
		`Course: ${input.title}`,
		"",
		"The approved skills (id :: name — statement):",
		...input.skills.map((s) => `- ${s.id} :: ${s.name} — ${s.statement}`),
		"",
		block.text,
	].join("\n");
	const out = await runSubmitAgent({
		role: "coursePlanner",
		chatId: deps.courseId,
		toolName: "submit_term_map",
		toolDescription: "Submit the vocabulary mapping: per approved skill the entries it teaches, the excluded entries with reasons, and confirmed links.",
		parameters: mapSchema,
		fill: (v: Static<typeof mapSchema>): PlannerTermOutput => ({
			skills: v.skills.map((s) => ({ key: s.id.trim(), terms: s.terms })),
			excludeTerms: v.excludeTerms ?? [],
			linkTerms: v.linkTerms ?? [],
		}),
		systemPrompt: withLanguageDirective(INSTRUCTIONS, input.language, "course"),
		prompt,
		engine: deps.engine,
		signal: deps.signal,
		onStep: deps.onStep,
		neverSubmitted: "the course planner never submitted a term map",
		extraTools: deps.tools,
		maxTurns: 16,
		validate: (value) => {
			const unknown = value.skills.map((s) => s.key).filter((k) => !known.has(k));
			return unknown.length > 0 ? `Fix the map and submit again: ${unknown.map((k) => `"${k}"`).join(", ")} ${unknown.length === 1 ? "is" : "are"} not an approved skill id (${[...known].join(", ")}).` : null;
		},
	});
	return draftCoverageFrom(out, input.glossary, block.shown);
}
