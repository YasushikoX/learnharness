"use client";

import { useState } from "react";
import { Loader2Icon, PlusIcon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { FIELD_CLASS } from "@/components/ui/input";
import { shortDate, type CourseStandingView, type LectureView } from "@/src/core";
import { cn } from "@/lib/utils";

/**
 * The class's lectures (WP9, 2026-11-25; core/lectures.ts; docs/courses.md "Lectures and where you stand"), in the class
 * side panel under Upcoming: the timeline with each lecture's number, date and skills, the class's position marked, the
 * lectures read from the file names marked "from your files"; an inline form to add, edit (number, title, date, topics,
 * skills) or remove one, like the Upcoming list; and the "link skills to lectures" step's state.
 */

const SMALL = buttonVariants({ variant: "secondary", size: "sm" });
const GHOST = buttonVariants({ variant: "ghost", size: "sm" });
const ICON = buttonVariants({ variant: "ghost", size: "icon-xs" });

interface FormValue {
	n: string;
	title: string;
	date: string;
	topics: string;
	skillIds: string[];
}

const EMPTY: FormValue = { n: "", title: "", date: "", topics: "", skillIds: [] };

function formOf(l: LectureView): FormValue {
	return { n: l.n === undefined ? "" : String(l.n), title: l.title, date: l.date ?? "", topics: l.topics, skillIds: [...l.skillIds] };
}

/** The PATCH/POST body; skills only when they changed (so an edit of the date never marks the skills as the learner's).
 *  A new lecture with no skill ticked sends none, so the linking step still places its skills (WP9 review 1, finding 6);
 *  clearing them on an existing lecture is sent. Pure. */
export function lectureBody(v: FormValue, before?: Pick<LectureView, "skillIds">): Record<string, unknown> {
	const sameSkills = before ? before.skillIds.length === v.skillIds.length && before.skillIds.every((s) => v.skillIds.includes(s)) : v.skillIds.length === 0;
	return {
		n: v.n.trim() === "" ? null : Number(v.n),
		title: v.title.trim(),
		date: v.date || null,
		topics: v.topics,
		...(sameSkills ? {} : { skillIds: v.skillIds }),
	};
}

function LectureForm({ initial, skills, busy, onSave, onCancel, onDelete, testid }: { initial: FormValue; skills: ReadonlyArray<{ id: string; name: string }>; busy: boolean; onSave: (v: FormValue) => void; onCancel: () => void; onDelete?: () => void; testid: string }) {
	const [v, setV] = useState<FormValue>(initial);
	const toggle = (id: string) => setV((x) => ({ ...x, skillIds: x.skillIds.includes(id) ? x.skillIds.filter((s) => s !== id) : [...x.skillIds, id] }));
	const valid = v.title.trim() !== "" || v.n.trim() !== "";
	return (
		<form
			className="space-y-2 rounded-lg border border-border bg-card p-3"
			data-testid={testid}
			onSubmit={(e) => {
				e.preventDefault();
				if (valid) onSave(v);
			}}
		>
			<div className="flex gap-2">
				<input aria-label="Number" placeholder="#" inputMode="numeric" value={v.n} onChange={(e) => setV((x) => ({ ...x, n: e.target.value.replace(/[^\d]/g, "").slice(0, 3) }))} className={cn(FIELD_CLASS, "h-8 w-14 px-2.5")} data-testid={`${testid}-n`} />
				<input aria-label="Title" placeholder="Lecture 8" value={v.title} onChange={(e) => setV((x) => ({ ...x, title: e.target.value }))} className={cn(FIELD_CLASS, "h-8 min-w-0 flex-1 px-2.5")} data-testid={`${testid}-title`} />
			</div>
			<input type="date" aria-label="Date" value={v.date} onChange={(e) => setV((x) => ({ ...x, date: e.target.value }))} className={cn(FIELD_CLASS, "h-8 w-fit px-2.5")} data-testid={`${testid}-date`} />
			<textarea aria-label="Topics" placeholder="What it covers" rows={2} value={v.topics} onChange={(e) => setV((x) => ({ ...x, topics: e.target.value }))} className={cn(FIELD_CLASS, "block w-full resize-y px-2.5 py-1.5")} data-testid={`${testid}-topics`} />
			{skills.length > 0 && (
				<fieldset className="max-h-32 space-y-0.5 overflow-y-auto rounded-md border border-border px-2 py-1.5 text-meta" data-testid={`${testid}-skills`}>
					<legend className="px-1 text-muted-foreground">Skills it teaches</legend>
					{skills.map((s) => (
						<label key={s.id} className="flex items-center gap-2 py-0.5">
							<input type="checkbox" checked={v.skillIds.includes(s.id)} onChange={() => toggle(s.id)} />
							<span className="truncate">{s.name}</span>
						</label>
					))}
				</fieldset>
			)}
			<div className="flex items-center gap-2">
				<button type="submit" className={SMALL} disabled={busy || !valid} data-testid={`${testid}-save`}>
					Save
				</button>
				<button type="button" className={GHOST} onClick={onCancel}>
					Cancel
				</button>
				{onDelete && (
					<button type="button" className={cn(GHOST, "ml-auto text-error")} disabled={busy} onClick={onDelete} data-testid={`${testid}-delete`}>
						Remove
					</button>
				)}
			</div>
		</form>
	);
}

/** One lecture row: number and title, its date; the topics or where it came from, and how many skills it teaches. */
function Row({ l, here, covered, onEdit }: { l: LectureView; here: boolean; covered: boolean; onEdit: () => void }) {
	const sub = [l.derived || l.source === "files" ? "from your files" : l.source === "syllabus" ? "from the syllabus" : null, l.topics || null, l.skillIds.length > 0 ? `${l.skillIds.length} skill${l.skillIds.length === 1 ? "" : "s"}` : "no skills placed"].filter(Boolean);
	return (
		<button
			type="button"
			onClick={onEdit}
			aria-label={`Edit ${l.title}`}
			data-testid={`lecture-item-${l.id}`}
			data-covered={covered ? "true" : "false"}
			className={cn("-mx-2 block w-[calc(100%+1rem)] rounded-sm px-2 py-1.5 text-left hover:bg-raised", !covered && "text-muted-foreground")}
		>
			<span className="flex items-baseline gap-2 text-chrome">
				{here && <span aria-label="the class is here" title="The class is here" className="size-1.5 shrink-0 -translate-y-0.5 rounded-full bg-primary" data-testid={`lecture-here-${l.id}`} />}
				<span className={cn("min-w-0 flex-1 truncate", covered && "font-medium")}>{l.title}</span>
				<span className="shrink-0 text-meta text-muted-foreground tabular-nums">{l.date ? shortDate(l.date) : "no date"}</span>
			</span>
			<span className="block truncate text-meta text-muted-foreground">{sub.join(" · ")}</span>
		</button>
	);
}

export function LectureList({ courseId, standing, skills, busy = false, onChanged }: { courseId: string; standing: CourseStandingView; skills: ReadonlyArray<{ id: string; name: string }>; busy?: boolean; onChanged: () => void }) {
	const [editing, setEditing] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [working, setWorking] = useState(false);
	const call = async (url: string, init: RequestInit): Promise<boolean> => {
		setError(null);
		setWorking(true);
		try {
			const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json" } });
			if (!res.ok) {
				setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `rejected (${res.status})`);
				return false;
			}
			onChanged();
			return true;
		} catch {
			setError("Could not reach the server — try again.");
			return false;
		} finally {
			setWorking(false);
		}
	};
	const base = `/api/courses/${encodeURIComponent(courseId)}/lectures`;
	const disabled = busy || working;
	const covered = new Set(standing.covered);
	return (
		<section className="space-y-2 px-4 py-4" data-testid="lectures" aria-label="Lectures">
			<div className="flex items-center justify-between gap-2">
				<h2 className="text-body font-semibold text-foreground">Lectures</h2>
				<button type="button" className={ICON} aria-label="Add a lecture" title="Add a lecture" disabled={disabled} data-testid="lecture-add" onClick={() => setEditing("new")}>
					<PlusIcon aria-hidden />
				</button>
			</div>
			{editing === "new" && (
				<LectureForm
					testid="lecture-form-new"
					initial={EMPTY}
					skills={skills}
					busy={disabled}
					onCancel={() => setEditing(null)}
					onSave={async (v) => {
						if (await call(base, { method: "POST", body: JSON.stringify(lectureBody(v)) })) setEditing(null);
					}}
				/>
			)}
			{standing.lectures.length === 0 && editing !== "new" && (
				<p className="text-meta text-muted-foreground" data-testid="lectures-empty">
					No lectures yet. Name files like “Lecture 8” or “L08”, find them in the syllabus, add one, or tell Short question.
				</p>
			)}
			{standing.lectures.length > 0 && (
				<div className="space-y-0.5" data-testid="lecture-list">
					{standing.lectures.map((l) =>
						editing === l.id ? (
							<LectureForm
								key={l.id}
								testid={`lecture-form-${l.id}`}
								initial={formOf(l)}
								skills={skills}
								busy={disabled}
								onCancel={() => setEditing(null)}
								onSave={async (v) => {
									if (await call(`${base}/${encodeURIComponent(l.id)}`, { method: "PATCH", body: JSON.stringify(lectureBody(v, l)) })) setEditing(null);
								}}
								onDelete={async () => {
									if (await call(`${base}/${encodeURIComponent(l.id)}`, { method: "DELETE" })) setEditing(null);
								}}
							/>
						) : (
							<Row key={l.id} l={l} here={standing.position?.lectureId === l.id} covered={covered.has(l.id)} onEdit={() => setEditing(l.id)} />
						),
					)}
				</div>
			)}
			{standing.linking ? (
				<p className="flex items-center gap-1.5 text-meta text-muted-foreground" data-testid="lectures-linking">
					<Loader2Icon className="size-3.5 shrink-0 animate-spin" aria-hidden />
					Placing the skills in the lectures…
				</p>
			) : standing.lectures.length > 0 && (standing.unplaced > 0 || standing.linkError) ? (
				<p className="flex flex-wrap items-center gap-x-2 text-meta text-muted-foreground" data-testid="lectures-unplaced">
					{standing.linkError ? <span className="text-error">Placing skills failed: {standing.linkError}</span> : <span>{standing.unplaced === 1 ? "1 skill is" : `${standing.unplaced} skills are`} not placed in a lecture.</span>}
					<button type="button" className="text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground" disabled={disabled} data-testid="lectures-link" onClick={() => void call(`${base}/link`, { method: "POST" })}>
						Place skills
					</button>
				</p>
			) : null}
			{error && <p className="text-meta text-error">{error}</p>}
		</section>
	);
}
