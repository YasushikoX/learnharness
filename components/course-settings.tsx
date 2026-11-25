"use client";

import { buttonVariants } from "@/components/ui/button";
import { useEffect, useState } from "react";
import { ChevronRightIcon, Loader2Icon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LessonMaterial, Pace } from "@/src/core";
import { CoursePace, CourseSettingRow } from "@/components/course-pace";
import { ExamSettings, type ExamPlanSectionProps } from "@/components/exam-plan";
import { LanguageControl } from "@/components/language-control";
import { MaterialsControl } from "@/components/materials-control";

/** UI round 1b (SPEC §3): settings actions are 32px outline buttons, level with the 32px select and date field. The
 *  Sources and language pills grow to 32px inside this panel too (.lh-course-controls in app/globals.css). */
const BTN = buttonVariants({ variant: "outline" });

/**
 * Everything about a course that is set up rarely, behind one closed line under the page header (owner, 2026-11-14):
 * pace, the curriculum (sources, language, draft the skill map), the exam date and "Weigh again", and the placement
 * test. It opens by itself while the skill map is missing, drafting, failed or waiting for review, since the
 * curriculum controls are then the whole page.
 */
export function CourseSettings({
	courseId,
	pace,
	hasSkills,
	hasDraft,
	drafting,
	courseError,
	error,
	materialCount,
	busy,
	onMaterials,
	onDraft,
	onChanged,
	onPlacement,
	exam,
	open: openProp,
	onOpenChange,
}: {
	courseId: string;
	pace: Pace | undefined;
	hasSkills: boolean;
	hasDraft: boolean;
	drafting: boolean;
	courseError?: string;
	error: string | null;
	materialCount: number;
	busy: boolean;
	onMaterials?: (materials: LessonMaterial[]) => void;
	onDraft: () => void;
	onChanged?: () => void;
	onPlacement: () => void;
	/** The exam settings' props; absent until the course has skills. */
	exam?: Pick<ExamPlanSectionProps, "examDate" | "hasWeights" | "weighing" | "canWeigh"> & { weightsSummary?: string; weightsAt?: string };
	/** Opened from the page header's gear (owner, 2026-11-16): given, the panel is controlled and shows nothing while
	 *  closed. Absent, it keeps its own closed line. */
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}) {
	const needsAttention = !hasSkills || hasDraft || drafting || !!courseError;
	const controlled = openProp !== undefined;
	const [ownOpen, setOwnOpen] = useState(needsAttention);
	const open = controlled ? openProp : ownOpen;
	const setOpen = (next: boolean) => (controlled ? onOpenChange?.(next) : setOwnOpen(next));
	useEffect(() => {
		if (needsAttention) setOpen(true);
		// only when attention is newly needed
	}, [needsAttention]);

	return (
		<details
			open={open}
			onToggle={(e) => {
				if (e.currentTarget.open !== open) setOpen(e.currentTarget.open);
			}}
			className={cn("group", open && "rounded-lg border border-border bg-card px-5 pb-2", controlled && !open && "hidden")}
			data-testid="course-settings"
		>
			<summary
				className={cn(
					"flex cursor-pointer list-none items-center justify-between gap-3 transition-colors duration-(--lh-duration-hover) ease-(--lh-ease) outline-none focus-visible:ring-2 focus-visible:ring-focus [&::-webkit-details-marker]:hidden",
					open
						? "lh-touch -mx-1 rounded-md px-1 pt-4 pb-1 lh-section-title text-foreground"
						: "h-10 rounded-lg border border-border px-4 text-sm text-muted-foreground hover:bg-raised hover:text-foreground",
				)}
			>
				<span className="flex min-w-0 items-center gap-2">
					Course settings
					{drafting && (
						<span className="flex min-w-0 items-center gap-1.5 text-meta font-normal text-muted-foreground" data-testid="course-drafting">
							<Loader2Icon className="size-3.5 shrink-0 animate-spin" />
							<span className="truncate">The course planner is reading the curriculum…</span>
						</span>
					)}
				</span>
				{open ? (
					<span className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }), "pointer-events-none text-muted-foreground")}>
						<XIcon aria-label="Close" />
					</span>
				) : (
					<ChevronRightIcon className="size-4 shrink-0" aria-hidden />
				)}
			</summary>
			<div className="lh-course-controls divide-y divide-border">
				<CoursePace courseId={courseId} pace={pace} onSaved={() => onChanged?.()} />
				<CourseSettingRow
					testid="course-curriculum"
					label="Curriculum"
					description={
						materialCount === 0 && !drafting
							? "Add the curriculum (PDFs, notes or links), then draft the skill map."
							: "What the course teaches. The course planner turns it into the skill map."
					}
					note={
						(courseError && !drafting) || error ? (
							<>
								{courseError && !drafting && (
									<p className="text-error" data-testid="course-error">
										Drafting failed: {courseError}
									</p>
								)}
								{error && <p className="text-error">{error}</p>}
							</>
						) : undefined
					}
				>
					<MaterialsControl courseId={courseId} onChange={onMaterials} />
					<LanguageControl courseId={courseId} />
					<button type="button" className={BTN} disabled={busy || drafting || materialCount === 0} data-testid="course-draft-button" onClick={onDraft}>
						{hasSkills || hasDraft ? "Re-draft skill map" : "Draft skill map"}
					</button>
				</CourseSettingRow>
				{exam && <ExamSettings courseId={courseId} busy={busy} onChanged={() => onChanged?.()} {...exam} />}
				{hasSkills && (
					<CourseSettingRow label="Starting point" description="Credit what you already know, so lessons start at your weak spots.">
						<button type="button" className={BTN} disabled={busy} data-testid="course-placement" onClick={onPlacement}>
							Placement test
						</button>
					</CourseSettingRow>
				)}
			</div>
		</details>
	);
}
