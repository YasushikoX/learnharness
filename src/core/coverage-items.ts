/**
 * Vocabulary coverage: the items (WP5, 2026-11-25; spec: docs/courses.md "Vocabulary coverage"). PURE, browser-safe.
 *
 * The owner: "it also skips over some vocabulary and some things and you have to ask again". Every CORE entry of the
 * class glossary (core/glossary.ts, merged from the class's indexed PDFs) must, when the class map is approved, be
 * ASSIGNED to one or more skills or EXCLUDED with a reason. That mapping is `CourseRecord.coverage`: a list of items
 * (one entry, or one cited sense of an entry) plus link groups (several names confirmed as one concept).
 *
 * Term identity stays the exact spelling (PLAN.md "Term identity"): an item names an entry by its exact id; nothing here
 * merges two entries. Suggested duplicates become one concept only by an explicit link, which the planner proposes and
 * the student can make or undo ("same thing").
 *
 * Everything about the glossary is READ-TIME: the mapping is stored, but whether an item's entry still exists, whether
 * a core entry has no item, and which skills are still the class's are derived on every read (`resolveCoverage`), so a
 * re-index, a new PDF or a deleted one reconciles without any write and without any model call:
 *   - an item whose entry (or sense) is no longer in the material is FLAGGED and counts toward nothing until the student
 *     removes or remaps it (it comes back by itself if the entry does, for example after a re-index finishes);
 *   - a core entry with no item is UNASSIGNED ("N new terms are not assigned to a skill");
 *   - an item whose skills all left the class map is UNASSIGNED too.
 */

import type { CourseCoverage, CoverageDropped, CoverageEntryView, CoverageItem, CoverageLinkEdit, CoverageSense, CoverageSuggestions, DraftCoverage } from "./contracts/course.ts";
import type { TermTier } from "./contracts/material-digest.ts";
import { byCodeUnit, normalizeName, type GlossaryCitation, type GlossaryEntry, type SuggestedDuplicateGroup } from "./glossary.ts";

// ─── what the coverage code reads of a glossary ─────────────────────────────

/** A glossary entry whose citations may name the course materials they resolve to (server CourseGlossaryEntry does). */
export interface CoverageGlossaryEntry extends GlossaryEntry {
	citations: Array<GlossaryCitation & { materials?: ReadonlyArray<{ id: string; name: string }> }>;
}

/** What coverage reads of a class glossary: server/material-indexing.ts CourseGlossary satisfies it. */
export interface CoverageGlossary {
	terms: Record<string, CoverageGlossaryEntry>;
	lookup: Record<string, string[]>;
	suggestedDuplicates: SuggestedDuplicateGroup[];
	/** The merged materials, in the course's order. */
	indexed?: ReadonlyArray<{ id: string; name: string; sourceHash: string }>;
	/** Materials missing from the glossary or only partly in it. */
	incomplete?: ReadonlyArray<{ name: string; reason?: string }>;
}

/** The mapping part of a coverage record or draft proposal. */
export interface CoverageMapping {
	items: CoverageItem[];
	links: string[][];
	/** A mapping pass's proposals awaiting the student (never applied by the pass). */
	suggested?: CoverageSuggestions;
	/** Earlier decisions that could not be kept, with why (the page shows them after approval). */
	displaced?: CoverageDropped[];
}

/** Does the glossary have anything coverage is about (a core entry)? Coverage behaviour exists only then. */
export function hasCoreEntries(glossary: CoverageGlossary | null | undefined): boolean {
	return !!glossary && Object.values(glossary.terms).some((e) => e.tier === "core");
}

// ─── keys ───────────────────────────────────────────────────────────────────

/** An item's key: the entry id, or `<entryId>#<materialId>:<page>` for a sense. "#" never appears in an entry id
 *  (glossary.ts encodeName writes ASCII punctuation as "~hex~"). */
export function itemKey(item: Pick<CoverageItem, "entryId" | "sense">): string {
	return item.sense ? `${item.entryId}#${item.sense.materialId}:${item.sense.page}` : item.entryId;
}

/** A key read back: the entry id and, for a sense key, the sense. Null for a malformed sense key. */
export function parseItemKey(key: string): { entryId: string; sense?: CoverageSense } | null {
	const at = key.indexOf("#");
	if (at < 0) return key.trim() === "" ? null : { entryId: key };
	const m = /^([^#:]+):(\d{1,6})$/.exec(key.slice(at + 1));
	if (!m || at === 0) return null;
	return { entryId: key.slice(0, at), sense: { materialId: m[1]!, page: Number(m[2]) } };
}

// ─── reading an entry ───────────────────────────────────────────────────────

const materialsOf = (entry: CoverageGlossaryEntry, sourceHash: string | null): ReadonlyArray<{ id: string; name: string }> =>
	sourceHash === null ? [] : (entry.citations.find((c) => c.sourceHash === sourceHash)?.materials ?? []);

/** The occurrence that defines a sense: in the sense's material, defined on its page (else used on its page). */
function senseOccurrence(entry: CoverageGlossaryEntry, sense: CoverageSense) {
	const hashes = new Set(entry.citations.filter((c) => c.materials?.some((m) => m.id === sense.materialId)).map((c) => c.sourceHash));
	if (hashes.size === 0) return undefined;
	const inMaterial = entry.occurrences.filter((o) => hashes.has(o.sourceHash));
	return inMaterial.find((o) => o.definition !== null && o.definitionPage === sense.page) ?? inMaterial.find((o) => o.page === sense.page);
}

/** An entry (or one sense of it) as the screens and the tutor show it: the material's definition with its page. */
export function entryView(entry: CoverageGlossaryEntry, sense?: CoverageSense): CoverageEntryView {
	const key = itemKey({ entryId: entry.id, sense });
	if (sense) {
		const o = senseOccurrence(entry, sense);
		const material = entry.citations.flatMap((c) => c.materials ?? []).find((m) => m.id === sense.materialId)?.name ?? null;
		return { key, name: entry.term, tier: o?.tier ?? entry.tier, definition: o?.definition ?? null, page: o?.definitionPage ?? o?.page ?? sense.page, material };
	}
	if (entry.definition !== null) {
		return { key, name: entry.term, tier: entry.tier, definition: entry.definition, page: entry.definitionPage, material: materialsOf(entry, entry.definitionSource)[0]?.name ?? null };
	}
	const first = entry.citations[0];
	return { key, name: entry.term, tier: entry.tier, definition: null, page: first?.page ?? null, material: first?.materials?.[0]?.name ?? null };
}

/** Is this key a real entry, or a real sense of one, in the glossary? */
export function keyExists(glossary: CoverageGlossary | null | undefined, key: string): boolean {
	const parsed = parseItemKey(key);
	if (!glossary || !parsed || !Object.hasOwn(glossary.terms, parsed.entryId)) return false;
	return !parsed.sense || senseOccurrence(glossary.terms[parsed.entryId]!, parsed.sense) !== undefined;
}

// ─── links ──────────────────────────────────────────────────────────────────

/** Link groups cleaned: trimmed keys, overlapping groups joined, groups of fewer than two keys dropped, sorted. */
export function normalizeLinks(groups: ReadonlyArray<ReadonlyArray<string>>, keep: (key: string) => boolean = () => true): string[][] {
	const parent = new Map<string, string>();
	const root = (k: string): string => {
		let at = k;
		while (parent.get(at) !== at) at = parent.get(at)!;
		return at;
	};
	for (const group of groups) {
		const keys = [...new Set(group.map((k) => (typeof k === "string" ? k.trim() : "")).filter((k) => k !== "" && keep(k)))];
		for (const k of keys) if (!parent.has(k)) parent.set(k, k);
		for (const k of keys.slice(1)) {
			const [a, b] = [root(keys[0]!), root(k)];
			if (a !== b) parent.set(byCodeUnit(a, b) < 0 ? b : a, byCodeUnit(a, b) < 0 ? a : b);
		}
	}
	const out = new Map<string, string[]>();
	for (const k of parent.keys()) out.set(root(k), [...(out.get(root(k)) ?? []), k]);
	return [...out.values()].filter((g) => g.length >= 2).map((g) => g.sort(byCodeUnit)).sort((a, b) => byCodeUnit(a.join("\n"), b.join("\n")));
}

/** key → its link group (itself included); a key in no group maps to [key]. */
export function linkGroupsOf(links: ReadonlyArray<ReadonlyArray<string>>): (key: string) => string[] {
	const map = new Map<string, string[]>();
	for (const g of links) for (const k of g) map.set(k, [...g]);
	return (key) => map.get(key) ?? [key];
}

// ─── reconciliation (read-time) ─────────────────────────────────────────────

export type ItemStatus = "assigned" | "excluded" | "flagged" | "unassigned";

export interface ResolvedItem {
	key: string;
	item: CoverageItem;
	/** The entry now; undefined when it is no longer in the material (flagged). */
	entry: CoverageGlossaryEntry | undefined;
	status: ItemStatus;
	/** The item's skills that are still the class's (assigned items only). */
	skills: string[];
	tier: TermTier;
	view: CoverageEntryView;
}

export interface ResolvedCoverage {
	items: ResolvedItem[];
	byKey: Map<string, ResolvedItem>;
	/** A key's live link group (itself included; flagged members left out). */
	group: (key: string) => string[];
	/** Core entries with no assigned or excluded item: never mapped, new since approval, or whose skills all left. */
	unassigned: CoverageGlossaryEntry[];
}

/**
 * Read a mapping against the glossary as it is now and the class's skills (`skills` null: every skill counts, as in a
 * draft whose keys are checked elsewhere). Never writes; see the module comment for the rules.
 */
export function resolveCoverage(mapping: CoverageMapping, glossary: CoverageGlossary | null | undefined, skills: ReadonlySet<string> | null): ResolvedCoverage {
	const items: ResolvedItem[] = [];
	const byKey = new Map<string, ResolvedItem>();
	for (const item of mapping.items) {
		const key = itemKey(item);
		if (byKey.has(key)) continue;
		const live = keyExists(glossary, key);
		const entry = live ? glossary!.terms[item.entryId] : undefined;
		const liveSkills = (item.skills ?? []).filter((s) => skills === null || skills.has(s));
		const status: ItemStatus = !entry ? "flagged" : liveSkills.length > 0 ? "assigned" : item.excluded !== undefined ? "excluded" : "unassigned";
		const view = entry ? entryView(entry, item.sense) : { key, name: item.name, tier: "supporting" as const, definition: null, page: item.sense?.page ?? null, material: null };
		const resolved: ResolvedItem = { key, item, entry, status, skills: status === "assigned" ? liveSkills : [], tier: view.tier, view };
		items.push(resolved);
		byKey.set(key, resolved);
	}
	const groupOf = linkGroupsOf(mapping.links);
	const group = (key: string) => groupOf(key).filter((k) => k === key || (byKey.get(k)?.status ?? "assigned") !== "flagged");
	const covered = new Set(items.filter((i) => i.status === "assigned" || i.status === "excluded").map((i) => i.item.entryId));
	const unassigned = glossary ? Object.values(glossary.terms).filter((e) => e.tier === "core" && !covered.has(e.id)) : [];
	return { items, byKey, group, unassigned };
}

// ─── keeping decisions (re-approval, removed skills) ───────────────────────

const decided = (i: CoverageItem) => (i.skills ?? []).length > 0 || i.excluded !== undefined;

/**
 * A new proposal with the class's EARLIER approved decisions carried in (re-drafting, re-approving): every earlier item
 * whose entry still exists is kept as it was, its skills translated to the draft skills that reuse them; a skill the new
 * draft does not carry is removed from the item (an item left with no skill is unassigned, for the student to assign
 * again) and reported in `displaced`; an exclusion is kept; a link is kept while two or more of its names exist. The
 * proposal fills in only the keys the earlier mapping had no item for, and its links among those; a proposed link that
 * touches an earlier item becomes a suggestion. What could not be kept is listed in `displaced`. Pure.
 */
export function carryForward(
	earlier: CoverageMapping | null | undefined,
	proposal: CoverageMapping | null | undefined,
	draftSkills: ReadonlyArray<{ key: string; reuse?: string }>,
	glossary: CoverageGlossary | null | undefined,
): CoverageMapping & { displaced: CoverageDropped[] } {
	const dropped: CoverageDropped[] = [...(proposal?.displaced ?? [])];
	const base = proposal ?? { items: [], links: [] };
	if (!earlier) return { items: base.items.map((i) => ({ ...i })), links: base.links.map((g) => [...g]), ...(base.suggested ? { suggested: base.suggested } : {}), displaced: dropped };
	const keyOfSkill = new Map(draftSkills.filter((s) => s.reuse).map((s) => [s.reuse!, s.key]));
	const items: CoverageItem[] = [];
	const kept = new Set<string>();
	for (const item of earlier.items) {
		const key = itemKey(item);
		if (kept.has(key)) continue;
		if (!keyExists(glossary, key)) {
			dropped.push({ key, name: item.name, reason: "no longer in the material" });
			continue;
		}
		kept.add(key);
		const { skills: earlierSkills, ...rest } = item;
		const skills = (earlierSkills ?? []).map((s) => keyOfSkill.get(s)).filter((s): s is string => s !== undefined);
		if ((earlierSkills ?? []).length > skills.length) dropped.push({ key, name: item.name, reason: skills.length > 0 ? "one of its skills is not in the new class map" : "its skill is not in the new class map; assign it again" });
		items.push(skills.length > 0 ? { ...rest, skills: [...new Set(skills)] } : rest);
	}
	for (const item of base.items) if (!kept.has(itemKey(item))) items.push({ ...item });
	const exists = (k: string) => items.some((i) => itemKey(i) === k) || keyExists(glossary, k);
	const links: string[][] = [];
	for (const group of earlier.links) {
		const live = group.filter(exists);
		if (live.length < group.length) {
			for (const k of group.filter((k) => !exists(k))) dropped.push({ key: k, name: glossary?.terms[parseItemKey(k)?.entryId ?? ""]?.term ?? k, reason: "a linked name no longer in the material" });
		}
		if (live.length >= 2) links.push(live);
	}
	const suggestedLinks = [...(base.suggested?.links ?? [])];
	for (const group of base.links) {
		if (group.some((k) => kept.has(k))) suggestedLinks.push([...group]);
		else links.push([...group]);
	}
	const suggested = suggestionsOf({ excluded: base.suggested?.excluded ?? [], links: suggestedLinks }, links);
	return { items, links: normalizeLinks(links), ...(suggested ? { suggested } : {}), displaced: dropped };
}

/** Suggestions cleaned: duplicate and already-made links dropped; undefined when nothing is left. */
export function suggestionsOf(s: CoverageSuggestions, links: ReadonlyArray<ReadonlyArray<string>>): CoverageSuggestions | undefined {
	const groupOf = linkGroupsOf(links);
	const excluded = [...new Map(s.excluded.map((x) => [x.key, x])).values()];
	const seen = new Set<string>();
	const outLinks: string[][] = [];
	for (const g of normalizeLinks(s.links)) {
		if (g.every((k) => groupOf(g[0]!).includes(k))) continue; // already one concept
		const id = g.join("\n");
		if (seen.has(id)) continue;
		seen.add(id);
		outLinks.push(g);
	}
	return excluded.length > 0 || outLinks.length > 0 ? { excluded, links: outLinks } : undefined;
}

/**
 * A draft's link decisions (DraftCoverage.linkEdits) replayed, in order, on a mapping (WP5 review 3: after approval
 * carries the approved map again): a link joins its keys that still exist (an item of the mapping or a glossary entry),
 * an unlink takes its key out of every group; suggestions a link made are dropped. Pure.
 */
export function replayLinkEdits(mapping: CoverageMapping, edits: readonly CoverageLinkEdit[] | undefined, glossary: CoverageGlossary | null | undefined): CoverageMapping {
	if (!edits || edits.length === 0) return mapping;
	const has = (k: string) => mapping.items.some((i) => itemKey(i) === k) || keyExists(glossary, k);
	let links = mapping.links.map((g) => [...g]);
	for (const e of edits) {
		if ("link" in e) {
			const keys = [...new Set(e.link)].filter(has);
			if (keys.length >= 2) links.push(keys);
		} else links = links.map((g) => g.filter((k) => k !== e.unlink));
	}
	const normalized = normalizeLinks(links);
	const suggested = mapping.suggested ? suggestionsOf(mapping.suggested, normalized) : undefined;
	const { suggested: _old, ...rest } = mapping;
	return { ...rest, links: normalized, ...(suggested ? { suggested } : {}) };
}

/**
 * A mapping with every skill reference checked against the class's skills now: a skill that is no longer the class's is
 * removed from its item (an item left with none becomes unassigned) and reported. Run on every approval, so no stale
 * skill id stays in a stored mapping. Pure.
 */
export function pruneStaleSkills(mapping: CoverageMapping, skills: ReadonlySet<string>): { mapping: CoverageMapping; displaced: CoverageDropped[] } {
	const dropped: CoverageDropped[] = [];
	const items = mapping.items.map((item) => {
		const live = (item.skills ?? []).filter((s) => skills.has(s));
		if (live.length === (item.skills ?? []).length) return item;
		dropped.push({ key: itemKey(item), name: item.name, reason: live.length > 0 ? "one of its skills left the class map" : "its skill left the class map; assign it again" });
		const { skills: _drop, ...rest } = item;
		return live.length > 0 ? { ...rest, skills: live } : rest;
	});
	return { mapping: { ...mapping, items }, displaced: dropped };
}

// ─── approval ───────────────────────────────────────────────────────────────

/**
 * Approve a proposal (a draft's, with the class's earlier decisions already carried in: carryForward): its items with
 * draft keys turned into skill ids (`idOf`), checked against the glossary NOW. A missing proposal is an EMPTY mapping.
 * Core entries with no assigned or excluded item refuse approval (returned as `unassigned`), unless `leaveReason` is
 * given (the student's explicit "leave N terms unassigned"): then each becomes an excluded item with that reason. A
 * draft key that resolves to no skill is removed and reported in `displaced`.
 */
export function approveCoverage(
	draft: CoverageMapping | null | undefined,
	idOf: (draftKey: string) => string | undefined,
	glossary: CoverageGlossary | null | undefined,
	leaveReason: string | null,
	now: string,
): { ok: true; coverage: CourseCoverage } | { ok: false; unassigned: CoverageGlossaryEntry[] } {
	const proposal = draft ?? { items: [], links: [] };
	const dropped: CoverageDropped[] = [...(proposal.displaced ?? [])];
	const items: CoverageItem[] = proposal.items.map((item) => {
		const skills = [...new Set((item.skills ?? []).map(idOf).filter((s): s is string => s !== undefined))];
		if ((item.skills ?? []).length > 0 && skills.length < new Set(item.skills).size) dropped.push({ key: itemKey(item), name: item.name, reason: "its skill is not in the approved map" });
		const { skills: _drop, ...rest } = item;
		return skills.length > 0 ? { ...rest, skills, excluded: undefined } : rest;
	}).map((i) => Object.fromEntries(Object.entries(i).filter(([, v]) => v !== undefined)) as unknown as CoverageItem);
	const links = proposal.links.map((g) => [...g]);
	const resolved = resolveCoverage({ items, links }, glossary, null);
	let out = items;
	if (resolved.unassigned.length > 0) {
		if (leaveReason === null) return { ok: false, unassigned: resolved.unassigned };
		const left = new Set(resolved.unassigned.map((e) => e.id));
		// an item whose skills all fell away is replaced, not doubled
		out = items.filter((i) => !(left.has(i.entryId) && !i.sense && !decided(i)));
		for (const e of resolved.unassigned) out.push({ entryId: e.id, name: e.term, excluded: leaveReason, leftAtApproval: true });
	}
	const suggested = proposal.suggested ? suggestionsOf(proposal.suggested, links) : undefined;
	return { ok: true, coverage: { updatedAt: now, items: out, links, ...(suggested ? { suggested } : {}), ...(dropped.length > 0 ? { displaced: dropped } : {}) } };
}

/**
 * A "Map the class's terms" pass merged into a mapping it must not overrule: it may only ADD assignments, for keys that
 * have no decision now (no item, or an item with no live skill and no exclusion), and only to the given skills. Its
 * proposed exclusions and links change decisions, so they become `suggested` (the student accepts them one by one);
 * no existing item, exclusion or link is changed. Pure.
 */
export function mergeMappingPass(existing: CoverageMapping, proposal: CoverageMapping, skills: ReadonlySet<string>): CoverageMapping {
	const items = existing.items.map((i) => ({ ...i, ...(i.skills ? { skills: [...i.skills] } : {}) }));
	const byKey = new Map(items.map((i) => [itemKey(i), i]));
	const undecided = (i: CoverageItem | undefined) => !i || (!(i.skills ?? []).some((s) => skills.has(s)) && i.excluded === undefined);
	const excluded = [...(existing.suggested?.excluded ?? [])];
	for (const p of proposal.items) {
		const key = itemKey(p);
		const current = byKey.get(key);
		if (!undecided(current)) continue;
		const live = (p.skills ?? []).filter((s) => skills.has(s));
		if (live.length > 0) {
			if (current) current.skills = [...new Set(live)];
			else {
				const { excluded: _x, leftAtApproval: _l, ...rest } = p;
				const added: CoverageItem = { ...rest, skills: [...new Set(live)] };
				items.push(added);
				byKey.set(key, added);
			}
		} else if (p.excluded !== undefined) {
			excluded.push({ key, reason: p.excluded });
		}
	}
	const suggested = suggestionsOf({ excluded, links: [...(existing.suggested?.links ?? []), ...proposal.links] }, existing.links);
	const { suggested: _s, ...rest } = existing;
	return { ...rest, items, links: existing.links.map((g) => [...g]), ...(suggested ? { suggested } : {}) };
}

// ─── the planner's input (bounded) ──────────────────────────────────────────

/** The planner's WHOLE glossary block (entries, duplicate pairs, materials, incomplete materials) stays within this many
 *  characters (about 15k tokens). */
export const PLANNER_GLOSSARY_BUDGET = 60_000;
/** Of the entries' share, entries are shown with their definition until this many characters; the rest by name only. */
export const PLANNER_GLOSSARY_FULL_BUDGET = 24_000;
/** A definition shown to the planner is cut at this many characters. */
export const PLANNER_DEFINITION_CHARS = 200;
/** The most suggested pairs the planner is shown, and the most characters they take. */
export const PLANNER_DUPLICATE_PAIRS = 150;
export const PLANNER_PAIRS_CHARS = 9_000;
/** The most characters the list of materials, and the list of incomplete materials, each take. */
export const PLANNER_MATERIALS_CHARS = 3_000;
export const PLANNER_INCOMPLETE_CHARS = 2_000;

const cut = (text: string, max: number) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

/** Items joined with "; " until `max` characters, then "+N more". */
function boundedList(items: readonly string[], max: number): string {
	const out: string[] = [];
	let used = 0;
	for (const item of items) {
		if (used + item.length + 2 > max) break;
		out.push(item);
		used += item.length + 2;
	}
	return out.join("; ") + (items.length > out.length ? `${out.length > 0 ? "; " : ""}+${items.length - out.length} more` : "");
}

/** Every entry in teaching order: the material it first appears in (the course's order), then the page, then id. */
function entriesInOrder(glossary: CoverageGlossary): CoverageGlossaryEntry[] {
	const order = new Map((glossary.indexed ?? []).map((m, i) => [m.sourceHash, i]));
	const rank = (e: CoverageGlossaryEntry) => {
		let best: [number, number] = [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
		for (const c of e.citations) {
			const r: [number, number] = [order.get(c.sourceHash) ?? Number.MAX_SAFE_INTEGER - 1, c.page];
			if (r[0] < best[0] || (r[0] === best[0] && r[1] < best[1])) best = r;
		}
		return best;
	};
	return Object.values(glossary.terms)
		.map((e) => ({ e, r: rank(e) }))
		.sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || byCodeUnit(a.e.id, b.e.id))
		.map((x) => x.e);
}

/** The core entries in teaching order (see entriesInOrder). */
export function coreEntriesInOrder(glossary: CoverageGlossary): CoverageGlossaryEntry[] {
	return entriesInOrder(glossary).filter((e) => e.tier === "core");
}

/** Each item key's place in the class's teaching order (smaller first): its entry's place, then a sense's page. Pure. */
export function teachingOrder(glossary: CoverageGlossary | null | undefined): (key: string) => number {
	const place = new Map((glossary ? entriesInOrder(glossary) : []).map((e, i) => [e.id, i]));
	return (key) => {
		const parsed = parseItemKey(key);
		const at = parsed ? place.get(parsed.entryId) : undefined;
		return (at ?? place.size) * 100_000 + Math.min(Math.max(0, parsed?.sense?.page ?? 0), 99_999);
	};
}

/** Where an entry is: "p. 3, 7 in Lecture 2.pdf [mat_1]; p. 1 in Notes.pdf [mat_2]", bounded. */
function placesOf(entry: CoverageGlossaryEntry, withIds: boolean): string {
	const parts: string[] = [];
	for (const c of entry.citations.slice(0, 3)) {
		const pages = [...new Set(entry.occurrences.filter((o) => o.sourceHash === c.sourceHash).map((o) => o.page))].slice(0, 6);
		const m = c.materials?.[0];
		parts.push(`p. ${(pages.length > 0 ? pages : [c.page]).join(", ")}${m ? ` in ${m.name}${withIds ? ` [${m.id}]` : ""}` : ""}`);
	}
	if (entry.citations.length > 3) parts.push(`+${entry.citations.length - 3} more documents`);
	return parts.join("; ");
}

/**
 * The class glossary as the planner reads it, within ONE character budget for the whole block. What is cut first: the
 * list of materials and the list of incomplete materials are each held to a small share (PLANNER_MATERIALS_CHARS,
 * PLANNER_INCOMPLETE_CHARS; the rest counted as "+N more"), and the suggested duplicate pairs to PLANNER_DUPLICATE_PAIRS
 * and PLANNER_PAIRS_CHARS; the core entries get everything else: with their id, definition from the material (or "no
 * definition") and pages until PLANNER_GLOSSARY_FULL_BUDGET, then by id, name and pages only, and any further entries
 * are counted, not listed (they show as unassigned at approval). Null when the glossary has no core entry. Pure.
 */
export function plannerGlossaryBlock(glossary: CoverageGlossary | null | undefined, budget = PLANNER_GLOSSARY_BUDGET, fullBudget = PLANNER_GLOSSARY_FULL_BUDGET): { text: string; shown: DraftCoverage["shown"] } | null {
	if (!glossary || !hasCoreEntries(glossary)) return null;
	const core = coreEntriesInOrder(glossary);
	const nameOf = (id: string) => glossary.terms[id]?.term ?? id;
	// the small shares first, so the entries' share is what is left
	const materials = "Materials: " + boundedList((glossary.indexed ?? []).map((m) => `${m.name} = ${m.id}`), PLANNER_MATERIALS_CHARS);
	const allPairs = glossary.suggestedDuplicates.flatMap((g) => g.pairs ?? []).filter((p) => p.ids.some((id) => glossary.terms[id]?.tier === "core"));
	const pairLines: string[] = [];
	let pairChars = 0;
	for (const p of allPairs.slice(0, PLANNER_DUPLICATE_PAIRS)) {
		const line = `- ${p.ids[0]} (${nameOf(p.ids[0])}) ~ ${p.ids[1]} (${nameOf(p.ids[1])}): ${p.reasons.map((r) => r.replace("_", " ")).join(", ")}`;
		if (pairChars + line.length + 1 > PLANNER_PAIRS_CHARS) break;
		pairLines.push(line);
		pairChars += line.length + 1;
	}
	const pairBlock =
		allPairs.length > 0
			? [
					"",
					"Suggested duplicates, as pairs (the names look alike; they may be one concept or two different ones — you decide; a pair is never merged unless you link it):",
					...pairLines,
					...(allPairs.length > pairLines.length ? [`(${allPairs.length - pairLines.length} more pairs not listed)`] : []),
				]
			: [];
	const incomplete = glossary.incomplete ?? [];
	const incompleteBlock =
		incomplete.length > 0
			? ["", `Materials whose index is incomplete (their terms may be missing here): ${boundedList(incomplete.map((m) => `${m.name}${m.reason ? ` (${m.reason.replace("_", " ")})` : ""}`), PLANNER_INCOMPLETE_CHARS)}`]
			: [];
	const headLine = (full: number, names: number, omitted: number) =>
		`The class's own vocabulary, from its indexed material: ${core.length} CORE entries (things the material treats as what a student must know).` +
		(names > 0 || omitted > 0 ? ` ${full} are shown with their definition, ${names} by name only${omitted > 0 ? `, and ${omitted} are not listed (the input is bounded; they will show as unassigned at approval)` : ""}.` : "");
	const fixed = ["<class_glossary>", headLine(core.length, core.length, core.length), materials, "", "Core entries (id :: name — definition — where):", ...pairBlock, ...incompleteBlock, `(${core.length} more core entries not listed)`, "</class_glossary>"];
	const entryBudget = Math.max(0, budget - fixed.join("\n").length - 1);
	const lines: string[] = [];
	let used = 0;
	let full = 0;
	let names = 0;
	for (const e of core) {
		const aliases = e.aliases.length > 0 ? ` · also called: ${cut(e.aliases.slice(0, 5).join(", "), 120)}` : "";
		const definition = e.definition !== null ? `"${cut(e.definition, PLANNER_DEFINITION_CHARS)}" (p. ${e.definitionPage})` : "no definition in the material";
		const fullLine = `- ${e.id} :: ${e.term} — ${definition}${aliases} — ${placesOf(e, true)}`;
		if (used + fullLine.length + 1 <= Math.min(fullBudget, entryBudget) && names === 0) {
			lines.push(fullLine);
			used += fullLine.length + 1;
			full++;
			continue;
		}
		const short = `- ${e.id} :: ${e.term} (${placesOf(e, false)})`;
		if (used + short.length + 1 > entryBudget) break;
		lines.push(short);
		used += short.length + 1;
		names++;
	}
	const omitted = core.length - full - names;
	const parts = ["<class_glossary>", headLine(full, names, omitted), materials, "", "Core entries (id :: name — definition — where):", ...lines];
	if (omitted > 0) parts.push(`(${omitted} more core entries not listed)`);
	parts.push(...pairBlock, ...incompleteBlock, "</class_glossary>");
	return { text: parts.join("\n"), shown: { full, names, omitted } };
}

// ─── the planner's output, validated ────────────────────────────────────────

/** What the planner returns about the vocabulary (beside its skills). */
export interface PlannerTermOutput {
	/** Per draft skill key: the entry ids (or sense keys) it covers. */
	skills: ReadonlyArray<{ key: string; terms?: readonly string[] }>;
	excludeTerms?: ReadonlyArray<{ id: string; reason: string }>;
	linkTerms?: ReadonlyArray<ReadonlyArray<string>>;
}

/**
 * The planner's mapping checked against the REAL glossary: every id it names must be an entry (or a real sense of one);
 * unknown ids are dropped and listed in `dropped`, never invented. An entry may be under several skills; an entry both
 * assigned and excluded is assigned. Core entries in neither list stay without an item: unassigned at approval. Pure.
 */
export function draftCoverageFrom(out: PlannerTermOutput, glossary: CoverageGlossary, shown: DraftCoverage["shown"]): DraftCoverage {
	const dropped = new Set<string>();
	const valid = (raw: string): string | null => {
		const key = typeof raw === "string" ? raw.trim() : "";
		if (key === "") return null;
		if (keyExists(glossary, key)) return key;
		dropped.add(key);
		return null;
	};
	const byKey = new Map<string, CoverageItem>();
	const itemFor = (key: string): CoverageItem => {
		let item = byKey.get(key);
		if (!item) {
			const parsed = parseItemKey(key)!;
			item = { entryId: parsed.entryId, ...(parsed.sense ? { sense: parsed.sense } : {}), name: glossary.terms[parsed.entryId]!.term };
			byKey.set(key, item);
		}
		return item;
	};
	for (const s of out.skills) {
		for (const raw of s.terms ?? []) {
			const key = valid(raw);
			if (!key) continue;
			const item = itemFor(key);
			item.skills = [...new Set([...(item.skills ?? []), s.key])];
		}
	}
	for (const x of out.excludeTerms ?? []) {
		const key = valid(x.id);
		if (!key) continue;
		const item = itemFor(key);
		if ((item.skills ?? []).length === 0) item.excluded = cut(normalizeName(x.reason ?? ""), 200) || "excluded by the planner";
	}
	const links = normalizeLinks((out.linkTerms ?? []).map((g) => g.map((k) => valid(k) ?? "")));
	// a linked name the planner did not map itself takes its group's mapping (one concept, one assignment)
	for (const group of links) {
		const model = group.map((k) => byKey.get(k)).find((i) => i && ((i.skills ?? []).length > 0 || i.excluded !== undefined));
		if (!model) continue;
		for (const k of group) {
			if (byKey.has(k)) continue;
			const item = itemFor(k);
			if (model.skills) item.skills = [...model.skills];
			else item.excluded = model.excluded;
		}
	}
	return { items: [...byKey.values()], links, dropped: [...dropped].sort(byCodeUnit), incomplete: (glossary.incomplete ?? []).map((m) => m.name), shown };
}

// ─── the student's edits ────────────────────────────────────────────────────

export type CoverageEdit =
	| { action: "assign"; key: string; skill: string }
	| { action: "unassign"; key: string; skill: string }
	| { action: "exclude"; key: string; reason: string }
	| { action: "link"; keys: string[] }
	| { action: "unlink"; key: string }
	| { action: "remove"; key: string }
	| { action: "remap"; key: string; to: string }
	/** Turn down a mapping pass's suggestion: an exclusion (`key`) or a link (`keys`). */
	| { action: "dismiss"; key?: string; keys?: string[] }
	/** Clear the list of decisions the last approval could not keep (the student has read it). */
	| { action: "clear-displaced" };

/** Read an edit from a request body; an error string when it is not one. */
export function parseCoverageEdit(raw: unknown): CoverageEdit | string {
	if (!raw || typeof raw !== "object") return "an edit is an object with an action";
	const r = raw as Record<string, unknown>;
	const str = (k: string) => (typeof r[k] === "string" && (r[k] as string).trim() !== "" ? (r[k] as string).trim() : null);
	switch (r.action) {
		case "assign":
		case "unassign":
			return str("key") && str("skill") ? { action: r.action, key: str("key")!, skill: str("skill")! } : `${r.action} needs key and skill`;
		case "exclude":
			return str("key") ? { action: "exclude", key: str("key")!, reason: cut(str("reason") ?? "", 200) || "excluded by the student" } : "exclude needs key";
		case "link":
			return Array.isArray(r.keys) && r.keys.filter((k) => typeof k === "string" && k.trim()).length >= 2 ? { action: "link", keys: (r.keys as string[]).map((k) => k.trim()) } : "link needs two keys or more";
		case "unlink":
		case "remove":
			return str("key") ? { action: r.action, key: str("key")! } : `${r.action} needs key`;
		case "remap":
			return str("key") && str("to") ? { action: "remap", key: str("key")!, to: str("to")! } : "remap needs key and to";
		case "dismiss":
			if (str("key")) return { action: "dismiss", key: str("key")! };
			return Array.isArray(r.keys) && r.keys.filter((k) => typeof k === "string" && k.trim()).length >= 2 ? { action: "dismiss", keys: (r.keys as string[]).map((k) => k.trim()) } : "dismiss needs key or keys";
		case "clear-displaced":
			return { action: "clear-displaced" };
		default:
			return "unknown action (assign, unassign, exclude, link, unlink, remove, remap, dismiss, clear-displaced)";
	}
}

/**
 * Apply one edit to a mapping (an approved one with skill ids, or a draft's with draft keys: `skills` is the set the
 * edit may name). A key that names no item may name a glossary entry (or a real sense), which gets a new item. Returns
 * the new mapping, or an error. Pure: the caller stores it.
 */
export function applyCoverageEdit(mapping: CoverageMapping, edit: CoverageEdit, ctx: { glossary: CoverageGlossary | null | undefined; skills: ReadonlySet<string> }): { ok: true; value: CoverageMapping } | { ok: false; error: string } {
	const items = mapping.items.map((i) => ({ ...i, ...(i.skills ? { skills: [...i.skills] } : {}) }));
	let links = mapping.links.map((g) => [...g]);
	let suggested: CoverageSuggestions = { excluded: [...(mapping.suggested?.excluded ?? [])], links: (mapping.suggested?.links ?? []).map((g) => [...g]) };
	let displaced = mapping.displaced;
	const sameGroup = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
	const find = (key: string) => items.find((i) => itemKey(i) === key);
	const ensure = (key: string): CoverageItem | string => {
		const found = find(key);
		if (found) return found;
		if (!keyExists(ctx.glossary, key)) return `"${key}" is not a term of this class's glossary`;
		const parsed = parseItemKey(key)!;
		const item: CoverageItem = { entryId: parsed.entryId, ...(parsed.sense ? { sense: parsed.sense } : {}), name: ctx.glossary!.terms[parsed.entryId]!.term };
		items.push(item);
		return item;
	};
	const done = (): { ok: true; value: CoverageMapping } => {
		const normalized = normalizeLinks(links);
		const cleaned = suggestionsOf(suggested, normalized);
		return { ok: true, value: { items, links: normalized, ...(cleaned ? { suggested: cleaned } : {}), ...(displaced && displaced.length > 0 ? { displaced } : {}) } };
	};
	switch (edit.action) {
		case "assign": {
			if (!ctx.skills.has(edit.skill)) return { ok: false, error: `"${edit.skill}" is not a skill of this class map` };
			const item = ensure(edit.key);
			if (typeof item === "string") return { ok: false, error: item };
			item.skills = [...new Set([...(item.skills ?? []).filter((s) => ctx.skills.has(s)), edit.skill])];
			delete item.excluded;
			delete item.leftAtApproval;
			return done();
		}
		case "unassign": {
			const item = find(edit.key);
			if (!item) return { ok: false, error: `no item "${edit.key}"` };
			item.skills = (item.skills ?? []).filter((s) => s !== edit.skill);
			if (item.skills.length === 0) delete item.skills;
			return done();
		}
		case "exclude": {
			const item = ensure(edit.key);
			if (typeof item === "string") return { ok: false, error: item };
			delete item.skills;
			delete item.leftAtApproval;
			item.excluded = edit.reason;
			suggested.excluded = suggested.excluded.filter((x) => x.key !== edit.key);
			return done();
		}
		case "link": {
			const keys = [...new Set(edit.keys)];
			for (const k of keys) if (!find(k) && !keyExists(ctx.glossary, k)) return { ok: false, error: `"${k}" is not a term of this class's glossary` };
			// a linked name with no item takes the state of one that has (one concept, one assignment)
			const model = keys.map(find).find((i) => i && ((i.skills ?? []).length > 0 || i.excluded !== undefined));
			if (model) {
				for (const k of keys) {
					if (find(k)) continue;
					const item = ensure(k) as CoverageItem;
					if (model.skills) item.skills = [...model.skills];
					else if (model.excluded !== undefined) item.excluded = model.excluded;
				}
			}
			links.push(keys);
			suggested.links = suggested.links.filter((g) => !g.every((k) => keys.includes(k)));
			return done();
		}
		case "unlink":
			links = links.map((g) => g.filter((k) => k !== edit.key));
			return done();
		case "remove": {
			const at = items.findIndex((i) => itemKey(i) === edit.key);
			if (at < 0) return { ok: false, error: `no item "${edit.key}"` };
			items.splice(at, 1);
			links = links.map((g) => g.filter((k) => k !== edit.key));
			return done();
		}
		case "remap": {
			const item = find(edit.key);
			if (!item) return { ok: false, error: `no item "${edit.key}"` };
			if (!keyExists(ctx.glossary, edit.to)) return { ok: false, error: `"${edit.to}" is not a term of this class's glossary` };
			if (find(edit.to)) return { ok: false, error: `"${edit.to}" already has an item: remove this one instead` };
			const parsed = parseItemKey(edit.to)!;
			item.entryId = parsed.entryId;
			if (parsed.sense) item.sense = parsed.sense;
			else delete item.sense;
			item.name = ctx.glossary!.terms[parsed.entryId]!.term;
			links = links.map((g) => g.map((k) => (k === edit.key ? edit.to : k)));
			return done();
		}
		case "dismiss":
			if (edit.key) suggested = { ...suggested, excluded: suggested.excluded.filter((x) => x.key !== edit.key) };
			if (edit.keys) suggested = { ...suggested, links: suggested.links.filter((g) => !sameGroup(g, edit.keys!)) };
			return done();
		case "clear-displaced":
			displaced = undefined;
			return done();
	}
}

// ─── reading stored values defensively (review 2, finding 8) ───────────────

/*
 * Everything this package reads from a chat or a course record was written by another build, synced from another
 * device, or hand-edited: it is read through these, which accept only the documented shape and treat anything else as
 * absent (or drop the one malformed element), so a malformed record can never throw out of a page load, a lesson turn
 * or a session start.
 */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);

/** An array of non-empty strings, or undefined for anything else (one malformed element makes it absent). */
export function readStringList(raw: unknown): string[] | undefined {
	if (!Array.isArray(raw) || !raw.every((x) => nonEmpty(x) !== undefined)) return undefined;
	return raw as string[];
}

/** `ChatCourseLink.vocabulary`: the keys listed to a session, or undefined (the session then owes nothing, as an
 *  unlisted one). */
export const readListedVocabulary = (raw: unknown): string[] | undefined => readStringList(raw);

/** A list of strings, keeping only the non-empty ones ([] for anything that is not an array). */
const someStrings = (raw: unknown): string[] => (Array.isArray(raw) ? raw.filter((x): x is string => nonEmpty(x) !== undefined) : []);

function readItem(raw: unknown): CoverageItem | null {
	if (!isObj(raw)) return null;
	const entryId = nonEmpty(raw.entryId);
	if (!entryId) return null;
	let sense: CoverageSense | undefined;
	if (raw.sense !== undefined) {
		const s = raw.sense;
		if (!isObj(s) || !nonEmpty(s.materialId) || typeof s.page !== "number" || !Number.isFinite(s.page)) return null; // never read as the plain entry
		sense = { materialId: s.materialId as string, page: s.page };
	}
	const skills = someStrings(raw.skills);
	return {
		entryId,
		...(sense ? { sense } : {}),
		name: typeof raw.name === "string" ? raw.name : entryId,
		...(skills.length > 0 ? { skills } : {}),
		...(typeof raw.excluded === "string" ? { excluded: raw.excluded } : {}),
		...(raw.leftAtApproval === true ? { leftAtApproval: true as const } : {}),
	};
}

const readGroups = (raw: unknown): string[][] => (Array.isArray(raw) ? raw.map(someStrings).filter((g) => g.length >= 2) : []);

function readSuggestions(raw: unknown): CoverageSuggestions | undefined {
	if (!isObj(raw)) return undefined;
	const excluded = Array.isArray(raw.excluded)
		? raw.excluded.filter((x): x is { key: string; reason: string } => isObj(x) && nonEmpty(x.key) !== undefined).map((x) => ({ key: x.key, reason: typeof x.reason === "string" ? x.reason : "" }))
		: [];
	const links = readGroups(raw.links);
	return excluded.length > 0 || links.length > 0 ? { excluded, links } : undefined;
}

function readDropped(raw: unknown): CoverageDropped[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out = raw.filter((x): x is Record<string, unknown> => isObj(x) && nonEmpty(x.key) !== undefined).map((x) => ({ key: x.key as string, name: typeof x.name === "string" ? x.name : (x.key as string), reason: typeof x.reason === "string" ? x.reason : "" }));
	return out.length > 0 ? out : undefined;
}

function readMapping(raw: Record<string, unknown>): CoverageMapping {
	const items = (raw.items as unknown[]).map(readItem).filter((i): i is CoverageItem => i !== null);
	const suggested = readSuggestions(raw.suggested);
	const displaced = readDropped(raw.displaced);
	return { items, links: readGroups(raw.links), ...(suggested ? { suggested } : {}), ...(displaced ? { displaced } : {}) };
}

/** `CourseRecord.coverage`: the approved mapping, or undefined when it is not an object with an `items` array. Pure. */
export function readCourseCoverage(raw: unknown): CourseCoverage | undefined {
	if (!isObj(raw) || !Array.isArray(raw.items)) return undefined;
	return { updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "", ...readMapping(raw) };
}

/** `CourseDraft.coverage`: the draft's proposal, or undefined when it is not an object with an `items` array. Pure. */
export function readDraftCoverage(raw: unknown): DraftCoverage | undefined {
	if (!isObj(raw) || !Array.isArray(raw.items)) return undefined;
	const shown = isObj(raw.shown) ? raw.shown : {};
	const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
	const carriedKeys = readStringList(raw.carriedKeys);
	const edited = readStringList(raw.edited);
	const linkEdits = readLinkEdits(raw.linkEdits);
	return {
		...readMapping(raw),
		dropped: someStrings(raw.dropped),
		incomplete: someStrings(raw.incomplete),
		shown: { full: count(shown.full), names: count(shown.names), omitted: count(shown.omitted) },
		...(raw.carried === true ? { carried: true as const } : {}),
		...(typeof raw.carriedFrom === "string" ? { carriedFrom: raw.carriedFrom } : {}),
		...(carriedKeys ? { carriedKeys } : {}),
		...(edited ? { edited } : {}),
		...(linkEdits ? { linkEdits } : {}),
	};
}

/** DraftCoverage.linkEdits: the well-formed entries, in order (undefined when none). */
function readLinkEdits(raw: unknown): CoverageLinkEdit[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: CoverageLinkEdit[] = [];
	for (const e of raw) {
		if (!isObj(e)) continue;
		const link = someStrings(e.link);
		if (Array.isArray(e.link) && link.length >= 2) out.push({ link });
		else if (nonEmpty(e.unlink)) out.push({ unlink: e.unlink as string });
	}
	return out.length > 0 ? out : undefined;
}

/** A fingerprint of a mapping's decisions (items and links): the draft records the approved map's when it carries it,
 *  so approval can tell whether the approved map changed since. Pure. */
export function mappingFingerprint(mapping: CoverageMapping | null | undefined): string {
	if (!mapping) return "none";
	const text = JSON.stringify([mapping.items.map((i) => [itemKey(i), i.skills ?? [], i.excluded ?? null]), mapping.links]);
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return `${text.length}:${(h >>> 0).toString(36)}`;
}
