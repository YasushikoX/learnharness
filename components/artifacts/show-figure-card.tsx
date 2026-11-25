"use client";

import { showFigureContent, type ArtifactPartProps } from "@/src/core";
import { DemoOutputCard } from "@/components/artifacts/demo-card";
import { VisualOutputCard } from "@/components/artifacts/visual-card";
import { FigureNotes } from "@/components/artifacts/figure-notes";

/**
 * The show_figure card (owner, 2026-11-12 — src/core/figure-show.ts): a
 * finished visual or demo, shown where the tutor brought it in. The view joins
 * the figure onto the part from its hidden delivery marker by job id, so the
 * invert switch writes to that marker and every showing shares it. Nothing
 * renders while the call runs, when it was refused, or when the figure is not
 * in this chat (yet): the learner never sees a figure being made.
 */
export function ShowFigureCard({ part }: ArtifactPartProps) {
	// Whether it renders, and what it shows, is decided in core/learner-seen.ts, where the vocabulary ledger reads the same
	// decision (WP5). What to look at, and on a demo what to try (WP6): absent on calls from before it, which render as they did.
	const shown = showFigureContent(part);
	if (!shown) return null;
	const { figure, caption } = shown;
	const inverted = figure.ui?.inverted ?? false;
	const notes = { lookAt: shown.lookAt, tryThis: shown.tryThis };
	if (figure.kind === "visual") {
		return (
			<>
				<VisualOutputCard output={figure.result} messageId={figure.steerId} initialInverted={inverted} caption={caption} />
				<FigureNotes lookAt={notes.lookAt} />
			</>
		);
	}
	return (
		<div data-testid="show-figure-demo">
			<DemoOutputCard output={figure.result} messageId={figure.steerId} initialInverted={inverted} />
			{caption && (
				<p className="mt-2 text-sm text-muted-foreground" data-testid="figure-caption">
					{caption}
				</p>
			)}
			<FigureNotes lookAt={notes.lookAt} tryThis={notes.tryThis} />
		</div>
	);
}
