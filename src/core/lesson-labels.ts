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
	/** Vocabulary coverage (WP5, 2026-11-25): the course page, the approval screen and the lesson result. */
	readonly coverage: CoverageLabels;
}

export interface CoverageLabels {
	/** "terms: 9 of 11 introduced, 6 checked" */
	readonly skillLine: (introduced: number, total: number, checked: number) => string;
	readonly stateNew: string;
	readonly stateIntroduced: string;
	readonly stateChecked: string;
	/** Checked by a question that never named it: not introduced. */
	readonly stateAsked: string;
	/** "left for later 2×": how many finished lessons deferred it. */
	readonly deferredCount: (n: number) => string;
	readonly supporting: string;
	readonly noDefinition: string;
	/** "3 new terms are not assigned to a skill" */
	readonly unassignedLine: (n: number) => string;
	/** "2 terms are no longer in the material" */
	readonly flaggedLine: (n: number) => string;
	readonly assignTo: string;
	readonly exclude: string;
	readonly excludeReason: string;
	readonly remove: string;
	readonly remapTo: string;
	readonly sameThing: string;
	readonly linked: string;
	readonly unlink: string;
	/** "Leave 4 terms unassigned" */
	readonly leaveUnassigned: (n: number) => string;
	/** The reason stored on a term left out at approval. */
	readonly leftAtApproval: string;
	readonly mapTerms: string;
	readonly mapping: string;
	readonly termsHeading: string;
	readonly duplicatesHeading: string;
	readonly excludedHeading: string;
	/** The planner named ids not in the glossary. */
	readonly droppedLine: (n: number) => string;
	/** Materials whose index is incomplete. */
	readonly incompleteLine: (names: string) => string;
	/** The lesson result: "Covered 9 of 11 terms; 2 left for next time: a, b" */
	readonly lessonLine: (covered: number, total: number, left: readonly string[]) => string;
	/** A mapping pass's proposals awaiting the student. */
	readonly suggestionsHeading: string;
	/** "Leave out: why" */
	readonly suggestExclude: (reason: string) => string;
	readonly accept: string;
	readonly dismiss: string;
	/** Earlier decisions an approval could not keep. */
	readonly displacedHeading: string;
	readonly displacedOk: string;
	/** The draft was made before the class's terms were indexed. */
	readonly draftEmpty: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const LESSON_LABELS: Readonly<Record<LessonLanguage, LessonLabels>> = {
	en: {
		lookAt: "Look at",
		tryThis: "Try this",
		keyPoints: "Key points",
		keyPointMet: "in your answer",
		keyPointMissed: "missing from your answer",
		coverage: {
			skillLine: (i, t, c) => `terms: ${i} of ${t} introduced, ${c} checked`,
			stateNew: "new",
			stateIntroduced: "introduced",
			stateChecked: "checked",
			stateAsked: "asked about, never named",
			deferredCount: (n) => `left for later ${n}×`,
			supporting: "supporting",
			noDefinition: "no definition in the material",
			unassignedLine: (n) => `${plural(n, "new term is", "new terms are")} not assigned to a skill`,
			flaggedLine: (n) => `${plural(n, "term is", "terms are")} no longer in the material`,
			assignTo: "Assign to…",
			exclude: "Exclude",
			excludeReason: "Why leave it out?",
			remove: "Remove",
			remapTo: "Remap to…",
			sameThing: "Same thing",
			linked: "linked",
			unlink: "Unlink",
			leaveUnassigned: (n) => `Leave ${plural(n, "term", "terms")} unassigned`,
			leftAtApproval: "left out at approval",
			mapTerms: "Map the class's terms",
			mapping: "Mapping the class's terms…",
			termsHeading: "Terms",
			duplicatesHeading: "Maybe the same term",
			excludedHeading: "Left out",
			droppedLine: (n) => `The planner named ${plural(n, "term id", "term ids")} that ${n === 1 ? "is" : "are"} not in the glossary; dropped:`,
			incompleteLine: (names) => `Not fully indexed yet, so their terms may be missing: ${names}`,
			lessonLine: (covered, total, left) =>
				left.length === 0 ? `Covered all ${plural(total, "term", "terms")}.` : `Covered ${covered} of ${plural(total, "term", "terms")}; ${left.length} left for next time: ${left.join(", ")}`,
			suggestionsHeading: "Suggested by the planner",
			suggestExclude: (reason) => `Leave out: ${reason}`,
			accept: "Accept",
			dismiss: "Dismiss",
			displacedHeading: "Not kept from the earlier map",
			displacedOk: "OK",
			draftEmpty: "This draft was made before the class's terms were indexed: assign them below, or let the planner map them.",
		},
	},
	nb: {
		lookAt: "Se på",
		tryThis: "Prøv dette",
		keyPoints: "Nøkkelpunkter",
		keyPointMet: "med i svaret ditt",
		keyPointMissed: "mangler i svaret ditt",
		coverage: {
			skillLine: (i, t, c) => `begreper: ${i} av ${t} gjennomgått, ${c} sjekket`,
			stateNew: "nytt",
			stateIntroduced: "gjennomgått",
			stateChecked: "sjekket",
			stateAsked: "spurt om, aldri nevnt",
			deferredCount: (n) => `utsatt ${n}×`,
			supporting: "støttebegrep",
			noDefinition: "ingen definisjon i materialet",
			unassignedLine: (n) => `${plural(n, "nytt begrep er", "nye begreper er")} ikke knyttet til en ferdighet`,
			flaggedLine: (n) => `${plural(n, "begrep er", "begreper er")} ikke lenger i materialet`,
			assignTo: "Knytt til…",
			exclude: "Utelat",
			excludeReason: "Hvorfor utelate det?",
			remove: "Fjern",
			remapTo: "Knytt om til…",
			sameThing: "Samme begrep",
			linked: "koblet",
			unlink: "Fjern kobling",
			leaveUnassigned: (n) => `La ${plural(n, "begrep", "begreper")} stå uten ferdighet`,
			leftAtApproval: "utelatt ved godkjenning",
			mapTerms: "Knytt klassens begreper til ferdigheter",
			mapping: "Knytter klassens begreper…",
			termsHeading: "Begreper",
			duplicatesHeading: "Kanskje samme begrep",
			excludedHeading: "Utelatt",
			droppedLine: (n) => `Planleggeren nevnte ${plural(n, "begrep-id", "begrep-id-er")} som ikke finnes i ordlisten; fjernet:`,
			incompleteLine: (names) => `Ikke ferdig indeksert ennå, så begreper kan mangle: ${names}`,
			lessonLine: (covered, total, left) =>
				left.length === 0 ? `Gikk gjennom alle ${plural(total, "begrep", "begrepene")}.` : `Gikk gjennom ${covered} av ${plural(total, "begrep", "begreper")}; ${left.length} til neste gang: ${left.join(", ")}`,
			suggestionsHeading: "Foreslått av planleggeren",
			suggestExclude: (reason) => `Utelat: ${reason}`,
			accept: "Godta",
			dismiss: "Avvis",
			displacedHeading: "Ikke beholdt fra det forrige kartet",
			displacedOk: "OK",
			draftEmpty: "Utkastet ble laget før klassens begreper var indeksert: knytt dem til ferdigheter nedenfor, eller la planleggeren gjøre det.",
		},
	},
};

export function lessonLabels(language?: LessonLanguage): LessonLabels {
	return LESSON_LABELS[language ?? DEFAULT_LESSON_LANGUAGE] ?? LESSON_LABELS[DEFAULT_LESSON_LANGUAGE];
}
