/**
 * The material digest (fork addition, 2026-11-24): what indexing ONE converted
 * document (its page-marked `content.md`) yields, and the `digest.json` file
 * contract. Built by `src/agent/subagents/material-digest.ts` from bounded
 * batches of the whole document (`core/material-split.ts`), merged across a
 * class's documents into a glossary by `core/glossary.ts`.
 *
 * Ids are deterministic (`t_` / `c_` plus the slug of the normalised name,
 * `core/glossary.ts termId`/`conceptId`), so re-indexing a document, or
 * indexing another document that defines the same term, gives the same id.
 */

/** The digest.json format stamp. */
export const MATERIAL_DIGEST_VERSION = 1;

/** core: the document treats it as something a student must know. supporting: it appears in passing. */
export type TermTier = "core" | "supporting";

export interface DigestTerm {
	/** `t_` + slug of the normalised term. */
	id: string;
	/** The term as the material writes it (its earliest occurrence). */
	term: string;
	/** Other names or spellings the material uses for it. */
	aliases: string[];
	/** The definition taken from the material, in its language. */
	definition: string;
	/** The earliest page it appears on (1 for a document without page markers). */
	page: number;
	tier: TermTier;
}

/** A checkable idea (a claim, rule or result), not a word. */
export interface DigestConcept {
	/** `c_` + slug of the normalised name. */
	id: string;
	name: string;
	statement: string;
	page: number;
}

export interface DigestFigure {
	page: number;
	caption: string;
}

/** One batch of the split plan: its page range. */
export interface DigestBatchRef {
	index: number;
	pageStart: number;
	pageEnd: number;
}

/** A batch whose model output never validated (or whose call failed): its pages are not indexed. */
export interface DigestFailedBatch extends DigestBatchRef {
	error: string;
}

/** The digest.json contract. */
export interface MaterialDigest {
	version: typeof MATERIAL_DIGEST_VERSION;
	/** The converted document's content hash (supplied by the caller). */
	sourceHash: string;
	/** The converter that produced content.md, and its version (supplied by the caller). */
	converter: string;
	converterVersion: string;
	/** The indexer's version (`MATERIAL_INDEXER_VERSION`): a bump means re-index. */
	indexerVersion: number;
	/** The highest page marker in content.md; 1 without markers. */
	pageCount: number;
	/** The whole split plan, in order (failed batches included). */
	batches: DigestBatchRef[];
	/** The batches that could not be indexed (a subset of `batches`). */
	failedBatches: DigestFailedBatch[];
	terms: DigestTerm[];
	concepts: DigestConcept[];
	figures: DigestFigure[];
	/** The source profile, the same Markdown format as `LessonMaterial.profile` (core/materials.ts). */
	profile: string;
}
