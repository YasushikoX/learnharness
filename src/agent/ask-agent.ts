import type { AgentTool } from "@earendil-works/pi-agent-core";
import { filterEnabledTools } from "../core/pending.ts";
import { baseAgentOptions, type AgentBuildOptions } from "./teacher-agent.ts";
import { healToolRecord } from "./tools/heal.ts";
import { circuitSolveTool, figureGuideTool } from "./tools/figures.ts";
import { ASK_SHOW_FIGURE_DESCRIPTION, createShowFigureTool } from "./tools/show-figure.ts";
import { jobTools, type JobToolContext } from "./tools/jobs.ts";

/**
 * The ASK agent (fork addition, 2026-11-25; docs/courses.md "Ask"): an open conversation inside a course where the
 * learner asks general questions about the class and gets short answers grounded in the class material, with page
 * citations. Available before a skill map exists.
 *
 * It never probes, plans, quizzes, grades, finishes or tracks: no question tools, no plan, no finish tool, no gates, no
 * grader. Its sessions are never course evidence (core/mastery.ts skillEventsOf) and never feed the knowledge graph
 * (the chat handler skips extraction, and the pipeline refuses it). Named "ask" in code; the selection pill that opens
 * a side conversation is "clarify" (server/clarify.ts), and the UI calls this mode "Questions" / "Short question".
 *
 * Its registry, all of it:
 *   - the class-material lookups and the lecture-note lookups — NOT built here: they ride `opts.materials` (the turn's
 *     materialsForTurn, server/materials.ts: material_search, material_read, and lecture_note_search /
 *     lecture_note_read when the course has notes), the same seam every conversation agent reads;
 *   - figure_guide and circuit_solve, for the inline figure blocks (docs/figures.md);
 *   - show_figure, and the background visual and demo jobs it shows (behind the learner's tool toggles);
 *   - [the glossary slot below];
 *   - WP8 (2026-11-25): the class tools, when the handler wires them: assessments_list, assessment_save,
 *     assessment_remove, assessments_find_in_syllabus and (with an approved skill map) record_self_report. They are the
 *     ONLY Ask tools that change anything: the class's assessments, and the learner's self-reports, which are the only
 *     way an Ask conversation reaches understanding (core/mastery.ts applySelfReports; never graded evidence).
 * Plus plain reply text. Its prompt is prompts/ask/ only, each conditional fragment composed only when this turn offers
 * what it is about (agent/ask-prompt.ts).
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
	// WP8: the class tools (agent/tools/class-facts.ts), when the handler wires them
	"assessments_list",
	"assessment_save",
	"assessment_remove",
	"assessments_find_in_syllabus",
	"record_self_report",
] as const);

export interface AskAgentContext {
	/** The background figure jobs (visual, demo): the same runner, store and spawn seam the teacher's jobs use. Absent
	 *  (bare agents, tests) = no visual or demo. */
	jobs?: JobToolContext;
	/**
	 * GLOSSARY SLOT — the class glossary lookup arrives with another work package. Build it there and pass it in here;
	 * it joins the registry under its own name, after the figure tools. Add its name to ASK_TOOL_NAMES, write its prompt
	 * fragment under prompts/ask/ and give it a condition in agent/ask-prompt.ts ASK_FRAGMENT_CONDITIONS, so the prompt
	 * mentions it only when it is offered. Not built: always absent.
	 */
	glossary?: AgentTool<any>;
	/** WP8: the class tools (agent/tools/class-facts.ts classFactsTools over server/assessments.ts classFactsPort): the
	 *  quizzes and exams the learner states, and what they say they know. Absent (bare agents, tests) = none. */
	classFacts?: Record<string, AgentTool<any>>;
}

/** The figure tools' descriptions in Ask's terms (an answer, not a question to write options for). */
const ASK_FIGURE_GUIDE_DESCRIPTION =
	"Returns the full syntax, rules and examples of one figure family (```blocks block diagrams, ```plot graphs, ```circuit schematics, " +
	"```logic gates and flip-flops, ```timing timing diagrams). Call it before writing your first figure of a family in this conversation.";
const ASK_CIRCUIT_SOLVE_DESCRIPTION =
	"Solve a ```circuit netlist: DC node voltages, element currents and powers, equivalent resistance, and transient values after " +
	"its switches move at t = 0. Use it before you state a circuit's values.";

/** The Ask agent's own tools (everything but the lookups, which ride `opts.materials`). `messages` reads the run's live
 *  history, so a figure delivered earlier in this run is found by show_figure. */
export function askTools(ctx: AskAgentContext, messages: () => readonly unknown[], toggles?: AgentBuildOptions["toolToggles"]): Record<string, AgentTool<any>> {
	// visual and demo stay behind the learner's job-tool toggles, like the teacher's (core/pending.ts TOGGLEABLE_TOOLS)
	const jobs = ctx.jobs ? filterEnabledTools(jobTools({ ...ctx.jobs, wording: "ask" }), toggles) : {};
	return healToolRecord({
		figure_guide: { ...figureGuideTool, description: ASK_FIGURE_GUIDE_DESCRIPTION },
		circuit_solve: { ...circuitSolveTool, description: ASK_CIRCUIT_SOLVE_DESCRIPTION },
		show_figure: createShowFigureTool({ messages, description: ASK_SHOW_FIGURE_DESCRIPTION }),
		...(jobs.visual ? { visual: jobs.visual } : {}),
		...(jobs.demo ? { demo: jobs.demo } : {}),
		...(ctx.glossary ? { [ctx.glossary.name]: ctx.glossary } : {}),
		...(ctx.classFacts ?? {}),
	});
}

/** Build the Ask agent for one turn. The handler passes the same build options every conversation agent gets: the
 *  session's own engine (the teacher's model slot), materials, course section, language. `opts.tools` (tests) replaces
 *  the registry outright, as for the other agents. The prompt is told exactly which tools this turn offers. */
export function createAskAgent(ctx: AskAgentContext, opts: AgentBuildOptions = {}) {
	let live: () => readonly unknown[] = () => opts.messages ?? [];
	const tools = opts.tools ?? askTools(ctx, () => live(), opts.toolToggles);
	const own = Object.values(tools);
	const offered = [...own, ...(opts.materials?.tools ?? []), ...(opts.course?.tools ?? [])].map((t) => t.name);
	const agent = baseAgentOptions("ask", { ...opts, askTools: offered }, own);
	live = () => agent.state.messages;
	return agent;
}

export type AskAgent = ReturnType<typeof createAskAgent>;
