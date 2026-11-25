"use client";

import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ViewReaderRef, NativeQuestionViewState } from "./session-view-readers";
import { ArrowDownIcon, CameraIcon, ChevronRightIcon, LightbulbIcon, MessageSquareIcon, PenLineIcon, PlayIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PhotoError, preparePhoto, releasePhoto, type PreparedPhoto } from "@/components/photo-answer";
import { useCamera } from "@/components/use-camera";
import { finishDictation, isDictationActive, joinDictation, useDictationTarget } from "@/components/dictation";
import { enterSends, useEnterSubmits } from "@/components/enter-submits";
import { useOptionalInteractionLayers } from "./interaction-layers";
import { isInteractionScopeEligible } from "./plugin-input-focus";
import { PathInput, pathInputClassName } from "@/components/path-input";
import { MalformedQuestion } from "@/components/malformed-question";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { FigureScope } from "@/components/figures/figure-scope";
import { ClarifyWording } from "@/components/clarify-wording";
import { teaserText } from "@/components/teaser-text";
import { QuestionPreview } from "@/components/question-preview";
import { SketchChoices } from "@/components/sketch/sketch-choices";
import { SketchView } from "@/components/sketch/sketch-view";
import { hasNewInk, pagePayload, readInk, readKept, sendPage, useInk } from "@/components/sketch/ink-memory";
import { nativeInkBridge, nativeInkEnabled } from "@/components/sketch/use-native-ink";
import { cn } from "@/lib/utils";
import { ChatActionsContext } from "@/components/chat";
import { hintEligible } from "@/src/core";
import { hintLabel, useHints } from "@/components/use-hints";
import {
	buildAnswer,
	steeredAnswer,
	toClientQuestion,
	normalizeQuizType,
	keyPointsOfCall,
	CONFIDENCE_LEVELS,
	CONFIDENCE_STOPS,
	dockSubmitGate,
	emptyDockSelection,
	displayedOptionLetter,
	questionDisplayOptions,
	resolveCorrect,
	toolQuestionKind,
	parseAskInput,
	parseQuizInput,
	parseExplainInput,
	sketchRefOf,
	toggleOption,
	toggleOther,
	type AnswerRequest,
	type AskToolInput,
	type ConfidenceControl,
	type DockSelection,
	type ExplainToolInput,
	type LessonLanguage,
	type QuestionAnswerData,
	type QuestionFormDraft,
	type QuestionData,
	type QuestionMode,
	type QuizToolInput,
	type SelectMode,
	type SketchPayload,
	type Phase3,
} from "@/src/core";
import { ConfidenceButtons, DONT_KNOW_LEADING } from "@/components/confidence-buttons";
import { DockActions, DockToolLabel, DONT_KNOW_ACTION } from "@/components/question-actions";
import { confidenceIndexFor, ConfidenceSlider, initialConfidenceFromDraft, stepConfidenceKey } from "@/components/confidence-slider";
import { QuestionReadAloud, readAloudStandIn } from "@/components/question-read-aloud";
import { useAppearance } from "@/components/settings/appearance";
import type { PrepareBuiltinSubmission } from "./plugin-submission-adapters";
import {
	ANSWER_COLUMN_FRAME,
	ANSWER_OPTIONS_PAD,
	QUESTION_COLUMN_PAD,
	STACKED_AREA_PAD,
	cloneWithImageSizes,
	type QuestionLayout,
} from "@/components/question-layout";
import { useQuestionLayout, type QuestionLayoutRequest } from "@/components/use-question-layout";
import { captureReadingPosition, holdAcrossSwitch, restoreReadingPosition, revealFocused, trackReadingPosition, visibleFocused } from "@/components/dock-switch";

export type { QuestionLayoutRequest } from "@/components/use-question-layout";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

// ─── The question card's static geometry ────────────────────────────────────
// Shared by the card's JSX and by questionCardStandIn below (answered cards
// measure a stand-in of the question card, so both solve the same layout).
// Fork: the label row also holds the read-aloud button (in the row, never over the question; the stand-in reserves its box).
const QC_LABEL = "mb-1 flex items-center lh-eyebrow text-muted-foreground";
const QC_LABEL_TEXT = "min-w-0 [overflow-wrap:anywhere]";
const QC_QUESTION = "mb-3 font-medium";
const QC_CONTEXT = "mb-3 text-sm text-muted-foreground";
const QC_OPTION_LIST = "flex flex-col gap-2 pb-2";
// Options (UI round 1b, SPEC §7): radius 8, 8px apart, a hairline at rest; the selected one carries a 2px accent
// indicator (the border plus an inset 1px, so nothing shifts) on a light accent fill.
const QC_OPTION_ROW = "flex items-center gap-3 rounded-md border border-border px-3 py-2 text-left text-sm outline-none transition-[background-color,border-color,box-shadow] duration-(--lh-duration-hover) ease-(--lh-ease) focus-visible:ring-2 focus-visible:ring-focus";
const QC_OPTION_SELECTED = "border-primary bg-primary/[0.07] shadow-[inset_0_0_0_1px_var(--primary)]";
const QC_OPTION_MARK = "flex size-[1.125rem] shrink-0 items-center justify-center border";
const QC_OPTION_LETTER = "text-eyebrow font-semibold leading-none";
const QC_OTHER_INPUT = "lh-input w-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground";
const OTHER_PLACEHOLDER = "Type your own answer…";

/** The question card's label: the tool's own name for probe-phase calls. */
export function questionCardLabel(tool: string | undefined, kind: string, questionType: string | undefined): string {
	if (tool === "probe") return "Probe";
	if (tool === "recall") return "Recall";
	if (kind === "quiz") return questionType === "predict" ? "Prediction" : "Check";
	if (kind === "explain") return questionType === "final" ? "Final problem" : questionType === "recall" ? "Recall" : "Explain";
	return "Question";
}

/** What an answered card knows of the question it answered. Rendered
 *  content (question, context, option labels) is the card's own LIVE
 *  markdown, cloned — never rendered twice. */
export interface QuestionCardContent {
	label: string;
	kind: "quiz" | "ask";
	multiSelect: boolean;
	/** Containers whose children are the rendered markdown. */
	question: HTMLElement;
	context: HTMLElement | null;
	options: HTMLElement[];
	optionLetters?: readonly (string | undefined)[];
}

/**
 * A detached stand-in of the pending question card's question part, option
 * list and confidence row, built from the same classes as its JSX, for the
 * layout probe: the answered card's layout is then exactly the one the
 * question card had (owner: "exactly when the question card would").
 */
export function questionCardStandIn(doc: Document, c: QuestionCardContent): { question: HTMLElement; options: HTMLElement; confidence: HTMLElement | null } {
	const el = (tag: string, className: string, ...children: (Node | string)[]) => {
		const node = doc.createElement(tag);
		node.className = className;
		node.append(...children);
		return node;
	};
	const contents = (live: HTMLElement) => [...live.childNodes].map((n) => (n instanceof HTMLElement ? cloneWithImageSizes(n) : n.cloneNode(true)));
	const question = el("div", "",
		el("div", QC_LABEL, el("span", QC_LABEL_TEXT, c.label + (c.multiSelect ? " · select all that apply" : "")), readAloudStandIn(doc)),
		el("div", QC_QUESTION, ...contents(c.question)),
	);
	if (c.context) question.append(el("div", QC_CONTEXT, ...contents(c.context)));
	const mark = (round: boolean) => el("span", cn(QC_OPTION_MARK, round ? "rounded-full" : "rounded-sm", "border-muted-foreground/40"));
	const list = el("div", QC_OPTION_LIST);
	for (const [i, option] of c.options.entries()) {
		const icon = mark(!c.multiSelect);
		const letter = c.optionLetters?.[i];
		if (letter) icon.append(el("span", QC_OPTION_LETTER, letter));
		list.append(el("button", QC_OPTION_ROW, icon, el("span", "", ...contents(option))));
	}
	// (Fork: the quiz's "I don't know" is a button in the confidence row, not an option row.)
	if (c.kind === "ask") {
		const input = el("div", cn(pathInputClassName(true), QC_OTHER_INPUT));
		input.dataset.empty = "true";
		input.dataset.placeholder = OTHER_PLACEHOLDER;
		list.append(el("div", QC_OPTION_ROW, mark(!c.multiSelect), input));
	}
	const options = el("div", "", list);
	// Fork: the confidence buttons are a full-width row below the question area, outside the measured columns.
	return { question, options, confidence: null };
}

/**
 * The question dock — a pending quiz/ask REPLACES the chat composer: the
 * persistent bottom blob morphs into the question. Two voices meet here:
 * the teacher's (question, options, explanation) and the learner's —
 * "Your thinking", a labeled composer-twin field for dumping reasoning,
 * with Submit docked inside it exactly like the chat composer's send.
 *
 * The thinking field is the transfer channel of the whole product (wave-2):
 * never called "optional", Enter makes a NEWLINE (it is for dumping — soon
 * dictated, not typed), submission is the button only, and its size scales
 * with the phase (probing stays quick; teaching invites depth). The
 * "Other…" option is an editable option ROW — circle + inline input,
 * styled like its siblings — so picking Other never displaces thinking.
 *
 * Collapse behavior (scroll-up → slim bar) is owned by the DockOverlay in the
 * chat view, which also owns the persistent shell and its height morph. This
 * component is content only. The expanded form stays MOUNTED while collapsed
 * (hidden, not unmounted) so a half-made selection survives scrolling.
 */

export interface QuestionDockProps {
	/** Private click-time view read: no draft save or dictation flush. */
	viewReader?: ViewReaderRef<NativeQuestionViewState>;
	toolName: "quiz" | "probe" | "ask_user_question" | "explain" | "recall";
	toolCallId: string;
	/** The native message the call sits in: with it the question's wording (stem, context) is markable for "Ask about this". */
	messageId?: string;
	/** A follow-up card about the wording is open: only the wording shows; the options and the answer fields are hidden (kept
	 *  mounted, so a half-made selection and typed text survive). */
	wordingOnly?: boolean;
	input: QuizToolInput | AskToolInput | ExplainToolInput;
	/** Collapse state, owned by the DockOverlay (it drives the shell's height morph). */
	expanded: boolean;
	/**
	 * Teach-phase check awaiting its reveal (vision §2, W5): while collapsed,
	 * the bar is the "Check your understanding" invitation instead of the
	 * scroll-collapse strip. Owned by the DockOverlay; false once the learner
	 * has revealed (afterwards the normal collapse machine rules apply).
	 */
	reveal?: boolean;
	onExpand: () => void;
	/** A sketch submit (Android plan M1, text mode) passes the handwriting;
	 *  the answer then carries its ref. */
	onSubmit: (output: QuestionAnswerData, sketch?: SketchPayload, onAccepted?: () => void) => Promise<boolean> | void;
	/** The host's capture step for an answer that carries more than the form (a plugin adapter's images). It runs inside
	 *  the confidence-first flow: after the confidence press, with the request read at that moment. */
	onPrepareSubmission?: PrepareBuiltinSubmission;
	/** Images are waiting to go with the answer (so an empty form may still be sent). */
	hasPendingInput?: (question: QuestionData) => boolean;
	preparing?: boolean;
	/** Restore only this call's unconfirmed submission after recovery. */
	initialDraft?: QuestionFormDraft;
	onSaveDraft?: (draft: QuestionFormDraft) => void;
	/** The session's model reads images — text mode then offers "Open in
	 *  sketch" (a text-only model would silently drop the pages). */
	sketchAvailable?: boolean;
	/** Escape in a question field stops dictation (STT wave) — threaded
	 *  from the page that owns the dictation hook. */
	onEscape?: () => void;
	/** The learner's current unsubmitted working (thinking, or the typed
	 *  answer in text mode), kept current for the side thread's nudges. */
	workingRef?: { current: string };
	/** The keyboard machine (wave B) is armed only while the dock is
	 *  expanded — the collapsed bar keeps its native Enter-to-expand. */
	active?: boolean;
	/** Session phase at the question — scales the thinking field: probing
	 *  stays quick (one row), teaching invites dumping (three rows). */
	phase?: Phase3;
	/** Dictation claim (owner 2026-10-03): false while a teach-phase check
	 *  sits UNREVEALED — the reading-thinking field owns dictated speech
	 *  during the reading; the dock reclaims on reveal. Default true (probe
	 *  questions, predictions, old callers). */
	dictationClaim?: boolean;
	/** Compaction is running for this chat (owner round 14): the answer
	 *  POST would block on the server's compaction gate — disable submit
	 *  and say so in the hint row. The server registry is the real gate;
	 *  this is the affordance. */
	compactionRunning?: boolean;
	/** Adaptive layout (Appearance → Adapt question layout); null/absent = off. */
	layoutRequest?: QuestionLayoutRequest | null;
	/** Reports the solved layout (null when off or unmounted). */
	onLayout?: (layout: QuestionLayout | null) => void;
	/** Lesson language for read-aloud voice selection. */
	language?: LessonLanguage;
	/** The chat the question is in (read-aloud remembers auto-read questions per chat). */
	chatId?: string;
	/** Override the confidence control mode (defaults to Appearance setting). */
	confidenceControl?: ConfidenceControl;
}

export function QuestionDock({
	viewReader,
	toolName,
	toolCallId,
	messageId,
	wordingOnly = false,
	input,
	expanded,
	reveal = false,
	onExpand,
	onSubmit,
	onPrepareSubmission,
	hasPendingInput,
	preparing,
	initialDraft,
	onSaveDraft,
	onEscape,
	phase = "probe",
	dictationClaim = true,
	compactionRunning = false,
	sketchAvailable = false,
	workingRef,
	layoutRequest,
	onLayout,
	language,
	chatId,
	confidenceControl,
}: QuestionDockProps) {
	// The probe-phase names (owner, 2026-10-09) canonicalize onto their
	// teach twins for every dock concern — parse dispatch, labels, kinds:
	// the probe quiz ("probe") is quiz-shaped, the probe free-recall
	// ("recall") is explain-shaped. Old records keep the teach names.
	const canonical =
		toolName === "probe" ? "quiz" : toolName === "recall" ? "explain" : toolName;
	// The chip's display name carries the tool's OWN name (owner
	// 2026-10-09): probe-phase questions label Probe/Recall in the
	// composer; teach tools keep the standing labels.
	const toolLabel = toolName === "probe" ? "Probe" : toolName === "recall" ? "Recall" : undefined;
	// Parse, don't cast (src/core/tool-parts.ts): the model authored this
	// input, and only the schema the tool declared vouches for its shape.
	// The dock mounts on input-available parts (already validated at the
	// bridge), so this is pure defense in depth — but it is STRUCTURAL now:
	// anything that slips through renders the quiet fallback, never a
	// crash on `.map` over model-authored bytes.
	const parsed = useMemo(() =>
		canonical === "quiz" ? parseQuizInput(input) : canonical === "explain" ? parseExplainInput(input) : parseAskInput(input), [canonical, input]);
	if (!parsed) {
		return <MalformedQuestion />;
	}
	return (
		<>
			{!expanded && (
				<QuestionDockBar
					toolName={canonical}
					question={parsed.question}
					onExpand={onExpand}
					variant={reveal ? "reveal" : "collapsed"}
					toolLabel={toolLabel}
					label={
						(canonical === "quiz" || canonical === "explain") &&
						normalizeQuizType((parsed as { type?: unknown }).type) === "predict"
							? "Prediction"
							: canonical === "explain" && normalizeQuizType((parsed as { type?: unknown }).type) === "final"
								? "Final problem"
								: canonical === "explain" && normalizeQuizType((parsed as { type?: unknown }).type) === "recall"
									? "Recall"
									: undefined
					}
				/>
			)}
			<div className={expanded ? "dock-variant" : "invisible h-0 overflow-hidden"}>
				<QuestionDockForm
					viewReader={viewReader}
					toolName={toolName}
					toolCallId={toolCallId}
					messageId={messageId}
					wordingOnly={wordingOnly}
					input={parsed}
					phase={phase}
					active={expanded}
					onSubmit={onSubmit}
					onPrepareSubmission={onPrepareSubmission}
					hasPendingInput={hasPendingInput}
					preparing={preparing}
					initialDraft={initialDraft}
					onSaveDraft={onSaveDraft}
					onEscape={onEscape}
					workingRef={workingRef}
					dictationClaim={dictationClaim}
					compactionRunning={compactionRunning}
					sketchAvailable={sketchAvailable}
					layoutRequest={layoutRequest}
					onLayout={onLayout}
					language={language}
					chatId={chatId}
					confidenceControl={confidenceControl}
				/>
			</div>
		</>
	);
}

/** The collapsed strip. Two species (W5): "collapsed" is the scroll minimization
 *  (kind chip + one-liner + Answer ↓); "reveal" is the teach-check invitation —
 *  a distinct, more inviting affordance, because it asks the learner to start
 *  something, not to resume something. */
export function QuestionDockBar({
	toolName,
	question,
	onExpand,
	variant = "collapsed",
	label,
	toolLabel,
}: {
	toolName: "quiz" | "ask_user_question" | "explain";
	question: string;
	onExpand: () => void;
	variant?: "collapsed" | "reveal";
	/** The kind chip's text (owner 2026-10-03): "Prediction" when a
	 *  predict-type quiz minimizes by scroll — predictions never use the
	 *  reveal variant, but the scroll-collapse strip can still hide them. */
	label?: string;
	/** The chip's TOOL display name (owner 2026-10-09): probe-phase calls
	 *  label Probe/Recall — the phase boundary visible in the composer. */
	toolLabel?: string;
}) {
	if (variant === "reveal") {
		return (
			<button
				type="button"
				data-testid="teach-check-reveal"
				onClick={onExpand}
				className="dock-variant flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-(--lh-duration-hover) ease-(--lh-ease) hover:bg-raised"
			>
				<span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
					<PlayIcon className="size-3.5" />
				</span>
				<span className="min-w-0 flex-1">
					<span className="block text-chrome font-medium">Check your understanding</span>
					<span className="block text-xs text-muted-foreground">
						<QuestionPreview>{question}</QuestionPreview>
					</span>
				</span>
				<span className="flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
					Open <ChevronRightIcon className="size-3.5" />
				</span>
			</button>
		);
	}
	return (
		<button
			type="button"
			data-testid="question-dock-bar"
			onClick={onExpand}
			className="dock-variant flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm transition-colors duration-(--lh-duration-hover) ease-(--lh-ease) hover:bg-raised"
		>
			<span className="shrink-0 lh-eyebrow text-muted-foreground">
				{label ??
							toolLabel ??
							(toolName === "quiz" ? "Check" : toolName === "explain" ? "Explain" : "Question")}
			</span>
			<span className="min-w-0 flex-1 text-muted-foreground">
				<QuestionPreview>{question}</QuestionPreview>
			</span>
			<span className="flex shrink-0 items-center gap-1 text-xs font-medium">
				Answer <ArrowDownIcon className="size-3.5" />
			</span>
		</button>
	);
}

/** The expanded question: label, question, options, and the unified bottom row. */
function QuestionDockForm({
	viewReader,
	toolName,
	toolCallId,
	messageId,
	wordingOnly = false,
	input,
	phase = "probe",
	active,
	onSubmit,
	onPrepareSubmission,
	hasPendingInput,
	preparing,
	initialDraft,
	onSaveDraft,
	onEscape,
	dictationClaim = true,
	compactionRunning = false,
	sketchAvailable = false,
	workingRef,
	layoutRequest,
	onLayout,
	language,
	chatId,
	confidenceControl,
}: Omit<QuestionDockProps, "expanded" | "onExpand" | "reveal">) {
	const kind = toolQuestionKind(toolName);
	const { appearance } = useAppearance();
	const confidenceMode = confidenceControl ?? appearance.confidenceControl;
	const stopSpeechRef = useRef<(() => void) | null>(null);
	const controller = useOptionalInteractionLayers();
	const rootRef = useRef<HTMLDivElement>(null);
	const questionPartRef = useRef<HTMLDivElement>(null);
	const optionsRef = useRef<HTMLDivElement>(null);
	const confidenceRef = useRef<HTMLDivElement>(null);

	// Canonical QuestionData, built once per question. Quiz options are
	// deterministically shuffled (seeded by toolCallId) so position never leaks
	// correctness AND server/client render the same order (hydration-safe);
	// the display order is snapshotted into the answer record at submit time.
	const qd = useMemo<QuestionData>(() => {
		const quizInput = kind === "quiz" ? (input as QuizToolInput) : null;
		const askInput = kind === "ask" ? (input as AskToolInput) : null;
		const explainInput = kind === "explain" ? (input as ExplainToolInput) : null;
		const multi = input instanceof Object && "multiSelect" in input ? input.multiSelect === true : false;
		const mode: QuestionMode =
			kind === "quiz"
				? multi
					? "multi-select"
					: "single-select"
				: askInput?.options?.length
					? multi
						? "multi-select"
						: "single-select"
						: "text";
		const { options: ordered, optionOrder } = questionDisplayOptions(quizInput?.options ?? askInput?.options, kind, multi, toolCallId);
		const q: QuestionData = {
			id: toolCallId,
			kind,
			// The role (owner 2026-10-03): predict questions gate by it in the
			// view (never collapsed) and the answered card tucks the explanation.
			questionType: kind === "quiz" || kind === "explain" ? normalizeQuizType((input as { type?: unknown }).type) : undefined,
			question: input.question,
			context: input.details,
			mode,
			options: ordered,
			optionOrder,
			createdAt: new Date().toISOString(),
		};
		if (quizInput) {
			const resolved = resolveCorrect(quizInput.correctAnswer, ordered);
			if (resolved.error) console.error("[quiz] correctAnswer did not resolve:", resolved.error);
			q.correctIndices = resolved.indices;
			q.explanation = quizInput.explanation;
		}
		if (explainInput) {
			// The commitment rides the question data (never sent to the
			// client before answering) and snapshots into the answer at submit.
			// One field, reasoning included — no separate explanation
			// (owner ruling 2026-09-27).
			q.committedAnswer = explainInput.correctAnswer;
			// The key points (WP6) ride beside it the same way: snapshotted into the answer, never into toClientQuestion.
			const keyPoints = keyPointsOfCall(toolName, input);
			if (keyPoints) q.keyPoints = keyPoints;
		}
		return q;
	}, [toolCallId, kind, input, toolName]);

	// The selection state machine lives in question-core (pure, tested):
	// single-select displaces, multi-select coexists — picking the ask
	// "Other…" row in a multi-select must never clear already-picked
	// options, and picking an option must never clear a typed custom answer.
	const [sel, setSel] = useState<DockSelection>(() => initialDraft?.selection ?? emptyDockSelection());
	// The learner's transfer channel — thinking, never "a note".
	const [thinking, setThinking] = useState(initialDraft?.thinking ?? "");
	const [other, setOther] = useState(initialDraft?.other ?? "");
	const [text, setText] = useState(initialDraft?.text ?? "");
	// Mirrors the working out for the side thread (nudges respond to it).
	useEffect(() => {
		if (workingRef) workingRef.current = (qd.mode === "text" ? text : thinking).trim();
	}, [workingRef, qd.mode, text, thinking]);
	useEffect(() => () => { if (workingRef) workingRef.current = ""; }, [workingRef]);
	/* Refs MIRROR the two dictation-target fields ("nothing gets lost"
	 * round, owner 2026-10-01): the run's flush lands via setState, which
	 * a closure waiting through `await finishDictation()` cannot observe
	 * in time — submit reads these, kept current at every write site. */
	const thinkingTextRef = useRef(initialDraft?.thinking ?? "");
	const answerTextRef = useRef(initialDraft?.text ?? "");
	// Confidence (owner, 2026-10-01): an index into CONFIDENCE_STOPS, or
	// null while unset — NO default (owner, 2026-10-25): a picked quiz
	// answer cannot be sent until the learner chooses a stop. The dock
	// unmounts between questions, so each question starts unset (a recovered
	// unconfirmed submission restores what was chosen).
	const [conf, setConf] = useState<number | null>(() => initialConfidenceFromDraft(initialDraft));
	const [sketching, setSketching] = useState(false);
	// A photo of the work (M17): the same read-first sketch answer, as one raster page; sent through the sketch path below
	const [photo, setPhoto] = useState<PreparedPhoto | null>(null);
	const [photoError, setPhotoError] = useState<string | null>(null);
	useEffect(() => () => releasePhoto(photo), [photo]);
	const camera = useCamera((files) => {
		const file = files[0];
		if (!file) return;
		setPhotoError(null);
		preparePhoto(file).then(setPhoto, (err: unknown) => setPhotoError(err instanceof PhotoError ? err.message : "The photo could not be used."));
	});
	// A switch to a text-only model closes an open sketch (its ink stays).
	useEffect(() => {
		if (!sketchAvailable) setSketching(false);
	}, [sketchAvailable]);
	const selectMode: SelectMode = qd.mode === "multi-select" ? "multi-select" : "single-select";

	// The PRIMARY dictation input (owner, STT round 1): while a question
	// waits, dictated finals land HERE, never in the hidden composer — text
	// mode owns "Your answer", select modes own "Your thinking". The claim
	// is effect-scoped, so the question unmounting releases it and
	// dictation falls back to the composer automatically.
	useDictationTarget(
		useCallback(
			(t: string, withdraw?: boolean) => {
				// Ref-first (see the refs block above): the join is computed from
				// the mirror, then both mirrors agree with state — a submit
				// resuming post-finish reads the tail, never a stale closure.
				if (qd.mode === "text") {
					const v = joinDictation(answerTextRef.current, t, withdraw);
					answerTextRef.current = v;
					setText(v);
				} else {
					const v = joinDictation(thinkingTextRef.current, t, withdraw);
					thinkingTextRef.current = v;
					setThinking(v);
				}
			},
			[qd.mode],
		),
		// Released while a teach check sits unrevealed (owner 2026-10-03):
		// the reading-thinking field owns dictated speech during the reading.
		dictationClaim,
	);

	const toggle = (idx: number) => setSel(toggleOption(selectMode, sel, idx));

	/** A press on a confidence button (or "I don't know") submits THIS render's answer with that press, so the gate and the
	 *  request read the override rather than state that has not landed yet (owner, 2026-10-28: Anki-style buttons). */
	/* UNSENT INK (owner report, 2026-11-13): a sketch drawn in the sketch view and left there by closing it used to be
	 * dropped when the answer was then sent from the dock ("I don't know" after an hour of work reached the tutor with
	 * no work). Ink waiting on this question's page now rides whatever the dock sends, shown as a chip the learner can
	 * remove. */
	const inkState = useInk(toolCallId);
	const [skipInk, setSkipInk] = useState(false);
	// Dropping unsent ink from an answer takes two taps (owner, 2026-11-15); the note also says when ink could not be attached
	const [inkNote, setInkNote] = useState<string | null>(null);
	const [confirmSkip, setConfirmSkip] = useState(false);
	const inkWaiting = sketchAvailable && !skipInk && hasNewInk(inkState);
	/* THE STEER BUTTON (owner, 2026-11-18): write to the tutor instead of answering. The open question is set aside (a dismissal that
	 * carries these words and wakes the tutor: never graded) and comes back unless what is written changes the plan. Lesson checks only. */
	const placementRecall = toolName === "recall" && typeof (input as { skill?: unknown } | undefined)?.skill === "string";
	const showConfidence = kind === "quiz" || placementRecall;
	const steerOffered = phase === "teach" && (kind === "quiz" || kind === "explain");
	const [steerOpen, setSteerOpen] = useState(false);
	const [steerText, setSteerText] = useState("");
	type SubmitOverride = { conf?: number; dontKnow?: boolean };
	const selFor = (ov?: SubmitOverride): DockSelection =>
		ov?.dontKnow ? { ...sel, selected: new Set(), otherSelected: false, dontKnow: true } : sel;
	const gateFor = (ov?: SubmitOverride) =>
		dockSubmitGate({
			kind,
			mode: qd.mode,
			sel: selFor(ov),
			other,
			text,
			confidenceSet: ov?.conf !== undefined || conf !== null,
			hasSketch: photo !== null || inkWaiting,
			requireConfidence: placementRecall,
		});
	// Images waiting in the host's adapter count as an answer (upstream): an empty form may still be sent with them.
	const pendingInput = hasPendingInput?.(qd) === true;
	const { canSubmit: formCanSubmit } = gateFor();
	const canSubmit = formCanSubmit || pendingInput;
	// An answer is picked (the confidence buttons wait for this and nothing else).
	const answerPicked = dockSubmitGate({ kind, mode: qd.mode, sel, other, text, confidenceSet: true, hasSketch: photo !== null || inkWaiting, requireConfidence: placementRecall }).canSubmit || pendingInput;
	const currentQuestion = useRef(qd); currentQuestion.current = qd;
	const mounted = useRef(true);
	useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
	const formValues = useRef({ sel, other, conf }); formValues.current = { sel, other, conf };
	useLayoutEffect(() => {
		if (!viewReader) return;
		const read = (): NativeQuestionViewState => {
			const { sel, other, conf } = formValues.current;
			return { question: qd, draft: { dontKnow: sel.dontKnow,
				values: [...sel.selected].flatMap(index => qd.options[index] ? [qd.options[index]!.value] : []),
				otherSelected: sel.otherSelected, other, text: answerTextRef.current, thinking: thinkingTextRef.current,
				...(showConfidence && conf !== null ? { confidence: conf } : {}) } };
		};
		viewReader.current = read;
		return () => { if (viewReader.current === read) viewReader.current = null; };
	}, [viewReader, qd, showConfidence]);
	const viewPresentationKey = JSON.stringify({ ...toClientQuestion(qd), questionType: qd.questionType });
	useLayoutEffect(() => { viewReader?.changed?.(); }, [viewReader, sel, other, text, thinking, conf, viewPresentationKey]);

	// Snapshot before optimistic submission unmounts the form, on BOTH routes: a refused send restores exactly this. Ref values
	// include the dictation finals that just landed, unlike stale closures.
	const saveDraft = (override?: SubmitOverride) => {
		const nextConf = override?.conf ?? conf;
		onSaveDraft?.({
			selection: { ...selFor(override), selected: new Set(selFor(override).selected) },
			thinking: thinkingTextRef.current,
			other,
			text: answerTextRef.current,
			confidence: nextConf,
			confidenceIndex: confidenceIndexFor(nextConf),
		});
	};

	const submitWith = (ov?: SubmitOverride) => {
		if (!(gateFor(ov).canSubmit || pendingInput) || compactionRunning || preparing) return;
		stopSpeechRef.current?.();
		// A photo rides the sketch path and an adapter's images the inline path: one image route per answer.
		if (pendingInput && photo) {
			setPhotoError("A photo and attached images can't be sent together — remove one.");
			return;
		}
		const go = () => {
			if (onPrepareSubmission && !photo) {
				saveDraft(ov);
				onPrepareSubmission({
					question: qd,
					isCurrent: () => mounted.current && currentQuestion.current === qd && isInteractionScopeEligible(rootRef.current, controller),
					capture: () => captureRequest(ov),
				});
				return;
			}
			doSubmit(ov);
		};
		/* FINISH DICTATION FIRST (owner, 2026-10-01): Enter may arrive while
		 * a run is live with reasoning still in Deepgram's hands. Stop the
		 * run, let the last finals land in the target field, and only then
		 * build the answer — the spoken reasoning is never lost to a
		 * forgotten stop. The field values below come from the REF mirrors
		 * because the flush lands via setState after an await. */
		if (!isDictationActive()) {
			go();
			return;
		}
		void finishDictation().then(go);
	};
	const submit = () => submitWith();

	/* HINTS (owner, 2026-11-13 — core/hints.ts): up to three on a lesson check, each one separate call that leaves the
	 * question open. They are kept with the question (this device's storage, keyed by the call) and ride the answer. After five
	 * minutes on the question with the app on screen, the button is quietly highlighted. Since 2026-11-17 the state is the shared
	 * controller (use-hints.ts): the sketch view shows the same button and list, and a hint reads the learner's current ink. */
	const hintCtl = useHints({
		callId: toolCallId,
		kind: "lesson",
		offered: hintEligible(toolName, input, phase),
		thinking: () => (qd.mode === "text" ? answerTextRef.current : thinkingTextRef.current),
		blocked: compactionRunning || preparing,
	});
	const hintsOffered = hintCtl.offered;
	const hints = hintCtl.texts;
	const hintsRef = useRef(hints);
	hintsRef.current = hints;
	const hintError = hintCtl.error;

	const pressLevel = (stopIndex: number) => {
		const value = CONFIDENCE_STOPS[stopIndex];
		if (value === undefined) return;
		setConf(value);
		submitWith({ conf: value });
	};
	const pressDontKnow = () => submitWith({ dontKnow: true });
	/** The answer exactly as the form holds it now — read from the refs, so dictation finals that landed after an await are
	 *  included — with a button press's override applied. */
	const captureRequest = (ov?: SubmitOverride): AnswerRequest => {
		const { sel, other, conf } = formValues.current;
		const dontKnow = ov?.dontKnow ?? sel.dontKnow;
		const c = ov?.conf ?? conf;
		return {
			dontKnow,
			values: dontKnow ? [] : [...sel.selected].map((i) => qd.options[i]!.value),
			other: !dontKnow && sel.otherSelected ? other : undefined,
			text: qd.mode === "text" ? answerTextRef.current : undefined,
			thinking: qd.mode !== "text" ? thinkingTextRef.current.trim() || undefined : undefined,
			// Always chosen on a picked quiz answer (canSubmit waits for it);
			// buildAnswer drops it on "I don't know".
			confidence: showConfidence && c !== null ? c : undefined,
			...(hintsRef.current.length > 0 ? { hints: hintsRef.current } : {}),
			// ink left off a free-text answer on purpose: the tutor is told, so "my drawing failed" is not graded as work
			...(skipInk && qd.kind === "explain" && hasNewInk(inkState) ? { sketchUnsent: true } : {}),
		};
	};
	const sendSteer = () => {
		const said = steerText.trim();
		if (!said || compactionRunning || preparing) return;
		stopSpeechRef.current?.();
		setSteerOpen(false);
		setSteerText("");
		void onSubmit(steeredAnswer(qd.kind, qd.question, said, hintsRef.current));
	};
	const doSubmit = (ov?: SubmitOverride) => {
		if (!(gateFor(ov).canSubmit || pendingInput)) return;
		if (photo) {
			// a photo answer rides the sketch path (the answer carries its SketchRef); the photo is dropped once it is sent
			void submitSketch(photo.payload, ov?.conf, ov?.dontKnow).then((sent) => {
				if (sent) setPhoto(null);
			});
			return;
		}
		if (inkWaiting) {
			// the page's unsent ink goes with the answer, exactly as the sketch view's own Submit would send it
			const state = readInk(toolCallId);
			try {
				const payload = pagePayload(readKept(toolCallId), state.strokes, nativeInkBridge() !== null && nativeInkEnabled() ? "android-ink" : "web-canvas", state.thawed !== undefined);
				void sendPage(toolCallId, payload, state.strokes, (accepted) => submitSketch(payload, ov?.conf, ov?.dontKnow, accepted));
				return;
			} catch (err) {
				// ink that cannot be packed is never dropped in silence: nothing is sent, the reason shows on the chip row, and the
				// learner fixes the page or removes the chip on purpose
				console.warn("[question-dock] the unsent sketch could not be attached:", err);
				setInkNote(`Your sketch could not be sent with the answer (${err instanceof Error ? err.message : "unknown error"}). Fix the page, or remove the sketch to send the text alone.`);
				setConfirmSkip(true);
				return;
			}
		}
		saveDraft(ov);
		onSubmit(buildAnswer(qd, captureRequest(ov), toolName));
	};
	/* The sketch submit (Android plan M1 + M3): in text mode the sketch
	 * answers on its own or with the typed/dictated text; in a choice mode
	 * the picked answer (and confidence) is the answer and the sketch rides
	 * as thinking. Dictation's tail lands first, exactly as for the Submit
	 * button. */
	const submitSketch = async (sketch: SketchPayload, pressedConf?: number, dontKnow?: boolean, onAccepted?: () => void): Promise<boolean> => {
		if (compactionRunning) return false;
		stopSpeechRef.current?.();
		setSketching(false);
		if (isDictationActive()) await finishDictation();
		// The dock's own gate (the view disables Submit with the same one). The sketch page asks for the confidence itself
		// (its Submit expands into the confidence control), so a choice there counts like one in the dock.
		const ov: SubmitOverride | undefined = pressedConf === undefined && !dontKnow ? undefined : { ...(pressedConf !== undefined ? { conf: pressedConf } : {}), ...(dontKnow ? { dontKnow: true } : {}) };
		if (!dockSubmitGate({ kind, mode: qd.mode, sel: selFor(ov), other, text: answerTextRef.current, confidenceSet: pressedConf !== undefined || conf !== null, hasSketch: true, requireConfidence: placementRecall }).canSubmit) return false;
		const req: AnswerRequest = { ...captureRequest(ov), sketch: sketchRefOf(sketch) };
		return (await onSubmit(buildAnswer(qd, req, toolName), sketch, onAccepted)) ?? true;
	};
	// Why the sketch view's Submit waits (a choice question needs its pick; the confidence is asked on the sketch page).
	const sketchGate = dockSubmitGate({ kind, mode: qd.mode, sel, other, text, confidenceSet: true, hasSketch: true, requireConfidence: placementRecall });
	const sketchBlocked = sketchGate.canSubmit ? undefined : "Pick an answer first";

	/* ENTER SUBMITS FROM ANYWHERE (owner round 6, 2026-10-05): the same
	 * law as the practice dock — dictated answers rarely focus the field.
	 * Rides submit() so the dictation-flush law is shared, not forked. */
	useEnterSubmits(submit, rootRef);

	// Selecting Other never clears the thinking field — two channels, the
	// answer and the reasoning behind it, side by side.
	const selectOther = () => setSel(toggleOther(selectMode, sel));

	/* ── The keyboard machine (shortcut wave B, owner rounds 2026-09-17) ──
	   ↑/↓ walk EVERY answerable row in order — options first, then the
	   quiz's "I don't know" or the ask's "Other…" (whichever exists) —
	   CLAMPED at the ends, no wrap (owner: faster to navigate when the
	   walk stops at the last row). Space acts on the walked row exactly
	   like a click (multi toggles, single displaces; Other also focuses
	   its input for typing), Enter submits once an answer exists.
	   Tab toggles FOCUS between the thinking field and the answer rows
	   (owner round 3) — nothing else; Shift+Tab is NOT ours (the global
	   thinking-level cycle owns it). Two guards keep native behavior
	   intact: keys from a TYPING SURFACE keep their meaning (arrows move
	   the caret, space types), and modifier combos are never ours
	   (Alt+arrows cycle sessions — they must not ALSO walk the rows).
	   The listener is document-level and lives only while the dock is
	   expanded — collapsed, the bar's native Enter expands it. */
	const [kbdIdx, setKbdIdx] = useState<number | null>(null);
	const otherInputRef = useRef<HTMLDivElement>(null);
	const thinkingRef = useRef<HTMLDivElement>(null);
	// One row past the options is the trailing row: quiz → don't-know,
	// ask → Other (a question never has both). Text mode (ask/explain)
	// has no rows — the composer IS the answer surface.
	const optionCount = qd.mode === "text" ? 0 : qd.options.length;
	// (the quiz's "I don't know" is a button beside the confidence buttons now, not a row)
	const rowCount = qd.mode === "text" ? 0 : optionCount + (kind === "quiz" ? 0 : 1);

	const kbdAct = (idx: number) => {
		if (idx < optionCount) toggle(idx);
		else {
			// Space on the ask's Other row (owner refinement round,
			// 2026-09-24): SELECTING it focuses the input for typing, but
			// the Space that DESELECTS an already-selected Other must never
			// drop the user back into the typing field — the core's
			// toggleOther has no single-select off-path (it displaces), so
			// the off-path lives here: clear the pick, keep the typed text,
			// focus stays where it is. Re-selecting is the way back into
			// the field.
			if (sel.otherSelected) setSel((prev) => ({ ...prev, otherSelected: false, dontKnow: false }));
			else {
				otherInputRef.current?.focus();
				selectOther();
			}
		}
	};

	// Focus the walked row's focusable element — the Other row is a div,
	// so its inline input is the focus target there.
	const focusRow = (idx: number) => {
		const row = rootRef.current?.querySelector(`[data-kbdrow="${idx}"]`) as HTMLElement | null;
		if (!row) return;
		const el = (row.querySelector("input, [data-file-path-input]") as HTMLElement | null) ?? row;
		el.focus();
	};

	useEffect(() => {
		if (!active || rowCount === 0) return;
		const onKeyDown = (e: KeyboardEvent) => {
			// Tab is already default-prevented by provider capture; do not
			// treat that as a claim. Eligibility, not focus alone, owns rows.
			if (!isInteractionScopeEligible(rootRef.current, controller)) return;
			const t = e.target as HTMLElement | null;
			// A TYPING field is where keys mean text (owner round 4): the
			// thinking/answer fields, search boxes, renames — never a range
			// input, whose focus after a click or drag must not kill the
			// arrow cycling. Everywhere else the arrows act.
			const typing =
				!!t &&
				((t.tagName === "INPUT" && (t as HTMLInputElement).type !== "range") ||
					t.tagName === "TEXTAREA" ||
					t.isContentEditable);
			// Alt/Cmd/Ctrl combos are never ours (Alt+arrows cycle sessions
			// globally — they must not ALSO walk the question rows).
			const modded = e.altKey || e.metaKey || e.ctrlKey;
			// Plain Tab toggles focus: rows → thinking. The confidence
			// slider takes NO focus at all (owner, UI round 2026-10-01) —
			// global ←/→ own its keyboard, so it never joins the chain.
			// Shift+Tab falls through (the global thinking-level cycle owns
			// it), so the shift check matters.
			if (e.key === "Tab" && !e.shiftKey && !modded) {
				e.preventDefault();
				e.stopPropagation();
				if (t?.closest?.("[data-kbdrow]")) thinkingRef.current?.focus();
				else {
					const idx = kbdIdx ?? 0;
					setKbdIdx(idx);
					focusRow(idx);
				}
				return;
			}
			// Keys from a typing surface keep their meaning (arrows move
			// the caret, space types).
			if (typing || modded) return;
			if (e.key === "ArrowDown") {
				e.preventDefault();
				const next = Math.min((kbdIdx ?? -1) + 1, rowCount - 1);
				setKbdIdx(next);
				// Focus follows the walk while the user is IN the rows (Tab
				// put them there) so focused and walked never diverge.
				if (t?.closest?.("[data-kbdrow]")) focusRow(next);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				const next = Math.max((kbdIdx ?? rowCount) - 1, 0);
				setKbdIdx(next);
				if (t?.closest?.("[data-kbdrow]")) focusRow(next);
			} else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
				// Global confidence highlight (owner, UI round 2026-10-01; the
				// buttons since 2026-10-28): the SAME pattern as ↑/↓ over the
				// rows — works wherever focus sits. ←/→ move the highlight over
				// the five levels and Enter presses it. Dead on "I don't know".
				// From unset, either arrow lands on 50 (the middle stop). (Fork: in slider mode ←/→ step the slider by 5.)
				if (e.defaultPrevented || kind !== "quiz" || sel.dontKnow) return;
				e.preventDefault();
				setConf((c) => stepConfidenceKey(confidenceMode, c, e.key));
			} else if (kind === "quiz" && (e.key === "0" || (confidenceMode === "buttons" && /^[1-5]$/.test(e.key)))) {
				// 1-5 press Guess..Certain and submit, 0 presses "I don't know" (owner, 2026-10-28)
				e.preventDefault();
				if (e.key === "0") pressDontKnow();
				else if (answerPicked) pressLevel(CONFIDENCE_LEVELS[Number(e.key) - 1]!.index);
			} else if (e.key === " ") {
				if (kbdIdx === null) return; // plain Space keeps scrolling the page
				e.preventDefault();
				kbdAct(kbdIdx);
			} else if (e.key === "Enter") {
				if (kbdIdx === null || !canSubmit) return;
				e.preventDefault();
				submit();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	});

	// Keep the walked row visible (the question area scrolls internally).
	useEffect(() => {
		if (kbdIdx === null) return;
		rootRef.current
			?.querySelector(`[data-kbdrow="${kbdIdx}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [kbdIdx]);

	const switchPosition = useRef<{ anchors: ReturnType<typeof captureReadingPosition>; focused: Element | null } | null>(null);
	const readingPosition = useRef<{ id: string; anchors: ReturnType<typeof captureReadingPosition> } | null>(null);
	const holdingPosition = useRef(false);
	const trackPosition = layoutRequest != null;
	useIsoLayoutEffect(() => {
		const question = questionPartRef.current;
		if (!trackPosition || !question) return;
		return trackReadingPosition(question, () => optionsRef.current, (anchors) => {
			if (!holdingPosition.current) readingPosition.current = { id: qd.id, anchors };
		});
	}, [trackPosition, qd.id]);

	// ADAPTIVE LAYOUT (Appearance → Adapt question layout): solved by the
	// shared hook (components/use-question-layout.ts) — the answered card
	// in the transcript uses the same one. The thinking field is never an
	// input, so typing cannot trigger a re-measure.
	// Fork (v0.7.0 merge): the confidence BUTTONS sit in their own full-width row below the question area (they submit),
	// not under the options, so the layout probe sees no confidence row (confidence: null).
	const layout = useQuestionLayout({
		cacheId: qd.id,
		// Wording-only ("Ask about this" open) hides the options, so the two-column request is suspended: an empty
		// answer column must not take width from the wording. It returns, from the saved measurements, when the card closes.
		request: wordingOnly ? null : layoutRequest ?? null,
		identity: qd,
		live: () => {
			const root = rootRef.current;
			const question = questionPartRef.current;
			if (!root || !question) return null;
			return { root, question, options: optionsRef.current, observe: [question, optionsRef.current] };
		},
		parts: (live) => ({ root: live.root, question: live.question, options: live.options, confidence: null }),
		onLayout,
		onSwitch: (_, to) => {
			const question = questionPartRef.current;
			const saved = readingPosition.current;
			const anchors = saved?.id === qd.id ? saved.anchors : question ? captureReadingPosition(question, optionsRef.current, to?.kind === "columns") : [];
			const root = rootRef.current;
			switchPosition.current = {
				anchors: to?.kind === "columns" ? anchors : anchors.filter((a) => a.edge === "top" && a.section === question),
				focused: root && visibleFocused(root),
			};
		},
	});
	const columns = layout?.kind === "columns" ? layout : null;
	// The fork's wide-dock two panes (a landscape touch screen, question-layout.ts WIDE_DOCK_QUERY; owner, 2026-11-10) remain the
	// fallback when the adaptive layout is off: question and options side by side, each scrolling on its own.
	const panes = !layoutRequest && qd.mode !== "text" && !wordingOnly;

	// Across a switch the same nodes stay (focus, caret, drags), but the
	// scrolling element changes. Transfer the reading anchor, then give
	// focus priority only if the control was visible before switching.
	const arrangement = columns ? "columns" : "stacked";
	useIsoLayoutEffect(() => {
		const root = rootRef.current;
		const position = switchPosition.current;
		switchPosition.current = null;
		if (!position || !root) return;
		const { anchors, focused } = position;
		if (!anchors.length && !focused) return;
		holdingPosition.current = true;
		return holdAcrossSwitch(root, () => {
			restoreReadingPosition(anchors);
			if (focused && root.ownerDocument.activeElement === focused) revealFocused(root);
		}, { onStop: () => { holdingPosition.current = false; } });
	}, [arrangement, qd.id]);

	// A lesson's written question may be given up ("I don't know" in the actions row); a final problem or a recall says
	// what it is in one quiet line above the answer.
	const explainGiveUp = kind === "explain" && toolName === "explain";
	const finalNote = qd.questionType === "final" ? "No hints. Sets your first rating." : qd.questionType === "recall" ? "No hints. A quick look back at an earlier skill." : "";

	// The question part (label, question, context) and the answer list are
	// shared by both arrangements; the refs feed the layout probe.
	const questionPart = (
		<div ref={questionPartRef} data-question-part="">
			<div className={QC_LABEL}>
				<span className={QC_LABEL_TEXT}>
					{questionCardLabel(toolName, kind, qd.questionType)}
					{qd.mode === "multi-select" && " · select all that apply"}
				</span>
				<QuestionReadAloud questionId={toolCallId} chatId={chatId} qd={qd} kind={kind} wordingOnly={wordingOnly} language={language} active={Boolean(active)} stopRef={stopSpeechRef} />
			</div>
			{/* The wording is markable for "Ask about this" (owner, 2026-11-06): the stem and the context, not the options. */}
			<ClarifyWording messageId={messageId} callId={toolCallId} dock>
				<div className={QC_QUESTION}>
					<ToolContentResponse>{qd.question}</ToolContentResponse>
				</div>
				{qd.context && (
					<div className={QC_CONTEXT}>
						<ToolContentResponse>{qd.context}</ToolContentResponse>
					</div>
				)}
			</ClarifyWording>
		</div>
	);
	// (The quiz's "I don't know" is a button beside the confidence buttons, not a row: fork, 2026-10-28.)
	const optionList = qd.mode === "text" ? null : (
		<div ref={optionsRef} data-question-options="">
			<div className={cn(QC_OPTION_LIST, wordingOnly && "hidden")} role={qd.mode === "multi-select" ? "group" : "radiogroup"}>
				{qd.options.map((opt, i) => {
					const isSel = sel.selected.has(i);
					const letter = displayedOptionLetter(qd.optionOrder, i + 1);
					return (
						<button
							key={opt.value}
							type="button"
							role={qd.mode === "multi-select" ? "checkbox" : "radio"}
							aria-checked={isSel}
							data-kbdrow={i}
							onClick={() => toggle(i)}
							className={cn(
								QC_OPTION_ROW,
								isSel ? QC_OPTION_SELECTED : "hover:bg-raised",
								i === kbdIdx && !isSel && "bg-raised",
							)}
						>
							<span
								className={cn(
									QC_OPTION_MARK,
									qd.mode === "multi-select" ? "rounded-sm" : "rounded-full",
									isSel ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
								)}
							>
								{letter ? (
									<span data-option-letter={letter} className={cn(QC_OPTION_LETTER, !isSel && "text-muted-foreground")}>
										{letter}
									</span>
								) : isSel && (
									<span className={cn(qd.mode === "multi-select" ? "text-base leading-none" : "size-1.5 rounded-full bg-current")}>
										{qd.mode === "multi-select" ? "✓" : ""}
									</span>
								)}
							</span>
							<span>
								<ToolContentResponse>{opt.label}</ToolContentResponse>
								{kind !== "quiz" && opt.description && (
									// Option subtext renders in Source Sans 3 (owner's mockup);
									// the "I don't know" copy stays JetBrains Mono. QUIZ options render
									// NO description (owner ruling 2026-09-26): the model used them to
									// telegraph correctness — the schema dropped the field and old
									// records must not leak either. Same MessageResponse path as the
									// label (owner, 2026-10-12): descriptions are full markdown —
									// LaTeX included — not plain text.
									<ToolContentResponse className="lh-prose block text-xs text-muted-foreground">
										{opt.description}
									</ToolContentResponse>
								)}
							</span>
						</button>
					);
				})}

				{kind === "ask" && (
					<div
						role={qd.mode === "multi-select" ? "checkbox" : "radio"}
						aria-checked={sel.otherSelected}
						data-testid="other-option"
						data-kbdrow={optionCount}
						onClick={selectOther}
						className={cn(
							QC_OPTION_ROW,
							sel.otherSelected ? QC_OPTION_SELECTED : "hover:bg-raised",
							kbdIdx === optionCount && !sel.otherSelected && "bg-raised",
						)}
					>
						<span
							className={cn(
								QC_OPTION_MARK,
								qd.mode === "multi-select" ? "rounded-sm" : "rounded-full",
								sel.otherSelected
									? "border-primary bg-primary text-primary-foreground"
									: "border-muted-foreground/40",
							)}
						>
							{sel.otherSelected && (
								<span className={cn(qd.mode === "multi-select" ? "text-base leading-none" : "size-1.5 rounded-full bg-current")}>
									{qd.mode === "multi-select" ? "✓" : ""}
								</span>
							)}
						</span>
						<PathInput
							ref={otherInputRef}
							singleLine
							value={other}
							onValueChange={(value) => {
								setOther(value);
								// Typing selects the row — displacing in
								// single-select, alongside the siblings in multi.
								setSel((prev) => (prev.otherSelected ? prev : toggleOther(selectMode, prev)));
							}}
							onKeyDown={(e) => {
								if (!isInteractionScopeEligible(e.currentTarget, controller)) return;
								// Esc escapes the typing (owner refinement round,
								// 2026-09-24): focus leaves the input, the row STAYS
								// selected — deselection is the next Space's job, acting
								// on the row — and the arrow walk resumes from this
								// row (kbdIdx pins it). stopPropagation keeps the
								// window chain from reading this Esc as abort-turn.
								if (e.key === "Escape") {
									controller?.claimEscape(e);
									e.preventDefault();
									e.stopPropagation();
									e.currentTarget.blur();
									setKbdIdx(optionCount);
								}
									// Enter submits directly (owner, keyboard round 2026-10-06):
									// the custom answer is a single-line input — no newline
									// to protect, and typing has already selected the row, so
									// the payload is ready. Every Enter (shift or not — nothing
									// else could ever happen in a one-line field) rides the
									// same submit seam as the button, dictation finish-first
									// included.
									if (e.key === "Enter") {
										e.preventDefault();
										submit();
									}
							}}
							placeholder={OTHER_PLACEHOLDER}
							className={QC_OTHER_INPUT}
							onClick={(e) => e.stopPropagation()}
						/>
					</div>
				)}
			</div>
		</div>
	);

	return (
		// one figure scope for the whole question: an option's plot may
		// reference the stem's diagram (figures, 2026-10-26)
		<FigureScope texts={[qd.question, qd.context, ...qd.options.flatMap((o) => [o.label, o.description])]}>
		<div ref={rootRef} data-testid="question-dock" data-question-layout={columns ? "columns" : "stacked"} className="@container/dock relative">
			{/* ONE subtree for both arrangements (identity is what keeps focus,
			    the Other caret, scroll positions and an active drag across a
			    layout switch): only classes and attributes change.
			    STACKED: the outer box is the question area — scrolls internally
			    if very tall, capped by the measured column (--dock-max-h; the old
			    fixed 55dvh cut long questions short — owner round, 2026-10-05);
			    the inner wrappers are display: contents.
			    TWO COLUMNS (Adapt question layout): the question left, the
			    options right, "Your thinking" full width below. The
			    row caps at --dock-max-h; each column scrolls on its own. No
			    divider: a shorter answer column centers its content vertically.
			    The question track is the flexible one, so while the dock's width
			    morphs the answer column is never clipped.
			    PANES (fork; only with the adaptive layout off): a wide dock puts the
			    question and its options side by side, each scrolling on its own. */}
			<div
				data-dock-height-region={columns ? "" : undefined}
				data-dock-scroll-area={columns ? undefined : ""}
				data-session-find-root=""
				data-testid={columns ? "question-columns" : undefined}
				className={columns
					? "grid"
					: cn(
						"max-h-[var(--dock-max-h,55dvh)] overflow-y-auto",
						STACKED_AREA_PAD,
						wordingOnly && "pb-3",
						panes && "@3xl/dock:grid @3xl/dock:max-h-none @3xl/dock:grid-cols-2 @3xl/dock:gap-x-5 @3xl/dock:overflow-visible",
					)}
				style={columns ? { gridTemplateColumns: `minmax(0, 1fr) ${columns.answer}px` } : undefined}
			>
				<div
					data-dock-scroll-area={columns ? "" : undefined}
					data-dock-pane={panes ? "question" : undefined}
					className={columns
						? cn("max-h-[var(--dock-max-h,55dvh)] min-w-0 overflow-y-auto", QUESTION_COLUMN_PAD)
						: cn("contents", panes && "@3xl/dock:block @3xl/dock:max-h-[var(--dock-max-h,55dvh)] @3xl/dock:overflow-y-auto @3xl/dock:pb-2")}
				>
					{questionPart}
				</div>
				<div className={columns ? cn("max-h-[var(--dock-max-h,55dvh)] min-h-0 min-w-0", ANSWER_COLUMN_FRAME) : "contents"}>
					<div
						data-dock-scroll-area={columns ? "" : undefined}
						data-dock-pane={panes ? "options" : undefined}
						className={columns
							? cn("flex min-h-0 flex-col overflow-y-auto", ANSWER_OPTIONS_PAD)
							: cn("contents", panes && "@3xl/dock:block @3xl/dock:max-h-[var(--dock-max-h,55dvh)] @3xl/dock:overflow-y-auto @3xl/dock:pb-2")}
					>
						{optionList}
					</div>
				</div>
			</div>

			{/* The confidence BUTTONS (owner, 2026-10-28; Anki style, replacing the slider and the Submit button): pick an answer,
			    then press how sure you are — the press submits. "I don't know" is the leading button and needs no pick; the five
			    levels wait for one. Keys: 1-5 press the levels, 0 presses "I don't know", ←/→ move the highlight, Enter presses it. */}
			{showConfidence && (
				<div ref={confidenceRef} className={cn("border-t border-border px-4 py-3", wordingOnly && "hidden")} data-testid="confidence-row">
					{confidenceMode === "slider" ? (
						<ConfidenceSlider value={conf} onChange={setConf} disabled={compactionRunning || preparing} showUnsetHint onDontKnow={pressDontKnow} dontKnowDisabled={compactionRunning || preparing} />
					) : (
					<ConfidenceButtons
						onPick={pressLevel}
						disabled={!answerPicked || compactionRunning || preparing}
						highlight={confidenceIndexFor(conf)}
						leading={
							<button
								type="button"
								disabled={compactionRunning || preparing}
								onClick={pressDontKnow}
								data-testid="dont-know-button"
								className={DONT_KNOW_LEADING}
							>
								I don't know
							</button>
						}
					/>
					)}
				</div>
			)}

			{hintsOffered && (hints.length > 0 || hintError) && (
				<div className={cn("space-y-1.5 border-t border-border px-4 py-3 text-sm", wordingOnly && "hidden")} data-testid="hint-list">
					{hints.map((hint, i) => (
						<div key={i} className="flex gap-2 text-foreground">
							<span className="shrink-0 pt-0.5 lh-eyebrow text-muted-foreground">Hint {i + 1}</span>
							<div className="min-w-0 flex-1">
								<ToolContentResponse>{hint}</ToolContentResponse>
							</div>
						</div>
					))}
					{hintError && (
						<div role="alert" className="text-xs text-destructive">
							{hintError}
						</div>
					)}
				</div>
			)}

			{/* A lesson's free-form question may be given up like a multiple-choice one (owner, 2026-11-13: with Tutor decides,
			    calculations are free-form). A course lesson's FINAL PROBLEM also says what it is. */}
			<form
				className={cn("border-t border-border", wordingOnly && "hidden")}
				onSubmit={(e) => {
					e.preventDefault();
					submit();
				}}
			>
				{/* UI round 1b (SPEC §7): the answer area is a section of the ONE card — a hairline above, no inner box; the
				    shell's own focus ring shows focus. The actions row closes it: secondary sm tools left, one primary
				    Submit right. */}
				<div data-testid={qd.mode === "text" ? "answer-field" : "thinking-field"}>
					<div className="px-4 pt-3 lh-eyebrow text-muted-foreground">
						{qd.mode === "text" ? "Your answer" : "Your thinking"}
					</div>
					{/* A course lesson's FINAL PROBLEM (or a recall) says what it is: one quiet line. */}
					{explainGiveUp && finalNote && (
						<div data-testid="final-problem-row" className="px-4 pt-1 text-xs text-muted-foreground">{finalNote}</div>
					)}
					{qd.mode === "text" ? (
						<PathInput
							value={text}
							onValueChange={(value) => {
								answerTextRef.current = value;
								setText(value);
							}}
							onKeyDown={(e) => {
								if (!isInteractionScopeEligible(e.currentTarget, controller)) return;
								// Esc ends dictation (the dictate decisions: click-again
								// or Esc) — stopPropagation claims it (keyboard wave
								// A) so the window chain doesn't also abort a turn.
								if (e.key === "Escape" && onEscape) {
									e.preventDefault();
									e.stopPropagation();
									controller?.claimEscape(e);
									onEscape();
									return;
								}
								// Chat convention: Enter submits, Shift+Enter is a newline;
								// ⌘/Ctrl+Enter also submits (universal across the app).
								if (enterSends(e)) {
									e.preventDefault();
									submit();
								}
							}}
							placeholder="Type your answer…"
							className="field-sizing-content lh-input max-h-48 min-h-10 w-full resize-none bg-transparent px-4 py-1.5 outline-none placeholder:text-muted-foreground"
						/>
					) : (
						<PathInput
							ref={thinkingRef}
							value={thinking}
							onValueChange={(value) => {
								thinkingTextRef.current = value;
								setThinking(value);
							}}
							onKeyDown={(e) => {
								if (!isInteractionScopeEligible(e.currentTarget, controller)) return;
								// Esc ends dictation (the dictate decisions: click-again
								// or Esc) — stopPropagation claims it (keyboard wave
								// A) so the window chain doesn't also abort a turn.
								if (e.key === "Escape" && onEscape) {
									e.preventDefault();
									e.stopPropagation();
									controller?.claimEscape(e);
									onEscape();
									return;
								}
								// THE STANDARD CHORD (owner round 5, 2026-10-05): Enter
								// submits, Shift+Enter is a newline, ⌘/Ctrl+Enter works
								// too — identical to the practice dock and the composer.
								if (enterSends(e)) {
									e.preventDefault();
									submit();
								}
							}}
							placeholder="Why this answer? Whatever comes to mind."
							className={cn(
								"field-sizing-content lh-input max-h-48 w-full resize-none bg-transparent px-4 py-1.5 outline-none placeholder:text-muted-foreground",
								// Phase-scaled prominence: teaching invites depth,
								// probing stays quick.
								// One line until focused (owner, 2026-11-10): the empty field took ~130px of a tablet's height; it opens up
								// to the taught-phase depth when tapped, and grows with what is typed.
								phase === "teach" ? "min-h-10 focus:min-h-[4.5rem]" : "min-h-10",
							)}
						/>
					)}
					{inkWaiting && !photo && (
						<div className="px-4 pb-2">
							<span data-testid="question-ink-chip" className="inline-flex items-center gap-1.5 rounded-full border bg-muted/50 py-0.5 pr-1 pl-2 text-xs text-muted-foreground">
								<PenLineIcon className="size-3" />
								Sketch attached
								<button
									type="button"
									data-testid="question-ink-chip-remove"
									aria-label="Don't attach the sketch"
									title="Send without the sketch (it stays on the sketch page)"
									onClick={() => {
										if (!confirmSkip) {
											setConfirmSkip(true);
											setInkNote("Tap ✕ again to send without your sketch (the ink stays on the page).");
											return;
										}
										setInkNote(null);
										setSkipInk(true);
									}}
									className="flex size-4 items-center justify-center rounded-full transition-colors hover:bg-muted hover:text-foreground"
								>
									<XIcon className="size-3" />
								</button>
							</span>
							{inkNote && (
								<p data-testid="question-ink-note" role="alert" className="mt-1 text-xs text-destructive">
									{inkNote}
								</p>
							)}
						</div>
					)}
					{(photo || photoError) && (
						<div className="px-4 pb-2">
							{photo && (
								<span data-testid="question-photo-chip" className="inline-flex items-center gap-1.5 rounded-full border bg-muted/50 py-0.5 pr-1 pl-1 text-xs text-muted-foreground">
									{/* eslint-disable-next-line @next/next/no-img-element -- a blob: URL of the photo just taken */}
									<img src={photo.previewUrl} alt="" className="size-5 rounded-full object-cover" />
									Photo attached
									<button
										type="button"
										data-testid="question-photo-chip-remove"
										aria-label="Don't attach the photo"
										title="Remove the photo"
										onClick={() => setPhoto(null)}
										className="flex size-4 items-center justify-center rounded-full transition-colors hover:bg-muted hover:text-foreground"
									>
										<XIcon className="size-3" />
									</button>
								</span>
							)}
							{!photo && photoError && (
								<span role="alert" data-testid="question-photo-error" className="text-xs text-destructive">
									{photoError}
								</span>
							)}
						</div>
					)}
					{steerOffered && steerOpen && (
						<div data-testid="question-steer-box" className="mx-4 mb-2 flex flex-col gap-2 rounded-lg bg-raised p-3">
							<p className="text-xs text-muted-foreground">Tell the tutor something instead of answering. This question is set aside, not graded, and comes back unless you change the plan.</p>
							<textarea
								autoFocus
								data-testid="question-steer-input"
								aria-label="Message to the tutor"
								value={steerText}
								onChange={(e) => setSteerText(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Escape") {
										controller?.claimEscape(e);
										e.preventDefault();
										setSteerOpen(false);
										return;
									}
									if (enterSends(e)) {
										e.preventDefault();
										sendSteer();
									}
								}}
								placeholder="What should the tutor do differently?"
								className="field-sizing-content lh-input max-h-40 min-h-[4.5rem] w-full resize-none rounded-md border border-input bg-card px-2.5 py-2 outline-none placeholder:text-muted-foreground focus:border-ring"
							/>
							<div className="flex justify-end gap-2">
								<Button type="button" variant="ghost" data-testid="question-steer-cancel" onClick={() => setSteerOpen(false)}>
									Cancel
								</Button>
								<Button type="button" data-testid="question-steer-send" disabled={!steerText.trim() || compactionRunning || preparing} onClick={sendSteer}>
									Send to tutor
								</Button>
							</div>
						</div>
					)}
					<DockActions
						tools={(sketchAvailable || hintsOffered || steerOffered) && <>
							{sketchAvailable && camera.available && (
								<Button
									type="button"
									variant="secondary"
									size="sm"
									data-testid="question-add-photo"
									aria-label="Camera"
									onClick={camera.open}
									className="lh-press"
								>
									<CameraIcon />
									<DockToolLabel>Camera</DockToolLabel>
								</Button>
							)}
							{sketchAvailable && (
								<Button
									type="button"
									variant="secondary"
									size="sm"
									data-testid="question-open-sketch"
									aria-label="Open in sketch"
									onClick={() => setSketching(true)}
									className="lh-press"
								>
									<PenLineIcon />
									<DockToolLabel>Open in sketch</DockToolLabel>
								</Button>
							)}
							{hintsOffered && (
								<Button
									type="button"
									variant="secondary"
									size="sm"
									data-testid="question-hint"
									data-nudge={hintCtl.nudge && hints.length === 0 ? "true" : undefined}
									aria-label={hintLabel(hintCtl)}
									disabled={hintCtl.disabled}
									onClick={hintCtl.ask}
									className={cn("lh-press", hintCtl.nudge && hints.length === 0 && "ring-2 ring-primary/50")}
								>
									<LightbulbIcon />
									<DockToolLabel>{hintLabel(hintCtl)}</DockToolLabel>
								</Button>
							)}
							{steerOffered && (
								<Button
									type="button"
									variant="secondary"
									size="sm"
									data-testid="question-steer"
									aria-label="Tell the tutor"
									aria-expanded={steerOpen}
									title="Set this question aside and write to the tutor instead"
									onClick={() => setSteerOpen((open) => !open)}
									className="lh-press"
								>
									<MessageSquareIcon />
									<DockToolLabel>Tell the tutor</DockToolLabel>
								</Button>
							)}
						</>}
						hint={compactionRunning ? "compacting session…" : <span className="lh-enter-hint [@media(pointer:coarse)]:hidden">↵ submits · ⇧↵ newline</span>}
						trailing={(explainGiveUp || !showConfidence || confidenceMode === "slider") && <>
							{/* A lesson's free-form question may be given up like a multiple-choice one (owner, 2026-11-13:
							    with Tutor decides, calculations are free-form). */}
							{explainGiveUp && (
								<button
									type="button"
									disabled={compactionRunning || preparing}
									onClick={pressDontKnow}
									data-testid="dont-know-button"
									className={DONT_KNOW_ACTION}
								>
									I don't know
								</button>
							)}
							{(!showConfidence || confidenceMode === "slider") && (
								<Button
									type="submit"
									size="lg"
									disabled={!canSubmit || compactionRunning || preparing}
								>
									Submit answer
								</Button>
							)}
						</>}
					/>
				</div>
			</form>
			{camera.node}
			{sketching && sketchAvailable && (
				<SketchView
					label="Question"
					statement={qd.context ? `${qd.question}\n\n${qd.context}` : qd.question}
					lessonText={typeof (input as { lead?: unknown }).lead === "string" ? (input as { lead: string }).lead : undefined}
					inkKey={toolCallId}
					hint={hintsOffered ? hintCtl : undefined}
					onSteer={steerOffered ? () => { setSketching(false); setSteerOpen(true); } : undefined}
					onSubmit={(sketch, confidenceIndex, onAccepted, confidenceValue) =>
						submitSketch(sketch, confidenceValue ?? (confidenceIndex !== undefined ? CONFIDENCE_STOPS[confidenceIndex] : undefined), undefined, onAccepted)
					}
					onClose={() => setSketching(false)}
					onCancelDictation={onEscape}
					disabled={compactionRunning}
					blocked={qd.mode === "text" ? undefined : sketchBlocked}
					confidenceLevels={(placementRecall || (kind === "quiz" && qd.mode !== "text")) && !sel.dontKnow}
					confidenceMode={confidenceMode}
					initialConfidence={conf}
					choices={
						qd.mode === "text" ? undefined : (
							<SketchChoices
								kind={kind as "quiz" | "ask" | "explain"}
								multi={qd.mode === "multi-select"}
								options={qd.options}
								optionOrder={qd.optionOrder}
								sel={sel}
								onToggle={toggle}
								onDontKnow={() =>
									setSel((prev) => ({ ...prev, selected: new Set(), otherSelected: false, dontKnow: !prev.dontKnow }))
								}
								onOther={selectOther}
								other={other}
								onOtherText={setOther}
							/>
						)
					}
				/>
			)}
		</div>
		</FigureScope>
	);
}
