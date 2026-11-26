"use client";

import { useState } from "react";
import { Loader2Icon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import type { Pace } from "@/src/core";
import { ClassFiles } from "@/components/class-files";
import { CoursePace, CourseSettingRow } from "@/components/course-pace";
import { ExamSettings, type ExamPlanSectionProps } from "@/components/exam-plan";
import { LanguageControl } from "@/components/language-control";
import { LectureNotesRow } from "@/components/lecture-notes-row";
import type { MaterialsApi } from "@/components/use-materials";
import { DeleteCourseDialog } from "@/components/course-row-actions";
import { cn } from "@/lib/utils";

/**
 * The class side panel (UI class page, 2026-11-25; owner: "class stuff (files, settings) goes on the side; the center
 * is for starting a session and the last sessions"). Top to bottom, calm sections on hairlines: the class's Files, the
 * Skill map (language, Draft / Re-draft and why it cannot start), the Exam, Starting point and Pace rows, the Lecture
 * notes, and a quiet Delete class… whose dialog holds the one destructive button. It replaces the Course settings card,
 * its header gear and the Sources popover.
 */

const BTN = buttonVariants({ variant: "outline" });

export interface SkillMapState {
	label: string;
	/** Can a draft start now? */
	enabled: boolean;
	/** Why it cannot (shown under the button), or null. */
	reason: string | null;
}

/** The Draft / Re-draft skill map button: its label, and when it is off, why. Pure — exported for tests. */
export function skillMapButton({
	hasSkills,
	hasDraft,
	drafting,
	materialCount,
	reading,
	busy = false,
}: {
	hasSkills: boolean;
	hasDraft: boolean;
	drafting: boolean;
	materialCount: number;
	/** Files still being read. */
	reading: number;
	busy?: boolean;
}): SkillMapState {
	const label = hasSkills || hasDraft ? "Re-draft skill map" : "Draft skill map";
	if (drafting) return { label, enabled: false, reason: null };
	if (materialCount === 0) return { label, enabled: false, reason: "Add a class file first." };
	if (reading >= materialCount) return { label, enabled: false, reason: "Waiting for the files to be read." };
	return { label, enabled: !busy, reason: null };
}

export function ClassPanel({
	courseId,
	courseTitle,
	pace,
	files,
	dropping = false,
	setup = false,
	hasSkills,
	hasDraft,
	drafting,
	courseError,
	error,
	busy,
	onDraft,
	onChanged,
	onPlacement,
	onDeleted,
	exam,
}: {
	courseId: string;
	courseTitle: string;
	pace: Pace | undefined;
	files: MaterialsApi;
	/** A file drag is over the page: the Files section shows it is the target. */
	dropping?: boolean;
	/** The empty class: the center shows the setup checklist with the large drop zone. */
	setup?: boolean;
	hasSkills: boolean;
	hasDraft: boolean;
	drafting: boolean;
	courseError?: string;
	/** The page's last request error. */
	error: string | null;
	busy: boolean;
	onDraft: () => void;
	onChanged?: () => void;
	onPlacement: () => void;
	/** The class was deleted (the dialog's confirm). */
	onDeleted: () => void;
	/** The exam settings' props; absent until the class has a skill map. */
	exam?: Pick<ExamPlanSectionProps, "examDate" | "hasWeights" | "weighing" | "canWeigh"> & { weightsSummary?: string; weightsAt?: string };
}) {
	const [deleting, setDeleting] = useState(false);
	const map = skillMapButton({ hasSkills, hasDraft, drafting, materialCount: files.materials.length, reading: files.reading, busy });
	return (
		<div className="flex flex-col divide-y divide-border" data-testid="class-panel">
			<div className="px-4 pt-3 pb-4">
				<ClassFiles files={files} dropping={dropping} setup={setup} />
			</div>

			<section className="lh-course-controls space-y-2 px-4 py-4" data-testid="course-curriculum" aria-label="Skill map">
				<h2 className="text-body font-semibold text-foreground">Skill map</h2>
				<div className="flex flex-wrap items-center gap-2">
					<LanguageControl courseId={courseId} />
					<button type="button" className={BTN} disabled={!map.enabled} data-testid="course-draft-button" onClick={onDraft}>
						{map.label}
					</button>
				</div>
				{drafting && (
					<p className="flex items-center gap-1.5 text-meta text-muted-foreground" data-testid="course-drafting">
						<Loader2Icon className="size-3.5 shrink-0 animate-spin" aria-hidden />
						Drafting the skill map…
					</p>
				)}
				{map.reason && !setup && (
					<p className="text-meta text-muted-foreground" data-testid="course-draft-reason">
						{map.reason}
					</p>
				)}
				{courseError && !drafting && (
					<p className="text-meta text-error" data-testid="course-error">
						Drafting failed: {courseError}
					</p>
				)}
				{error && <p className="text-meta text-error">{error}</p>}
			</section>

			<section className="px-4 py-2.5" aria-label="Class settings" data-testid="class-settings">
				{exam && <ExamSettings courseId={courseId} busy={busy} onChanged={() => onChanged?.()} {...exam} />}
				{hasSkills && (
					<CourseSettingRow label="Starting point" hint="Credit what you already know, so lessons start at your weak spots.">
						<button type="button" className={BTN} disabled={busy} data-testid="course-placement" onClick={onPlacement}>
							Placement test
						</button>
					</CourseSettingRow>
				)}
				<CoursePace courseId={courseId} pace={pace} onSaved={() => onChanged?.()} />
			</section>

			<div className="px-4 py-4">
				<LectureNotesRow courseId={courseId} compact />
			</div>

			<div className="px-4 py-3">
				<button
					type="button"
					onClick={() => setDeleting(true)}
					data-testid="course-delete"
					className={cn(buttonVariants({ variant: "ghost" }), "-ml-2.5 text-muted-foreground hover:text-foreground")}
				>
					Delete class…
				</button>
			</div>
			<DeleteCourseDialog course={deleting ? { id: courseId, title: courseTitle } : null} onClose={() => setDeleting(false)} onDeleted={onDeleted} />
		</div>
	);
}
