/**
 * The class glossary (fork addition, 2026-11-24): the terms of several
 * documents' digests (contracts/material-digest.ts) merged into one glossary,
 * and the id, alias and lookup rules the indexer shares. Pure.
 *
 * Keys and ids: `t_` (terms) or `c_` (concepts) plus the KEY of the name
 * (`slugOf`). Normalising (`normalizeName`): soft hyphens and zero-width
 * characters removed, Unicode NFC, then only these foldings: the ligatures
 * ﬀ ﬁ ﬂ ﬃ ﬄ ﬅ ﬆ Ĳ ĳ spelled out, full-width ASCII forms (Ａ, ＋) read as ASCII, the
 * apostrophe and prime marks ’ ‘ ʼ ′ read as ' (″ as '', ‴ as '''); then lower
 * case and whitespace collapsed. Superscripts, subscripts and double-struck
 * letters are NOT folded: "x²", "x₂" and "x2", "ℝ" and "R" are different names.
 *
 * The key is the name's tokens joined by "-". A word is a run of letters,
 * digits and combining marks (any script, diacritics kept: "første" stays
 * "første"). Whitespace separates words. A dash (- – — …) between two letters
 * also only separates words ("Eigen-value" and "eigen value" share a key); any
 * other dash, "_" and every other symbol or punctuation character is a token of
 * its own, written "_" and its hex code point ("+" is "_2b", "-" is "_2d"). So
 * "C", "C++" and "C--", "-1" and "1", "O(n-1)" and "O(n 1)", "x_y" and "x-y",
 * "f(x)" and "f′(x)", "∇" and the word "u2207" all differ (a word never contains
 * "_"). A key longer than SLUG_MAX_CHARS code points is cut to its first
 * SLUG_PREFIX_CHARS code points, then "~" and an 11-character hash of the whole
 * key are appended (names that differ only late still differ; "~" itself is
 * always written "_7e" in a key). A name whose key is empty (nothing but
 * whitespace and invisible characters) has no id: the indexer refuses it. The
 * same name gives the same key across batches, re-indexing and documents.
 *
 * Merging (here across documents, and in the indexer across a document's
 * batches, both through `unifyByAlias`): occurrences with the same key are one
 * term; for different keys see `unifyByAlias`. When in doubt nothing merges: an
 * unmerged duplicate is visible, a wrong merge hides a core term.
 *
 * Each entry keeps one citation per document (keyed by the digest's
 * `sourceHash`, so a repeated digest counts once). Documents are processed in
 * `sourceHash` order, so the whole glossary is the same whatever order the
 * digests come in. The entry's id is the member key that the most distinct
 * documents use as a term's own name, ties to the lexicographically smallest.
 * Every member id stays listed in `ids`.
 */

import type { DigestTerm, MaterialDigest, TermTier } from "./contracts/material-digest.ts";

/** Soft hyphen, zero-width space / non-joiner / joiner, word joiner, BOM: PDF extraction noise inside words. */
const INVISIBLE: ReadonlySet<number> = new Set([0xad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]);
/**
 * The targeted foldings by code point: the Latin ligatures ff fi fl ffi ffl ſt st IJ ij spelled out; the apostrophe and
 * prime marks (left and right single quotation marks, modifier letter apostrophe, prime) read as ', the double and
 * triple prime as '' and '''.
 */
const FOLDS: ReadonlyMap<number, string> = new Map([
	[0xfb00, "ff"],
	[0xfb01, "fi"],
	[0xfb02, "fl"],
	[0xfb03, "ffi"],
	[0xfb04, "ffl"],
	[0xfb05, "st"],
	[0xfb06, "st"],
	[0x0132, "IJ"],
	[0x0133, "ij"],
	[0x2018, "'"],
	[0x2019, "'"],
	[0x02bc, "'"],
	[0x2032, "'"],
	[0x2033, "''"],
	[0x2034, "'''"],
]);

/**
 * A name in the form keys are made from (see the module comment): invisible characters removed, NFC, the targeted
 * foldings, lower case, whitespace collapsed, trimmed. Idempotent. Pure.
 */
export function normalizeName(name: string): string {
	let stripped = "";
	for (const ch of name) {
		const code = ch.codePointAt(0)!;
		if (!INVISIBLE.has(code)) stripped += ch;
	}
	let folded = "";
	for (const ch of stripped.normalize("NFC")) {
		const code = ch.codePointAt(0)!;
		// full-width ASCII forms (U+FF01 to U+FF5E) read as their ASCII character
		folded += FOLDS.get(code) ?? (code >= 0xff01 && code <= 0xff5e ? String.fromCodePoint(code - 0xfee0) : ch);
	}
	return folded
		.toLowerCase()
		.normalize("NFC")
		.replace(/\s+/g, " ")
		.trim();
}

/** The longest key kept as it is, in code points; a longer one is shortened and given a hash suffix. */
export const SLUG_MAX_CHARS = 96;
/** How much of a long key's start is kept before "~" and its 11-character hash, in code points. */
export const SLUG_PREFIX_CHARS = SLUG_MAX_CHARS - 12;

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
const LETTER = /[\p{L}\p{M}]/u;
const DASH = /\p{Pd}/u;
const SPACE = /\s/u;

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

/** The id key of a name (see the module comment). "" only for a name of whitespace and invisible characters. Pure. */
export function slugOf(name: string): string {
	const chars = [...normalizeName(name)];
	const tokens: string[] = [];
	let word = "";
	const flush = () => {
		if (word) tokens.push(word);
		word = "";
	};
	chars.forEach((ch, i) => {
		if (WORD_CHAR.test(ch)) {
			word += ch;
			return;
		}
		flush();
		if (SPACE.test(ch)) return;
		// a dash between two letters only separates words ("eigen-value"); anywhere else it is a symbol ("-1", "n-1", "C--")
		if (DASH.test(ch) && i > 0 && LETTER.test(chars[i - 1]!) && i + 1 < chars.length && LETTER.test(chars[i + 1]!)) return;
		tokens.push(`_${ch.codePointAt(0)!.toString(16)}`);
	});
	flush();
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
 * Which groups of names are one term. Groups have distinct own keys; each declares alias keys. THE RULE: P and Q are
 * LINKED when P declares Q's key as an alias, no other group declares that key, and Q declares no alias that P does not
 * also know (P's own key or one of P's aliases). A set of groups connected by links merges only when every two of its
 * members are linked directly and no group outside it declares any member's key as an alias; otherwise every group in
 * that connected set stays separate. So "ordinary least squares" (alias OLS) and "OLS" merge, while a shared symbol, a
 * flipped alias ("velocity" → v, "v" → voltage), a hub ("v" → velocity, voltage) or a chain merges nothing. The result
 * depends only on the sets of keys, never on input order. Returns a component label per group (the smallest group
 * index in its merged set). Pure.
 */
export function unifyByAlias(groups: readonly { key: string; aliasKeys: Iterable<string> }[]): number[] {
	const aliasSets = groups.map((g) => new Set([...g.aliasKeys].filter((a) => a !== "" && a !== g.key)));
	const ownIndex = new Map<string, number>();
	groups.forEach((g, i) => ownIndex.set(g.key, i));
	const claimants = new Map<string, number[]>();
	aliasSets.forEach((set, i) => {
		for (const a of set) {
			const list = claimants.get(a);
			if (list) list.push(i);
			else claimants.set(a, [i]);
		}
	});
	const links = groups.map(() => new Set<number>());
	for (const [alias, by] of claimants) {
		const q = ownIndex.get(alias);
		if (q === undefined || by.length !== 1) continue;
		const p = by[0]!;
		const known = (a: string) => a === groups[p]!.key || aliasSets[p]!.has(a);
		if (![...aliasSets[q]!].every(known)) continue;
		links[p]!.add(q);
		links[q]!.add(p);
	}

	const labels = groups.map((_, i) => i);
	const seen = new Set<number>();
	for (let start = 0; start < groups.length; start++) {
		if (seen.has(start) || links[start]!.size === 0) continue;
		const members: number[] = [];
		const queue = [start];
		seen.add(start);
		while (queue.length > 0) {
			const m = queue.pop()!;
			members.push(m);
			for (const next of links[m]!) {
				if (seen.has(next)) continue;
				seen.add(next);
				queue.push(next);
			}
		}
		const inSet = new Set(members);
		// links only join groups of the same connected set, so a full degree means every pair is linked directly
		const everyPairLinked = members.every((m) => links[m]!.size === members.length - 1);
		const claimedFromOutside = members.some((m) => (claimants.get(groups[m]!.key) ?? []).some((c) => !inSet.has(c)));
		if (!everyPairLinked || claimedFromOutside) continue;
		const label = Math.min(...members);
		for (const m of members) labels[m] = label;
	}
	return labels;
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
	/** The display form: the canonical key's term as the document with the smallest sourceHash writes it. */
	term: string;
	/** Every other spelling and alias, unique by key, in sourceHash order then document order (ambiguous aliases included). */
	aliases: string[];
	/**
	 * The explicit definition, chosen across documents by `pickDefinition` (a definition from a core mention first, then
	 * the earliest definition page, ties to the smaller sourceHash); null when no document defines it.
	 */
	definition: string | null;
	tier: TermTier;
	/** One per document (distinct sourceHash), sorted by sourceHash. */
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

/**
 * Merge several documents' digests into one class glossary. The result does not depend on the order of `digests`.
 * Throws on a term whose key is empty (a digest the indexer did not write: it refuses such names). Pure.
 */
export function mergeGlossary(digests: readonly Pick<MaterialDigest, "sourceHash" | "terms">[]): Glossary {
	interface Occurrence {
		order: number;
		sourceHash: string;
		term: DigestTerm;
		key: string;
		aliasKeys: string[];
	}
	// One digest per sourceHash (a repeated document counts once: its first copy), processed in sourceHash order.
	const bySourceHash = new Map<string, Pick<MaterialDigest, "sourceHash" | "terms">>();
	for (const digest of digests) if (!bySourceHash.has(digest.sourceHash)) bySourceHash.set(digest.sourceHash, digest);
	const occurrences: Occurrence[] = [];
	for (const sourceHash of [...bySourceHash.keys()].sort()) {
		for (const term of bySourceHash.get(sourceHash)!.terms) {
			const key = slugOf(term.term);
			if (key === "") throw new Error(`the digest ${sourceHash} has a term without a name (${JSON.stringify(term.term)})`);
			occurrences.push({ order: occurrences.length, sourceHash, term, key, aliasKeys: term.aliases.map(slugOf).filter((k) => k !== "" && k !== key) });
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
		const definitions: (DefinitionSource & { sourceHash: string })[] = [];
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
			if (defined) definitions.push({ sourceHash, definition: defined.definition, definitionPage: defined.definitionPage, tier: defined.tier });
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

		terms.set(id, {
			id,
			ids: [...ownKeys].map((k) => `t_${k}`).sort(),
			term: canonical.term.term.trim(),
			aliases,
			// `definitions` is in sourceHash order, so pickDefinition's "first given" tie-break is the smaller sourceHash
			definition: pickDefinition(definitions)?.definition ?? null,
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
		terms: Object.fromEntries([...terms].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
		names: Object.fromEntries(names),
		aliases: Object.fromEntries([...aliasOwners].map(([key, ids]) => [key, [...ids].sort()])),
	};
}

function own<T>(record: Record<string, T>, key: string): T | undefined {
	return key !== "" && Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * Every entry a term or alias (plain text, normalised as ids are) may name: the entry whose own name it is first, then
 * every entry that declares it as an alias, by id. Plain text is never read as an id (`findTermById`). [] when none.
 * Pure.
 */
export function findTermCandidates(glossary: Glossary, text: string): GlossaryEntry[] {
	const key = slugOf(text);
	const ids: string[] = [];
	const add = (id: string | undefined) => {
		if (id !== undefined && !ids.includes(id) && Object.hasOwn(glossary.terms, id)) ids.push(id);
	};
	add(own(glossary.names, key));
	for (const id of own(glossary.aliases, key) ?? []) add(id);
	return ids.map((id) => glossary.terms[id]!);
}

/**
 * The one entry a term or alias (plain text) names: undefined when none, and undefined whenever more than one entry
 * may be meant (an alias several entries declare, or one entry's own name that others declare as an alias): use
 * findTermCandidates then. Plain text is never read as an id. Pure.
 */
export function findTerm(glossary: Glossary, text: string): GlossaryEntry | undefined {
	const candidates = findTermCandidates(glossary, text);
	return candidates.length === 1 ? candidates[0] : undefined;
}

/** The entry a term id names (its canonical id or any id merged into it, exactly as stored); undefined when none. Pure. */
export function findTermById(glossary: Glossary, id: string): GlossaryEntry | undefined {
	if (!id.startsWith("t_")) return undefined;
	const canonical = own(glossary.names, id.slice(2));
	return canonical !== undefined && Object.hasOwn(glossary.terms, canonical) ? glossary.terms[canonical] : undefined;
}
