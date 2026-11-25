import type { AgentTool } from "@earendil-works/pi-agent-core";
import { filterEnabledTools } from "../core/pending.ts";
import { baseAgentOptions, type AgentBuildOptions } from "./teacher-agent.ts";
import { healToolRecord } from "./tools/heal.ts";
import { circuitSolveTool, figureGuideTool } from "./tools/figures.ts";
import { createShowFigureTool } from "./tools/show-figure.ts";
import { jobTools, type JobToolContext } from "./tools/jobs.ts";

/**
 * The ASK agent (fork addition, 2026-11-25; docs/courses.md "Ask"): an open conversation inside a course where the
 * learner asks general questions about the class and gets short answers grounded in the class material, with page
 * citations. Available before a skill map exists.
 *
 * It never probes, plans, quizzes, grades, finishes or tracks: no question tools, no plan, no finish tool, no gates, no
 * grader. Its sessions are never course evidence (core/mastery.ts skillEventsOf) and never feed the knowledge graph
 * (the chat handler skips extraction). Named "ask" in code; the selection pill that opens a side conversation is
 * "clarify" (server/clarify.ts), and the UI calls this mode "Questions" / "Ask about this class".
 *
 * Its registry, all of it:
 *   - the class-material lookups and the lecture-note lookups — NOT built here: they ride `opts.materials` (the turn's
 *     materialsForTurn, server/materials.ts: material_search, material_read, and lecture_note_search /
 *     lecture_note_read when the course has notes), the same seam every conversation agent reads;
 *   - figure_guide and circuit_solve, for the inline figure blocks (docs/figures.md);
 *   - show_figure, and the background visual and demo jobs it shows (behind the learner's tool toggles);
 *   - [the glossary slot below].
 * Plus plain reply text. Its prompt is prompts/ask/ plus a curated shared subset (agent/prompt-segments.ts).
 */

/** Every tool name an Ask turn can be offered (tests pin the exact registry against it). The glossary is not built. */
export const ASK_TOOL_NAMES = Object.freeze([
	"material_search",
	"material_read",
	"lecture_note_search",
	"lecture_note_read",
	"figure_guide",
	"circuit_solve",
	"show_figure",
	"visual",
	"demo",
] as const);

export interface AskAgentContext {
	/** The background figure jobs (visual, demo): the same runner, store and spawn seam the teacher's jobs use. Absent
	 *  (bare agents, tests) = no visual or demo. */
	jobs?: JobToolContext;
	/**
	 * GLOSSARY SLOT — the class glossary lookup arrives with another work package. Build it there and pass it in here;
	 * it joins the registry under its own name, after the figure tools. Nothing else in this file needs to change, but
	 * add its name to ASK_TOOL_NAMES and say in prompts/ask/20-grounding.md when to use it. Not built: always absent.
	 */
	glossary?: AgentTool<any>;
}

/** The Ask agent's own tools (everything but the lookups, which ride `opts.materials`). `messages` reads the run's live
 *  history, so a figure delivered earlier in this run is found by show_figure. */
export function askTools(ctx: AskAgentContext, messages: () => readonly unknown[], toggles?: AgentBuildOptions["toolToggles"]): Record<string, AgentTool<any>> {
	// visual and demo stay behind the learner's job-tool toggles, like the teacher's (core/pending.ts TOGGLEABLE_TOOLS)
	const jobs = ctx.jobs ? filterEnabledTools(jobTools(ctx.jobs), toggles) : {};
	return healToolRecord({
		figure_guide: figureGuideTool,
		circuit_solve: circuitSolveTool,
		show_figure: createShowFigureTool({ messages }),
		...(jobs.visual ? { visual: jobs.visual } : {}),
		...(jobs.demo ? { demo: jobs.demo } : {}),
		...(ctx.glossary ? { [ctx.glossary.name]: ctx.glossary } : {}),
	});
}

/** Build the Ask agent for one turn. The handler passes the same build options every conversation agent gets: the
 *  session's own engine (the teacher's model slot), materials, course section, language. `opts.tools` (tests) replaces
 *  the registry outright, as for the other agents. */
export function createAskAgent(ctx: AskAgentContext, opts: AgentBuildOptions = {}) {
	let live: () => readonly unknown[] = () => opts.messages ?? [];
	const tools = opts.tools ?? askTools(ctx, () => live(), opts.toolToggles);
	const agent = baseAgentOptions("ask", opts, Object.values(tools));
	live = () => agent.state.messages;
	return agent;
}

export type AskAgent = ReturnType<typeof createAskAgent>;
