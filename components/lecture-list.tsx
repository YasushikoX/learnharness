"use client";

import { useEffect, useState } from "react";
import { Loader2Icon, PlusIcon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { FIELD_CLASS } from "@/components/ui/input";
import { CheckRow, Field, FieldGroup, useOverflow } from "@/components/ui/field";
import { ErrorNotice } from "@/components/ui/error-notice";
import { InlineConfirm } from "@/components/ui/inline-confirm";
import { shortRows, ShortList } from "@/components/ui/short-list";
import { formDirty, useUnsavedGuard } from "@/components/use-unsaved-guard";
import { dayLabel, shortDate, type CourseStandingView, type LectureView } from "@/src/core";
import { cn } from "@/lib/utils";

/**
 * The class's lectures (WP9, 2026-11-25; core/lectures.ts; docs/courses.md "Lectures and where you stand"), in the class
 * side panel under Upcoming: the timeline with each lecture's number, date and skills, the class's position marked, the
 * lectures read from the file names marked "from your files"; an inline form to add, edit (number, title, date, topics,
 * skills) or remove one, like the Upcoming list; and the "link skills to lectures" step's state.
 */

const BTN = buttonVariants({ variant: "outline", size: "sm" });
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

/** The next lecture number after the timeline's own (for the "e.g." hint). Pure. */
export function nextLectureNumber(lectures: ReadonlyArray<Pick<LectureView, "n">>): number {
	return lectures.reduce((m, l) => Math.max(m, l.n ?? 0), 0) + 1;
}

/** Collapsed, the lectures list shows this many rows: the class's current lecture and the two after it. */
export const LECTURE_ROWS = 3;

/**
 * The Lectures list's collapsed rows (UI long lists, 2026-11-26; owner: "the same goes for lectures"): the lecture the
 * class is at first, then the next two, so its position is always in view; with no position, the first lecture the class
 * has not covered. Near the end of the term the window ends at the last lecture. A lecture being edited stays. Pure.
 */
export function lectureRows<L extends Pick<LectureView, "id">>(lectures: readonly L[], positionId: string | undefined, covered: ReadonlySet<string>, keep?: string): { items: L[]; preview: L[]; anchor: string | undefined } {
	const at = positionId ? lectures.findIndex((l) => l.id === positionId) : -1;
	const start = at >= 0 ? at : Math.max(0, lectures.findIndex((l) => !covered.has(l.id)));
	return { ...shortRows(lectures, keep, start, LECTURE_ROWS), anchor: lectures[start]?.id };
}

/** The inline add / edit form (UI round 8, SPEC §9): labelled fields, whole skill rows, Remove behind an inline confirm,
 *  and "Discard changes?" when the list asks to leave it dirty. */
function LectureForm({
	initial,
	heading,
	nextN,
	skills,
	busy,
	asking = false,
	onSave,
	onCancel,
	onDelete,
	onDirty,
	onDiscard,
	onKeep,
	testid,
}: {
	initial: FormValue;
	heading: string;
	nextN: number;
	skills: ReadonlyArray<{ id: string; name: string }>;
	busy: boolean;
	asking?: boolean;
	onSave: (v: FormValue) => void;
	onCancel: () => void;
	onDelete?: () => void;
	onDirty?: (dirty: boolean) => void;
	onDiscard?: () => void;
	onKeep?: () => void;
	testid: string;
}) {
	const [v, setV] = useState<FormValue>(initial);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [listRef, overflow] = useOverflow<HTMLDivElement>();
	const toggle = (id: string) => setV((x) => ({ ...x, skillIds: x.skillIds.includes(id) ? x.skillIds.filter((s) => s !== id) : [...x.skillIds, id] }));
	const valid = v.title.trim() !== "" || v.n.trim() !== "";
	const dirty = formDirty(initial, v);
	useEffect(() => onDirty?.(dirty), [dirty, onDirty]);
	const name = v.title.trim() || (v.n.trim() ? `Lecture ${v.n.trim()}` : "this lecture");
	return (
		<form
			className="space-y-3 rounded-lg border border-border bg-card p-3"
			data-testid={testid}
			aria-label={heading}
			onSubmit={(e) => {
				e.preventDefault();
				if (valid) onSave(v);
			}}
			onKeyDown={(e) => {
				if (e.key === "Escape" && !asking && !confirmDelete) {
					e.stopPropagation();
					onCancel();
				}
			}}
		>
			<div>
				<h3 className="text-chrome font-semibold text-foreground">{heading}</h3>
				<p className="text-meta text-muted-foreground">A number or a title is enough.</p>
			</div>
			<div className="grid grid-cols-[4rem_minmax(0,1fr)] gap-2">
				<Field label="Number">
					<input placeholder={`e.g. ${nextN}`} inputMode="numeric" value={v.n} onChange={(e) => setV((x) => ({ ...x, n: e.target.value.replace(/[^\d]/g, "").slice(0, 3) }))} className={cn(FIELD_CLASS, "h-8 w-full px-2.5")} data-testid={`${testid}-n`} />
				</Field>
				<Field label="Title">
					<input placeholder="e.g. The proton gradient" value={v.title} onChange={(e) => setV((x) => ({ ...x, title: e.target.value }))} className={cn(FIELD_CLASS, "h-8 w-full min-w-0 px-2.5")} data-testid={`${testid}-title`} />
				</Field>
			</div>
			<Field label="Date" hint={v.date ? dayLabel(v.date) : undefined}>
				<input type="date" value={v.date} onChange={(e) => setV((x) => ({ ...x, date: e.target.value }))} className={cn(FIELD_CLASS, "h-8 w-fit px-2.5")} data-testid={`${testid}-date`} />
			</Field>
			<Field label="What it covers">
				<textarea placeholder="e.g. chapter 6, ATP synthase" rows={2} value={v.topics} onChange={(e) => setV((x) => ({ ...x, topics: e.target.value }))} className={cn(FIELD_CLASS, "block w-full resize-none px-2.5 py-1.5")} data-testid={`${testid}-topics`} />
			</Field>
			{skills.length > 0 && (
				<FieldGroup label="Skills it teaches" testid={`${testid}-skills`}>
					<div ref={listRef} className="lh-row-list rounded-md border border-border p-0.5" data-overflow={overflow ? "true" : "false"}>
						{skills.map((s) => (
							<CheckRow key={s.id} checked={v.skillIds.includes(s.id)} onChange={() => toggle(s.id)}>
								{s.name}
							</CheckRow>
						))}
					</div>
				</FieldGroup>
			)}
			{asking ? (
				<InlineConfirm question="Discard changes?" cancelLabel="Keep editing" confirmLabel="Discard" onCancel={() => onKeep?.()} onConfirm={() => onDiscard?.()} testid={`${testid}-discard`} />
			) : confirmDelete && onDelete ? (
				<InlineConfirm question={`Remove ${name}?`} confirmLabel="Remove lecture" busy={busy} onCancel={() => setConfirmDelete(false)} onConfirm={onDelete} testid={`${testid}-delete-confirm`} />
			) : (
				<div className="flex items-center gap-2">
					<button type="submit" className={SMALL} disabled={busy || !valid} data-testid={`${testid}-save`}>
						Save
					</button>
					<button type="button" className={GHOST} onClick={onCancel}>
						Cancel
					</button>
					{onDelete && (
						<button type="button" className={cn(GHOST, "ml-auto text-error")} disabled={busy} onClick={() => setConfirmDelete(true)} data-testid={`${testid}-delete`}>
							Remove…
						</button>
					)}
				</div>
			)}
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
	const guard = useUnsavedGuard<string>();
	const editing = guard.open;
	const [error, setError] = useState<{ text: string; where: "form" | "link" } | null>(null);
	const [working, setWorking] = useState<null | "form" | "link">(null);
	const call = async (url: string, init: RequestInit, where: "form" | "link"): Promise<boolean> => {
		setError(null);
		setWorking(where);
		try {
			const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json" } });
			if (!res.ok) {
				setError({ text: ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `rejected (${res.status})`, where });
				return false;
			}
			onChanged();
			return true;
		} catch {
			setError({ text: "Could not reach the server.", where });
			return false;
		} finally {
			setWorking(null);
		}
	};
	const base = `/api/courses/${encodeURIComponent(courseId)}/lectures`;
	const linking = standing.linking === true || working === "link";
	const disabled = busy || working !== null;
	const covered = new Set(standing.covered);
	const nextN = nextLectureNumber(standing.lectures);
	const rows = lectureRows(standing.lectures, standing.position?.lectureId, covered, editing ?? undefined);
	const link = () => void call(`${base}/link`, { method: "POST" }, "link");
	const formProps = (key: string) => ({ skills, busy: disabled, nextN, asking: guard.open === key && guard.asking, onDirty: guard.setDirty, onDiscard: guard.discard, onKeep: guard.keep, onCancel: guard.close });
	return (
		<section className="space-y-2 px-4 py-4" data-testid="lectures" aria-label="Lectures">
			<div className="flex items-center justify-between gap-2">
				<h2 className="text-body font-semibold text-foreground">Lectures</h2>
				<button type="button" className={ICON} aria-label="Add a lecture" title="Add a lecture" disabled={disabled} data-testid="lecture-add" onClick={() => guard.request("new")}>
					<PlusIcon aria-hidden />
				</button>
			</div>
			{editing === "new" && (
				<LectureForm
					{...formProps("new")}
					testid="lecture-form-new"
					heading="New lecture"
					initial={EMPTY}
					onSave={async (v) => {
						if (await call(base, { method: "POST", body: JSON.stringify(lectureBody(v)) }, "form")) guard.close();
					}}
				/>
			)}
			{standing.lectures.length === 0 && editing !== "new" && (
				<p className="text-meta text-muted-foreground" data-testid="lectures-empty">
					No lectures yet. Add one with +, name files like “Lecture 8” or “L08”, find them in the syllabus, or tell Short question.
				</p>
			)}
			{standing.lectures.length > 0 && (
				<ShortList
					{...rows}
					keyOf={(l) => l.id}
					text={(l) => `${l.title} ${l.topics}`}
					noun="lectures"
					storageKey={`${courseId}:lectures`}
					unbounded={editing !== null && editing !== "new"}
					testid="lecture-list"
					rowsClassName="-mx-2 space-y-0.5 px-2"
					render={(l) =>
						editing === l.id ? (
							<LectureForm
								key={l.id}
								{...formProps(l.id)}
								testid={`lecture-form-${l.id}`}
								heading={`Edit ${l.title}`}
								initial={formOf(l)}
								onSave={async (v) => {
									if (await call(`${base}/${encodeURIComponent(l.id)}`, { method: "PATCH", body: JSON.stringify(lectureBody(v, l)) }, "form")) guard.close();
								}}
								onDelete={async () => {
									if (await call(`${base}/${encodeURIComponent(l.id)}`, { method: "DELETE" }, "form")) guard.close();
								}}
							/>
						) : (
							<Row key={l.id} l={l} here={standing.position?.lectureId === l.id} covered={covered.has(l.id)} onEdit={() => guard.request(l.id)} />
						)
					}
				/>
			)}
			{error?.where === "form" && <ErrorNotice error={error.text} what="Couldn't save the lecture." testid="lectures-form-error" />}
			{/* The linking step: its button carries the running state; its failure sits under it with Try again. */}
			{standing.lectures.length > 0 && (linking || standing.unplaced > 0 || standing.linkError || error?.where === "link") && (
				<div className="space-y-1.5 pt-1" data-testid="lectures-unplaced">
					{!linking && !standing.linkError && (
						<p className="text-meta text-muted-foreground">{standing.unplaced === 1 ? "1 skill is" : `${standing.unplaced} skills are`} not placed in a lecture yet.</p>
					)}
					{standing.linkError && !linking ? (
						<ErrorNotice error={standing.linkError} what="Couldn't place the skills in the lectures." onRetry={link} testid="lectures-link-error" />
					) : (
						<button type="button" className={BTN} disabled={disabled || linking} aria-busy={linking} data-testid={linking ? "lectures-linking" : "lectures-link"} onClick={link}>
							{linking && <Loader2Icon className="animate-spin" aria-hidden />}
							{linking ? "Placing the skills…" : "Place skills in lectures"}
						</button>
					)}
					{error?.where === "link" && <ErrorNotice error={error.text} what="Couldn't start placing the skills." onRetry={link} testid="lectures-link-start-error" />}
				</div>
			)}
		</section>
	);
}
