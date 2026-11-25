/**
 * The class glossary (fork addition, 2026-11-24): the terms of several
 * documents' digests (contracts/material-digest.ts) merged into one glossary,
 * and the id and lookup rules both share. Pure.
 *
 * Ids: `t_` (terms) or `c_` (concepts) plus the slug of the normalised name.
 * Normalising: Unicode NFKC, lower case. Slug: runs of letters and digits (any
 * script, diacritics kept: "første" stays "første") joined by "-". A name with
 * no letter or digit at all (a bare symbol such as "∇") is slugged by its code
 * points ("u2207"). So "Eigen-value", "eigen value" and "EIGEN VALUE" are one id,
 * the same term gets the same id across re-indexing and across documents, and
 * `findTerm` matches on exactly the same key.
 *
 * Merging: within a document, terms with the same id were merged by the
 * indexer. Across documents (and within one), two terms are the same entry when
 * their keys meet: a term's own key or any alias key equal to another term's
 * own or alias key (transitively). Each entry keeps one citation per document
 * (its earliest page there and that document's definition) and is `core` if any
 * document says core. The entry's id is chosen without regard to input order:
 * the member id that the most documents use as their term's own id, ties to the
 * lexicographically smallest, so the class glossary's ids are stable as
 * documents are added in any order. Every member id stays listed in `ids`.
 */

import type { DigestTerm, MaterialDigest, TermTier } from "./contracts/material-digest.ts";

/** NFKC, lower case, whitespace collapsed, trimmed. Pure. */
export function normalizeName(name: string): string {
	return name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** The longest slug kept (a concept named by a whole sentence still gets a bounded id). */
export const SLUG_MAX_CHARS = 96;

/** The id slug of a name (see the module comment). "" only for an empty or all-whitespace name. Pure. */
export function slugOf(name: string): string {
	const norm = normalizeName(name);
	const words = norm.match(/[\p{L}\p{N}\p{M}]+/gu);
	let slug = words ? words.join("-") : [...norm.replace(/\s/g, "")].map((ch) => `u${ch.codePointAt(0)!.toString(16)}`).join("-");
	if (slug.length > SLUG_MAX_CHARS) slug = slug.slice(0, SLUG_MAX_CHARS).replace(/-+$/, "");
	return slug;
}

/** A term's id. Pure. */
export function termId(term: string): string {
	return `t_${slugOf(term)}`;
}

/** A concept's id. Pure. */
export function conceptId(name: string): string {
	return `c_${slugOf(name)}`;
}

/** Where one document cites a glossary term. */
export interface GlossaryCitation {
	/** The document (its digest's sourceHash). */
	sourceHash: string;
	/** The earliest page the term appears on in that document. */
	page: number;
	/** That document's definition. */
	definition: string;
	/** Its tier in that document. */
	tier: TermTier;
}

export interface GlossaryEntry {
	/** The canonical id (see the module comment). */
	id: string;
	/** Every term id merged into this entry (the canonical one included), sorted. */
	ids: string[];
	/** The display form: the canonical id's term as first written. */
	term: string;
	/** Every other spelling and alias, unique by key, in first-seen order. */
	aliases: string[];
	/** The canonical term's definition from its first citation. */
	definition: string;
	tier: TermTier;
	/** One per document, in input order. */
	citations: GlossaryCitation[];
}

export interface Glossary {
	/** Keyed by canonical id. */
	terms: Record<string, GlossaryEntry>;
	/** Every slug key (term ids' slugs and aliases' slugs) to its entry's canonical id; for findTerm. */
	index: Record<string, string>;
}

/** Merge several documents' digests into one class glossary. Pure. */
export function mergeGlossary(digests: readonly Pick<MaterialDigest, "sourceHash" | "terms">[]): Glossary {
	interface Occurrence {
		doc: number;
		term: DigestTerm;
		keys: string[];
	}
	const occurrences: Occurrence[] = [];
	digests.forEach((digest, doc) => {
		for (const term of digest.terms) {
			const keys = [slugOf(term.term), ...term.aliases.map(slugOf)].filter((k) => k !== "");
			if (keys.length === 0) continue;
			occurrences.push({ doc, term, keys });
		}
	});

	// Union-find over occurrences, joined through shared keys.
	const parent = occurrences.map((_, i) => i);
	const find = (i: number): number => {
		while (parent[i] !== i) {
			parent[i] = parent[parent[i]!]!;
			i = parent[i]!;
		}
		return i;
	};
	const ownerOfKey = new Map<string, number>();
	occurrences.forEach((occ, i) => {
		for (const key of occ.keys) {
			const other = ownerOfKey.get(key);
			if (other === undefined) ownerOfKey.set(key, i);
			else parent[find(i)] = find(other);
		}
	});

	const groups = new Map<number, Occurrence[]>();
	occurrences.forEach((occ, i) => {
		const root = find(i);
		const list = groups.get(root);
		if (list) list.push(occ);
		else groups.set(root, [occ]);
	});

	const terms: Record<string, GlossaryEntry> = {};
	const index: Record<string, string> = {};
	for (const members of groups.values()) {
		// The canonical id: the own id the most documents use, ties to the smallest.
		const docsPerId = new Map<string, Set<number>>();
		for (const m of members) {
			const id = termId(m.term.term);
			const docs = docsPerId.get(id) ?? new Set<number>();
			docs.add(m.doc);
			docsPerId.set(id, docs);
		}
		const ids = [...docsPerId.keys()].sort();
		const id = ids.reduce((best, cur) => (docsPerId.get(cur)!.size > docsPerId.get(best)!.size ? cur : best), ids[0]!);
		const canonical = members.find((m) => termId(m.term.term) === id)!;

		const citations: GlossaryCitation[] = [];
		const byDoc = new Map<number, GlossaryCitation>();
		for (const m of members) {
			const seen = byDoc.get(m.doc);
			if (!seen) {
				const citation: GlossaryCitation = { sourceHash: digests[m.doc]!.sourceHash, page: m.term.page, definition: m.term.definition, tier: m.term.tier };
				byDoc.set(m.doc, citation);
				citations.push(citation);
				continue;
			}
			if (m.term.page < seen.page) {
				seen.page = m.term.page;
				seen.definition = m.term.definition;
			}
			if (m.term.tier === "core") seen.tier = "core";
		}

		const canonicalKey = slugOf(canonical.term.term);
		const aliases: string[] = [];
		const aliasKeys = new Set<string>([canonicalKey]);
		for (const m of members) {
			for (const name of [m.term.term, ...m.term.aliases]) {
				const key = slugOf(name);
				if (key === "" || aliasKeys.has(key)) continue;
				aliasKeys.add(key);
				aliases.push(name.trim());
			}
		}

		terms[id] = {
			id,
			ids,
			term: canonical.term.term,
			aliases,
			definition: canonical.term.definition,
			tier: members.some((m) => m.term.tier === "core") ? "core" : "supporting",
			citations,
		};
		for (const key of aliasKeys) index[key] = id;
	}
	return { terms, index };
}

/** The entry a term, alias or term id names (normalised as ids are); undefined when none. Pure. */
export function findTerm(glossary: Glossary, text: string): GlossaryEntry | undefined {
	const trimmed = text.trim();
	// A term id (canonical or merged) is `t_` + its slug key.
	const keys = [...(trimmed.startsWith("t_") ? [trimmed.slice(2)] : []), slugOf(trimmed)];
	for (const key of keys) {
		// own keys only: a plain-object index answers "constructor" from its prototype
		const id = key !== "" && Object.hasOwn(glossary.index, key) ? glossary.index[key] : undefined;
		if (id !== undefined && Object.hasOwn(glossary.terms, id)) return glossary.terms[id];
	}
	return undefined;
}
