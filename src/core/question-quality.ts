/**
 * Question quality (WP6, 2026-11-25). PURE, browser-safe.
 *
 * The owner, after studying real classes: "No short responses, only multiple choice", "the questions when teaching
 * feel easy". Three new fields ride the teach question tools, and nothing refuses on them beyond schema validation (one
 * error the model fixes in one step, never a gate):
 *
 *   - `level` (quiz, explain): how demanding the question is: recall < apply < analyze < transfer. Recorded with the
 *     question (its persisted call arguments), never shown, never enforced. The prompt asks for a level higher after a
 *     confident correct answer.
 *   - `conceptIds` (quiz, explain): the terms or concepts the question tests. A later package (vocabulary coverage)
 *     reads it. THE CONTRACT that package may rely on: the field is always present on a call written after this change
 *     (it is required, so the tutor always considers it) and may be empty; ids are opaque strings (the class glossary's
 *     term spelling when there is one; nothing here validates them against a glossary); order is not meaningful;
 *     duplicates and blank entries are dropped by `normalizeConceptIds`, which is how every reader must read it.
 *     Calls written before this change carry no field: `normalizeConceptIds` returns undefined for them.
 *   - `keyPoints` (explain): two to five short statements, each one thing a correct answer must contain, committed with
 *     `correctAnswer` when the question is posed and hidden from the learner until he has answered. His answer goes back
 *     to the tutor beside them (`withKeyPointsForModel`), and the tutor grades each point in its next reply, recording
 *     which were met in the next question's `previousKeyPoints` (the same call that carries `previous`). No extra model
 *     call. The answered card shows the points, marked when that verdict exists (`keyPointMarksOf`).
 *
 * Everything is optional on read: old transcripts (and transcripts synced from a device without this change) carry none
 * of these fields, and every reader below returns undefined for them.
 */

import { Type } from "typebox";
import { stripModelValueDebris } from "./value-debris.ts";

// ─── level ──────────────────────────────────────────────────────────────────

export const QUESTION_LEVELS = ["recall", "apply", "analyze", "transfer"] as const;
export type QuestionLevel = (typeof QUESTION_LEVELS)[number];

export const levelField = Type.Union([Type.Literal("recall"), Type.Literal("apply"), Type.Literal("analyze"), Type.Literal("transfer")], {
	description:
		"REQUIRED — how demanding this question is, as a bare word: recall = state or recognise the idea; apply = use it on a case " +
		"not worked in the lesson; analyze = take a case apart: compare, find the cause, find what is wrong in a given attempt; " +
		"transfer = use it in a setting the lesson has not shown. Recorded with the question, never shown to the learner.",
});

/** A persisted `level`, or undefined (absent on old records; unhealable wobble degrades to undefined). */
export function normalizeQuestionLevel(raw: unknown): QuestionLevel | undefined {
	if (typeof raw !== "string") return undefined;
	const v = stripModelValueDebris(raw).toLowerCase();
	return (QUESTION_LEVELS as readonly string[]).includes(v) ? (v as QuestionLevel) : undefined;
}

// ─── conceptIds ─────────────────────────────────────────────────────────────

export const conceptIdsField = Type.Array(Type.String(), {
	description:
		"REQUIRED, may be empty ([]). The terms or concepts this question tests, one string each: when the session lists a class " +
		"glossary, its terms exactly as spelled there; otherwise each term exactly as the class material spells it. [] when the " +
		"question tests no named term. Order does not matter; duplicates are dropped. Recorded with the question, never shown to the learner.",
});

/** A persisted `conceptIds`: trimmed, blanks and duplicates dropped, first-seen order kept (order carries no meaning).
 *  Undefined when the field is absent or not an array (an old record). */
export function normalizeConceptIds(raw: unknown): string[] | undefined {
	const list = arrayOf(raw);
	if (!list) return undefined;
	const out: string[] = [];
	for (const item of list) {
		if (typeof item !== "string") continue;
		const id = item.trim();
		if (id && !out.includes(id)) out.push(id);
	}
	return out;
}

// ─── keyPoints ──────────────────────────────────────────────────────────────

export const KEY_POINTS_MIN = 2;
export const KEY_POINTS_MAX = 5;

export const keyPointsField = Type.Array(Type.String({ minLength: 1 }), {
	minItems: KEY_POINTS_MIN,
	maxItems: KEY_POINTS_MAX,
	description:
		"REQUIRED. Two to five short statements, each ONE thing a correct answer must contain (a fact, a step, a value with its unit), " +
		"taken from correctAnswer and committed with it. Hidden from the learner until he has answered, then shown to him. His answer " +
		"comes back to you beside them, and you grade each point.",
});

/** The verdict per key point, on the NEXT teach question (beside `previous`). Optional: nothing refuses on it. */
export const previousKeyPointsField = Type.Optional(
	Type.Array(Type.Integer({ minimum: 1, maximum: KEY_POINTS_MAX }), {
		maxItems: KEY_POINTS_MAX,
		description:
			"Only when the learner's last answer was to an `explain` (its result lists `keyPoints`): the numbers of the key points his " +
			"answer contained, e.g. [1, 3]; [] when it contained none. The others count as missed; he sees which. Omit otherwise.",
	}),
);

/** A persisted `keyPoints`: trimmed non-empty strings, or undefined (absent on old records and on recall/probe calls). */
export function normalizeKeyPoints(raw: unknown): string[] | undefined {
	const list = arrayOf(raw);
	if (!list) return undefined;
	const points = list.filter((p): p is string => typeof p === "string").map((p) => p.trim()).filter(Boolean);
	return points.length > 0 ? points : undefined;
}

/** The key points of a question call, read from its arguments: only a teach `explain` carries them. */
export function keyPointsOfCall(tool: string, input: unknown): string[] | undefined {
	if (tool !== "explain" || !input || typeof input !== "object") return undefined;
	return normalizeKeyPoints((input as { keyPoints?: unknown }).keyPoints);
}

/** The authoring problems the schema cannot express (a point of blanks only). Run in the explain tool's execute. */
export function keyPointsProblems(raw: unknown): string[] {
	const list = arrayOf(raw);
	if (!list) return [];
	return list.some((p) => typeof p !== "string" || p.trim() === "")
		? ["keyPoints has an empty point: every key point is a short statement of one thing a correct answer must contain."]
		: [];
}

/** What the tutor is asked to do with the key points, beside the learner's answer (the result's `next`). */
export const KEY_POINTS_NEXT_TEXT =
	"Grade his answer point by point against `keyPoints` (committed before he answered; he sees them now): a point counts when his answer " +
	"states it or something equivalent, not when it only hints at it. In your next question set `previousKeyPoints` to the numbers of the " +
	"points his answer contained ([] for none), and `previous` to right when it has them all, partly when it has some, wrong when it has none. " +
	"In `lead`, name each point he missed and repair it.";

/** Add the committed key points to the model-facing answer record (agent sees them numbered, beside his answer). A dismissal
 *  or a steer is not an answer and gets none. Mutates and returns `forModel`. */
export function withKeyPointsForModel(forModel: Record<string, unknown>, keyPoints: readonly string[] | undefined): Record<string, unknown> {
	if (!keyPoints || keyPoints.length === 0 || forModel.dismissed === true) return forModel;
	forModel.keyPoints = keyPoints.map((p, i) => `${i + 1}. ${p}`);
	forModel.next = [typeof forModel.next === "string" ? forModel.next : "", KEY_POINTS_NEXT_TEXT].filter(Boolean).join(" ");
	return forModel;
}

/** A persisted `previousKeyPoints`: the distinct 1-based numbers in range, or undefined when absent or unreadable. */
export function normalizePreviousKeyPoints(raw: unknown, count: number): Set<number> | undefined {
	const list = arrayOf(raw);
	if (!list) return undefined;
	const out = new Set<number>();
	for (const item of list) {
		const n = typeof item === "number" ? item : typeof item === "string" ? Number(item.trim()) : NaN;
		if (Number.isInteger(n) && n >= 1 && n <= count) out.add(n);
	}
	return out;
}

/** The view parts the marks scan reads (a subset of LhViewPart). */
interface MarkPart {
	type: string;
	toolCallId?: string;
	state?: string;
	input?: unknown;
}

const GRADED_PART_TYPES = new Set(["tool-quiz", "tool-explain", "tool-probe", "tool-recall", "tool-ask_user_question"]);
const TEACH_QUESTION_PART_TYPES = new Set(["tool-quiz", "tool-explain"]);

/**
 * The tutor's verdict per key point, for each answered `explain` that has one: answered explain call id → the numbers of
 * the points met. The verdict rides the NEXT teach question the tutor posed (its `previousKeyPoints`, beside `previous`),
 * before any other question was answered. A refused call (output-error) does not count; a question with no
 * `previousKeyPoints`, or none at all yet, leaves the answer unmarked (absent from the map).
 */
export function keyPointMarksOf(messages: ReadonlyArray<{ role?: string; parts: ReadonlyArray<MarkPart> }>): Map<string, Set<number>> {
	const marks = new Map<string, Set<number>>();
	let waiting: { id: string; count: number } | null = null;
	for (const message of messages) {
		for (const part of message.parts) {
			if (!GRADED_PART_TYPES.has(part.type) || !part.toolCallId) continue;
			if (part.state === "output-error") continue;
			if (waiting && TEACH_QUESTION_PART_TYPES.has(part.type)) {
				const met = normalizePreviousKeyPoints((part.input as { previousKeyPoints?: unknown } | undefined)?.previousKeyPoints, waiting.count);
				if (met) marks.set(waiting.id, met);
				waiting = null;
			}
			if (part.state !== "output-available") continue;
			// an answered question: the next teach question grades this one (only an explain with key points is waited for)
			const points = part.type === "tool-explain" ? keyPointsOfCall("explain", part.input) : undefined;
			waiting = points ? { id: part.toolCallId, count: points.length } : null;
		}
	}
	return marks;
}

function arrayOf(raw: unknown): unknown[] | undefined {
	if (Array.isArray(raw)) return raw;
	// the GLM wobble: an array sent as its JSON text (the boundary heal repairs it; a raw record may still carry it)
	if (typeof raw === "string" && raw.trim().startsWith("[")) {
		try {
			const parsed: unknown = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed : undefined;
		} catch {
			return undefined;
		}
	}
	return undefined;
}
