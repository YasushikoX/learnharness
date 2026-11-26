"use client";

import { buttonVariants } from "@/components/ui/button";
import { ErrorNotice } from "@/components/ui/error-notice";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CourseSummary } from "@/src/core";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { useInteractionLayer } from "./interaction-layers";

/**
 * Course row actions (Android phone pass, owner 2026-10-28: swiping a course row reveals the same actions as a session
 * row; course rows had no actions at all before). Rename is the sidebar's inline edit (Enter or blur commits, Esc
 * discards); Delete is a confirmation in the session delete dialog's shape, and the swipe itself never deletes
 * anything. The server routes already exist: PATCH /api/courses/[id] {title}, DELETE /api/courses/[id] (the record and
 * its material; its skills stay in the graph).
 */

export function CourseRenameRow({ course, onCommit, onCancel }: { course: CourseSummary; onCommit: (next: string) => void; onCancel: () => void }) {
	const [draft, setDraft] = useState(course.title);
	const inputRef = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		const el = inputRef.current;
		if (el) {
			el.focus();
			el.select();
		}
	}, []);
	return (
		<div data-testid="course-rename-row" className="relative mb-0.5 flex w-full items-center rounded-lg bg-accent px-3 py-1.5">
			<span className="flex w-full min-w-0 flex-col">
				<input
					ref={inputRef}
					value={draft}
					spellCheck={false}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={() => onCommit(draft)}
					onKeyDown={(e) => {
						if (e.key === "Enter") e.currentTarget.blur();
						if (e.key === "Escape") {
							e.stopPropagation(); // discard, not also the sidebar chain
							onCancel();
						}
					}}
					aria-label="Rename class"
					data-testid="course-rename-input"
					className="lh-input w-full min-w-0 truncate border-0 border-b border-border bg-transparent px-0 text-foreground outline-none"
				/>
			</span>
		</div>
	);
}

export function DeleteCourseDialog({
	course,
	onClose,
	onDeleted,
}: {
	/** The course up for deletion; null = closed. */
	course: Pick<CourseSummary, "id" | "title"> | null;
	onClose: () => void;
	onDeleted: (id: string) => void;
}) {
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const backdropDismiss = useBackdropDismiss(() => {
		if (!busy) onClose();
	});
	const rootRef = useRef<HTMLDivElement>(null);
	// Esc and the Android back close it through the shared modal layer (interaction-layers.tsx).
	useInteractionLayer({ kind: "modal", enabled: course !== null, rootRef, onClose: () => { onClose(); return "closed"; } });

	// a fresh dialog starts clean
	useEffect(() => {
		setBusy(false);
		setFailure(null);
	}, [course?.id]);

	if (!course) return null;

	const run = async () => {
		setBusy(true);
		setFailure(null);
		try {
			const res = await fetch(`/api/courses/${encodeURIComponent(course.id)}`, { method: "DELETE" });
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				setFailure(body?.error ?? `Delete failed (${res.status}).`);
				setBusy(false);
				return;
			}
			onDeleted(course.id);
		} catch {
			setFailure("Delete failed — network error. Try again.");
			setBusy(false);
		}
	};

	return createPortal(
		<div ref={rootRef} className="fixed inset-0 z-50 flex items-center justify-center lh-scrim" {...backdropDismiss}>
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Delete class"
				data-testid="delete-course-dialog"
				onClick={(e) => e.stopPropagation()}
				className="w-[27.5rem] max-w-[calc(100vw-2rem)] lh-dialog p-6"
			>
				{/* UI round 8 (SPEC §9): a 15/20 title in the text colour (the danger fill is the confirm's alone), 440px */}
				<h2 className="lh-section-title text-foreground">
					Delete <span data-testid="course-name-code">“{course.title}”</span>?
				</h2>
				<p className="mt-2 text-body text-muted-foreground">
					This removes the class and its curriculum material. Its skills stay in your knowledge graph. This cannot be
					undone.
				</p>
				{failure && <ErrorNotice className="mt-3" error={failure} what="Couldn't delete the class." onRetry={() => void run()} retrying={busy} testid="delete-course-failure" />}
				<div className="mt-4 flex justify-end gap-2">
					<button
						type="button"
						data-testid="delete-course-cancel"
						onClick={onClose}
						disabled={busy}
						className={buttonVariants({ variant: "ghost", size: "sm" })}
					>
						Cancel
					</button>
					<button
						type="button"
						data-testid="delete-course-confirm"
						onClick={() => void run()}
						disabled={busy}
						className={buttonVariants({ variant: "destructiveSolid", size: "sm" })}
					>
						{busy ? "Deleting…" : "Delete"}
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
