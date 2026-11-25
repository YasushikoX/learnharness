"use client";

import { useEffect, useState } from "react";
import {
	bandCounts,
	bucketCounts,
	DUE_BUCKET_LABEL,
	DUE_BUCKETS,
	isDue,
	KNOWN_UNDERSTANDING,
	MAX_UNDERSTANDING,
	SKILL_BAND_LABEL,
	SKILL_BANDS,
	understandingColor,
	type CourseSkillView,
	type DueBucket,
	type SkillBand,
} from "@/src/core";
import { cn } from "@/lib/utils";

/**
 * The course page's visual skill layer (owner, 2026-11-09; the overview redone 2026-11-14): a color bar per skill, one
 * bar showing how the skills spread over understanding with each band's count printed on it, band chips and a strip of
 * when reviews fall due (both tap to narrow the list). Color is the quick read, never the only one: every bar sits next
 * to a word or a number, every segment carries its count. All the cut-points are in core/skill-visual.ts; the ramp is
 * --lh-understanding-N.
 */

const DUE_COLOR = "var(--lh-due)";

/** The clock, re-read each `everyMs` so "due now" and the timeline stay true on a page left open. */
export function useNow(everyMs = 60_000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), everyMs);
		return () => clearInterval(id);
	}, [everyMs]);
	return now;
}

/** One skill's understanding as a bar: filled to understanding/10 in the ramp color, a tick at the known line (6),
 *  dimmed with a dashed sky outline when recall has fallen below the review line, a hatched empty track when locked. */
export function UnderstandingBar({
	skill,
	now,
	className,
}: {
	skill: Pick<CourseSkillView, "understanding" | "learned" | "needsReview" | "reviewAt" | "missing">;
	now: number;
	className?: string;
}) {
	const color = understandingColor(skill.understanding);
	const due = isDue(skill, now);
	const locked = !skill.learned && skill.missing.length > 0;
	return (
		<span
			role="meter"
			aria-label="Understanding"
			aria-valuemin={0}
			aria-valuemax={MAX_UNDERSTANDING}
			aria-valuenow={skill.understanding}
			data-testid="skill-bar"
			data-due={due ? "true" : undefined}
			className={cn("relative mt-1.5 block h-1.5 w-full rounded-full bg-border/50", className)}
			style={{
				...(due ? { outline: `1px dashed ${DUE_COLOR}`, outlineOffset: 2 } : {}),
				...(locked
					? { backgroundImage: "repeating-linear-gradient(135deg, var(--border) 0 2px, transparent 2px 5px)", backgroundColor: "transparent" }
					: {}),
			}}
		>
			{color && (
				<span
					className="absolute inset-y-0 left-0 block rounded-full"
					style={{ width: `${(skill.understanding / MAX_UNDERSTANDING) * 100}%`, backgroundColor: color, opacity: due ? 0.55 : 1 }}
				/>
			)}
			<span aria-hidden className="absolute -top-0.5 block h-2.5 w-px bg-foreground/60" style={{ left: `${(KNOWN_UNDERSTANDING / MAX_UNDERSTANDING) * 100}%` }} />
		</span>
	);
}

/** The marker beside a due skill's name: a sky dot that carries its word for screen readers and a long press. */
export function DueChip() {
	return (
		<span
			role="img"
			aria-label="due for review"
			title="Due for review"
			data-testid="skill-due-chip"
			className="size-2 shrink-0 rounded-full"
			style={{ backgroundColor: DUE_COLOR }}
		/>
	);
}

/** Representative ramp step of a band, for the strip. */
const BAND_COLOR: Record<SkillBand, string> = {
	new: "var(--border)",
	low: "var(--lh-understanding-2)",
	mid: "var(--lh-understanding-5)",
	known: "var(--lh-understanding-8)",
};

/** How the course's skills spread over the understanding bands: one bar with each band's count printed on its segment,
 *  and under it each band's label and count as a toggle that narrows the list. */
export function DistributionStrip({
	skills,
	due,
	active,
	onPick,
}: {
	skills: readonly Pick<CourseSkillView, "learned" | "understanding">[];
	/** Skills due for review now. */
	due: number;
	active: SkillBand | null;
	onPick: (band: SkillBand | null) => void;
}) {
	const counts = bandCounts(skills);
	const total = skills.length;
	return (
		<div data-testid="skill-strip">
			<div className="flex h-6 gap-0.5 overflow-hidden rounded-sm" aria-hidden>
				{SKILL_BANDS.filter((b) => counts[b] > 0).map((b) => (
					<button
						key={b}
						type="button"
						tabIndex={-1}
						onClick={() => onPick(active === b ? null : b)}
						className={cn("flex h-full min-w-0 items-center px-2 text-xs font-medium transition-opacity", active && active !== b && "opacity-40")}
						style={{ flexGrow: counts[b], flexBasis: 0, backgroundColor: BAND_COLOR[b], color: b === "new" ? "var(--muted-foreground)" : "var(--background)" }}
					>
						{counts[b]}
					</button>
				))}
			</div>
			{/* The legend (UI round 1b): small 24px chips, one style, no outlines; the picked one takes the raised fill. */}
			<div className="mt-2 -ml-2 flex flex-wrap items-center gap-x-1 gap-y-1">
				{SKILL_BANDS.map((b) => (
					<button
						key={b}
						type="button"
						aria-pressed={active === b}
						data-testid={`strip-${b}`}
						disabled={counts[b] === 0}
						onClick={() => onPick(active === b ? null : b)}
						className={cn(
							"lh-touch flex h-6 items-center gap-1.5 rounded-sm px-2 text-xs whitespace-nowrap outline-none transition-colors duration-(--lh-duration-hover) ease-(--lh-ease) hover:bg-raised hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus disabled:pointer-events-none disabled:opacity-45",
							active === b ? "bg-raised text-foreground" : "text-muted-foreground",
						)}
					>
						<span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: BAND_COLOR[b] }} />
						{SKILL_BAND_LABEL[b]} · {counts[b]}
					</button>
				))}
				{due > 0 && (
					<span className="ml-auto flex items-center gap-1.5 px-2 text-xs" style={{ color: DUE_COLOR }} data-testid="strip-due">
						<span aria-hidden className="size-2 rounded-full border border-dashed" style={{ borderColor: DUE_COLOR }} />
						{due} due of {total}
					</span>
				)}
			</div>
		</div>
	);
}

/** When the learned skills come due, as one small strip: Now / Today / This week / Later, each a toggle that narrows the list. */
export function DueTimeline({
	skills,
	now,
	active,
	onPick,
}: {
	skills: readonly Pick<CourseSkillView, "learned" | "needsReview" | "reviewAt">[];
	now: number;
	active: DueBucket | null;
	onPick: (bucket: DueBucket | null) => void;
}) {
	const counts = bucketCounts(skills, now);
	const max = Math.max(1, ...DUE_BUCKETS.map((b) => counts[b]));
	return (
		// No boxes (UI round 1b, SPEC §7): four quiet cells on the section's hairline, a fill only on hover or when picked.
		<div className="-mx-2 grid grid-cols-4 gap-1" data-testid="due-timeline">
			{DUE_BUCKETS.map((b) => (
				<button
					key={b}
					type="button"
					aria-pressed={active === b}
					data-testid={`timeline-${b}`}
					disabled={counts[b] === 0}
					onClick={() => onPick(active === b ? null : b)}
					className={cn(
						"lh-touch min-w-0 rounded-md px-2 py-1.5 text-left outline-none transition-colors duration-(--lh-duration-hover) ease-(--lh-ease) hover:bg-raised focus-visible:ring-2 focus-visible:ring-focus disabled:pointer-events-none disabled:opacity-45",
						active === b && "bg-raised",
					)}
				>
					<span className="block truncate whitespace-nowrap text-xs text-muted-foreground">{DUE_BUCKET_LABEL[b]}</span>
					<span className="block text-xl font-semibold tabular-nums" style={b === "now" && counts.now > 0 ? { color: DUE_COLOR } : undefined}>
						{counts[b]}
					</span>
					<span aria-hidden className="mt-1 block h-1 rounded-full bg-secondary">
						<span
							className="block h-full rounded-full"
							style={{ width: `${(counts[b] / max) * 100}%`, backgroundColor: b === "now" ? DUE_COLOR : "var(--muted-foreground)" }}
						/>
					</span>
				</button>
			))}
		</div>
	);
}
