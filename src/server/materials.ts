import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	MATERIAL_MAX_BYTES,
	imageMimeType,
	isMaterialUrl,
	materialKindFor,
	materialsPromptSection,
	readMaterialIds,
	type LessonMaterial,
	type MaterialIndexingProgress,
} from "../core/materials.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { piEngineForSpec } from "../agent/models.ts";
import { profileMaterial } from "../agent/subagents/material-profiler.ts";
import { fetchLink } from "../agent/tools/web.ts";
import { materialTools } from "../agent/tools/materials.ts";
import type { MaterialStore } from "../core/ports.ts";
import { lectureNotesForTurn } from "./lecture-notes.ts";
import { convertPdfMaterial } from "./material-conversion.ts";
import type { MaterialConversionProgress } from "../core/pdf-converter.ts";
import {
	canIndexMaterial,
	dropStaleIndex,
	indexPdfMaterial,
	pendingIndexingError,
	profileFromDigest,
	retryPdfIndexing,
	rewritePdfProfile,
	rewriteRefusal,
	type IndexMaterialOptions,
} from "./material-indexing.ts";
import { hasProfile } from "../agent/subagents/material-digest.ts";
import { stores } from "./stores.ts";

/**
 * Lesson source material — the service seam (fork addition, 2026-10-24;
 * model: core/materials.ts). Adds uploads and links, profiles each
 * material ONCE in the background (one run per material, through the
 * shared background-LLM permits), and hands each turn its prompt section
 * and lookup tools. A turn waits briefly for profiles still being read.
 *
 * Crash safety: a material left "reading" by a dead process has no live
 * run — any read of the lesson's materials restarts it.
 *
 * OWNERS (courses, fork addition — docs/courses.md §1.2): material
 * belongs to a lesson (a chat id) or to a course (a course id). A course
 * session sees its course's material beside its own (sessionMaterials).
 */

type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

interface Run {
	promise: Promise<void>;
	controller: AbortController;
	progress?: MaterialConversionProgress;
	indexing?: MaterialIndexingProgress;
}
const KEY = Symbol.for("lh.materialRuns");
function runs(): Map<string, Run> {
	const g = globalThis as Record<symbol, Map<string, Run> | undefined>;
	g[KEY] ??= new Map();
	return g[KEY];
}
const runKey = (chatId: string, id: string) => `${chatId}/${id}`;
/** A conversion's progress onto its live run (listMaterials shows it). */
const progressTo = (key: string) => (progress: MaterialConversionProgress | undefined) => {
	const run = runs().get(key);
	if (run) run.progress = progress;
};

/** An indexing's progress onto its live run (material-indexing.ts). */
const indexingTo = (key: string) => (progress: MaterialIndexingProgress | undefined) => {
	const run = runs().get(key);
	if (run) run.indexing = progress;
};

/** How many materials are being read right now (the idle check reads this). */
export function materialRunCount(): number {
	return runs().size;
}

/** How long a turn waits for profiles still being read. */
const TURN_WAIT_MS = 180_000;

/** A material owner exists: a lesson, or a course. */
function ownerExists(ownerId: string): boolean {
	return stores.chatStore.getChat(ownerId) !== null || stores.courseStore.getCourse(ownerId) !== null;
}

function lessonStarted(chatId: string): boolean {
	return (stores.chatStore.getChat(chatId)?.messages ?? []).some((m) => (m as { role?: string }).role === "assistant");
}

const NO_VISION_MODEL = "no vision model is configured (Settings → Agent: the vision slot reads source material)";

/** The material's record as stored now (the run's copy may be older); undefined once it is removed. */
const current = (ownerId: string, id: string) => stores.materialStore.list(ownerId).find((m) => m.id === id);

/**
 * After a PDF's conversion run, whichever way it ended (a first read, a restart, a retry): drop what no longer
 * describes content.md (material-indexing.ts dropStaleIndex, THE INDEX INVARIANT) and, when no vision model is
 * configured, say that indexing is pending. Returns the material as stored now, or undefined once it was removed.
 */
function settleAfterConversion(ownerId: string, id: string, forced: boolean, hasModel: boolean): { material: LessonMaterial; profileDropped: boolean } | undefined {
	const material = current(ownerId, id);
	if (!material) return undefined;
	const settled = dropStaleIndex(ownerId, material, stores.materialStore, { forced });
	if (!hasModel && settled.converted && !settled.describes) stores.materialStore.update(ownerId, id, { indexingError: pendingIndexingError(settled.invalidReason) });
	const now = current(ownerId, id);
	return now ? { material: now, profileDropped: settled.profileDropped } : undefined;
}

/**
 * Index (a PDF) and profile one material on the vision slot: a converted PDF is indexed whole (material-indexing.ts)
 * and its digest's profile becomes the material's; otherwise the old profiler reads the original, always on a first
 * read (`fallback` "profiler") and only when the material has no profile left on a retry ("when_missing"). Never
 * rejects; an abort records nothing.
 */
async function indexAndProfile(ownerId: string, material: LessonMaterial, engine: ReturnType<typeof piEngineForSpec>, signal: AbortSignal, key: string, fallback: "profiler" | "when_missing"): Promise<void> {
	const { materialStore } = stores;
	const runsProfiler = fallback === "profiler" || !material.profile;
	try {
		const indexed =
			material.kind === "pdf"
				? await indexPdfMaterial(ownerId, material, { signal, store: materialStore, model: { engine, chatId: ownerId }, onProgress: indexingTo(key), fallback: runsProfiler ? "profiler" : "kept" })
				: undefined;
		if (signal.aborted) return;
		const digest = indexed?.digest;
		// hasProfile: the one test of "has a profile" (the notes digestNotes wrote use it too)
		if (digest && hasProfile(digest)) return void materialStore.update(ownerId, material.id, profileFromDigest(digest));
		if (!runsProfiler) return void materialStore.update(ownerId, material.id, { status: "ready" });
		// The profiler's model requests pass the process-wide worker-request admission (the one background-LLM pool).
		const result = await profileMaterial(
			{
				kind: material.kind,
				name: material.name,
				path: materialStore.filePath(ownerId, material),
				mimeType: material.mimeType,
			},
			{ engine, abortSignal: signal, chatId: ownerId },
		);
		if (signal.aborted) return;
		if (result.transcript !== undefined) {
			// images only (the profiler returns a transcript for no other kind): never a PDF's content.md
			fs.writeFileSync(materialStore.auxPath(ownerId, material.id, "content.md"), result.transcript, "utf8");
		}
		materialStore.update(ownerId, material.id, {
			status: "ready",
			profile: result.profile,
			profileFromDigest: undefined,
			...(result.pages !== undefined ? { pages: result.pages } : {}),
			error: undefined,
		});
	} catch (err) {
		if (signal.aborted) return; // removed while reading
		materialStore.update(ownerId, material.id, {
			status: "error",
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/** Profile one material in the background (idempotent per material). */
function startProfile(chatId: string, material: LessonMaterial): Promise<void> {
	const key = runKey(chatId, material.id);
	const live = runs().get(key);
	if (live) return live.promise;
	const controller = new AbortController();
	const { materialStore } = stores;
	const promise = (async () => {
		const spec = () => resolveRoleSpec("pdfReader", stores.settingsStore.readSettings());
		let target: LessonMaterial | undefined = material;
		// PDF → content.md first (material-conversion.ts); it never fails the material, and the profiler below reads the original.
		if (material.kind === "pdf") {
			await convertPdfMaterial(chatId, material, controller.signal, materialStore, stores.settingsStore.readSettings()?.pdfConversion, { onProgress: progressTo(key) });
			if (controller.signal.aborted) return;
			target = settleAfterConversion(chatId, material.id, false, !!spec())?.material;
			if (!target) return;
		}
		if (controller.signal.aborted) return;
		const resolved = spec();
		if (!resolved) return void materialStore.update(chatId, material.id, { status: "error", error: NO_VISION_MODEL });
		let engine: ReturnType<typeof piEngineForSpec>;
		try {
			engine = piEngineForSpec(resolved);
		} catch (err) {
			return void materialStore.update(chatId, material.id, { status: "error", error: err instanceof Error ? err.message : String(err) });
		}
		await indexAndProfile(chatId, target, engine, controller.signal, key, "profiler");
	})().finally(() => runs().delete(key));
	runs().set(key, { promise, controller });
	return promise;
}

/** The lesson's materials — restarting any read a dead process left behind. */
export function listMaterials(chatId: string): LessonMaterial[] {
	const materials = stores.materialStore.list(chatId);
	for (const m of materials) if (m.status === "reading" && !runs().has(runKey(chatId, m.id))) void startProfile(chatId, m);
	// Source files do not sync (owner decision, 2026-11-02): a material that arrived from another device has no original here.
	return materials.map((stored) => {
		const run = runs().get(runKey(chatId, stored.id));
		const m = run?.progress || run?.indexing ? { ...stored, conversionProgress: run.progress, indexingProgress: run.indexing } : stored;
		return m.status !== "reading" && !fs.existsSync(stores.materialStore.filePath(chatId, m)) ? { ...m, originalElsewhere: true } : m;
	});
}

/**
 * Convert a PDF material again on purpose (after a failure, an interrupted conversion or a fallback): the skip key and
 * the interrupted marker are ignored; a removal aborts the run like a read. THE INDEX INVARIANT holds whichever way it
 * ends (settleAfterConversion): converted with a vision model, the new content.md is indexed in the same run (with
 * progress) and its digest's profile becomes the material's (the old profiler reads the original only when the
 * material is left without a profile, as at upload); converted without a model, no stale digest or profile from one is
 * left and the material says indexing is pending; failed, no digest or indexing field is left and the material keeps
 * working through the original PDF (a profile that came from the removed digest is read the old way, or, without a
 * model, the material says so).
 */
export function retryMaterialConversion(ownerId: string, id: string): Result<LessonMaterial> {
	const material = current(ownerId, id);
	if (!material) return { ok: false, status: 404, error: "Unknown material" };
	if (material.kind !== "pdf") return { ok: false, status: 400, error: "Only a PDF is converted" };
	const key = runKey(ownerId, id);
	if (runs().has(key)) return { ok: false, status: 409, error: `${material.name} is still being read` };
	const controller = new AbortController();
	const { signal } = controller;
	const settings = stores.settingsStore.readSettings()?.pdfConversion;
	const promise = (async () => {
		const outcome = await convertPdfMaterial(ownerId, material, signal, stores.materialStore, settings, { force: true, onProgress: progressTo(key) });
		if (!outcome || signal.aborted) return;
		const spec = resolveRoleSpec("pdfReader", stores.settingsStore.readSettings());
		const settled = settleAfterConversion(ownerId, id, true, !!spec);
		if (!settled) return;
		const { material: now } = settled;
		const converted = canIndexMaterial(ownerId, now, stores.materialStore);
		// nothing to index and a profile that is still the material's: the conversion is all this run does
		if (!converted && now.profile) return;
		if (!spec) {
			if (!now.profile) stores.materialStore.update(ownerId, id, { status: "error", error: NO_VISION_MODEL });
			return;
		}
		let engine: ReturnType<typeof piEngineForSpec>;
		try {
			engine = piEngineForSpec(spec);
		} catch (err) {
			if (!now.profile) stores.materialStore.update(ownerId, id, { status: "error", error: err instanceof Error ? err.message : String(err) });
			return;
		}
		// without a profile the material is being read again (a turn waits for it; a restart resumes it)
		if (!now.profile) stores.materialStore.update(ownerId, id, { status: "reading" });
		await indexAndProfile(ownerId, current(ownerId, id) ?? now, engine, signal, key, "when_missing");
	})()
		.catch(() => {})
		.finally(() => runs().delete(key));
	runs().set(key, { promise, controller });
	return { ok: true, value: material };
}

/** Start an indexing run the user asked for (retry or rewrite), on the profiler's slot, aborted by a removal. */
function startIndexing(ownerId: string, id: string, refusal: (m: LessonMaterial) => string | undefined, work: (m: LessonMaterial, opts: Omit<IndexMaterialOptions, "force">) => Promise<void>): Result<LessonMaterial> {
	const material = current(ownerId, id);
	if (!material) return { ok: false, status: 404, error: "Unknown material" };
	const key = runKey(ownerId, id);
	// a running read first: during an upload the material has no index yet, and the true reason is that it is still being read
	if (runs().has(key)) return { ok: false, status: 409, error: `${material.name} is still being read` };
	const refused = refusal(material);
	if (refused !== undefined) return { ok: false, status: 409, error: refused };
	const spec = resolveRoleSpec("pdfReader", stores.settingsStore.readSettings());
	if (!spec) return { ok: false, status: 409, error: "no vision model is configured (Settings → Agent: the vision slot reads source material)" };
	let engine: ReturnType<typeof piEngineForSpec>;
	try {
		engine = piEngineForSpec(spec);
	} catch (err) {
		return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) };
	}
	const controller = new AbortController();
	const opts = { signal: controller.signal, store: stores.materialStore, model: { engine, chatId: ownerId }, onProgress: indexingTo(key) };
	const promise = work(material, opts).then(() => {}, () => {}).finally(() => runs().delete(key));
	runs().set(key, { promise, controller });
	return { ok: true, value: material };
}

/** Index a converted PDF again on purpose (failed parts, no profile, an interrupted run): the whole document. */
export function retryMaterialIndexing(ownerId: string, id: string): Result<LessonMaterial> {
	return startIndexing(
		ownerId,
		id,
		(m) => (canIndexMaterial(ownerId, m, stores.materialStore) ? undefined : "Only a converted PDF is indexed: convert it first"),
		(m, opts) => retryPdfIndexing(ownerId, m, opts),
	);
}

/** Write a PDF's profile again from its stored index (the profile step alone, no part re-read). */
export function rewriteMaterialProfile(ownerId: string, id: string): Result<LessonMaterial> {
	return startIndexing(ownerId, id, (m) => rewriteRefusal(ownerId, m, stores.materialStore), (m, opts) => rewritePdfProfile(ownerId, m, opts));
}

/** Add an uploaded file. */
export function addUploadedMaterial(
	chatId: string,
	file: { name: string; type: string; bytes: Uint8Array },
): Result<LessonMaterial> {
	if (!ownerExists(chatId)) return { ok: false, status: 404, error: "Unknown chat or course" };
	const kind = materialKindFor(file.name, file.type);
	if (!kind) return { ok: false, status: 415, error: `Unsupported file type: ${file.name} (PDF, text, Markdown or an image)` };
	if (file.bytes.byteLength === 0) return { ok: false, status: 400, error: `${file.name} is empty` };
	if (file.bytes.byteLength > MATERIAL_MAX_BYTES) {
		return { ok: false, status: 413, error: `${file.name} is larger than ${MATERIAL_MAX_BYTES / 1024 / 1024} MB` };
	}
	const material = stores.materialStore.add(chatId, {
		kind,
		name: path.basename(file.name),
		ext: path.extname(file.name) || (kind === "pdf" ? ".pdf" : kind === "text" ? ".txt" : ".png"),
		bytes: file.bytes,
		mimeType: kind === "image" ? (file.type.startsWith("image/") ? file.type : imageMimeType(file.name)) : file.type || undefined,
		addedMidLesson: lessonStarted(chatId),
	});
	void startProfile(chatId, material);
	return { ok: true, value: material };
}

/** Add a web page: fetched once, stored as its extracted Markdown. */
export async function addLinkMaterial(chatId: string, url: string): Promise<Result<LessonMaterial>> {
	if (!ownerExists(chatId)) return { ok: false, status: 404, error: "Unknown chat or course" };
	if (!isMaterialUrl(url)) return { ok: false, status: 400, error: "The link must be an http(s) address" };
	let link: Awaited<ReturnType<typeof fetchLink>>;
	try {
		link = await fetchLink(url.trim());
	} catch (err) {
		return { ok: false, status: 502, error: `Could not fetch ${url}: ${err instanceof Error ? err.message : String(err)}` };
	}
	if ("pdf" in link) {
		// A link to a PDF is the PDF itself (2026-11-18): kept as the file, read like an upload. It used to be stored as web_fetch's
		// "this URL is a PDF" sentence, which the PDF reader then rejected as an invalid PDF.
		if (link.pdf.byteLength === 0) return { ok: false, status: 422, error: `${url} is an empty PDF` };
		const pdfUrl = new URL(url.trim());
		const last = decodeURIComponent(pdfUrl.pathname.split("/").filter(Boolean).pop() ?? "");
		const fileName = (last || pdfUrl.host).replace(/[\\/:*?"<>|]+/g, "_");
		const pdf = stores.materialStore.add(chatId, {
			kind: "pdf",
			name: (/\.pdf$/i.test(fileName) ? fileName : `${fileName}.pdf`).slice(0, 120),
			ext: ".pdf",
			bytes: link.pdf,
			url: url.trim(),
			mimeType: "application/pdf",
			addedMidLesson: lessonStarted(chatId),
		});
		void startProfile(chatId, pdf);
		return { ok: true, value: pdf };
	}
	const markdown = link.text;
	if (!markdown.trim()) return { ok: false, status: 422, error: `${url} has no readable text` };
	const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
	const u = new URL(url.trim());
	const material = stores.materialStore.add(chatId, {
		kind: "web",
		name: (title ?? `${u.host}${u.pathname === "/" ? "" : u.pathname}`).slice(0, 120),
		ext: ".md",
		bytes: new TextEncoder().encode(markdown),
		url: url.trim(),
		mimeType: "text/markdown",
		addedMidLesson: lessonStarted(chatId),
	});
	void startProfile(chatId, material);
	return { ok: true, value: material };
}

/** Remove one material, stopping its read if one is running. */
export function removeMaterial(chatId: string, id: string): boolean {
	runs().get(runKey(chatId, id))?.controller.abort();
	return stores.materialStore.remove(chatId, id);
}

/** Wait (bounded) until no material of the lesson is still being read. */
export async function waitForMaterials(chatId: string, timeoutMs = TURN_WAIT_MS): Promise<void> {
	const pending = listMaterials(chatId)
		.filter((m) => m.status === "reading")
		.map((m) => runs().get(runKey(chatId, m.id))?.promise)
		.filter((p): p is Promise<void> => !!p);
	if (pending.length === 0) return;
	await Promise.race([Promise.allSettled(pending), new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
}

/** A session's material store: the lesson's own, plus — for a course
 *  session — its course's, routed by material id (ids are unique). Only
 *  the reads the lookup tools use are routed; writes go to the lesson. */
export function sessionMaterials(chatId: string): MaterialStore {
	const base = stores.materialStore;
	const courseId = stores.chatStore.getChat(chatId)?.course?.courseId;
	if (!courseId || !stores.courseStore.getCourse(courseId)) return base;
	const ownerOf = (id: string) => (base.list(courseId).some((m) => m.id === id) ? courseId : chatId);
	return {
		...base,
		list: () => [...listMaterials(courseId), ...listMaterials(chatId)],
		filePath: (_owner, m) => base.filePath(ownerOf(m.id), m),
		auxPath: (_owner, id, name) => base.auxPath(ownerOf(id), id, name),
	};
}

/** A turn's view of the lesson's material: the prompt section and the
 *  lookup tools; undefined when the lesson has none. A course session
 *  also sees its course's material. */
export function materialsForTurn(chatId: string): { section: string; tools: AgentTool<any>[] } | undefined {
	const sources = sourceMaterialsForTurn(chatId);
	const notes = lectureNotesForTurn(chatId);
	if (!notes) return sources;
	if (!sources) return notes;
	return { section: `${sources.section}\n\n${notes.section}`, tools: [...sources.tools, ...notes.tools] };
}

function sourceMaterialsForTurn(chatId: string): { section: string; tools: AgentTool<any>[] } | undefined {
	const store = sessionMaterials(chatId);
	const materials = store === stores.materialStore ? listMaterials(chatId) : store.list(chatId);
	// the teacher's last message: material newer than it is announced once
	const messages = stores.chatStore.getChat(chatId)?.messages ?? [];
	const lastAssistant = [...messages].reverse().find((m) => (m as { role?: string }).role === "assistant") as
		| { timestamp?: number }
		| undefined;
	// catalog mode pins what this conversation has read (core/materials.ts), from the stored tool calls
	const section = materialsPromptSection(materials, (m) => store.filePath(chatId, m), lastAssistant?.timestamp, readMaterialIds(messages, materials));
	if (!section) return undefined;
	return { section, tools: Object.values(materialTools({ chatId, store })) };
}
