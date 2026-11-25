import { effectivePromptSegments } from "./prompt-segments.ts";
import { DEFAULT_LESSON_LANGUAGE, lessonLanguageInfo, type LessonLanguage } from "../core/language.ts";
import type { TurnSources } from "../core/materials.ts";

/**
 * The Ask agent's system prompt (2026-11-25, review 1 prompt assessment; agent/ask-agent.ts). Composed from its own
 * editable fragments (prompts/ask/, listed in the prompt editor) and nothing from shared/: those fragments are written for
 * lessons. A fragment that is about one source or tool composes only when this turn has it, so the prompt never sends
 * the model to a tool it lacks (a selection clarification has none). Then, generated per turn: the material and
 * lecture-note sections written for Ask (server/materials.ts), the course section, the line naming the sources this
 * conversation can check, and Ask's own language section with the fixed wording in the course's language.
 */

/** What this turn offers: the tool names in the registry, and which kinds of source the class has. */
export interface AskPromptCapabilities {
	tools: readonly string[];
	sources: TurnSources;
}

/** When each conditional fragment composes; a fragment not listed always does. One entry per conditional file. */
export const ASK_FRAGMENT_CONDITIONS: Readonly<Record<string, (c: AskPromptCapabilities) => boolean>> = {
	"ask/21-class-material.md": (c) => c.tools.includes("material_search"),
	"ask/22-lecture-notes.md": (c) => c.tools.includes("lecture_note_search"),
	"ask/23-no-sources.md": (c) => !c.sources.pdf && !c.sources.other && !c.sources.notes,
	"ask/24-no-tools.md": (c) => c.tools.length === 0,
	"ask/30-figure-blocks.md": (c) => c.tools.includes("figure_guide"),
	"ask/31-circuits.md": (c) => c.tools.includes("circuit_solve"),
	"ask/32-visual.md": (c) => c.tools.includes("visual"),
	"ask/33-demo.md": (c) => c.tools.includes("demo"),
};

/** The fixed wording of the grounding rules, per course language (every language the fork supports). */
export const ASK_WORDING: Record<LessonLanguage, { label: string; notCovered: string; unchecked: string }> = {
	en: {
		label: "Not from the class material:",
		notCovered: "The class material doesn't cover this.",
		unchecked: "I couldn't check this in the class material.",
	},
	nb: {
		label: "Ikke fra kursmaterialet:",
		notCovered: "Kursmaterialet dekker ikke dette.",
		unchecked: "Jeg fikk ikke sjekket dette i kursmaterialet.",
	},
};

/** The editable part: the Ask fragments that apply to this turn, overrides honoured. */
export function askInstructions(caps: AskPromptCapabilities, switches: Record<string, boolean> = {}): string {
	return effectivePromptSegments("ask", switches)
		.filter((s) => ASK_FRAGMENT_CONDITIONS[s.path]?.(caps) ?? true)
		.map((s) => (s.enabled ? s.overrideText! : s.sourceText).trim())
		.filter(Boolean)
		.join("\n\n---\n\n");
}

/** The line naming the sources this conversation can check. Pure. */
export function askSourcesLine(caps: AskPromptCapabilities): string {
	const { pdf, other, notes } = caps.sources;
	const material = pdf && other ? "the class's PDF and other material" : pdf ? "the class's PDF material" : other ? "the class's text material" : null;
	const parts = [material, notes ? "the learner's lecture notes" : null].filter((p): p is string => p !== null);
	const what = parts.length === 0 ? "none: the class has no material or lecture notes yet." : `${parts.join(" and ")}, listed above.`;
	const reach = caps.tools.length === 0 && parts.length > 0 ? " You cannot look anything up in this reply." : "";
	return `<ask_sources>\nSources in this conversation: ${what}${reach}\n</ask_sources>`;
}

/** Ask's language section: the lesson directive's rules that apply here, and the fixed wording in that language. */
export function askLanguageSection(language: LessonLanguage): string {
	const name = lessonLanguageInfo(language).promptName;
	const w = ASK_WORDING[language];
	return [
		"<language>",
		`Write everything the learner sees in ${name}, even when the material or the question is in another language, unless they ask you to switch. If earlier messages are in another language, continue in ${name}. Keep mathematical notation, code, and the material's own names and quoted terms as they are.`,
		`The fixed wording, in ${name}: the coverage line "${w.notCovered}" · the unchecked line "${w.unchecked}" · the general-knowledge label **${w.label}**`,
		"</language>",
	].join("\n");
}

/** The whole Ask system prompt for one turn (or one selection clarification: `caps.tools` empty). */
export function askSystemPrompt(opts: {
	caps: AskPromptCapabilities;
	switches?: Record<string, boolean>;
	language?: LessonLanguage;
	materials?: { section: string };
	course?: { section: string };
}): string {
	return [
		askInstructions(opts.caps, opts.switches),
		opts.materials?.section,
		opts.course?.section,
		askSourcesLine(opts.caps),
		askLanguageSection(opts.language ?? DEFAULT_LESSON_LANGUAGE),
	]
		.filter(Boolean)
		.join("\n\n");
}
