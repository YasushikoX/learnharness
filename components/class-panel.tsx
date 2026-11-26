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
import { UpcomingList } from "@/components/upcoming-list";
import { LectureList } from "@/components/lecture-list";
import type { CourseStandingView, UpcomingView } from "@/src/core";
import type { MaterialsApi } from "@/components/use-materials";
import { DeleteCourseDialog } from "@/components/course-row-actions";
import { ErrorNotice } from "@/components/ui/error-notice";

/**
 * The class side panel (UI class page, 2026-11-25; owner: "class stuff (files, settings) goes on the side; the center
 * is for starting a session and the last sessions"). Top to bottom, calm sections on hairlines: the class's Files, the
 * Skill map (language, Draft / Re-draft and why it cannot start), the Upcoming quizzes and exams (WP8: they replace the
 * single exam-date field), the Lectures (WP9: the timeline, the class's position, from the syllabus, the file names, Short
 * question or here), the Exam (weighing), Starting point and Pace rows, the Lecture
 * notes, and a quiet Delete class… whose dialog holds the one destructive button. It replaces the Course settings card,
 * its header gear and the Sources popover. A brand-new class shows only Files and Delete class… until its first file.
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
	upcoming,
	skills = [],
	standing,
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
	exam?: Pick<ExamPlanSectionProps, "examDate" | "hasWeights" | "weighing" | "canWeigh" | "weightsError"> & { weightsSummary?: string; weightsAt?: string };
	/** WP8: the class's quizzes, exams and assignments (the old exam date included), and the syllabus pass. */
	upcoming?: UpcomingView;
	/** The approved skills, for mapping an assessment's topics. */
	skills?: ReadonlyArray<{ id: string; name: string }>;
	/** WP9: the lecture timeline and the class's position (absent before a skill map). */
	standing?: CourseStandingView;
}) {
	const [deleting, setDeleting] = useState(false);
	const map = skillMapButton({ hasSkills, hasDraft, drafting, materialCount: files.materials.length, reading: files.reading, busy });
	// A brand-new class (no file, no draft, no skill map) shows only Files and Delete class… (new-class polish,
	// 2026-11-25): the setup checklist guides the rest, and the other sections appear with the first file.
	const quiet = !hasSkills && !hasDraft && !drafting && files.materials.length === 0;
	return (
		<div className="flex flex-col divide-y divide-border" data-testid="class-panel" data-quiet={quiet ? "true" : "false"}>
			<div className="px-4 pt-3 pb-4">
				<ClassFiles files={files} dropping={dropping} setup={setup} />
			</div>

			{!quiet && (
			<>
			<section className="lh-course-controls space-y-2 px-4 py-4" data-testid="course-curriculum" aria-label="Skill map">
				<h2 className="text-body font-semibold text-foreground">Skill map</h2>
				{/* Before the first map the setup checklist owns Draft, its running state and its error (UI round 8: one
				    button, one error, not a copy here); the panel keeps the class's language. */}
				<div className="flex flex-wrap items-center gap-2">
					<LanguageControl courseId={courseId} />
					{!setup && (
						<button type="button" className={BTN} disabled={!map.enabled} aria-busy={drafting} data-testid={drafting ? "course-drafting" : "course-draft-button"} onClick={onDraft}>
							{drafting && <Loader2Icon className="animate-spin" aria-hidden />}
							{drafting ? "Drafting…" : map.label}
						</button>
					)}
				</div>
				{setup && <p className="text-meta text-muted-foreground">The checklist drafts the first skill map.</p>}
				{map.reason && !setup && (
					<p className="text-meta text-muted-foreground" data-testid="course-draft-reason">
						{map.reason}
					</p>
				)}
				{courseError && !drafting && !setup && <ErrorNotice error={courseError} what="Couldn't draft the skill map." onRetry={map.enabled ? onDraft : undefined} testid="course-error" />}
				{error && <ErrorNotice error={error} testid="course-request-error" />}
			</section>

			{upcoming && <UpcomingList courseId={courseId} upcoming={upcoming} skills={skills} busy={busy} canFind={files.materials.length > 0} onChanged={() => onChanged?.()} />}

			{standing && <LectureList courseId={courseId} standing={standing} skills={skills} busy={busy} onChanged={() => onChanged?.()} />}

			<section className="px-4 py-2.5" aria-label="Class settings" data-testid="class-settings">
				{/* the exam date itself is an item of the Upcoming list now (WP8): only the weighing stays here */}
				{exam && <ExamSettings courseId={courseId} busy={busy} onChanged={() => onChanged?.()} {...exam} examDate={upcoming ? undefined : exam.examDate} />}
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
			</>
			)}

			<div className="px-4 py-3">
				{/* UI round 8: a destructive small button on the section's edge (it read as disabled body text) */}
				<button type="button" onClick={() => setDeleting(true)} data-testid="course-delete" className={buttonVariants({ variant: "destructive", size: "sm" })}>
					Delete class…
				</button>
			</div>
			<DeleteCourseDialog course={deleting ? { id: courseId, title: courseTitle } : null} onClose={() => setDeleting(false)} onDeleted={onDeleted} />
		</div>
	);
}
