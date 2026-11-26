"use client";

import { buttonVariants } from "@/components/ui/button";
import { FIELD_CLASS } from "@/components/ui/input";
import { Children, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, InfoIcon, LockIcon, PanelRightIcon } from "lucide-react";
import {
	COURSE_MODE_LABEL,
	courseProgressPercent,
	examReadiness,
	knownShare,
	DUE_BUCKET_LABEL,
	isDue,
	KNOWN_UNDERSTANDING,
	lastsLabel,
	matchesSelection,
	MAX_UNDERSTANDING,
	NO_SELECTION,
	placementQuestionTarget,
	repairMathForDisplay,
	retrievability,
	SKILL_BAND_LABEL,
	sortByUnderstanding,
	type CourseMode,
	type CourseSkillView,
	type CourseView,
	type DraftSkill,
	type Pace,
	type PlanNodeStatus,
	type SkillSelection,
	type SkillWeightValue,
} from "@/src/core";
import { DistributionStrip, DueChip, DueTimeline, UnderstandingBar, useNow } from "@/components/skill-visuals";
import { CourseModes, SHORT_QUESTION } from "@/components/course-modes";
import { ClassPanel } from "@/components/class-panel";
import { ClassSetup } from "@/components/class-setup";
import { dragHasFiles, useMaterials, type MaterialsApi } from "@/components/use-materials";
import { Hint } from "@/components/ui/hint";
import { LearnPaceDialog } from "@/components/learn-pace-dialog";
import { ExamPlanSection, WeightEditContext, WeightEditor, WeightNote } from "@/components/exam-plan";
import { SkillMap } from "@/components/skill-map";
import { SidebarToggle } from "@/components/sidebar";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { cn } from "@/lib/utils";
import { HEAD_COUNT, PAGE_HEAD, SECTION_HEAD } from "@/components/section-heads";
import { FitTitleInput } from "@/components/fit-title-input";
import { RichLine, RichText } from "@/components/rich-text";
import { CoverageContext, CoverageSummary, DraftCoverageReview, DraftTerms, SkillTerms, type CoverageActions } from "@/components/course-coverage";

/**
 * The course page (fork addition, 2026-10-24 — docs/courses.md §6): the
 * curriculum, the planner's draft for review (ask for changes / approve),
 * and once approved the skill map, how much of it is known, and the route
 * — Review / Next up / Learning / Locked / Known — with a button for every
 * session a course can start (2026-10-25: the placement test offered first,
 * finished lessons unlock what builds on them). Everything shown is derived server-side (GET
 * /api/courses/:id); the page refetches on courses-changed and on every
 * turn settle (a concluded practice problem moves understanding).
 */

export type CoursePayload = CourseView & { drafting: boolean; weighing?: boolean };

/** A skill's state word. Pure — exported for render tests. */
export function skillStateLabel(skill: Pick<CourseSkillView, "understanding" | "learned" | "known" | "missing">): string {
	if (skill.known) return `Known · understanding ${skill.understanding}/${MAX_UNDERSTANDING} · lasts ${lastsLabel(skill.understanding)}`;
	if (skill.learned) return `Learned · understanding ${skill.understanding}/${MAX_UNDERSTANDING} · lasts ${lastsLabel(skill.understanding)}`;
	if (skill.missing.length > 0) return "Locked";
	return "Not started";
}

/** The skill map's node look: known, learned and next up white; locked gray. */
function diagramStatus(skill: CourseSkillView): PlanNodeStatus {
	if (skill.known) return "visited";
	return skill.learned || skill.missing.length === 0 ? "current" : "upcoming";
}

/** Has the learner skipped the placement offer for this course? Per-viewer
 *  convenience (localStorage) — the offer also leaves once any session exists. */
function placementSkipKey(courseId: string): string {
	return `lh:placement-skipped:${courseId}`;
}
function readPlacementSkipped(courseId: string): boolean {
	try {
		return window.localStorage.getItem(placementSkipKey(courseId)) === "1";
	} catch {
		return false;
	}
}
function writePlacementSkipped(courseId: string): void {
	try {
		window.localStorage.setItem(placementSkipKey(courseId), "1");
	} catch {
		/* the offer just comes back next visit */
	}
}

/** The first step after approval (owner, 2026-10-25): find the starting
 *  point with the quick placement test, or start from the beginning. */
function PlacementOffer({ total, busy, onTake, onSkip }: { total: number; busy: boolean; onTake: () => void; onSkip: () => void }) {
	const target = placementQuestionTarget(total);
	return (
		<section data-testid="placement-offer" className="rounded-lg border border-border bg-card p-4">
			<div className="lh-section-title">Find your starting point</div>
			<p className="mt-1 text-sm text-muted-foreground">
				A quick multiple-choice test — about {target === 1 ? "one short question" : `${target} short questions`} for {total === 1 ? "1 skill" : `${total} skills`}, hardest
				first. What you already know is credited, so you start at your weak spots instead of the most basic skill.
			</p>
			<div className="mt-3 flex flex-wrap items-center gap-2">
				<button type="button" className={BTN_PRIMARY} disabled={busy} data-testid="placement-take" onClick={onTake}>
					Take the placement test
				</button>
				<button type="button" className={BTN} disabled={busy} data-testid="placement-skip" onClick={onSkip}>
					Start from the beginning
				</button>
			</div>
		</section>
	);
}

function dueLine(skill: CourseSkillView, now = Date.now()): string | null {
	if (!skill.learned || !skill.reviewAt) return null;
	const ms = Date.parse(skill.reviewAt) - now;
	if (ms <= 0) return "due now";
	const days = Math.ceil(ms / 86_400_000);
	return days === 1 ? "due tomorrow" : `due in ${days} days`;
}

/** The due figure of the opened skill: "now", "tomorrow", "3 d", or a dash before it is learned. Pure. */
export function dueShort(skill: Pick<CourseSkillView, "learned" | "reviewAt">, now = Date.now()): string {
	if (!skill.learned || !skill.reviewAt) return "—";
	const ms = Date.parse(skill.reviewAt) - now;
	if (ms <= 0) return "now";
	const days = Math.ceil(ms / 86_400_000);
	return days === 1 ? "tomorrow" : `${days} d`;
}

/** One figure of the opened skill: a number, a one-word label and, for recall, a small meter with the 90% review line. */
function Figure({ value, label, testid, accent, meter }: { value: string; label: string; testid?: string; accent?: boolean; meter?: number | null }) {
	return (
		<div data-testid={testid} className="min-w-0">
			<div className="text-lg font-semibold leading-none tabular-nums" style={accent ? { color: "var(--lh-due)" } : undefined}>
				{value}
			</div>
			<div className="mt-1 text-xs text-muted-foreground">{label}</div>
			{meter !== undefined && meter !== null && (
				<span role="meter" aria-label="Recall" aria-valuemin={0} aria-valuemax={100} aria-valuenow={meter} className="relative mt-1.5 block h-1 rounded-full bg-border/50">
					<span className="block h-full rounded-full" style={{ width: `${meter}%`, backgroundColor: meter < 90 ? "var(--lh-due)" : "var(--lh-understanding-8)" }} />
					<span aria-hidden className="absolute -top-0.5 block h-2 w-px bg-foreground/60" style={{ left: "90%" }} />
				</span>
			)}
		</div>
	);
}

/** A prerequisite as a chip: a check when it is learned, a lock when it is not. The icon says it, not only the colour. */
function PrereqChip({ name, learned }: { name: string; learned: boolean }) {
	return (
		<span data-testid="prereq-chip" data-learned={learned ? "true" : "false"} className="inline-flex h-6 items-center gap-1 rounded-sm bg-secondary px-2 text-xs">
			{learned ? <CheckIcon role="img" aria-label="learned" className="size-3" /> : <LockIcon role="img" aria-label="not learned yet" className="size-3 text-muted-foreground" />}
			{name}
		</span>
	);
}

/** UI round 1 (SPEC §3): ordinary actions are secondary sm Buttons; the region's one emphasised action is primary. */
const BTN = buttonVariants({ variant: "secondary", size: "sm" });
const BTN_PRIMARY = buttonVariants({ size: "sm" });
/** The page header's controls (UI round 1b): 32px, the gear a quiet ghost icon button, Review a secondary button. */
const HEAD_ICON_BTN = buttonVariants({ variant: "ghost", size: "icon" }) + " text-muted-foreground hover:text-foreground";
const HEAD_BTN = buttonVariants({ variant: "secondary" });
/** A closed group's summary: a chevron instead of the browser's marker, the whole line a target. */
const DETAILS_HEAD = "lh-touch flex cursor-pointer list-none items-center gap-1.5 [&::-webkit-details-marker]:hidden";
/** Missed problems shown before "Show all" (owner, 2026-11-16). */
export const MISSED_SHOWN = 3;

/** A problem statement as one line for a list row: display math becomes inline math and line breaks become spaces, so
 *  RichLine (which renders the first line only) keeps the math instead of stopping before it. A display block that is
 *  several rows tall (a system, cases, a matrix: `\\` or `\begin`) becomes "…", so every row keeps one line's height. Pure. */
export function oneLineStatement(text: string): string {
	// encoded line breaks become real ones first (the same repair RichLine runs)
	return repairMathForDisplay(text)
		.replace(/\$\$([\s\S]+?)\$\$/g, (_, math: string) => (/\\\\|\\begin\{/.test(math) ? "…" : `$${math.replace(/\s+/g, " ").trim()}$`))
		.replace(/\s*\r?\n\s*/g, " ")
		.trim();
}
/** The page's small type for a rendered name or statement: text-xs, relaxed leading (see rich-text.tsx). */
const ITEM_TYPE = "[--lh-prose-size:var(--text-xs)] [--lh-prose-leading:1.625]";
/** A list row's rendered name (UI round 1b): the 14px body rung in the UI font, like every other row on the page. */
const ROW_NAME = "[--lh-prose-size:var(--text-body)] [--lh-prose-leading:calc(20/14)]";

/**
 * The "Choose skills" practice mode (owner, 2026-11-14): while `choosing`, a tap on a skill row ticks it instead of
 * opening it, and the rows that can be practiced (learned or next-up, not locked) can be ticked.
 */
const SkillListContext = createContext<{
	/** The learned skills' ids: a prerequisite chip shows a check for them and a lock for the rest. */
	learned: ReadonlySet<string>;
	choosing: boolean;
	chosen: ReadonlySet<string>;
	canChoose: (skillId: string) => boolean;
	toggle: (skillId: string) => void;
} | null>(null);

/** WP8: remove a self-report from a skill's detail, in the class that holds it (review 1, finding 9: a shared skill shows
 *  another class's report); resolves to an error to show, or null. Absent outside a course page. */
const SelfReportContext = createContext<((report: { id: string; courseId?: string }) => Promise<string | null>) | null>(null);

/** DELETE one self-report in the class that holds it (`fallbackCourseId` when the view names none); the error to show, or
 *  null. Exported for tests. */
export async function removeSelfReport(report: { id: string; courseId?: string }, fallbackCourseId: string, fetcher: typeof fetch = fetch): Promise<string | null> {
	try {
		const res = await fetcher(`/api/courses/${report.courseId ?? fallbackCourseId}/self-reports/${report.id}`, { method: "DELETE" });
		if (res.ok) return null;
		return ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Could not remove it (${res.status})`;
	} catch {
		return "Could not reach the server — try again.";
	}
}

/** What the learner said, as the skill shows it: "you said you know this", "…this is unclear", "…you don't get this". Pure. */
export function selfReportLabel(stance: "know" | "shaky" | "dont_know"): string {
	return stance === "know" ? "you said you know this" : stance === "shaky" ? "you said this is unclear" : "you said you don't get this";
}

/**
 * One skill, one quiet line (owner, 2026-11-14): its name, a thin understanding bar and a dot when it is due. A tap opens
 * the detail: the state line, the Learn / Practice / Quick check buttons, the exam weight and everything below.
 */
function SkillRow({
	skill,
	names,
	now,
	actions,
}: {
	skill: CourseSkillView;
	names: ReadonlyMap<string, string>;
	now: number;
	actions?: React.ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const [more, setMore] = useState(false);
	const choose = useContext(SkillListContext);
	const removeReport = useContext(SelfReportContext);
	const [reportError, setReportError] = useState<string | null>(null);
	const choosing = choose?.choosing === true;
	const can = choose?.canChoose(skill.id) === true;
	const checked = choose?.chosen.has(skill.id) === true;
	const due = dueLine(skill, now);
	const recall =
		skill.stability !== null && skill.lastReview !== null
			? Math.round(retrievability({ stability: skill.stability, lastReview: Date.parse(skill.lastReview) }, now) * 100)
			: null;
	return (
		<div className="break-inside-avoid border-b border-border" data-testid={`skill-${skill.id}`}>
			<button
				type="button"
				onClick={choosing ? () => (can ? choose?.toggle(skill.id) : undefined) : () => setOpen((o) => !o)}
				{...(choosing
					? { role: "checkbox", "aria-checked": checked, "aria-disabled": !can, "aria-label": `Choose ${skill.name}` }
					: { "aria-expanded": open, "aria-label": open ? `Collapse ${skill.name}` : `Expand ${skill.name}` })}
				className={cn(
					"lh-touch -mx-2 flex min-h-10 w-[calc(100%+1rem)] items-center gap-2 rounded-sm px-2 text-left outline-none transition-colors duration-(--lh-duration-hover) ease-(--lh-ease) hover:bg-raised focus-visible:ring-2 focus-visible:ring-focus",
					// a skill that cannot be ticked stays readable: muted text and its lock, never a faded row (SPEC §7)
					choosing && !can && "cursor-default text-muted-foreground hover:bg-transparent",
				)}
			>
				{choosing ? (
					<span aria-hidden data-testid={`choose-box-${skill.id}`} className={cn("flex size-4 shrink-0 items-center justify-center rounded-sm border", checked ? "border-foreground bg-foreground text-background" : "border-border")}>
						{checked && <CheckIcon className="size-3" />}
					</span>
				) : open ? (
					<ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
				) : (
					<ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
				)}
				<span className={cn("min-w-0 flex-1 truncate", ROW_NAME)}>
					<RichLine>{skill.name}</RichLine>
				</span>
				{skill.selfReport && (
					// WP8: a quiet marker for what the learner said (the detail says it in words, with its date)
					<span className="shrink-0 text-meta text-muted-foreground" title={selfReportLabel(skill.selfReport.stance)} data-testid={`skill-said-${skill.id}`}>
						{skill.selfReport.stance === "know" ? "said: know" : skill.selfReport.stance === "shaky" ? "said: unsure" : "said: unclear"}
					</span>
				)}
				{!skill.learned && skill.missing.length > 0 && <LockIcon role="img" aria-label="locked" data-testid={`skill-lock-${skill.id}`} className="size-3.5 shrink-0 text-muted-foreground" />}
				{isDue(skill, now) && <DueChip />}
				<span className="w-24 shrink-0">
					<UnderstandingBar skill={skill} now={now} className="mt-0" />
				</span>
			</button>
			{open && !choosing && (
				<div className="space-y-3 pt-1 pb-4 pl-5.5 text-meta" data-testid={`skill-detail-${skill.id}`}>
					{actions && <div className="flex flex-wrap items-center gap-1.5">{actions}</div>}
					{skill.learned ? (
						<div
							className="grid grid-cols-3 gap-3"
							role="group"
							aria-label={`${skillStateLabel(skill)}${due ? ` · ${due}` : ""}`}
							data-testid={`skill-figures-${skill.id}`}
						>
							<Figure value={`${skill.understanding}/${MAX_UNDERSTANDING}`} label="understanding" />
							<Figure value={recall === null ? "—" : `${recall}%`} label="recall" meter={recall} testid={`skill-recall-${skill.id}`} />
							<Figure value={dueShort(skill, now)} label="due" accent={isDue(skill, now)} />
						</div>
					) : (
						<p className="text-muted-foreground" data-testid={`skill-state-${skill.id}`}>
							{skill.missing.length > 0 ? "Locked" : "Not started"}
						</p>
					)}
					{skill.requires.length > 0 && (
						<div className="flex flex-wrap items-center gap-1.5" data-testid={`skill-needs-${skill.id}`}>
							<span className="text-muted-foreground">needs</span>
							{skill.requires.map((id) => (
								<PrereqChip key={id} name={names.get(id) ?? id} learned={choose?.learned.has(id) === true} />
							))}
						</div>
					)}
					{skill.selfReport && (
						<p className="flex flex-wrap items-center gap-x-2 text-muted-foreground" data-testid={`skill-self-report-${skill.id}`}>
							<span>
								{selfReportLabel(skill.selfReport.stance)[0]!.toUpperCase() + selfReportLabel(skill.selfReport.stance).slice(1)} ({skill.selfReport.at.slice(0, 10)})
								{skill.selfReport.chatId && (
									<>
										{" · "}
										<Link href={`/chat/${skill.selfReport.chatId}`} className="underline decoration-border underline-offset-2 hover:text-foreground">
											where
										</Link>
									</>
								)}
							</span>
							{removeReport && (
								<button
									type="button"
									className="underline decoration-border underline-offset-2 hover:text-foreground"
									data-testid={`skill-self-report-remove-${skill.id}`}
									onClick={() => {
										setReportError(null);
										void removeReport(skill.selfReport!).then(setReportError);
									}}
								>
									Remove
								</button>
							)}
							{reportError && (
								<span className="text-error" role="alert" data-testid={`skill-self-report-error-${skill.id}`}>
									{reportError}
								</span>
							)}
						</p>
					)}
					<WeightEditor skill={skill} />
					<SkillTerms skillId={skill.id} />
					<div className="max-h-[2.6rem] overflow-hidden [&_p]:line-clamp-2" data-testid={`skill-statement-${skill.id}`}>
						<RichText className={cn(ITEM_TYPE, "text-muted-foreground")}>{skill.statement}</RichText>
					</div>
					<button type="button" className="text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground" aria-expanded={more} data-testid={`skill-more-${skill.id}`} onClick={() => setMore((m) => !m)}>
						{more ? "Less ‹" : "More ›"}
					</button>
					{more && (
						<div className="space-y-2 border-t border-border/50 pt-2" data-testid={`skill-more-body-${skill.id}`}>
							<RichText className={cn(ITEM_TYPE, "text-foreground")}>{skill.statement}</RichText>
							<WeightNote skill={skill} />
							{skill.lessonNote && (
								<div className="space-y-0.5" data-testid={`skill-note-${skill.id}`}>
									<p className="text-muted-foreground">
										Last lesson ({skill.lessonNote.at.slice(0, 10)}):{" "}
										<Link href={`/chat/${skill.lessonNote.chatId}`} className="underline decoration-border underline-offset-2 hover:text-foreground">
											open
										</Link>
									</p>
									<RichText className={cn(ITEM_TYPE, "text-muted-foreground")}>{skill.lessonNote.summary}</RichText>
								</div>
							)}
							{skill.propositions.length > 0 && (
								<div className="space-y-1.5">
									<p className="text-muted-foreground">Rests on what you have learned:</p>
									{skill.propositions.map((p) => (
										<div key={p.id} className="leading-relaxed">
											<RichText className={cn(ITEM_TYPE, "font-medium text-foreground")}>{p.name}</RichText>
											<RichText className={cn(ITEM_TYPE, "text-muted-foreground")}>{p.statement}</RichText>
											{p.sessions.length > 0 && (
												<span className="block text-xs text-muted-foreground">
													from{" "}
													{p.sessions.map((s, i) => (
														<span key={s.id}>
															{i > 0 ? ", " : ""}
															<Link href={`/chat/${s.id}`} className="underline decoration-border underline-offset-2 hover:text-foreground">
																{s.title}
															</Link>
														</span>
													))}
												</span>
											)}
										</div>
									))}
								</div>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

/**
 * A group of skill rows: two columns on a wide page. The split is fixed — the first half on the left, the rest on the
 * right — so opening a row only pushes the rows below it in its own column (owner, 2026-11-16: CSS columns rebalanced
 * on every open and moved rows across). One column on a phone, in the same order.
 */
function RowList({ children }: { children: React.ReactNode }) {
	const rows = Children.toArray(children);
	const half = Math.ceil(rows.length / 2);
	return (
		<div className="md:grid md:grid-cols-2 md:items-start md:gap-x-8">
			<div className="min-w-0">{rows.slice(0, half)}</div>
			<div className="min-w-0">{rows.slice(half)}</div>
		</div>
	);
}

function DraftReview({
	data,
	busy,
	onFeedback,
	onApprove,
}: {
	data: CoursePayload;
	busy: boolean;
	onFeedback: (text: string) => void;
	onApprove: () => void;
}) {
	const draft = data.course.draft!;
	const [feedback, setFeedback] = useState("");
	const byKey = new Map(draft.skills.map((s) => [s.key, s]));
	const reusedCount = draft.skills.filter((s) => s.reuse).length;
	// A reused skill shows the draft's wording: approval writes it over the stored one (a re-wording into the course language).
	const label = (s: DraftSkill) => s.name;
	return (
		<section data-testid="course-draft" className="rounded-lg border border-border bg-card p-5">
			<div className={PAGE_HEAD}>
				Draft skill map · {draft.skills.length} skills{reusedCount > 0 ? ` · ${reusedCount} reused` : ""}
			</div>
			{draft.feedback && <p className="mb-2 text-xs text-muted-foreground">Answering: “{draft.feedback}”</p>}
			<p className="mb-3 font-prose text-(length:--lh-prose-size) leading-relaxed">{draft.summary}</p>
			{/* UI round 1b: the draft's skills as hairline rows inside the one card, not boxes in a box */}
			<ol className="mb-4 divide-y divide-border border-y border-border">
				{draft.skills.map((s) => (
					<li key={s.key} className="py-2.5" data-testid={`draft-skill-${s.key}`}>
						<div className={cn("flex items-baseline gap-2 font-medium", ROW_NAME)}>
							<RichLine>{label(s)}</RichLine>
							{s.reuse && <span className="shrink-0 rounded-sm bg-secondary px-1.5 text-xs font-normal text-muted-foreground">reused</span>}
						</div>
						<RichText className={cn(ITEM_TYPE, "text-muted-foreground")}>{s.statement}</RichText>
						<p className="mt-0.5 text-xs text-muted-foreground">
							{s.requires.length > 0 ? `Requires ${s.requires.map((k) => (byKey.get(k) ? label(byKey.get(k)!) : k)).join(", ")}` : "No prerequisites"}
							{s.restsOn.length > 0 ? ` · rests on ${s.restsOn.length} proposition${s.restsOn.length === 1 ? "" : "s"} you have learned` : ""}
							{s.cite ? ` · ${s.cite}` : ""}
						</p>
						<DraftTerms draftKey={s.key} />
					</li>
				))}
			</ol>
			<DraftCoverageReview />
			<textarea
				value={feedback}
				onChange={(e) => setFeedback(e.target.value)}
				placeholder="What should change? (split, merge, add or drop skills, prerequisites…)"
				aria-label="Changes to the draft"
				data-testid="draft-feedback"
				rows={3}
				className={cn(FIELD_CLASS, "w-full px-3 py-2 text-body")}
			/>
			<div className="mt-2 flex items-center justify-end gap-2">
				<button
					type="button"
					className={BTN}
					disabled={busy || feedback.trim() === ""}
					data-testid="draft-ask-changes"
					onClick={() => {
						onFeedback(feedback.trim());
						setFeedback("");
					}}
				>
					Ask for changes
				</button>
				<button type="button" className={BTN_PRIMARY} disabled={busy} data-testid="draft-approve" onClick={onApprove}>
					Approve
				</button>
			</div>
		</section>
	);
}

function SessionLink({ session }: { session: CourseView["sessions"][number] }) {
	return (
		<li>
			{/* UI round 1b (SPEC §8): the hover fill bleeds 8px past the column (-mx-2 on the list) so the titles sit flush
			    with the heading instead of 11px in. */}
			<Link
				href={`/chat/${session.id}`}
				className={cn(
					"flex min-h-9 items-center gap-3 rounded-sm px-2 py-1.5 text-body outline-none transition-colors duration-(--lh-duration-hover) ease-(--lh-ease) hover:bg-raised focus-visible:ring-2 focus-visible:ring-focus",
					session.finished && "text-muted-foreground",
				)}
			>
				<span className="min-w-0 flex-1 truncate">{session.title}</span>
				<span className="shrink-0 text-meta text-muted-foreground">{session.mode === "ask" ? SHORT_QUESTION : COURSE_MODE_LABEL[session.mode]}</span>
				{session.finished && <CheckIcon className="size-3.5 shrink-0 text-muted-foreground" aria-label="Finished" />}
			</Link>
		</li>
	);
}

/** Sessions the Recent sessions list shows before "Show all" (UI class page, 2026-11-25). */
export const RECENT_SESSIONS = 5;

/** The class's recent sessions (UI class page, 2026-11-25; owner: the center is for starting a session and the last
 *  sessions): a compact list under Next up, newest first as the sidebar lists them, finished ones quiet with a check;
 *  the rest behind "Show all". */
function SessionsSection({ sessions }: { sessions: CourseView["sessions"] }) {
	const [all, setAll] = useState(false);
	const shown = all ? sessions : sessions.slice(0, RECENT_SESSIONS);
	return (
		<section data-testid="course-sessions" className="min-w-0">
			<div className={PAGE_HEAD}>Recent sessions</div>
			<ul className="-mx-2" data-testid="course-sessions-list">
				{shown.map((s) => (
					<SessionLink key={s.id} session={s} />
				))}
			</ul>
			{sessions.length > RECENT_SESSIONS && (
				<button
					type="button"
					onClick={() => setAll((v) => !v)}
					aria-expanded={all}
					data-testid="course-sessions-all"
					className={cn(buttonVariants({ variant: "ghost" }), "mt-1 -ml-2.5 text-muted-foreground hover:text-foreground")}
				>
					{all ? "Show fewer" : `Show all ${sessions.length}`}
					<ChevronRightIcon className={cn("size-3.5 transition-transform", all && "-rotate-90")} aria-hidden />
				</button>
			)}
		</section>
	);
}

/** What "learned" and "known" mean: the Understanding heading's help, not a paragraph on the page. */
export const UNDERSTANDING_HELP = `Learned: a finished lesson or a placement credit; it unlocks the skills that build on it. Known: understanding ${KNOWN_UNDERSTANDING} or higher, about a month of memory, built by solving it on spaced days or a confident correct answer in the placement test.`;

/** The page body — a pure function of the payload plus callbacks (render
 *  tests drive it directly). */
export function CourseBody({
	data,
	busy,
	error,
	onDraft,
	onApprove,
	onStart,
	onRetest,
	onPracticeSet,
	materialCount,
	files,
	title,
	dropping = false,
	placementSkipped = false,
	onSkipPlacement,
	onChanged,
	onAsk,
	onCoverage,
}: {
	data: CoursePayload;
	busy: boolean;
	error: string | null;
	onDraft: (feedback?: string) => void;
	onApprove: () => void;
	onStart: (mode: CourseMode, skillId?: string) => void;
	/** Start a placement retest: only what is not learned or needs review (owner, 2026-11-16). */
	onRetest?: () => void;
	/** Start one practice session on the chosen skills ("Choose skills" mode). */
	onPracticeSet?: (skillIds: string[]) => void;
	materialCount: number;
	/** The class's files (the page's useMaterials): the empty class's drop zone uploads through it. */
	files?: MaterialsApi;
	/** The editable class name: the empty class's setup card is headed by it (the page header then shows none). */
	title?: React.ReactNode;
	/** A file drag is over the page. */
	dropping?: boolean;
	/** The learner chose "Start from the beginning" (per-viewer). */
	placementSkipped?: boolean;
	onSkipPlacement?: () => void;
	/** The exam date or a weight changed on the server: refetch. */
	onChanged?: () => void;
	/** Open the course's Ask conversation (2026-11-25): `reopen` = an existing one's chat id, absent = a new one. */
	onAsk?: (reopen?: string) => void;
	/** The vocabulary coverage actions (WP5): edits, "Map the class's terms", approve leaving terms unassigned. */
	onCoverage?: CoverageActions;
}) {
	// The map opens where the learner is: what is due, then what is next.
	const mapFocus = useMemo(
		() => (data.review.length + data.nextUp.length > 0 ? [...data.review, ...data.nextUp] : data.learning),
		[data.review, data.nextUp, data.learning],
	);
	const { course, skills } = data;
	const byId = useMemo(() => new Map(skills.map((s) => [s.id, s])), [skills]);
	const names = useMemo(() => new Map(skills.map((s) => [s.id, s.name])), [skills]);
	const nodes = useMemo(() => skills.map((s) => ({ id: s.id, title: s.name })), [skills]);
	const edges = useMemo(() => skills.flatMap((s) => s.requires.map((r) => ({ from: r, to: s.id }))), [skills]);
	const drafting = data.drafting || course.status === "drafting";
	const list = (ids: readonly string[]) => ids.map((id) => byId.get(id)).filter((s): s is CourseSkillView => s !== undefined);
	// Every skill shows once (owner, 2026-11-16): a skill from another course in its own section, a skill to review in
	// To review, the rest in Learning or Known (the counts elsewhere still read data.known / data.learning).
	const fromElsewhere = new Set(data.contextCheck);
	const toReview = new Set(data.review);
	const learning = data.learning.filter((id) => !fromElsewhere.has(id) && !toReview.has(id));
	const known = data.known.filter((id) => !fromElsewhere.has(id) && !toReview.has(id));
	const fadingCount = data.plan.reviewFading ?? 0;
	const dueNowCount = data.review.length - fadingCount;
	const [allMissed, setAllMissed] = useState(false);
	const missed = data.missed ?? [];
	// The starting-point card and the Retest row both start a placement-style test: while the card shows, only the card
	// (owner, 2026-11-16).
	// (an Ask conversation is not studying: it leaves the offer up)
	const offerPlacement = data.sessions.every((s) => s.mode === "ask") && !placementSkipped && skills.length > data.contextCheck.length;

	// The visual layer (owner, 2026-11-09; one grouped list and a Map button since 2026-11-14): the color bars read `now`; a
	// tap on a band or a review bucket narrows the list to the skills that match, sorted weakest first.
	const now = useNow();
	const [selection, setSelection] = useState<SkillSelection>(NO_SELECTION);
	const [showMap, setShowMap] = useState(false);
	// "Choose skills" (owner, 2026-11-14): tick skills, then one practice session on them. Locked skills cannot be ticked.
	const [choosing, setChoosing] = useState(false);
	const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
	const canChoose = (id: string) => {
		const s = byId.get(id);
		return s !== undefined && (s.learned || s.missing.length === 0);
	};
	const toggleChosen = (id: string) =>
		setChosen((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	const stopChoosing = () => {
		setChoosing(false);
		setChosen(new Set());
	};
	const chosenIds = [...chosen].filter(canChoose);
	const chooseCount = chosenIds.length;
	const learnedIds = useMemo(() => new Set(skills.filter((s) => s.learned).map((s) => s.id)), [skills]);
	const choose = { learned: learnedIds, choosing, chosen, canChoose, toggle: toggleChosen };
	const narrow = (next: SkillSelection) => setSelection(next);
	const narrowed = !!(selection.band || selection.bucket);
	const flat = useMemo(
		() =>
			sortByUnderstanding(
				skills.filter((s) => matchesSelection(s, selection, now)),
				true,
				now,
			),
		[skills, selection, now],
	);
	const dueNow = skills.filter((s) => isDue(s, now)).length;
	const hasWeights = !!course.skillWeights && Object.keys(course.skillWeights).length > 0;
	// A weighing pass ran (a hand edit does not set weightsAt): only then is there a readiness score (core/exam-plan.ts).
	const weighed = !!course.weightsAt;
	// WP8: readiness is about the NEXT assessment: with skills mapped to it, those skills (weighed or not); else the whole
	// class once weighed
	const nextSkills = new Set(data.plan.next?.skillIds ?? []);
	const readinessSkills = nextSkills.size > 0 ? skills.filter((s) => nextSkills.has(s.id)) : skills;
	const readiness = weighed || nextSkills.size > 0 ? examReadiness(readinessSkills.map((s) => ({ priority: s.priority, credit: knownShare(s.understanding) })), course.pastExams) : null;
	const nextUpIds = new Set(data.nextUp);
	const contextIds = new Set(data.contextCheck);
	const learnPractice = (s: CourseSkillView) => (
		<>
			<button type="button" className={cn(BTN, "lh-touch")} disabled={busy} data-testid={`learn-${s.id}`} onClick={() => onStart("learn", s.id)}>
				Learn
			</button>
			<button type="button" className={cn(BTN, "lh-touch")} disabled={busy} data-testid={`practice-${s.id}`} onClick={() => onStart("practice", s.id)}>
				Practice
			</button>
		</>
	);
	const practiceLearnAgain = (s: CourseSkillView) => (
		<>
			<button type="button" className={cn(BTN, "lh-touch")} disabled={busy} data-testid={`practice-${s.id}`} onClick={() => onStart("practice", s.id)}>
				Practice
			</button>
			<button type="button" className={cn(BTN, "lh-touch")} disabled={busy} data-testid={`learn-${s.id}`} onClick={() => onStart("learn", s.id)}>
				Learn again
			</button>
		</>
	);
	const quickCheck = (s: CourseSkillView) => (
		<button type="button" className={cn(BTN, "lh-touch")} disabled={busy} data-testid={`check-${s.id}`} onClick={() => onStart("check", s.id)}>
			Quick check
		</button>
	);
	/** A known skill can be practiced too (owner, 2026-11-14): keeping it sharp before the exam. */
	const practiceOnly = (s: CourseSkillView) => (
		<button type="button" className={cn(BTN, "lh-touch")} disabled={busy} data-testid={`practice-${s.id}`} onClick={() => onStart("practice", s.id)}>
			Practice
		</button>
	);
	/** A skill had from another course: the quick check, and practice since it is known. */
	const contextActions = (s: CourseSkillView) => (
		<>
			{quickCheck(s)}
			{practiceOnly(s)}
		</>
	);
	/** The flat list's per-row button: the same one the section the skill would sit in shows. */
	const actionsFor = (s: CourseSkillView) => {
		if (contextIds.has(s.id)) return contextActions(s);
		if (nextUpIds.has(s.id)) return learnPractice(s);
		if (s.learned && !s.known) return practiceLearnAgain(s);
		if (s.learned && s.known) return practiceOnly(s);
		return undefined;
	};
	const draftNames = new Map((course.draft?.skills ?? []).map((s) => [s.key, s.name]));
	const coverage = data.coverage ? { view: data.coverage, skillNames: names, draftNames, busy, ...(onCoverage ? { actions: onCoverage } : {}) } : null;
	// WP8: "Remove" on a skill's self-report (a tombstone; the skill's state goes back to what the evidence says), sent
	// to the class that holds it; a failure shows on the skill
	const removeReport = onChanged
		? async (report: { id: string; courseId?: string }) => {
				const error = await removeSelfReport(report, course.id);
				if (!error) onChanged();
				return error;
			}
		: null;
	return (
		<CoverageContext.Provider value={coverage}>
		<SkillListContext.Provider value={choose}>
		<SelfReportContext.Provider value={removeReport}>
		<div className="space-y-8">
			{skills.length === 0 ? (
				<>
					{/* The empty / new class (UI class page, 2026-11-25): one setup card, then Short question once there is a
					    file to ask about, and any sessions already had. Learn and Practice show once they can work. */}
					<ClassSetup
						title={title ?? <h1 className="lh-page-title">{course.title}</h1>}
						files={files}
						materialCount={materialCount}
						dropping={dropping}
						hasSkills={false}
						hasDraft={!!course.draft}
						drafting={drafting}
						courseError={course.error}
						busy={busy}
						onDraft={() => onDraft()}
					/>
					{error && <p className="text-meta text-error">{error}</p>}
					{course.draft && !drafting && <DraftReview data={data} busy={busy} onFeedback={(f) => onDraft(f)} onApprove={onApprove} />}
					{materialCount > 0 && <CourseModes data={data} busy={busy} onLearn={(id) => onStart("learn", id)} onPractice={() => onStart("practice")} onAsk={onAsk} />}
					{data.sessions.length > 0 && <SessionsSection sessions={data.sessions} />}
				</>
			) : (
				<>
					{/* Learn, Short question, Practice (2026-11-25): the ways in, at the top of the center column. */}
					<CourseModes data={data} busy={busy} onLearn={(id) => onStart("learn", id)} onPractice={() => onStart("practice")} onAsk={onAsk} />
					{course.draft && !drafting && <DraftReview data={data} busy={busy} onFeedback={(f) => onDraft(f)} onApprove={onApprove} />}
				</>
			)}

		{skills.length > 0 && (
			<>
				<ExamPlanSection
					courseId={course.id}
					plan={data.plan}
					names={names}
					weightOf={(id) => byId.get(id)?.weight ?? 1}
					nextUp={data.nextUp}
					learningCount={data.learning.length}
					examDate={data.plan.examDate}
					readiness={readiness}
					hasWeights={weighed}
					weightsError={course.weightsError}
					weighing={data.weighing === true}
					canWeigh={!drafting && materialCount > 0}
					busy={busy}
					onStart={onStart}
					onRetest={offerPlacement ? undefined : onRetest}
					onChanged={() => onChanged?.()}
					afterNextUp={data.sessions.length > 0 ? <SessionsSection sessions={data.sessions} /> : undefined}
				/>

					{offerPlacement && (
						<PlacementOffer total={skills.length - data.contextCheck.length} busy={busy} onTake={() => onStart("placement")} onSkip={() => onSkipPlacement?.()} />
					)}

					{/* Understanding and Reviews due side by side, flat (owner, 2026-11-16): only Next up and Exam are raised. UI round
					    1b: no boxes, a hairline above, a 24px grid; side by side only when the COLUMN is wide enough for "This week"
					    (a container query), stacked at 1024px. */}
					<div className="@container border-t border-border pt-6">
					<div className={cn("grid gap-x-12 gap-y-6", skills.some((s) => s.learned) && "@3xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]")}>
						<section data-testid="course-overview" className="min-w-0 space-y-3">
							<div className={cn(PAGE_HEAD, "flex items-center")}>
								Understanding<span className={HEAD_COUNT}>{courseProgressPercent(skills.map((s) => s.understanding))}%</span>
								<Hint label={UNDERSTANDING_HELP}>
									<button type="button" aria-label="What learned and known mean" data-testid="understanding-help" className={cn(buttonVariants({ variant: "ghost", size: "icon-xs" }), "ml-1 text-muted-foreground hover:text-foreground")}>
										<InfoIcon aria-hidden />
									</button>
								</Hint>
							</div>
							<DistributionStrip skills={skills} due={dueNow} active={selection.band} onPick={(band) => narrow({ ...selection, band })} />
						</section>

						{skills.some((s) => s.learned) && (
							<section data-testid="course-due" className="min-w-0 space-y-3">
								<div className={PAGE_HEAD}>Reviews due</div>
								<DueTimeline skills={skills} now={now} active={selection.bucket} onPick={(bucket) => narrow({ ...selection, bucket })} />
							</section>
						)}
					</div>
					</div>

					{/* The class's vocabulary (WP5): unassigned and flagged terms, or "Map the class's terms". */}
					<CoverageSummary />

					<div className="flex flex-wrap items-center gap-2 border-t border-border pt-6">
						<h2 className={cn(PAGE_HEAD, "pb-0")}>
							Skills<span className={HEAD_COUNT}>{skills.length}</span>
						</h2>
						<span className="ml-auto flex items-center gap-2">
					{skills.some((s) => canChoose(s.id)) && (
						<button type="button" className={BTN} aria-pressed={choosing} data-testid="choose-toggle" onClick={() => (choosing ? stopChoosing() : setChoosing(true))}>
							{choosing ? "Done" : "Choose skills"}
						</button>
					)}
					<button type="button" className={BTN} aria-expanded={showMap} data-testid="map-toggle" onClick={() => setShowMap((v) => !v)}>
						{showMap ? "Hide map" : "Map"}
					</button>
				</span>
					</div>

					{showMap && (
						<section data-testid="course-map">
							<SkillMap
								nodes={nodes}
								edges={edges}
								statusOf={(id) => {
									const s = byId.get(id);
									return s ? diagramStatus(s) : "upcoming";
								}}
								focusIds={mapFocus}
								fitted
								accentId={data.nextUp[0] ?? null}
							/>
							<p className="mt-2 text-meta text-muted-foreground">Blue outline: next up · dashed with a lock: locked behind a prerequisite.</p>
						</section>
					)}

					{narrowed ? (
						<section data-testid="course-flat">
							<div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
								Showing
								{selection.band && (
									<button type="button" className={BTN} data-testid="clear-band" onClick={() => setSelection({ ...selection, band: null })}>
										{SKILL_BAND_LABEL[selection.band]} ×
									</button>
								)}
								{selection.bucket && (
									<button type="button" className={BTN} data-testid="clear-bucket" onClick={() => setSelection({ ...selection, bucket: null })}>
										Due: {DUE_BUCKET_LABEL[selection.bucket]} ×
									</button>
								)}
							</div>
							{flat.length === 0 ? (
								<p className="text-xs text-muted-foreground" data-testid="flat-empty">
									No skill matches.
								</p>
							) : (
								<RowList>
									{flat.map((s) => (
										<SkillRow key={s.id} skill={s} names={names} now={now} actions={actionsFor(s)} />
									))}
								</RowList>
							)}
						</section>
					) : (
						<>
							{data.review.length > 0 && (
								<section data-testid="course-review">
									{/* "To review": due now plus fading before the exam (owner, 2026-11-16); the header and Next up start it. */}
									<div className={cn(SECTION_HEAD, fadingCount > 0 && "mb-0.5")}>
										To review<span className={HEAD_COUNT}>{data.review.length}</span>
									</div>
									{fadingCount > 0 && (
										<p className="mb-2 text-xs text-muted-foreground" data-testid="course-review-split">
											{dueNowCount} due now · {fadingCount} fading before {data.plan.reviewFadingBefore ?? "the exam"}
										</p>
									)}
									<RowList>{list(data.review).map((s) => <SkillRow key={s.id} skill={s} names={names} now={now} actions={actionsFor(s)} />)}</RowList>
								</section>
							)}

							<section data-testid="course-next">
								<div className={SECTION_HEAD}>
									Not started<span className={HEAD_COUNT}>{data.nextUp.length}</span>
								</div>
								{data.nextUp.length === 0 ? (
									<p className="text-xs text-muted-foreground">
										{data.known.length === skills.length ? "Every skill is known." : data.locked.length === 0 ? "Every skill is learned — practice makes them known." : "Nothing is next up."}
									</p>
								) : (
									<RowList>
										{list(data.nextUp).map((s) => (
											<SkillRow key={s.id} skill={s} names={names} now={now} actions={learnPractice(s)} />
										))}
									</RowList>
								)}
							</section>

							{data.notExamined.length > 0 && (
								<details data-testid="course-not-examined" className="group">
									<summary className={cn(SECTION_HEAD, DETAILS_HEAD)}>
										<ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
										Not examined<span className={HEAD_COUNT}>{data.notExamined.length}</span>
									</summary>
									<p className="mb-2 text-xs text-muted-foreground">The sources never use these in an exam, and nothing examined builds on them. You can still learn them.</p>
									<RowList>
										{list(data.notExamined).map((s) => (
											<SkillRow key={s.id} skill={s} names={names} now={now} actions={learnPractice(s)} />
										))}
									</RowList>
								</details>
							)}

							{data.contextCheck.length > 0 && (
								<section data-testid="course-context-check">
									<div className={SECTION_HEAD}>
										From another course<span className={HEAD_COUNT}>{data.contextCheck.length}</span>
									</div>
									<p className="mb-2 text-xs text-muted-foreground">
										You already have these from another course. A short check confirms each one works the same way here — optional, nothing is locked behind it.
									</p>
									<RowList>
										{list(data.contextCheck).map((s) => (
											<SkillRow key={s.id} skill={s} names={names} now={now} actions={contextActions(s)} />
										))}
									</RowList>
								</section>
							)}

							{learning.length > 0 && (
								<section data-testid="course-learning">
									<div className="mb-2 flex items-center justify-between">
										<span className={cn(SECTION_HEAD, "mb-0")}>
											Learning<span className={HEAD_COUNT}>{learning.length}</span>
										</span>
										{data.learning.length > 1 && (
											<button type="button" className={BTN} disabled={busy} data-testid="practice-all" onClick={() => onStart("practice")}>
												Practice all
											</button>
										)}
									</div>
									<RowList>
										{list(learning).map((s) => (
											<SkillRow key={s.id} skill={s} names={names} now={now} actions={practiceLearnAgain(s)} />
										))}
									</RowList>
								</section>
							)}

							{known.length > 0 && (
								<section data-testid="course-known">
									<div className={SECTION_HEAD}>
										Known<span className={HEAD_COUNT}>{known.length}</span>
									</div>
									<RowList>{list(known).map((s) => <SkillRow key={s.id} skill={s} names={names} now={now} actions={practiceOnly(s)} />)}</RowList>
								</section>
							)}

							{data.locked.length > 0 && (
								<details data-testid="course-locked" className="group">
									<summary className={cn(SECTION_HEAD, DETAILS_HEAD)}>
										<ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
										Locked<span className={HEAD_COUNT}>{data.locked.length}</span>
									</summary>
									<RowList>{list(data.locked).map((s) => <SkillRow key={s.id} skill={s} names={names} now={now} />)}</RowList>
								</details>
							)}

							{/* Below the skill groups, the newest three, the rest behind "Show all" (owner, 2026-11-16). */}
							{missed.length > 0 && (
								<section data-testid="course-missed">
									<div className={SECTION_HEAD}>
										Missed problems<span className={HEAD_COUNT}>{missed.length}</span>
									</div>
									<RowList>
										{(allMissed ? missed : missed.slice(0, MISSED_SHOWN)).map((m) => (
											<div key={m.id} className="flex items-center justify-between gap-3 border-b border-border py-2.5 text-body" data-testid={`course-missed-${m.id}`}>
												<div className="min-w-0">
													<div className={cn("line-clamp-2", ROW_NAME)}>
														<RichLine>{oneLineStatement(m.statement)}</RichLine>
													</div>
													<div className="mt-0.5 text-xs text-muted-foreground">
														{m.skills.map((s) => s.name).join(", ")} · {m.how} · {m.at.slice(0, 10)}
													</div>
												</div>
												<button
													type="button"
													className={cn(BTN, "lh-touch shrink-0")}
													disabled={busy || !onPracticeSet}
													aria-label="Retry as a new variant"
													title="Retry as a new variant"
													onClick={() => onPracticeSet?.(m.skills.map((s) => s.id))}
												>
													Retry
												</button>
											</div>
										))}
									</RowList>
									{missed.length > MISSED_SHOWN && (
										<button
											type="button"
											className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "lh-touch mt-1 -ml-2 text-muted-foreground hover:text-foreground")}
											aria-expanded={allMissed}
											data-testid="course-missed-all"
											onClick={() => setAllMissed((v) => !v)}
										>
											{allMissed ? "Show fewer" : `Show all ${missed.length}`}
											<ChevronRightIcon className={cn("size-3.5 transition-transform", allMissed && "-rotate-90")} aria-hidden />
										</button>
									)}
								</section>
							)}
						</>
					)}
				</>
			)}

			{choosing && (
				<div data-testid="choose-bar" className="lh-popover sticky bottom-3 z-20 flex items-center justify-between gap-3 px-3 py-2.5 sm:px-4">
					<span className="text-sm" data-testid="choose-count">
						{chooseCount === 0 ? "Tap skills to practice" : `${chooseCount} skill${chooseCount === 1 ? "" : "s"} chosen`}
					</span>
					<span className="flex shrink-0 items-center gap-2">
						<button type="button" className={BTN} data-testid="choose-cancel" onClick={stopChoosing}>
							Cancel
						</button>
						<button
							type="button"
							className={cn(BTN_PRIMARY, "whitespace-nowrap")}
							disabled={busy || chooseCount === 0 || !onPracticeSet}
							data-testid="choose-start"
							onClick={() => onPracticeSet?.(chosenIds)}
						>
							Practice {chooseCount}
						</button>
					</span>
				</div>
			)}

		</div>
		</SelfReportContext.Provider>
		</SkillListContext.Provider>
		</CoverageContext.Provider>
	);
}

/** "7/12 known · 58%". Pure. */
/** The Review buttons' label: how many skills need review, and how many of
 *  them the next review takes when that is capped (the session size). Pure. */
export function reviewLabel(data: Pick<CourseView, "review" | "reviewBatch">): string {
	if (data.review.length === 0) return "Review";
	return data.reviewBatch < data.review.length ? `Review · ${data.reviewBatch} of ${data.review.length}` : `Review · ${data.review.length}`;
}

export function courseProgress(data: Pick<CourseView, "skills" | "known">): string | null {
	if (data.skills.length === 0) return null;
	return `${data.known.length}/${data.skills.length} known`;
}

export function CoursePage({ courseId, initial }: { courseId: string; initial: CoursePayload }) {
	const router = useRouter();
	const [data, setData] = useState<CoursePayload>(initial);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [title, setTitle] = useState(initial.course.title);
	const [placementSkipped, setPlacementSkipped] = useState(false);
	useEffect(() => setPlacementSkipped(readPlacementSkipped(courseId)), [courseId]);
	// The class's files (UI class page, 2026-11-25): one list for the side panel, the empty class's drop zone and a drop
	// anywhere on the page.
	const files = useMaterials(courseId);
	const materialCount = files.materials.length;
	// The side panel always shows on a wide page; on a narrower one (1024) it is a toggle in the header, open from the
	// start for an empty class, whose files and skill map live there.
	const [panelOpen, setPanelOpen] = useState(() => initial.skills.length === 0);
	const [dropping, setDropping] = useState(false);
	const dragDepth = useRef(0);
	const scrollRef = useRef<HTMLDivElement>(null);
	const [scrolled, setScrolled] = useState(false);

	const refresh = useCallback(async () => {
		try {
			const res = await fetch(`/api/courses/${courseId}`, { cache: "no-store" });
			if (res.status === 404) {
				router.push("/");
				return;
			}
			const next = (await res.json()) as CoursePayload;
			setData(next);
		} catch {
			/* keep the last snapshot */
		}
	}, [courseId, router]);

	const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const schedule = () => {
		if (debounceRef.current) clearTimeout(debounceRef.current);
		debounceRef.current = setTimeout(() => {
			debounceRef.current = undefined;
			void refresh();
		}, 250);
	};
	useServerEvent("courses-changed", schedule);
	useServerEvent("turn-settled", schedule);
	useServerEvent("chats-changed", schedule);
	useServerResync(() => void refresh());
	useEffect(() => () => debounceRef.current && clearTimeout(debounceRef.current), []);
	useEffect(() => setTitle(data.course.title), [data.course.title]);

	const call = async (url: string, body: unknown): Promise<Response | null> => {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
			if (!res.ok) {
				setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `request failed (${res.status})`);
				return null;
			}
			return res;
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			return null;
		} finally {
			setBusy(false);
			void refresh();
		}
	};

	const onDraft = (feedback?: string) => void call(`/api/courses/${courseId}/draft`, feedback ? { feedback } : {});
	const onApprove = () => void call(`/api/courses/${courseId}/approve`, {});
	const onStart = async (mode: CourseMode, skillId?: string, pace?: Pace) => {
		const res = await call(`/api/courses/${courseId}/sessions`, { mode, ...(skillId ? { skillId } : {}), ...(pace ? { pace } : {}) });
		if (!res) return;
		const { id, prompt } = (await res.json()) as { id: string; prompt: string };
		router.push(`/chat/${id}?prompt=${encodeURIComponent(prompt)}`);
	};
	// "Retest what I know": a placement test on only what is not learned or needs review (owner, 2026-11-16)
	const onRetest = async () => {
		const res = await call(`/api/courses/${courseId}/sessions`, { mode: "placement", retest: true });
		if (!res) return;
		const { id, prompt } = (await res.json()) as { id: string; prompt: string };
		router.push(`/chat/${id}?prompt=${encodeURIComponent(prompt)}`);
	};
	// Short question (2026-11-25): reopen the newest Ask conversation, or start one. It opens on an empty composer.
	const onAsk = async (reopen?: string) => {
		if (reopen) {
			router.push(`/chat/${reopen}`);
			return;
		}
		const res = await call(`/api/courses/${courseId}/sessions`, { mode: "ask" });
		if (!res) return;
		const { id } = (await res.json()) as { id: string };
		router.push(`/chat/${id}`);
	};
	// "Choose skills": one practice session on the ticked skills (owner, 2026-11-14)
	const onPracticeSet = async (skillIds: string[]) => {
		const res = await call(`/api/courses/${courseId}/sessions`, { mode: "practice", skillIds });
		if (!res) return;
		const { id, prompt } = (await res.json()) as { id: string; prompt: string };
		router.push(`/chat/${id}?prompt=${encodeURIComponent(prompt)}`);
	};
	// A Learn start asks for its pace first (fork addition, 2026-11-09); every other mode starts straight away.
	const [learnSkill, setLearnSkill] = useState<string | null>(null);
	// A hand edit of a skill's exam weight (owner, 2026-11-13): 0-3, or null to reset it.
	const editWeight = useCallback(
		async (skillId: string, weight: SkillWeightValue | null) => {
			try {
				const res = await fetch(`/api/courses/${courseId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ weights: { [skillId]: weight } }) });
				if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `weight rejected (${res.status})`);
			} catch {
				setError("Could not reach the server — try again.");
			}
			void refresh();
		},
		[courseId, refresh],
	);
	// The sidebar's Today opens a lesson's pace dialog through ?learn=<skill id>.
	const wantedLearn = useSearchParams().get("learn");
	useEffect(() => {
		if (!wantedLearn) return;
		if (data.skills.some((s) => s.id === wantedLearn)) setLearnSkill(wantedLearn);
		router.replace(`/course/${courseId}`);
		// every arrival by a link with ?learn=, also from another lesson of the same course (the effect follows the URL)
	}, [wantedLearn]);

	const commitTitle = async () => {
		const t = title.trim();
		if (!t || t === data.course.title) {
			setTitle(data.course.title);
			return;
		}
		await fetch(`/api/courses/${courseId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: t }),
		}).catch(() => {});
		void refresh();
	};

	const progress = courseProgress(data);
	const hasSkills = data.skills.length > 0;
	const drafting = data.drafting || data.course.status === "drafting";
	const weighed = !!data.course.weightsAt;
	// The empty class (no skill map yet): the setup card in the center carries the class name as its H1.
	const setup = !hasSkills;
	const titleField = (className: string) => (
		<FitTitleInput
			value={title}
			onChange={(e) => setTitle(e.target.value)}
			onBlur={() => void commitTitle()}
			onKeyDown={(e) => {
				if (e.key === "Enter") e.currentTarget.blur();
				if (e.key === "Escape") {
					setTitle(data.course.title);
					e.currentTarget.blur();
				}
			}}
			placeholder="Class name"
			aria-label="Class name"
			data-testid="course-title"
			className={cn("lh-no-drag resize-none overflow-y-auto bg-transparent lh-page-title outline-none", className)}
		/>
	);
	// A file dropped anywhere on the class page becomes a class file (UI class page): the panel opens to show it land.
	const dropHandlers = {
		onDragEnter: (e: React.DragEvent) => {
			if (!dragHasFiles(e)) return;
			e.preventDefault();
			e.stopPropagation();
			dragDepth.current++;
			setDropping(true);
			setPanelOpen(true);
		},
		onDragOver: (e: React.DragEvent) => {
			if (!dragHasFiles(e)) return;
			e.preventDefault();
			e.stopPropagation();
			e.dataTransfer.dropEffect = "copy";
		},
		onDragLeave: (e: React.DragEvent) => {
			if (!dragHasFiles(e)) return;
			e.stopPropagation();
			dragDepth.current = Math.max(0, dragDepth.current - 1);
			if (dragDepth.current === 0) setDropping(false);
		},
		onDrop: (e: React.DragEvent) => {
			if (!dragHasFiles(e)) return;
			e.preventDefault();
			e.stopPropagation();
			dragDepth.current = 0;
			setDropping(false);
			void files.addFiles(Array.from(e.dataTransfer.files));
		},
	};
	return (
		// The class page (UI class page, 2026-11-25): the center column (header, start a session, recent sessions,
		// progress) and the class side panel on the right (files, skill map, settings, lecture notes). A container query on
		// the page's own width keeps the panel always shown when there is room (1440) and a header toggle below that (1024).
		<div className="@container/class relative flex h-dvh min-w-0" data-testid="class-page" {...dropHandlers}>
			{files.node}
			<div ref={scrollRef} className="relative min-w-0 flex-1 overflow-y-auto" onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}>
				{/* A solid band (UI round 1b, SPEC §8): content scrolling under the sticky header no longer shows through it. UI
				    round 2: a bottom hairline once the page has scrolled, so content never shears against empty space. */}
				<header className={cn("lh-drag sticky top-0 z-10 border-b bg-background pb-2 pt-[calc(0.5rem+var(--lh-safe-top))] transition-colors duration-(--lh-duration-hover)", scrolled ? "border-border" : "border-transparent")}>
					{/* the same column and padding as the page below, so the title lines up with the content (owner, 2026-11-16) */}
					<div className="mx-auto flex min-h-9 max-w-5xl items-center gap-3 px-6">
						<SidebarToggle />
						{setup ? <span className="flex-1" /> : titleField("min-w-0 flex-1")}
						{/* One quiet group (UI round 1b): the known count as meta text, then 32px controls 8px apart. */}
						<span className="lh-no-drag flex shrink-0 items-center gap-2">
							{progress && (
								<span className="mr-1 whitespace-nowrap text-meta tabular-nums text-muted-foreground" data-testid="course-progress">
									{progress}
								</span>
							)}
							{hasSkills && (
								<button
									type="button"
									className={cn(HEAD_BTN, "lh-touch")}
									disabled={busy || data.review.length === 0}
									data-testid="course-review-button"
									onClick={() => void onStart("review")}
								>
									{reviewLabel(data)}
								</button>
							)}
							<button
								type="button"
								className={cn(HEAD_ICON_BTN, "lh-touch @6xl/class:hidden", panelOpen && "bg-raised text-foreground")}
								aria-label={panelOpen ? "Hide class files and settings" : "Show class files and settings"}
								title="Class files and settings"
								aria-pressed={panelOpen}
								data-testid="class-panel-toggle"
								onClick={() => setPanelOpen((o) => !o)}
							>
								<PanelRightIcon strokeWidth={1.75} aria-hidden />
							</button>
						</span>
					</div>
				</header>
				<div className="mx-auto max-w-5xl px-6 pb-16 pt-4">
					{learnSkill && (
						<LearnPaceDialog
							courseId={courseId}
							busy={busy}
							onClose={() => setLearnSkill(null)}
							onStart={(pace) => {
								const skillId = learnSkill;
								setLearnSkill(null);
								void onStart("learn", skillId, pace);
							}}
						/>
					)}
					<WeightEditContext.Provider value={(id, w) => void editWeight(id, w)}>
						<CourseBody
							data={data}
							busy={busy}
							error={setup ? error : null}
							onDraft={onDraft}
							onApprove={onApprove}
							onStart={(mode, skillId) => {
								if (mode === "learn" && skillId) setLearnSkill(skillId);
								else void onStart(mode, skillId);
							}}
							onPracticeSet={(ids) => void onPracticeSet(ids)}
							onRetest={() => void onRetest()}
							materialCount={materialCount}
							files={files}
							title={titleField("w-full")}
							dropping={dropping}
							placementSkipped={placementSkipped}
							onSkipPlacement={() => {
								writePlacementSkipped(courseId);
								setPlacementSkipped(true);
							}}
							onChanged={() => void refresh()}
							onAsk={(reopen) => void onAsk(reopen)}
							onCoverage={{
								edit: (target, edit) => void call(`/api/courses/${courseId}/coverage`, { target, ...edit }),
								map: (target) => void call(`/api/courses/${courseId}/coverage`, { map: true, ...(target === "draft" ? { target: "draft" } : {}) }),
								approveLeaving: () => void call(`/api/courses/${courseId}/approve`, { leaveUnassigned: true }),
							}}
						/>
					</WeightEditContext.Provider>
				</div>
			</div>
			<aside
				aria-label="Class files and settings"
				data-testid="class-side-panel"
				className={cn(
					"w-84 shrink-0 overflow-y-auto border-l border-border bg-background pt-[var(--lh-safe-top)] transition-colors duration-(--lh-duration-hover)",
					panelOpen ? "block" : "hidden @6xl/class:block",
					dropping && "bg-raised/40",
				)}
			>
				<ClassPanel
					courseId={courseId}
					courseTitle={data.course.title}
					pace={data.course.pace}
					files={files}
					dropping={dropping}
					setup={setup}
					hasSkills={hasSkills}
					hasDraft={!!data.course.draft}
					drafting={drafting}
					courseError={data.course.error}
					error={setup ? null : error}
					busy={busy}
					onDraft={() => onDraft()}
					onChanged={() => void refresh()}
					onPlacement={() => void onStart("placement")}
					onDeleted={() => router.push("/")}
					exam={
						hasSkills
							? { examDate: data.course.examDate, hasWeights: weighed, weighing: data.weighing === true, canWeigh: !drafting && materialCount > 0, weightsSummary: data.course.weightsSummary, weightsAt: data.course.weightsAt }
							: undefined
					}
					// WP8: the Upcoming list (quizzes, exams; the old exam date as an "Exam") and the syllabus pass
					{...(data.upcoming ? { upcoming: data.upcoming } : {})}
					skills={data.skills.map((s) => ({ id: s.id, name: s.name }))}
				/>
			</aside>
		</div>
	);
}
