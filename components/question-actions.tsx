"use client";

import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The question and practice docks' actions row (UI round 1b, SPEC §7 "Lesson"): secondary sm tools (Camera, Sketch,
 * Hint, Tell the tutor) on the left, the keyboard hint as one quiet line in the free middle, the ONE primary lg Submit
 * on the right. The row lives in the dock's `@container/dock`: below 36rem the tools drop their labels (icon-only, the
 * label stays the accessible name) so the row never wraps.
 */

/** A dock tool: a secondary sm button (28px). */
export const DOCK_TOOL = cn(buttonVariants({ variant: "secondary", size: "sm" }), "lh-press");

/** The dock's primary Submit: lg (36px). */
export const DOCK_SUBMIT = buttonVariants({ size: "lg" });

/** "I don't know" beside the actions: a ghost sm button in the muted ink (no dashed box). */
export const DONT_KNOW_ACTION = cn(buttonVariants({ variant: "ghost", size: "sm" }), "lh-touch text-muted-foreground hover:text-foreground");

/** A tool's label: shown when the dock is wide enough, otherwise the button is its icon. */
export function DockToolLabel({ children }: { children: ReactNode }) {
	return <span className="hidden @xl/dock:inline">{children}</span>;
}

/**
 * The keyboard hint: ONE 12px muted line that never wraps. It sits after a zero-width lead in a one-line, clipped
 * wrapping flex box, so when it does not fit beside the tools it wraps whole onto the hidden second line instead of
 * breaking into a stack of words (the round-0 four-line wrap).
 */
export function DockKeyHint({ children }: { children: ReactNode }) {
	return (
		<span aria-hidden data-testid="dock-key-hint" className="flex h-4 min-w-0 flex-1 flex-wrap overflow-hidden pl-1 text-xs leading-4 whitespace-nowrap text-muted-foreground">
			<span className="h-4 w-0" />
			<span>{children}</span>
		</span>
	);
}

/** The row itself: tools left, the hint in the middle, the trailing actions (I don't know, Submit) right. */
export function DockActions({ tools, hint, trailing }: { tools?: ReactNode; hint?: ReactNode; trailing?: ReactNode }) {
	return (
		<div data-testid="dock-actions" className="flex items-center gap-2 px-4 pt-1 pb-4">
			{tools && <div className="flex shrink-0 items-center gap-1.5">{tools}</div>}
			<DockKeyHint>{hint}</DockKeyHint>
			{trailing && <div className="flex shrink-0 items-center gap-2">{trailing}</div>}
		</div>
	);
}
