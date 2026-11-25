/**
 * The give-away option check (WP6, 2026-11-25). PURE, browser-safe.
 *
 * The owner: "The questions when teaching feel easy." The commonest give-away in a multiple-choice question is
 * asymmetry: the correct option is the long, careful, qualified one and the wrong options are short. The rule: a teach
 * `quiz` is refused when a correct option is longer than GIVEAWAY_MIN_CHARS characters AND more than
 * GIVEAWAY_MEDIAN_RATIO times the median length of all its options. With several correct options each is checked.
 *
 * It refuses through the teacher's shared refusal budget (agent/refusal-budget.ts), not through quizInputProblems,
 * whose problems are uncapped: after the budget is spent the question passes. Only the teacher's `quiz`: the probe,
 * the placement test and ask_user_question are never checked.
 */

import { coerceCorrectAnswer, parseOptionsIfString } from "./question-core.ts";

export const GIVEAWAY_MIN_CHARS = 40;
export const GIVEAWAY_MEDIAN_RATIO = 2.5;
/** The only tool the check applies to. */
export const GIVEAWAY_CHECKED_TOOL = "quiz";

export interface GiveawayProblem {
	/** The correct options that give themselves away, with their lengths. */
	options: { label: string; length: number }[];
	median: number;
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The problem with this call, or null. Null for any tool but the teacher's quiz and for anything it cannot read. */
export function giveawayOptionProblem(toolName: string, args: unknown): GiveawayProblem | null {
	if (toolName !== GIVEAWAY_CHECKED_TOOL || !args || typeof args !== "object") return null;
	const a = args as { options?: unknown; correctAnswer?: unknown };
	const raw = parseOptionsIfString(a.options as string | unknown[] | undefined);
	if (!Array.isArray(raw)) return null;
	const options = raw
		.filter((o): o is { label: string; value?: unknown } => !!o && typeof o === "object" && typeof (o as { label?: unknown }).label === "string")
		.map((o) => {
			const label = o.label.trim();
			return { label, key: (typeof o.value === "string" ? o.value.trim() : "") || label };
		})
		.filter((o) => o.label.length > 0);
	if (options.length < 2) return null;
	const correctAnswer = a.correctAnswer;
	if (typeof correctAnswer !== "string" && !(Array.isArray(correctAnswer) && correctAnswer.every((v) => typeof v === "string"))) return null;
	const keys = new Set(coerceCorrectAnswer(correctAnswer as string | string[], options.map((o) => o.key)));
	const mid = median(options.map((o) => o.label.length));
	const giveaways = options
		.filter((o) => keys.has(o.key) && o.label.length > GIVEAWAY_MIN_CHARS && o.label.length > GIVEAWAY_MEDIAN_RATIO * mid)
		.map((o) => ({ label: o.label, length: o.label.length }));
	return giveaways.length > 0 ? { options: giveaways, median: mid } : null;
}

const quote = (label: string) => (label.length > 60 ? `${label.slice(0, 57)}…` : label);

/** The refusal text: exactly what to change. */
export function giveawayOptionReason(problem: GiveawayProblem): string {
	const which = problem.options.map((o) => `"${quote(o.label)}" (${o.length} characters)`).join(" and ");
	return (
		`Refused: the correct option ${which} is more than ${GIVEAWAY_MEDIAN_RATIO} times as long as the median option ` +
		`(${problem.median} characters), so it can be picked by its length alone. Make every option the same length and form: ` +
		"cut the correct option down to its bare claim (the reasoning belongs in `explanation`). Do not lengthen the wrong options to match. " +
		"Then call again with the same question. Do not mention this to the learner."
	);
}
