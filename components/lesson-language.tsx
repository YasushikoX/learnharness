"use client";

import { createContext, useContext } from "react";
import { DEFAULT_LESSON_LANGUAGE, lessonLabels, type LessonLabels, type LessonLanguage } from "@/src/core";

/**
 * The lesson's language for transcript cards (WP6, 2026-11-25): the chat page provides its session language, so a card
 * deep in the transcript (a shown figure, an answered question) can label its notes in it without threading a prop
 * through every renderer. Outside a chat page (tests, previews) it is English.
 */
export const LessonLanguageContext = createContext<LessonLanguage>(DEFAULT_LESSON_LANGUAGE);

/** The labels for the current lesson language. */
export function useLessonLabels(): LessonLabels {
	return lessonLabels(useContext(LessonLanguageContext));
}
