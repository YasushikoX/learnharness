import { createHash } from "node:crypto";
import fs from "node:fs";
import { MATERIAL_DIGEST_VERSION, type MaterialDigest } from "../core/contracts/material-digest.ts";
import { mergeGlossary, type Glossary, type GlossaryCitation, type GlossaryEntry } from "../core/glossary.ts";
import type { LessonMaterial, MaterialIndexingError, MaterialIndexingProgress } from "../core/materials.ts";
import type { MaterialStore } from "../core/ports.ts";
import { digestMaterial, MATERIAL_INDEXER_VERSION, rewriteProfile, type DigestModelCall } from "../agent/subagents/material-digest.ts";
import { completeOnce, type MaterialProfilerOptions } from "../agent/subagents/material-profiler.ts";
import { openPdfBytes } from "../agent/subagents/pdf-ops.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";
import { PDF_CONTENT_FILE, PDF_CONVERSION_SIDECAR, readSidecar } from "./material-conversion.ts";
import { stores } from "./stores.ts";

/**
 * Indexing a converted PDF once into `digest.json` (fork addition, 2026-11-25). Runs inside the material's background
 * read, right after the conversion (material-conversion.ts) and instead of the old skim profiler: the indexer
 * (agent/subagents/material-digest.ts) reads the WHOLE of `content.md` in bounded batches, one model call per batch
 * plus one for the profile (a one-batch document costs exactly one call), on the profiler's model slot and its
 * one-shot helper (`completeOnce`). The material's profile comes from the digest; when the digest has no profile, or
 * indexing throws, the caller falls back to the old profiler on the original PDF and the material carries an
 * `indexingError`. Only a PDF whose conversion succeeded (content.md and a successful conversion.json) is indexed;
 * every other material keeps the old profiler path.
 *
 * Beside the material (store.auxPath):
 *   digest.json             the MaterialDigest (contracts/material-digest.ts), written atomically
 *   indexing-started.json   exists while an indexing run is in flight: the attempt number and the content hash
 *
 * SKIP-IF-UNCHANGED. A run is skipped (no model call) when digest.json has the current digest version, the content
 * hash of content.md, the converter and converter version of conversion.json and the current indexer version. A
 * stored digest with failed batches or a null profile counts as unchanged: it is re-run only on purpose
 * (`retryPdfIndexing`, or `rewritePdfProfile` for the profile step alone).
 *
 * RESTART. A run that finds indexing-started.json (the app stopped mid-indexing) RESUMES by indexing again from the
 * start, once (attempt 2): the indexer keeps no partial state, so the calls made before the stop are paid again. A run
 * that finds attempt 2 interrupted too does not start a third: it records an "interrupted" indexingError and the
 * caller falls back to the old profiler, so a document that keeps killing the app cannot loop.
 *
 * Model calls: counted by the wrapper around completeOnce and stored on the material as `indexingCalls` (the calls
 * that produced the current digest.json, its profile rewrites included).
 */

export const MATERIAL_DIGEST_FILE = "digest.json";
export const MATERIAL_INDEXING_STARTED = "indexing-started.json";
/** Attempts of one content before an interrupted run stops being resumed. */
const MAX_ATTEMPTS = 2;

export interface MaterialIndexingOutcome {
	/** not_converted: no successful conversion, nothing was indexed (the caller keeps the old path). */
	status: "indexed" | "unchanged" | "failed" | "interrupted" | "not_converted";
	digest?: MaterialDigest;
	/** The model calls this run made. */
	calls: number;
	error?: MaterialIndexingError;
	warnings: string[];
}

export interface IndexMaterialOptions {
	signal: AbortSignal;
	store: MaterialStore;
	/** The profiler's model options (its engine on the pdfReader slot, the session id); the run's `signal` replaces abortSignal. */
	model: MaterialProfilerOptions;
	/** An indexing the user asked for: ignores the stored digest and an interrupted marker. */
	force?: boolean;
	onProgress?: (progress: MaterialIndexingProgress | undefined) => void;
}

/** The indexer's injected model call: completeOnce with the system prompt and one user text, counted. */
export function digestModelCall(model: MaterialProfilerOptions, onCall: () => void): DigestModelCall {
	return async (request, signal) => {
		onCall();
		return completeOnce({ ...model, abortSignal: signal ?? model.abortSignal }, request.system, [{ type: "text", text: request.user }]);
	};
}

/** The key a stored digest must match to be reused. */
export interface DigestKey {
	sourceHash: string;
	converter: string;
	converterVersion: string;
}

/** A material's converted text and its digest key; undefined when it has no successful conversion. */
export function readConvertedContent(ownerId: string, materialId: string, store: MaterialStore): { contentMd: string; key: DigestKey } | undefined {
	const sidecar = readSidecar(store.auxPath(ownerId, materialId, PDF_CONVERSION_SIDECAR));
	if (!sidecar || sidecar.error || !sidecar.converterId) return undefined;
	let contentMd: string;
	try {
		contentMd = fs.readFileSync(store.auxPath(ownerId, materialId, PDF_CONTENT_FILE), "utf8");
	} catch {
		return undefined;
	}
	const sourceHash = createHash("sha256").update(contentMd, "utf8").digest("hex");
	return { contentMd, key: { sourceHash, converter: sidecar.converterId, converterVersion: sidecar.converterVersion ?? "unknown" } };
}

/** A stored digest.json, of any version; undefined when missing or not a digest. */
export function readDigest(file: string): MaterialDigest | undefined {
	try {
		const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<MaterialDigest> | null;
		if (!value || typeof value.version !== "number" || typeof value.sourceHash !== "string" || !Array.isArray(value.terms) || !Array.isArray(value.batches)) return undefined;
		return value as MaterialDigest;
	} catch {
		return undefined;
	}
}

/** The digest was built from exactly this content, converter and indexer. Pure. */
export function digestIsCurrent(digest: MaterialDigest, key: DigestKey): boolean {
	return (
		digest.version === MATERIAL_DIGEST_VERSION &&
		digest.indexerVersion === MATERIAL_INDEXER_VERSION &&
		digest.sourceHash === key.sourceHash &&
		digest.converter === key.converter &&
		digest.converterVersion === key.converterVersion
	);
}

interface StartedMarker {
	sourceHash: string;
	attempt: number;
	startedAt: string;
}

function readStarted(file: string): StartedMarker | undefined {
	try {
		const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<StartedMarker> | null;
		return value && typeof value.sourceHash === "string" && typeof value.attempt === "number" ? (value as StartedMarker) : undefined;
	} catch {
		return undefined;
	}
}

/** The indexer's progress line as the material shows it. Pure. */
export function indexingProgressOf(line: string): MaterialIndexingProgress {
	const part = /: part (\d+) of (\d+) \(p\. \d+-\d+\)$/.exec(line);
	return part ? { stage: "part", part: Number(part[1]), parts: Number(part[2]) } : { stage: "profile" };
}

function pageRanges(batches: readonly { pageStart: number; pageEnd: number }[]): string {
	const shown = batches.slice(0, 6).map((b) => (b.pageStart === b.pageEnd ? `${b.pageStart}` : `${b.pageStart}-${b.pageEnd}`));
	return `${shown.join(", ")}${batches.length > 6 ? ` and ${batches.length - 6} more` : ""}`;
}

/** What the material shows about a digest: a missing profile (error) and parts that could not be indexed (warning). Pure. */
export function digestNotes(digest: MaterialDigest): { error?: MaterialIndexingError; warnings: string[] } {
	const warnings: string[] = [];
	const failed = digest.failedBatches;
	if (failed.length > 0) {
		const n = digest.batches.length;
		warnings.push(
			`${failed.length} of ${n} ${n === 1 ? "part" : "parts"} of this PDF could not be indexed (pages ${pageRanges(failed)}), so their terms are missing from the class glossary. Retry the indexing to read them again.`,
		);
	}
	if (digest.profile !== null) return { warnings };
	return {
		error: { kind: "no_profile", message: `The whole-document index has no profile (${digest.profileError}), so the profile was read the old way. Rewrite the profile to try again.`, retryable: true },
		warnings,
	};
}

function failedError(error: unknown): MaterialIndexingError {
	return { kind: "failed", message: `Indexing this PDF failed (${error instanceof Error ? error.message : String(error)}), so the profile was read the old way. Retry the indexing to try again.`, retryable: true };
}

/** A PDF's physical page count; undefined when it cannot be opened. */
async function pdfPageCount(file: string, signal: AbortSignal): Promise<number | undefined> {
	let opened: Awaited<ReturnType<typeof openPdfBytes>> | undefined;
	try {
		opened = await openPdfBytes(new Uint8Array(await fs.promises.readFile(file)), signal);
		return opened.doc.numPages;
	} catch {
		signal.throwIfAborted();
		return undefined;
	} finally {
		await opened?.task.destroy();
	}
}

/**
 * Index one converted PDF (or skip it, see the module comment). Resolves with the outcome; rejects only when `signal`
 * aborted (the material was removed). Writes digest.json; never touches the material record.
 */
export async function indexMaterialContent(ownerId: string, material: LessonMaterial, opts: IndexMaterialOptions): Promise<MaterialIndexingOutcome> {
	const { signal, store } = opts;
	signal.throwIfAborted();
	const content = readConvertedContent(ownerId, material.id, store);
	if (!content) return { status: "not_converted", calls: 0, warnings: [] };
	const digestPath = store.auxPath(ownerId, material.id, MATERIAL_DIGEST_FILE);
	const startedPath = store.auxPath(ownerId, material.id, MATERIAL_INDEXING_STARTED);
	if (!opts.force) {
		const stored = readDigest(digestPath);
		if (stored && digestIsCurrent(stored, content.key)) return { status: "unchanged", digest: stored, calls: 0, ...digestNotes(stored) };
	}
	const started = opts.force ? undefined : readStarted(startedPath);
	const attempt = started?.sourceHash === content.key.sourceHash ? started.attempt + 1 : 1;
	if (attempt > MAX_ATTEMPTS) {
		const error: MaterialIndexingError = {
			kind: "interrupted",
			message: "Indexing this PDF was interrupted twice (the app stopped while it ran), so it was not started again and the profile was read the old way. Retry the indexing to try again.",
			retryable: true,
		};
		return { status: "interrupted", calls: 0, error, warnings: [] };
	}
	writeFileAtomicSync(startedPath, `${JSON.stringify({ sourceHash: content.key.sourceHash, attempt, startedAt: new Date().toISOString() } satisfies StartedMarker)}\n`);
	let calls = 0;
	try {
		const sourcePageCount = await pdfPageCount(store.filePath(ownerId, material), signal);
		const digest = await digestMaterial(content.contentMd, {
			complete: digestModelCall(opts.model, () => calls++),
			...content.key,
			...(sourcePageCount !== undefined ? { sourcePageCount } : {}),
			name: material.name,
			signal,
			onActivity: (line) => opts.onProgress?.(indexingProgressOf(line)),
		});
		signal.throwIfAborted();
		writeFileAtomicSync(digestPath, `${JSON.stringify(digest, null, "\t")}\n`);
		return { status: "indexed", digest, calls, ...digestNotes(digest) };
	} catch (error) {
		if (signal.aborted) throw error;
		return { status: "failed", calls, error: failedError(error), warnings: [] };
	} finally {
		fs.rmSync(startedPath, { force: true });
		opts.onProgress?.(undefined);
	}
}

/**
 * The upload hook's step (server/materials.ts): index, then record the outcome on the material (indexingError,
 * indexingWarnings, indexingCalls). Never rejects; an abort records nothing and resolves undefined. The caller sets the
 * profile from `outcome.digest.profile`, or falls back to the old profiler when it is missing.
 */
export async function indexPdfMaterial(ownerId: string, material: LessonMaterial, opts: IndexMaterialOptions): Promise<MaterialIndexingOutcome | undefined> {
	let outcome: MaterialIndexingOutcome;
	try {
		outcome = await indexMaterialContent(ownerId, material, opts);
	} catch (error) {
		if (opts.signal.aborted) return undefined;
		outcome = { status: "failed", calls: 0, error: failedError(error), warnings: [] };
	}
	if (opts.signal.aborted) return undefined;
	if (outcome.status === "not_converted") return outcome;
	opts.store.update(ownerId, material.id, {
		indexingError: outcome.error,
		indexingWarnings: outcome.warnings.length > 0 ? outcome.warnings : undefined,
		...(outcome.status === "indexed" ? { indexingCalls: outcome.calls } : {}),
	});
	return outcome;
}

/** The material fields a digest with a profile sets. */
export function profileFromDigest(digest: MaterialDigest & { profile: string }): Partial<LessonMaterial> {
	return { status: "ready", profile: digest.profile, ...(digest.sourcePageCount !== null ? { pages: digest.sourcePageCount } : {}), error: undefined };
}

/** Whether a material can be indexed now: a PDF with a successful conversion. */
export function canIndexMaterial(ownerId: string, material: LessonMaterial, store: MaterialStore): boolean {
	return material.kind === "pdf" && readConvertedContent(ownerId, material.id, store) !== undefined;
}

/** Whether a material's profile can be rewritten from its digest: a current digest.json. */
export function canRewriteProfile(ownerId: string, material: LessonMaterial, store: MaterialStore): boolean {
	const content = material.kind === "pdf" ? readConvertedContent(ownerId, material.id, store) : undefined;
	const digest = content && readDigest(store.auxPath(ownerId, material.id, MATERIAL_DIGEST_FILE));
	return !!content && !!digest && digestIsCurrent(digest, content.key);
}

/**
 * Index a material again on purpose (server/materials.ts retryMaterialIndexing): the whole document, ignoring the
 * stored digest and an interrupted marker. A digest with a profile replaces the material's profile; otherwise the
 * profile it has is kept and the note says why. Never rejects.
 */
export async function retryPdfIndexing(ownerId: string, material: LessonMaterial, opts: Omit<IndexMaterialOptions, "force">): Promise<void> {
	const outcome = await indexPdfMaterial(ownerId, material, { ...opts, force: true });
	const digest = outcome?.digest;
	if (digest?.profile && !opts.signal.aborted) opts.store.update(ownerId, material.id, profileFromDigest({ ...digest, profile: digest.profile }));
}

/**
 * Run only the profile step again from the stored digest (one call and its one retry; no batch is re-read), then
 * store the digest and, with a profile, the material's profile. A digest that is missing or out of date is left alone
 * (canRewriteProfile). Never rejects.
 */
export async function rewritePdfProfile(ownerId: string, material: LessonMaterial, opts: Omit<IndexMaterialOptions, "force">): Promise<void> {
	const { signal, store } = opts;
	if (!canRewriteProfile(ownerId, material, store)) return;
	const digestPath = store.auxPath(ownerId, material.id, MATERIAL_DIGEST_FILE);
	let calls = 0;
	let digest: MaterialDigest;
	try {
		digest = await rewriteProfile(readDigest(digestPath)!, {
			complete: digestModelCall(opts.model, () => calls++),
			name: material.name,
			signal,
			onActivity: (line) => opts.onProgress?.(indexingProgressOf(line)),
		});
		signal.throwIfAborted();
		writeFileAtomicSync(digestPath, `${JSON.stringify(digest, null, "\t")}\n`);
	} catch (error) {
		if (!signal.aborted) store.update(ownerId, material.id, { indexingError: failedError(error) });
		return;
	} finally {
		opts.onProgress?.(undefined);
	}
	const before = store.list(ownerId).find((m) => m.id === material.id)?.indexingCalls ?? 0;
	const notes = digestNotes(digest);
	store.update(ownerId, material.id, {
		indexingError: notes.error,
		indexingWarnings: notes.warnings.length > 0 ? notes.warnings : undefined,
		indexingCalls: before + calls,
		...(digest.profile !== null ? profileFromDigest({ ...digest, profile: digest.profile }) : {}),
	});
}

// ── The class glossary ─────────────────────────────────────────────────────

/** A material a glossary citation resolves to. */
export interface GlossaryMaterialRef {
	id: string;
	name: string;
}

/** A citation with its document resolved to the course's materials (usually one; two when the same document was added twice). */
export interface CourseGlossaryCitation extends GlossaryCitation {
	materials: GlossaryMaterialRef[];
}

export interface CourseGlossaryEntry extends GlossaryEntry {
	citations: CourseGlossaryCitation[];
}

/** Why a material is missing from the glossary, or only partly in it. */
export interface CourseGlossaryGap extends GlossaryMaterialRef {
	kind: LessonMaterial["kind"];
	/**
	 * no_digest: never indexed (not a PDF, its conversion failed, still being read, or indexing failed); outdated: its
	 * digest no longer matches content.md, the converter or the indexer (left out until it is indexed again);
	 * failed_batches: merged, but parts of it could not be indexed.
	 */
	reason: "no_digest" | "outdated" | "failed_batches";
	/** failed_batches: the page ranges that are missing. */
	failedPages?: { pageStart: number; pageEnd: number }[];
}

/** A course's glossary: mergeGlossary of its materials' current digests, with citations resolved to materials. */
export interface CourseGlossary extends Glossary {
	terms: Record<string, CourseGlossaryEntry>;
	/** The materials whose digests were merged. */
	indexed: (GlossaryMaterialRef & { sourceHash: string })[];
	/** Materials missing from the glossary or only partly in it: when this is not empty, the glossary is incomplete. */
	incomplete: CourseGlossaryGap[];
}

/**
 * The class glossary of a course, built on every call from the digests on disk (uncached: a few small JSON reads and
 * a hash of each content.md, no model call). Null for an unknown course.
 */
export function courseGlossary(courseId: string, store: MaterialStore = stores.materialStore): CourseGlossary | null {
	if (!stores.courseStore.getCourse(courseId)) return null;
	const indexed: CourseGlossary["indexed"] = [];
	const incomplete: CourseGlossaryGap[] = [];
	const digests: MaterialDigest[] = [];
	for (const m of store.list(courseId)) {
		const ref = { id: m.id, name: m.name };
		const content = m.kind === "pdf" ? readConvertedContent(courseId, m.id, store) : undefined;
		const digest = content && readDigest(store.auxPath(courseId, m.id, MATERIAL_DIGEST_FILE));
		if (!content || !digest) {
			incomplete.push({ ...ref, kind: m.kind, reason: "no_digest" });
			continue;
		}
		if (!digestIsCurrent(digest, content.key)) {
			incomplete.push({ ...ref, kind: m.kind, reason: "outdated" });
			continue;
		}
		digests.push(digest);
		indexed.push({ ...ref, sourceHash: digest.sourceHash });
		if (digest.failedBatches.length > 0) {
			incomplete.push({ ...ref, kind: m.kind, reason: "failed_batches", failedPages: digest.failedBatches.map((b) => ({ pageStart: b.pageStart, pageEnd: b.pageEnd })) });
		}
	}
	const glossary = mergeGlossary(digests);
	const materialsOf = (sourceHash: string) => indexed.filter((m) => m.sourceHash === sourceHash).map(({ id, name }) => ({ id, name }));
	const terms = Object.fromEntries(
		Object.entries(glossary.terms).map(([id, entry]) => [id, { ...entry, citations: entry.citations.map((c) => ({ ...c, materials: materialsOf(c.sourceHash) })) }]),
	);
	return { ...glossary, terms, indexed, incomplete };
}
