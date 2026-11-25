"use client";

import { ToolContentResponse } from "@/components/ai-elements/message";
import { useLessonLabels } from "@/components/lesson-language";

/**
 * The notes under a shown figure (WP6, 2026-11-25 — core/figure-notes.ts): "Look at" with the tutor's one to three
 * points, and under a demo "Try this" with one action and what to predict first. Labelled in the lesson language.
 * Renders nothing for an old show_figure call without notes.
 */
export function FigureNotes({ lookAt, tryThis }: { lookAt: readonly string[]; tryThis?: string }) {
	const labels = useLessonLabels();
	if (lookAt.length === 0 && !tryThis) return null;
	return (
		<div className="mx-auto mt-2 mb-4 max-w-full space-y-2 text-sm sm:max-w-lg" data-testid="figure-notes">
			{lookAt.length > 0 && (
				<div data-testid="figure-look-at">
					<span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{labels.lookAt}</span>
					{lookAt.length === 1 ? (
						<ToolContentResponse className="lh-prose text-muted-foreground">{lookAt[0]!}</ToolContentResponse>
					) : (
						<ul className="mt-0.5 list-disc space-y-0.5 pl-5 text-muted-foreground">
							{lookAt.map((point, i) => (
								<li key={i}>
									<ToolContentResponse className="inline [&>p]:inline [&>p]:m-0">{point}</ToolContentResponse>
								</li>
							))}
						</ul>
					)}
				</div>
			)}
			{tryThis && (
				<div data-testid="figure-try-this">
					<span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{labels.tryThis}</span>
					<ToolContentResponse className="lh-prose text-muted-foreground">{tryThis}</ToolContentResponse>
				</div>
			)}
		</div>
	);
}
