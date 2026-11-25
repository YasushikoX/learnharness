/**
 * Explained figures (WP6, 2026-11-25). PURE, browser-safe.
 *
 * The owner: "One time it gave a simulator but it was not explained well, and the same goes for other visuals." So a
 * figure shown with `show_figure` carries a required `lookAt` (one to three short points: what to look at), and a demo
 * also carries `tryThis` (one action to take and what to predict before taking it). Both render under the figure,
 * labelled in the lesson language (core/lesson-labels.ts).
 *
 * `lookAt` is a schema rule. `tryThis` cannot be: the tool learns whether the figure is a demo only when it looks the
 * figure up, so its execute checks it (`figureNotesProblems`) and returns one error naming the missing field, fixed in
 * one step. The same holds for lookAt's minimum total length. Neither is a gate.
 *
 * Old transcripts carry `show_figure` calls without these fields: `figureNotesOf` returns nothing for them and the
 * card renders exactly as before.
 */

import { Type } from "typebox";

/** The least `lookAt` text, all points together, that says anything. */
export const LOOK_AT_MIN_CHARS = 10;
export const LOOK_AT_MAX_POINTS = 3;
/** The least `tryThis` that can hold an action and a prediction. */
export const TRY_THIS_MIN_CHARS = 10;

export const lookAtField = Type.Array(Type.String({ minLength: 1 }), {
	minItems: 1,
	maxItems: LOOK_AT_MAX_POINTS,
	description:
		"REQUIRED. What to look at in the figure: one to three short points, each naming a part of it and what that part shows " +
		"(e.g. \"the dashed curve: the response without feedback\"). Shown under the figure. A figure shown again needs it too; one short point can do.",
});

export const tryThisField = Type.Optional(
	Type.String({
		description:
			"REQUIRED when the figure is a demo (an interactive figure); leave it out for a still figure. One action to take and what " +
			"to predict before taking it (e.g. \"Drag the damping slider to 0. Before you do: will the overshoot grow or shrink?\"). Shown under the demo.",
	}),
);

/** What the tool returns for a call whose notes do not hold (empty = fine). `kind` is the looked-up figure's. */
export function figureNotesProblems(kind: "visual" | "demo", input: { lookAt?: unknown; tryThis?: unknown }): string[] {
	const problems: string[] = [];
	const lookAt = lookAtOf(input.lookAt);
	if (lookAt.join(" ").length < LOOK_AT_MIN_CHARS) {
		problems.push(
			`\`lookAt\` is too short: give one to three points (at least ${LOOK_AT_MIN_CHARS} characters in all), each naming a part of the figure and what it shows.`,
		);
	}
	const tryThis = typeof input.tryThis === "string" ? input.tryThis.trim() : "";
	if (kind === "demo" && tryThis.length < TRY_THIS_MIN_CHARS) {
		problems.push(
			"This figure is a demo, so `tryThis` is required: one action to take with its controls and what to predict before taking it " +
				"(e.g. \"Drag the damping slider to 0. Before you do: will the overshoot grow or shrink?\").",
		);
	}
	return problems;
}

/** The notes a persisted show_figure call carries, for the card: `tryThis` only on a demo. Empty on old records. */
export function figureNotesOf(input: unknown, kind: "visual" | "demo"): { lookAt: string[]; tryThis?: string } {
	const args = (input && typeof input === "object" ? input : {}) as { lookAt?: unknown; tryThis?: unknown };
	const tryThis = kind === "demo" && typeof args.tryThis === "string" ? args.tryThis.trim() : "";
	return { lookAt: lookAtOf(args.lookAt), ...(tryThis ? { tryThis } : {}) };
}

function lookAtOf(raw: unknown): string[] {
	// a single string is read as one point (a raw record may carry the wobble; the boundary already rejects it)
	const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
	return list.filter((p): p is string => typeof p === "string").map((p) => p.trim()).filter(Boolean).slice(0, LOOK_AT_MAX_POINTS);
}
