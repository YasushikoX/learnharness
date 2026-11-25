"use client";

/**
 * Finishing a course lesson (owner, 2026-10-25 — docs/courses.md): the
 * top bar's Finish lesson button, the transcript divider both finish
 * paths render (the learner's marker, the teacher's finish_lesson call),
 * and the session's course link read off the context card.
 */

import { CheckIcon, FlagIcon } from "lucide-react";
import type { CourseContextDetails, LhViewMessage } from "@/src/core";
import { Hint } from "@/components/ui/hint";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The session's course details — the graph-context card's `course`
 *  block (message[0] of a course session); undefined otherwise. */
export function courseOfView(messages: readonly LhViewMessage[]): CourseContextDetails | undefined {
	for (const m of messages) {
		for (const part of m.parts) {
			if (part.type === "data-graph-context") return (part.data as { course?: CourseContextDetails } | null)?.course;
		}
	}
	return undefined;
}

/** The centered divider: "Lesson finished · <skill> learned" — or, for
 *  every other course session (owner, 2026-10-25), "Session finished". */
export function LessonFinishedLine({ skill, lesson = true, request = false }: { skill?: string; lesson?: boolean; request?: boolean }) {
	// A Learn session's Finish press (owner, 2026-11-13) only asks for the final problem.
	if (request) {
		return (
			<div
				data-testid="finish-requested-line"
				className="my-4 flex items-center justify-center gap-1.5 lh-eyebrow text-muted-foreground"
			>
				<FlagIcon className="size-3" />
				Finish requested · final problem next
			</div>
		);
	}
	return (
		<div
			data-testid="lesson-finished-line"
			className="my-4 flex items-center justify-center gap-1.5 lh-eyebrow text-muted-foreground"
		>
			<CheckIcon className="size-3" />
			{lesson ? `Lesson finished${skill ? ` · ${skill} learned` : ""}` : "Session finished"}
		</div>
	);
}

/** The top bar's button: Finish lesson (Finish session outside Learn),
 *  then Finished ✓ (inert). */
export function FinishLessonButton({
	finished,
	blocked,
	onFinish,
	lesson = true,
}: {
	finished: boolean;
	blocked: string | null;
	onFinish: () => void;
	lesson?: boolean;
}) {
	if (finished) {
		return (
			<span
				data-testid="lesson-finished-chip"
				className="flex shrink-0 select-none items-center gap-1 whitespace-nowrap text-xs font-medium text-muted-foreground"
			>
				<CheckIcon className="size-3" />
				Finished
			</span>
		);
	}
	return (
		<Hint
			label={
				blocked ??
				(lesson
					? "Ask for the final problem — passing it finishes the lesson and makes its skill learned"
					: "Mark this session as finished — what it showed stays credited")
			}
			side="bottom"
		>
			<button
				type="button"
				data-testid="finish-lesson"
				disabled={blocked !== null}
				onClick={onFinish}
				className={cn(buttonVariants({ variant: "outline", size: "sm" }), "lh-no-drag text-muted-foreground hover:text-foreground")}
			>
				<FlagIcon aria-hidden />
				{lesson ? "Finish lesson" : "Finish session"}
			</button>
		</Hint>
	);
}
