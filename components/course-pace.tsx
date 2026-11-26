"use client";

import { useState } from "react";
import { PACES, isPace, paceInfo, type Pace } from "@/src/core";
import { ThinSelect } from "@/components/settings/controls";
import { cn } from "@/lib/utils";

/**
 * A course's default pace (fork addition, 2026-11-09), beside its time note.
 * Sessions started from the course begin at this pace (a Learn start's dialog
 * can override it for that one session); "Global default" clears it, so the
 * course follows Settings. Saved on change.
 */
export function CoursePace({
	courseId,
	pace,
	globalPace,
	onSaved,
}: {
	courseId: string;
	pace: Pace | undefined;
	/** The global default's label hint; omit while unknown. */
	globalPace?: Pace;
	onSaved: () => void;
}) {
	const [error, setError] = useState<string | null>(null);

	const save = async (value: string) => {
		setError(null);
		try {
			const res = await fetch(`/api/courses/${courseId}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pace: isPace(value) ? value : null }),
			});
			if (!res.ok) {
				setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `pace rejected (${res.status})`);
				return;
			}
			onSaved();
		} catch {
			setError("Could not reach the server — try again.");
		}
	};

	// A row of the class side panel (UI class page, 2026-11-25): the label left, the one select style right; what the
	// pace means is the label's tooltip, not a line of text.
	return (
		<CourseSettingRow
			testid="course-pace"
			label="Pace"
			hint="How fast this class's lessons go. A Learn start can still pick its own."
			note={error && <span role="alert" className="text-destructive">{error}</span>}
		>
			<span className="w-40 [&>span]:w-full">
				<ThinSelect testid="course-pace-select" ariaLabel="class default pace" value={pace ?? ""} onChange={(v) => void save(v)}>
					<option value="">{`Global default${globalPace ? ` (${paceInfo(globalPace).label})` : ""}`}</option>
					{PACES.map((p) => (
						<option key={p.id} value={p.id}>
							{p.label}
						</option>
					))}
				</ThinSelect>
			</span>
		</CourseSettingRow>
	);
}

/**
 * One settings row of the class side panel (UI class page, 2026-11-25; before, a row of the Course settings card): the
 * label (13/500) left and the controls right on one line, wrapping under the label when they do not fit. `hint` is the
 * label's tooltip; `description` and `note` are 12px lines under the row (what the last weighing found, an error).
 * `stacked`: the label on its own line and the controls left-aligned under it (the exam's date, Clear, Weigh again).
 */
export function CourseSettingRow({
	label,
	hint,
	description,
	note,
	testid,
	stacked = false,
	children,
}: {
	label: string;
	hint?: string;
	stacked?: boolean;
	description?: React.ReactNode;
	note?: React.ReactNode;
	testid?: string;
	children?: React.ReactNode;
}) {
	return (
		<section data-testid={testid} className="py-1.5">
			<div className={cn("flex flex-wrap gap-x-3 gap-y-2", stacked ? "flex-col" : "items-center justify-between")}>
				<div className={cn("text-chrome font-medium text-foreground", stacked && "flex min-h-8 items-center")} title={hint}>
					{label}
				</div>
				{children && <div className={cn("flex flex-wrap items-center gap-2", !stacked && "ml-auto justify-end")}>{children}</div>}
			</div>
			{description && <div className="mt-1 min-w-0 text-meta text-muted-foreground">{description}</div>}
			{note && <div className="mt-1.5 text-meta">{note}</div>}
		</section>
	);
}
