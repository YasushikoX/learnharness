/**
 * The vocabulary coverage LEDGER (WP5, 2026-11-25, reworked after review 1; spec: docs/courses.md "Vocabulary
 * coverage"). PURE, browser-safe.
 *
 * Nothing here is stored: what each coverage item (core/coverage-items.ts) has had in the class's sessions is DERIVED
 * from the transcripts, like skill evidence (server/courses.ts courseEvidence), and cached per chat file by the server.
 * The guiding rule: a false "introduced" is the costly error (a term is skipped silently); a false "new" costs one
 * repeated mention. Every uncertain case below resolves to "not introduced".
 *
 *   INTRODUCED: the entry's name or one of its aliases appeared in text the learner actually saw in a session of the
 *     class, and that name is unambiguous in the class (findTermCandidates gives exactly one entry, or every candidate is
 *     in one link group). Nothing else introduces: a question's tag never does.
 *   CHECKED: the learner answered (not dismissed, not refused, not skipped) a `quiz` or `explain` whose `conceptIds`
 *     resolves to the item (resolveConceptId). The best `level` reached is kept, and whether any such answer was graded
 *     right. Independent of introduced: a question tagged with a term it never names leaves the term CHECKED and NOT
 *     introduced ("asked about, never named"), which the prompt, the page and the finish gate show as such.
 *
 * WHAT THE LEARNER SAW is core/learner-seen.ts (one definition, shared with the cards that render it), read over the
 * transcript view (core/view.ts projectView). The answers are read through the same view, so an answer pairs with the
 * question occurrence it answers (the view's most-recent-call rule), never with a legacy duplicate of its call id.
 *
 * MATCHING RULES (docs/courses.md has them as a table), on the visible text (core/visible-text.ts):
 *   - Exact spelling, on word boundaries: a name matches where it starts at a word start and the next character is not a
 *     letter, digit or mark ("ring" is not in "string", "rings" or "ring2"), also when the name ends in punctuation
 *     ("C++" is not in "C++foo"). Texts and names are compared after normalizeName's invisible-character, NFC and space
 *     folding and with typographic quotes read as plain ones.
 *   - A hyphen joins a word: a name preceded or followed by a hyphen that touches a letter or digit is part of a longer
 *     word and does not match ("sub-ring" does not introduce "ring"; "R-module" is one word). So do an en dash, an em
 *     dash without spaces, a minus sign, a non-breaking hyphen and an underscore (review 2: "sub–ring", "ring_buffer");
 *     a soft hyphen is removed, and a line-break hyphen joins its halves (core/visible-text.ts).
 *   - Emphasis markers are removed before words are formed ("**sub**group" is "subgroup"), and inline code counts
 *     nothing (core/visible-text.ts).
 *   - Longest match wins: where a longer name of the class covers a span, the shorter names inside that span are not
 *     credited by it ("ring homomorphism" does not introduce "ring").
 *   - Case: exact, with one exception: a name stored in lower case at its start (the glossary keeps running-text forms)
 *     also matches with its first letter capitalised AT THE START OF A SENTENCE (start of a line, which is where every
 *     heading, list item and table cell starts in the visible text, or after ".", "!", "?" or ":"). All-caps text never
 *     matches a lower-case name.
 *   - Inflections are NOT matched unless the inflected form is an alias of the entry, or is itself an entry linked with it.
 *   - Symbols never introduce anything.
 *   - Senses of a homonym: a mention credits a sense only when exactly ONE sense of that entry is eligible in the
 *     session (assigned to one of its skills). With two or more eligible senses a bare mention introduces none of them;
 *     a sense is then introduced when its word was seen in the session AND the learner answered a question of that
 *     session tagged with that sense's key (review 2: the tag alone still introduces nothing, the name alone neither).
 *   - Ask conversations count for nothing, and nor do chats outside the class.
 *
 * NOTHING HERE THROWS (review 2, "nothing in one chat may break the class"): a text that cannot be reduced or matched
 * counts nothing (core/learner-seen.ts, matchNames); a chat whose record cannot be read counts nothing
 * (chatVocabularyOf returns `failed`); a chat whose fold fails counts nothing (foldLedger's `onChatError`).
 */

import type { CourseMode, CoverageTermState } from "./contracts/course.ts";
import type { CoverageGlossary, ResolvedCoverage } from "./coverage-items.ts";
import { findTermCandidates, normalizeName, plainQuotes, stripInvisible } from "./glossary.ts";
import { readAnswerVerdict } from "./lead-floor-gate.ts";
import { pendingQuestionAt, seenTextsOfView, type SeenReading } from "./learner-seen.ts";
import type { LhMessage } from "./native-messages.ts";
import type { QuestionAnswerData } from "./question-core.ts";
import { normalizeConceptIds, normalizeQuestionLevel, QUESTION_LEVELS, type QuestionLevel } from "./question-quality.ts";
import { FINISH_LESSON_TOOL, sessionFinishOf, VOCABULARY_REFUSAL_HEAD } from "./course-session.ts";
import { projectView, type LhViewPart } from "./view.ts";

// ─── what the learner saw ───────────────────────────────────────────────────

/** Every text the learner was shown in a transcript, in order, as the screen shows it (core/learner-seen.ts): an
 *  unanswered question only when it is the dock's pending one. Pure. */
export function learnerSeenTexts(messages: readonly LhMessage[], reading?: SeenReading): string[] {
	return seenTextsOfView(projectView(messages), pendingQuestionAt(messages), reading);
}

// ─── the name matcher ───────────────────────────────────────────────────────

const WORD_RUN = /[\p{L}\p{N}\p{M}]+/gu;
const WORD_CHAR = /^[\p{L}\p{N}\p{M}]$/u;
const FIRST_WORD = /^[\p{L}\p{N}\p{M}]+/u;
/** Characters that join the words on either side into one (when they touch a letter or digit on the other side). */
const JOINERS = new Set(["-", "\u2010", "\u2011", "\u2013", "\u2014", "\u2212", "_"]);

/** A text or a name as matching reads it: invisible characters out, NFC, typographic quotes plain, runs of spaces and
 *  tabs as one space (line breaks kept: they start sentences). */
export function matchText(text: string): string {
	return plainQuotes(stripInvisible(text).normalize("NFC")).replace(/[^\S\n]+/gu, " ");
}

/** The class's names, indexed for one pass over a text. */
export interface VocabularyMatcher {
	/** A fingerprint of the names: a cached chat scan is valid only for the same one. */
	key: string;
	/** First word of a name → the names that start with it. */
	byFirst: Map<string, string[]>;
	/** Names that do not start with a letter or digit (rare; found by a plain search). */
	odd: string[];
}

function fnv(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}

/** Bump when the matching rules change: cached chat scans made under older rules are then redone. */
const MATCH_RULES_VERSION = 3;

/** The matcher over every entry's name and aliases (never its symbols). Pure. */
export function buildMatcher(glossary: Pick<CoverageGlossary, "terms">): VocabularyMatcher {
	const forms = new Set<string>();
	for (const e of Object.values(glossary.terms)) {
		for (const name of [e.term, ...e.aliases]) {
			const form = matchText(normalizeName(name));
			if (form.trim() !== "" && /[\p{L}\p{N}]/u.test(form)) forms.add(form);
		}
	}
	const sorted = [...forms].sort();
	const byFirst = new Map<string, string[]>();
	const odd: string[] = [];
	for (const form of sorted) {
		const first = FIRST_WORD.exec(form)?.[0];
		if (!first) odd.push(form);
		else byFirst.set(first, [...(byFirst.get(first) ?? []), form]);
	}
	return { key: `r${MATCH_RULES_VERSION}:${sorted.length}:${fnv(sorted.join("\u0000"))}`, byFirst, odd };
}

/** The code point ending just before `i` ("" at the start). */
function before(text: string, i: number): string {
	if (i <= 0) return "";
	const low = text.charCodeAt(i - 1);
	if (low >= 0xdc00 && low <= 0xdfff && i >= 2) return text.slice(i - 2, i);
	return text[i - 1]!;
}
/** The code point starting at `i` ("" at the end). */
function after(text: string, i: number): string {
	if (i >= text.length) return "";
	return String.fromCodePoint(text.codePointAt(i)!);
}
const isWord = (ch: string) => ch !== "" && WORD_CHAR.test(ch);

/** Can a name start at `i`? Not inside a word, and not right after a hyphen that is joined to a word before it. */
function startsClean(text: string, i: number): boolean {
	const prev = before(text, i);
	if (isWord(prev)) return false;
	if (JOINERS.has(prev) && isWord(before(text, i - prev.length))) return false;
	return true;
}
/** Can a name end at `end`? The next character is not a word character, nor a hyphen joined to a word after it. */
function endsClean(text: string, end: number): boolean {
	const next = after(text, end);
	if (isWord(next)) return false;
	if (JOINERS.has(next) && isWord(after(text, end + next.length))) return false;
	return true;
}

const SKIP_BACK = /[\s*_#>\-•"'“”‘’(\[«»|]/u;

/** Does position `i` start a sentence (see the module comment)? */
function sentenceStart(text: string, i: number): boolean {
	let k = i - 1;
	while (k >= 0 && SKIP_BACK.test(text[k]!)) {
		if (text[k] === "\n") return true;
		k--;
	}
	return k < 0 || /[.!?:]/u.test(text[k]!);
}

/** The text from `i` with its first character lower-cased, as long as `form`. */
function loweredSlice(text: string, i: number, form: string): string {
	const slice = text.slice(i, i + form.length);
	const [head, ...tail] = [...slice];
	return head === undefined ? "" : head.toLowerCase() + tail.join("");
}

interface Span {
	start: number;
	end: number;
	form: string;
}

/** Every name of the matcher that occurs in the (visible) text under the rules above, longest match winning. Never
 *  throws: a text that cannot be matched gives nothing. Pure. */
export function matchNames(rawText: string, m: VocabularyMatcher): Set<string> {
	try {
		return typeof rawText === "string" ? namesIn(rawText, m) : new Set();
	} catch {
		return new Set();
	}
}

function namesIn(rawText: string, m: VocabularyMatcher): Set<string> {
	const text = matchText(rawText);
	const spans: Span[] = [];
	for (const w of text.matchAll(WORD_RUN)) {
		const i = w.index!;
		const word = w[0];
		if (!startsClean(text, i)) continue;
		for (const form of m.byFirst.get(word) ?? []) {
			if (text.startsWith(form, i) && endsClean(text, i + form.length)) spans.push({ start: i, end: i + form.length, form });
		}
		const [head, ...tail] = [...word];
		if (head && head !== head.toLowerCase() && sentenceStart(text, i)) {
			const lowered = head.toLowerCase() + tail.join("");
			for (const form of m.byFirst.get(lowered) ?? []) {
				if (loweredSlice(text, i, form) === form && endsClean(text, i + form.length)) spans.push({ start: i, end: i + form.length, form });
			}
		}
	}
	for (const form of m.odd) {
		for (let i = text.indexOf(form); i >= 0; i = text.indexOf(form, i + 1)) {
			if (startsClean(text, i) && endsClean(text, i + form.length)) spans.push({ start: i, end: i + form.length, form });
		}
	}
	// longest match wins: a span inside a longer one credits nothing. One sweep (n log n): spans by start, longer first;
	// a span is covered when an earlier one in that order reaches as far (spans of the same extent are one name read two
	// ways, the same form, and never cover each other).
	spans.sort((a, b) => a.start - b.start || b.end - a.end);
	const found = new Set<string>();
	let reach = -1;
	let reachStart = -1;
	for (const s of spans) {
		const covered = reach >= s.end && !(reachStart === s.start && reach === s.end);
		if (!covered) found.add(s.form);
		if (s.end > reach) {
			reach = s.end;
			reachStart = s.start;
		}
	}
	return found;
}

// ─── reading a question's conceptIds ────────────────────────────────────────

/**
 * The one reader of a question's `conceptIds` (the ledger and the turn timeline use it): an exact item key; an id
 * written with the prompt's brackets ("[t_ring]"); or a term's name or alias when it names exactly one item of the class
 * (or one linked group). Anything else is unknown: [] (ignored, counted in the timeline, never refused). Returns the
 * item's live link group. Pure.
 */
export function resolveConceptId(raw: string, glossary: Pick<CoverageGlossary, "terms" | "lookup">, resolved: ResolvedCoverage): string[] {
	let id = typeof raw === "string" ? raw.trim() : "";
	const bracketed = /^\[(.+)\]$/u.exec(id);
	if (bracketed) id = bracketed[1]!.trim();
	if (id === "") return [];
	const live = (key: string) => {
		const item = resolved.byKey.get(key);
		return item !== undefined && item.status !== "flagged";
	};
	if (live(id)) return resolved.group(id);
	if (bracketed) return [];
	const entries = new Set(findTermCandidates(glossary, id).filter((c) => c.matchedBy.includes("name") || c.matchedBy.includes("alias")).map((c) => c.entry.id));
	if (entries.size === 0) return [];
	const keys = resolved.items.filter((i) => i.status !== "flagged" && entries.has(i.item.entryId)).map((i) => i.key);
	if (keys.length === 0) return [];
	const group = resolved.group(keys[0]!);
	return keys.every((k) => group.includes(k)) ? group : [];
}

// ─── one chat's vocabulary evidence (cached per chat file by the server) ────

/** An answered teach question's tags (as written; resolved against the mapping when folded). */
export interface VocabularyCheck {
	ids: string[];
	level?: QuestionLevel;
	/** Graded right (quiz: the recorded answer; explain: the tutor's `previous` on the next question); null = not graded yet. */
	right: boolean | null;
}

/** What one chat holds for the ledger. */
export interface ChatVocabulary {
	/** The matcher's names found in what the learner saw. */
	forms: string[];
	checks: VocabularyCheck[];
	/** The ids the clean `finish_lesson` deferred with a reason. */
	deferred: string[];
	/** The chat's record could not be read: it counts nothing (the server reports it once). */
	failed?: true;
	/** How many texts the learner saw were not read (too long, too deep, or a record that failed): they count nothing. */
	unread?: number;
}

const TEACH_PARTS = new Set(["tool-quiz", "tool-explain"]);

/** A chat's vocabulary evidence: the names seen, the answered tagged questions, and the lesson's deferred ids. Never
 *  throws: a chat whose record cannot be read is `failed` and counts nothing. Pure. */
export function chatVocabularyOf(messages: readonly LhMessage[], matcher: VocabularyMatcher): ChatVocabulary {
	try {
		const list = Array.isArray(messages) ? messages : [];
		const reading = { unread: 0 };
		const forms = new Set<string>();
		for (const text of learnerSeenTexts(list, reading)) for (const f of matchNames(text, matcher)) forms.add(f);
		return { forms: [...forms].sort(), checks: checksOf(list), deferred: deferredOf(list), ...(reading.unread > 0 ? { unread: reading.unread } : {}) };
	} catch {
		return { forms: [], checks: [], deferred: [], failed: true };
	}
}

/** The answered quiz/explain occurrences that carry concept ids, with their level and grade, read through the view so
 *  each answer belongs to the question occurrence it answers. Dismissed (skipped or set aside) and refused ones check
 *  nothing. Pure. */
export function checksOf(messages: readonly LhMessage[]): VocabularyCheck[] {
	const parts: LhViewPart[] = [];
	for (const m of projectView(messages)) if (m.role === "assistant") for (const p of m.parts) if (TEACH_PARTS.has(p.type)) parts.push(p);
	const checks: VocabularyCheck[] = [];
	parts.forEach((part, i) => {
		try {
			checkOf(part, i);
		} catch {
			// a record that cannot be read checks nothing
		}
	});
	return checks;
	function checkOf(part: LhViewPart, i: number): void {
		if (part.state !== "output-available") return;
		const answer = part.output as QuestionAnswerData | null | undefined;
		if (!answer || typeof answer !== "object" || answer.dismissed === true) return;
		const args = (part.input && typeof part.input === "object" ? part.input : {}) as Record<string, unknown>;
		const ids = normalizeConceptIds(args.conceptIds) ?? [];
		if (ids.length === 0) return;
		const verdict = readAnswerVerdict({ content: part.result?.content ?? [], details: answer } as never);
		let right: boolean | null = verdict === "hit" ? true : verdict === "miss" ? false : null;
		if (right === null) {
			const next = parts.slice(i + 1).find((p) => p.state !== "output-error");
			const raw = (next?.input as { previous?: unknown } | undefined)?.previous;
			const previous = typeof raw === "string" ? raw.trim().toLowerCase() : "";
			if (previous === "right") right = true;
			else if (previous === "partly" || previous === "wrong") right = false;
		}
		const level = normalizeQuestionLevel(args.level);
		checks.push({ ids, ...(level ? { level } : {}), right });
	}
}

/** The ids `finish_lesson` deferred in a lesson that finished (its clean call); [] otherwise. Pure. */
export function deferredOf(messages: readonly LhMessage[]): string[] {
	const finish = sessionFinishOf(messages);
	if (!finish?.callId) return [];
	for (const m of messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		for (const b of (m as unknown as { content: Array<{ type: string; id?: string; arguments?: unknown }> }).content) {
			if (b.type === "toolCall" && b.id === finish.callId) return deferredIdsOf((b.arguments as { deferred?: unknown } | undefined)?.deferred);
		}
	}
	return [];
}

/** The ids of a `deferred` argument ([{ id, why }]) that carry a reason; [] when absent (the field is optional). A
 *  deferral without a non-blank `why` defers nothing. Pure. */
export function deferredIdsOf(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const d of raw) {
		if (!d || typeof d !== "object") continue;
		const { id, why } = d as { id?: unknown; why?: unknown };
		if (typeof id !== "string" || id.trim() === "" || typeof why !== "string" || why.trim() === "") continue;
		if (!out.includes(id.trim())) out.push(id.trim());
	}
	return out;
}

// ─── the fold ───────────────────────────────────────────────────────────────

/** One chat as the fold reads it. */
export interface LedgerChat {
	chatId: string;
	mode: CourseMode;
	skillIds: readonly string[];
	vocabulary: ChatVocabulary;
	/** When the session started (ms since the epoch), for "oldest first". */
	startedAt?: number;
	/** The item keys listed to it when it started (its stored listing; absent when it has none). */
	listed?: readonly string[];
}

export interface ItemLedger {
	/** Named in what the learner saw (never by a tag alone). */
	introduced: boolean;
	/** An answered question was tagged with it. */
	checked: boolean;
	level?: QuestionLevel;
	right?: boolean;
	/** The chats it was introduced or checked in. */
	seenIn: Set<string>;
	/** The chats it was introduced in. */
	introducedIn: Set<string>;
	/** The chats whose finished lesson deferred it. */
	deferredIn: Set<string>;
}

/** An item's state as the screens and the prompt show it: new, introduced (not checked), checked (and introduced), or
 *  asked (checked, never named). Pure. */
export function itemState(l: Pick<ItemLedger, "introduced" | "checked"> | undefined): CoverageTermState {
	if (!l) return "new";
	if (l.checked) return l.introduced ? "checked" : "asked";
	return l.introduced ? "introduced" : "new";
}

const levelRank = (l: QuestionLevel | undefined) => (l ? QUESTION_LEVELS.indexOf(l) : -1);

/** Which item keys a name introduces in a chat of these skills (none when the name is ambiguous in the class, and none
 *  for a homonym with two or more senses eligible in the chat). Pure. */
export function keysForName(form: string, glossary: Pick<CoverageGlossary, "terms" | "lookup">, resolved: ResolvedCoverage, chatSkills: ReadonlySet<string>): string[] {
	return namedKeys(form, glossary, resolved, chatSkills).keys;
}

/** What naming a word does in a chat of these skills: the keys it introduces, and the senses it names without
 *  introducing (a homonym with two or more senses eligible in the chat; each is introduced only with a sense-keyed
 *  answered check of the same chat). Pure. */
export function namedKeys(form: string, glossary: Pick<CoverageGlossary, "terms" | "lookup">, resolved: ResolvedCoverage, chatSkills: ReadonlySet<string>): { keys: string[]; senses: string[] } {
	const entries = findTermCandidates(glossary, form).map((c) => c.entry.id);
	if (entries.length === 0) return { keys: [], senses: [] };
	if (entries.length > 1) {
		// unambiguous only when every candidate is one linked concept
		const group = new Set(resolved.group(entries[0]!));
		if (!entries.every((id) => group.has(id))) return { keys: [], senses: [] };
	}
	const keys: string[] = [];
	const senses: string[] = [];
	for (const entryId of entries) {
		const items = resolved.items.filter((i) => i.status !== "flagged" && i.item.entryId === entryId);
		for (const i of items) if (!i.item.sense) keys.push(i.key);
		const eligible = items.filter((i) => i.item.sense && i.skills.some((s) => chatSkills.has(s)));
		if (eligible.length === 1) keys.push(eligible[0]!.key);
		else for (const i of eligible) senses.push(i.key);
	}
	return { keys, senses };
}

/** Every item's ledger from the class's chats (an Ask chat counts for nothing). `exclude`: leave one chat out (the
 *  session a prompt is built for, so its own progress does not change its prompt mid-session). Never throws: a chat
 *  whose fold fails counts nothing and is passed to `onChatError`. Pure. */
export function foldLedger(
	resolved: ResolvedCoverage,
	glossary: Pick<CoverageGlossary, "terms" | "lookup">,
	chats: readonly LedgerChat[],
	exclude?: string,
	onChatError?: (chatId: string, err: unknown) => void,
): Map<string, ItemLedger> {
	const ledger = new Map<string, ItemLedger>();
	for (const item of resolved.items) if (item.status !== "flagged") ledger.set(item.key, { introduced: false, checked: false, seenIn: new Set(), introducedIn: new Set(), deferredIn: new Set() });
	const nameCache = new Map<string, { keys: string[]; senses: string[] }>();
	const idCache = new Map<string, string[]>();
	const idKeys = (id: string) => {
		let keys = idCache.get(id);
		if (!keys) idCache.set(id, (keys = resolveConceptId(id, glossary, resolved)));
		return keys;
	};
	for (const chat of chats) {
		if (chat.mode === "ask" || chat.chatId === exclude) continue;
		// one chat's marks are worked out first and applied only when the whole chat was read
		let marks: { introduced: string[]; checks: Array<{ keys: string[]; check: VocabularyCheck }>; deferred: string[] };
		try {
			marks = chatMarks(chat);
		} catch (err) {
			onChatError?.(chat.chatId, err);
			continue;
		}
		for (const key of marks.introduced) {
			for (const k of resolved.group(key)) {
				const l = ledger.get(k);
				if (!l) continue;
				l.introduced = true;
				l.introducedIn.add(chat.chatId);
				l.seenIn.add(chat.chatId);
			}
		}
		for (const { keys, check } of marks.checks) {
			for (const key of keys) {
				for (const k of resolved.group(key)) {
					const l = ledger.get(k);
					if (!l) continue;
					l.checked = true;
					if (levelRank(check.level) > levelRank(l.level)) l.level = check.level;
					if (check.right === true) l.right = true;
					else if (check.right === false && l.right === undefined) l.right = false;
					l.seenIn.add(chat.chatId);
				}
			}
		}
		for (const k of marks.deferred) ledger.get(k)?.deferredIn.add(chat.chatId);
	}
	return ledger;

	function chatMarks(chat: LedgerChat) {
		const skills = new Set(Array.isArray(chat.skillIds) ? chat.skillIds : []);
		const skillKey = [...skills].sort().join(",");
		const introduced: string[] = [];
		const namedSenses = new Set<string>();
		for (const form of chat.vocabulary.forms) {
			const cacheKey = `${skillKey}\u0000${form}`;
			let named = nameCache.get(cacheKey);
			if (!named) nameCache.set(cacheKey, (named = namedKeys(form, glossary, resolved, skills)));
			introduced.push(...named.keys);
			for (const k of named.senses) namedSenses.add(k);
		}
		const checks: Array<{ keys: string[]; check: VocabularyCheck }> = [];
		for (const check of chat.vocabulary.checks) {
			for (const id of check.ids) {
				const keys = idKeys(id);
				checks.push({ keys, check });
				// a sense whose word was named in this chat is introduced by an answered check tagged with it (review 2)
				for (const k of keys) if (namedSenses.has(k)) introduced.push(k);
			}
		}
		const deferred = chat.vocabulary.deferred.flatMap(idKeys);
		return { introduced, checks, deferred };
	}
}

// ─── the lesson's prompt section ────────────────────────────────────────────

/** The most terms one session is LISTED, and so owes (see listVocabulary for the order). A lesson teaches one skill in
 *  roughly half an hour, a new term every two or three minutes is already dense, and a checklist longer than this stops
 *  being one the tutor can keep in view; the rest of the skill's terms go to the next sessions. */
export const VOCABULARY_PROMPT_MAX = 12;
/** The most of those places that go to terms introduced but not checked while a term not yet introduced is waiting
 *  (review 2, finding 2: checks of old terms must never starve the new ones). */
export const VOCABULARY_TO_CHECK_MAX = 4;
/** The most already-done terms named (without definition) on one line. */
export const VOCABULARY_CHECKED_MAX = 20;
/** The most other names of a linked term shown on its line. */
export const VOCABULARY_LINKED_MAX = 4;
const DEFINITION_CHARS = 260;

export interface VocabularyPromptItem {
	key: string;
	name: string;
	tier: "core" | "supporting";
	definition: string | null;
	page: number | null;
	material: string | null;
	state: CoverageTermState;
	/** Introduced, checked or deferred in an earlier session of this skill. */
	carried: boolean;
	/** How many earlier lessons of this skill deferred it. */
	deferredCount?: number;
	level?: QuestionLevel;
	right?: boolean;
	/** Other names linked with it (one concept). */
	linked?: string[];
	/** For a sense of a homonym: how many senses of its word this session has (2 or more: a bare mention introduces none). */
	senses?: number;
	/** How many earlier sessions of this skill (Learn or Practice) were listed it (their stored listing). */
	listedBefore?: number;
	/** Where the material introduces it (smaller first; the class's teaching order). */
	order?: number;
	/** When it was first introduced (the earliest session's start, ms since the epoch), for "oldest first". */
	introducedAt?: number;
}

const flat = (t: string, max: number) => {
	const s = t.replace(/\s+/g, " ").trim();
	return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
};

const isOpen = (i: VocabularyPromptItem) => i.state !== "checked";
const notIntroduced = (i: VocabularyPromptItem) => i.state === "new" || i.state === "asked";

/**
 * Which of a skill's items a session is listed (review 2, finding 2: no term is starved), at most
 * VOCABULARY_PROMPT_MAX, filled in this order:
 *   1. core terms never listed to an earlier session of this skill (and not introduced), in the order the material
 *      introduces them;
 *   2. core terms listed before but still not introduced (deferred or ignored), fewest earlier listings first;
 *   3. core terms introduced but not checked, oldest first (first introduced earliest, then fewest listings); at most
 *      VOCABULARY_TO_CHECK_MAX places go to these while any term of 1 or 2 is waiting;
 *   4. supporting terms still open, not introduced first, with whatever places are left.
 * Practice sessions of the skill take part like Learn sessions (they are listed and can introduce and check). The
 * session owes exactly these (the core ones not yet introduced); its section counts the rest as left for later. Pure.
 */
export function listVocabulary(items: readonly VocabularyPromptItem[]): string[] {
	const open = items.map((item, i) => ({ item, i })).filter((x) => isOpen(x.item));
	type X = (typeof open)[number];
	const order = (x: X) => x.item.order ?? x.i;
	const listings = (x: X) => x.item.listedBefore ?? 0;
	const byOrder = (a: X, b: X) => order(a) - order(b) || a.i - b.i;
	const core = open.filter((x) => x.item.tier === "core");
	const fresh = core.filter((x) => notIntroduced(x.item) && listings(x) === 0).sort(byOrder);
	const again = core.filter((x) => notIntroduced(x.item) && listings(x) > 0).sort((a, b) => listings(a) - listings(b) || byOrder(a, b));
	const age = (x: X) => x.item.introducedAt ?? Number.MAX_SAFE_INTEGER;
	// fewest listings first, then oldest: with a tutor that never checks, every introduced term still comes round
	// again (by age alone the first twelve would be offered for a check for ever and the rest never)
	const toCheck = core.filter((x) => x.item.state === "introduced").sort((a, b) => listings(a) - listings(b) || age(a) - age(b) || byOrder(a, b));
	const supporting = open
		.filter((x) => x.item.tier !== "core")
		.sort((a, b) => Number(!notIntroduced(a.item)) - Number(!notIntroduced(b.item)) || listings(a) - listings(b) || byOrder(a, b));
	const waiting = [...fresh, ...again];
	const share = Math.min(VOCABULARY_TO_CHECK_MAX, toCheck.length);
	const checkPlaces = waiting.length > VOCABULARY_PROMPT_MAX - share ? share : Math.min(toCheck.length, VOCABULARY_PROMPT_MAX - waiting.length);
	const picked = [...waiting.slice(0, VOCABULARY_PROMPT_MAX - checkPlaces), ...toCheck.slice(0, checkPlaces)];
	picked.push(...supporting.slice(0, VOCABULARY_PROMPT_MAX - picked.length));
	return picked.map((x) => x.item.key);
}

function stateText(i: VocabularyPromptItem): string {
	const carried = i.carried ? " (carried over)" : "";
	const deferred = i.deferredCount ? `, left for later by ${i.deferredCount === 1 ? "an earlier lesson" : `${i.deferredCount} earlier lessons`}` : "";
	switch (i.state) {
		case "new":
			return `new${deferred}${carried}`;
		case "asked":
			return `asked about in an earlier session but never named, so not introduced yet${deferred}${carried}`;
		case "introduced":
			return `introduced${i.carried ? " in an earlier session" : ""}, not checked yet${carried}`;
		default:
			return "introduced and checked";
	}
}

/**
 * The vocabulary block of a Learn or Practice session's course section: the items LISTED to this session (`listed`, the
 * keys stored with it when it started: listVocabulary), each with its id, the material's definition and page, and its
 * state; the skill's done terms on one line by name; and how many terms are left for later sessions (`later`). "" when
 * nothing is listed and nothing is done. Pure.
 */
export function vocabularySection(skillName: string, listed: readonly VocabularyPromptItem[], mode: CourseMode, opts: { done?: readonly VocabularyPromptItem[]; later?: number } = {}): string {
	const done = opts.done ?? [];
	const later = opts.later ?? 0;
	if (listed.length === 0 && done.length === 0) return "";
	const line = (i: VocabularyPromptItem) => {
		const where = [i.material, i.page !== null ? `p. ${i.page}` : null].filter(Boolean).join(", ");
		const definition = i.definition !== null ? `The material: "${flat(i.definition, DEFINITION_CHARS)}"${where ? ` (${where})` : ""}` : `The material uses it without defining it${where ? ` (${where})` : ""}.`;
		const names = i.linked ?? [];
		const shownNames = names.slice(0, VOCABULARY_LINKED_MAX);
		const linked = names.length > 0 ? ` Also named: ${shownNames.join(", ")}${names.length > shownNames.length ? ` (+${names.length - shownNames.length} more)` : ""}.` : "";
		const sense =
			i.senses && i.senses > 1
				? ` One of ${i.senses} senses of "${i.name}" in this lesson (this one: ${where || "its own page"}): naming the word alone introduces none of them. Name the word, explain this sense, and check it with a question tagged with this exact id: the name seen and that answered check together introduce this sense and check it. List it in \`deferred\` if you leave it.`
				: "";
		return `- [${i.key}] ${i.name}${i.tier === "supporting" ? " (supporting)" : ""} — ${stateText(i)}. ${definition}${linked}${sense}`;
	};
	const body: string[] = [];
	if (listed.length > 0) {
		body.push(
			`VOCABULARY — the class's own terms that this ${mode === "learn" ? "lesson" : "session"} of "${skillName}" owes (from the class glossary, built from its material). The [id] in brackets is what \`conceptIds\` takes:`,
			...listed.map(line),
		);
	} else {
		body.push(`VOCABULARY — "${skillName}" owes no new term in this ${mode === "learn" ? "lesson" : "session"}.`);
	}
	if (later > 0) body.push(`(${later} more term${later === 1 ? "" : "s"} of this skill ${later === 1 ? "is" : "are"} left for later sessions; not owed by this one.)`);
	if (done.length > 0) {
		const names = done.slice(0, VOCABULARY_CHECKED_MAX).map((i) => `${i.name} [${i.key}]${i.level ? ` (${i.level}${i.right ? ", right" : ""})` : ""}`);
		body.push(`Already introduced and checked in earlier sessions: ${names.join("; ")}${done.length > names.length ? ` (+${done.length - names.length} more)` : ""}.`);
	}
	if (listed.length > 0) {
		body.push(
			"Introduce each term by naming it in the sentence that first uses it, with the class's own definition (cite the page) rather than a wording of your own; use the material's notation. A term counts as introduced only when the learner sees its name in your text, a question, or a figure note; a question tagged with it does not introduce it, and neither do multiple-choice options.",
			"Tag every `quiz` and `explain` with the ids of the terms it tests in `conceptIds`, copied exactly from the brackets ([] when it tests none). An id that is not listed here counts for nothing.",
		);
		if (mode === "learn") {
			body.push(
				`Before \`${FINISH_LESSON_TOOL}\`, every core term listed above must have been introduced (in this lesson or an earlier one) or listed in its \`deferred\` with a few words of why. Terms introduced but not checked carry into the next session of this skill; they never block finishing.`,
			);
		}
	}
	return body.join("\n");
}

// ─── the finish check ───────────────────────────────────────────────────────

export { VOCABULARY_REFUSAL_HEAD };

/** The finish refusal's text, naming every item it checked that is still owed. */
export function vocabularyRefusalText(missing: ReadonlyArray<{ key: string; name: string }>): string {
	const list = missing.map((i) => `${i.name} [${i.key}]`).join(", ");
	const n = missing.length;
	return (
		`${VOCABULARY_REFUSAL_HEAD} this lesson owes ${n} core term${n === 1 ? "" : "s"} of the class that ${n === 1 ? "has" : "have"} not been introduced yet ` +
		`(named where the learner sees it, in this lesson or an earlier one; a question tag alone does not count): ${list}. ` +
		`Work the next one in where it belongs to what you just taught, and list the others in \`deferred\` with a few words of why each waits; then call \`${FINISH_LESSON_TOOL}\` again. ` +
		"This check refuses once per lesson."
	);
}

/** Did this lesson's transcript already get the vocabulary refusal? (It fires once per lesson at most.) */
export function vocabularyRefusedBefore(messages: readonly unknown[]): boolean {
	return messages.some((m) => {
		const r = m as { role?: string; toolName?: string; isError?: boolean; content?: unknown };
		if (r.role !== "toolResult" || r.toolName !== FINISH_LESSON_TOOL || !r.isError || !Array.isArray(r.content)) return false;
		return (r.content as Array<{ type?: string; text?: unknown }>).some((b) => b.type === "text" && typeof b.text === "string" && b.text.includes(VOCABULARY_REFUSAL_HEAD));
	});
}

/** What a lesson's finish check knows: the core items LISTED to it (its whole obligation, with their link groups), and
 *  what is introduced given this lesson's own transcript on top of every other session (the server's ledger, live). */
export interface LessonVocabulary {
	items: ReadonlyArray<{ key: string; name: string; group: readonly string[] }>;
	/** The keys introduced given this lesson's messages and every other session of the class. */
	introduced: (messages: readonly LhMessage[]) => ReadonlySet<string>;
}

/** The items a `finish_lesson` call would leave behind unnamed, or null when it may go through: nothing owed, every
 *  listed core item introduced or deferred with a reason, or the refusal already fired in this lesson. Pure given
 *  `introduced`. `messages`: what the learner had seen when the call was made (core/learner-seen.ts messagesSeenAtFinish). */
export function finishVocabularyProblem(lesson: LessonVocabulary | undefined, messages: readonly LhMessage[], args: unknown): Array<{ key: string; name: string }> | null {
	if (!lesson || lesson.items.length === 0) return null;
	if (vocabularyRefusedBefore(messages)) return null;
	const deferred = new Set(deferredIdsOf((args as { deferred?: unknown } | null | undefined)?.deferred));
	const introduced = lesson.introduced(messages);
	const missing = lesson.items.filter((i) => !i.group.some((k) => introduced.has(k) || deferred.has(k)));
	return missing.length > 0 ? missing.map(({ key, name }) => ({ key, name })) : null;
}

/** What a clean finish records about the lesson's terms, fixed as of that moment (the lesson result reads it back, so a
 *  later lesson never changes it): the listed core items, how many were introduced, and the names of those left. Null
 *  when the lesson owed none. Pure given `introduced`. */
export function lessonCoverageAtFinish(lesson: LessonVocabulary | undefined, messages: readonly LhMessage[]): { total: number; covered: number; left: string[] } | null {
	if (!lesson || lesson.items.length === 0) return null;
	const introduced = lesson.introduced(messages);
	const left = lesson.items.filter((i) => !i.group.some((k) => introduced.has(k))).map((i) => i.name);
	return { total: lesson.items.length, covered: lesson.items.length - left.length, left };
}
