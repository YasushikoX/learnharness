"use client";

import { useState } from "react";
import { CameraIcon, PlusIcon, UploadIcon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { FIELD_CLASS } from "@/components/ui/input";
import { MaterialRow } from "@/components/materials-control";
import { ErrorNotice } from "@/components/ui/error-notice";
import { SHORT_LIST_ROWS, ShortList } from "@/components/ui/short-list";
import type { MaterialsApi } from "@/components/use-materials";
import type { LessonMaterial } from "@/src/core";
import { cn } from "@/lib/utils";

/**
 * A class's files, inline (UI class page, 2026-11-25; owner: "the files should be on the side, it shouldn't be a pop-up
 * you can easily close"). The list (name, pages, conversion and indexing status, remove after a confirm), then Add
 * files, Camera and a link field. It replaces the Sources popover on the class page. The empty class's drop zone
 * (FileDropZone) uses the same upload path; drops anywhere on the class page land here too (course-page.tsx).
 */

const BTN = buttonVariants({ variant: "outline" });

/** The header's count and status beside "Files": "37", "37 · 3 reading", "37 · 1 failed". Pure. */
export function filesCount(count: number, reading: number, failed = 0): string | null {
	if (count === 0) return null;
	return [String(count), reading > 0 ? `${reading} reading` : null, failed > 0 ? `${failed} failed` : null].filter(Boolean).join(" · ");
}

/**
 * The Files list's order and its collapsed rows (UI long lists, 2026-11-26): the files that failed, then those still
 * being read, then the rest newest first. Collapsed shows the first SHORT_LIST_ROWS of that, and every failed file even
 * when there are more, so a failure is never behind "Show all". Pure.
 */
export function fileRows<M extends Pick<LessonMaterial, "status" | "addedAt">>(materials: readonly M[]): { items: M[]; preview: M[] } {
	const rank = (m: M) => (m.status === "error" ? 0 : m.status === "reading" ? 1 : 2);
	const items = materials
		.map((m, i) => ({ m, i }))
		.sort((a, b) => rank(a.m) - rank(b.m) || (a.m.addedAt < b.m.addedAt ? 1 : a.m.addedAt > b.m.addedAt ? -1 : b.i - a.i))
		.map((x) => x.m);
	const failed = items.filter((m) => m.status === "error").length;
	return { items, preview: items.slice(0, Math.max(SHORT_LIST_ROWS, failed)) };
}

/** The link field: Enter adds it. */
function LinkField({ files, className }: { files: MaterialsApi; className?: string }) {
	const [url, setUrl] = useState("");
	return (
		<input
			value={url}
			onChange={(e) => setUrl(e.target.value)}
			onKeyDown={(e) => {
				if (e.key === "Enter") void files.addUrl(url).then((ok) => ok && setUrl(""));
			}}
			placeholder="Paste a link"
			aria-label="Class file link"
			data-testid="materials-link-input"
			disabled={files.busy}
			className={cn(FIELD_CLASS, "h-8 min-w-0 px-2.5 text-chrome", className)}
		/>
	);
}

/** Add files, Camera (where there is one) and the link field: one 32px row. */
export function AddFilesRow({ files }: { files: MaterialsApi }) {
	return (
		<div className="flex items-center gap-2">
			<button type="button" disabled={files.busy} data-testid="materials-add-files" onClick={files.pickFiles} className={BTN}>
				<PlusIcon aria-hidden />
				Add files…
			</button>
			{files.camera.available && (
				<button type="button" disabled={files.busy} data-testid="materials-camera" onClick={files.camera.open} className={buttonVariants({ variant: "outline", size: "icon" })} aria-label="Camera" title="Camera">
					<CameraIcon aria-hidden />
				</button>
			)}
			<LinkField files={files} className="flex-1" />
		</div>
	);
}

/** `setup`: the empty class's center holds the large drop zone and the errors, so the panel shows neither again. */
export function ClassFiles({ files, dropping = false, setup = false, courseId }: { files: MaterialsApi; dropping?: boolean; setup?: boolean; courseId?: string }) {
	const failed = files.materials.filter((m) => m.status === "error").length;
	const count = filesCount(files.materials.length, files.reading, failed);
	const { items, preview } = fileRows(files.materials);
	return (
		<section data-testid="class-files" aria-label="Class files" className="space-y-2">
			<h2 className="flex items-baseline text-body font-semibold text-foreground">
				Files
				{count && <span className="ml-2 font-normal tabular-nums text-muted-foreground" data-testid="class-files-count">{count}</span>}
			</h2>
			{/* the ways to add stay above the list, so a long list never pushes them down (UI long lists) */}
			{files.materials.length > 0 && <AddFilesRow files={files} />}
			{files.materials.length > 0 && files.error && !setup && <ErrorNotice error={files.error} what="Couldn't add the file." testid="materials-error" />}
			{files.materials.length > 0 ? (
				<ShortList
					items={items}
					preview={preview}
					keyOf={(m) => m.id}
					text={(m) => m.name}
					noun="files"
					storageKey={courseId ? `${courseId}:files` : undefined}
					testid="class-files-list"
					className="text-chrome"
					rowsClassName="-mx-1"
					render={(m) => <MaterialRow material={m} confirmRemove onRemove={() => void files.remove(m.id)} />}
				/>
			) : setup ? null : (
				<button
					type="button"
					onClick={files.pickFiles}
					data-testid="class-files-empty"
					className={cn(
						"flex h-16 w-full items-center justify-center gap-2 rounded-lg border border-dashed text-chrome text-muted-foreground outline-none transition-colors duration-(--lh-duration-hover) hover:bg-raised hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus",
						dropping ? "border-primary bg-raised text-foreground" : "border-input",
					)}
				>
					<UploadIcon className="size-4" aria-hidden />
					Drop PDFs, notes or photos
				</button>
			)}
			{files.materials.length === 0 && <AddFilesRow files={files} />}
			{files.materials.length === 0 && files.error && !setup && <ErrorNotice error={files.error} what="Couldn't add the file." testid="materials-error" />}
		</section>
	);
}

/**
 * The empty class's large drop zone (UI class page): a dashed area that takes a drop or a click (the file picker), with
 * Camera and the link field below it. Files dropped here appear in the side panel's list.
 */
export function FileDropZone({ files, dropping = false }: { files: MaterialsApi; dropping?: boolean }) {
	return (
		<div className="space-y-2" data-testid="class-drop-zone">
			<button
				type="button"
				onClick={files.pickFiles}
				disabled={files.busy}
				data-testid="class-drop-zone-pick"
				className={cn(
					"flex h-36 w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-center outline-none transition-colors duration-(--lh-duration-hover) hover:bg-raised focus-visible:ring-2 focus-visible:ring-focus",
					dropping ? "border-primary bg-raised" : "border-input",
				)}
			>
				<UploadIcon className="size-5 text-muted-foreground" aria-hidden strokeWidth={1.75} />
				<span className="text-body font-medium text-foreground">Drop your class files here</span>
				<span className="text-meta text-muted-foreground">PDFs, notes, Markdown or photos. Or click to choose.</span>
			</button>
			<div className="flex items-center gap-2">
				{files.camera.available && (
					<button type="button" disabled={files.busy} data-testid="materials-camera" onClick={files.camera.open} className={BTN}>
						<CameraIcon aria-hidden />
						Camera
					</button>
				)}
				<LinkField files={files} className="flex-1" />
			</div>
			{files.error && <ErrorNotice error={files.error} what="Couldn't add the file." testid="materials-error" />}
		</div>
	);
}
