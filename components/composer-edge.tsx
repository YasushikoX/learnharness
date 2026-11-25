"use client";

import { createContext, useContext, type ReactNode } from "react";
import { MaterialsControl } from "@/components/materials-control";
import { LanguageControl } from "@/components/language-control";
import { PaceControl } from "@/components/pace-control";
import { DifficultyControl } from "@/components/difficulty-control";

/**
 * The composer shell's bottom edge (owner, 2026-10-25 — the bottom-bar
 * declutter, "split by scope"): what shapes the CONTENT — the lesson's
 * sources and language — and the mic sit where the learner types.
 *
 * The session's stats and the model joined it (owner, 2026-11-25: "the
 * model selection should go to the left of the microphone button. It
 * wastes so much space by pushing that entire window up"): the row that
 * used to sit beneath the shell is gone; its cluster (stats-bar.tsx
 * ToolbarStats) rides here, immediately left of the mic.
 *
 * The composer renders the edge itself (its send button closes the row);
 * the question and practice docks get the standalone row beneath them, so
 * the mic stays where it was while an answer is dictated.
 */

/** The stats + model cluster for the edge rows below this provider. The
 *  host provides it once per view, so whichever edge is mounted (the
 *  composer's, or a dock's) shows the one model control. */
export const ComposerToolbarSession = createContext<ReactNode>(null);

/** The edge's leading tools: Sources + language, as quiet edge buttons. */
export function ComposerEdgeTools({ chatId }: { chatId?: string }) {
	return (
		<>
			<MaterialsControl chatId={chatId} variant="edge" />
			<LanguageControl chatId={chatId} variant="edge" />
			{/* Pace (fork addition, 2026-11-01): a running session only; the new-session screen has its setup panel. */}
			{chatId && <PaceControl chatId={chatId} variant="edge" />}
			{/* Difficulty (fork addition, 2026-11-07): a practice session only — the mirror of pace. */}
			{chatId && <DifficultyControl chatId={chatId} variant="edge" />}
		</>
	);
}

/** The standalone edge row (beneath a dock): tools left, then the session
 *  cluster and the mic right. While recording, the mic's meter fills the
 *  free middle. `@container`: the cluster's numbers hide on a narrow row
 *  (below 38rem), and a long model id truncates. */
export function ComposerEdge({ chatId, mic, trailing, leading }: { chatId?: string; mic?: ReactNode; trailing?: ReactNode; leading?: ReactNode }) {
	const session = useContext(ComposerToolbarSession);
	return (
		<div data-testid="composer-edge" className="@container flex min-w-0 items-center gap-1">
			{/* The attach paperclip (upstream v0.5.0), first in the row. */}
			{leading}
			<ComposerEdgeTools chatId={chatId} />
			<div className="flex min-w-0 flex-1 items-center justify-end gap-1">
				{session}
				{mic}
			</div>
			{trailing}
		</div>
	);
}
