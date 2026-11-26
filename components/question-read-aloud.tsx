"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { SquareIcon, Volume2Icon } from "lucide-react";
import {
	bindingForAction,
	buildQuestionSpeech,
	DEFAULT_LESSON_LANGUAGE,
	DEFAULT_READ_ALOUD_RATE,
	displayedOptionLetter,
	formatBinding,
	kbdEventForAction,
	KEYMAP_CHANGED_EVENT,
	READ_ALOUD_RATE_MAX,
	READ_ALOUD_RATE_MIN,
	type LessonLanguage,
	type QuestionData,
	type QuestionKind,
	type ReadAloudEngine,
	type ReadAloudStatus,
	type SpeechQuestionOption,
	type UserSettings,
	effectiveReadAloudEngine,
} from "@/src/core";
import { cn } from "@/lib/utils";
import { useSettingsSaved } from "@/components/settings-signal";
import {
	createReadAloudController,
	type ReadAloudController,
	type ReadAloudControllerDeps,
	type ReadAloudState,
} from "@/components/read-aloud-controller";

export interface ReadAloudConfig {
	autoRead: boolean;
	rate: number;
	/** The system voice (system engine and the fallback). */
	voice: string | null;
	/** The engine reads use: Google when chosen (or not chosen) and a key is available, else system voices. */
	engine: ReadAloudEngine;
}

const DEFAULT_READ_ALOUD_CONFIG: ReadAloudConfig = {
	autoRead: false,
	rate: DEFAULT_READ_ALOUD_RATE,
	voice: null,
	engine: "system",
};

// The learner pressed read aloud in this app session: a question that appears is then likely to be read, so its first
// sentences are synthesized (and cached) as it appears.
let readAloudUsed = false;

const AUTO_READ_STORAGE_KEY = "lh:read-aloud-seen";
const MAX_AUTO_READ_HISTORY = 200;

// Survives dock remounts (refused-send draft restoration, reopened chats) so a
// pending question is never auto-read twice. Keyed on chat id + tool call id:
// call ids are unique only within one chat (some providers send `call_0` every turn).
const autoReadSeen = new Set<string>();

function autoReadKey(chatId: string | undefined, questionId: string): string {
	return JSON.stringify([chatId ?? "", questionId]);
}

function readStoredSeen(): Set<string> | null {
	try {
		if (typeof window === "undefined" || !window.sessionStorage) return null;
		const raw = window.sessionStorage.getItem(AUTO_READ_STORAGE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return null;
		return new Set(parsed.filter((v): v is string => typeof v === "string"));
	} catch {
		return null;
	}
}

function hasAutoReadQuestion(questionId: string): boolean {
	if (autoReadSeen.has(questionId)) return true;
	const stored = readStoredSeen();
	if (stored?.has(questionId)) {
		autoReadSeen.add(questionId);
		return true;
	}
	return false;
}

function markAutoReadQuestion(questionId: string): void {
	const stored = readStoredSeen();
	if (stored) {
		for (const id of stored) autoReadSeen.add(id);
	}
	autoReadSeen.add(questionId);
	while (autoReadSeen.size > MAX_AUTO_READ_HISTORY) {
		const oldest = autoReadSeen.values().next().value;
		if (oldest === undefined) break;
		autoReadSeen.delete(oldest);
	}
	try {
		if (typeof window !== "undefined" && window.sessionStorage) {
			window.sessionStorage.setItem(AUTO_READ_STORAGE_KEY, JSON.stringify([...autoReadSeen]));
		}
	} catch {
		// Best-effort persistence; in-memory Set still guards remounts.
	}
}

/** Clear recorded auto-read question IDs (for tests). */
export function clearAutoReadHistory(): void {
	autoReadSeen.clear();
	readAloudUsed = false;
	try {
		if (typeof window !== "undefined" && window.sessionStorage) {
			window.sessionStorage.removeItem(AUTO_READ_STORAGE_KEY);
		}
	} catch {
		// Ignore unavailable sessionStorage.
	}
}

/**
 * Extract displayed-only options for read-aloud from QuestionData: never leaks
 * hidden quiz descriptions, correct answers, unrevealed hints, or tutor planning.
 */
export function speechOptionsFromQuestion(
	qd: QuestionData,
	kind: QuestionKind,
): readonly SpeechQuestionOption[] {
	return qd.options.map((opt, i) => ({
		letter: displayedOptionLetter(qd.optionOrder, i + 1),
		label: opt.label,
		description: kind !== "quiz" ? opt.description : undefined,
	}));
}

function configFromSettings(settings: UserSettings | null | undefined, googleKey: boolean): ReadAloudConfig {
	const g = settings?.general;
	const rate = typeof g?.readAloudRate === "number" && Number.isFinite(g.readAloudRate)
		? Math.min(READ_ALOUD_RATE_MAX, Math.max(READ_ALOUD_RATE_MIN, g.readAloudRate))
		: DEFAULT_READ_ALOUD_RATE;
	return {
		autoRead: g?.readAloudAuto === true,
		rate,
		voice: typeof g?.readAloudVoice === "string" && g.readAloudVoice.trim() ? g.readAloudVoice.trim() : null,
		engine: effectiveReadAloudEngine(g?.readAloudEngine ?? null, googleKey),
	};
}

/** Read general read-aloud settings from `/api/settings` and stay in sync on saves. */
export function useReadAloudSettings(override?: Partial<ReadAloudConfig>): ReadAloudConfig {
	const [stored, setStored] = useState<ReadAloudConfig>(DEFAULT_READ_ALOUD_CONFIG);
	const hasOverride = override !== undefined;

	const reload = useCallback(() => {
		if (hasOverride || typeof window === "undefined" || typeof fetch !== "function") return;
		let alive = true;
		const json = <T,>(url: string): Promise<T | null> => fetch(url).then((r) => (r.ok ? (r.json() as Promise<T>) : null)).catch(() => null);
		void Promise.all([json<{ settings?: UserSettings | null }>("/api/settings"), json<ReadAloudStatus>("/api/tts")]).then(([body, tts]) => {
			if (alive && body) setStored(configFromSettings(body.settings, !!tts?.key?.source));
		});
		return () => {
			alive = false;
		};
	}, [hasOverride]);

	useEffect(() => reload(), [reload]);
	useSettingsSaved((section) => {
		// "keys": a Google key saved (Settings → Read aloud, PDF conversion or providers) switches the engine
		if (section === "general" || section === "keys") void reload();
	});

	return useMemo(
		() => ({
			autoRead: override?.autoRead ?? stored.autoRead,
			rate: override?.rate ?? stored.rate,
			voice: override?.voice !== undefined ? override.voice : stored.voice,
			engine: override?.engine ?? stored.engine,
		}),
		[override?.autoRead, override?.rate, override?.voice, override?.engine, stored],
	);
}

export interface QuestionReadAloudProps {
	questionId: string;
	/** The chat the question belongs to: auto-read memory is per chat, since tool call ids repeat across chats. */
	chatId?: string;
	/** Displayed question payload (preferred when invoked from QuestionDock). */
	qd?: QuestionData;
	/** Tool kind when `qd` is provided (controls whether option descriptions are shown). */
	kind?: QuestionKind;
	/** When true, options are hidden on screen and must not be read aloud. */
	wordingOnly?: boolean;
	/** Explicit question text (alternative to `qd`, e.g. unit tests). */
	question?: string;
	/** Explicit context text (alternative to `qd`). */
	context?: string;
	/** Explicit displayed options (alternative to `qd`). */
	options?: readonly SpeechQuestionOption[];
	language?: LessonLanguage;
	/** True while the pending question is visible/expanded to the learner. */
	active: boolean;
	/** Populated with an imperative stop function for submit/steer paths. */
	stopRef?: { current: (() => void) | null };
	/** Optional settings override (tests). */
	settingsOverride?: Partial<ReadAloudConfig>;
	/** Optional speechSynthesis / Google client injection (tests). */
	controllerDeps?: ReadAloudControllerDeps;
	className?: string;
}

const INITIAL_SPEECH_STATE: ReadAloudState = {
	status: "unsupported",
	speaking: false,
	voices: [],
	engine: "system",
	notice: null,
};

const NO_UTTERANCES: readonly string[] = [];

function unavailableReason(status: ReadAloudState["status"], buildFailed: boolean): string | null {
	if (status === "unsupported") return "Read aloud is unavailable in this browser";
	if (status === "no-voices") return "No system speech voices installed";
	if (buildFailed) return "This question cannot be read aloud";
	return null;
}

/**
 * The Play/Stop button's box. Its width is fixed (in em, so it follows the text size) so its size never depends
 * on its label, and the answered card's stand-in (`readAloudStandIn`) reserves exactly the same box. `lh-touch`
 * grows it to 44 px on touch screens, and the label row grows with it (the button sits in the row, never over
 * the question); `-my-1` keeps the mouse-sized row as tall as the label text.
 */
export const READ_ALOUD_BUTTON_BOX =
	"lh-touch -my-1 inline-flex h-6 w-[9.5em] shrink-0 items-center justify-center gap-1 rounded-sm px-1.5 text-xs font-medium normal-case tracking-normal whitespace-nowrap";
/** The slot holding the button at the right end of the question card's label row. */
export const READ_ALOUD_SLOT = "ml-auto flex shrink-0 pl-1.5";
/**
 * Why the button is disabled: visible beside the label when there is room, truncated otherwise. It takes no
 * width of its own (`w-0 flex-1`), so the label wraps exactly as in the stand-in, and one line never makes the
 * row taller.
 */
const READ_ALOUD_REASON =
	"w-0 min-w-0 flex-1 truncate text-right text-xs leading-4 font-normal normal-case tracking-normal text-muted-foreground";

/** The read-aloud slot as the answered card's stand-in measures it: the same box, invisible and empty. */
export function readAloudStandIn(doc: Document): HTMLElement {
	const slot = doc.createElement("div");
	slot.className = READ_ALOUD_SLOT;
	const box = doc.createElement("span");
	box.className = cn(READ_ALOUD_BUTTON_BOX, "invisible");
	box.setAttribute("aria-hidden", "true");
	slot.append(box);
	return slot;
}

/**
 * Play/Stop control placed beside a pending question in QuestionDock.
 *
 * Only accepts displayed question text, context, and displayed options — never
 * correct answers, hidden explanations, unrevealed hints, or tutor planning.
 */
export function QuestionReadAloud({
	questionId,
	chatId,
	qd,
	kind = "quiz",
	wordingOnly = false,
	question,
	context,
	options,
	language = DEFAULT_LESSON_LANGUAGE,
	active,
	stopRef,
	settingsOverride,
	controllerDeps,
	className,
}: QuestionReadAloudProps) {
	const config = useReadAloudSettings(settingsOverride);
	const controllerRef = useRef<ReadAloudController | null>(null);
	const [speech, setSpeech] = useState<ReadAloudState>(INITIAL_SPEECH_STATE);
	const [shortcutLabel, setShortcutLabel] = useState<string>(() => formatBinding(bindingForAction("read-question-aloud")));
	const reasonId = useId();

	const resolvedQuestion = qd ? qd.question : (question ?? "");
	const resolvedContext = qd ? qd.context : context;
	const resolvedOptions = useMemo(() => {
		if (wordingOnly) return undefined;
		if (qd) return speechOptionsFromQuestion(qd, kind);
		return options;
	}, [qd, kind, wordingOnly, options]);

	// Very deep nesting can overflow the parser's stack (the renderer fails the same way): the dock still renders
	// and only the button is disabled.
	const built = useMemo(() => {
		try {
			return buildQuestionSpeech({ question: resolvedQuestion, context: resolvedContext, options: resolvedOptions, language });
		} catch {
			return null;
		}
	}, [resolvedQuestion, resolvedContext, resolvedOptions, language]);
	const utterances = built ?? NO_UTTERANCES;

	// Keep latest playback inputs in refs so event listeners and auto-read never churn.
	const latestRef = useRef({ utterances, language, config, active });
	latestRef.current = { utterances, language, config, active };

	// Create and dispose the read-aloud controller (Google and system voices) on mount/unmount.
	useEffect(() => {
		const controller = createReadAloudController(controllerDeps);
		controller.setEngine(latestRef.current.config.engine);
		controllerRef.current = controller;
		setSpeech(controller.getState());
		const unsubscribe = controller.subscribe(setSpeech);
		if (stopRef) stopRef.current = () => controller.stop();
		return () => {
			if (stopRef) stopRef.current = null;
			unsubscribe();
			controller.dispose();
			if (controllerRef.current === controller) controllerRef.current = null;
		};
	}, [controllerDeps, stopRef]);

	useEffect(() => {
		controllerRef.current?.setEngine(config.engine);
	}, [config.engine]);

	// Keep shortcut hint in sync if the user rebinds the shortcut in Settings.
	useEffect(() => {
		const update = () => setShortcutLabel(formatBinding(bindingForAction("read-question-aloud")));
		window.addEventListener(KEYMAP_CHANGED_EVENT, update);
		return () => window.removeEventListener(KEYMAP_CHANGED_EVENT, update);
	}, []);

	// Stop when switching to a different question.
	const prevQuestionIdRef = useRef(questionId);
	useEffect(() => {
		if (prevQuestionIdRef.current !== questionId) {
			prevQuestionIdRef.current = questionId;
			controllerRef.current?.stop();
		}
	}, [questionId]);

	// Stop when the dock collapses or becomes inactive.
	useEffect(() => {
		if (!active) controllerRef.current?.stop();
	}, [active]);

	// Cancel speech when the app window is hidden or navigated away.
	useEffect(() => {
		const onVisibility = () => {
			if (document.hidden) controllerRef.current?.stop();
		};
		const onPageHide = () => controllerRef.current?.stop();
		document.addEventListener("visibilitychange", onVisibility);
		window.addEventListener("pagehide", onPageHide);
		return () => {
			document.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("pagehide", onPageHide);
		};
	}, []);

	const speakNow = useCallback(() => {
		const controller = controllerRef.current;
		if (!controller) return;
		const { utterances: lines, language: lang, config: cfg } = latestRef.current;
		controller.speak(lines, { language: lang, rate: cfg.rate, voice: cfg.voice });
	}, []);

	const toggleSpeech = useCallback(() => {
		const controller = controllerRef.current;
		if (!controller) return;
		if (controller.getState().speaking) controller.stop();
		else {
			readAloudUsed = true;
			speakNow();
		}
	}, [speakNow]);

	// Keyboard shortcut: toggle play/stop while this question is active.
	useEffect(() => {
		if (!active) return;
		const eventName = kbdEventForAction("read-question-aloud");
		const onShortcut = () => {
			const controller = controllerRef.current;
			if (!controller || controller.getState().status !== "ready") return;
			toggleSpeech();
		};
		window.addEventListener(eventName, onShortcut);
		return () => window.removeEventListener(eventName, onShortcut);
	}, [active, toggleSpeech]);

	// Auto-read once per pending question when enabled and visible (persists across dock remounts).
	useEffect(() => {
		if (!config.autoRead || !active || speech.status !== "ready" || utterances.length === 0) return;
		const key = autoReadKey(chatId, questionId);
		if (hasAutoReadQuestion(key)) return;
		markAutoReadQuestion(key);
		speakNow();
	}, [config.autoRead, active, speech.status, chatId, questionId, utterances.length, speakNow]);

	// Google voices: synthesize the first sentences as the question appears when it is likely to be read (the learner has
	// used read aloud in this session; auto-read speaks at once anyway). Cached on the server, so the read starts at once.
	useEffect(() => {
		if (!active || config.autoRead || !readAloudUsed || speech.engine !== "google" || utterances.length === 0) return;
		controllerRef.current?.prefetch(utterances, { language, rate: config.rate, voice: config.voice });
	}, [active, config.autoRead, config.rate, config.voice, speech.engine, utterances, language]);

	// While the voice list is still loading the button waits, without a reason (it would flash before voices arrive).
	const reason = unavailableReason(speech.status, built === null);
	const disabled = reason !== null || speech.status === "loading" || utterances.length === 0;
	const speaking = speech.speaking;
	// Changing label alone communicates state — never combine with aria-pressed. The accessible
	// name starts with the visible text, so voice control ("click Read aloud") finds it.
	const actionLabel = speaking ? "Stop reading the question" : "Read aloud the question";
	const notice = reason ? null : speech.notice;
	const tooltip = reason
		? reason
		: speech.status === "loading"
			? "Loading system voices…"
			: shortcutLabel
				? `${actionLabel} (${shortcutLabel})`
				: actionLabel;

	// Rendered as two items of the question card's label row (see `readAloudStandIn`): the reason, then the slot.
	return (
		<>
			{reason && (
				<span id={reasonId} data-testid="question-read-aloud-reason" title={reason} className={READ_ALOUD_REASON}>
					{reason}
				</span>
			)}
			{notice && (
				<span role="status" data-testid="question-read-aloud-notice" title={notice} className={READ_ALOUD_REASON}>
					{notice}
				</span>
			)}
			<div className={cn(READ_ALOUD_SLOT, className)}>
				<button
					type="button"
					data-testid="question-read-aloud"
					data-speech-status={speech.status}
					data-speech-engine={speech.engine}
					disabled={disabled}
					aria-label={actionLabel}
					aria-describedby={reason ? reasonId : undefined}
					title={tooltip}
					onClick={toggleSpeech}
					className={cn(
						READ_ALOUD_BUTTON_BOX,
						"transition-colors",
						disabled
							? "cursor-not-allowed text-muted-foreground/50"
							: speaking
								? "bg-accent text-foreground"
								: "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
					)}
				>
					{speaking ? <SquareIcon className="size-3 fill-current" aria-hidden="true" /> : <Volume2Icon className="size-3.5" aria-hidden="true" />}
					<span>{speaking ? "Stop" : "Read aloud"}</span>
				</button>
			</div>
		</>
	);
}
