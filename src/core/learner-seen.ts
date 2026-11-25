/**
 * What the learner saw (WP5 rework, 2026-11-25). PURE, browser-safe.
 *
 * ONE definition of the text each rendered card of a projected transcript (core/view.ts projectView) shows the learner,
 * for the vocabulary ledger (core/coverage-ledger.ts). Where a card component decides what to show, the decision lives
 * here and the component calls it, so the screen and the ledger cannot disagree:
 *   - answeredCardContent: an answered question (components/answered-card.tsx). A DISMISSED (skipped or set-aside)
 *     question shows only its question text (reduced as Markdown like every text, review 3); an answered one its question, its details line, and for `explain` the
 *     committed answer and the key points. A quiz's explanation sits behind the "Why" toggle and is NOT counted as seen
 *     (text the learner must open does not count). Option labels are shown but are not teaching: the ledger leaves
 *     them out (a term met only as a wrong option was not introduced).
 *   - showFigureContent: a show_figure card (components/artifacts/show-figure-card.tsx). Nothing while it runs, when it
 *     was refused, or when the figure is missing or failed; otherwise the caption, the `lookAt` points (an array, as the
 *     production schema has it) and, on a demo only, `tryThis`.
 *   - pendingQuestionContent: a posed question waiting in the dock: its question and details (its options, again, are
 *     not teaching). Only THE pending question counts, as the dock computes it (core/native-messages.ts
 *     pendingQuestionOf, shared, review 2): a question in a generation that ended in error, abort or a length stop, one
 *     the dock cannot parse ("malformed"), and one a later message superseded show nothing of themselves.
 *   - tutor prose (text parts, which include `send_to_user`), and a practice problem's statement once the problem went
 *     through (its clean result; a pose in a failed generation never did).
 *   - a question's `lead` (a text part the view tags with its call, `leadFor`) only when the question itself counts: it
 *     was answered or dismissed, or it is the dock's pending question (review 3). The transcript still shows the lead of
 *     a question in a generation that stopped with an error, an abort or a length stop, of one a later message
 *     superseded, and of a second sibling question, although it shows no card for that question; the ledger does not
 *     count it.
 * Never thinking, the learner's own words, plan blocks, context markers, refused calls, or any tool argument a card
 * does not render. Every text goes through core/visible-text.ts (a link's label, not its URL; collapsed details out).
 *
 * At finish time (`messagesSeenAtFinish`) the message that calls `finish_lesson` contributes only its own prose: its
 * sibling calls have not settled when the finish gate runs (pi prepares every call of a message before executing any),
 * so a sibling that will fail, and one that will succeed, both contribute nothing yet. (A sibling `send_to_user` that
 * will succeed is therefore not counted by the gate although the later scan counts it: the gate errs toward "new".)
 *
 * Nothing here throws (review 2): a part whose record cannot be read, or a text that is too long or too deep to reduce
 * (core/visible-text.ts readVisibleVariants), counts nothing, and `unread` counts such texts. A reading also collects
 * each text's variants (line-break hyphens kept; `*` and `_` kept) in `hyphenated` and `marked` when it is given them.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { QuestionAnswerData } from "./question-core.ts";
import { pendingQuestionOf, type LhMessage } from "./native-messages.ts";
import type { LhViewMessage, LhViewPart } from "./view.ts";
import { answerForPresentation } from "./answer-presentation.ts";
import { figureNotesOf } from "./figure-notes.ts";
import type { FigureEntry } from "./figure-show.ts";
import { parseAskInput, parseQuestionInput, parseQuizInput } from "./tool-parts.ts";
import type { PendingQuestion } from "./pending.ts";
import { readVisibleVariants } from "./visible-text.ts";

// ─── the cards' decisions ───────────────────────────────────────────────────

/** What an answered question's card shows. `answer` is the snapshot as presented (answerForPresentation). */
export type AnsweredCardContent =
	| { dismissed: true; answer: QuestionAnswerData; questionText: string; steer?: string }
	| {
			dismissed: false;
			answer: QuestionAnswerData;
			questionText: string;
			/** The details line (from the call). */
			details?: string;
			/** An ask option's description, by option index (shown under its label). */
			optionDescriptions: ReadonlyMap<number, string>;
			/** A quiz's explanation: behind the "Why" toggle, so not seen unless opened. */
			tuckedExplanation?: string;
			/** An explain's committed answer, revealed with the answer. */
			committed?: string;
			/** An explain's key points, revealed with the answer. */
			keyPoints: readonly string[];
	  };

/** The answered card's content (the one decision components/answered-card.tsx renders from). Pure. */
export function answeredCardContent(saved: QuestionAnswerData, input: unknown): AnsweredCardContent {
	if (saved.dismissed) {
		return { dismissed: true, answer: saved, questionText: saved.questionText, ...(saved.steer ? { steer: saved.steer } : {}) };
	}
	const answer = answerForPresentation(saved, input);
	const ask = answer.kind === "ask" ? parseAskInput(input) : undefined;
	const details = ask?.details ?? (answer.kind === "quiz" ? parseQuizInput(input)?.details : undefined);
	const optionDescriptions = new Map<number, string>();
	(ask?.options ?? []).forEach((o, i) => {
		if (o.description) optionDescriptions.set(i + 1, o.description);
	});
	return {
		dismissed: false,
		answer,
		questionText: answer.questionText,
		...(details ? { details } : {}),
		optionDescriptions,
		...(answer.kind === "quiz" && answer.explanation ? { tuckedExplanation: answer.explanation } : {}),
		...(answer.kind === "explain" && answer.committed ? { committed: answer.committed } : {}),
		keyPoints: answer.kind === "explain" ? (answer.keyPoints ?? []) : [],
	};
}

/** What a show_figure card shows, or null when it renders nothing. Pure. */
export function showFigureContent(part: { state?: string; figure?: unknown; input?: unknown }): { figure: FigureEntry; caption?: string; lookAt: string[]; tryThis?: string } | null {
	if (part.state !== "output-available") return null;
	const figure = part.figure as FigureEntry | undefined;
	if (!figure || !figure.ok) return null;
	const rawCaption = (part.input as { caption?: unknown } | null | undefined)?.caption;
	const caption = typeof rawCaption === "string" && rawCaption.trim() ? rawCaption.trim() : undefined;
	const notes = figureNotesOf(part.input, figure.kind);
	return { figure, ...(caption ? { caption } : {}), lookAt: notes.lookAt, ...(notes.tryThis ? { tryThis: notes.tryThis } : {}) };
}

/** What the dock shows of a posed question (its question and details), or null when it cannot render it. Pure. */
export function pendingQuestionContent(tool: string, input: unknown): { question: string; details?: string } | null {
	const parsed = parseQuestionInput(tool, input) as { question?: unknown; details?: unknown } | undefined;
	if (!parsed || typeof parsed.question !== "string") return null;
	return { question: parsed.question, ...(typeof parsed.details === "string" && parsed.details.trim() ? { details: parsed.details } : {}) };
}

// ─── the seen texts of a projected transcript ───────────────────────────────

const QUESTION_PARTS = new Set(["tool-quiz", "tool-explain", "tool-probe", "tool-recall", "tool-ask_user_question"]);

/** Where the dock's pending question is (core/native-messages.ts pendingQuestionOf). */
export type PendingQuestionAt = Pick<PendingQuestion, "toolCallId" | "messageId" | "contentIndex">;

/** How a reading went: the texts it could not read (too long, too deep, or a record that failed); and, when the
 *  arrays are given, each read text's variants (core/visible-text.ts VisibleVariants). */
export interface SeenReading {
	unread: number;
	hyphenated?: string[];
	marked?: string[];
}

/** A question occurrence as the view and the dock name it. */
const occurrenceKey = (toolCallId: unknown, messageId: unknown, contentIndex: unknown) => `${String(messageId)}\u0000${String(contentIndex)}\u0000${String(toolCallId)}`;

const isPendingPart = (part: LhViewPart, pending: PendingQuestionAt | null) =>
	pending !== null && part.toolCallId === pending.toolCallId && part.sourceMessageId === pending.messageId && part.sourceContentIndex === pending.contentIndex;

/** The question occurrences of a view whose lead counts: answered or dismissed (it has a result), or the dock's pending
 *  one. Pure. */
export function countedQuestionsOf(view: readonly LhViewMessage[], pending: PendingQuestionAt | null): Set<string> {
	const out = new Set<string>();
	for (const m of view) {
		if (m?.role !== "assistant" || !Array.isArray(m.parts)) continue;
		for (const part of m.parts) {
			if (!part || !QUESTION_PARTS.has(part.type) || part.pluginQuestion) continue;
			if (part.state === "output-available" || (part.state !== "output-error" && isPendingPart(part, pending))) {
				out.add(occurrenceKey(part.toolCallId, part.sourceMessageId, part.sourceContentIndex));
			}
		}
	}
	return out;
}

/** The texts one view part shows the learner (see the module comment). `pending`: the dock's pending question (null or
 *  absent: none, so no unanswered question counts). `counted`: the question occurrences whose lead counts
 *  (countedQuestionsOf; absent: no lead counts). Never throws: a part that cannot be read shows nothing. Pure. */
export function seenTextsOfPart(part: LhViewPart, pending?: PendingQuestionAt | null, reading: SeenReading = { unread: 0 }, counted?: ReadonlySet<string>): string[] {
	try {
		return partTexts(part, pending ?? null, reading, counted ?? new Set());
	} catch {
		reading.unread++;
		return [];
	}
}

function partTexts(part: LhViewPart, pending: PendingQuestionAt | null, reading: SeenReading, counted: ReadonlySet<string>): string[] {
	const out: string[] = [];
	/** A text the learner was shown, as the screen shows it: Markdown reduced to its visible text (and its variants). */
	const markdown = (text: unknown) => {
		if (typeof text !== "string" || text.trim() === "") return;
		const visible = readVisibleVariants(text);
		if (visible === null) {
			reading.unread++;
			return;
		}
		if (visible.text) out.push(visible.text);
		if (visible.hyphenated) reading.hyphenated?.push(visible.hyphenated);
		if (visible.marked) reading.marked?.push(visible.marked);
	};
	if (part.type === "text") {
		// a question's lead counts only when its question does (review 3)
		// (`leadFor` is set by core/view.ts on a lead's text part; not part of the typed view, which plugins read)
		const lead = part.leadFor as { toolCallId?: unknown; messageId?: unknown; contentIndex?: unknown } | undefined;
		if (lead && !counted.has(occurrenceKey(lead.toolCallId, lead.messageId, lead.contentIndex))) return out;
		markdown(part.text);
		return out;
	}
	if (typeof part.type !== "string" || !part.type.startsWith("tool-") || part.pluginQuestion || part.pluginProblem) return out;
	if (part.state === "output-error" || part.state === "input-streaming") return out;
	if (QUESTION_PARTS.has(part.type)) {
		if (part.state === "output-available") {
			const content = answeredCardContent(part.output as QuestionAnswerData, part.input);
			if (content.dismissed) {
				markdown(content.questionText);
				return out;
			}
			markdown(content.questionText);
			markdown(content.details);
			markdown(content.committed);
			for (const k of content.keyPoints) markdown(k);
			return out;
		}
		// unanswered: only the dock's pending question was ever shown (review 2, finding 5)
		if (!isPendingPart(part, pending)) return out;
		const posed = pendingQuestionContent(part.type.slice("tool-".length), part.input);
		if (posed) {
			markdown(posed.question);
			markdown(posed.details);
		}
		return out;
	}
	if (part.type === "tool-show_figure") {
		const shown = showFigureContent(part);
		if (!shown) return out;
		markdown(shown.caption); // the card shows it as plain text; one with Markdown markers is reduced like any text (review 3)
		for (const p of shown.lookAt) markdown(p);
		markdown(shown.tryThis);
		return out;
	}
	// a practice problem shows once it went through (its clean result), never from a failed generation
	if (part.type === "tool-problem" && part.state === "output-available") markdown((part.input as { statement?: unknown } | undefined)?.statement);
	return out;
}

/** Every text the learner was shown in a projected transcript, in order. `pending`: the dock's pending question for the
 *  same transcript (pendingQuestionOf; absent: no unanswered question counts). Never throws. Pure. */
export function seenTextsOfView(view: readonly LhViewMessage[], pending?: PendingQuestionAt | null, reading: SeenReading = { unread: 0 }): string[] {
	const out: string[] = [];
	let counted: Set<string>;
	try {
		counted = countedQuestionsOf(view, pending ?? null);
	} catch {
		counted = new Set();
	}
	for (const m of view) {
		if (m?.role !== "assistant" || !Array.isArray(m.parts)) continue;
		for (const part of m.parts) out.push(...seenTextsOfPart(part, pending, reading, counted));
	}
	return out;
}

/** The dock's pending question of a native transcript (pendingQuestionOf, shared with the dock), or null. Never throws. */
export function pendingQuestionAt(messages: readonly LhMessage[]): PendingQuestionAt | null {
	try {
		const p = pendingQuestionOf(messages);
		return p ? { toolCallId: p.toolCallId, messageId: p.messageId, contentIndex: p.contentIndex } : null;
	} catch {
		return null;
	}
}

/**
 * The transcript as it stands when `finish_lesson` is checked: the history before the calling message, and the calling
 * message with only its prose (its tool calls, the finish included, have not settled). `history` may or may not hold the
 * calling message already. Pure.
 */
export function messagesSeenAtFinish(history: readonly LhMessage[], calling: LhMessage): LhMessage[] {
	const id = (calling as { id?: unknown }).id;
	const before = history.filter((m) => m !== calling && !(typeof id === "string" && (m as { id?: unknown }).id === id));
	const message = calling as unknown as AssistantMessage;
	const prose = { ...message, content: message.content.filter((b) => b.type === "text") } as unknown as LhMessage;
	return [...before, prose];
}
