/**
 * The material digest (fork addition, 2026-11-24): what indexing ONE converted
 * document (its page-marked `content.md`) yields, and the `digest.json` file
 * contract. Built by `src/agent/subagents/material-digest.ts` from bounded
 * batches of the whole document (`core/material-split.ts`), merged across a
 * class's documents into a glossary by `core/glossary.ts`.
 *
 * Ids are deterministic (`t_` / `c_` plus the key of the normalised name,
 * `core/glossary.ts slugOf`), so re-indexing a document, or indexing another
 * document that names the same term, gives the same id; names that differ in
 * anything but case, spacing, hyphenation or Unicode compatibility form get
 * different ids ("C" and "C++", "f(x)" and "f′(x)" are different terms).
 *
 * Page markers: `content.md` marks page N with a line `--- Page N ---` of its
 * own. Converters must not emit a page marker inside a fenced code block (``` or
 * ~~~) and must close every fence they open: the splitter treats marker-like
 * lines and headings inside a closed fence as content (a fenced example of a
 * marker is not a page break), and a fence that is never closed as no fence.
 */

/** The digest.json format stamp. 2: nullable profile, explicit definitions, batch character ranges, new ids. */
export const MATERIAL_DIGEST_VERSION = 2;

/** core: the document treats it as something a student must know. supporting: it appears in passing. */
export type TermTier = "core" | "supporting";

export interface DigestTerm {
	/** `t_` + the key of the normalised term (core/glossary.ts termId). */
	id: string;
	/** The term as the material writes it. */
	term: string;
	/** Other names, abbreviations or symbols the material uses for it. */
	aliases: string[];
	/** The earliest page it is mentioned on (1 for a document without page markers). */
	page: number;
	tier: TermTier;
	/**
	 * The material's own explicit definition, in its language; null when the material uses the term without defining
	 * it (a prerequisite it takes as known). Never a definition the material does not give.
	 */
	definition: string | null;
	/** The page of that definition; null exactly when `definition` is null. */
	definitionPage: number | null;
}

/** A checkable idea (a claim, rule or result), not a word. */
export interface DigestConcept {
	/** `c_` + the key of the normalised name. */
	id: string;
	name: string;
	statement: string;
	page: number;
}

export interface DigestFigure {
	page: number;
	caption: string;
}

/** One batch of the split plan: its page range and where it sits in content.md. */
export interface DigestBatchRef {
	index: number;
	/** The page its first character is on. */
	pageStart: number;
	/** The page its last character is on (lower than pageStart only when the markers run backwards). */
	pageEnd: number;
	/** content.md.slice(charStart, charEnd) is the batch's text (UTF-16 offsets): a failed batch can be re-run alone. */
	charStart: number;
	charEnd: number;
}

/** A batch whose model output never validated (or whose call failed): its pages are not indexed. */
export interface DigestFailedBatch extends DigestBatchRef {
	error: string;
}

interface MaterialDigestBase {
	version: typeof MATERIAL_DIGEST_VERSION;
	/** The converted document's content hash (supplied by the caller). */
	sourceHash: string;
	/** The converter that produced content.md, and its version (supplied by the caller). */
	converter: string;
	converterVersion: string;
	/** The indexer's version (`MATERIAL_INDEXER_VERSION`): a bump means re-index. */
	indexerVersion: number;
	/**
	 * The highest page marker seen in content.md; 1 without markers. Not the physical page count: a converter may leave
	 * out pages without text (pdf-markdown.ts joinPages drops image-only pages), so a PDF whose last page is a picture
	 * reports less here. See `sourcePageCount`.
	 */
	pageCount: number;
	/** The source's physical page count when the caller supplied it (a PDF's page count at conversion); else null. */
	sourcePageCount: number | null;
	/** The whole split plan, in order (failed batches included). */
	batches: DigestBatchRef[];
	/** The batches that could not be indexed (a subset of `batches`; all of them when nothing could be indexed). */
	failedBatches: DigestFailedBatch[];
	terms: DigestTerm[];
	concepts: DigestConcept[];
	figures: DigestFigure[];
}

/**
 * The digest.json contract. `profile` is the source profile in the Markdown format of `LessonMaterial.profile`
 * (core/materials.ts), or null with `profileError` saying why (the profile call failed, or no batch was indexed): the
 * extracted terms, concepts and figures are kept either way, and the profile can be written again later.
 */
export type MaterialDigest = MaterialDigestBase & ({ profile: string; profileError?: undefined } | { profile: null; profileError: string });
