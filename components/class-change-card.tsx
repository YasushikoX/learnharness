"use client";

import { useCallback, useEffect, useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { dayLabel, KIND_LABELS, STANCE_LABELS, WEIGHT_LABELS, type Assessment, type ClassPosition, type Lecture, type SkillWeightValue } from "@/src/core";
import { RotateCcwIcon } from "lucide-react";
import { useNotifyHub } from "@/components/server-events";
import { cn } from "@/lib/utils";

/**
 * A Short question change, in the transcript (WP8, 2026-11-25; WP9: lectures, the class position, skill weights and class
 * settings): what the agent wrote when the learner stated a fact about the class (an assessment or a lecture added,
 * changed or removed; where the class is; how much the exams use a skill; the class's title, language, pace or folder)
 * or about themselves (a self-report), as one compact card in the
 * transcript's card style (the lesson-result card's), with Undo. Undo reverts exactly that change and is offered only
 * while the class still holds it (GET /api/chats/[id]/class-changes; the server reads the change from the record, never
 * from this card).
 */

const BTN = buttonVariants({ variant: "secondary", size: "sm" });

/** The change as the tool result's details carry it (agent/tools/class-facts.ts ClassChange). */
export type ClassChangeData =
	| { kind: "assessment"; courseId: string; action: "added" | "updated" | "removed"; before: Assessment | null; after: Assessment | null; skillNames: string[] }
	| { kind: "self-report"; courseId: string; report: { stance: "know" | "shaky" | "dont_know"; note: string; at: string }; skillNames: string[] }
	| { kind: "lecture"; courseId: string; action: "added" | "updated" | "removed"; before: Lecture | null; after: Lecture | null; fromFiles?: true; skillNames: string[] }
	| { kind: "position"; courseId: string; before: ClassPosition | null; after: ClassPosition | null; label: string | null; beforeLabel: string | null }
	| { kind: "weights"; courseId: string; before: Record<string, { w: number } | null>; after: Record<string, { w: number } | null>; names: Record<string, string> }
	| { kind: "setting"; courseId: string; field: "title" | "language" | "pace" | "folder"; before: string | null; after: string | null }
	// WP9 review 1, finding 13
	| { kind: "self-report-retract"; courseId: string; before: Array<{ stance: "know" | "shaky" | "dont_know"; skillIds: string[] }>; skillNames: string[] }
	| { kind: "note"; courseId: string; noteId: string; before: { title: string; date: string }; after: { title: string; date: string } };

const FIELD_LABELS: Record<"title" | "language" | "pace" | "folder", string> = { title: "Class name", language: "Class language", pace: "Class pace", folder: "Folder" };
const LANGUAGE_NAMES: Record<string, string> = { en: "English", nb: "Norwegian" };
const settingValue = (field: string, v: string | null): string => (v === null ? (field === "folder" ? "no folder" : "default") : field === "language" ? (LANGUAGE_NAMES[v] ?? v) : v);

/** "You said: unsure" (the one self-report wording, SPEC §9). */
const STANCE = (s: "know" | "shaky" | "dont_know") => `You said: ${STANCE_LABELS[s]}`;

/** The card's lines. Pure. */
export function classChangeLines(change: ClassChangeData, now: number = Date.now()): { eyebrow: string; title: string; lines: string[] } {
	const day = (d: string) => dayLabel(d, now);
	if (change.kind === "self-report") {
		return {
			eyebrow: "Noted",
			title: `${STANCE(change.report.stance)} · ${change.skillNames.join(", ")}`,
			lines: [change.report.stance === "know" ? "A short check comes up soon; practice results count over this." : change.report.stance === "dont_know" ? "It comes first in Next up or comes back for review." : "Its review comes sooner."],
		};
	}
	if (change.kind === "lecture") {
		const l = change.after ?? change.before!;
		const verb = change.action === "added" ? "Added" : change.action === "updated" ? "Changed" : "Removed";
		const moved = change.action === "updated" && change.before && change.before.date !== l.date ? ` (was ${change.before.date ? day(change.before.date) : "no date"})` : "";
		return {
			eyebrow: `${verb} · Lecture`,
			title: l.title,
			lines: [`${l.date ? day(l.date) : "no date"}${moved}`, ...(l.topics ? [l.topics] : []), ...(change.skillNames.length > 0 ? [`Skills: ${change.skillNames.join(", ")}`] : [])],
		};
	}
	if (change.kind === "position") {
		if (!change.after) return { eyebrow: "Class position", title: "Follows the lecture dates", lines: change.beforeLabel ? [`Was: ${change.beforeLabel}`] : [] };
		return {
			eyebrow: "Class position",
			title: change.label ? `Class is at ${change.label}` : `Class covered ${change.after.coveredThrough ?? "…"}`,
			lines: [...(change.label && change.after.coveredThrough ? [`Covered ${change.after.coveredThrough}`] : []), ...(change.after.note ? [change.after.note] : []), ...(change.beforeLabel && change.beforeLabel !== change.label ? [`Was: ${change.beforeLabel}`] : [])],
		};
	}
	if (change.kind === "weights") {
		const entries = Object.entries(change.after);
		return {
			eyebrow: "Exam weights",
			title: entries.map(([id]) => change.names[id] ?? id).join(", "),
			lines: entries.map(([id, e]) => `${change.names[id] ?? id}: ${e ? WEIGHT_LABELS[e.w as SkillWeightValue] ?? `weight ${e.w}` : "back to the default"}${change.before[id] && e && change.before[id]!.w !== e.w ? ` (was ${change.before[id]!.w})` : ""}`),
		};
	}
	if (change.kind === "setting") {
		return { eyebrow: FIELD_LABELS[change.field], title: settingValue(change.field, change.after), lines: [`Was: ${settingValue(change.field, change.before)}`] };
	}
	if (change.kind === "self-report-retract") {
		const was = [...new Set(change.before.map((r) => STANCE_LABELS[r.stance]))];
		return { eyebrow: "Taken back", title: change.skillNames.join(", "), lines: [`You had said: ${was.join("; ")}`, "Your practice results decide it again."] };
	}
	if (change.kind === "note") {
		const moved = change.before.date !== change.after.date ? [`Was ${day(change.before.date)}`] : [];
		return { eyebrow: "Lecture note", title: change.after.title, lines: [day(change.after.date), ...(change.before.title !== change.after.title ? [`Was: ${change.before.title}`] : []), ...moved] };
	}
	const a = change.after ?? change.before!;
	const verb = change.action === "added" ? "Added" : change.action === "updated" ? "Changed" : "Removed";
	const when = a.date ? day(a.date) : "no date";
	const moved = change.action === "updated" && change.before && change.before.date !== a.date ? ` (was ${change.before.date ? day(change.before.date) : "no date"})` : "";
	return {
		eyebrow: `${verb} · ${KIND_LABELS[a.kind]}`,
		title: a.title,
		lines: [`${when}${moved}`, ...(a.topics ? [a.topics] : []), ...(change.skillNames.length > 0 ? [`Skills: ${change.skillNames.join(", ")}`] : [])],
	};
}

/** The card's body, separate from the fetch so it renders in tests. `status`: applied = Undo offered; changed = undone or
 *  changed since; null = not known yet. */
export function ClassChangeView({ change, status, busy = false, error, onUndo }: { change: ClassChangeData; status: "applied" | "changed" | "undone" | null; busy?: boolean; error?: string | null; onUndo: () => void }) {
	const { eyebrow, title, lines } = classChangeLines(change);
	return (
		<div data-testid="class-change" data-status={status ?? "unknown"} className="my-3 rounded-xl border bg-card px-4 py-3">
			<div className="lh-eyebrow text-muted-foreground">{eyebrow}</div>
			<div className={cn((status === "undone" || status === "changed") && "opacity-60")}>
				<div className={cn("text-chrome font-semibold", ((change.kind === "assessment" || change.kind === "lecture") && change.action === "removed") || status === "undone" ? "line-through decoration-muted-foreground" : null)}>{title}</div>
				{lines.map((l, i) => (
					<div key={i} className="text-meta text-muted-foreground">
						{l}
					</div>
				))}
			</div>
			{/* UI round 8: the state change is a line of its own where Undo was, not small grey text in a corner */}
			{(status === "undone" || status === "changed") && (
				<p className="mt-2 flex items-center gap-1.5 rounded-md bg-raised px-2 py-1 text-meta text-foreground" data-testid="class-change-status">
					<RotateCcwIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
					{status === "undone" ? "Undone." : "Undone or changed since, so it can't be undone from here."}
				</p>
			)}
			{status === "applied" && (
				<div className="mt-2">
					<button type="button" className={BTN} disabled={busy} data-testid="class-change-undo" onClick={onUndo}>
						Undo
					</button>
				</div>
			)}
			{error && <p className="mt-1 text-meta text-error">{error}</p>}
		</div>
	);
}

export function ClassChangeCard({ chatId, toolCallId, change }: { chatId: string; toolCallId: string; change: ClassChangeData }) {
	const [status, setStatus] = useState<"applied" | "changed" | "undone" | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const load = useCallback(() => {
		fetch(`/api/chats/${encodeURIComponent(chatId)}/class-changes`, { cache: "no-store" })
			.then((r) => (r.ok ? (r.json() as Promise<Record<string, "applied" | "changed">>) : null))
			.then((all) => {
				if (all && all[toolCallId]) setStatus((s) => (s === "undone" ? s : all[toolCallId]!));
			})
			.catch(() => {});
	}, [chatId, toolCallId]);
	useEffect(() => load(), [load]);
	const hub = useNotifyHub();
	useEffect(() => {
		if (!hub) return;
		const offs = [hub.subscribe("turn-settled", () => load()), hub.subscribe("courses-changed", () => load())];
		return () => offs.forEach((off) => off());
	}, [hub, load]);
	const undo = async () => {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/class-changes/${encodeURIComponent(toolCallId)}`, { method: "POST" });
			if (res.ok) setStatus("undone");
			else {
				setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not undo");
				load();
			}
		} catch {
			setError("Could not reach the server — try again.");
		} finally {
			setBusy(false);
		}
	};
	return <ClassChangeView change={change} status={status} busy={busy} error={error} onUndo={() => void undo()} />;
}
