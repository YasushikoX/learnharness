"use client";

import { ToolContentResponse } from "@/components/ai-elements/message";
import { GlyphMark } from "@/components/ui/glyph-mark";
import { useLessonLabels } from "@/components/lesson-language";
import { cn } from "@/lib/utils";

/**
 * An answered written question's key points (WP6, 2026-11-25 — core/question-quality.ts), under the committed answer.
 * The card renders only after the answer, so they are never shown before it. `met` is the tutor's verdict per point,
 * recorded on its next question (`previousKeyPoints`): with it, each point is marked in or missing from the answer;
 * without it (the tutor has not replied yet, or recorded none) the points are listed unmarked.
 */
export function AnsweredKeyPoints({ points, met }: { points: readonly string[] | undefined; met?: ReadonlySet<number> }) {
	const labels = useLessonLabels();
	if (!points || points.length === 0) return null;
	return (
		<div className="mt-4 text-foreground" data-testid="answered-key-points" data-graded={met ? "true" : "false"}>
			<div className="mb-1 lh-eyebrow text-muted-foreground">{labels.keyPoints}</div>
			{/* UI round 1b (SPEC §8): markers sit on the text's first line. The points render at the reading size, so the
			    marker box is one reading line tall (a mark is centred in it; a number shares the text's font and baseline). */}
			<ol className="flex flex-col gap-1">
				{points.map((point, i) => {
					const hit = met?.has(i + 1);
					return (
						<li key={i} className={cn("flex gap-2.5", met ? "items-start" : "items-baseline")} data-key-point={met ? (hit ? "met" : "missed") : "unmarked"}>
							{met ? (
								<span aria-hidden className={cn("flex h-[calc(var(--lh-prose-size)*var(--lh-prose-leading))] shrink-0 items-center", hit ? "text-success" : "text-error")}>
									<GlyphMark kind={hit ? "check" : "x"} className="size-3.5" />
								</span>
							) : (
								<span aria-hidden className="lh-prose w-5 shrink-0 text-right tabular-nums text-muted-foreground">{i + 1}.</span>
							)}
							<span className={cn("min-w-0", met && !hit && "text-muted-foreground")}>
								<ToolContentResponse className="inline [&>p]:inline [&>p]:m-0">{point}</ToolContentResponse>
								{met && <span className="sr-only"> ({hit ? labels.keyPointMet : labels.keyPointMissed})</span>}
							</span>
						</li>
					);
				})}
			</ol>
		</div>
	);
}
