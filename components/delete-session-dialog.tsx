"use client";

import { buttonVariants } from "@/components/ui/button";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { HostDialog } from "@/components/host-dialog";
import type { ChatDeleteMode, ChatListItem, CourseDeletionImpact, FolderDeletionScope } from "@/src/core";

/** The graph-traces checkbox copy (owner, 2026-09-24 flow rework — was
 *  the delete-nodes option's body in the two-button design): the
 *  graph-touching consequence says so, shared-topic survival included.
 *  Exported pure for render pins: the copy is design, not implementation. */
export const TRACES_COPY = {
	testid: "delete-traces",
	checkbox: "delete-traces-checkbox",
	title: "Also remove its graph traces",
	body: "This session’s topics, links, and events leave the graph too. Topics other sessions or imported notes also cover survive; topics only this session created are removed entirely.",
};

export interface DeleteDialogCopy {
	label: string;
	testid: string;
	heading: string;
	body: string;
	/** The body when the deletion takes (or may take) course progress: the graph promise, qualified. */
	courseLossBody: string;
	/** How many sessions the deletion removes (the course-loss wording's numbers). */
	sessions: number;
	traces: { title: string; body: string };
}

export const SESSION_DELETE_COPY: DeleteDialogCopy = {
	label: "Delete session",
	testid: "delete-session-dialog",
	heading: "Delete session?",
	body: "This permanently removes the session — its messages, background jobs, and extraction records. Everything it added to the graph stays unless you check below. This cannot be undone.",
	courseLossBody: "This permanently removes the session — its messages, background jobs, and extraction records. Everything it added to the graph stays unless you check below, except its course progress. This cannot be undone.",
	sessions: 1,
	traces: TRACES_COPY,
};

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What a delete dialog knows about the course progress the deletion takes (POST /api/courses/deletion-impact).
 *  Merge review finding 1: skill progress is derived from the course sessions' transcripts, so it goes with them in
 *  either mode — the dialog must say so instead of promising that everything stays. */
export type CourseLoss = { status: "checking" } | { status: "unknown" } | { status: "known"; impact: CourseDeletionImpact };

/** “A”, “A” and “B”, “A”, “B” and “C”; deleted courses collapse into “a deleted course” or “N deleted courses”. */
function courseNames(impact: CourseDeletionImpact): string {
	const named: string[] = [];
	let deleted = 0;
	for (const c of impact.courses) {
		if (c.title === null) deleted++;
		else named.push(`“${c.title}”`);
	}
	const parts = deleted > 0 ? [...named, deleted === 1 ? "a deleted course" : `${deleted} deleted courses`] : named;
	return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0] ?? "a course";
}

/** True when the deletion takes, or may take, course progress (the qualified body shows). */
export function mayLoseCourseProgress(loss: CourseLoss | undefined): boolean {
	return loss !== undefined && (loss.status !== "known" || loss.impact.sessions > 0);
}

/** The plain-words course-progress line under the body, or null when nothing is lost. `total` is how many sessions
 *  the deletion removes, so the line can say how many of them are course sessions. Set `eitherMode: false` when the
 *  loss is already conditional on a checkbox (the graph Sources dialog) instead of happening in both modes below. */
export function courseLossWarning(
	loss: CourseLoss | undefined,
	total: number,
	{ eitherMode = true }: { eitherMode?: boolean } = {},
): string | null {
	if (!loss) return null;
	const one = total === 1;
	if (loss.status === "checking") return `Checking whether ${one ? "this session" : "these sessions"} recorded course progress…`;
	if (loss.status === "unknown") {
		return one
			? "Couldn’t check whether this session recorded course progress. If it came from a course, the skills it taught or checked lose that progress."
			: "Couldn’t check whether these sessions recorded course progress. If any came from a course, the skills they taught or checked lose that progress.";
	}
	const { sessions, skills } = loss.impact;
	if (sessions === 0) return null;
	const from = courseNames(loss.impact);
	const who = one
		? `This is a course session from ${from}.`
		: sessions === total
			? `${total === 2 ? "Both" : `All ${total}`} sessions are course sessions, from ${from}.`
			: `${sessions} of these ${total} sessions ${sessions === 1 ? "is a course session" : "are course sessions"}, from ${from}.`;
	const it = sessions === 1 ? "it" : "they";
	const what = skills > 0 ? `the ${count(skills, "skill", "skills")} ${it} taught or checked ${skills === 1 ? "loses" : "lose"}` : `the skills ${it} taught or checked lose`;
	const suffix = eitherMode ? ", whichever you choose below." : ".";
	return `${who} Deleting ${sessions === 1 ? "it" : "them"} also deletes the course progress ${it} recorded: ${what} that progress${suffix}`;
}

/** Ask the server what deleting these sessions takes from the courses; null ids = the dialog is closed. Every open or
 *  selection change gets a fresh request id starting at "checking", so reopening or revisiting a selection never shows
 *  a stale answer or accepts a late response from an earlier request. */
export function useCourseLoss(chatIds: readonly string[] | null): CourseLoss | undefined {
	const key = chatIds === null ? null : JSON.stringify(chatIds);
	const [session, setSession] = useState<{ key: string | null; id: number }>({ key, id: 0 });
	let reqId = session.id;
	if (session.key !== key) {
		reqId = session.id + 1;
		setSession({ key, id: reqId });
	}
	const [answer, setAnswer] = useState<{ id: number; loss: CourseLoss } | null>(null);
	useEffect(() => {
		if (key === null) return;
		let alive = true;
		const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
		void fetch("/api/courses/deletion-impact", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chatIds: JSON.parse(key) }),
			...(controller ? { signal: controller.signal } : {}),
		})
			.then(async (res) => {
				if (!res.ok) throw new Error(String(res.status));
				const impact = (await res.json()) as CourseDeletionImpact;
				if (alive) setAnswer({ id: reqId, loss: { status: "known", impact } });
			})
			.catch(() => { if (alive) setAnswer({ id: reqId, loss: { status: "unknown" } }); });
		return () => { alive = false; controller?.abort(); };
	}, [key, reqId]);
	if (key === null) return undefined;
	return answer?.id === reqId ? answer.loss : { status: "checking" };
}

/** The folder Delete's wording (owner, 2026-11-18): the session dialog's
 *  shape, plural, saying what goes and where notes move. */
export function folderDeleteCopy(input: { sessions: number; subfolders: number; notes: number; parentName: string | null }): DeleteDialogCopy {
	const what = [count(input.sessions, "session", "sessions"), ...(input.subfolders ? [count(input.subfolders, "subfolder", "subfolders")] : [])].join(" and ");
	const notes = input.notes
		? ` ${count(input.notes, "imported notes file", "imported notes files")} inside ${input.notes === 1 ? "moves" : "move"} to ${input.parentName === null ? "the top level" : `“${input.parentName}”`}.`
		: "";
	const removes = `This permanently removes the folder and the ${what} inside — the sessions’ messages, background jobs, and extraction records.`;
	return {
		label: "Delete folder",
		testid: "delete-folder-dialog",
		heading: "Delete folder?",
		body: `${removes} Everything they added to the graph stays unless you check below.${notes} This cannot be undone.`,
		courseLossBody: `${removes} Everything they added to the graph stays unless you check below, except their course progress.${notes} This cannot be undone.`,
		sessions: input.sessions,
		traces: {
			title: "Also remove their graph traces",
			body: "These sessions’ topics, links, and events leave the graph too. Topics other sessions or imported notes also cover survive; topics only these sessions created are removed entirely.",
		},
	};
}

/**
 * Session deletion (wave 6 chunk A; owner flow rework 2026-09-24) — THE
 * destructive-confirmation surface, portaled z-50 like the setup dialog,
 * now in the node dialog's shape (the two must read as one design):
 *
 *   - red title "Delete session?" in the abort-turn look (owner, 2026-10-13
 *     polish: text-sm font-semibold JetBrains Mono via the UI default —
 *     the serif display title is gone), the session name below it in
 *     JetBrains Mono at normal text-sm size (was sized-up text-lg), no
 *     code-block chrome;
 *   - ONE unchecked-by-default checkbox "Also remove its graph traces"
 *     (unchecked = preserve-graph: the session record, its jobs, and its
 *     extraction bookkeeping die; the graph keeps every contribution.
 *     checked = delete-nodes: the session's ledger traces go too);
 *   - a bottom row Cancel + destructive-red Delete, exactly the node
 *     dialog's pair.
 *
 * Retryable failures render honestly with a Try-again: 409 turn_in_flight /
 * jobs_running ("wait for running work") and 503 extraction_winding_down
 * ("in a moment") both clear on their own — the server's error line is
 * already written for the user; we show it verbatim. Try-again is just
 * Delete pressed again — the mode re-derives from the checkbox.
 */
export function DeleteSessionDialog({
	chat,
	onClose,
	onDeleted,
}: {
	/** The session up for deletion; null = closed. */
	chat: Pick<ChatListItem, "id" | "title"> | null;
	onClose: () => void;
	/** Success path — the sidebar owns navigation + list patching. */
	onDeleted: (id: string, mode: ChatDeleteMode, graphRevision: number) => void;
}) {
	const [traces, setTraces] = useState(false);
	const [busy, setBusy] = useState(false);
	// Retry IS pressing Delete again: the mode always derives from the
	// checkbox's current state (a toggle between failure and retry is a
	// change of intent, honored as such — the checkbox is disabled while
	// busy, so no mid-flight switches).
	const [failure, setFailure] = useState<{ code: string; error: string } | null>(null);
	const courseLoss = useCourseLoss(chat ? [chat.id] : null);

	// Fresh state per session: closing resets, opening a new chat starts clean.
	useEffect(() => {
		if (!chat) {
			setTraces(false);
			setBusy(false);
			setFailure(null);
		}
	}, [chat]);

	const run = async () => {
		if (!chat || busy || courseLoss?.status === "checking") return;
		const mode: ChatDeleteMode = traces ? "delete-nodes" : "preserve-graph";
		setBusy(true);
		setFailure(null);
		try {
			const res = await fetch(`/api/chats/${chat.id}?mode=${mode}`, { method: "DELETE" });
			const body = (await res.json()) as {
				ok?: boolean;
				error?: string;
				code?: string;
				graphRevision?: number;
			};
			if (!res.ok) {
				// 409 (turn/jobs running) and 503 (extraction winding down) are
				// both retryable — keep the dialog open, show the server's line.
				setFailure({ code: body.code ?? "error", error: body.error ?? `Delete failed (${res.status})` });
				setBusy(false);
				return;
			}
			onDeleted(chat.id, mode, body.graphRevision ?? 0);
		} catch {
			setFailure({ code: "network", error: "Delete failed — network error. Try again." });
			setBusy(false);
		}
	};

	if (!chat) return null;

	return <DeleteSessionBody
				chat={chat}
				courseLoss={courseLoss}
				traces={traces}
				busy={busy}
				failure={failure}
				onTraces={(next) => setTraces(next)}
				onClose={onClose}
				onRun={() => void run()}
				renderFrame={(frame) => <HostDialog open frame={frame} onClose={() => {
					if (busy) return "blocked";
					onClose(); return "closed";
				}} backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center lh-scrim" }}>{frame.props.children}</HostDialog>}
			/>;
}

/** The dialog's pure body — exported for SSR pins (the settings-dialog /
 *  node-dialog body pattern). The wrapper owns state + effects + portal. */
export function DeleteSessionBody({
	chat,
	traces,
	busy,
	failure,
	onTraces,
	onClose,
	onRun,
	renderFrame,
	copy = SESSION_DELETE_COPY,
	courseLoss,
}: {
	chat: Pick<ChatListItem, "id" | "title">;
	/** What the deletion takes from the courses; absent = nothing (the plain copy). Delete waits while it is checked. */
	courseLoss?: CourseLoss;
	/** The graph-traces checkbox — unchecked by default (preserve-graph). */
	traces: boolean;
	busy: boolean;
	failure: { code: string; error: string } | null;
	onTraces: (next: boolean) => void;
	onClose: () => void;
	onRun: () => void;
	renderFrame?: (frame: ReactElement<{ children: ReactNode }>) => ReactNode;
	/** The wording; the folder Delete reuses this exact surface. */
	copy?: DeleteDialogCopy;
}) {
	const warning = courseLossWarning(courseLoss, copy.sessions);
	const checking = courseLoss?.status === "checking";
	const frame = (
		<div
			role="dialog"
			aria-modal="true"
			aria-label={copy.label}
			data-testid={copy.testid}
			onClick={(e) => e.stopPropagation()}
			className="w-[32rem] max-w-[calc(100vw-2rem)] lh-dialog p-6"
		>
			<h2 className="text-[15px] font-semibold leading-5 text-destructive">{copy.heading}</h2>
			{/* The session name below the title in JetBrains Mono (owner,
			    2026-09-24): no code-block chrome — the font already says
			    code. Owner, 2026-10-13 polish: normal text-sm size (was
			    sized-up text-lg), still white. Same shape as the node
			    dialog. */}
			<div className="mt-1.5">
				<code data-testid="session-name-code" className="font-sans text-sm font-medium text-foreground">
					{chat.title}
				</code>
			</div>
			<p className="mt-2 text-sm text-muted-foreground">{mayLoseCourseProgress(courseLoss) ? copy.courseLossBody : copy.body}</p>
			{warning && (
				<p data-testid="delete-course-loss" role={checking ? "status" : "alert"} className={checking ? "mt-2 text-xs text-muted-foreground" : "mt-2 text-sm text-destructive"}>
					{warning}
				</p>
			)}
			<label
				data-testid={TRACES_COPY.testid}
				className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/60 px-4 py-3"
			>
				<input
					type="checkbox"
					data-testid={TRACES_COPY.checkbox}
					checked={traces}
					onChange={(e) => onTraces(e.target.checked)}
					disabled={busy}
					className="mt-0.5 size-4 shrink-0 accent-primary"
				/>
				<span className="min-w-0">
					<span className="block text-sm text-foreground">{copy.traces.title}</span>
					<span className="mt-1 block text-xs text-muted-foreground">{copy.traces.body}</span>
				</span>
			</label>
			{failure && (
				<div
					role="alert"
					data-testid="delete-failure"
					className="mt-3 rounded-sm border border-border/60 px-3 py-2 text-xs"
				>
					<span className="text-foreground">{failure.error}</span>
					<button
						type="button"
						data-testid="delete-retry"
						onClick={onRun}
						disabled={busy}
						className="ml-3 text-xs text-foreground underline-offset-2 hover:underline disabled:opacity-40"
					>
						Try again
					</button>
				</div>
			)}
			{/* The node dialog's exact bottom row: quiet Cancel, destructive
			    red Delete (border + text, fill on hover — the app's
			    established destructive pair). */}
			<div className="mt-4 flex justify-end gap-2">
				<button
					type="button"
					data-testid="delete-cancel"
					onClick={onClose}
					disabled={busy}
					className={buttonVariants({ variant: "ghost", size: "sm" })}
				>
					Cancel
				</button>
				<button
					type="button"
					data-testid="delete-confirm"
					onClick={onRun}
					disabled={busy || checking}
					className={buttonVariants({ variant: "destructiveSolid", size: "sm" })}
				>
					{busy ? "Deleting…" : "Delete"}
				</button>
			</div>
		</div>
	);
	return renderFrame ? renderFrame(frame) : frame;
}
/** The sidebar's folder Delete, on the session dialog's surface: the same
 *  unchecked traces box, the same retryable-failure line. */
export function DeleteFolderDialog({
	folder,
	onClose,
	onDeleted,
	onStale,
}: {
	folder: { id: string; name: string; copy: DeleteDialogCopy; scope: FolderDeletionScope } | null;
	onStale: (message: string) => void;
	onClose: () => void;
	onDeleted: (result: { deletedChatIds: string[]; graphRevision: number }) => void;
}) {
	const [traces, setTraces] = useState(false);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<{ code: string; error: string } | null>(null);
	const courseLoss = useCourseLoss(folder ? folder.scope.chatIds : null);
	useEffect(() => {
		if (!folder) {
			setTraces(false);
			setBusy(false);
			setFailure(null);
		}
	}, [folder]);

	const run = async () => {
		if (!folder || busy || courseLoss?.status === "checking") return;
		const mode: ChatDeleteMode = traces ? "delete-nodes" : "preserve-graph";
		setBusy(true);
		setFailure(null);
		try {
			const res = await fetch(`/api/graph/sources/folders/${encodeURIComponent(folder.id)}?mode=${mode}`, {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(folder.scope),
			});
			const body = (await res.json()) as { error?: string; code?: string; graphRevision?: number; deletedChatIds?: string[] };
			if (body.code === "folder_scope_changed" || body.code === "not_found") {
				onStale(body.error ?? "This folder changed. Nothing was deleted.");
				return;
			}
			if (!res.ok) {
				setFailure({ code: body.code ?? "error", error: body.error ?? `Delete failed (${res.status})` });
				setBusy(false);
				return;
			}
			onDeleted({ deletedChatIds: body.deletedChatIds ?? [], graphRevision: body.graphRevision ?? 0 });
		} catch {
			setFailure({ code: "network", error: "Delete failed — network error. Try again." });
			setBusy(false);
		}
	};

	if (!folder) return null;
	return <DeleteSessionBody
				chat={{ id: folder.id, title: folder.name }}
				copy={folder.copy}
				courseLoss={courseLoss}
				traces={traces}
				busy={busy}
				failure={failure}
				onTraces={(next) => setTraces(next)}
				onClose={onClose}
				onRun={() => void run()}
				renderFrame={(frame) => <HostDialog open frame={frame} onClose={() => {
					if (busy) return "blocked";
					onClose(); return "closed";
				}} backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center lh-scrim" }}>{frame.props.children}</HostDialog>}
			/>;
}
