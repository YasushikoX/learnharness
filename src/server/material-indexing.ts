import { createHash } from "node:crypto";
import fs from "node:fs";
import type { MaterialDigest } from "../core/contracts/material-digest.ts";
import { mergeGlossary, type Glossary, type GlossaryCitation, type GlossaryEntry } from "../core/glossary.ts";
import type { LessonMaterial, MaterialIndexingError, MaterialIndexingProgress } from "../core/materials.ts";
import type { MaterialStore } from "../core/ports.ts";
import {
	digestMaterial,
	failedBatchesOf,
	hasProfile,
	MATERIAL_INDEXER_VERSION,
	parseStoredDigest,
	rewriteProfile,
	type DigestModelCall,
	type DigestProgress,
	type StoredDigestProblem,
} from "../agent/subagents/material-digest.ts";
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
 * READING digest.json goes only through the indexer's validated loader (`parseStoredDigest`, via `readDigest` here):
 * a file of another version, or one that is truncated or hand-edited into an invalid digest, is not used (and is
 * indexed again); the failed parts are derived from the parts on read.
 *
 * SKIP-IF-UNCHANGED. A run is skipped (no model call) when digest.json is a valid digest of the current version, with
 * the content hash of content.md, the converter and converter version of conversion.json and the current indexer
 * version. A stored digest with failed parts or a null profile counts as unchanged: it is re-run only on purpose
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
	/** What the caller does about the profile when the run gives none, for the notes (default "profiler", the upload hook). */
	fallback?: ProfileFallback;
	onProgress?: (progress: MaterialIndexingProgress | undefined) => void;
}

/** What an empty reply means, per indexing step. */
const EMPTY_REPLY = {
	extraction: "the model returned an empty reply instead of the part's notes",
	profile: "the model returned no profile",
} as const;

/** The indexer's injected model call: completeOnce with the system prompt and one user text, counted. */
export function digestModelCall(model: MaterialProfilerOptions, onCall: () => void): DigestModelCall {
	return async (request, signal) => {
		onCall();
		return completeOnce({ ...model, abortSignal: signal ?? model.abortSignal }, request.system, [{ type: "text", text: request.user }], EMPTY_REPLY[request.kind]);
	};
}

/** The key a stored digest must match to be reused. */
export interface DigestKey {
	sourceHash: string;
	converter: string;
	converterVersion: string;
}

/** The converter version as a digest stores it (review 5, finding 3): trimmed, and "unknown" when the service gave
 *  none or only whitespace, so the digest written with it is one the stored-digest reader accepts. */
export function storedConverterVersion(version: string | undefined): string {
	return version?.trim() || "unknown";
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
	return { contentMd, key: { sourceHash, converter: sidecar.converterId, converterVersion: storedConverterVersion(sidecar.converterVersion) } };
}

/** A stored digest.json read through the validated loader: the digest, or why there is none usable. */
export type StoredDigest = { digest: MaterialDigest } | { problem: StoredDigestProblem | { kind: "missing"; reason: string } };

/** Read digest.json through the indexer's validated loader (parseStoredDigest). Never throws. */
export function readStoredDigest(file: string): StoredDigest {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return { problem: { kind: "missing", reason: "no digest.json" } };
	}
	const parsed = parseStoredDigest(text);
	return parsed.ok ? { digest: parsed.digest } : { problem: parsed.problem };
}

/** A valid stored digest of the current version; undefined when missing, of another version or invalid. */
export function readDigest(file: string): MaterialDigest | undefined {
	const stored = readStoredDigest(file);
	return "digest" in stored ? stored.digest : undefined;
}

/** The digest was built from exactly this content, converter and indexer (its version is checked on read). Pure. */
export function digestIsCurrent(digest: MaterialDigest, key: DigestKey): boolean {
	return (
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

/** The indexer's structured progress as the material shows it. Pure. */
export function indexingProgressOf(progress: DigestProgress): MaterialIndexingProgress {
	return progress.stage === "part" ? { stage: "part", part: progress.part, parts: progress.parts } : { stage: "profile" };
}

function pageRanges(batches: readonly { pageStart: number; pageEnd: number }[]): string {
	const shown = batches.slice(0, 6).map((b) => (b.pageStart === b.pageEnd ? `${b.pageStart}` : `${b.pageStart}-${b.pageEnd}`));
	return `${shown.join(", ")}${batches.length > 6 ? ` and ${batches.length - 6} more` : ""}`;
}

/**
 * What happens to the material's profile when an indexing run gives none, so the notes say what actually happened:
 * profiler: the caller reads it the old way (the upload hook); kept: the material keeps the profile it has (a retry);
 * none: it has none and none is read now.
 */
export type ProfileFallback = "profiler" | "kept" | "none";

const FALLBACK_CLAUSE: Record<ProfileFallback, string> = {
	profiler: "so the profile was read the old way",
	kept: "so the material keeps the profile it had",
	none: "so this PDF has no profile from it",
};

/** The fallback a retry has: the profile the material has is kept, or there is none. */
export const keptOrNone = (material: Pick<LessonMaterial, "profile">): ProfileFallback => (material.profile ? "kept" : "none");

/**
 * What the material shows about a digest: a missing profile (error) and parts that could not be indexed (warning).
 * "Has a profile" is hasProfile's answer, the same test the upload hook uses. The note names the action that can
 * work: rewriting the profile needs at least one indexed part, otherwise the indexing is retried. Pure.
 */
export function digestNotes(digest: MaterialDigest, fallback: ProfileFallback = "profiler"): { error?: MaterialIndexingError; warnings: string[] } {
	const warnings: string[] = [];
	const failed = failedBatchesOf(digest);
	if (failed.length > 0) {
		const n = digest.batches.length;
		warnings.push(
			`${failed.length} of ${n} ${n === 1 ? "part" : "parts"} of this PDF could not be indexed (pages ${pageRanges(failed)}), so their terms are missing from the class glossary. Retry the indexing to read them again.`,
		);
	}
	if (hasProfile(digest)) return { warnings };
	const action = hasIndexedPart(digest) ? "Rewrite the profile to try again." : "Retry the indexing to try again.";
	const why = digest.profile === null ? digest.profileError : "its profile is not valid";
	return { error: { kind: "no_profile", message: `The whole-document index has no profile (${why}), ${FALLBACK_CLAUSE[fallback]}. ${action}`, retryable: true }, warnings };
}

/** Whether at least one part of a digest was indexed (the profile step has notes to write from). Pure. */
export const hasIndexedPart = (digest: Pick<MaterialDigest, "batches">): boolean => digest.batches.some((b) => b.status === "indexed");

function failedError(error: unknown, fallback: ProfileFallback): MaterialIndexingError {
	return { kind: "failed", message: `Indexing this PDF failed (${error instanceof Error ? error.message : String(error)}), ${FALLBACK_CLAUSE[fallback]}. Retry the indexing to try again.`, retryable: true };
}

/** The note a converted PDF without a current index shows while no vision model is configured (with why a stored index is not used). */
export function pendingIndexingError(invalidReason?: string): MaterialIndexingError {
	const stored = invalidReason ? ` Its stored index is not valid (${invalidReason}), so it is not used.` : "";
	return {
		kind: "pending",
		message: `Indexing this PDF is pending: no vision model is configured (Settings → Agent: the vision slot reads source material).${stored} Retry the indexing once one is.`,
		retryable: true,
	};
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
	const fallback = opts.fallback ?? "profiler";
	signal.throwIfAborted();
	const content = readConvertedContent(ownerId, material.id, store);
	if (!content) return { status: "not_converted", calls: 0, warnings: [] };
	const digestPath = store.auxPath(ownerId, material.id, MATERIAL_DIGEST_FILE);
	const startedPath = store.auxPath(ownerId, material.id, MATERIAL_INDEXING_STARTED);
	if (!opts.force) {
		const stored = readDigest(digestPath);
		if (stored && digestIsCurrent(stored, content.key)) return { status: "unchanged", digest: stored, calls: 0, ...digestNotes(stored, fallback) };
	}
	const started = opts.force ? undefined : readStarted(startedPath);
	const attempt = started?.sourceHash === content.key.sourceHash ? started.attempt + 1 : 1;
	if (attempt > MAX_ATTEMPTS) {
		const error: MaterialIndexingError = {
			kind: "interrupted",
			message: `Indexing this PDF was interrupted twice (the app stopped while it ran), so it was not started again, ${FALLBACK_CLAUSE[fallback].replace(/^so /, "and ")}. Retry the indexing to try again.`,
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
			onProgress: (progress) => opts.onProgress?.(indexingProgressOf(progress)),
		});
		signal.throwIfAborted();
		writeFileAtomicSync(digestPath, `${JSON.stringify(digest, null, "\t")}\n`);
		return { status: "indexed", digest, calls, ...digestNotes(digest, fallback) };
	} catch (error) {
		if (signal.aborted) throw error;
		return { status: "failed", calls, error: failedError(error, fallback), warnings: [] };
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
		outcome = { status: "failed", calls: 0, error: failedError(error, opts.fallback ?? "profiler"), warnings: [] };
	}
	if (opts.signal.aborted) return undefined;
	if (outcome.status === "not_converted") return outcome;
	// A run that failed or was not started leaves the stored digest as it was: when that digest still describes
	// content.md, its warnings (failed parts) still apply and are kept, and so is the call count that produced it.
	const warnings = outcome.status === "failed" || outcome.status === "interrupted" ? currentDigestWarnings(ownerId, material.id, opts.store) : outcome.warnings;
	opts.store.update(ownerId, material.id, {
		indexingError: outcome.error,
		indexingWarnings: warnings.length > 0 ? warnings : undefined,
		...(outcome.status === "indexed" ? { indexingCalls: outcome.calls } : {}),
	});
	return outcome;
}

/** The warnings of the stored digest when it is current for content.md; [] otherwise. */
function currentDigestWarnings(ownerId: string, materialId: string, store: MaterialStore): string[] {
	const content = readConvertedContent(ownerId, materialId, store);
	const stored = content && readDigest(store.auxPath(ownerId, materialId, MATERIAL_DIGEST_FILE));
	return content && stored && digestIsCurrent(stored, content.key) ? digestNotes(stored).warnings : [];
}

/** The material fields a digest with a profile sets (hasProfile first). */
export function profileFromDigest(digest: MaterialDigest & { profile: string }): Partial<LessonMaterial> {
	return { status: "ready", profile: digest.profile, profileFromDigest: true, ...(digest.sourcePageCount !== null ? { pages: digest.sourcePageCount } : {}), error: undefined };
}

/** Whether a material can be indexed now: a PDF with a successful conversion. */
export function canIndexMaterial(ownerId: string, material: LessonMaterial, store: MaterialStore): boolean {
	return material.kind === "pdf" && readConvertedContent(ownerId, material.id, store) !== undefined;
}

/**
 * Why a material's profile cannot be rewritten from its digest now, in words for the user (naming the action that
 * can work); undefined when it can: a converted PDF with a current, valid digest.json with at least one indexed part.
 */
export function rewriteRefusal(ownerId: string, material: LessonMaterial, store: MaterialStore): string | undefined {
	const content = material.kind === "pdf" ? readConvertedContent(ownerId, material.id, store) : undefined;
	if (!content) return "Only a converted PDF has a whole-document index: convert it first";
	const stored = readStoredDigest(store.auxPath(ownerId, material.id, MATERIAL_DIGEST_FILE));
	if ("problem" in stored) {
		if (stored.problem.kind === "missing") return "This material has no whole-document index yet: retry the indexing first";
		if (stored.problem.kind === "invalid") return `This material's stored index is not valid (${stored.problem.reason}), so it is not used: retry the indexing first`;
		return "This material's index is of an older version: retry the indexing first";
	}
	if (!digestIsCurrent(stored.digest, content.key)) return "This material's index no longer matches its converted text: retry the indexing first";
	if (!hasIndexedPart(stored.digest)) return "No part of this PDF could be indexed, so there is nothing to write a profile from: retry the indexing first";
	return undefined;
}

/** Whether a material's profile can be rewritten from its digest (rewriteRefusal has nothing against it). */
export function canRewriteProfile(ownerId: string, material: LessonMaterial, store: MaterialStore): boolean {
	return rewriteRefusal(ownerId, material, store) === undefined;
}

/**
 * Index a material again on purpose (server/materials.ts retryMaterialIndexing): the whole document, ignoring the
 * stored digest and an interrupted marker. A digest with a profile replaces the material's profile; otherwise the
 * profile it has is kept (no old profiler runs here) and the note says so. Never rejects.
 */
export async function retryPdfIndexing(ownerId: string, material: LessonMaterial, opts: Omit<IndexMaterialOptions, "force">): Promise<void> {
	const outcome = await indexPdfMaterial(ownerId, material, { ...opts, force: true, fallback: keptOrNone(material) });
	const digest = outcome?.digest;
	if (digest && hasProfile(digest) && !opts.signal.aborted) opts.store.update(ownerId, material.id, profileFromDigest(digest));
}

/** What dropStaleIndex left: whether content.md can be indexed, and what it removed. */
export interface StaleIndexResult {
	/** content.md and a successful conversion.json exist. */
	converted: boolean;
	/** A digest describing the current content.md (its hash, converter and converter version) is on disk. */
	describes: boolean;
	/** The material's profile came from a digest that no longer describes content.md and was removed. */
	profileDropped: boolean;
	/** A digest.json that is not a valid digest was kept for the indexer's skip rule (it re-indexes it): why it is invalid. */
	invalidReason?: string;
}

/**
 * THE INDEX INVARIANT (review 4, finding 1): a material's digest.json, its profile when it came from a digest
 * (`profileFromDigest`), and its indexing fields (indexingError, indexingWarnings, indexingCalls) always describe the
 * content.md that is on disk now, or are absent. Called after every conversion run, whichever way it ended (the only
 * writer and remover of a PDF's content.md is the conversion, server/material-conversion.ts): when no digest on disk
 * describes the current content.md (same hash, converter and converter version), it removes a digest of other content,
 * the indexing fields, and a profile that came from a digest; with no content.md at all it removes any digest.json. An
 * invalid digest.json beside a current content.md is left for the skip rule, which indexes it again (its reason is
 * returned). The interrupted marker is removed when it is for other content, or always when `forced` (a run the user
 * asked for starts its attempts again). Re-indexing is the caller's job. Never throws on a missing file.
 */
export function dropStaleIndex(ownerId: string, material: LessonMaterial, store: MaterialStore, opts: { forced?: boolean } = {}): StaleIndexResult {
	const content = material.kind === "pdf" ? readConvertedContent(ownerId, material.id, store) : undefined;
	const digestPath = store.auxPath(ownerId, material.id, MATERIAL_DIGEST_FILE);
	const startedPath = store.auxPath(ownerId, material.id, MATERIAL_INDEXING_STARTED);
	const started = readStarted(startedPath);
	if (started && (opts.forced || !content || started.sourceHash !== content.key.sourceHash)) fs.rmSync(startedPath, { force: true });
	const stored = readStoredDigest(digestPath);
	const valid = "digest" in stored ? stored.digest : undefined;
	if (content && valid && describesContent(valid, content.key)) return { converted: true, describes: true, profileDropped: false };
	const invalidReason = content && "problem" in stored && stored.problem.kind === "invalid" ? stored.problem.reason : undefined;
	if (invalidReason === undefined) fs.rmSync(digestPath, { force: true });
	// a profile from a digest that no longer describes content.md (the flag, or, for a record written before the flag, the stored digest's own profile)
	const fromDigest = material.profileFromDigest === true || (valid !== undefined && material.profile !== undefined && valid.profile === material.profile);
	const stale = material.indexingError !== undefined || material.indexingWarnings !== undefined || material.indexingCalls !== undefined || fromDigest;
	if (stale) {
		store.update(ownerId, material.id, {
			indexingError: undefined,
			indexingWarnings: undefined,
			indexingCalls: undefined,
			...(fromDigest ? { profile: undefined, profileFromDigest: undefined } : {}),
		});
	}
	return { converted: !!content, describes: false, profileDropped: fromDigest, ...(invalidReason !== undefined ? { invalidReason } : {}) };
}

/** A digest was built from this content.md and conversion (its indexer version aside). Pure. */
export function describesContent(digest: MaterialDigest, key: DigestKey): boolean {
	return digest.sourceHash === key.sourceHash && digest.converter === key.converter && digest.converterVersion === key.converterVersion;
}

/**
 * Run only the profile step again from the stored digest (one call and its one retry; no part is re-read), then
 * store the digest and, with a profile, the material's profile. A rewrite that fails on a digest that already had a
 * profile keeps that profile (in digest.json and on the material) and says so in a warning. A digest that is missing,
 * invalid or out of date is left alone (canRewriteProfile). Never rejects.
 */
export async function rewritePdfProfile(ownerId: string, material: LessonMaterial, opts: Omit<IndexMaterialOptions, "force">): Promise<void> {
	const { signal, store } = opts;
	if (!canRewriteProfile(ownerId, material, store)) return;
	const fallback = keptOrNone(material);
	const digestPath = store.auxPath(ownerId, material.id, MATERIAL_DIGEST_FILE);
	let calls = 0;
	let digest: MaterialDigest;
	let rewriteError: string | null;
	try {
		const result = await rewriteProfile(readDigest(digestPath)!, {
			complete: digestModelCall(opts.model, () => calls++),
			signal,
			onProgress: (progress) => opts.onProgress?.(indexingProgressOf(progress)),
		});
		signal.throwIfAborted();
		digest = result.digest;
		rewriteError = result.error;
		writeFileAtomicSync(digestPath, `${JSON.stringify(digest, null, "\t")}\n`);
	} catch (error) {
		if (!signal.aborted) store.update(ownerId, material.id, { indexingError: failedError(error, fallback) });
		return;
	} finally {
		opts.onProgress?.(undefined);
	}
	const before = store.list(ownerId).find((m) => m.id === material.id)?.indexingCalls ?? 0;
	const notes = digestNotes(digest, fallback);
	const warnings = [...notes.warnings];
	if (rewriteError !== null && hasProfile(digest)) warnings.push(`Writing the profile again failed (${rewriteError}); the previous profile is kept.`);
	store.update(ownerId, material.id, {
		indexingError: notes.error,
		indexingWarnings: warnings.length > 0 ? warnings : undefined,
		indexingCalls: before + calls,
		...(hasProfile(digest) ? profileFromDigest(digest) : {}),
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
	 * digest is of another version or no longer matches content.md, the converter or the indexer (left out until it is
	 * indexed again); invalid: its digest.json is not a valid digest (truncated or edited; left out, indexed again on the
	 * next read); failed_batches: merged, but parts of it could not be indexed.
	 */
	reason: "no_digest" | "outdated" | "invalid" | "failed_batches";
	/** invalid: what the loader found. */
	detail?: string;
	/** failed_batches: the pages that are missing, per failed part. */
	failedPages?: { pageStart: number; pageEnd: number; pages: number[] }[];
}

/**
 * A course's glossary: mergeGlossary of its materials' current digests (entries by exact id, every occurrence kept,
 * likely duplicates only suggested, same-source conflicts reported), with citations resolved to materials.
 */
export interface CourseGlossary extends Glossary {
	terms: Record<string, CourseGlossaryEntry>;
	/** The materials whose digests were merged. */
	indexed: (GlossaryMaterialRef & { sourceHash: string })[];
	/** Materials missing from the glossary or only partly in it: when this is not empty, the glossary is incomplete. */
	incomplete: CourseGlossaryGap[];
}

/** What the glossary reads of one PDF material: its current digest, or why it has none. */
type MaterialGlossaryRead = { digest: MaterialDigest } | { reason: "no_digest" | "outdated" } | { reason: "invalid"; detail: string };

/** How many materials' reads the glossary cache keeps (least recently used first out). */
export const GLOSSARY_CACHE_MAX = 512;
const glossaryReads = new Map<string, { stamp: string; read: MaterialGlossaryRead }>();

/** A file's identity for the cache: modification time, size and inode ("-" when it is missing). */
function fileStamp(file: string): string {
	try {
		const st = fs.statSync(file);
		return `${st.mtimeMs}:${st.size}:${st.ino}`;
	} catch {
		return "-";
	}
}

/** One PDF material's glossary read, from the files (no cache). */
function readForGlossary(ownerId: string, materialId: string, store: MaterialStore): MaterialGlossaryRead {
	const content = readConvertedContent(ownerId, materialId, store);
	if (!content) return { reason: "no_digest" };
	const stored = readStoredDigest(store.auxPath(ownerId, materialId, MATERIAL_DIGEST_FILE));
	if ("problem" in stored) {
		if (stored.problem.kind === "missing") return { reason: "no_digest" };
		return stored.problem.kind === "invalid" ? { reason: "invalid", detail: stored.problem.reason } : { reason: "outdated" };
	}
	return digestIsCurrent(stored.digest, content.key) ? { digest: stored.digest } : { reason: "outdated" };
}

/**
 * One PDF material's glossary read through the cache: keyed by the material's digest.json path (which names its owner
 * and id, so a material moved to another course is a different entry), valid while digest.json, content.md and
 * conversion.json keep their modification time, size and inode (a re-index, a re-conversion or a deletion changes
 * them; every writer replaces the file atomically, so the inode changes too). At most GLOSSARY_CACHE_MAX entries.
 */
function cachedReadForGlossary(ownerId: string, materialId: string, store: MaterialStore): MaterialGlossaryRead {
	const key = store.auxPath(ownerId, materialId, MATERIAL_DIGEST_FILE);
	const stamp = [MATERIAL_DIGEST_FILE, PDF_CONTENT_FILE, PDF_CONVERSION_SIDECAR].map((f) => fileStamp(store.auxPath(ownerId, materialId, f))).join("|");
	const hit = glossaryReads.get(key);
	glossaryReads.delete(key);
	if (hit && hit.stamp === stamp) {
		glossaryReads.set(key, hit);
		return hit.read;
	}
	const read = readForGlossary(ownerId, materialId, store);
	glossaryReads.set(key, { stamp, read });
	while (glossaryReads.size > GLOSSARY_CACHE_MAX) glossaryReads.delete(glossaryReads.keys().next().value!);
	return read;
}

/** Empty the glossary cache (tests). */
export function clearCourseGlossaryCache(): void {
	glossaryReads.clear();
}

/** How many materials' reads the glossary cache holds (tests). */
export const courseGlossaryCacheSize = (): number => glossaryReads.size;

/**
 * The class glossary of a course, built on every call from the digests on disk (no model call). Each material's
 * digest and content hash are read once and cached until its files change (cachedReadForGlossary); `cache: false`
 * reads everything again (the result is the same). Null for an unknown course.
 */
export function courseGlossary(courseId: string, store: MaterialStore = stores.materialStore, opts: { cache?: boolean } = {}): CourseGlossary | null {
	if (!stores.courseStore.getCourse(courseId)) return null;
	const indexed: CourseGlossary["indexed"] = [];
	const incomplete: CourseGlossaryGap[] = [];
	const digests: MaterialDigest[] = [];
	for (const m of store.list(courseId)) {
		const ref = { id: m.id, name: m.name };
		const read: MaterialGlossaryRead = m.kind !== "pdf" ? { reason: "no_digest" } : opts.cache === false ? readForGlossary(courseId, m.id, store) : cachedReadForGlossary(courseId, m.id, store);
		if (!("digest" in read)) {
			incomplete.push({ ...ref, kind: m.kind, reason: read.reason, ...(read.reason === "invalid" ? { detail: read.detail } : {}) });
			continue;
		}
		const digest = read.digest;
		digests.push(digest);
		indexed.push({ ...ref, sourceHash: digest.sourceHash });
		const failed = failedBatchesOf(digest);
		if (failed.length > 0) {
			incomplete.push({ ...ref, kind: m.kind, reason: "failed_batches", failedPages: failed.map((b) => ({ pageStart: b.pageStart, pageEnd: b.pageEnd, pages: [...b.pages] })) });
		}
	}
	const glossary = mergeGlossary(digests);
	const materialsOf = (sourceHash: string) => indexed.filter((m) => m.sourceHash === sourceHash).map(({ id, name }) => ({ id, name }));
	const terms = Object.fromEntries(
		Object.entries(glossary.terms).map(([id, entry]) => [id, { ...entry, citations: entry.citations.map((c) => ({ ...c, materials: materialsOf(c.sourceHash) })) }]),
	);
	return { ...glossary, terms, indexed, incomplete };
}
