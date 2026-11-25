/**
 * Vocabulary coverage — the server seam (WP5, 2026-11-25, reworked after review 1; spec: docs/courses.md "Vocabulary
 * coverage"). Thin hooks in server/courses.ts call in here; the rules live in core/coverage-items.ts (the mapping) and
 * core/coverage-ledger.ts (what the transcripts show).
 *
 *   - The class glossary is read through `coverageGlossary` (server/material-indexing.ts courseGlossary: computed from
 *     the digests on disk, cached by file stamps, never stored).
 *   - Each course chat's vocabulary evidence is cached per chat file like the course evidence cache (server/courses.ts):
 *     keyed by the file path, valid while its mtime, size and inode match AND the class's names are the same (the
 *     matcher's fingerprint, which also carries the matching rules' version), bounded to COURSE_VOCABULARY_CACHE_MAX
 *     files (least recently used out first). An entry of a chat that is no longer in the chat list is dropped the next
 *     time a class's coverage is read. So a page load of a class with 50 sessions stats 50 files and folds cached
 *     results; a changed glossary re-scans each chat once.
 *   - A session's vocabulary obligation is fixed when it starts: `listedVocabularyFor` picks the items its prompt lists
 *     and server/courses.ts stores their keys on the chat's course link (ChatCourseLink.vocabulary); every turn reads them
 *     back (`sessionVocabulary`), so what a lesson owes never drifts with later sessions.
 *   - No model call happens here except the "Map the class's terms" pass the student starts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { PATHS } from "../../config.ts";
import type { CourseCoverage, CourseCoverageView, CourseMode, CourseRecord, CoverageEntryView, CoverageSuggestions, CoverageTermView, DraftCoverage, LessonResult } from "../core/contracts.ts";
import {
	applyCoverageEdit,
	carryForward,
	entryView,
	hasCoreEntries,
	mergeMappingPass,
	resolveCoverage,
	type CoverageEdit,
	type CoverageGlossary,
	type CoverageMapping,
	type ResolvedCoverage,
} from "../core/coverage-items.ts";
import {
	buildMatcher,
	chatVocabularyOf,
	foldLedger,
	itemState,
	listVocabulary,
	resolveConceptId,
	vocabularySection,
	type ChatVocabulary,
	type ItemLedger,
	type LedgerChat,
	type LessonVocabulary,
	type VocabularyMatcher,
	type VocabularyPromptItem,
} from "../core/coverage-ledger.ts";
import { sessionFinishOf } from "../core/course-session.ts";
import type { LessonLanguage } from "../core/language.ts";
import { lessonLabels } from "../core/lesson-labels.ts";
import type { LhMessage } from "../core/native-messages.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { piEngineForSpec } from "../agent/models.ts";
import { mapCourseTerms } from "../agent/subagents/term-mapper.ts";
import { materialTools } from "../agent/tools/materials.ts";
import { courseGlossary } from "./material-indexing.ts";
import { stores } from "./stores.ts";

type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

// ─── the glossary ───────────────────────────────────────────────────────────

let glossarySource: (courseId: string) => CoverageGlossary | null = (courseId) => courseGlossary(courseId);

/** Test seam: read the class glossary from somewhere else (undefined restores the real one). */
export function setCoverageGlossarySource(source?: (courseId: string) => CoverageGlossary | null): void {
	glossarySource = source ?? ((courseId) => courseGlossary(courseId));
}

/** The class glossary coverage reads, or null (no indexed material, or a digest the merge refused). */
export function coverageGlossary(courseId: string): CoverageGlossary | null {
	try {
		return glossarySource(courseId);
	} catch (err) {
		console.warn(`[coverage ${courseId}] the class glossary could not be read: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}

const EMPTY_GLOSSARY: CoverageGlossary = { terms: {}, lookup: {}, suggestedDuplicates: [] };

// ─── the per-chat vocabulary cache ──────────────────────────────────────────

interface VocabularyCacheEntry {
	mtimeMs: number;
	size: number;
	ino: number;
	matcherKey: string;
	vocabulary: ChatVocabulary;
}

/** Bump when chatVocabularyOf or ChatVocabulary changes. */
export const COURSE_VOCABULARY_CACHE_VERSION = 2;
const CACHE_KEY = Symbol.for(`lh.courseVocabularyCache.v${COURSE_VOCABULARY_CACHE_VERSION}`);
/** The most chat files the cache keeps (least recently used first out). */
export const COURSE_VOCABULARY_CACHE_MAX = 5_000;

function cache(): Map<string, VocabularyCacheEntry> {
	const g = globalThis as Record<symbol, Map<string, VocabularyCacheEntry> | undefined>;
	g[CACHE_KEY] ??= new Map();
	return g[CACHE_KEY];
}

/** Test seams. */
export function clearCourseVocabularyCache(): void {
	cache().clear();
}
export const courseVocabularyCacheSize = (): number => cache().size;
let scans = 0;
/** How many chats were scanned (not served from the cache) since the process started (tests, measurements). */
export const courseVocabularyScans = (): number => scans;

function chatFile(id: string): string | null {
	return /^[A-Za-z0-9_-]+$/.test(id) ? path.join(/* turbopackIgnore: true */ PATHS.chats, `${id}.json`) : null;
}

function scan(chatId: string, matcher: VocabularyMatcher): ChatVocabulary {
	scans++;
	return chatVocabularyOf(stores.chatStore.getChat(chatId)?.messages ?? [], matcher);
}

/** One chat's vocabulary evidence, through the cache unless `useCache` is false (the result is the same). */
function chatVocabulary(chatId: string, matcher: VocabularyMatcher, useCache: boolean): ChatVocabulary {
	const file = chatFile(chatId);
	if (!file || !useCache) return scan(chatId, matcher);
	let st: fs.Stats;
	try {
		st = fs.statSync(/* turbopackIgnore: true */ file);
	} catch {
		cache().delete(file);
		return scan(chatId, matcher);
	}
	const entries = cache();
	const hit = entries.get(file);
	entries.delete(file);
	if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && hit.ino === st.ino && hit.matcherKey === matcher.key) {
		entries.set(file, hit);
		return hit.vocabulary;
	}
	const vocabulary = scan(chatId, matcher);
	entries.set(file, { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, matcherKey: matcher.key, vocabulary });
	while (entries.size > COURSE_VOCABULARY_CACHE_MAX) entries.delete(entries.keys().next().value!);
	return vocabulary;
}

/** Drop the cache entries of chats that are no longer in the chat list (deleted chats). */
function pruneDeleted(chatIds: readonly string[]): void {
	const live = new Set(chatIds.map(chatFile).filter((f): f is string => f !== null));
	for (const file of [...cache().keys()]) if (!live.has(file)) cache().delete(file);
}

// ─── the class's coverage, resolved ─────────────────────────────────────────

const matchers = new WeakMap<object, VocabularyMatcher>();
function matcherFor(glossary: CoverageGlossary): VocabularyMatcher {
	let m = matchers.get(glossary.terms);
	if (!m) matchers.set(glossary.terms, (m = buildMatcher(glossary)));
	return m;
}

export interface ClassCoverage {
	glossary: CoverageGlossary;
	resolved: ResolvedCoverage;
	matcher: VocabularyMatcher;
	chats: LedgerChat[];
}

/** A mapped class's coverage read against the glossary now, with its chats' vocabulary evidence. Null when the class
 *  has no mapping (no coverage behaviour). */
export function classCoverage(course: CourseRecord, opts: { cache?: boolean; glossary?: CoverageGlossary | null } = {}): ClassCoverage | null {
	if (!course.coverage) return null;
	const glossary = (opts.glossary !== undefined ? opts.glossary : coverageGlossary(course.id)) ?? EMPTY_GLOSSARY;
	const resolved = resolveCoverage(course.coverage, glossary, new Set(course.skills));
	const matcher = matcherFor(glossary);
	const chats: LedgerChat[] = [];
	const all = stores.chatStore.listChats();
	for (const c of all) {
		if (c.course?.courseId !== course.id || c.course.mode === "ask") continue;
		chats.push({ chatId: c.id, mode: c.course.mode, skillIds: c.course.skillIds, vocabulary: chatVocabulary(c.id, matcher, opts.cache !== false) });
	}
	pruneDeleted(all.map((c) => c.id));
	return { glossary, resolved, matcher, chats };
}

const termView = (base: CoverageEntryView, l: ItemLedger | undefined, linked: string[]): CoverageTermView => ({
	...base,
	state: itemState(l),
	...(l?.level ? { level: l.level } : {}),
	...(l?.right !== undefined ? { right: l.right } : {}),
	...(linked.length > 0 ? { linked } : {}),
	...(l && l.deferredIn.size > 0 ? { deferredCount: l.deferredIn.size } : {}),
});

const coreFirst = <T extends { tier: "core" | "supporting"; name: string }>(a: T, b: T) => (a.tier === b.tier ? a.name.localeCompare(b.name) : a.tier === "core" ? -1 : 1);

/** A mapping pass's suggestions with the names the page shows. */
function suggestedView(s: CoverageSuggestions | undefined, nameOf: (key: string) => string): CourseCoverageView["suggested"] {
	if (!s || (s.excluded.length === 0 && s.links.length === 0)) return undefined;
	return { excluded: s.excluded.map((x) => ({ ...x, name: nameOf(x.key) })), links: s.links.map((keys) => ({ keys, names: keys.map(nameOf) })) };
}

/** The course page's coverage block (CourseView.coverage); undefined when the class has no coverage behaviour at all. */
export function coverageView(course: CourseRecord, language: LessonLanguage, mapping: boolean, opts: { cache?: boolean } = {}): CourseCoverageView | undefined {
	const glossary = coverageGlossary(course.id);
	const status: CourseCoverageView["status"] = course.coverage ? "mapped" : hasCoreEntries(glossary) && course.skills.length > 0 ? "unmapped" : "none";
	// the draft review shows the proposal approval would check: also when the draft carries none but the class has core terms
	const draft = course.draft && (course.draft.coverage || hasCoreEntries(glossary)) ? draftView(course, glossary) : undefined;
	if (status === "none" && !draft && !mapping && !course.coverageError) return undefined;
	const view: CourseCoverageView = {
		status,
		mapping,
		...(course.coverageError ? { error: course.coverageError } : {}),
		language,
		skills: {},
		unassigned: [],
		flagged: [],
		excluded: [],
		incomplete: (glossary?.incomplete ?? []).map((m) => m.name),
		...(draft ? { draft } : {}),
	};
	if (status === "unmapped") view.unassigned = Object.values(glossary!.terms).filter((e) => e.tier === "core").map((e) => entryView(e)).sort(coreFirst);
	const cc = classCoverage(course, { ...opts, glossary });
	if (!cc) return view;
	const ledger = foldLedger(cc.resolved, cc.glossary, cc.chats);
	const nameOf = (k: string) => cc.resolved.byKey.get(k)?.view.name ?? cc.glossary.terms[k]?.term ?? k;
	for (const skillId of course.skills) {
		const terms = cc.resolved.items
			.filter((i) => i.status === "assigned" && i.skills.includes(skillId))
			.map((i) => termView(i.view, ledger.get(i.key), cc.resolved.group(i.key).filter((k) => k !== i.key).map(nameOf)))
			.sort(coreFirst);
		if (terms.length === 0) continue;
		const core = terms.filter((t) => t.tier === "core");
		// introduced and checked are independent: an "asked" term (checked, never named) counts as checked, not introduced
		view.skills[skillId] = {
			total: core.length,
			introduced: core.filter((t) => t.state === "introduced" || t.state === "checked").length,
			checked: core.filter((t) => t.state === "checked" || t.state === "asked").length,
			terms,
		};
	}
	view.unassigned = cc.resolved.unassigned.map((e) => entryView(e)).sort(coreFirst);
	view.flagged = cc.resolved.items.filter((i) => i.status === "flagged").map((i) => ({ key: i.key, name: i.item.name, skills: i.item.skills ?? [] }));
	view.excluded = cc.resolved.items.filter((i) => i.status === "excluded").map((i) => ({ key: i.key, name: i.view.name, reason: i.item.excluded ?? "" }));
	const suggested = suggestedView(course.coverage!.suggested, nameOf);
	if (suggested) view.suggested = suggested;
	if (course.coverage!.displaced?.length) view.displaced = course.coverage!.displaced;
	return view;
}

/** The proposal approval checks for a pending draft: the draft's own (with the class's earlier decisions carried in
 *  when the draft was made), else the earlier decisions carried into the draft's proposal or into an empty one (a draft
 *  made before the class's material was indexed). Null without a draft. */
export function approvalProposal(course: CourseRecord, glossary: CoverageGlossary | null): (CoverageMapping & Partial<DraftCoverage>) | null {
	if (!course.draft) return null;
	const own = course.draft.coverage;
	if (own?.carried) return own;
	const carried = carryForward(course.coverage, own, course.draft.skills, glossary);
	return { ...(own ?? {}), ...carried };
}

/** The approval screen's view of a draft's proposal. */
function draftView(course: CourseRecord, glossary: CoverageGlossary | null): NonNullable<CourseCoverageView["draft"]> {
	const proposal = approvalProposal(course, glossary)!;
	const resolved = resolveCoverage(proposal, glossary, new Set(course.draft!.skills.map((s) => s.key)));
	const skills: Record<string, CoverageEntryView[]> = {};
	for (const s of course.draft!.skills) {
		skills[s.key] = resolved.items.filter((i) => i.status === "assigned" && i.skills.includes(s.key)).map((i) => i.view).sort(coreFirst);
	}
	const linkedTogether = (a: string, b: string) => resolved.group(a).includes(b);
	const duplicates = (glossary?.suggestedDuplicates ?? [])
		.flatMap((g) => g.pairs ?? [])
		.filter((p) => p.ids.every((id) => glossary!.terms[id]) && p.ids.some((id) => glossary!.terms[id]!.tier === "core"))
		.map((p) => ({ a: entryView(glossary!.terms[p.ids[0]]!), b: entryView(glossary!.terms[p.ids[1]]!), reasons: p.reasons, linked: linkedTogether(p.ids[0], p.ids[1]) }));
	const nameOf = (k: string) => resolved.byKey.get(k)?.view.name ?? glossary?.terms[k]?.term ?? k;
	const suggested = suggestedView(proposal.suggested, nameOf);
	return {
		...(course.draft!.coverage ? {} : { empty: true }),
		skills,
		unassigned: resolved.unassigned.map((e) => entryView(e)).sort(coreFirst),
		excluded: resolved.items.filter((i) => i.status === "excluded").map((i) => ({ key: i.key, name: i.view.name, reason: i.item.excluded ?? "" })),
		duplicates,
		dropped: course.draft!.coverage?.dropped ?? [],
		incomplete: course.draft!.coverage?.incomplete ?? (glossary?.incomplete ?? []).map((m) => m.name),
		shown: course.draft!.coverage?.shown ?? { full: 0, names: 0, omitted: 0 },
		...(suggested ? { suggested } : {}),
		...(proposal.displaced?.length ? { displaced: proposal.displaced } : {}),
	};
}

// ─── approval ───────────────────────────────────────────────────────────────

/** The core entries a pending draft would leave unassigned, read against the glossary NOW, whether or not the draft
 *  carries a proposal ([] when the class glossary has no core term: approval is then exactly as before). */
export function draftUnassigned(course: CourseRecord): Array<{ id: string; name: string }> {
	const glossary = coverageGlossary(course.id);
	if (!course.draft || !hasCoreEntries(glossary)) return [];
	return resolveCoverage(approvalProposal(course, glossary)!, glossary, new Set(course.draft.skills.map((s) => s.key))).unassigned.map((e) => ({ id: e.id, name: e.term }));
}

// ─── a session's pieces ─────────────────────────────────────────────────────

/** Every assigned item of one skill as the prompt shows it, with its state as of the other sessions (this one left
 *  out, so its own progress never changes its prompt mid-session). */
function promptItemsOf(cc: ClassCoverage, skillId: string, chatId: string | undefined): { items: VocabularyPromptItem[]; others: Map<string, ItemLedger> } {
	const others = foldLedger(cc.resolved, cc.glossary, cc.chats, chatId);
	const skillChats = new Set(cc.chats.filter((c) => c.chatId !== chatId && c.skillIds.includes(skillId) && (c.mode === "learn" || c.mode === "practice")).map((c) => c.chatId));
	const learnChats = new Set(cc.chats.filter((c) => c.chatId !== chatId && c.skillIds.includes(skillId) && c.mode === "learn").map((c) => c.chatId));
	const nameOf = (k: string) => cc.resolved.byKey.get(k)?.view.name ?? k;
	const assigned = cc.resolved.items.filter((i) => i.status === "assigned" && i.skills.includes(skillId));
	const items = assigned.map((i): VocabularyPromptItem => {
		const l = others.get(i.key);
		const deferredCount = l ? [...l.deferredIn].filter((c) => learnChats.has(c)).length : 0;
		const carried = deferredCount > 0 || (!!l && [...l.seenIn].some((c) => skillChats.has(c)));
		const linked = cc.resolved.group(i.key).filter((k) => k !== i.key).map(nameOf);
		const senses = i.item.sense ? assigned.filter((o) => o.item.sense && o.item.entryId === i.item.entryId).length : 0;
		return {
			key: i.key,
			name: i.view.name,
			tier: i.view.tier,
			definition: i.view.definition,
			page: i.view.page,
			material: i.view.material,
			state: itemState(l),
			carried,
			...(deferredCount > 0 ? { deferredCount } : {}),
			...(l?.level ? { level: l.level } : {}),
			...(l?.right !== undefined ? { right: l.right } : {}),
			...(linked.length > 0 ? { linked } : {}),
			...(senses > 1 ? { senses } : {}),
		};
	});
	return { items, others };
}

/** The item keys a new Learn or Practice session on one skill is listed (and, for Learn, owes), to store with the session
 *  when it starts. Undefined when the class has no vocabulary mapping (the session owes none). */
export function listedVocabularyFor(course: CourseRecord, skillId: string): string[] | undefined {
	const cc = classCoverage(course);
	if (!cc) return undefined;
	return listVocabulary(promptItemsOf(cc, skillId, undefined).items);
}

/** How the turn timeline reads a question's tags: known when they resolve to an item of the class (resolveConceptId). */
export interface ConceptIdReader {
	has: (id: string) => boolean;
}

/** What a Learn or Practice session on one skill gets: its prompt block (the items `listed` to it when it started), the
 *  finish check over exactly those (Learn), and the reader of question tags. Undefined without coverage. */
export function sessionVocabulary(
	course: CourseRecord,
	chatId: string,
	skill: { id: string; name: string },
	mode: CourseMode,
	listed: readonly string[] | undefined,
): { section: string; lesson?: LessonVocabulary; known: ConceptIdReader } | undefined {
	const cc = classCoverage(course);
	if (!cc) return undefined;
	const known: ConceptIdReader = { has: (id) => resolveConceptId(id, cc.glossary, cc.resolved).length > 0 };
	// a session started before the class had a mapping was listed nothing: it owes nothing
	if (!listed) return { section: "", known };
	const { items, others } = promptItemsOf(cc, skill.id, chatId);
	const byKey = new Map(items.map((i) => [i.key, i]));
	const shown = listed.map((k) => byKey.get(k)).filter((i): i is VocabularyPromptItem => i !== undefined);
	const shownKeys = new Set(shown.map((i) => i.key));
	const done = items.filter((i) => i.state === "checked" && !shownKeys.has(i.key));
	const later = items.filter((i) => i.state !== "checked" && !shownKeys.has(i.key)).length;
	const section = vocabularySection(skill.name, shown, mode, { done, later });
	if (mode !== "learn") return { section, known };
	const introducedElsewhere = new Set([...others].filter(([, l]) => l.introduced).map(([k]) => k));
	const lesson: LessonVocabulary = {
		items: shown.filter((i) => i.tier === "core").map((i) => ({ key: i.key, name: i.name, group: cc.resolved.group(i.key) })),
		introduced: (messages: readonly LhMessage[]) => {
			const live = foldLedger(cc.resolved, cc.glossary, [{ chatId, mode, skillIds: [skill.id], vocabulary: chatVocabularyOf(messages, cc.matcher) }]);
			const out = new Set(introducedElsewhere);
			for (const [k, l] of live) if (l.introduced) out.add(k);
			return out;
		},
	};
	return { section, lesson, known };
}

/** The lesson result's coverage line, as recorded by the lesson's clean finish (fixed as of the end of that lesson;
 *  later lessons never change it). Undefined when the finish recorded none (no coverage, no listed core term, or a
 *  lesson finished before this was recorded). */
export function lessonCoverage(messages: readonly LhMessage[], language: LessonLanguage): LessonResult["coverage"] | undefined {
	const finish = sessionFinishOf(messages);
	if (!finish?.callId) return undefined;
	const result = messages.find((m) => (m as { role?: string }).role === "toolResult" && (m as ToolResultMessage).toolCallId === finish.callId && !(m as ToolResultMessage).isError) as ToolResultMessage | undefined;
	const c = (result?.details as { coverage?: { total?: unknown; covered?: unknown; left?: unknown } } | null | undefined)?.coverage;
	if (!c || typeof c.total !== "number" || typeof c.covered !== "number" || !Array.isArray(c.left)) return undefined;
	return { total: c.total, covered: c.covered, left: c.left.filter((x): x is string => typeof x === "string"), language };
}

// ─── the student's edits ────────────────────────────────────────────────────

/** Edit the approved mapping ("approved"; started empty on a class that has core terms and none) or the draft's
 *  proposal ("draft"; started from the proposal approval would check, so a draft with none gets one). */
export function editCourseCoverage(courseId: string, target: "approved" | "draft", edit: CoverageEdit): Result<CourseRecord> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	const glossary = coverageGlossary(courseId);
	if (target === "draft") {
		if (!course.draft) return { ok: false, status: 409, error: "There is no draft" };
		if (!course.draft.coverage && !hasCoreEntries(glossary)) return { ok: false, status: 409, error: "The class has no indexed terms to map" };
		const base = approvalProposal(course, glossary)!;
		const applied = applyCoverageEdit(base, edit, { glossary, skills: new Set(course.draft.skills.map((s) => s.key)) });
		if (!applied.ok) return { ok: false, status: 400, error: applied.error };
		const coverage: DraftCoverage = {
			dropped: course.draft.coverage?.dropped ?? [],
			incomplete: course.draft.coverage?.incomplete ?? (glossary?.incomplete ?? []).map((m) => m.name),
			shown: course.draft.coverage?.shown ?? { full: 0, names: 0, omitted: 0 },
			...applied.value,
			carried: true,
		};
		const updated = stores.courseStore.updateCourse(courseId, { draft: { ...course.draft, coverage } })!;
		return { ok: true, value: updated };
	}
	if (course.skills.length === 0) return { ok: false, status: 409, error: "Approve the skill map first" };
	if (!course.coverage && !hasCoreEntries(glossary)) return { ok: false, status: 409, error: "The class has no indexed terms to map" };
	const base: CourseCoverage = course.coverage ?? { updatedAt: new Date().toISOString(), items: [], links: [] };
	const applied = applyCoverageEdit(base, edit, { glossary, skills: new Set(course.skills) });
	if (!applied.ok) return { ok: false, status: 400, error: applied.error };
	const updated = stores.courseStore.updateCourse(courseId, { coverage: { updatedAt: new Date().toISOString(), ...applied.value } })!;
	return { ok: true, value: updated };
}

// ─── "Map the class's terms" (the only model work) ──────────────────────────

const RUNS_KEY = Symbol.for("lh.courseTermMapRuns");
function mapRuns(): Map<string, AbortController> {
	const g = globalThis as Record<symbol, Map<string, AbortController> | undefined>;
	g[RUNS_KEY] ??= new Map();
	return g[RUNS_KEY];
}

/** Is a mapping pass running for this course? */
export const courseTermMapping = (courseId: string): boolean => mapRuns().has(courseId);
/** How many mapping passes are running (the idle check). */
export const courseTermMapCount = (): number => mapRuns().size;
/** Stop a course's mapping pass (its deletion). */
export function abortCourseTermMapping(courseId: string): void {
	mapRuns().get(courseId)?.abort();
}

/** Start the mapping-only pass on the approved map ("approved") or the pending draft ("draft"). It changes no skill, and
 *  it may only ADD assignments for terms that have no decision now; the exclusions and links it proposes are stored as
 *  suggestions the student accepts one by one (core/coverage-items.ts mergeMappingPass). Returns at once. */
export function startCourseTermMapping(courseId: string, language: LessonLanguage, target: "approved" | "draft" = "approved"): Result<CourseRecord> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	if (target === "approved" && course.skills.length === 0) return { ok: false, status: 409, error: "Approve the skill map first" };
	if (target === "draft" && !course.draft) return { ok: false, status: 409, error: "There is no draft" };
	if (mapRuns().has(courseId)) return { ok: false, status: 409, error: "The terms are already being mapped" };
	if (!hasCoreEntries(coverageGlossary(courseId))) return { ok: false, status: 409, error: "The class has no indexed terms to map (index its PDFs first)" };
	const controller = new AbortController();
	mapRuns().set(courseId, controller);
	const updated = stores.courseStore.updateCourse(courseId, { coverageError: undefined })!;
	void runMapping(courseId, language, target, controller).finally(() => mapRuns().delete(courseId));
	return { ok: true, value: updated };
}

async function runMapping(courseId: string, language: LessonLanguage, target: "approved" | "draft", controller: AbortController): Promise<void> {
	const settle = (patch: Partial<CourseRecord>) => {
		if (stores.courseStore.getCourse(courseId)) stores.courseStore.updateCourse(courseId, patch);
	};
	try {
		const course = stores.courseStore.getCourse(courseId);
		const glossary = coverageGlossary(courseId);
		if (!course || !glossary || controller.signal.aborted) return;
		const spec = resolveRoleSpec("coursePlanner", stores.settingsStore.readSettings());
		if (!spec) {
			settle({ coverageError: "No model is configured for the course planner (Settings → Agent: the strong slot or a Course planner override)" });
			return;
		}
		let skills: Array<{ id: string; name: string; statement: string }>;
		if (target === "draft") {
			skills = (course.draft?.skills ?? []).map((s) => ({ id: s.key, name: s.name, statement: s.statement }));
		} else {
			const byId = new Map<string, { name: string; statement: string }>();
			for (const line of stores.skillStore.readSkillLines()) if (!byId.has(line.id) || line.reworded) byId.set(line.id, { name: line.name, statement: line.statement });
			skills = course.skills.filter((id) => byId.has(id)).map((id) => ({ id, ...byId.get(id)! }));
		}
		const tools: Record<string, AgentTool<any>> = { ...materialTools({ chatId: courseId, store: stores.materialStore }) };
		const proposal = await mapCourseTerms({ title: course.title, skills, glossary, language }, { engine: piEngineForSpec(spec), signal: controller.signal, tools, onStep: () => {}, courseId });
		const fresh = stores.courseStore.getCourse(courseId);
		if (!fresh || controller.signal.aborted) return;
		const error = proposal.dropped.length > 0 ? `The planner named ${proposal.dropped.length} term id(s) that are not in the glossary; they were dropped: ${proposal.dropped.slice(0, 8).join(", ")}` : undefined;
		if (target === "draft") {
			if (!fresh.draft) return;
			const base = approvalProposal(fresh, glossary)!;
			const merged = mergeMappingPass(base, proposal, new Set(fresh.draft.skills.map((s) => s.key)));
			const coverage: DraftCoverage = {
				dropped: [...new Set([...(fresh.draft.coverage?.dropped ?? []), ...proposal.dropped])],
				incomplete: proposal.incomplete,
				shown: proposal.shown,
				...merged,
				carried: true,
			};
			settle({ draft: { ...fresh.draft, coverage }, coverageError: error });
			return;
		}
		// the pass only adds assignments for terms with no decision; what would change one is a suggestion
		const existing = fresh.coverage ?? { updatedAt: "", items: [], links: [] };
		const merged = mergeMappingPass(existing, proposal, new Set(fresh.skills));
		settle({ coverage: { ...merged, updatedAt: new Date().toISOString() }, coverageError: error });
	} catch (err) {
		if (controller.signal.aborted) return;
		settle({ coverageError: err instanceof Error ? err.message : String(err) });
	}
}

/** The leave-unassigned reason, in the class's language. */
export const leftAtApprovalReason = (language: LessonLanguage): string => lessonLabels(language).coverage.leftAtApproval;
