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

import type { CoverageEntryView, CoverageItem, CoverageSense, DraftCoverage } from "./contracts/course.ts";
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

// ─── approval ───────────────────────────────────────────────────────────────

/**
 * Approve a draft's proposal: its items with draft keys turned into skill ids (`idOf`), checked against the glossary
 * NOW. Core entries with no assigned or excluded item refuse approval (returned as `unassigned`), unless `leaveReason`
 * is given (the student's explicit "leave N terms unassigned"): then each becomes an excluded item with that reason.
 */
export function approveCoverage(
	draft: Pick<DraftCoverage, "items" | "links">,
	idOf: (draftKey: string) => string | undefined,
	glossary: CoverageGlossary | null | undefined,
	leaveReason: string | null,
	now: string,
): { ok: true; coverage: { updatedAt: string; items: CoverageItem[]; links: string[][] } } | { ok: false; unassigned: CoverageGlossaryEntry[] } {
	const items: CoverageItem[] = draft.items.map((item) => {
		const skills = [...new Set((item.skills ?? []).map(idOf).filter((s): s is string => s !== undefined))];
		const { skills: _drop, ...rest } = item;
		return skills.length > 0 ? { ...rest, skills, excluded: undefined } : rest;
	}).map((i) => Object.fromEntries(Object.entries(i).filter(([, v]) => v !== undefined)) as unknown as CoverageItem);
	const resolved = resolveCoverage({ items, links: draft.links }, glossary, null);
	if (resolved.unassigned.length > 0) {
		if (leaveReason === null) return { ok: false, unassigned: resolved.unassigned };
		const left = new Set(resolved.unassigned.map((e) => e.id));
		// an item whose skills all fell away is replaced, not doubled
		const kept = items.filter((i) => !(left.has(i.entryId) && !i.sense && (i.skills ?? []).length === 0 && i.excluded === undefined));
		for (const e of resolved.unassigned) kept.push({ entryId: e.id, name: e.term, excluded: leaveReason, leftAtApproval: true });
		return { ok: true, coverage: { updatedAt: now, items: kept, links: draft.links.map((g) => [...g]) } };
	}
	return { ok: true, coverage: { updatedAt: now, items, links: draft.links.map((g) => [...g]) } };
}

// ─── the planner's input (bounded) ──────────────────────────────────────────

/** The planner's glossary block is cut at this many characters (about 15k tokens). */
export const PLANNER_GLOSSARY_BUDGET = 60_000;
/** Of that, entries are shown with their definition until this many characters; the rest by name only. */
export const PLANNER_GLOSSARY_FULL_BUDGET = 24_000;
/** A definition shown to the planner is cut at this many characters. */
export const PLANNER_DEFINITION_CHARS = 200;
/** The most suggested pairs the planner is shown. */
export const PLANNER_DUPLICATE_PAIRS = 150;

const cut = (text: string, max: number) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

/** The core entries in teaching order: the material they first appear in (the course's order), then the page, then id. */
export function coreEntriesInOrder(glossary: CoverageGlossary): CoverageGlossaryEntry[] {
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
		.filter((e) => e.tier === "core")
		.map((e) => ({ e, r: rank(e) }))
		.sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || byCodeUnit(a.e.id, b.e.id))
		.map((x) => x.e);
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
 * The class glossary as the planner reads it: every core entry with its id, its definition from the material (or "no
 * definition") and its pages, until PLANNER_GLOSSARY_FULL_BUDGET characters; then by id, name and pages only, until
 * PLANNER_GLOSSARY_BUDGET; any further entries are counted, not listed (they show as unassigned at approval). Then the
 * suggested duplicates as PAIRS with the reason for each pair, and the materials whose index is incomplete. Null when the
 * glossary has no core entry. Pure.
 */
export function plannerGlossaryBlock(glossary: CoverageGlossary | null | undefined, budget = PLANNER_GLOSSARY_BUDGET, fullBudget = PLANNER_GLOSSARY_FULL_BUDGET): { text: string; shown: DraftCoverage["shown"] } | null {
	if (!glossary || !hasCoreEntries(glossary)) return null;
	const core = coreEntriesInOrder(glossary);
	const lines: string[] = [];
	let used = 0;
	let full = 0;
	let names = 0;
	for (const e of core) {
		const aliases = e.aliases.length > 0 ? ` · also called: ${cut(e.aliases.slice(0, 5).join(", "), 120)}` : "";
		const definition = e.definition !== null ? `"${cut(e.definition, PLANNER_DEFINITION_CHARS)}" (p. ${e.definitionPage})` : "no definition in the material";
		const fullLine = `- ${e.id} :: ${e.term} — ${definition}${aliases} — ${placesOf(e, true)}`;
		if (used + fullLine.length + 1 <= fullBudget && names === 0) {
			lines.push(fullLine);
			used += fullLine.length + 1;
			full++;
			continue;
		}
		const short = `- ${e.id} :: ${e.term} (${placesOf(e, false)})`;
		if (used + short.length + 1 > budget) break;
		lines.push(short);
		used += short.length + 1;
		names++;
	}
	const omitted = core.length - full - names;
	const parts = [
		`<class_glossary>`,
		`The class's own vocabulary, from its indexed material: ${core.length} CORE entries (things the material treats as what a student must know).` +
			(names > 0 || omitted > 0 ? ` ${full} are shown with their definition, ${names} by name only${omitted > 0 ? `, and ${omitted} are not listed (the input is bounded; they will show as unassigned at approval)` : ""}.` : ""),
		"Materials: " + (glossary.indexed ?? []).map((m) => `${m.name} = ${m.id}`).join("; "),
		"",
		"Core entries (id :: name — definition — where):",
		...lines,
	];
	if (omitted > 0) parts.push(`(${omitted} more core entries not listed)`);
	const nameOf = (id: string) => glossary.terms[id]?.term ?? id;
	const pairs = glossary.suggestedDuplicates.flatMap((g) => g.pairs ?? []).filter((p) => p.ids.some((id) => glossary.terms[id]?.tier === "core"));
	if (pairs.length > 0) {
		parts.push(
			"",
			"Suggested duplicates, as pairs (the names look alike; they may be one concept or two different ones — you decide; a pair is never merged unless you link it):",
			...pairs.slice(0, PLANNER_DUPLICATE_PAIRS).map((p) => `- ${p.ids[0]} (${nameOf(p.ids[0])}) ~ ${p.ids[1]} (${nameOf(p.ids[1])}): ${p.reasons.map((r) => r.replace("_", " ")).join(", ")}`),
		);
		if (pairs.length > PLANNER_DUPLICATE_PAIRS) parts.push(`(${pairs.length - PLANNER_DUPLICATE_PAIRS} more pairs not listed)`);
	}
	if ((glossary.incomplete ?? []).length > 0) {
		parts.push("", `Materials whose index is incomplete (their terms may be missing here): ${glossary.incomplete!.map((m) => `${m.name}${m.reason ? ` (${m.reason.replace("_", " ")})` : ""}`).join("; ")}`);
	}
	parts.push(`</class_glossary>`);
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
	| { action: "remap"; key: string; to: string };

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
		default:
			return "unknown action (assign, unassign, exclude, link, unlink, remove, remap)";
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
	const done = (): { ok: true; value: CoverageMapping } => ({ ok: true, value: { items, links: normalizeLinks(links) } });
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
	}
}
