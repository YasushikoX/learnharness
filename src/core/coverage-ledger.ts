/**
 * The vocabulary coverage LEDGER (WP5, 2026-11-25; spec: docs/courses.md "Vocabulary coverage"). PURE, browser-safe.
 *
 * Nothing here is stored: what each coverage item (core/coverage-items.ts) has had in the class's sessions is DERIVED
 * from the transcripts, like skill evidence (server/courses.ts courseEvidence), and cached per chat file by the server.
 *
 *   INTRODUCED: the entry's name or one of its aliases appeared in text the learner actually saw in a session of the
 *     class, and that name is unambiguous in the class (findTermCandidates gives exactly one entry, or every candidate is
 *     in one link group). An item that was CHECKED counts as introduced too.
 *   CHECKED: the learner answered a `quiz` or `explain` whose `conceptIds` holds the item's key (or a key linked with it).
 *     The best `level` reached is kept, and whether any such answer was graded right.
 *
 * WHAT THE LEARNER SAW is what the transcript view renders (core/view.ts projectView, the one definition of it): the
 * tutor's text parts (prose, `send_to_user`, a posed question's `lead`), the posed questions' displayed fields (question,
 * details, options; an explain's key points and a quiz's explanation only once answered), a shown figure's caption,
 * `lookAt` and `tryThis`, and a practice problem's statement. Never thinking, tool arguments the view does not show,
 * hidden key points before the answer, system prompts, context markers or material excerpts fed to the model, and never
 * the learner's own messages.
 *
 * MATCHING RULES (docs/courses.md has them as a table):
 *   - Exact spelling, on word boundaries: a name matches where it starts at a word start and the next character is not a
 *     letter, digit or mark ("ring" is not in "string" or "rings"). Text and names are compared after normalizeName's
 *     invisible-character, NFC and space folding and after typographic quotes are read as plain ones (plainQuotes).
 *   - Case: exact, with one exception: a name stored in lower case at its start (the glossary keeps running-text forms)
 *     also matches with its first letter capitalised AT THE START OF A SENTENCE (start of a text or line, or after ".",
 *     "!", "?" or ":", skipping spaces, quotes, brackets and Markdown markers). "Entropy is…" introduces "entropy";
 *     "Entropy" mid-sentence does not, and "ENTROPY" never does. Ambiguity is then decided on the name as stored.
 *   - Inflections are NOT matched ("resistors" does not introduce "resistor") unless the inflected form is an alias of
 *     the entry, or is itself an entry linked with it (a confirmed plural suggestion).
 *   - Symbols never introduce anything (a symbol alone is notation, not the term).
 *   - A sense of a homonym (an item with `sense`) is introduced by its name only in a session of a skill the sense is
 *     assigned to; a whole-entry item by its name in any session of the class.
 *   - Ask conversations count for nothing (they affect no progress anywhere else either), and nor do chats outside the
 *     class. Every other course mode counts for introduced; only Learn sessions pose quiz/explain, so only they check.
 */

import type { CourseMode } from "./contracts/course.ts";
import type { CoverageGlossary, ResolvedCoverage } from "./coverage-items.ts";
import { findTermCandidates, normalizeName, plainQuotes, stripInvisible } from "./glossary.ts";
import { readAnswerVerdict } from "./lead-floor-gate.ts";
import type { LhMessage } from "./native-messages.ts";
import { normalizeConceptIds, normalizeQuestionLevel, QUESTION_LEVELS, type QuestionLevel } from "./question-quality.ts";
import { FINISH_LESSON_TOOL, sessionFinishOf, VOCABULARY_REFUSAL_HEAD } from "./course-session.ts";
import { projectView } from "./view.ts";

// ─── what the learner saw ───────────────────────────────────────────────────

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const QUESTION_PARTS = new Set(["tool-quiz", "tool-explain", "tool-probe", "tool-recall", "tool-ask_user_question"]);

/** Every text the learner was shown in a transcript, in order (see the module comment). Pure. */
export function learnerSeenTexts(messages: readonly LhMessage[]): string[] {
	const out: string[] = [];
	const push = (v: unknown) => {
		const s = str(v);
		if (s.trim() !== "") out.push(s);
	};
	for (const m of projectView(messages)) {
		if (m.role !== "assistant") continue;
		for (const part of m.parts) {
			if (part.type === "text") {
				push((part as { text?: unknown }).text);
				continue;
			}
			if (part.state === "output-error" || part.state === "input-streaming") continue;
			const input = (part.input ?? {}) as Record<string, unknown>;
			if (QUESTION_PARTS.has(part.type)) {
				push(input.question);
				push(input.details);
				if (Array.isArray(input.options)) {
					for (const o of input.options) {
						if (!o || typeof o !== "object") continue;
						push((o as { label?: unknown }).label);
						push((o as { description?: unknown }).description);
					}
				}
				// shown only once he has answered
				if (part.state === "output-available") {
					if (part.type === "tool-quiz") push(input.explanation);
					if (part.type === "tool-explain" && Array.isArray(input.keyPoints)) for (const k of input.keyPoints) push(k);
				}
			} else if (part.type === "tool-show_figure" && part.state === "output-available") {
				push(input.caption);
				push(input.lookAt);
				push(input.tryThis);
			} else if (part.type === "tool-problem") {
				push(input.statement);
			}
		}
	}
	return out;
}

// ─── the name matcher ───────────────────────────────────────────────────────

const WORD_RUN = /[\p{L}\p{N}\p{M}]+/gu;
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
const FIRST_WORD = /^[\p{L}\p{N}\p{M}]+/u;

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
	return { key: `${sorted.length}:${fnv(sorted.join("\u0000"))}`, byFirst, odd };
}

const SKIP_BACK = /[\s*_#>\-•"'“”‘’(\[«»]/u;

/** Does position `at` start a sentence (see the module comment)? */
function sentenceStart(text: string, at: number): boolean {
	let i = at - 1;
	while (i >= 0 && SKIP_BACK.test(text[i]!)) {
		if (text[i] === "\n") return true;
		i--;
	}
	return i < 0 || /[.!?:]/u.test(text[i]!);
}

const endsClean = (text: string, end: number, form: string) => end >= text.length || !WORD_CHAR.test(text[end]!) || !WORD_CHAR.test(form[form.length - 1]!);

/** The text from `at` with its first character lower-cased, as long as `form`. */
function loweredSlice(text: string, at: number, form: string): string {
	const slice = text.slice(at, at + form.length);
	const [head, ...tail] = [...slice];
	return head === undefined ? "" : head.toLowerCase() + tail.join("");
}

/** Every name of the matcher that occurs in the text under the rules above. Pure. */
export function matchNames(rawText: string, m: VocabularyMatcher): Set<string> {
	const text = matchText(rawText);
	const found = new Set<string>();
	for (const w of text.matchAll(WORD_RUN)) {
		const at = w.index!;
		const word = w[0];
		for (const form of m.byFirst.get(word) ?? []) {
			if (text.startsWith(form, at) && endsClean(text, at + form.length, form)) found.add(form);
		}
		const [head, ...tail] = [...word];
		if (head && head !== head.toLowerCase() && sentenceStart(text, at)) {
			const lowered = head.toLowerCase() + tail.join("");
			for (const form of m.byFirst.get(lowered) ?? []) {
				if (loweredSlice(text, at, form) === form && endsClean(text, at + form.length, form)) found.add(form);
			}
		}
	}
	for (const form of m.odd) {
		for (let at = text.indexOf(form); at >= 0; at = text.indexOf(form, at + 1)) {
			if ((at === 0 || !WORD_CHAR.test(text[at - 1]!)) && endsClean(text, at + form.length, form)) {
				found.add(form);
				break;
			}
		}
	}
	return found;
}

// ─── one chat's vocabulary evidence (cached per chat file by the server) ────

/** An answered teach question's tags. */
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
	/** The ids the clean `finish_lesson` deferred. */
	deferred: string[];
}

const TEACH_QUESTIONS = new Set(["quiz", "explain"]);

interface ResultLike {
	role: "toolResult";
	toolCallId: string;
	isError?: boolean;
	details?: unknown;
	content: unknown;
}

/** A chat's vocabulary evidence: the names seen, the answered tagged questions, and the lesson's deferred ids. Pure. */
export function chatVocabularyOf(messages: readonly LhMessage[], matcher: VocabularyMatcher): ChatVocabulary {
	const forms = new Set<string>();
	for (const text of learnerSeenTexts(messages)) for (const f of matchNames(text, matcher)) forms.add(f);
	return { forms: [...forms].sort(), checks: checksOf(messages), deferred: deferredOf(messages) };
}

/** The answered quiz/explain calls that carry concept ids, with their level and grade. Pure. */
export function checksOf(messages: readonly LhMessage[]): VocabularyCheck[] {
	const results = new Map<string, ResultLike>();
	for (const msg of messages) {
		const r = msg as unknown as ResultLike;
		if (r.role === "toolResult" && r.toolCallId) results.set(r.toolCallId, r);
	}
	// teach questions in order: an explain's grade rides the next one's `previous`
	const calls: Array<{ id: string; args: Record<string, unknown> }> = [];
	for (const msg of messages) {
		if ((msg as { role?: string }).role !== "assistant") continue;
		for (const b of (msg as unknown as { content: Array<{ type: string; id?: string; name?: string; arguments?: unknown }> }).content) {
			if (b.type === "toolCall" && b.id && b.name && TEACH_QUESTIONS.has(b.name)) calls.push({ id: b.id, args: (b.arguments ?? {}) as Record<string, unknown> });
		}
	}
	const checks: VocabularyCheck[] = [];
	calls.forEach((call, i) => {
		const result = results.get(call.id);
		if (!result || result.isError || result.details == null) return;
		if ((result.details as { dismissed?: unknown }).dismissed === true) return;
		const ids = normalizeConceptIds(call.args.conceptIds) ?? [];
		if (ids.length === 0) return;
		const verdict = readAnswerVerdict(result as never);
		let right: boolean | null = verdict === "hit" ? true : verdict === "miss" ? false : null;
		if (right === null) {
			const next = calls.slice(i + 1).find((c) => !results.get(c.id)?.isError);
			const previous = typeof next?.args.previous === "string" ? next.args.previous.trim().toLowerCase() : "";
			if (previous === "right") right = true;
			else if (previous === "partly" || previous === "wrong") right = false;
		}
		const level = normalizeQuestionLevel(call.args.level);
		checks.push({ ids, ...(level ? { level } : {}), right });
	});
	return checks;
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

/** The ids of a `deferred` argument ([{ id, why }], tolerant of bare strings); [] when absent. Pure. */
export function deferredIdsOf(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const d of raw) {
		const id = typeof d === "string" ? d : d && typeof d === "object" ? (d as { id?: unknown }).id : undefined;
		if (typeof id === "string" && id.trim() !== "" && !out.includes(id.trim())) out.push(id.trim());
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
}

export interface ItemLedger {
	introduced: boolean;
	checked: boolean;
	level?: QuestionLevel;
	right?: boolean;
	/** The chats it was introduced or checked in. */
	seenIn: Set<string>;
	/** The chats whose finished lesson deferred it. */
	deferredIn: Set<string>;
}

const levelRank = (l: QuestionLevel | undefined) => (l ? QUESTION_LEVELS.indexOf(l) : -1);

/** Which item keys a name introduces in a chat of these skills (none when the name is ambiguous in the class). Pure. */
export function keysForName(form: string, glossary: Pick<CoverageGlossary, "terms" | "lookup">, resolved: ResolvedCoverage, chatSkills: ReadonlySet<string>): string[] {
	const entries = findTermCandidates(glossary, form).map((c) => c.entry.id);
	if (entries.length === 0) return [];
	if (entries.length > 1) {
		// unambiguous only when every candidate is one linked concept
		const group = new Set(resolved.group(entries[0]!));
		if (!entries.every((id) => group.has(id))) return [];
	}
	const out: string[] = [];
	for (const item of resolved.items) {
		if (item.status === "flagged" || !entries.includes(item.item.entryId)) continue;
		if (item.item.sense && !(item.item.skills ?? []).some((s) => chatSkills.has(s))) continue;
		out.push(item.key);
	}
	return out;
}

/** Every item's ledger from the class's chats (an Ask chat counts for nothing). `exclude`: leave one chat out (the
 *  session a prompt is built for, so its own progress does not change its prompt mid-session). Pure. */
export function foldLedger(resolved: ResolvedCoverage, glossary: Pick<CoverageGlossary, "terms" | "lookup">, chats: readonly LedgerChat[], exclude?: string): Map<string, ItemLedger> {
	const ledger = new Map<string, ItemLedger>();
	for (const item of resolved.items) if (item.status !== "flagged") ledger.set(item.key, { introduced: false, checked: false, seenIn: new Set(), deferredIn: new Set() });
	const mark = (key: string, chatId: string, f: (l: ItemLedger) => void) => {
		for (const k of resolved.group(key)) {
			const l = ledger.get(k);
			if (!l) continue;
			f(l);
			l.seenIn.add(chatId);
		}
	};
	const nameCache = new Map<string, string[]>();
	for (const chat of chats) {
		if (chat.mode === "ask" || chat.chatId === exclude) continue;
		const skills = new Set(chat.skillIds);
		const skillKey = [...skills].sort().join(",");
		for (const form of chat.vocabulary.forms) {
			const cacheKey = `${skillKey}\u0000${form}`;
			let keys = nameCache.get(cacheKey);
			if (!keys) nameCache.set(cacheKey, (keys = keysForName(form, glossary, resolved, skills)));
			for (const k of keys) mark(k, chat.chatId, (l) => (l.introduced = true));
		}
		for (const check of chat.vocabulary.checks) {
			for (const id of check.ids) {
				if (!ledger.has(id)) continue;
				mark(id, chat.chatId, (l) => {
					l.checked = true;
					l.introduced = true;
					if (levelRank(check.level) > levelRank(l.level)) l.level = check.level;
					if (check.right === true) l.right = true;
					else if (check.right === false && l.right === undefined) l.right = false;
				});
			}
		}
		for (const id of chat.vocabulary.deferred) for (const k of resolved.group(id)) ledger.get(k)?.deferredIn.add(chat.chatId);
	}
	return ledger;
}

/** How many of a question's concept ids are not items of the class (an id the model invented). Pure. */
export function unknownConceptIds(ids: readonly string[], known: ReadonlySet<string>): number {
	return ids.filter((id) => !known.has(id)).length;
}

// ─── the lesson's prompt section ────────────────────────────────────────────

/** The most terms a lesson's prompt lists with their definition (core first): a lesson teaches one skill in roughly half
 *  an hour, and a list longer than this stops being a checklist the tutor can keep in view. */
export const VOCABULARY_PROMPT_MAX = 12;
/** The most already-checked terms named (without definition) on one line. */
export const VOCABULARY_CHECKED_MAX = 20;
const DEFINITION_CHARS = 260;

export interface VocabularyPromptItem {
	key: string;
	name: string;
	tier: "core" | "supporting";
	definition: string | null;
	page: number | null;
	material: string | null;
	state: "new" | "introduced" | "checked";
	/** Introduced, checked or deferred in an earlier session of this skill. */
	carried: boolean;
	/** An earlier lesson of this skill deferred it. */
	deferred?: boolean;
	level?: QuestionLevel;
	right?: boolean;
	/** Other names linked with it (one concept). */
	linked?: string[];
}

const flat = (t: string, max: number) => {
	const s = t.replace(/\s+/g, " ").trim();
	return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
};

/**
 * The vocabulary block of a Learn or Practice session's course section: the skill's terms, core first, carried-over
 * ones before new ones, each with its id, the material's definition and page, and its state; checked terms on one line
 * by name. At most VOCABULARY_PROMPT_MAX with definitions. "" when the skill owes no term. Pure.
 */
export function vocabularySection(skillName: string, items: readonly VocabularyPromptItem[], mode: CourseMode): string {
	if (items.length === 0) return "";
	const rank = (i: VocabularyPromptItem) => (i.tier === "core" ? 0 : 10) + (i.state === "checked" ? 3 : i.carried ? 0 : i.state === "introduced" ? 1 : 2);
	const ordered = [...items].sort((a, b) => rank(a) - rank(b));
	const open = ordered.filter((i) => i.state !== "checked");
	const checked = ordered.filter((i) => i.state === "checked");
	const shown = open.slice(0, VOCABULARY_PROMPT_MAX);
	const line = (i: VocabularyPromptItem) => {
		const state =
			i.state === "new"
				? i.deferred ? "new, left for later by an earlier lesson (carried over)" : "new"
				: `introduced${i.carried ? " in an earlier session" : ""}, not checked yet${i.carried ? " (carried over)" : ""}`;
		const where = [i.material, i.page !== null ? `p. ${i.page}` : null].filter(Boolean).join(", ");
		const definition = i.definition !== null ? `The material: "${flat(i.definition, DEFINITION_CHARS)}"${where ? ` (${where})` : ""}` : `The material uses it without defining it${where ? ` (${where})` : ""}.`;
		const linked = i.linked && i.linked.length > 0 ? ` Also named: ${i.linked.join(", ")}.` : "";
		return `- [${i.key}] ${i.name}${i.tier === "supporting" ? " (supporting)" : ""} — ${state}. ${definition}${linked}`;
	};
	const body = [
		`VOCABULARY — the class's own terms that "${skillName}" owes (from the class glossary, built from its material). The [id] in brackets is what \`conceptIds\` takes:`,
		...shown.map(line),
	];
	if (open.length > shown.length) body.push(`(+${open.length - shown.length} more terms of this skill not listed here)`);
	if (checked.length > 0) {
		const names = checked.slice(0, VOCABULARY_CHECKED_MAX).map((i) => `${i.name} [${i.key}]${i.level ? ` (${i.level}${i.right ? ", right" : ""})` : ""}`);
		body.push(`Already checked in earlier sessions: ${names.join("; ")}${checked.length > names.length ? ` (+${checked.length - names.length} more)` : ""}.`);
	}
	body.push(
		"Introduce each term in the sentence that first uses it, with the class's own definition (cite the page) rather than a wording of your own; use the material's notation.",
		"Tag every `quiz` and `explain` with the ids of the terms it tests in `conceptIds`, copied exactly from the brackets ([] when it tests none). An id that is not listed here counts for nothing.",
	);
	if (mode === "learn") {
		body.push(
			`Before \`${FINISH_LESSON_TOOL}\`, every core term above must have been introduced (in this lesson or an earlier one) or listed in its \`deferred\` with a few words of why. Terms introduced but not checked carry into the next session of this skill; they never block finishing.`,
		);
	}
	return body.join("\n");
}

// ─── the finish check ───────────────────────────────────────────────────────

export { VOCABULARY_REFUSAL_HEAD };

/** The finish refusal's text, naming the items. */
export function vocabularyRefusalText(missing: ReadonlyArray<{ key: string; name: string }>): string {
	const list = missing.slice(0, 12).map((i) => `${i.name} [${i.key}]`).join(", ");
	const more = missing.length > 12 ? ` and ${missing.length - 12} more` : "";
	const n = missing.length;
	return (
		`${VOCABULARY_REFUSAL_HEAD} this lesson's skill owes ${n} core term${n === 1 ? "" : "s"} of the class that ${n === 1 ? "has" : "have"} not been introduced, ` +
		`in this lesson or an earlier one: ${list}${more}. Introduce each one now, with the class's definition, in the sentence that first uses it; or call \`${FINISH_LESSON_TOOL}\` again ` +
		"with each one in `deferred` and a few words of why. This check refuses once per lesson."
	);
}

/** Did this lesson's transcript already get the vocabulary refusal? (It fires once per session at most.) */
export function vocabularyRefusedBefore(messages: readonly unknown[]): boolean {
	return messages.some((m) => {
		const r = m as { role?: string; toolName?: string; isError?: boolean; content?: unknown };
		if (r.role !== "toolResult" || r.toolName !== FINISH_LESSON_TOOL || !r.isError || !Array.isArray(r.content)) return false;
		return (r.content as Array<{ type?: string; text?: unknown }>).some((b) => b.type === "text" && typeof b.text === "string" && b.text.includes(VOCABULARY_REFUSAL_HEAD));
	});
}

/** What a lesson's finish check knows: the skill's core items (with their link groups), and what is introduced given
 *  this lesson's own transcript on top of every other session (the server's ledger, live). */
export interface LessonVocabulary {
	items: ReadonlyArray<{ key: string; name: string; group: readonly string[] }>;
	/** The keys introduced (or checked) given this lesson's messages and every other session of the class. */
	introduced: (messages: readonly LhMessage[]) => ReadonlySet<string>;
}

/** The items a `finish_lesson` call would leave behind unnamed, or null when it may go through: nothing owed, every
 *  core item introduced or deferred, or the refusal already fired in this lesson. Pure given `introduced`. */
export function finishVocabularyProblem(lesson: LessonVocabulary | undefined, messages: readonly LhMessage[], args: unknown): Array<{ key: string; name: string }> | null {
	if (!lesson || lesson.items.length === 0) return null;
	if (vocabularyRefusedBefore(messages)) return null;
	const deferred = new Set(deferredIdsOf((args as { deferred?: unknown } | null | undefined)?.deferred));
	const introduced = lesson.introduced(messages);
	const missing = lesson.items.filter((i) => !i.group.some((k) => introduced.has(k) || deferred.has(k)));
	return missing.length > 0 ? missing.map(({ key, name }) => ({ key, name })) : null;
}
