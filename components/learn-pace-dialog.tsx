"use client";

import { buttonVariants } from "@/components/ui/button";
import { useEffect, useRef, useState } from "react";
import { DEFAULT_PACE, isPace, type Pace } from "@/src/core";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { PaceRadios } from "@/components/session-setup";
import { useInteractionLayer } from "./interaction-layers";

/**
 * The pace dialog for a Learn start from a course (fork addition, 2026-11-09):
 * the course page's Learn / Learn again buttons and the chat's "Learn <skill>"
 * buttons open it before the session exists. The pick is for THIS session only:
 * it never changes the course's default or the global one. It starts on the
 * course's pace, else the global default (general.pace), else Thorough.
 * No time note here: the note lives on the course page.
 */

/** The dialog's pure body, exported for SSR pins. `pace` is null while the defaults load (Start waits). */
export function LearnPaceBody({
	pace,
	onPace,
	onClose,
	onStart,
	busy = false,
}: {
	pace: Pace | null;
	onPace: (pace: Pace) => void;
	onClose: () => void;
	onStart: () => void;
	busy?: boolean;
}) {
	const backdropDismiss = useBackdropDismiss(onClose);
	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="How fast do you want to go?"
			data-testid="learn-pace-dialog"
			className="fixed inset-0 z-50 flex items-center justify-center lh-scrim"
			{...backdropDismiss}
		>
			<div className="mx-4 w-full max-w-sm lh-dialog p-6" onClick={(e) => e.stopPropagation()}>
				{/* UI round 1b (SPEC §3 dialogs): a 15/600 title, 32px buttons, Cancel ghost, the dialog's one primary action. */}
				<h2 className="lh-section-title text-card-foreground">How fast do you want to go?</h2>
				<div className="mt-4">
					<PaceRadios pace={pace} onPace={onPace} />
				</div>
				<p className="mt-3 text-sm text-muted-foreground">This lesson only. The course and Settings keep their own defaults.</p>
				<div className="mt-6 flex justify-end gap-2">
					<button type="button" data-testid="learn-pace-cancel" onClick={onClose} className={buttonVariants({ variant: "ghost" })}>
						Cancel
					</button>
					<button
						type="button"
						data-testid="learn-pace-start"
						disabled={pace === null || busy}
						onClick={onStart}
						className={buttonVariants()}
					>
						Start lesson
					</button>
				</div>
			</div>
		</div>
	);
}

export function LearnPaceDialog({
	courseId,
	onClose,
	onStart,
	busy = false,
}: {
	courseId: string;
	onClose: () => void;
	/** The picked pace for the new session. */
	onStart: (pace: Pace) => void;
	busy?: boolean;
}) {
	const [pace, setPace] = useState<Pace | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	// Esc and the Android back close it through the shared modal layer (interaction-layers.tsx).
	useInteractionLayer({ kind: "modal", enabled: true, rootRef, onClose: () => { onClose(); return "closed"; } });

	useEffect(() => {
		let alive = true;
		const course = fetch(`/api/courses/${courseId}`)
			.then((r) => r.json() as Promise<{ course?: { pace?: unknown } }>)
			.then((b) => (isPace(b.course?.pace) ? b.course.pace : undefined))
			.catch(() => undefined);
		const general = fetch("/api/settings")
			.then((r) => r.json() as Promise<{ settings: { general?: { pace?: unknown } } | null }>)
			.then((b) => (isPace(b.settings?.general?.pace) ? b.settings.general.pace : undefined))
			.catch(() => undefined);
		void Promise.all([course, general]).then(([c, g]) => {
			if (alive) setPace((current) => current ?? c ?? g ?? DEFAULT_PACE);
		});
		return () => {
			alive = false;
		};
	}, [courseId]);

	return (
		<div ref={rootRef} className="contents">
			<LearnPaceBody pace={pace} onPace={setPace} onClose={onClose} onStart={() => pace && onStart(pace)} busy={busy} />
		</div>
	);
}
