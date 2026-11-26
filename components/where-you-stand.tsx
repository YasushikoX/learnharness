"use client";

import { useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { ThinSelect } from "@/components/settings/controls";
import { FIELD_CLASS } from "@/components/ui/input";
import { clientTimeZoneHeader } from "@/components/time-zone";
import { daysUntil, lectureShortLabel, shortDate, weekdayLabel, type CourseStandingView } from "@/src/core";
import { PencilIcon } from "lucide-react";
import { Field } from "@/components/ui/field";
import { ErrorNotice } from "@/components/ui/error-notice";
import { cn } from "@/lib/utils";

/**
 * "Where you stand" (WP9, 2026-11-25; core/lectures.ts whereYouStand; docs/courses.md "Lectures and where you stand"):
 * the compact top of the class page's Next up card. Three short lines and a verdict:
 *
 *   Class   Class is at Lecture 8 · Tue 24 Nov            (click: correct it)
 *   You     You've learned what Lectures 1–6 cover
 *   Next    Quiz 3 · Fri · needs 5 skills: 3 learned, 2 not yet (Lecture 7)
 *   Behind · 2 skills from lectures the class has covered
 *
 * The card's one primary Start (components/exam-plan.tsx) is on the most urgent gap. Desktop only.
 */

const SMALL = buttonVariants({ variant: "secondary", size: "sm" });
const GHOST = buttonVariants({ variant: "ghost", size: "sm" });

export interface StandingLines {
	/** "Class is at Lecture 8 · Tue 24 Nov"; null when the class has no lectures and nothing was said. */
	classLine: string | null;
	youLine: string | null;
	nextLine: string | null;
	verdict: { text: string; behind: boolean } | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The block's lines. Pure (exported for tests). */
export function standingLines(s: CourseStandingView, now = Date.now()): StandingLines {
	// one-line places use the short name ("Lecture 4"); the lecture list shows the whole title
	const title = (id: string) => {
		const l = s.lectures.find((x) => x.id === id);
		return l ? lectureShortLabel(l) : id;
	};
	// The row labels (Class, You, Next) already say whose line it is: the values never repeat them (owner, round 8 (a)).
	let classLine: string | null = null;
	if (s.position) {
		const parts = [
			s.position.lectureId && s.position.label ? title(s.position.lectureId) : null,
			s.position.date ? shortDate(s.position.date, now) : null,
			s.position.coveredThrough ? `covered ${s.position.coveredThrough}` : null,
			s.position.note || null,
		].filter((p): p is string => !!p);
		const line = parts.join(" · ");
		classLine = line ? line[0]!.toUpperCase() + line.slice(1) : "Not known yet";
	} else if (s.lectures.length > 0) classLine = "Not known yet";
	let youLine: string | null = null;
	const withSkills = s.lectures.filter((l) => l.skillIds.length > 0);
	if (s.learnedThrough) youLine = `${s.learnedThrough.label} learned`;
	else if (withSkills.length > 0) youLine = `Not all of ${lectureShortLabel(withSkills[0]!)} learned yet`;
	else if (s.lectures.length > 0) youLine = s.linking ? "Placing the skills in the lectures…" : "Skills aren't placed in lectures yet";
	let nextLine: string | null = null;
	if (s.next) {
		const days = daysUntil(s.next.date, now);
		const when = days >= 0 && days <= 6 ? weekdayLabel(s.next.date) : shortDate(s.next.date, now);
		const head = `${s.next.title} · ${when}`;
		if (!s.next.needs) nextLine = head;
		else {
			const lectures = [...new Set(s.next.missing.flatMap((m) => m.lectureIds.slice(0, 1)))].slice(0, 2).map(title);
			const notYet = s.next.missing.length > 0 ? `, ${s.next.missing.length} not yet${lectures.length > 0 ? ` (${lectures.join(", ")})` : ""}` : "";
			nextLine = `${head} · needs ${plural(s.next.needs.length, "skill")}: ${s.next.learned.length} learned${notYet}`;
		}
	}
	const verdict = s.verdict === "behind" ? { text: `Behind · ${plural(s.behind.length, "skill")} from lectures the class has covered`, behind: true } : s.verdict === "on_track" ? { text: "On track", behind: false } : null;
	return { classLine, youLine, nextLine, verdict };
}

/** Does the block show at all? Only with lectures or a next assessment. Pure. */
export function showsStanding(s: CourseStandingView | undefined | null): s is CourseStandingView {
	return !!s && (s.lectures.length > 0 || s.next !== null || s.position !== null);
}

/** The PUT body of a position correction: the lecture, what was covered and the note, as the form holds them. The note
 *  the learner gave (in Short question too) is in the form, so correcting the lecture keeps it (WP9 review 1, finding
 *  15). Pure (exported for tests). */
export function positionBody(v: { lectureId: string; covered: string; note: string }): Record<string, string> {
	return { ...(v.lectureId ? { lectureId: v.lectureId } : {}), ...(v.covered.trim() ? { coveredThrough: v.covered.trim() } : {}), ...(v.note.trim() ? { note: v.note.trim() } : {}) };
}

/** The inline correction of the class position: pick the lecture, say what was covered, the note, or follow the dates
 *  again. */
function PositionEditor({ courseId, standing, onDone }: { courseId: string; standing: CourseStandingView; onDone: (changed: boolean) => void }) {
	const explicit = standing.position?.how === "explicit";
	const [lectureId, setLectureId] = useState(standing.position?.lectureId ?? "");
	const [covered, setCovered] = useState(explicit ? (standing.position?.coveredThrough ?? "") : "");
	const [note, setNote] = useState(explicit ? (standing.position?.note ?? "") : "");
	const [error, setError] = useState<string | null>(null);
	const [working, setWorking] = useState(false);
	const send = async (body: unknown, method: "PUT" | "DELETE") => {
		setWorking(true);
		setError(null);
		try {
			// the day it is said is the learner's (review 1, finding 10)
			const res = await fetch(`/api/courses/${encodeURIComponent(courseId)}/class-position`, { method, headers: { "Content-Type": "application/json", ...clientTimeZoneHeader() }, ...(method === "PUT" ? { body: JSON.stringify(body) } : {}) });
			if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `rejected (${res.status})`);
			else onDone(true);
		} catch {
			setError("Could not reach the server — try again.");
		} finally {
			setWorking(false);
		}
	};
	return (
		// UI round 8 (SPEC §9): labelled fields on one grid, the lecture by its short name (no clipped title), and the
		// actions on their own row under them
		<form
			className="mt-1 space-y-2.5 rounded-lg border border-border bg-card p-3"
			data-testid="standing-position-form"
			onSubmit={(e) => {
				e.preventDefault();
				void send(positionBody({ lectureId, covered, note }), "PUT");
			}}
			onKeyDown={(e) => {
				if (e.key === "Escape") {
					e.stopPropagation();
					onDone(false);
				}
			}}
		>
			<div className="grid grid-cols-3 gap-2">
				<Field label="Lecture">
					<ThinSelect value={lectureId} onChange={setLectureId} ariaLabel="The lecture the class is at" className="w-full" testid="standing-position-lecture">
						<option value="">No lecture</option>
						{standing.lectures.map((l) => (
							<option key={l.id} value={l.id} title={l.title}>
								{lectureShortLabel(l)}
								{l.date ? ` · ${shortDate(l.date)}` : ""}
							</option>
						))}
					</ThinSelect>
				</Field>
				<Field label="Covered">
					<input placeholder="e.g. chapter 6" value={covered} onChange={(e) => setCovered(e.target.value)} className={cn(FIELD_CLASS, "h-8 w-full px-2.5")} data-testid="standing-position-covered" />
				</Field>
				<Field label="Note">
					<input placeholder="e.g. a week behind" value={note} onChange={(e) => setNote(e.target.value)} className={cn(FIELD_CLASS, "h-8 w-full px-2.5")} data-testid="standing-position-note" />
				</Field>
			</div>
			<div className="flex items-center gap-2">
				<button type="submit" className={SMALL} disabled={working || (!lectureId && !covered.trim() && !note.trim())} data-testid="standing-position-save">
					Save
				</button>
				<button type="button" className={GHOST} onClick={() => onDone(false)}>
					Cancel
				</button>
				{standing.position?.how === "explicit" && (
					<button type="button" className={cn(GHOST, "ml-auto")} disabled={working} data-testid="standing-position-dates" onClick={() => void send(null, "DELETE")}>
						Follow the dates again
					</button>
				)}
			</div>
			{error && <ErrorNotice error={error} what="Couldn't save where the class is." testid="standing-position-error" />}
		</form>
	);
}

/** The block itself (inside the Next up card, above its Start). */
export function WhereYouStand({ courseId, standing, onChanged, now }: { courseId: string; standing: CourseStandingView; onChanged?: () => void; now?: number }) {
	const [editing, setEditing] = useState(false);
	const lines = standingLines(standing, now);
	const row = (label: string, value: React.ReactNode, testid: string) => (
		<div className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-baseline gap-x-3" data-testid={testid}>
			<span className="text-meta text-muted-foreground">{label}</span>
			<span className="min-w-0 text-chrome">{value}</span>
		</div>
	);
	return (
		<div className="space-y-1 pb-3" data-testid="where-you-stand">
			{lines.classLine &&
				row(
					"Class",
					editing ? (
						<PositionEditor
							courseId={courseId}
							standing={standing}
							onDone={(changed) => {
								setEditing(false);
								if (changed) onChanged?.();
							}}
						/>
					) : (
						<button
							type="button"
							className="group/pos -mx-1.5 flex max-w-full items-center gap-1.5 rounded-sm px-1.5 text-left transition-colors duration-(--lh-duration-hover) hover:bg-raised"
							aria-label={`Edit class position: ${lines.classLine}`}
							data-testid="standing-class-edit"
							onClick={() => setEditing(true)}
						>
							<span className="min-w-0 truncate">{lines.classLine}</span>
							{standing.position?.how === "explicit" && <span className="shrink-0 text-meta text-muted-foreground">(you said)</span>}
							<PencilIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground opacity-60 group-hover/pos:opacity-100" />
						</button>
					),
					"standing-class",
				)}
			{lines.youLine && row("You", <span className="block truncate">{lines.youLine}</span>, "standing-you")}
			{lines.nextLine && row("Next", <span className="block truncate">{lines.nextLine}</span>, "standing-next")}
			{lines.verdict && (
				<p className={cn("pt-1 text-meta font-medium", lines.verdict.behind ? "text-warning" : "text-muted-foreground")} data-testid="standing-verdict">
					{lines.verdict.text}
				</p>
			)}
		</div>
	);
}
