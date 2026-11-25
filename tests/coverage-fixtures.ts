/**
 * Shared fixtures for the vocabulary coverage tests (WP5): a class glossary built by the REAL merge (core/glossary.ts
 * mergeGlossary) from synthetic digests, with citations resolved to materials like server/material-indexing.ts does.
 */

import type { DigestTerm, TermTier } from "../src/core/contracts/material-digest.ts";
import type { CoverageGlossary } from "../src/core/coverage-items.ts";
import { mergeGlossary, normalizeName, termId } from "../src/core/glossary.ts";

export interface TermSpec {
	tier?: TermTier;
	def?: string | null;
	page?: number;
	aliases?: string[];
	symbols?: string[];
	/** Extra occurrences (a second sense defined on another page). */
	more?: Array<{ page: number; def?: string | null; tier?: TermTier }>;
}

export function term(name: string, spec: TermSpec = {}): DigestTerm {
	const tier = spec.tier ?? "core";
	const page = spec.page ?? 1;
	const def = spec.def === undefined ? `the meaning of ${name}` : spec.def;
	const occurrences = [
		{ part: 0, page, tier, definition: def, definitionPage: def === null ? null : page },
		...(spec.more ?? []).map((o) => ({ part: 0, page: o.page, tier: o.tier ?? tier, definition: o.def ?? null, definitionPage: o.def ? o.page : null })),
	];
	return {
		id: termId(name),
		term: normalizeName(name),
		aliases: [...(spec.aliases ?? [])].sort(),
		symbols: [...(spec.symbols ?? [])].sort(),
		page,
		tier,
		definition: def,
		definitionPage: def === null ? null : page,
		definitionTier: def === null ? null : tier,
		occurrences,
		occurrenceCount: occurrences.length,
	};
}

export interface DocSpec {
	material: { id: string; name: string };
	terms: DigestTerm[];
	hash?: string;
}

/** A class glossary from documents, as courseGlossary would return it. */
export function glossaryOf(docs: DocSpec[], incomplete: Array<{ name: string; reason?: string }> = []): CoverageGlossary {
	const sources = docs.map((d, i) => ({ sourceHash: d.hash ?? `hash${i}`, indexerVersion: 1, batches: [], terms: d.terms }));
	const merged = mergeGlossary(sources);
	const materialOf = new Map(docs.map((d, i) => [d.hash ?? `hash${i}`, d.material]));
	const terms = Object.fromEntries(
		Object.entries(merged.terms).map(([id, e]) => [id, { ...e, citations: e.citations.map((c) => ({ ...c, materials: [materialOf.get(c.sourceHash)!] })) }]),
	);
	return { ...merged, terms, indexed: docs.map((d, i) => ({ ...d.material, sourceHash: d.hash ?? `hash${i}` })), incomplete };
}
