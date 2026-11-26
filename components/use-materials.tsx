"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { MATERIAL_ACCEPT, isMaterialUrl, type LessonMaterial } from "@/src/core";
import { useCamera } from "@/components/use-camera";
import { addLink, draftKey, draftMaterials, fetchMaterials, materialsPath, uploadFiles, useDraftMaterials, type DraftMaterial } from "@/components/materials-client";

/**
 * One owner's source material, read and edited (UI class page, 2026-11-25): the list, the polling while something is
 * still being read, and the add / link / remove calls. The Sources popover (a lesson's material, or the new lesson's
 * draft) and the class page's Files (the class side panel and the empty class's drop zone) share it, so every surface
 * uploads the same way. Without an owner id the calls go to the new lesson's draft store.
 *
 * `node` must be rendered once by the caller: the hidden file input behind `pickFiles` and the camera's input/dialog.
 */
export interface MaterialsApi {
	/** The owner's materials as last read (empty for the draft store; see `draft`). */
	materials: LessonMaterial[];
	/** The draft store's items (no owner id). */
	draft: DraftMaterial[];
	/** How many materials are still being read. */
	reading: number;
	/** An upload or a link is being sent. */
	busy: boolean;
	error: string | null;
	clearError: () => void;
	addFiles: (files: File[]) => Promise<void>;
	/** Add a web link; resolves true when it was taken. */
	addUrl: (url: string) => Promise<boolean>;
	remove: (id: string) => Promise<void>;
	/** Open the file picker. */
	pickFiles: () => void;
	camera: { available: boolean; open: () => void };
	node: ReactNode;
}

export function useMaterials(ownerId: string | undefined, onChange?: (materials: LessonMaterial[]) => void): MaterialsApi {
	const draft = useDraftMaterials();
	const [materials, setMaterials] = useState<LessonMaterial[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const fileRef = useRef<HTMLInputElement>(null);

	const read = useCallback(() => {
		if (ownerId)
			void fetchMaterials(ownerId)
				.then((list) => {
					setMaterials(list);
					onChange?.(list);
				})
				.catch(() => {});
	}, [ownerId, onChange]);
	useEffect(read, [read]);
	// poll while anything is still being read
	const reading = materials.filter((m) => m.status === "reading").length;
	useEffect(() => {
		if (!ownerId || reading === 0) return;
		const id = setInterval(read, 2000);
		return () => clearInterval(id);
	}, [ownerId, reading, read]);

	const addFiles = async (files: File[]) => {
		if (files.length === 0) return;
		setError(null);
		if (!ownerId) {
			draftMaterials.add(files.map((file): DraftMaterial => ({ key: draftKey(), kind: "file", file })));
			return;
		}
		setBusy(true);
		const err = await uploadFiles(ownerId, files).catch(() => "upload failed");
		setBusy(false);
		if (err) setError(err);
		read();
	};

	const camera = useCamera((files) => void addFiles(files));

	const addUrl = async (url: string): Promise<boolean> => {
		const value = url.trim();
		if (!isMaterialUrl(value)) {
			setError("Enter an http(s) link");
			return false;
		}
		setError(null);
		if (!ownerId) {
			draftMaterials.add([{ key: draftKey(), kind: "link", url: value }]);
			return true;
		}
		setBusy(true);
		const err = await addLink(ownerId, value).catch(() => "could not add the link");
		setBusy(false);
		if (err) setError(err);
		read();
		return !err;
	};

	const remove = async (id: string) => {
		if (!ownerId) {
			draftMaterials.remove(id);
			return;
		}
		await fetch(`${materialsPath(ownerId)}/${id}`, { method: "DELETE" }).catch(() => {});
		read();
	};

	const node = (
		<>
			{camera.node}
			<input
				ref={fileRef}
				type="file"
				multiple
				accept={MATERIAL_ACCEPT}
				className="hidden"
				data-testid="materials-file-input"
				onChange={(e) => {
					const files = Array.from(e.currentTarget.files ?? []);
					e.currentTarget.value = ""; // the same file can be picked again
					void addFiles(files);
				}}
			/>
		</>
	);

	return {
		materials,
		draft,
		reading: ownerId ? reading : 0,
		busy,
		error,
		clearError: () => setError(null),
		addFiles,
		addUrl,
		remove,
		pickFiles: () => fileRef.current?.click(),
		camera: { available: camera.available, open: camera.open },
		node,
	};
}

/** The files a drag carries, or none for a drag of text or a link. */
export function dragHasFiles(event: { dataTransfer: DataTransfer | null }): boolean {
	return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}
