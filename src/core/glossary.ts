/**
 * Term identity, the class glossary and its lookups (fork addition, 2026-11-24; reworked 2026-11-25 by the manager's
 * ruling "Term identity", PLAN.md). Pure and browser-safe (no node modules).
 *
 * IDENTITY IS THE EXACT SPELLING. `normalizeName` does only three things: removes invisible characters (INVISIBLE:
 * every default-ignorable code point, which covers the soft hyphen, zero-width characters, directional marks and
 * isolates, the BOM and variation selectors, and every control character that is not whitespace), applies Unicode
 * NFC, and trims and collapses whitespace to single spaces. No case folding, no hyphen, punctuation, apostrophe or
 * prime folding, no compatibility (NFKC) folding. A term's id is `t_`, a concept's `c_`, plus `encodeName` of the
 * normalised name, which is injective: ASCII letters and digits and every non-ASCII character stay as they are, a
 * space is written "_", and every other character (ASCII punctuation and symbols, "_" and "~" themselves, a lone
 * surrogate) is written "~", its hex code point, "~". So distinct normalised names always give distinct ids, the same
 * name always the same id, in every run and every document, and an id is a safe JSON key (never "__proto__").
 * An encoding longer than ID_MAX_CHARS code points is cut (between whole characters) to at most ID_PREFIX_CHARS and
 * given "-" and a 22-character hash of the whole name; "-" appears in no other id, so a long id never equals a short
 * one, and two long ids are equal only on a 106-bit hash collision.
 *
 * Nothing merges by rule: occurrences combine only when their ids are equal. Aliases and symbols are lookup data.
 * The class glossary SUGGESTS likely duplicates (entries sharing a relaxed key, or one naming the other as an alias)
 * for a planner to confirm, and lookups return every candidate; `findTerm` answers only when exactly one entry is
 * possible.
 */

import type { DigestBatch, DigestTerm, MaterialDigest, TermOccurrence, TermTier } from "./contracts/material-digest.ts";

/**
 * The one definition of an invisible character: default-ignorable code points (soft hyphen, zero-width space,
 * non-joiner and joiner, word joiner, invisible operators, LRM, RLM, ALM, the bidi embeddings, overrides and isolates,
 * the BOM, variation selectors, Hangul fillers, tags) and control characters other than whitespace.
 */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}|(?!\s)\p{Cc}/gu;

/** The text with every invisible character removed. Pure. */
export function stripInvisible(text: string): string {
	return text.replace(INVISIBLE, "");
}

/** The shared visible-content check: true when the text has a character that is neither whitespace nor invisible. Pure. */
export function hasVisibleContent(text: string): boolean {
	return /\S/u.test(stripInvisible(text));
}

/** A name as identity reads it: invisible characters removed, NFC, whitespace trimmed and collapsed. Idempotent. Pure. */
export function normalizeName(name: string): string {
	return stripInvisible(name).normalize("NFC").replace(/\s+/gu, " ").trim();
}

/** The longest encoded name kept whole in an id, in code points; a longer one is cut and given a hash. */
export const ID_MAX_CHARS = 120;
/** How much of a long name's encoding is kept before "-" and the hash, at most, in code points. */
export const ID_PREFIX_CHARS = 96;

/** A 53-bit string hash (cyrb53) with a seed, 11 base-36 digits. Deterministic, pure. */
function hash53(text: string, seed: number): string {
	let h1 = 0xdeadbeef ^ seed;
	let h2 = 0x41c6ce57 ^ seed;
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36).padStart(11, "0");
}

/** One code point as the id encoding writes it (see the module comment). */
function encodeChar(ch: string): string {
	const code = ch.codePointAt(0)!;
	const asciiWord = (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
	if (asciiWord) return ch;
	if (code === 0x20) return "_";
	if (code >= 0x80 && !(code >= 0xd800 && code <= 0xdfff)) return ch;
	return `~${code.toString(16)}~`;
}

/**
 * The injective id encoding of a name that is ALREADY normalised (see the module comment); "" for "". Callers pass
 * `normalizeName(name)`; termId and conceptId do. Pure.
 */
export function encodeName(normalized: string): string {
	let out = "";
	let points = 0;
	for (const ch of normalized) {
		const piece = encodeChar(ch);
		out += piece;
		points += piece.length === ch.length ? 1 : piece.length;
	}
	if (points <= ID_MAX_CHARS) return out;
	let prefix = "";
	let used = 0;
	for (const ch of normalized) {
		const piece = encodeChar(ch);
		const size = piece.length === ch.length ? 1 : piece.length;
		if (used + size > ID_PREFIX_CHARS) break;
		prefix += piece;
		used += size;
	}
	return `${prefix}-${hash53(normalized, 0)}${hash53(normalized, 0x9e3779b9)}`;
}

/** A term's id: `t_` + encodeName(normalizeName(term)). "t_" alone for a name with nothing visible (refused upstream). Pure. */
export function termId(term: string): string {
	return `t_${encodeName(normalizeName(term))}`;
}

/** A concept's id: `c_` + encodeName(normalizeName(name)). Pure. */
export function conceptId(name: string): string {
	return `c_${encodeName(normalizeName(name))}`;
}

const WORD = "[\\p{L}\\p{N}\\p{M}]";
const RELAXED_JOIN = new RegExp(`(?<=${WORD})[\\s\\p{Pd}]+(?=${WORD})`, "gu");

/**
 * The relaxed key used ONLY for lookup and duplicate suggestions, never for identity: the normalised name case-folded
 * (upper then lower case, so "ß" reads as "ss" and "ς" as "σ"), whitespace and dashes between two letters or digits
 * removed ("COVID-19", "COVID 19" and "covid19" share one), and any remaining whitespace removed. Other symbols stay
 * ("C", "C++" and "C--" keep different keys). Pure.
 */
export function relaxedKey(text: string): string {
	return normalizeName(text).toUpperCase().toLowerCase().normalize("NFC").replace(RELAXED_JOIN, "").replace(/\s+/gu, "");
}

/** Code-unit order (the same in every locale). */
export const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ── The class glossary ─────────────────────────────────────────────────────

/** An occurrence with the document it is in. */
export interface GlossaryOccurrence extends TermOccurrence {
	/** The document (its digest's sourceHash). */
	sourceHash: string;
}

/** How one document has a glossary term: that digest term's summary. */
export interface GlossaryCitation {
	sourceHash: string;
	/** The page of its first occurrence in that document. */
	page: number;
	tier: TermTier;
	/** That document's chosen explicit definition, or null when it uses the term without defining it. */
	definition: string | null;
	definitionPage: number | null;
	/** The tier of the occurrence that supplied that definition (null with it). */
	definitionTier: TermTier | null;
	/** How many occurrences that document has. */
	occurrenceCount: number;
}

export interface GlossaryEntry {
	/** The term id (equal in every document that spells the name the same). */
	id: string;
	/** The normalised name. */
	term: string;
	/** Every alias the documents give, sorted, unique (lookup data only). */
	aliases: string[];
	/** Every symbol the documents give, sorted, unique (lookup data only). */
	symbols: string[];
	/** core when any document has it as core. */
	tier: TermTier;
	/**
	 * The explicit definition: one supplied by a core occurrence first (a supporting gloss never outranks it), then the
	 * smallest sourceHash; null when no document defines it.
	 */
	definition: string | null;
	definitionPage: number | null;
	definitionTier: TermTier | null;
	/** The document that supplied the definition (null with it). */
	definitionSource: string | null;
	/** One per document, sorted by sourceHash. */
	citations: GlossaryCitation[];
	/** Every occurrence the documents store, by sourceHash and then each document's own order. */
	occurrences: GlossaryOccurrence[];
	/** The exact total over the documents (some documents may store a truncated list: DigestTerm.occurrenceCount). */
	occurrenceCount: number;
}

/** Entries a planner should look at side by side: maybe one concept under several names. Nothing is merged. */
export interface SuggestedDuplicateGroup {
	/** Two or more entry ids, sorted. */
	ids: string[];
	/** similar_name: their names share a relaxed key; alias: one names another as an alias. */
	reasons: ("similar_name" | "alias")[];
}

/** Two or more different digests of one source (the same sourceHash), and which one the glossary used. */
export interface SourceConflict {
	sourceHash: string;
	/** How many distinct copies there were. */
	copies: number;
	/** What decided: fewer failed parts, then the newer indexer version, then the larger digest, then content order. */
	decidedBy: "fewer_failed_parts" | "newer_indexer" | "larger" | "content_order";
}

export interface Glossary {
	/** Keyed by id, sorted by id. */
	terms: Record<string, GlossaryEntry>;
	/** Every relaxed key of an entry's name, aliases and symbols to the ids of the entries that have it, sorted. */
	lookup: Record<string, string[]>;
	/** Sorted by their ids. */
	suggestedDuplicates: SuggestedDuplicateGroup[];
	/** Same-sourceHash conflicts that were resolved, sorted by sourceHash. */
	conflicts: SourceConflict[];
}

/** What mergeGlossary reads from a digest. */
export type GlossarySource = Pick<MaterialDigest, "sourceHash" | "indexerVersion" | "batches" | "terms">;

/** JSON with object keys sorted: equal for equal content whatever order the keys were written in. Pure. */
function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => byCodeUnit(a, b));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

const failedCount = (batches: readonly DigestBatch[]) => batches.reduce((n, b) => n + (b.status === "failed" ? 1 : 0), 0);
const occurrenceTotal = (terms: readonly DigestTerm[]) => terms.reduce((n, t) => n + t.occurrenceCount, 0);

/**
 * One digest per sourceHash, independent of input order: identical copies are one; differing copies are ranked by
 * fewer failed parts, then the higher indexer version, then more terms and more occurrences, then their content, and
 * the conflict is reported.
 */
function resolveSources(digests: readonly GlossarySource[]): { chosen: GlossarySource[]; conflicts: SourceConflict[] } {
	const bySource = new Map<string, Map<string, GlossarySource>>();
	for (const d of digests) {
		const copies = bySource.get(d.sourceHash) ?? new Map<string, GlossarySource>();
		const content = stableJson({ sourceHash: d.sourceHash, indexerVersion: d.indexerVersion, batches: d.batches, terms: d.terms });
		if (!copies.has(content)) copies.set(content, d);
		bySource.set(d.sourceHash, copies);
	}
	const chosen: GlossarySource[] = [];
	const conflicts: SourceConflict[] = [];
	for (const sourceHash of [...bySource.keys()].sort(byCodeUnit)) {
		const ranked = [...bySource.get(sourceHash)!.entries()].map(([content, d]) => ({
			d,
			key: [failedCount(d.batches), -d.indexerVersion, -d.terms.length, -occurrenceTotal(d.terms)],
			content,
		}));
		ranked.sort((a, b) => {
			for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i]! - b.key[i]!;
			return byCodeUnit(a.content, b.content);
		});
		chosen.push(ranked[0]!.d);
		if (ranked.length > 1) {
			const [first, second] = [ranked[0]!.key, ranked[1]!.key];
			const at = first.findIndex((v, i) => v !== second[i]);
			const decidedBy = at === 0 ? "fewer_failed_parts" : at === 1 ? "newer_indexer" : at >= 2 ? "larger" : "content_order";
			conflicts.push({ sourceHash, copies: ranked.length, decidedBy });
		}
	}
	return { chosen, conflicts };
}

/** The citation to take a definition from: one supplied by a core occurrence first, then the first given. */
function chooseDefinition(citations: readonly GlossaryCitation[]): GlossaryCitation | null {
	let best: GlossaryCitation | null = null;
	for (const c of citations) {
		if (c.definition === null) continue;
		if (!best || (c.definitionTier === "core" && best.definitionTier !== "core")) best = c;
	}
	return best;
}

/**
 * Merge several documents' digests into one class glossary: entries grouped by exact id, every occurrence kept with
 * its document, likely duplicates only suggested. The result does not depend on the order of `digests`. Throws on a
 * term with nothing visible in its name (a digest the indexer did not write). Pure.
 */
export function mergeGlossary(digests: readonly GlossarySource[]): Glossary {
	const { chosen, conflicts } = resolveSources(digests);
	interface Acc {
		term: string;
		aliases: Set<string>;
		symbols: Set<string>;
		citations: GlossaryCitation[];
		occurrences: GlossaryOccurrence[];
		count: number;
	}
	const byId = new Map<string, Acc>();
	for (const digest of chosen) {
		for (const t of digest.terms) {
			const name = normalizeName(t.term);
			if (name === "") throw new Error(`the digest ${digest.sourceHash} has a term without a name (${JSON.stringify(t.term)})`);
			const id = termId(name);
			let acc = byId.get(id);
			if (!acc) {
				acc = { term: name, aliases: new Set(), symbols: new Set(), citations: [], occurrences: [], count: 0 };
				byId.set(id, acc);
			}
			for (const a of t.aliases) {
				const alias = normalizeName(a);
				if (alias !== "" && alias !== name) acc.aliases.add(alias);
			}
			for (const s of t.symbols) {
				const symbol = normalizeName(s);
				if (symbol !== "") acc.symbols.add(symbol);
			}
			const previous = acc.citations.at(-1);
			const citation: GlossaryCitation = {
				sourceHash: digest.sourceHash,
				page: t.page,
				tier: t.tier,
				definition: t.definition,
				definitionPage: t.definitionPage,
				definitionTier: t.definitionTier,
				occurrenceCount: t.occurrenceCount,
			};
			// two terms with one id in one digest (not written by the indexer): one citation
			if (previous?.sourceHash === digest.sourceHash) {
				previous.tier = previous.tier === "core" || t.tier === "core" ? "core" : "supporting";
				previous.occurrenceCount += t.occurrenceCount;
				if (chooseDefinition([previous, citation]) === citation) Object.assign(previous, { definition: t.definition, definitionPage: t.definitionPage, definitionTier: t.definitionTier });
			} else acc.citations.push(citation);
			for (const o of t.occurrences) acc.occurrences.push({ sourceHash: digest.sourceHash, ...o });
			acc.count += t.occurrenceCount;
		}
	}

	const terms: [string, GlossaryEntry][] = [];
	const lookup = new Map<string, Set<string>>();
	const addKey = (key: string, id: string) => {
		if (key === "") return;
		const ids = lookup.get(key) ?? new Set<string>();
		ids.add(id);
		lookup.set(key, ids);
	};
	for (const [id, acc] of byId) {
		const defined = chooseDefinition(acc.citations);
		const entry: GlossaryEntry = {
			id,
			term: acc.term,
			aliases: [...acc.aliases].sort(byCodeUnit),
			symbols: [...acc.symbols].sort(byCodeUnit),
			tier: acc.citations.some((c) => c.tier === "core") ? "core" : "supporting",
			definition: defined?.definition ?? null,
			definitionPage: defined?.definitionPage ?? null,
			definitionTier: defined?.definitionTier ?? null,
			definitionSource: defined?.sourceHash ?? null,
			citations: acc.citations,
			occurrences: acc.occurrences,
			occurrenceCount: acc.count,
		};
		terms.push([id, entry]);
		addKey(relaxedKey(entry.term), id);
		for (const a of entry.aliases) addKey(relaxedKey(a), id);
		for (const s of entry.symbols) addKey(relaxedKey(s), id);
	}
	terms.sort(([a], [b]) => byCodeUnit(a, b));

	// Suggested duplicates: a shared relaxed name, or one entry naming another as an alias. Symbols never suggest.
	const groups = new Map<string, Set<SuggestedDuplicateGroup["reasons"][number]>>();
	const suggest = (ids: Iterable<string>, reason: SuggestedDuplicateGroup["reasons"][number]) => {
		const sorted = [...new Set(ids)].sort(byCodeUnit);
		if (sorted.length < 2) return;
		const key = sorted.join("\n");
		const reasons = groups.get(key) ?? new Set();
		reasons.add(reason);
		groups.set(key, reasons);
	};
	const byRelaxedName = new Map<string, string[]>();
	for (const [id, entry] of terms) {
		const key = relaxedKey(entry.term);
		const list = byRelaxedName.get(key);
		if (list) list.push(id);
		else byRelaxedName.set(key, [id]);
	}
	for (const ids of byRelaxedName.values()) suggest(ids, "similar_name");
	for (const [id, entry] of terms) {
		for (const alias of entry.aliases) {
			const named = byRelaxedName.get(relaxedKey(alias))?.filter((other) => other !== id) ?? [];
			for (const other of named) suggest([id, other], "alias");
		}
	}
	const suggestedDuplicates = [...groups.entries()]
		.sort(([a], [b]) => byCodeUnit(a, b))
		.map(([key, reasons]) => ({ ids: key.split("\n"), reasons: [...reasons].sort(byCodeUnit) }));

	// Object.fromEntries defines own properties, so a key such as "__proto__" never reaches a prototype.
	return {
		terms: Object.fromEntries(terms),
		lookup: Object.fromEntries([...lookup.entries()].sort(([a], [b]) => byCodeUnit(a, b)).map(([key, ids]) => [key, [...ids].sort(byCodeUnit)])),
		suggestedDuplicates,
		conflicts,
	};
}

/** What a lookup reads: a glossary, or one with richer entries (server/material-indexing.ts CourseGlossary). */
export interface GlossaryLookup<E extends GlossaryEntry = GlossaryEntry> {
	terms: Record<string, E>;
	lookup: Record<string, string[]>;
}

/** One entry a text may name, and how. */
export interface TermCandidate<E extends GlossaryEntry = GlossaryEntry> {
	entry: E;
	/** Which of the entry's names matched the text's relaxed key. */
	matchedBy: ("name" | "alias" | "symbol")[];
}

/**
 * Every entry a text (a name, alias or symbol, compared by relaxed key) may name, sorted by id; [] when none. Plain
 * text is never read as an id (`findTermById`). Pure.
 */
export function findTermCandidates<E extends GlossaryEntry>(glossary: GlossaryLookup<E>, text: string): TermCandidate<E>[] {
	const key = relaxedKey(text);
	if (key === "" || !Object.hasOwn(glossary.lookup, key)) return [];
	const out: TermCandidate<E>[] = [];
	for (const id of glossary.lookup[key]!) {
		if (!Object.hasOwn(glossary.terms, id)) continue;
		const entry = glossary.terms[id]!;
		const matchedBy: TermCandidate["matchedBy"] = [];
		if (relaxedKey(entry.term) === key) matchedBy.push("name");
		if (entry.aliases.some((a) => relaxedKey(a) === key)) matchedBy.push("alias");
		if (entry.symbols.some((s) => relaxedKey(s) === key)) matchedBy.push("symbol");
		out.push({ entry, matchedBy });
	}
	return out;
}

/**
 * The one entry a text names: undefined when no entry or more than one entry may be meant (an exact own-name match
 * does not suppress another entry's alias or symbol match). Never guesses; use findTermCandidates to see them. Pure.
 */
export function findTerm<E extends GlossaryEntry>(glossary: GlossaryLookup<E>, text: string): E | undefined {
	const candidates = findTermCandidates(glossary, text);
	return candidates.length === 1 ? candidates[0]!.entry : undefined;
}

/** The entry with exactly this id; undefined when none. Pure. */
export function findTermById<E extends GlossaryEntry>(glossary: GlossaryLookup<E>, id: string): E | undefined {
	return Object.hasOwn(glossary.terms, id) ? glossary.terms[id] : undefined;
}
