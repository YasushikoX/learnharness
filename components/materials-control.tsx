"use client";

import { useRef, useState } from "react";
import { BookOpenIcon, CameraIcon, FileTextIcon, ImageIcon, LinkIcon, Loader2Icon, XIcon } from "lucide-react";
import { usePopoverDismiss } from "./popover-dismiss.ts";
import { indexingProgressLine, type LessonMaterial } from "@/src/core";
import { MenuShell } from "@/components/menu-shell";
import { Hint } from "@/components/ui/hint";
import { CONTROL_CLASS, type ControlVariant } from "@/components/control-variant";
import { buttonVariants } from "@/components/ui/button";
import { FIELD_CLASS } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** UI round 1b (SPEC §3): the popover's actions are 28px outline Buttons beside a 28px field; remove is a ghost icon. */
const ADD_BTN = buttonVariants({ variant: "outline", size: "sm", className: "text-xs" });
const REMOVE_BTN = buttonVariants({ variant: "ghost", size: "icon-xs", className: "text-muted-foreground hover:text-foreground" });
import { useMaterials } from "@/components/use-materials";

/**
 * The Sources pill (fork addition, 2026-10-24) — the stats bar's source
 * material control, beside the language and model pills:
 *
 *   chat mode (chatId)  the lesson's materials (GET /api/chats/:id/materials),
 *                       each with its reading status; add files or a link,
 *                       remove — the next turn uses the change.
 *   draft mode          what the new-lesson screen will attach: held in the
 *                       draft store and uploaded right after the lesson is
 *                       created (materials-client.ts).
 *   course mode         a course's curriculum (courseId — fork addition,
 *                       docs/courses.md): the chat mode against the course's
 *                       endpoint; `onChange` tells the course page.
 *
 * UI class page (2026-11-25): the class page no longer opens this popover; its files sit in the class side panel
 * (class-files.tsx). Both read and write through useMaterials (use-materials.tsx) and show the same MaterialRow.
 */

/** What the user should know about a material's conversion and indexing. Pure. */
export function materialNotes(m: LessonMaterial): string[] {
	return [m.conversionError?.message, ...(m.conversionWarnings ?? []), m.indexingError?.message, ...(m.indexingWarnings ?? [])].filter((s): s is string => Boolean(s));
}

/** One row's status line. Pure — exported for pins. */
export function materialStatusLine(m: LessonMaterial): string {
	const p = m.conversionProgress;
	const converting = p ? `converting: ${p.stage}${p.donePages !== undefined && p.totalPages ? ` ${p.donePages}/${p.totalPages}` : ""}` : m.indexingProgress ? indexingProgressLine(m.indexingProgress) : undefined;
	if (m.status === "reading") return converting ? `reading… · ${converting}` : "reading…";
	if (converting) return converting;
	const notes = materialNotes(m);
	const note = notes.length > 0 ? ` · ${notes.join(" · ")}` : "";
	if (m.status === "error") return `not read${m.error ? ` — ${m.error}` : ""}${note}`;
	const base = m.kind === "pdf" && m.pages ? pagesLabel(m.pages) : m.kind === "web" ? "web page" : m.kind === "image" ? "image" : "text";
	return `${m.originalElsewhere ? `${base} · original on another device` : base}${note}`;
}

/** "1 page", "12 pages". Pure. */
export function pagesLabel(pages: number): string {
	return pages === 1 ? "1 page" : `${pages} pages`;
}

/** The pill's label. Pure. */
export function sourcesLabel(count: number, reading: number): string {
	if (reading > 0) return `Reading ${reading}…`;
	return count === 0 ? "Sources" : `Sources · ${count}`;
}

export function KindIcon({ kind }: { kind: LessonMaterial["kind"] | "file" | "link" }) {
	const cls = "size-3.5 shrink-0 text-muted-foreground";
	if (kind === "web" || kind === "link") return <LinkIcon className={cls} />;
	if (kind === "image") return <ImageIcon className={cls} />;
	return <FileTextIcon className={cls} />;
}

/**
 * One material as a row: its kind, its name, its status line (conversion and indexing progress, errors in the error
 * colour) and a remove button. With `confirmRemove` the first press asks ("Remove?") and only the second removes.
 */
export function MaterialRow({ material: m, onRemove, confirmRemove = false }: { material: LessonMaterial; onRemove: () => void; confirmRemove?: boolean }) {
	const [asking, setAsking] = useState(false);
	return (
		<div className="flex items-center gap-2 rounded-md px-1 py-1" data-testid={`material-${m.id}`} onMouseLeave={() => setAsking(false)}>
			{m.status === "reading" ? <Loader2Icon className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Reading" /> : <KindIcon kind={m.kind} />}
			<span className="min-w-0 flex-1">
				<span className="block truncate text-foreground" title={m.url ?? m.name}>
					{m.name}
				</span>
				<span
					className={`block truncate text-meta ${m.status === "error" ? "text-error" : "text-muted-foreground"}`}
					data-testid={`material-status-${m.id}`}
					title={m.conversionProgress || m.indexingProgress ? materialStatusLine(m) : ([m.error, ...materialNotes(m)].filter(Boolean).join(" · ") || undefined)}
				>
					{materialStatusLine(m)}
				</span>
			</span>
			{confirmRemove && asking ? (
				<span className="flex shrink-0 items-center gap-1">
					<button type="button" data-testid={`material-remove-cancel-${m.id}`} onClick={() => setAsking(false)} className={buttonVariants({ variant: "ghost", size: "xs" })}>
						Keep
					</button>
					<button type="button" data-testid={`material-remove-confirm-${m.id}`} onClick={onRemove} className={buttonVariants({ variant: "destructiveSolid", size: "xs" })}>
						Remove
					</button>
				</span>
			) : (
				<button type="button" aria-label={`Remove ${m.name}`} data-testid={`material-remove-${m.id}`} onClick={() => (confirmRemove ? setAsking(true) : onRemove())} className={REMOVE_BTN}>
					<XIcon />
				</button>
			)}
		</div>
	);
}

export function MaterialsControl({
	chatId: lessonId,
	courseId,
	onChange,
	variant = "pill",
}: {
	chatId?: string;
	courseId?: string;
	/** Course mode: the materials as read, after every refresh. */
	onChange?: (materials: LessonMaterial[]) => void;
	/** pill: the floating chrome · edge: the quiet button on the composer shell's bottom edge (owner, 2026-10-25). */
	variant?: ControlVariant;
}) {
	// One owner id for the requests: the course's, else the lesson's.
	const chatId = courseId ?? lessonId;
	const files = useMaterials(chatId, onChange);
	const { materials, draft, reading, busy, error } = files;
	const [open, setOpen] = useState(false);
	const [url, setUrl] = useState("");
	const containerRef = useRef<HTMLDivElement>(null);

	// Outside pointerdown, Esc and the Android back close it through the shared popup layer (interaction-layers.tsx).
	usePopoverDismiss(containerRef, open, () => setOpen(false));

	const submitLink = async () => {
		if (await files.addUrl(url)) setUrl("");
	};

	const count = chatId ? materials.length : draft.length;
	return (
		<div ref={containerRef} className="relative flex items-center" data-testid="materials-control">
			<Hint label={courseId ? "This class's curriculum" : chatId ? "This lesson's source material" : "Source material for the new lesson"} side="bottom">
				<button
					type="button"
					data-testid="stats-materials"
					aria-expanded={open}
					onClick={() => {
						setOpen((o) => !o);
						files.clearError();
					}}
					className={CONTROL_CLASS[variant]}
				>
					{reading > 0 ? <Loader2Icon className="size-3.5 animate-spin" /> : <BookOpenIcon className="size-3.5 text-muted-foreground" />}
					<span className="text-card-foreground">{sourcesLabel(count, reading)}</span>
				</button>
			</Hint>
			{files.node}
			{open && (
				<MenuShell anchorRef={containerRef} testid="materials-menu" preferredSide="up" align="right" menuClass="flex w-80 flex-col gap-1 lh-menu p-2">
					<div className="px-1 pb-1 text-xs text-muted-foreground">The material sets the lesson&apos;s target; teaching uses its definitions, notation and terms and cites it.</div>
					{chatId
						? materials.map((m) => <MaterialRow key={m.id} material={m} onRemove={() => void files.remove(m.id)} />)
						: draft.map((d) => (
								<div key={d.key} className="flex items-center gap-2 rounded-md px-1 py-1" data-testid={`draft-material-${d.key}`}>
									<KindIcon kind={d.kind === "link" ? "link" : "file"} />
									<span className="min-w-0 flex-1 truncate text-foreground">{d.kind === "file" ? d.file.name : d.url}</span>
									<button type="button" aria-label="Remove" onClick={() => void files.remove(d.key)} className={REMOVE_BTN}>
										<XIcon />
									</button>
								</div>
							))}
					{count === 0 && <div className="px-1 py-1 text-muted-foreground">No source material yet.</div>}
					<div className="mt-1 flex items-center gap-1.5 border-t border-border pt-2">
						<button type="button" disabled={busy} data-testid="materials-add-files" onClick={files.pickFiles} className={ADD_BTN}>
							Add files…
						</button>
						{files.camera.available && (
							<button type="button" disabled={busy} data-testid="materials-camera" onClick={files.camera.open} className={ADD_BTN}>
								<CameraIcon />
								Camera
							</button>
						)}
						<input
							value={url}
							onChange={(e) => setUrl(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") void submitLink();
							}}
							placeholder="or paste a link"
							aria-label="Source link"
							data-testid="materials-link-input"
							disabled={busy}
							className={cn(FIELD_CLASS, "h-7 min-w-0 flex-1 px-2 text-xs")}
						/>
					</div>
					<div className="px-1 text-xs text-muted-foreground">PDF, text, Markdown, images, a photo, or a web link</div>
					{error && <div className="px-1 text-error" data-testid="materials-error">{error}</div>}
				</MenuShell>
			)}
		</div>
	);
}
