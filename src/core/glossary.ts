/**
 * The class glossary (fork addition, 2026-11-24): the terms of several
 * documents' digests (contracts/material-digest.ts) merged into one glossary,
 * and the id, alias and lookup rules the indexer shares. Pure.
 *
 * Keys and ids: `t_` (terms) or `c_` (concepts) plus the KEY of the name
 * (`slugOf`). Normalising: Unicode NFKC, lower case, the apostrophe-like marks
 * ’ ‘ ʼ ′ read as '. The key is the name's tokens joined by "-": a word is a run
 * of letters, digits and combining marks (any script, diacritics kept: "første"
 * stays "første"); whitespace, dashes and "_" only separate words; every other
 * character (a symbol or punctuation: + ( ) ' ∇ …) is a token of its own, written
 * "_" and its hex code point ("+" is "_2b"). So "Eigen-value", "eigen value" and
 * "EIGEN VALUE" share a key, while "C" and "C++", "f(x)" and "f′(x)", "∇" and the
 * word "u2207" do not (a word never contains "_"). A key longer than
 * SLUG_MAX_CHARS code points keeps its start and ends in "~" and a hash of the
 * whole key, so names that differ late still differ. The same name gives the same
 * key across batches, re-indexing and documents, and `findTerm` matches on it.
 *
 * Merging (here across documents, and in the indexer across a document's
 * batches, both through `unifyByAlias`): occurrences with the same key are one
 * term. Two different keys are one term only on unambiguous evidence: one of
 * them is declared as an alias by the other and by no other term (`OLS` and
 * `ordinary least squares` with alias `OLS`). An alias declared by two or more
 * terms (`v` for velocity and for voltage) is ambiguous: it never merges anything
 * and stays a lookup candidate of each of them. Two terms that merely share an
 * alias are not merged.
 *
 * Each entry keeps one citation per document (keyed by the digest's
 * `sourceHash`, so a repeated digest counts once): its earliest page there and
 * that document's definition. It is `core` if any document says core. The entry's
 * id is chosen without regard to input order: the member key that the most
 * distinct documents use as a term's own name, ties to the lexicographically
 * smallest, so the class glossary's ids are stable as documents are added in any
 * order. Every member id stays listed in `ids`.
 */

import type { DigestTerm, MaterialDigest, TermTier } from "./contracts/material-digest.ts";

/** NFKC, lower case, whitespace collapsed, trimmed. Pure. */
export function normalizeName(name: string): string {
	return name.normalize("NFKC").toLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim();
}

/** The longest key kept as it is, in code points; a longer one is shortened and given a hash suffix. */
export const SLUG_MAX_CHARS = 96;
/** How much of a long key's start is kept before its hash suffix, in code points. */
const SLUG_PREFIX_CHARS = SLUG_MAX_CHARS - 12;

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
const SEPARATOR = /[\s\p{Pd}_]/u;
const APOSTROPHES = /[‘’ʼ′]/g;

/** A 53-bit string hash (cyrb53), 11 base-36 digits. Deterministic, pure. */
function hash53(text: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36).padStart(11, "0");
}

/** The id key of a name (see the module comment). "" only for an empty or all-separator name. Pure. */
export function slugOf(name: string): string {
	const norm = normalizeName(name).replace(APOSTROPHES, "'");
	const tokens: string[] = [];
	let word = "";
	for (const ch of norm) {
		if (WORD_CHAR.test(ch)) {
			word += ch;
			continue;
		}
		if (word) tokens.push(word);
		word = "";
		if (!SEPARATOR.test(ch)) tokens.push(`_${ch.codePointAt(0)!.toString(16)}`);
	}
	if (word) tokens.push(word);
	const key = tokens.join("-");
	const points = [...key];
	if (points.length <= SLUG_MAX_CHARS) return key;
	return `${points.slice(0, SLUG_PREFIX_CHARS).join("").replace(/-+$/, "")}~${hash53(key)}`;
}

/** A term's id. Pure. */
export function termId(term: string): string {
	return `t_${slugOf(term)}`;
}

/** A concept's id. Pure. */
export function conceptId(name: string): string {
	return `c_${slugOf(name)}`;
}

/**
 * Which groups of names are one term, on unambiguous alias evidence only (see the module comment): group X joins
 * group K when X's key is an alias key that K declares and no other group declares. Groups have distinct keys. Returns
 * a component label per group (the smallest group index in its component). Pure.
 */
export function unifyByAlias(groups: readonly { key: string; aliasKeys: Iterable<string> }[]): number[] {
	const ownIndex = new Map<string, number>();
	groups.forEach((g, i) => ownIndex.set(g.key, i));
	const claimants = new Map<string, Set<number>>();
	groups.forEach((g, i) => {
		for (const a of g.aliasKeys) {
			if (a === "" || a === g.key) continue;
			const set = claimants.get(a) ?? new Set<number>();
			set.add(i);
			claimants.set(a, set);
		}
	});
	const parent = groups.map((_, i) => i);
	const find = (i: number): number => {
		while (parent[i] !== i) {
			parent[i] = parent[parent[i]!]!;
			i = parent[i]!;
		}
		return i;
	};
	for (const [alias, by] of claimants) {
		const owner = ownIndex.get(alias);
		if (owner === undefined || by.size !== 1) continue;
		const [claimant] = by;
		const a = find(owner);
		const b = find(claimant!);
		if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
	}
	return groups.map((_, i) => find(i));
}

/** Something that may carry an explicit definition. */
export interface DefinitionSource {
	definition: string | null;
	definitionPage: number | null;
	tier: TermTier;
}

/**
 * The explicit definition to keep among several mentions of one term: from a core mention before a supporting one
 * (the material's formal definition over a passing gloss), then the earliest definition page, then the first given.
 * Null when none is explicit. Pure.
 */
export function pickDefinition<T extends DefinitionSource>(sources: readonly T[]): T | null {
	let best: T | null = null;
	for (const s of sources) {
		if (s.definition === null || s.definitionPage === null) continue;
		if (!best) {
			best = s;
			continue;
		}
		const rank = (x: T) => (x.tier === "core" ? 0 : 1);
		if (rank(s) < rank(best) || (rank(s) === rank(best) && s.definitionPage < best.definitionPage!)) best = s;
	}
	return best;
}

/** Where one document cites a glossary term. */
export interface GlossaryCitation {
	/** The document (its digest's sourceHash). */
	sourceHash: string;
	/** The earliest page the term is mentioned on in that document. */
	page: number;
	/** That document's explicit definition, or null when it uses the term without defining it. */
	definition: string | null;
	/** The page of that definition (null with it). */
	definitionPage: number | null;
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
	/** Every other spelling and alias, unique by key, in first-seen order (ambiguous aliases included). */
	aliases: string[];
	/** The explicit definition: the canonical name's first one in input order, else any member's first; null when no document defines it. */
	definition: string | null;
	tier: TermTier;
	/** One per document (distinct sourceHash), in input order. */
	citations: GlossaryCitation[];
}

export interface Glossary {
	/** Keyed by canonical id. */
	terms: Record<string, GlossaryEntry>;
	/** Every member's own key (an id without its `t_`) to its entry's canonical id: one entry per key by construction. */
	names: Record<string, string>;
	/** Every alias key to the canonical ids of all entries that declare it, sorted; more than one means ambiguous. */
	aliases: Record<string, string[]>;
}

/** Merge several documents' digests into one class glossary. Pure. */
export function mergeGlossary(digests: readonly Pick<MaterialDigest, "sourceHash" | "terms">[]): Glossary {
	interface Occurrence {
		order: number;
		sourceHash: string;
		term: DigestTerm;
		key: string;
		aliasKeys: string[];
	}
	// One digest per sourceHash: a repeated document counts once (its first copy).
	const seenSources = new Set<string>();
	const occurrences: Occurrence[] = [];
	for (const digest of digests) {
		if (seenSources.has(digest.sourceHash)) continue;
		seenSources.add(digest.sourceHash);
		for (const term of digest.terms) {
			const key = slugOf(term.term);
			if (key === "") continue;
			occurrences.push({ order: occurrences.length, sourceHash: digest.sourceHash, term, key, aliasKeys: term.aliases.map(slugOf).filter((k) => k !== "" && k !== key) });
		}
	}

	// Same key: one group. Then unambiguous alias evidence joins groups.
	const groupOf = new Map<string, Occurrence[]>();
	for (const occ of occurrences) {
		const list = groupOf.get(occ.key);
		if (list) list.push(occ);
		else groupOf.set(occ.key, [occ]);
	}
	const groups = [...groupOf.entries()].map(([key, members]) => ({ key, members, aliasKeys: new Set(members.flatMap((m) => m.aliasKeys)) }));
	const labels = unifyByAlias(groups);
	const components = new Map<number, typeof groups>();
	groups.forEach((g, i) => {
		const list = components.get(labels[i]!);
		if (list) list.push(g);
		else components.set(labels[i]!, [g]);
	});

	const terms = new Map<string, GlossaryEntry>();
	const names = new Map<string, string>();
	const aliasOwners = new Map<string, Set<string>>();
	for (const parts of components.values()) {
		const members = parts.flatMap((p) => p.members).sort((a, b) => a.order - b.order);
		// The canonical key: the own key the most distinct documents use, ties to the smallest.
		const docsPerKey = new Map(parts.map((p) => [p.key, new Set(p.members.map((m) => m.sourceHash)).size]));
		const keys = [...docsPerKey.keys()].sort();
		const canonicalKey = keys.reduce((best, cur) => (docsPerKey.get(cur)! > docsPerKey.get(best)! ? cur : best), keys[0]!);
		const id = `t_${canonicalKey}`;
		const canonical = members.find((m) => m.key === canonicalKey)!;

		const citations: GlossaryCitation[] = [];
		const bySource = new Map<string, Occurrence[]>();
		for (const m of members) {
			const list = bySource.get(m.sourceHash);
			if (list) list.push(m);
			else bySource.set(m.sourceHash, [m]);
		}
		for (const [sourceHash, list] of bySource) {
			const defined = pickDefinition(list.map((m) => m.term));
			citations.push({
				sourceHash,
				page: Math.min(...list.map((m) => m.term.page)),
				definition: defined?.definition ?? null,
				definitionPage: defined?.definitionPage ?? null,
				tier: list.some((m) => m.term.tier === "core") ? "core" : "supporting",
			});
		}

		const ownKeys = new Set(parts.map((p) => p.key));
		const aliases: string[] = [];
		const shownKeys = new Set<string>([canonicalKey]);
		for (const m of members) {
			for (const name of [m.term.term, ...m.term.aliases]) {
				const key = slugOf(name);
				if (key === "" || shownKeys.has(key)) continue;
				shownKeys.add(key);
				aliases.push(name.trim());
			}
		}
		const definedBy = members.find((m) => m.key === canonicalKey && m.term.definition !== null) ?? members.find((m) => m.term.definition !== null);

		terms.set(id, {
			id,
			ids: [...ownKeys].map((k) => `t_${k}`).sort(),
			term: canonical.term.term.trim(),
			aliases,
			definition: definedBy?.term.definition ?? null,
			tier: members.some((m) => m.term.tier === "core") ? "core" : "supporting",
			citations,
		});
		for (const key of ownKeys) names.set(key, id);
		for (const key of shownKeys) {
			if (ownKeys.has(key)) continue;
			const set = aliasOwners.get(key) ?? new Set<string>();
			set.add(id);
			aliasOwners.set(key, set);
		}
	}
	// Object.fromEntries defines own properties, so a key such as "constructor" never reaches a prototype.
	return {
		terms: Object.fromEntries(terms),
		names: Object.fromEntries(names),
		aliases: Object.fromEntries([...aliasOwners].map(([key, ids]) => [key, [...ids].sort()])),
	};
}

function own<T>(record: Record<string, T>, key: string): T | undefined {
	return key !== "" && Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * Every entry a term, alias or term id may name (normalised as ids are): the entry whose own name (or id) it is first,
 * then every entry that declares it as an alias, by id. [] when none. Pure.
 */
export function findTermCandidates(glossary: Glossary, text: string): GlossaryEntry[] {
	const trimmed = text.trim();
	const ids: string[] = [];
	const add = (id: string | undefined) => {
		if (id !== undefined && !ids.includes(id) && Object.hasOwn(glossary.terms, id)) ids.push(id);
	};
	// A term id (canonical or merged) is `t_` + its key.
	if (trimmed.startsWith("t_")) add(own(glossary.names, trimmed.slice(2)));
	const key = slugOf(trimmed);
	add(own(glossary.names, key));
	for (const id of own(glossary.aliases, key) ?? []) add(id);
	return ids.map((id) => glossary.terms[id]!);
}

/**
 * The one entry a term, alias or term id names; undefined when none, or when the text is only an alias that several
 * entries declare (ambiguous: use findTermCandidates). An entry's own name or id always names that entry. Pure.
 */
export function findTerm(glossary: Glossary, text: string): GlossaryEntry | undefined {
	const trimmed = text.trim();
	const byName = (trimmed.startsWith("t_") ? own(glossary.names, trimmed.slice(2)) : undefined) ?? own(glossary.names, slugOf(trimmed));
	if (byName !== undefined && Object.hasOwn(glossary.terms, byName)) return glossary.terms[byName];
	const byAlias = own(glossary.aliases, slugOf(trimmed)) ?? [];
	return byAlias.length === 1 && Object.hasOwn(glossary.terms, byAlias[0]!) ? glossary.terms[byAlias[0]!] : undefined;
}
