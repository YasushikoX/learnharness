/**
 * The material digest (fork addition, 2026-11-24): what indexing ONE converted
 * document (its page-marked `content.md`) yields, and the `digest.json` file
 * contract. Built by `src/agent/subagents/material-digest.ts` from bounded
 * parts ("batches") of the whole document (`core/material-split.ts`), read back
 * only through its validated loader (`parseStoredDigest` there), and combined
 * across a class's documents into a glossary by `core/glossary.ts`.
 *
 * IDENTITY IS THE EXACT SPELLING (the manager's ruling of 2026-11-25, PLAN.md
 * "Term identity"). A term's id is `t_` plus an injective encoding of its name
 * after only: invisible characters removed, Unicode NFC, whitespace trimmed and
 * collapsed (`core/glossary.ts normalizeName`, `termId`). No case, hyphen,
 * apostrophe or compatibility folding: "MW" and "mW", "Entropy" and "entropy",
 * "COVID-19" and "COVID 19", "x²" and "x2" are different terms. Nothing is ever
 * merged because of aliases or symbols: occurrences are combined only when their
 * ids are equal. Aliases and symbols are lookup data; likely duplicates are only
 * SUGGESTED by the class glossary, for a planner to confirm.
 *
 * Page markers: `content.md` is written by the host application, which writes
 * every page marker itself and escapes marker-like lines in a page's own text
 * (`core/material-split.ts`: PAGE_MARKER_PATTERN, formatPageMarker,
 * escapePageMarkerLines). Every marker line is a real page boundary; a code
 * fence never spans one.
 */

/**
 * The digest.json format stamp. 2: nullable profile, explicit definitions, batch character ranges, new ids. 3: new
 * ids, batch pages, heading paths and summary bullets persisted. 4: ids are the exact spelling (no folding), no alias
 * merging, terms keep their occurrences (part, page, tier, definition), separate `symbols`, concepts and figures keep
 * their part, the request name is stored (`name`), `failedBatches` is derived from `batches` on read (not stored).
 */
export const MATERIAL_DIGEST_VERSION = 4;

/** The most occurrences a digest term stores (the count stays exact: `occurrenceCount`). See DigestTerm.occurrences. */
export const MAX_TERM_OCCURRENCES = 64;
/** The most aliases, and separately the most symbols, a digest term stores (the smallest by code unit order). */
export const MAX_TERM_NAMES = 32;

/** core: the document treats it as something a student must know. supporting: it appears in passing. */
export type TermTier = "core" | "supporting";

/** One mention of a term in one part of the document, as that part's extraction reported it. */
export interface TermOccurrence {
	/** The part (batch index, 0-based). */
	part: number;
	/** The page the part first mentions the term on. */
	page: number;
	tier: TermTier;
	/** The material's own explicit definition in that part, in its language; null when the part uses the term without defining it. */
	definition: string | null;
	/** The page of that definition; null exactly when `definition` is null. */
	definitionPage: number | null;
}

export interface DigestTerm {
	/** `t_` + the encoding of the normalised name (core/glossary.ts termId): equal ids exactly when equal names. */
	id: string;
	/** The name, normalised (core/glossary.ts normalizeName): the material's spelling, case and notation kept. */
	term: string;
	/** Other names and abbreviations the material uses for this concept (lookup data only), normalised, sorted, unique. */
	aliases: string[];
	/** Notation used for it (lookup data only), normalised, sorted, unique. */
	symbols: string[];
	/** The page of the first occurrence in source order (not the smallest page number: numbering may run backwards). */
	page: number;
	/** core when any occurrence is core. */
	tier: TermTier;
	/**
	 * The chosen explicit definition: from the first core occurrence that has one, else from the first occurrence that
	 * has one (source order); null when no occurrence defines it. Never a definition the material does not give.
	 */
	definition: string | null;
	/** The page of that definition; null exactly when `definition` is null. */
	definitionPage: number | null;
	/** The tier of the occurrence that supplied the definition (a supporting gloss never outranks a core definition); null with it. */
	definitionTier: TermTier | null;
	/**
	 * The occurrences, in source order (part, then the part's own order). When there are more than MAX_TERM_OCCURRENCES,
	 * the list keeps the first MAX_TERM_OCCURRENCES - 2 in source order plus the occurrence that supplied the definition
	 * and the first core one, so every summary field above can be derived from the list alone.
	 */
	occurrences: TermOccurrence[];
	/** How many occurrences there are in all (more than `occurrences.length` exactly when the list was truncated). */
	occurrenceCount: number;
}

/** A checkable idea (a claim, rule or result), not a word. */
export interface DigestConcept {
	/** `c_` + the encoding of the normalised name (core/glossary.ts conceptId). */
	id: string;
	/** The name, normalised. */
	name: string;
	/** As the first occurrence in source order states it. */
	statement: string;
	page: number;
	/** The part (batch index) of that first occurrence. */
	part: number;
}

export interface DigestFigure {
	page: number;
	caption: string;
	/** The part (batch index) that reported it first. */
	part: number;
}

/** One batch of the split plan: where it sits in content.md and what the extraction request said about it. */
export interface DigestBatchRef {
	index: number;
	/** The page its first character is on. */
	pageStart: number;
	/** The page its last character is on (lower than pageStart only when the markers run backwards). */
	pageEnd: number;
	/** Every page its text is on, ascending (core/material-split.ts MaterialBatch.pages): what citations are checked against. */
	pages: number[];
	/** The heading titles in force where it starts, outermost first; each title whitespace-collapsed, at most 200 characters. */
	headingPath: string[];
	/** content.md.slice(charStart, charEnd) is the batch's text (UTF-16 offsets): a failed batch can be re-run alone. */
	charStart: number;
	charEnd: number;
}

/** A batch whose notes validated. */
export interface DigestIndexedBatch extends DigestBatchRef {
	status: "indexed";
	/** The batch's own summary bullets, in order: the reduce step's notes for it. */
	summaryBullets: string[];
}

/** A batch whose model output never validated (or whose call failed): its pages are not indexed. */
export interface DigestFailedBatch extends DigestBatchRef {
	status: "failed";
	error: string;
}

export type DigestBatch = DigestIndexedBatch | DigestFailedBatch;

interface MaterialDigestBase {
	version: typeof MATERIAL_DIGEST_VERSION;
	/** The converted document's content hash (supplied by the caller). */
	sourceHash: string;
	/** The converter that produced content.md, and its version (supplied by the caller). */
	converter: string;
	converterVersion: string;
	/** The indexer's version (`MATERIAL_INDEXER_VERSION`): a bump means re-index. */
	indexerVersion: number;
	/** The document name the requests showed (bounded), or null: the reduce request is rebuilt from it exactly. */
	name: string | null;
	/**
	 * The highest page marker seen in content.md; 1 without markers. Not the physical page count: a converter may leave
	 * out pages without text (pdf-markdown.ts joinPages drops image-only pages), so a PDF whose last page is a picture
	 * reports less here. See `sourcePageCount`.
	 */
	pageCount: number;
	/** The source's physical page count when the caller supplied it (a PDF's page count at conversion); else null. */
	sourcePageCount: number | null;
	/** The whole split plan, in order, each batch indexed or failed (the failed ones: material-digest.ts failedBatchesOf). */
	batches: DigestBatch[];
	/** In order of first occurrence (source order). */
	terms: DigestTerm[];
	concepts: DigestConcept[];
	/** In source order, each page and caption once. */
	figures: DigestFigure[];
}

/**
 * The digest.json contract. `profile` is the source profile in the Markdown format of `LessonMaterial.profile`
 * (core/materials.ts), or null with `profileError` saying why (the profile call failed, or no batch was indexed): the
 * extracted terms, concepts and figures are kept either way, and the profile can be written again later from the digest
 * alone (agent/subagents/material-digest.ts rewriteProfile).
 */
export type MaterialDigest = MaterialDigestBase & ({ profile: string; profileError?: undefined } | { profile: null; profileError: string });
