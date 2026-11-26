"use client";

import { useEffect, useState } from "react";
import { InfoIcon, Loader2Icon, PlusIcon, XIcon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { FIELD_CLASS } from "@/components/ui/input";
import { CheckRow, Field, FieldGroup, useOverflow } from "@/components/ui/field";
import { ErrorNotice } from "@/components/ui/error-notice";
import { InlineConfirm } from "@/components/ui/inline-confirm";
import { formDirty, useUnsavedGuard } from "@/components/use-unsaved-guard";
import { ThinSelect } from "@/components/settings/controls";
import { ASSESSMENT_KINDS, dayLabel, daysUntil, KIND_LABELS, relativeDays, shortDate, type Assessment, type AssessmentKind, type AssessmentProposal, type ProposedAssessment, type ProposedLecture, type UpcomingView } from "@/src/core";
import { cn } from "@/lib/utils";

/**
 * The class's Upcoming list (WP8, 2026-11-25; docs/courses.md "Quizzes, exams and what you say you know"), in the class
 * side panel where the single exam-date field was: every quiz, exam and assignment with its kind, title, date or
 * countdown and topics; a small inline form to add or edit one; "Find in syllabus"; and the syllabus pass's proposal, to
 * approve, edit or drop item by item. The old exam date shows as an "Exam"; editing it makes it an ordinary item.
 */

/** UI round 1 (SPEC §3): settings-like actions are 32px outline buttons; small row actions are ghost. */
const BTN = buttonVariants({ variant: "outline" });
const SMALL = buttonVariants({ variant: "secondary", size: "sm" });
const GHOST = buttonVariants({ variant: "ghost", size: "sm" });
const ICON = buttonVariants({ variant: "ghost", size: "icon-xs" });

/** "today", "tomorrow", "in 9 days", "passed" (spelled out, SPEC §9). Pure. */
export function countdownLabel(date: string, now: number): string {
	const d = daysUntil(date, now);
	if (d < 0) return "passed";
	return relativeDays(d);
}

/** "Fri 4 Dec · in 9 days", or "no date". Pure. */
export function whenLabel(date: string | undefined | null, now: number): string {
	return date ? `${dayLabel(date, now)} · ${countdownLabel(date, now)}` : "no date";
}

/** The title hint for a new item of `kind`: the next number after the list's own ("e.g. Quiz 4"). Pure. */
export function suggestTitle(kind: AssessmentKind, items: ReadonlyArray<Pick<Assessment, "kind" | "title">>): string {
	const word = KIND_LABELS[kind];
	if (kind === "exam" || kind === "final") return "e.g. Final exam";
	if (kind === "other") return "e.g. Lab report";
	const re = new RegExp(`^${word}\\s+(\\d+)\\b`, "i");
	const top = items.reduce((m, a) => Math.max(m, Number(re.exec(a.title)?.[1] ?? 0)), 0);
	return `e.g. ${word} ${top + 1}`;
}

/** The kind as a row's subtitle, unless the title already says it ("Exam" titled "Exam"). Pure. */
export function kindSubtitle(a: Pick<Assessment, "kind" | "title">): string | null {
	return a.title.trim().toLowerCase() === KIND_LABELS[a.kind].toLowerCase() ? null : KIND_LABELS[a.kind];
}

/** The list split for the panel: dated and still to come (by date), then undated, then the past ones. Pure. */
export function upcomingRows(items: readonly Assessment[], now: number): { coming: Assessment[]; undated: Assessment[]; past: Assessment[] } {
	const coming = items.filter((a) => a.date && daysUntil(a.date, now) >= 0);
	const past = items.filter((a) => a.date && daysUntil(a.date, now) < 0).reverse();
	const undated = items.filter((a) => !a.date);
	return { coming, undated, past };
}

/** The proposal's items still to decide (new or a change to a syllabus item), and how many are already in the list. Pure. */
export function proposalRows(items: readonly ProposedAssessment[]): { pending: ProposedAssessment[]; already: number } {
	const pending = items.filter((i) => i.status === "new" || i.status === "update");
	return { pending, already: items.length - pending.length };
}

/** WP9: the proposal's lectures still to decide. Pure. */
export function proposalLectureRows(lectures: readonly ProposedLecture[] | undefined): { pending: ProposedLecture[]; already: number } {
	const all = lectures ?? [];
	const pending = all.filter((l) => l.status === "new" || l.status === "update");
	return { pending, already: all.length - pending.length };
}

/** A proposal action's body, naming the proposal the page shows (review 1, finding 1: the server refuses an action on
 *  any other with 409, and the page refreshes). Pure. */
export function proposalBody(proposal: Pick<AssessmentProposal, "id">, action: Record<string, unknown>): string {
	return JSON.stringify({ ...action, ...(proposal.id ? { proposalId: proposal.id } : {}) });
}

interface FormValue {
	kind: AssessmentKind;
	title: string;
	date: string;
	topics: string;
	skillIds: string[];
	/** Covers every skill of the class (cumulative; WP9 review 1, finding 12). */
	allSkills: boolean;
}

const EMPTY: FormValue = { kind: "quiz", title: "", date: "", topics: "", skillIds: [], allSkills: false };

/** The small add / edit form (UI round 8, SPEC §9): a heading, a 12px label over every field, "e.g." hints, the skills as
 *  whole 28px rows, Delete behind an inline confirm, and "Discard changes?" when the list asks to leave it dirty. */
function AssessmentForm({
	initial,
	heading,
	titleHint,
	skills,
	busy,
	asking = false,
	onSave,
	onCancel,
	onDelete,
	onDirty,
	onDiscard,
	onKeep,
	now,
	testid,
}: {
	initial: FormValue;
	heading: string;
	titleHint: (kind: AssessmentKind) => string;
	skills: ReadonlyArray<{ id: string; name: string }>;
	busy: boolean;
	/** The list wants to open another row and this form has edits: ask first. */
	asking?: boolean;
	onSave: (v: FormValue) => void;
	onCancel: () => void;
	onDelete?: () => void;
	onDirty?: (dirty: boolean) => void;
	onDiscard?: () => void;
	onKeep?: () => void;
	now: number;
	testid: string;
}) {
	const [v, setV] = useState<FormValue>(initial);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [listRef, overflow] = useOverflow<HTMLDivElement>();
	const toggle = (id: string) => setV((x) => ({ ...x, skillIds: x.skillIds.includes(id) ? x.skillIds.filter((s) => s !== id) : [...x.skillIds, id] }));
	const dirty = formDirty(initial, v);
	useEffect(() => onDirty?.(dirty), [dirty, onDirty]);
	const title = v.title.trim() || KIND_LABELS[v.kind];
	return (
		<form
			className="space-y-3 rounded-lg border border-border bg-card p-3"
			data-testid={testid}
			aria-label={heading}
			onSubmit={(e) => {
				e.preventDefault();
				if (v.title.trim()) onSave(v);
			}}
			onKeyDown={(e) => {
				if (e.key === "Escape" && !asking && !confirmDelete) {
					e.stopPropagation();
					onCancel();
				}
			}}
		>
			<h3 className="text-chrome font-semibold text-foreground">{heading}</h3>
			<div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-2">
				<Field label="Kind">
					<ThinSelect value={v.kind} onChange={(k) => setV((x) => ({ ...x, kind: k as AssessmentKind }))} ariaLabel="Kind" className="w-full" testid={`${testid}-kind`}>
						{ASSESSMENT_KINDS.map((k) => (
							<option key={k} value={k}>
								{KIND_LABELS[k]}
							</option>
						))}
					</ThinSelect>
				</Field>
				<Field label="Title">
					<input placeholder={titleHint(v.kind)} value={v.title} required onChange={(e) => setV((x) => ({ ...x, title: e.target.value }))} className={cn(FIELD_CLASS, "h-8 w-full min-w-0 px-2.5")} data-testid={`${testid}-title`} />
				</Field>
			</div>
			<Field label="Date" hint={v.date ? dayLabel(v.date, now) : undefined}>
				<input type="date" value={v.date} onChange={(e) => setV((x) => ({ ...x, date: e.target.value }))} className={cn(FIELD_CLASS, "h-8 w-fit px-2.5")} data-testid={`${testid}-date`} />
			</Field>
			<Field label="What it covers">
				<textarea placeholder="e.g. chapters 4 and 5" rows={2} value={v.topics} onChange={(e) => setV((x) => ({ ...x, topics: e.target.value }))} className={cn(FIELD_CLASS, "block w-full resize-none px-2.5 py-1.5")} data-testid={`${testid}-topics`} />
			</Field>
			{skills.length > 0 && (
				<FieldGroup label="Skills it covers" testid={`${testid}-skills`}>
					<CheckRow checked={v.allSkills} onChange={() => setV((x) => ({ ...x, allSkills: !x.allSkills }))} testid={`${testid}-all-skills`}>
						Every skill (cumulative)
					</CheckRow>
					<div ref={listRef} className="lh-row-list rounded-md border border-border p-0.5" data-overflow={overflow ? "true" : "false"}>
						{skills.map((s) => (
							<CheckRow key={s.id} disabled={v.allSkills} checked={v.allSkills || v.skillIds.includes(s.id)} onChange={() => toggle(s.id)}>
								{s.name}
							</CheckRow>
						))}
					</div>
				</FieldGroup>
			)}
			{asking ? (
				<InlineConfirm question="Discard changes?" cancelLabel="Keep editing" confirmLabel="Discard" onCancel={() => onKeep?.()} onConfirm={() => onDiscard?.()} testid={`${testid}-discard`} />
			) : confirmDelete && onDelete ? (
				<InlineConfirm question={`Delete ${title}?`} confirmLabel={`Delete ${KIND_LABELS[v.kind].toLowerCase()}`} busy={busy} onCancel={() => setConfirmDelete(false)} onConfirm={onDelete} testid={`${testid}-delete-confirm`} />
			) : (
				<div className="flex items-center gap-2">
					<button type="submit" className={SMALL} disabled={busy || !v.title.trim()} data-testid={`${testid}-save`}>
						Save
					</button>
					<button type="button" className={GHOST} onClick={onCancel}>
						Cancel
					</button>
					{onDelete && (
						<button type="button" className={cn(GHOST, "ml-auto text-error")} disabled={busy} onClick={() => setConfirmDelete(true)} data-testid={`${testid}-delete`}>
							Delete…
						</button>
					)}
				</div>
			)}
		</form>
	);
}

function formOf(a: Pick<Assessment, "kind" | "title" | "date" | "topics" | "skillIds" | "allSkills">): FormValue {
	return { kind: a.kind, title: a.title, date: a.date ?? "", topics: a.topics, skillIds: [...a.skillIds], allSkills: a.allSkills === true };
}

/** The POST/PATCH body: a cumulative one keeps its flag (never a list of every skill). Pure (exported for tests). */
export function bodyOf(v: FormValue) {
	return { kind: v.kind, title: v.title.trim(), date: v.date || null, topics: v.topics, ...(v.allSkills ? { allSkills: true } : { skillIds: v.skillIds }) };
}

/** One assessment row: title and kind, the date with its countdown, the topics. */
function Row({ a, now, next, names, onEdit }: { a: Assessment; now: number; next: boolean; names: ReadonlyMap<string, string>; onEdit: () => void }) {
	const past = !!a.date && daysUntil(a.date, now) < 0;
	return (
		<button
			type="button"
			onClick={onEdit}
			aria-label={`Edit ${a.title}`}
			data-testid={`upcoming-item-${a.id}`}
			className={cn("-mx-2 block w-[calc(100%+1rem)] rounded-sm px-2 py-1.5 text-left hover:bg-raised", past && "text-muted-foreground")}
		>
			<span className="flex items-baseline gap-2 text-chrome">
				{next && <span aria-label="next" className="size-1.5 shrink-0 -translate-y-0.5 rounded-full bg-primary" />}
				<span className="min-w-0 flex-1 truncate font-medium">{a.title}</span>
				<span className="shrink-0 text-meta text-muted-foreground tabular-nums" data-testid={`upcoming-when-${a.id}`}>
					{whenLabel(a.date, now)}
				</span>
			</span>
			{(() => {
				const sub = [kindSubtitle(a), a.topics || null, a.allSkills ? "every skill" : a.skillIds.length > 0 ? a.skillIds.map((id) => names.get(id) ?? id).join(", ") : null].filter(Boolean);
				return sub.length > 0 ? <span className="block text-meta text-muted-foreground">{sub.join(" · ")}</span> : null;
			})()}
		</button>
	);
}

const HINT_KEY = (courseId: string, materialId: string) => `lh:syllabus-hint:${courseId}:${materialId}`;

export function UpcomingList({
	courseId,
	upcoming,
	skills,
	busy = false,
	canFind,
	onChanged,
	now = Date.now(),
}: {
	courseId: string;
	upcoming: UpcomingView;
	skills: ReadonlyArray<{ id: string; name: string }>;
	busy?: boolean;
	/** The class has a file to read. */
	canFind: boolean;
	onChanged: () => void;
	now?: number;
}) {
	const guard = useUnsavedGuard<string>();
	const editing = guard.open?.startsWith("item:") ? guard.open.slice(5) : null;
	const proposalEdit = guard.open?.startsWith("proposal:") ? guard.open.slice(9) : null;
	const [error, setError] = useState<{ text: string; where: "find" | "proposal" | "form" } | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [working, setWorking] = useState<null | "find" | "proposal" | "form">(null);
	const [showPast, setShowPast] = useState(false);
	const names = new Map(skills.map((s) => [s.id, s.name]));
	const hint = upcoming.syllabusHint;
	// the syllabus hint shows once per file: dismissing it is remembered in this browser
	const dismissed = (materialId: string): boolean => {
		try {
			return typeof window !== "undefined" && window.localStorage.getItem(HINT_KEY(courseId, materialId)) === "1";
		} catch {
			return false;
		}
	};
	const [hintHidden, setHintHidden] = useState(() => (hint ? dismissed(hint.materialId) : false));
	const hintId = hint?.materialId;
	useEffect(() => {
		if (hintId) setHintHidden(dismissed(hintId));
		// `dismissed` reads only courseId and the id
	}, [courseId, hintId]);

	const call = async (url: string, init: RequestInit, where: "find" | "proposal" | "form"): Promise<boolean> => {
		setError(null);
		setNotice(null);
		setWorking(where);
		try {
			const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json" } });
			if (!res.ok) {
				setError({ text: ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `rejected (${res.status})`, where });
				// 409: the list or the proposal changed under this page (a second pass, a sync): show what is there now
				if (res.status === 409) onChanged();
				return false;
			}
			// an approval leaves alone what the learner changed since the pass ran: say how many (WP8 re-check 1, N4)
			const skipped = ((await res.json().catch(() => ({}))) as { skipped?: unknown }).skipped;
			if (typeof skipped === "number" && skipped > 0) setNotice(`${skipped === 1 ? "1 item was" : `${skipped} items were`} left as you have ${skipped === 1 ? "it" : "them"}: you changed the list after the syllabus was read.`);
			onChanged();
			return true;
		} catch {
			setError({ text: "Could not reach the server.", where });
			return false;
		} finally {
			setWorking(null);
		}
	};
	const base = `/api/courses/${courseId}/assessments`;
	const find = () => void call(`${base}/find`, { method: "POST" }, "find");
	const dismissHint = () => {
		if (!hint) return;
		try {
			window.localStorage.setItem(HINT_KEY(courseId, hint.materialId), "1");
		} catch {
			/* private mode: it shows again next time */
		}
		setHintHidden(true);
	};
	const { coming, undated, past } = upcomingRows(upcoming.items, now);
	const proposal = upcoming.proposal ? proposalRows(upcoming.proposal.items) : null;
	const proposalLectures = proposalLectureRows(upcoming.proposal?.lectures);
	const pendingCount = (proposal?.pending.length ?? 0) + proposalLectures.pending.length;
	const shown = upcoming.proposal ?? {};
	const act = (action: Record<string, unknown>) => call(`${base}/proposal`, { method: "POST", body: proposalBody(shown, action) }, "proposal");
	// one running state (SPEC §9): while the syllabus is read, nothing that would clash with its result can start
	const finding = upcoming.finding === true || working === "find";
	const disabled = busy || working !== null;
	const proposalDisabled = disabled || finding;
	const titleHint = (kind: AssessmentKind) => suggestTitle(kind, upcoming.items);
	const form = (key: string, props: Omit<React.ComponentProps<typeof AssessmentForm>, "titleHint" | "skills" | "busy" | "now" | "onDirty" | "asking" | "onDiscard" | "onKeep">) => (
		<AssessmentForm
			key={key}
			{...props}
			titleHint={titleHint}
			skills={skills}
			busy={disabled}
			now={now}
			asking={guard.open === key && guard.asking}
			onDirty={guard.setDirty}
			onDiscard={guard.discard}
			onKeep={guard.keep}
		/>
	);
	const row = (a: Assessment) =>
		editing === a.id ? (
			form(`item:${a.id}`, {
				testid: `upcoming-form-${a.id}`,
				heading: `Edit ${a.title}`,
				initial: formOf(a),
				onCancel: guard.close,
				onSave: async (v) => {
					if (await call(`${base}/${a.id}`, { method: "PATCH", body: JSON.stringify(bodyOf(v)) }, "form")) guard.close();
				},
				onDelete: async () => {
					if (await call(`${base}/${a.id}`, { method: "DELETE" }, "form")) guard.close();
				},
			})
		) : (
			<Row key={a.id} a={a} now={now} next={a.id === upcoming.nextId} names={names} onEdit={() => guard.request(`item:${a.id}`)} />
		);

	return (
		<section className="space-y-2 px-4 py-4" data-testid="upcoming" aria-label="Upcoming">
			<div className="flex items-center justify-between gap-2">
				<h2 className="text-body font-semibold text-foreground">Upcoming</h2>
				<button type="button" className={ICON} aria-label="Add a quiz or exam" title="Add a quiz or exam" disabled={disabled} data-testid="upcoming-add" onClick={() => guard.request("item:new")}>
					<PlusIcon aria-hidden />
				</button>
			</div>

			{hint && !hintHidden && !finding && (
				<p className="flex items-center gap-1.5 text-meta text-muted-foreground" data-testid="upcoming-syllabus-hint">
					<span className="min-w-0 flex-1">
						<span className="truncate">{hint.name}</span> looks like a syllabus.{" "}
						<button type="button" className="text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground" disabled={disabled || !canFind} onClick={find}>
							Find quizzes and exams
						</button>
					</span>
					<button type="button" className={ICON} aria-label="Dismiss" onClick={dismissHint}>
						<XIcon aria-hidden />
					</button>
				</p>
			)}

			{editing === "new" &&
				form("item:new", {
					testid: "upcoming-form-new",
					heading: "New quiz or exam",
					initial: EMPTY,
					onCancel: guard.close,
					onSave: async (v) => {
						if (await call(base, { method: "POST", body: JSON.stringify(bodyOf(v)) }, "form")) guard.close();
					},
				})}

			{upcoming.items.length === 0 && editing !== "new" && !proposal && (
				<p className="text-meta text-muted-foreground" data-testid="upcoming-empty">
					No quizzes or exams yet. Add one with +, find them in the syllabus, or tell Short question.
				</p>
			)}

			{(coming.length > 0 || undated.length > 0) && (
				<div className="space-y-0.5" data-testid="upcoming-list">
					{coming.map(row)}
					{undated.map(row)}
				</div>
			)}
			{past.length > 0 && (
				<div>
					<button type="button" className="text-meta text-muted-foreground hover:text-foreground" aria-expanded={showPast} data-testid="upcoming-past-toggle" onClick={() => setShowPast((s) => !s)}>
						{showPast ? "Hide past" : `Past · ${past.length}`}
					</button>
					{showPast && <div className="mt-1 space-y-0.5">{past.map(row)}</div>}
				</div>
			)}
			{error?.where === "form" && <ErrorNotice error={error.text} what="Couldn't save the change." testid="upcoming-form-error" />}

			{/* The syllabus pass: its button runs it (the spinner on the button itself), its failure sits right under it, and
			    its result — the proposal, then the approval's notice — follows. */}
			<div className="space-y-1.5 pt-1">
				<button
					type="button"
					className={BTN}
					disabled={disabled || !canFind || finding}
					aria-busy={finding}
					data-testid={finding ? "upcoming-finding" : "upcoming-find"}
					onClick={find}
				>
					{finding && <Loader2Icon className="animate-spin" aria-hidden />}
					{finding ? "Reading the syllabus…" : "Find in syllabus"}
				</button>
				{!canFind && !finding && (
					<p className="text-meta text-muted-foreground" data-testid="upcoming-find-reason">
						Add the syllabus or another class file first.
					</p>
				)}
				{upcoming.error && !finding && <ErrorNotice error={upcoming.error} what="Couldn't find quizzes and exams." onRetry={canFind ? find : undefined} retrying={finding} testid="upcoming-error" />}
				{error?.where === "find" && <ErrorNotice error={error.text} what="Couldn't start reading the syllabus." onRetry={canFind ? find : undefined} testid="upcoming-find-error" />}
			</div>

			{proposal && upcoming.proposal && (
				<div className={cn("space-y-2 rounded-lg border border-border p-3", finding && "opacity-60")} data-testid="upcoming-proposal" aria-disabled={finding}>
					<div className="text-chrome font-medium">From the syllabus{pendingCount > 0 ? ` · ${pendingCount} to add` : ""}</div>
					<p className="text-meta text-muted-foreground">
						{upcoming.proposal.summary}
						{proposal.already + proposalLectures.already > 0 ? ` ${proposal.already + proposalLectures.already} already in your list.` : ""}
						{upcoming.proposal.partial ? " It stopped early, so this may not be all of them." : ""}
					</p>
					{finding && <p className="text-meta text-muted-foreground">This list is replaced when the new reading finishes.</p>}
					{pendingCount === 0 && <p className="text-meta text-muted-foreground">Nothing new to add.</p>}
					<div className="divide-y divide-border">
						{proposal.pending.map((p) =>
							proposalEdit === p.key ? (
								form(`proposal:${p.key}`, {
									testid: `proposal-form-${p.key}`,
									heading: `Edit ${p.title}`,
									initial: formOf(p),
									onCancel: guard.close,
									onSave: async (v) => {
										if (await act({ action: "approve", keys: [p.key], edits: { [p.key]: bodyOf(v) } })) guard.close();
									},
								})
							) : (
								<div key={p.key} className="py-1.5" data-testid={`proposal-item-${p.key}`}>
									<div className="flex items-baseline gap-2 text-chrome">
										<span className="min-w-0 flex-1 truncate font-medium">{p.title}</span>
										<span className="shrink-0 text-meta text-muted-foreground tabular-nums">{whenLabel(p.date, now)}</span>
									</div>
									{(() => {
										const sub = [kindSubtitle(p), p.status === "update" ? "changes the syllabus item" : null, p.topics || null].filter(Boolean);
										return sub.length > 0 ? <div className="text-meta text-muted-foreground">{sub.join(" · ")}</div> : null;
									})()}
									<div className="flex items-center gap-2 text-meta text-muted-foreground">
										<span className="min-w-0 flex-1 truncate" data-testid={`proposal-cite-${p.key}`} title={p.quote ? `“${p.quote}”` : undefined}>
											{p.cite}
											{p.quote ? ` · “${p.quote}”` : ""}
										</span>
										<button type="button" className={GHOST} disabled={proposalDisabled} onClick={() => guard.request(`proposal:${p.key}`)}>
											Edit
										</button>
										<button type="button" className={GHOST} disabled={proposalDisabled} data-testid={`proposal-drop-${p.key}`} onClick={() => void act({ action: "drop", key: p.key })}>
											Drop
										</button>
									</div>
								</div>
							),
						)}
					</div>
					{/* WP9: the lecture schedule from the same run, added with the items */}
					{proposalLectures.pending.length > 0 && (
						<details className="group border-t border-border pt-1.5" data-testid="proposal-lectures">
							<summary className="cursor-pointer text-meta text-muted-foreground hover:text-foreground">
								Lecture schedule · {proposalLectures.pending.length} lecture{proposalLectures.pending.length === 1 ? "" : "s"}
							</summary>
							<div className="mt-1 divide-y divide-border">
								{proposalLectures.pending.map((l) => (
									<div key={l.key} className="flex items-baseline gap-2 py-1 text-meta" data-testid={`proposal-lecture-${l.key}`}>
										<span className="min-w-0 flex-1 truncate" title={l.quote ? `${l.cite} · “${l.quote}”` : l.cite}>
											{l.title}
											{l.status === "update" ? " · changes the syllabus lecture" : ""}
										</span>
										<span className="shrink-0 text-muted-foreground tabular-nums">{l.date ? shortDate(l.date, now) : "no date"}</span>
										<button type="button" className={GHOST} disabled={proposalDisabled} data-testid={`proposal-drop-${l.key}`} onClick={() => void act({ action: "drop", key: l.key })}>
											Drop
										</button>
									</div>
								))}
							</div>
						</details>
					)}
					<div className="flex items-center gap-2 pt-1">
						{pendingCount > 0 && (
							<button type="button" className={SMALL} disabled={proposalDisabled} data-testid="proposal-approve" onClick={() => void act({ action: "approve" })}>
								{working === "proposal" && <Loader2Icon className="animate-spin" aria-hidden />}
								{pendingCount === 1 ? "Add it" : `Add all ${pendingCount}`}
							</button>
						)}
						<button type="button" className={GHOST} disabled={proposalDisabled} data-testid="proposal-discard" onClick={() => void act({ action: "discard" })}>
							{pendingCount > 0 ? "Discard" : "Close"}
						</button>
					</div>
					{error?.where === "proposal" && <ErrorNotice error={error.text} what="Couldn't update the list." testid="upcoming-proposal-error" />}
				</div>
			)}
			{/* the approval's result, where the proposal was (round 8: not away under Find in syllabus) */}
			{notice && (
				<p className="flex items-start gap-1.5 rounded-md bg-raised px-2.5 py-2 text-meta text-foreground" role="status" data-testid="upcoming-notice">
					<InfoIcon className="mt-px size-3.5 shrink-0 text-muted-foreground" aria-hidden />
					{notice}
				</p>
			)}
			{error?.where === "proposal" && !upcoming.proposal && <ErrorNotice error={error.text} what="Couldn't update the list." testid="upcoming-proposal-error" />}
		</section>
	);
}
