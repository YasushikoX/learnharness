"use client";

import { useEffect, useState } from "react";
import { Loader2Icon, PlusIcon, XIcon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { FIELD_CLASS } from "@/components/ui/input";
import { ThinSelect } from "@/components/settings/controls";
import { ASSESSMENT_KINDS, daysUntil, examDateLabel, KIND_LABELS, shortDate, type Assessment, type AssessmentKind, type AssessmentProposal, type ProposedAssessment, type ProposedLecture, type UpcomingView } from "@/src/core";
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

/** "today", "tomorrow", "in 9 d", "passed". Pure. */
export function countdownLabel(date: string, now: number): string {
	const d = daysUntil(date, now);
	if (d < 0) return "passed";
	if (d === 0) return "today";
	if (d === 1) return "tomorrow";
	return `in ${d} d`;
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

/** The small add / edit form. */
function AssessmentForm({
	initial,
	skills,
	busy,
	onSave,
	onCancel,
	onDelete,
	testid,
}: {
	initial: FormValue;
	skills: ReadonlyArray<{ id: string; name: string }>;
	busy: boolean;
	onSave: (v: FormValue) => void;
	onCancel: () => void;
	onDelete?: () => void;
	testid: string;
}) {
	const [v, setV] = useState<FormValue>(initial);
	const toggle = (id: string) => setV((x) => ({ ...x, skillIds: x.skillIds.includes(id) ? x.skillIds.filter((s) => s !== id) : [...x.skillIds, id] }));
	return (
		<form
			className="space-y-2 rounded-lg border border-border bg-card p-3"
			data-testid={testid}
			onSubmit={(e) => {
				e.preventDefault();
				if (v.title.trim()) onSave(v);
			}}
		>
			<div className="flex gap-2">
				<ThinSelect value={v.kind} onChange={(k) => setV((x) => ({ ...x, kind: k as AssessmentKind }))} ariaLabel="Kind" className="w-32 shrink-0" testid={`${testid}-kind`}>
					{ASSESSMENT_KINDS.map((k) => (
						<option key={k} value={k}>
							{KIND_LABELS[k]}
						</option>
					))}
				</ThinSelect>
				<input aria-label="Title" placeholder="Quiz 3" value={v.title} onChange={(e) => setV((x) => ({ ...x, title: e.target.value }))} className={cn(FIELD_CLASS, "h-8 min-w-0 flex-1 px-2.5")} data-testid={`${testid}-title`} />
			</div>
			<input type="date" aria-label="Date" value={v.date} onChange={(e) => setV((x) => ({ ...x, date: e.target.value }))} className={cn(FIELD_CLASS, "h-8 w-fit px-2.5")} data-testid={`${testid}-date`} />
			<textarea aria-label="Topics" placeholder="What it covers" rows={2} value={v.topics} onChange={(e) => setV((x) => ({ ...x, topics: e.target.value }))} className={cn(FIELD_CLASS, "block w-full resize-y px-2.5 py-1.5")} data-testid={`${testid}-topics`} />
			{skills.length > 0 && (
				<fieldset className="max-h-32 space-y-0.5 overflow-y-auto rounded-md border border-border px-2 py-1.5 text-meta" data-testid={`${testid}-skills`}>
					<legend className="px-1 text-muted-foreground">Skills it covers</legend>
					<label className="flex items-center gap-2 py-0.5">
						<input type="checkbox" checked={v.allSkills} onChange={() => setV((x) => ({ ...x, allSkills: !x.allSkills }))} data-testid={`${testid}-all-skills`} />
						<span className="truncate">Every skill (cumulative)</span>
					</label>
					{skills.map((s) => (
						<label key={s.id} className={cn("flex items-center gap-2 py-0.5", v.allSkills && "opacity-60")}>
							<input type="checkbox" disabled={v.allSkills} checked={v.allSkills || v.skillIds.includes(s.id)} onChange={() => toggle(s.id)} />
							<span className="truncate">{s.name}</span>
						</label>
					))}
				</fieldset>
			)}
			<div className="flex items-center gap-2">
				<button type="submit" className={SMALL} disabled={busy || !v.title.trim()} data-testid={`${testid}-save`}>
					Save
				</button>
				<button type="button" className={GHOST} onClick={onCancel}>
					Cancel
				</button>
				{onDelete && (
					<button type="button" className={cn(GHOST, "ml-auto text-error")} disabled={busy} onClick={onDelete} data-testid={`${testid}-delete`}>
						Delete
					</button>
				)}
			</div>
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
					{a.date ? `${examDateLabel(a.date)} · ${countdownLabel(a.date, now)}` : "no date"}
				</span>
			</span>
			<span className="block text-meta text-muted-foreground">
				{KIND_LABELS[a.kind]}
				{a.topics ? ` · ${a.topics}` : ""}
				{a.allSkills ? " · every skill" : a.skillIds.length > 0 ? ` · ${a.skillIds.map((id) => names.get(id) ?? id).join(", ")}` : ""}
			</span>
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
	const [editing, setEditing] = useState<string | null>(null);
	const [proposalEdit, setProposalEdit] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [working, setWorking] = useState(false);
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

	const call = async (url: string, init: RequestInit): Promise<boolean> => {
		setError(null);
		setNotice(null);
		setWorking(true);
		try {
			const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json" } });
			if (!res.ok) {
				setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `rejected (${res.status})`);
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
			setError("Could not reach the server — try again.");
			return false;
		} finally {
			setWorking(false);
		}
	};
	const base = `/api/courses/${courseId}/assessments`;
	const find = () => void call(`${base}/find`, { method: "POST" });
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
	const act = (action: Record<string, unknown>) => call(`${base}/proposal`, { method: "POST", body: proposalBody(shown, action) });
	const disabled = busy || working;
	const row = (a: Assessment) =>
		editing === a.id ? (
			<AssessmentForm
				key={a.id}
				testid={`upcoming-form-${a.id}`}
				initial={formOf(a)}
				skills={skills}
				busy={disabled}
				onCancel={() => setEditing(null)}
				onSave={async (v) => {
					if (await call(`${base}/${a.id}`, { method: "PATCH", body: JSON.stringify(bodyOf(v)) })) setEditing(null);
				}}
				onDelete={async () => {
					if (await call(`${base}/${a.id}`, { method: "DELETE" })) setEditing(null);
				}}
			/>
		) : (
			<Row key={a.id} a={a} now={now} next={a.id === upcoming.nextId} names={names} onEdit={() => setEditing(a.id)} />
		);

	return (
		<section className="space-y-2 px-4 py-4" data-testid="upcoming" aria-label="Upcoming">
			<div className="flex items-center justify-between gap-2">
				<h2 className="text-body font-semibold text-foreground">Upcoming</h2>
				<button type="button" className={ICON} aria-label="Add a quiz or exam" title="Add a quiz or exam" disabled={disabled} data-testid="upcoming-add" onClick={() => setEditing("new")}>
					<PlusIcon aria-hidden />
				</button>
			</div>

			{hint && !hintHidden && !upcoming.finding && (
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

			{editing === "new" && (
				<AssessmentForm
					testid="upcoming-form-new"
					initial={EMPTY}
					skills={skills}
					busy={disabled}
					onCancel={() => setEditing(null)}
					onSave={async (v) => {
						if (await call(base, { method: "POST", body: JSON.stringify(bodyOf(v)) })) setEditing(null);
					}}
				/>
			)}

			{upcoming.items.length === 0 && editing !== "new" && !proposal && (
				<p className="text-meta text-muted-foreground" data-testid="upcoming-empty">
					No quizzes or exams yet. Add one, find them in the syllabus, or tell Short question.
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

			{upcoming.finding && (
				<p className="flex items-center gap-1.5 text-meta text-muted-foreground" data-testid="upcoming-finding">
					<Loader2Icon className="size-3.5 shrink-0 animate-spin" aria-hidden />
					Reading the syllabus…
				</p>
			)}
			{upcoming.error && !upcoming.finding && (
				<p className="text-meta text-error" data-testid="upcoming-error">
					Finding failed: {upcoming.error}
				</p>
			)}

			{proposal && upcoming.proposal && (
				<div className="space-y-2 rounded-lg border border-border p-3" data-testid="upcoming-proposal">
					<div className="text-chrome font-medium">From the syllabus{pendingCount > 0 ? ` · ${pendingCount} to add` : ""}</div>
					<p className="text-meta text-muted-foreground">
						{upcoming.proposal.summary}
						{proposal.already + proposalLectures.already > 0 ? ` ${proposal.already + proposalLectures.already} already in your list.` : ""}
						{upcoming.proposal.partial ? " It stopped early, so this may not be all of them." : ""}
					</p>
					{pendingCount === 0 && <p className="text-meta text-muted-foreground">Nothing new to add.</p>}
					<div className="divide-y divide-border">
						{proposal.pending.map((p) =>
							proposalEdit === p.key ? (
								<AssessmentForm
									key={p.key}
									testid={`proposal-form-${p.key}`}
									initial={formOf(p)}
									skills={skills}
									busy={disabled}
									onCancel={() => setProposalEdit(null)}
									onSave={async (v) => {
										if (await act({ action: "approve", keys: [p.key], edits: { [p.key]: bodyOf(v) } })) setProposalEdit(null);
									}}
								/>
							) : (
								<div key={p.key} className="py-1.5" data-testid={`proposal-item-${p.key}`}>
									<div className="flex items-baseline gap-2 text-chrome">
										<span className="min-w-0 flex-1 truncate font-medium">{p.title}</span>
										<span className="shrink-0 text-meta text-muted-foreground tabular-nums">{p.date ? `${examDateLabel(p.date)} · ${countdownLabel(p.date, now)}` : "no date"}</span>
									</div>
									<div className="text-meta text-muted-foreground">
										{KIND_LABELS[p.kind]}
										{p.status === "update" ? " · changes the syllabus item" : ""}
										{p.topics ? ` · ${p.topics}` : ""}
									</div>
									<div className="flex items-center gap-1 text-meta text-muted-foreground">
										<span className="min-w-0 flex-1 truncate" data-testid={`proposal-cite-${p.key}`} title={p.quote ? `“${p.quote}”` : undefined}>
											{p.cite}
											{p.quote ? ` · “${p.quote}”` : ""}
										</span>
										<button type="button" className={GHOST} disabled={disabled} onClick={() => setProposalEdit(p.key)}>
											Edit
										</button>
										<button type="button" className={GHOST} disabled={disabled} data-testid={`proposal-drop-${p.key}`} onClick={() => void act({ action: "drop", key: p.key })}>
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
										<span className="shrink-0 text-muted-foreground tabular-nums">{l.date ? shortDate(l.date) : "no date"}</span>
										<button type="button" className={GHOST} disabled={disabled} data-testid={`proposal-drop-${l.key}`} onClick={() => void act({ action: "drop", key: l.key })}>
											Drop
										</button>
									</div>
								))}
							</div>
						</details>
					)}
					<div className="flex items-center gap-2 pt-1">
						{pendingCount > 0 && (
							<button type="button" className={SMALL} disabled={disabled} data-testid="proposal-approve" onClick={() => void act({ action: "approve" })}>
								{pendingCount === 1 ? "Add it" : `Add all ${pendingCount}`}
							</button>
						)}
						<button type="button" className={GHOST} disabled={disabled} data-testid="proposal-discard" onClick={() => void act({ action: "discard" })}>
							{pendingCount > 0 ? "Discard" : "Close"}
						</button>
					</div>
				</div>
			)}

			{!upcoming.finding && (
				<button type="button" className={BTN} disabled={disabled || !canFind} data-testid="upcoming-find" onClick={find} title={canFind ? undefined : "Add the syllabus or another class file first"}>
					Find in syllabus
				</button>
			)}
			{notice && (
				<p className="text-meta text-muted-foreground" data-testid="upcoming-notice">
					{notice}
				</p>
			)}
			{error && <p className="text-meta text-error">{error}</p>}
		</section>
	);
}
