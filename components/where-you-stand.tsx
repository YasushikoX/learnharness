"use client";

import { useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { ThinSelect } from "@/components/settings/controls";
import { FIELD_CLASS } from "@/components/ui/input";
import { daysUntil, shortDate, type CourseStandingView } from "@/src/core";
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
	const title = (id: string) => s.lectures.find((l) => l.id === id)?.title ?? id;
	let classLine: string | null = null;
	if (s.position) {
		const at = s.position.label ? `Class is at ${s.position.label}` : "Class";
		const covered = s.position.coveredThrough ? `${s.position.label ? " · covered" : " covered"} ${s.position.coveredThrough}` : "";
		classLine = `${at}${s.position.date ? ` · ${shortDate(s.position.date)}` : ""}${covered}${s.position.note ? ` · ${s.position.note}` : ""}`;
	} else if (s.lectures.length > 0) classLine = "Where the class is: not known yet";
	let youLine: string | null = null;
	const withSkills = s.lectures.filter((l) => l.skillIds.length > 0);
	if (s.learnedThrough) youLine = `You've learned what ${s.learnedThrough.label} ${/–|^Lectures|^Forelesnings|^Weeks/.test(s.learnedThrough.label) ? "cover" : "covers"}`;
	else if (withSkills.length > 0) youLine = `Not all of ${withSkills[0]!.title} learned yet`;
	else if (s.lectures.length > 0) youLine = s.linking ? "Placing the skills in the lectures…" : "Skills aren't placed in lectures yet";
	let nextLine: string | null = null;
	if (s.next) {
		const days = daysUntil(s.next.date, now);
		const when = days >= 0 && days <= 6 ? shortDate(s.next.date).split(" ")[0]! : shortDate(s.next.date);
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

/** The inline correction of the class position: pick the lecture, say what was covered, or follow the dates again. */
function PositionEditor({ courseId, standing, onDone }: { courseId: string; standing: CourseStandingView; onDone: (changed: boolean) => void }) {
	const [lectureId, setLectureId] = useState(standing.position?.lectureId ?? "");
	const [covered, setCovered] = useState(standing.position?.how === "explicit" ? (standing.position.coveredThrough ?? "") : "");
	const [error, setError] = useState<string | null>(null);
	const [working, setWorking] = useState(false);
	const send = async (body: unknown, method: "PUT" | "DELETE") => {
		setWorking(true);
		setError(null);
		try {
			const res = await fetch(`/api/courses/${encodeURIComponent(courseId)}/class-position`, { method, headers: { "Content-Type": "application/json" }, ...(method === "PUT" ? { body: JSON.stringify(body) } : {}) });
			if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `rejected (${res.status})`);
			else onDone(true);
		} catch {
			setError("Could not reach the server — try again.");
		} finally {
			setWorking(false);
		}
	};
	return (
		<form
			className="mt-1 flex flex-wrap items-center gap-2"
			data-testid="standing-position-form"
			onSubmit={(e) => {
				e.preventDefault();
				void send({ ...(lectureId ? { lectureId } : {}), ...(covered.trim() ? { coveredThrough: covered.trim() } : {}) }, "PUT");
			}}
		>
			<ThinSelect value={lectureId} onChange={setLectureId} ariaLabel="The lecture the class is at" className="w-48" testid="standing-position-lecture">
				<option value="">No lecture</option>
				{standing.lectures.map((l) => (
					<option key={l.id} value={l.id}>
						{l.title}
						{l.date ? ` · ${shortDate(l.date)}` : ""}
					</option>
				))}
			</ThinSelect>
			<input aria-label="What the class covered" placeholder="Covered (e.g. chapter 6)" value={covered} onChange={(e) => setCovered(e.target.value)} className={cn(FIELD_CLASS, "h-7 w-44 px-2")} data-testid="standing-position-covered" />
			<button type="submit" className={SMALL} disabled={working || (!lectureId && !covered.trim())} data-testid="standing-position-save">
				Save
			</button>
			{standing.position?.how === "explicit" && (
				<button type="button" className={GHOST} disabled={working} data-testid="standing-position-dates" onClick={() => void send(null, "DELETE")}>
					Follow the dates
				</button>
			)}
			<button type="button" className={GHOST} onClick={() => onDone(false)}>
				Cancel
			</button>
			{error && <p className="w-full text-meta text-error">{error}</p>}
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
						<button type="button" className="truncate text-left hover:underline hover:decoration-border hover:underline-offset-2" title="Correct where the class is" data-testid="standing-class-edit" onClick={() => setEditing(true)}>
							{lines.classLine}
							{standing.position?.how === "explicit" && <span className="ml-1.5 text-meta text-muted-foreground">(you said)</span>}
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
