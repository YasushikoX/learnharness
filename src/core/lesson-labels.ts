/**
 * Learner-facing labels that follow the lesson language (WP6, 2026-11-25). PURE, browser-safe.
 *
 * The same compact per-language table as the read-aloud phrases (core/speech-text.ts SPEECH_PHRASES): adding a lesson
 * language means adding one entry here. Only the labels the question-quality package added live here.
 */

import { DEFAULT_LESSON_LANGUAGE, type LessonLanguage } from "./language.ts";

export interface LessonLabels {
	/** Above a shown figure's `lookAt` points. */
	readonly lookAt: string;
	/** Above a shown demo's `tryThis`. */
	readonly tryThis: string;
	/** Above an answered written question's key points. */
	readonly keyPoints: string;
	/** A key point the tutor found in the answer (screen readers; the mark is a glyph). */
	readonly keyPointMet: string;
	/** A key point the tutor did not find in the answer. */
	readonly keyPointMissed: string;
}

export const LESSON_LABELS: Readonly<Record<LessonLanguage, LessonLabels>> = {
	en: { lookAt: "Look at", tryThis: "Try this", keyPoints: "Key points", keyPointMet: "in your answer", keyPointMissed: "missing from your answer" },
	nb: { lookAt: "Se på", tryThis: "Prøv dette", keyPoints: "Nøkkelpunkter", keyPointMet: "med i svaret ditt", keyPointMissed: "mangler i svaret ditt" },
};

export function lessonLabels(language?: LessonLanguage): LessonLabels {
	return LESSON_LABELS[language ?? DEFAULT_LESSON_LANGUAGE] ?? LESSON_LABELS[DEFAULT_LESSON_LANGUAGE];
}
