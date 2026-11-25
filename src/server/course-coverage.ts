/**
 * Vocabulary coverage — the server seam (WP5, 2026-11-25; spec: docs/courses.md "Vocabulary coverage"). Thin hooks in
 * server/courses.ts call in here; the rules live in core/coverage-items.ts (the mapping) and core/coverage-ledger.ts
 * (what the transcripts show).
 *
 *   - The class glossary is read through `coverageGlossary` (server/material-indexing.ts courseGlossary: computed from
 *     the digests on disk, cached by file stamps, never stored).
 *   - Each course chat's vocabulary evidence is cached per chat file like the course evidence cache (server/courses.ts):
 *     keyed by the file path, valid while its mtime, size and inode match AND the class's names are the same (the
 *     matcher's fingerprint), bounded, pruned of deleted chats. So a page load of a class with 50 sessions stats 50 files
 *     and folds cached results; a changed glossary re-scans each chat once.
 *   - No model call happens here except the "Map the class's terms" pass the student starts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { PATHS } from "../../config.ts";
import type { CourseCoverage, CourseCoverageView, CourseMode, CourseRecord, CoverageEntryView, CoverageTermView, LessonResult } from "../core/contracts.ts";
import {
	applyCoverageEdit,
	entryView,
	hasCoreEntries,
	itemKey,
	normalizeLinks,
	resolveCoverage,
	type CoverageEdit,
	type CoverageGlossary,
	type ResolvedCoverage,
} from "../core/coverage-items.ts";
import {
	buildMatcher,
	chatVocabularyOf,
	foldLedger,
	vocabularySection,
	type ChatVocabulary,
	type ItemLedger,
	type LedgerChat,
	type LessonVocabulary,
	type VocabularyMatcher,
	type VocabularyPromptItem,
} from "../core/coverage-ledger.ts";
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
export const COURSE_VOCABULARY_CACHE_VERSION = 1;
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
	for (const c of stores.chatStore.listChats()) {
		if (c.course?.courseId !== course.id || c.course.mode === "ask") continue;
		chats.push({ chatId: c.id, mode: c.course.mode, skillIds: c.course.skillIds, vocabulary: chatVocabulary(c.id, matcher, opts.cache !== false) });
	}
	return { glossary, resolved, matcher, chats };
}

const termView = (base: CoverageEntryView, l: ItemLedger | undefined, linked: string[]): CoverageTermView => ({
	...base,
	state: l?.checked ? "checked" : l?.introduced ? "introduced" : "new",
	...(l?.level ? { level: l.level } : {}),
	...(l?.right !== undefined ? { right: l.right } : {}),
	...(linked.length > 0 ? { linked } : {}),
});

const coreFirst = <T extends { tier: "core" | "supporting"; name: string }>(a: T, b: T) => (a.tier === b.tier ? a.name.localeCompare(b.name) : a.tier === "core" ? -1 : 1);

/** The course page's coverage block (CourseView.coverage); undefined when the class has no coverage behaviour at all. */
export function coverageView(course: CourseRecord, language: LessonLanguage, mapping: boolean, opts: { cache?: boolean } = {}): CourseCoverageView | undefined {
	const glossary = coverageGlossary(course.id);
	const status: CourseCoverageView["status"] = course.coverage ? "mapped" : hasCoreEntries(glossary) && course.skills.length > 0 ? "unmapped" : "none";
	const draft = course.draft?.coverage ? draftView(course, glossary) : undefined;
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
		view.skills[skillId] = { total: core.length, introduced: core.filter((t) => t.state !== "new").length, checked: core.filter((t) => t.state === "checked").length, terms };
	}
	view.unassigned = cc.resolved.unassigned.map((e) => entryView(e)).sort(coreFirst);
	view.flagged = cc.resolved.items.filter((i) => i.status === "flagged").map((i) => ({ key: i.key, name: i.item.name, skills: i.item.skills ?? [] }));
	view.excluded = cc.resolved.items.filter((i) => i.status === "excluded").map((i) => ({ key: i.key, name: i.view.name, reason: i.item.excluded ?? "" }));
	return view;
}

/** The approval screen's view of a draft's proposal. */
function draftView(course: CourseRecord, glossary: CoverageGlossary | null): NonNullable<CourseCoverageView["draft"]> {
	const proposal = course.draft!.coverage!;
	const resolved = resolveCoverage(proposal, glossary, null);
	const skills: Record<string, CoverageEntryView[]> = {};
	for (const s of course.draft!.skills) {
		skills[s.key] = resolved.items.filter((i) => i.status === "assigned" && i.skills.includes(s.key)).map((i) => i.view).sort(coreFirst);
	}
	const linkedTogether = (a: string, b: string) => resolved.group(a).includes(b);
	const duplicates = (glossary?.suggestedDuplicates ?? [])
		.flatMap((g) => g.pairs ?? [])
		.filter((p) => p.ids.every((id) => glossary!.terms[id]) && p.ids.some((id) => glossary!.terms[id]!.tier === "core"))
		.map((p) => ({ a: entryView(glossary!.terms[p.ids[0]]!), b: entryView(glossary!.terms[p.ids[1]]!), reasons: p.reasons, linked: linkedTogether(p.ids[0], p.ids[1]) }));
	return {
		skills,
		unassigned: resolved.unassigned.map((e) => entryView(e)).sort(coreFirst),
		excluded: resolved.items.filter((i) => i.status === "excluded").map((i) => ({ key: i.key, name: i.view.name, reason: i.item.excluded ?? "" })),
		duplicates,
		dropped: proposal.dropped,
		incomplete: proposal.incomplete,
		shown: proposal.shown,
	};
}

// ─── approval ───────────────────────────────────────────────────────────────

/** The core entries a draft's proposal leaves unassigned, read against the glossary now ([] for a draft without one). */
export function draftUnassigned(course: CourseRecord): Array<{ id: string; name: string }> {
	if (!course.draft?.coverage) return [];
	return resolveCoverage(course.draft.coverage, coverageGlossary(course.id), null).unassigned.map((e) => ({ id: e.id, name: e.term }));
}

// ─── a session's pieces ─────────────────────────────────────────────────────

/** What a Learn or Practice session on one skill gets: its prompt block, the finish check (Learn), and every live item
 *  key of the class (a question's unknown concept ids are counted against them). Undefined without coverage. */
export function sessionVocabulary(course: CourseRecord, chatId: string, skill: { id: string; name: string }, mode: CourseMode): { section: string; lesson?: LessonVocabulary; known: ReadonlySet<string> } | undefined {
	const cc = classCoverage(course);
	if (!cc) return undefined;
	const known = new Set(cc.resolved.items.filter((i) => i.status !== "flagged").map((i) => i.key));
	const items = cc.resolved.items.filter((i) => i.status === "assigned" && i.skills.includes(skill.id));
	if (items.length === 0) return { section: "", known };
	// the state as of this session's start: its own progress would change its prompt (and the prompt cache) every turn
	const others = foldLedger(cc.resolved, cc.glossary, cc.chats, chatId);
	const skillChats = new Set(cc.chats.filter((c) => c.chatId !== chatId && c.skillIds.includes(skill.id) && (c.mode === "learn" || c.mode === "practice")).map((c) => c.chatId));
	const nameOf = (k: string) => cc.resolved.byKey.get(k)?.view.name ?? k;
	const promptItems: VocabularyPromptItem[] = items.map((i) => {
		const l = others.get(i.key);
		const deferred = !!l && [...l.deferredIn].some((c) => skillChats.has(c));
		const carried = deferred || (!!l && [...l.seenIn].some((c) => skillChats.has(c)));
		const linked = cc.resolved.group(i.key).filter((k) => k !== i.key).map(nameOf);
		return {
			key: i.key,
			name: i.view.name,
			tier: i.view.tier,
			definition: i.view.definition,
			page: i.view.page,
			material: i.view.material,
			state: l?.checked ? "checked" : l?.introduced ? "introduced" : "new",
			carried,
			...(deferred && !l?.introduced ? { deferred: true } : {}),
			...(l?.level ? { level: l.level } : {}),
			...(l?.right !== undefined ? { right: l.right } : {}),
			...(linked.length > 0 ? { linked } : {}),
		};
	});
	const section = vocabularySection(skill.name, promptItems, mode);
	if (mode !== "learn") return { section, known };
	const introducedElsewhere = new Set([...others].filter(([, l]) => l.introduced).map(([k]) => k));
	const coreItems = items.filter((i) => i.tier === "core").map((i) => ({ key: i.key, name: i.view.name, group: cc.resolved.group(i.key) }));
	const lesson: LessonVocabulary = {
		items: coreItems,
		introduced: (messages: readonly LhMessage[]) => {
			const live = foldLedger(cc.resolved, cc.glossary, [{ chatId, mode, skillIds: [skill.id], vocabulary: chatVocabularyOf(messages, cc.matcher) }]);
			const out = new Set(introducedElsewhere);
			for (const [k, l] of live) if (l.introduced) out.add(k);
			return out;
		},
	};
	return { section, lesson, known };
}

/** The lesson result's coverage line: the skill's core terms, how many were introduced, and those left. */
export function lessonCoverage(course: CourseRecord, skillId: string, language: LessonLanguage): LessonResult["coverage"] | undefined {
	const cc = classCoverage(course);
	if (!cc) return undefined;
	const items = cc.resolved.items.filter((i) => i.status === "assigned" && i.tier === "core" && i.skills.includes(skillId));
	if (items.length === 0) return undefined;
	const ledger = foldLedger(cc.resolved, cc.glossary, cc.chats);
	const left = items.filter((i) => !ledger.get(i.key)?.introduced).map((i) => i.view.name);
	return { total: items.length, covered: items.length - left.length, left, language };
}

// ─── the student's edits ────────────────────────────────────────────────────

/** Edit the approved mapping ("approved"; started empty on a class that has core terms and none) or the draft's
 *  proposal ("draft"). */
export function editCourseCoverage(courseId: string, target: "approved" | "draft", edit: CoverageEdit): Result<CourseRecord> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	const glossary = coverageGlossary(courseId);
	if (target === "draft") {
		if (!course.draft?.coverage) return { ok: false, status: 409, error: "The draft has no vocabulary mapping" };
		const applied = applyCoverageEdit(course.draft.coverage, edit, { glossary, skills: new Set(course.draft.skills.map((s) => s.key)) });
		if (!applied.ok) return { ok: false, status: 400, error: applied.error };
		const updated = stores.courseStore.updateCourse(courseId, { draft: { ...course.draft, coverage: { ...course.draft.coverage, ...applied.value } } })!;
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

/** Start the mapping-only pass: it assigns the class's core terms to the APPROVED skills (changing no skill) and adds an
 *  item for every entry that has none yet; existing items are kept as they are. Returns at once. */
export function startCourseTermMapping(courseId: string, language: LessonLanguage): Result<CourseRecord> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	if (course.skills.length === 0) return { ok: false, status: 409, error: "Approve the skill map first" };
	if (mapRuns().has(courseId)) return { ok: false, status: 409, error: "The terms are already being mapped" };
	if (!hasCoreEntries(coverageGlossary(courseId))) return { ok: false, status: 409, error: "The class has no indexed terms to map (index its PDFs first)" };
	const controller = new AbortController();
	mapRuns().set(courseId, controller);
	const updated = stores.courseStore.updateCourse(courseId, { coverageError: undefined })!;
	void runMapping(courseId, language, controller).finally(() => mapRuns().delete(courseId));
	return { ok: true, value: updated };
}

async function runMapping(courseId: string, language: LessonLanguage, controller: AbortController): Promise<void> {
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
		const graph = stores.skillStore.readSkillLines();
		const byId = new Map<string, { name: string; statement: string }>();
		for (const line of graph) if (!byId.has(line.id) || line.reworded) byId.set(line.id, { name: line.name, statement: line.statement });
		const skills = course.skills.filter((id) => byId.has(id)).map((id) => ({ id, ...byId.get(id)! }));
		const tools: Record<string, AgentTool<any>> = { ...materialTools({ chatId: courseId, store: stores.materialStore }) };
		const proposal = await mapCourseTerms({ title: course.title, skills, glossary, language }, { engine: piEngineForSpec(spec), signal: controller.signal, tools, onStep: () => {}, courseId });
		const fresh = stores.courseStore.getCourse(courseId);
		if (!fresh || controller.signal.aborted) return;
		// keep what is there (the student's own edits); add an item for each key that has none
		const existing = fresh.coverage ?? { updatedAt: "", items: [], links: [] };
		const have = new Set(existing.items.map(itemKey));
		const live = new Set(fresh.skills);
		const added = proposal.items
			.filter((i) => !have.has(itemKey(i)))
			.map((i) => ({ ...i, ...(i.skills ? { skills: i.skills.filter((s) => live.has(s)) } : {}) }))
			.filter((i) => (i.skills ?? []).length > 0 || i.excluded !== undefined);
		settle({
			coverage: { updatedAt: new Date().toISOString(), items: [...existing.items, ...added], links: normalizeLinks([...existing.links, ...proposal.links]) },
			coverageError: proposal.dropped.length > 0 ? `The planner named ${proposal.dropped.length} term id(s) that are not in the glossary; they were dropped: ${proposal.dropped.slice(0, 8).join(", ")}` : undefined,
		});
	} catch (err) {
		if (controller.signal.aborted) return;
		settle({ coverageError: err instanceof Error ? err.message : String(err) });
	}
}

/** The leave-unassigned reason, in the class's language. */
export const leftAtApprovalReason = (language: LessonLanguage): string => lessonLabels(language).coverage.leftAtApproval;
