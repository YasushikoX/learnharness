import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute, type ImageFileResult } from "../tool-execute.ts";
import { SHOW_FIGURE_TOOL, figureLabel, figuresOf } from "../../core/figure-show.ts";
import { figureNotesProblems, lookAtField, tryThisField } from "../../core/figure-notes.ts";

/**
 * show_figure (owner, 2026-11-12 — core/figure-show.ts): a finished `visual`
 * or `demo` stays hidden until the tutor calls this, in the turn whose
 * teaching it serves; the card renders at that point of the transcript
 * (the view joins the figure onto this call by job id). Teacher only, always
 * on. The figure is looked up in the chat's messages, never in data/jobs
 * (job records do not sync between devices). The result is one line: the
 * figure itself never re-enters the tutor's context.
 */

const showFigureInput = Type.Object({
	figure: Type.String({ minLength: 1, description: "The figure's job id, from its arrival message (e.g. job_mx1abc_1234abcd)" }),
	// WP6 (2026-11-25 — core/figure-notes.ts): what to look at, and on a demo what to try (checked in execute)
	lookAt: lookAtField,
	tryThis: tryThisField,
	caption: Type.Optional(Type.String({ description: "One short line shown under the figure" })),
});

const SHOW_FIGURE_DESCRIPTION =
	"Show a finished figure or demo to the learner at this point of the lesson. Finished figures stay hidden until you call this. " +
	"Call it in the turn whose explanation the figure serves, next to that teaching, so the card appears right there, before any question you ask. " +
	"figure = the job id from the figure's arrival message. `lookAt` says what to look at in it; a demo also needs `tryThis`: one thing to do and what to predict first. " +
	"Show a figure again later only when bringing it back genuinely helps.";

export interface ShowFigureDetails {
	jobId: string;
	kind: "visual" | "demo";
	caption?: string;
}

/** The Ask agent's wording (2026-11-25): an answer, not a lesson, and no questions to place it before. */
export const ASK_SHOW_FIGURE_DESCRIPTION =
	"Show a finished figure or demo to the learner at this point of the conversation. Finished figures stay hidden until you call this. " +
	"Call it next to the answer the figure belongs to. `lookAt` says what to look at in it; a demo also needs `tryThis`: one thing to do with it and what to expect before doing it. " +
	"figure = the job id from the figure's arrival message.";

/** `messages` reads the run's live history (the agent's state), so a figure delivered earlier in this run is found. */
export function createShowFigureTool(ctx: { messages: () => readonly unknown[]; description?: string }): AgentTool<typeof showFigureInput> {
	return {
		name: SHOW_FIGURE_TOOL,
		label: SHOW_FIGURE_TOOL,
		description: ctx.description ?? SHOW_FIGURE_DESCRIPTION,
		parameters: showFigureInput,
		execute: serverExecute(SHOW_FIGURE_TOOL, showFigureInput, ({ figure, caption, lookAt, tryThis }): ImageFileResult => {
			const messages = ctx.messages();
			const all = figuresOf(messages);
			const id = figure.trim();
			const found = all.get(id);
			if (!found || !found.ok) {
				const ready = [...all.values()].filter((f) => f.ok).map((f) => `${f.jobId} (${f.kind}: "${figureLabel(messages, f)}")`);
				const why = !found
					? `No finished figure or demo with id "${id}" in this lesson (a figure still being made cannot be shown yet).`
					: `Figure "${id}" could not be made, so there is nothing to show.`;
				throw new Error(`${why} ${ready.length > 0 ? `Figures you can show: ${ready.join(", ")}.` : "No figure is ready to show."}`);
			}
			// the kind is known only now, so tryThis on a demo is checked here: one error naming the field, fixed in one step
			const notes = figureNotesProblems(found.kind, { lookAt, tryThis });
			if (notes.length > 0) throw new Error(notes.join(" "));
			const trimmed = caption?.trim();
			const details: ShowFigureDetails = { jobId: found.jobId, kind: found.kind, ...(trimmed ? { caption: trimmed } : {}) };
			return { text: `Shown: figure ${found.jobId} (${found.kind}).`, details };
		}),
	};
}
