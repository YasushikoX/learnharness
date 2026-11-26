"use client";

import { useEffect, useRef } from "react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * THE INLINE CONFIRM (UI round 8, 2026-11-25; SPEC §9): a form's footer turns into one question and two answers before
 * anything is lost — "Delete Quiz 3?" (Cancel · Delete quiz) or "Discard changes?" (Keep editing · Discard). The safe
 * answer is focused, so Enter or Esc never destroys; the danger fill is on the final action only. Nothing is sent until
 * the second click.
 */

const SAFE = buttonVariants({ variant: "ghost", size: "sm" });
const DANGER = buttonVariants({ variant: "destructiveSolid", size: "sm" });
const PLAIN = buttonVariants({ variant: "secondary", size: "sm" });

export function InlineConfirm({
	question,
	confirmLabel,
	cancelLabel = "Cancel",
	danger = true,
	busy = false,
	onConfirm,
	onCancel,
	className,
	testid,
}: {
	question: string;
	confirmLabel: string;
	cancelLabel?: string;
	/** The confirm destroys something (the solid danger fill); otherwise a plain secondary. */
	danger?: boolean;
	busy?: boolean;
	onConfirm: () => void;
	onCancel: () => void;
	className?: string;
	testid?: string;
}) {
	const safe = useRef<HTMLButtonElement>(null);
	useEffect(() => safe.current?.focus(), []);
	return (
		<div
			role="group"
			aria-label={question}
			data-testid={testid}
			className={cn("flex flex-wrap items-center gap-2 rounded-md bg-raised px-2.5 py-1.5", className)}
			onKeyDown={(e) => {
				if (e.key === "Escape") {
					e.stopPropagation();
					onCancel();
				}
			}}
		>
			<span className="min-w-0 flex-1 text-chrome font-medium text-foreground">{question}</span>
			<button ref={safe} type="button" className={SAFE} onClick={onCancel} data-testid={testid ? `${testid}-cancel` : undefined}>
				{cancelLabel}
			</button>
			<button type="button" className={danger ? DANGER : PLAIN} disabled={busy} onClick={onConfirm} data-testid={testid ? `${testid}-confirm` : undefined}>
				{confirmLabel}
			</button>
		</div>
	);
}
