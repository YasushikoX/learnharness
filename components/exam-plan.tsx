"use client";

import { buttonVariants } from "@/components/ui/button";
import { FIELD_CLASS } from "@/components/ui/input";
import { createContext, useContext, useState } from "react";
import { Loader2Icon } from "lucide-react";
import { examDateLabel, forecastLine, readinessBasis, readinessStep, understandingColor, type Readiness, SKILL_WEIGHTS, WEIGHT_LABELS, type CoursePlan, type CourseMode, type CourseSkillView, type SkillWeightValue } from "@/src/core";
import { cn } from "@/lib/utils";
import { PAGE_HEAD } from "@/components/section-heads";
import { CourseSettingRow } from "@/components/course-pace";

/**
 * The exam plan on the course page (owner, 2026-11-13 — core/exam-plan.ts): today's list and the exam card (the
 * countdown, the forecast, "Weigh by exams"), the exam's settings, plus the weight chip and the hand-edit control a
 * skill row shows.
 */

/** UI round 1 (SPEC §3): ordinary actions are secondary sm Buttons; the region's one emphasised action is primary. */
const BTN = buttonVariants({ variant: "secondary", size: "sm" });
/** A course-settings action (UI round 1b): a 32px outline button, level with the date field. */
const SETTING_BTN = buttonVariants({ variant: "outline" });
/** Next up's one primary Start: 32px, the page's only solid accent. */
const BTN_HERO = buttonVariants({ className: "lh-touch" });

/** A skill's weight chip text ("w3"), shown when someone set it or it is not the default. Pure. */
export function weightChip(skill: Pick<CourseSkillView, "weight" | "weightBy">): string | null {
	return skill.weightBy !== undefined || skill.weight !== 1 ? `w${skill.weight}` : null;
}

// ─── the hand edit, reached by the skill rows through a context ─────────────

/** Set (0-3) or clear (null) one skill's exam weight; absent outside a course page. */
export const WeightEditContext = createContext<((skillId: string, weight: SkillWeightValue | null) => void) | null>(null);

export function WeightChip({ skill }: { skill: Pick<CourseSkillView, "id" | "weight" | "weightBy"> }) {
	const text = weightChip(skill);
	if (!text) return null;
	return (
		<span data-testid={`weight-chip-${skill.id}`} title={`Exam weight ${skill.weight}: ${WEIGHT_LABELS[skill.weight as SkillWeightValue] ?? ""}`} className="rounded-sm border border-border px-1.5 text-meta font-medium text-muted-foreground">
			{text}
		</span>
	);
}

/** In a skill's detail: "Exam weight", the 0-3 buttons to change it, and a few words on what the weight means (Reset
 *  returns a hand edit to the default). The evidence behind it is the WeightNote. */
export function WeightEditor({ skill }: { skill: Pick<CourseSkillView, "id" | "weight" | "weightBy" | "priority"> }) {
	const edit = useContext(WeightEditContext);
	const meaning = WEIGHT_LABELS[skill.weight as SkillWeightValue] ?? "";
	return (
		<div className="flex flex-wrap items-center gap-x-2 gap-y-1.5" data-testid={`weight-editor-${skill.id}`}>
			<span className="text-muted-foreground">Exam weight</span>
			{edit ? (
				<span className="flex items-center gap-1" role="group" aria-label="Exam weight">
					{SKILL_WEIGHTS.map((w) => (
						<button key={w} type="button" aria-pressed={skill.weight === w} className={cn(BTN, "min-w-7 px-2", skill.weight === w && "border-foreground bg-foreground text-background")} data-testid={`weight-${skill.id}-${w}`} onClick={() => edit(skill.id, w as SkillWeightValue)}>
							{w}
						</button>
					))}
				</span>
			) : (
				<span className="font-medium text-foreground">{skill.weight}</span>
			)}
			<span className="text-muted-foreground">
				{meaning}
				{skill.priority > skill.weight ? ` · counts as ${skill.priority}` : ""}
			</span>
			{edit && skill.weightBy === "learner" && (
				<button type="button" className={BTN} data-testid={`weight-${skill.id}-reset`} onClick={() => edit(skill.id, null)}>
					Reset
				</button>
			)}
		</div>
	);
}

/** The evidence behind a skill's weight in words (what set it, why it counts higher, the model's reason): the full
 *  sentence behind the compact control, shown under "More". */
export function WeightNote({ skill }: { skill: Pick<CourseSkillView, "id" | "weight" | "weightBy" | "weightReason" | "priority"> }) {
	return (
		<p className="text-muted-foreground" data-testid={`weight-note-${skill.id}`}>
			Exam weight {skill.weight} · {WEIGHT_LABELS[skill.weight as SkillWeightValue] ?? ""}
			{skill.weightBy === "learner" ? " · set by you" : skill.weightBy === "model" ? " · from the sources" : " · not weighed"}
			{skill.priority > skill.weight ? ` · counts as ${skill.priority} because later skills build on it` : ""}
			{skill.weightReason ? ` · ${skill.weightReason}` : ""}
		</p>
	);
}

// ─── the section ────────────────────────────────────────────────────────────

/** UI round 1b (SPEC §7 "Course page"): Next up is the page's one dominant card (20-24px padding, the next task as a
 *  16/22 semibold title with the page's ONE primary Start; every other row quiet, on hairlines). The exam card is
 *  compact and supporting: 16px padding, the countdown as the big number, 12px meta lines. */
const HERO_CARD = "min-w-0 rounded-lg border border-border bg-card p-5 sm:p-6";
const SIDE_CARD = "flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-4";
/** A part inside the Next up box ("Learn today", "More to learn"): below the box heading, above its rows. */
const BOX_HEAD = "pt-3 text-meta font-medium text-muted-foreground";
/** One quiet row of the Next up box: 14px text, a secondary sm button, a hairline between rows. */
const ROW = "flex min-h-11 items-center justify-between gap-3 py-1.5 text-body";
/** The hero's title (SPEC: 16/22 semibold). */
const HERO_TITLE = "text-lg leading-[22px] font-semibold";
/** How many more next-up skills the box lists after today's lessons. */
export const MORE_NEXT_UP = 4;

/** The exam card's big figure: "30 d", "today", "passed". Pure. */
export function examCountdown(daysLeft: number): string {
	if (daysLeft > 0) return `${daysLeft} d`;
	return daysLeft === 0 ? "today" : "passed";
}

/** A "a · b · c" line whose middots stay on the line before them (a no-break space in front), so a narrow card wraps
 *  after "·", never before it (UI round 1b, SPEC §8: no line starts with a middot). Pure. */
export function keepMiddots(line: string): string {
	return line.replace(/ · /g, " · ");
}

/** "27 skills left", "1 skill left". Pure. */
export function skillsLeftLabel(skillsLeft: number): string {
	return skillsLeft === 1 ? "1 skill left" : `${skillsLeft} skills left`;
}

/**
 * The exam readiness score (owner, 2026-11-14, core/exam-plan.ts examReadiness): the percent, one bar with a tick where the
 * foundation and the most tested skills end, and what the score rests on.
 */
function ReadinessStrip({ readiness }: { readiness: Readiness }) {
	const percent = Math.round(readiness.score * 100);
	const key = Math.round(readiness.key * 100);
	return (
		<div className="space-y-1.5" data-testid="course-exam-readiness">
			<div className="flex items-baseline justify-between gap-2 text-sm">
				<span className="text-muted-foreground">Readiness</span>
				<span className="font-semibold tabular-nums">{percent}%</span>
			</div>
			<span role="meter" aria-label="Exam readiness" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="relative block h-1.5 w-full rounded-full bg-secondary">
				<span className="block h-full rounded-full" style={{ width: `${percent}%`, backgroundColor: understandingColor(readinessStep(readiness.score, readiness.key)) ?? "var(--lh-understanding-1)" }} />
				<span aria-hidden className="absolute -top-1 block h-3.5 w-px bg-foreground/70" style={{ left: `${key}%` }} data-testid="course-exam-readiness-key" />
			</span>
			<div className="flex items-baseline justify-between gap-2 text-meta text-muted-foreground">
				<span>{readinessBasis(readiness)}</span>
				<span>key skills {key}%</span>
			</div>
		</div>
	);
}

/** The exam date's PATCH and the Weigh by exams POST, shared by the card and the settings. */
export function useExamActions(courseId: string, onChanged: () => void) {
	const [error, setError] = useState<string | null>(null);
	const [starting, setStarting] = useState(false);

	const patch = async (body: unknown): Promise<boolean> => {
		setError(null);
		try {
			const res = await fetch(`/api/courses/${courseId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
			if (!res.ok) {
				setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `rejected (${res.status})`);
				return false;
			}
			onChanged();
			return true;
		} catch {
			setError("Could not reach the server — try again.");
			return false;
		}
	};
	const weigh = async () => {
		setError(null);
		setStarting(true);
		try {
			const res = await fetch(`/api/courses/${courseId}/weigh`, { method: "POST" });
			if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `could not start (${res.status})`);
		} catch {
			setError("Could not reach the server — try again.");
		} finally {
			setStarting(false);
			onChanged();
		}
	};
	return { error, starting, patch, weigh };
}

export interface ExamPlanSectionProps {
	courseId: string;
	plan: CoursePlan;
	/** Skill names by id, for the lessons. */
	names: ReadonlyMap<string, string>;
	weightOf: (skillId: string) => number;
	/** Next up, by exam priority (the course view's nextUp): the box lists the first few not already in today's lessons. */
	nextUp: readonly string[];
	/** Learned skills not yet known: the box offers to practice them together when there are several. */
	learningCount: number;
	examDate?: string;
	/** The exam readiness score, null while the course has not been weighed (core/exam-plan.ts examReadiness). */
	readiness: Readiness | null;
	/** The course has been weighed (a weighing pass ran), not just edited by hand. */
	hasWeights: boolean;
	weightsError?: string;
	weighing: boolean;
	/** Drafting, no curriculum, or a request in flight: the pass cannot start. */
	canWeigh: boolean;
	busy: boolean;
	onStart: (mode: CourseMode, skillId?: string) => void;
	/** Start a placement RETEST (owner, 2026-11-16); the row shows when `plan.retestCount` > 0. */
	onRetest?: () => void;
	onChanged: () => void;
	/** What sits between Next up and the exam card: the class's recent sessions (UI class page, 2026-11-25). */
	afterNextUp?: React.ReactNode;
}

/**
 * Next up and the exam, side by side (owner, 2026-11-14). Next up holds the review due, today's lessons (to hold the
 * pace), the next few skills by exam priority and, with several skills still being learned, one row to practice them
 * together, each with its own button so a bulk session starts without opening a row; it is left out when there is
 * nothing to do. The exam card shows the countdown, the skills left and the forecast. With
 * no exam date it holds the date field; with an exam date the field and Clear sit in the course settings. Before the
 * course is weighed the card holds "Weigh by exams"; afterwards it says so in one line and "Weigh again" is a setting.
 */
export function ExamPlanSection(props: ExamPlanSectionProps) {
	const { courseId, plan, names, weightOf, nextUp, learningCount, examDate, readiness, hasWeights, weightsError, weighing, canWeigh, busy, onStart, onRetest, onChanged, afterNextUp } = props;
	const { error, starting, patch, weigh } = useExamActions(courseId, onChanged);

	const f = plan.forecast;
	const more = nextUp.filter((id) => !plan.lessons.includes(id)).slice(0, MORE_NEXT_UP);
	const practiceAll = learningCount > 1;
	const retest = (plan.retestCount ?? 0) > 0 && onRetest !== undefined;
	const boxHasItems = plan.reviewDue > 0 || plan.lessons.length > 0 || more.length > 0 || practiceAll || retest;
	const learnRow = (id: string, testid: string) => (
		<div key={id} className={ROW} data-testid={testid}>
			<span className="min-w-0 flex-1 line-clamp-2 break-words sm:line-clamp-none sm:block sm:truncate">
				{names.get(id) ?? id}
				{weightOf(id) !== 1 && <span className="ml-2 text-meta text-muted-foreground">w{weightOf(id)}</span>}
			</span>
			<button type="button" className={BTN} disabled={busy} onClick={() => onStart("learn", id)}>
				Learn
			</button>
		</div>
	);
	// The hero: the review when one is due, else the first lesson to take (today's, else the next by exam priority). It
	// carries the page's one primary Start; everything after it is a quiet row.
	const heroLesson = plan.reviewDue > 0 ? undefined : (plan.lessons[0] ?? more[0]);
	const heroIsToday = heroLesson !== undefined && plan.lessons[0] === heroLesson;
	const todayRows = plan.lessons.filter((id) => id !== heroLesson);
	const moreRows = more.filter((id) => id !== heroLesson);
	const fading = plan.reviewFading ?? 0;
	return (
		// UI round 2: Next up first, at full width (the page's one dominant card). UI class page: then the recent sessions,
		// then the exam card.
		<section data-testid="course-exam-plan" className="grid items-start gap-6">
			{boxHasItems && (
				<div data-testid="course-next-up" className={HERO_CARD}>
					<div className={PAGE_HEAD}>Next up</div>
					{plan.reviewDue > 0 && (
						<div className="flex items-center justify-between gap-4 pb-4" data-testid="course-today-review">
							<span className="min-w-0">
								<span className={cn(HERO_TITLE, "flex items-center gap-2")}>
									<span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: "var(--lh-due)" }} />
									<span className="whitespace-nowrap">{plan.reviewBatch < plan.reviewDue ? `Review · ${plan.reviewBatch} of ${plan.reviewDue}` : `Review · ${plan.reviewDue}`}</span>
								</span>
								{fading > 0 && (
									<span className="mt-0.5 block pl-4 text-sm text-muted-foreground" data-testid="course-review-fading">
										{`${fading} fading before the exam`}
									</span>
								)}
							</span>
							<button type="button" className={BTN_HERO} disabled={busy} onClick={() => onStart("review")}>
								Start
							</button>
						</div>
					)}
					{heroLesson !== undefined && (
						<div data-testid={heroIsToday ? "course-today" : "course-next-more"}>
							<div className="flex items-center justify-between gap-4 pb-4" data-testid={heroIsToday ? `course-today-lesson-${heroLesson}` : `course-next-more-${heroLesson}`}>
								<span className="min-w-0">
									<span className="block text-meta font-medium text-muted-foreground">{heroIsToday ? "Learn today" : "More to learn"}</span>
									<span className={cn(HERO_TITLE, "mt-0.5 block line-clamp-2 break-words")}>
										{names.get(heroLesson) ?? heroLesson}
										{weightOf(heroLesson) !== 1 && <span className="ml-2 text-meta font-normal text-muted-foreground">w{weightOf(heroLesson)}</span>}
									</span>
								</span>
								<button type="button" className={BTN_HERO} disabled={busy} aria-label={`Start learning ${names.get(heroLesson) ?? heroLesson}`} onClick={() => onStart("learn", heroLesson)}>
									Start
								</button>
							</div>
						</div>
					)}
					<div className="divide-y divide-border border-t border-border empty:hidden">
						{todayRows.length > 0 && (
							<div data-testid={heroIsToday ? "course-today-rest" : "course-today"}>
								<div className={BOX_HEAD}>Learn today</div>
								<div className="divide-y divide-border">{todayRows.map((id) => learnRow(id, `course-today-lesson-${id}`))}</div>
							</div>
						)}
						{moreRows.length > 0 && (
							<div data-testid={heroLesson !== undefined && !heroIsToday ? "course-next-more-rest" : "course-next-more"}>
								<div className={BOX_HEAD}>More to learn</div>
								<div className="divide-y divide-border">{moreRows.map((id) => learnRow(id, `course-next-more-${id}`))}</div>
							</div>
						)}
						{retest && (
							<div className={ROW} data-testid="course-next-retest">
								<span>Retest what I know · {plan.retestCount} to check</span>
								<button type="button" className={BTN} disabled={busy} onClick={() => onRetest?.()}>
									Retest
								</button>
							</div>
						)}
						{practiceAll && (
							<div className={ROW} data-testid="course-next-practice">
								<span>Practice · {learningCount} learning</span>
								<button type="button" className={BTN} disabled={busy} onClick={() => onStart("practice")}>
									Practice
								</button>
							</div>
						)}
					</div>
				</div>
			)}
			{afterNextUp}
			{/* UI class page: the lecture notes moved to the class side panel; the exam card has the row to itself. */}
			<div className="min-w-0" data-testid="course-exam-column">
				<div className={SIDE_CARD}>
					<div className="lh-section-title text-foreground">Exam</div>
					{examDate ? (
						<div className="flex flex-wrap items-baseline gap-x-2" data-testid="course-exam-countdown">
							<span className="lh-big-number">{examCountdown(plan.daysLeft ?? 0)}</span>
							<span className="whitespace-nowrap text-sm text-muted-foreground">{examDateLabel(examDate)}</span>
						</div>
					) : (
						<input
							type="date"
							aria-label="Exam date"
							data-testid="course-exam-date"
							value=""
							onChange={(e) => void patch({ examDate: e.target.value === "" ? null : e.target.value })}
							className={cn(FIELD_CLASS, "h-8 w-fit px-2.5")}
						/>
					)}
					{readiness && <ReadinessStrip readiness={readiness} />}
					<div className="space-y-1 text-meta text-muted-foreground empty:hidden">
						{(examDate || plan.skillsLeft > 0) && <p data-testid="course-plan-headline">{skillsLeftLabel(plan.skillsLeft)}</p>}
						{f && (
							<p className={cn(f.status === "behind" && "text-warning")} data-testid="course-plan-forecast">
								{keepMiddots(forecastLine(f))}
							</p>
						)}
						{(weighing || starting) && (
							<span className="flex items-center gap-1.5" data-testid="course-weighing">
								<Loader2Icon className="size-3.5 animate-spin" />
								Reading the exams…
							</span>
						)}
						{hasWeights && !weighing && <p data-testid="course-weights-summary">Skills weighed by exam importance.</p>}
						{!hasWeights && !weighing && !starting && <p data-testid="course-exam-readiness-prompt">Weigh by exams to get a readiness score.</p>}
					</div>
					{!hasWeights && (
						<button type="button" className={cn(BTN, "w-fit")} disabled={!canWeigh || weighing || starting || busy} data-testid="course-weigh-button" onClick={() => void weigh()}>
							Weigh by exams
						</button>
					)}
					{weightsError && !weighing && (
						<p className="text-meta text-error" data-testid="course-weights-error">
							Weighing failed: {weightsError}
						</p>
					)}
					{error && <p className="text-meta text-error">{error}</p>}
				</div>
			</div>
		</section>
	);
}

/**
 * The exam's settings, in the class side panel (UI class page, 2026-11-25; before, in the Course settings card): the date with Clear once one is set (before that the exam
 * card holds the field), and "Weigh again" once the course is weighed (before that the exam card holds "Weigh by
 * exams"), with what the weighing found.
 */
export function ExamSettings(props: Pick<ExamPlanSectionProps, "courseId" | "examDate" | "hasWeights" | "weighing" | "canWeigh" | "busy" | "onChanged"> & { weightsSummary?: string; weightsAt?: string }) {
	const { courseId, examDate, hasWeights, weighing, canWeigh, busy, onChanged, weightsSummary, weightsAt } = props;
	const { error, starting, patch, weigh } = useExamActions(courseId, onChanged);
	if (!examDate && !hasWeights) return null;
	return (
		<CourseSettingRow
			testid="course-exam-settings"
			label="Exam"
			stacked
			description={
				hasWeights && weightsSummary ? (
					<p className="truncate" title={weightsSummary} data-testid="course-weights-found">
						Last weighing{weightsAt ? ` (${weightsAt.slice(0, 10)})` : ""}: {weightsSummary}
					</p>
				) : undefined
			}
			note={error ? <p className="text-error">{error}</p> : undefined}
		>
			{examDate && (
				<>
					<input
						type="date"
						aria-label="Exam date"
						data-testid="course-exam-date"
						value={examDate}
						onChange={(e) => void patch({ examDate: e.target.value === "" ? null : e.target.value })}
						className={cn(FIELD_CLASS, "h-8 w-fit px-2.5")}
					/>
					<button type="button" className={SETTING_BTN} data-testid="course-exam-date-clear" onClick={() => void patch({ examDate: null })}>
						Clear
					</button>
				</>
			)}
			{hasWeights && (
				<button type="button" className={SETTING_BTN} disabled={!canWeigh || weighing || starting || busy} data-testid="course-weigh-button" onClick={() => void weigh()}>
					Weigh again
				</button>
			)}
		</CourseSettingRow>
	);
}
