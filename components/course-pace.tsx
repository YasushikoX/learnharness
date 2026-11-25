"use client";

import { useState } from "react";
import { PACES, isPace, paceInfo, type Pace } from "@/src/core";
import { ThinSelect } from "@/components/settings/controls";

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

	// A course-settings row (UI round 1b, SPEC §7 "Settings"): label and description left, the one select style right.
	return (
		<CourseSettingRow
			testid="course-pace"
			label="Pace"
			description="How fast this course's lessons go. A Learn start can still pick its own."
			note={error && <span role="alert" className="text-destructive">{error}</span>}
		>
			<span className="w-44 max-sm:w-full">
				<ThinSelect testid="course-pace-select" ariaLabel="course default pace" value={pace ?? ""} onChange={(v) => void save(v)}>
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
 * One row of the course settings (UI round 1b, SPEC §7 "Settings"): the label (14/500) and a 13px muted description on
 * the left, the controls right-aligned on the same line; under 640px the controls drop below. `note` is a line under the
 * row (an error, what the last weighing found).
 */
export function CourseSettingRow({
	label,
	description,
	note,
	testid,
	children,
}: {
	label: string;
	description?: React.ReactNode;
	note?: React.ReactNode;
	testid?: string;
	children?: React.ReactNode;
}) {
	return (
		<section data-testid={testid} className="py-3">
			<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
				<div className="min-w-0">
					<div className="text-body font-medium text-foreground">{label}</div>
					{description && <div className="mt-0.5 text-sm text-muted-foreground">{description}</div>}
				</div>
				{children && <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">{children}</div>}
			</div>
			{note && <div className="mt-1.5 text-meta">{note}</div>}
		</section>
	);
}
