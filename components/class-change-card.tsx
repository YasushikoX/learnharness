"use client";

import { useCallback, useEffect, useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { dateWithWeekday, KIND_LABELS, type Assessment } from "@/src/core";
import { useNotifyHub } from "@/components/server-events";
import { cn } from "@/lib/utils";

/**
 * A Short question change, in the transcript (WP8, 2026-11-25): what the agent wrote when the learner stated a fact about
 * the class (an assessment added, changed or removed) or about themselves (a self-report), as one compact card in the
 * transcript's card style (the lesson-result card's), with Undo. Undo reverts exactly that change and is offered only
 * while the class still holds it (GET /api/chats/[id]/class-changes; the server reads the change from the record, never
 * from this card).
 */

const BTN = buttonVariants({ variant: "secondary", size: "sm" });

/** The change as the tool result's details carry it (agent/tools/class-facts.ts ClassChange). */
export type ClassChangeData =
	| { kind: "assessment"; courseId: string; action: "added" | "updated" | "removed"; before: Assessment | null; after: Assessment | null; skillNames: string[] }
	| { kind: "self-report"; courseId: string; report: { stance: "know" | "shaky" | "dont_know"; note: string; at: string }; skillNames: string[] };

const STANCE: Record<"know" | "shaky" | "dont_know", string> = { know: "You know", shaky: "Not sure about", dont_know: "Don't get yet" };

/** The card's lines. Pure. */
export function classChangeLines(change: ClassChangeData): { eyebrow: string; title: string; lines: string[] } {
	if (change.kind === "self-report") {
		return {
			eyebrow: "Noted",
			title: `${STANCE[change.report.stance]}: ${change.skillNames.join(", ")}`,
			lines: [change.report.stance === "know" ? "A short check comes up soon; practice results count over this." : change.report.stance === "dont_know" ? "It comes first in Next up or comes back for review." : "Its review comes sooner."],
		};
	}
	const a = change.after ?? change.before!;
	const verb = change.action === "added" ? "Added" : change.action === "updated" ? "Changed" : "Removed";
	const when = a.date ? dateWithWeekday(a.date) : "no date";
	const moved = change.action === "updated" && change.before && change.before.date !== a.date ? ` (was ${change.before.date ? dateWithWeekday(change.before.date) : "no date"})` : "";
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
		<div data-testid="class-change" className={cn("my-3 rounded-xl border bg-card px-4 py-3", status !== "applied" && status !== null && "opacity-80")}>
			<div className="flex items-center justify-between gap-2 lh-eyebrow text-muted-foreground">
				<span>{eyebrow}</span>
				{status === "undone" || status === "changed" ? (
					<span data-testid="class-change-status">{status === "undone" ? "undone" : "undone or changed since"}</span>
				) : null}
			</div>
			<div className={cn("text-chrome font-semibold", change.kind === "assessment" && change.action === "removed" && "line-through decoration-muted-foreground")}>{title}</div>
			{lines.map((l, i) => (
				<div key={i} className="text-meta text-muted-foreground">
					{l}
				</div>
			))}
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
