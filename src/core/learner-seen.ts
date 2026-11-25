/**
 * What the learner saw (WP5 rework, 2026-11-25). PURE, browser-safe.
 *
 * ONE definition of the text each rendered card of a projected transcript (core/view.ts projectView) shows the learner,
 * for the vocabulary ledger (core/coverage-ledger.ts). Where a card component decides what to show, the decision lives
 * here and the component calls it, so the screen and the ledger cannot disagree:
 *   - answeredCardContent: an answered question (components/answered-card.tsx). A DISMISSED (skipped or set-aside)
 *     question shows only its question text; an answered one its question, its details line, and for `explain` the
 *     committed answer and the key points. A quiz's explanation sits behind the "Why" toggle and is NOT counted as seen
 *     (text the learner must open does not count). Option labels are shown but are not teaching: the ledger leaves
 *     them out (a term met only as a wrong option was not introduced).
 *   - showFigureContent: a show_figure card (components/artifacts/show-figure-card.tsx). Nothing while it runs, when it
 *     was refused, or when the figure is missing or failed; otherwise the caption, the `lookAt` points (an array, as the
 *     production schema has it) and, on a demo only, `tryThis`.
 *   - pendingQuestionContent: a posed question waiting in the dock: its question and details (its options, again, are
 *     not teaching). A question the dock cannot parse renders as "malformed" and shows nothing of itself.
 *   - tutor prose (text parts, which include `send_to_user` and a posed question's `lead`), and a practice problem's
 *     statement.
 * Never thinking, the learner's own words, plan blocks, context markers, refused calls, or any tool argument a card
 * does not render. Every text goes through core/visible-text.ts (a link's label, not its URL; collapsed details out).
 *
 * At finish time (`messagesSeenAtFinish`) the message that calls `finish_lesson` contributes only its own prose: its
 * sibling calls have not settled when the finish gate runs (pi prepares every call of a message before executing any),
 * so a sibling that will fail, and one that will succeed, both contribute nothing yet.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { QuestionAnswerData } from "./question-core.ts";
import type { LhMessage } from "./native-messages.ts";
import type { LhViewMessage, LhViewPart } from "./view.ts";
import { answerForPresentation } from "./answer-presentation.ts";
import { figureNotesOf } from "./figure-notes.ts";
import type { FigureEntry } from "./figure-show.ts";
import { parseAskInput, parseQuestionInput, parseQuizInput } from "./tool-parts.ts";
import { visibleMarkdownText } from "./visible-text.ts";

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

/** A text the learner was shown, as the screen shows it: Markdown reduced to its visible text, plain text as is. */
const markdown = (out: string[], text: unknown) => {
	if (typeof text !== "string" || text.trim() === "") return;
	const visible = visibleMarkdownText(text);
	if (visible) out.push(visible);
};
const plain = (out: string[], text: unknown) => {
	if (typeof text === "string" && text.trim() !== "") out.push(text.replace(/\s+/g, " ").trim());
};

/** The texts one view part shows the learner (see the module comment). Pure. */
export function seenTextsOfPart(part: LhViewPart): string[] {
	const out: string[] = [];
	if (part.type === "text") {
		markdown(out, part.text);
		return out;
	}
	if (!part.type.startsWith("tool-") || part.pluginQuestion || part.pluginProblem) return out;
	if (part.state === "output-error" || part.state === "input-streaming") return out;
	if (QUESTION_PARTS.has(part.type)) {
		if (part.state === "output-available") {
			const content = answeredCardContent(part.output as QuestionAnswerData, part.input);
			if (content.dismissed) {
				plain(out, content.questionText);
				return out;
			}
			markdown(out, content.questionText);
			markdown(out, content.details);
			markdown(out, content.committed);
			for (const k of content.keyPoints) markdown(out, k);
			return out;
		}
		const pending = pendingQuestionContent(part.type.slice("tool-".length), part.input);
		if (pending) {
			markdown(out, pending.question);
			markdown(out, pending.details);
		}
		return out;
	}
	if (part.type === "tool-show_figure") {
		const shown = showFigureContent(part);
		if (!shown) return out;
		plain(out, shown.caption);
		for (const p of shown.lookAt) markdown(out, p);
		markdown(out, shown.tryThis);
		return out;
	}
	if (part.type === "tool-problem") markdown(out, (part.input as { statement?: unknown } | undefined)?.statement);
	return out;
}

/** Every text the learner was shown in a projected transcript, in order. Pure. */
export function seenTextsOfView(view: readonly LhViewMessage[]): string[] {
	const out: string[] = [];
	for (const m of view) {
		if (m.role !== "assistant") continue;
		for (const part of m.parts) out.push(...seenTextsOfPart(part));
	}
	return out;
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
