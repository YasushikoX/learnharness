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
	type SpeechQuestionOption,
	type UserSettings,
} from "@/src/core";
import { cn } from "@/lib/utils";
import { useSettingsSaved } from "@/components/settings-signal";
import {
	createSpeechController,
	type SpeechController,
	type SpeechControllerDeps,
	type SpeechState,
} from "@/components/speech-controller";

export interface ReadAloudConfig {
	autoRead: boolean;
	rate: number;
	voice: string | null;
}

const DEFAULT_READ_ALOUD_CONFIG: ReadAloudConfig = {
	autoRead: false,
	rate: DEFAULT_READ_ALOUD_RATE,
	voice: null,
};

const AUTO_READ_STORAGE_KEY = "lh:read-aloud-seen";
const MAX_AUTO_READ_HISTORY = 200;

// Survives dock remounts (refused-send draft restoration, reopened chats) so a
// pending question is never auto-read twice.
const autoReadSeen = new Set<string>();

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

function configFromSettings(settings: UserSettings | null | undefined): ReadAloudConfig {
	const g = settings?.general;
	const rate = typeof g?.readAloudRate === "number" && Number.isFinite(g.readAloudRate)
		? Math.min(READ_ALOUD_RATE_MAX, Math.max(READ_ALOUD_RATE_MIN, g.readAloudRate))
		: DEFAULT_READ_ALOUD_RATE;
	return {
		autoRead: g?.readAloudAuto === true,
		rate,
		voice: typeof g?.readAloudVoice === "string" && g.readAloudVoice.trim() ? g.readAloudVoice.trim() : null,
	};
}

/** Read general read-aloud settings from `/api/settings` and stay in sync on saves. */
export function useReadAloudSettings(override?: Partial<ReadAloudConfig>): ReadAloudConfig {
	const [stored, setStored] = useState<ReadAloudConfig>(DEFAULT_READ_ALOUD_CONFIG);
	const hasOverride = override !== undefined;

	const reload = useCallback(() => {
		if (hasOverride || typeof window === "undefined" || typeof fetch !== "function") return;
		let alive = true;
		fetch("/api/settings")
			.then((r) => (r.ok ? (r.json() as Promise<{ settings?: UserSettings | null }>) : null))
			.then((body) => {
				if (alive && body) setStored(configFromSettings(body.settings));
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [hasOverride]);

	useEffect(() => reload(), [reload]);
	useSettingsSaved((section) => {
		if (section === "general") void reload();
	});

	return useMemo(
		() => ({
			autoRead: override?.autoRead ?? stored.autoRead,
			rate: override?.rate ?? stored.rate,
			voice: override?.voice !== undefined ? override.voice : stored.voice,
		}),
		[override?.autoRead, override?.rate, override?.voice, stored],
	);
}

export interface QuestionReadAloudProps {
	questionId: string;
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
	/** Optional speechSynthesis dependency injection (tests). */
	controllerDeps?: SpeechControllerDeps;
	className?: string;
}

const INITIAL_SPEECH_STATE: SpeechState = {
	status: "unsupported",
	speaking: false,
	voices: [],
};

function unavailableReason(status: SpeechState["status"]): string | null {
	if (status === "unsupported") return "Read aloud is unavailable in this browser";
	if (status === "no-voices") return "No system speech voices installed";
	return null;
}

/**
 * Play/Stop control placed beside a pending question in QuestionDock.
 *
 * Only accepts displayed question text, context, and displayed options — never
 * correct answers, hidden explanations, unrevealed hints, or tutor planning.
 */
export function QuestionReadAloud({
	questionId,
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
	const controllerRef = useRef<SpeechController | null>(null);
	const [speech, setSpeech] = useState<SpeechState>(INITIAL_SPEECH_STATE);
	const [shortcutLabel, setShortcutLabel] = useState<string>(() => formatBinding(bindingForAction("read-question-aloud")));
	const reasonId = useId();

	const resolvedQuestion = qd ? qd.question : (question ?? "");
	const resolvedContext = qd ? qd.context : context;
	const resolvedOptions = useMemo(() => {
		if (wordingOnly) return undefined;
		if (qd) return speechOptionsFromQuestion(qd, kind);
		return options;
	}, [qd, kind, wordingOnly, options]);

	const utterances = useMemo(
		() => buildQuestionSpeech({ question: resolvedQuestion, context: resolvedContext, options: resolvedOptions, language }),
		[resolvedQuestion, resolvedContext, resolvedOptions, language],
	);

	// Keep latest playback inputs in refs so event listeners and auto-read never churn.
	const latestRef = useRef({ utterances, language, config, active });
	latestRef.current = { utterances, language, config, active };

	// Create and dispose the Web Speech controller on mount/unmount.
	useEffect(() => {
		const controller = createSpeechController(controllerDeps);
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
		else speakNow();
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
		if (hasAutoReadQuestion(questionId)) return;
		markAutoReadQuestion(questionId);
		speakNow();
	}, [config.autoRead, active, speech.status, questionId, utterances.length, speakNow]);

	const reason = unavailableReason(speech.status);
	const disabled = reason !== null || utterances.length === 0;
	const speaking = speech.speaking;
	// Changing label alone communicates state — never combine with aria-pressed.
	const actionLabel = speaking ? "Stop reading question" : "Read question aloud";
	const tooltip = reason
		? reason
		: shortcutLabel
			? `${actionLabel} (${shortcutLabel})`
			: actionLabel;

	return (
		<div className={cn("inline-flex shrink-0 items-center gap-1.5", className)}>
			{reason && (
				<span
					id={reasonId}
					data-testid="question-read-aloud-reason"
					className="text-[11px] font-normal normal-case tracking-normal text-muted-foreground/70"
				>
					{reason}
				</span>
			)}
			<button
				type="button"
				data-testid="question-read-aloud"
				data-speech-status={speech.status}
				disabled={disabled}
				aria-label={actionLabel}
				aria-describedby={reason ? reasonId : undefined}
				title={tooltip}
				onClick={toggleSpeech}
				className={cn(
					"lh-touch inline-flex h-6 shrink-0 items-center gap-1 rounded-sm px-1.5 text-[11px] font-medium normal-case tracking-normal transition-colors",
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
	);
}
