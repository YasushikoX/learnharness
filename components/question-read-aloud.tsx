"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SquareIcon, Volume2Icon } from "lucide-react";
import {
	bindingForAction,
	buildQuestionSpeech,
	DEFAULT_LESSON_LANGUAGE,
	DEFAULT_READ_ALOUD_RATE,
	formatBinding,
	kbdEventForAction,
	KEYMAP_CHANGED_EVENT,
	READ_ALOUD_RATE_MAX,
	READ_ALOUD_RATE_MIN,
	type LessonLanguage,
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
	question: string;
	context?: string;
	/** Displayed options only, in displayed order with displayed letters. */
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

	const utterances = useMemo(
		() => buildQuestionSpeech({ question, context, options }),
		[question, context, options],
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

	// Auto-read once per pending question when enabled and visible.
	const autoReadQuestionIdRef = useRef<string | null>(null);
	useEffect(() => {
		if (!config.autoRead || !active || speech.status !== "ready" || utterances.length === 0) return;
		if (autoReadQuestionIdRef.current === questionId) return;
		autoReadQuestionIdRef.current = questionId;
		speakNow();
	}, [config.autoRead, active, speech.status, questionId, utterances.length, speakNow]);

	const reason = unavailableReason(speech.status);
	const disabled = reason !== null || utterances.length === 0;
	const speaking = speech.speaking;
	const actionLabel = speaking ? "Stop reading question" : "Read question aloud";
	const tooltip = reason
		? reason
		: shortcutLabel
			? `${actionLabel} (${shortcutLabel})`
			: actionLabel;

	return (
		<button
			type="button"
			data-testid="question-read-aloud"
			data-speech-status={speech.status}
			disabled={disabled}
			aria-label={reason ? `${actionLabel} — ${reason}` : actionLabel}
			aria-pressed={speaking}
			title={tooltip}
			onClick={toggleSpeech}
			className={cn(
				"inline-flex h-6 shrink-0 items-center gap-1 rounded-sm px-1.5 text-[11px] font-medium normal-case tracking-normal transition-colors",
				disabled
					? "cursor-not-allowed text-muted-foreground/50"
					: speaking
						? "bg-accent text-foreground"
						: "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
				className,
			)}
		>
			{speaking ? <SquareIcon className="size-3 fill-current" aria-hidden="true" /> : <Volume2Icon className="size-3.5" aria-hidden="true" />}
			<span>{speaking ? "Stop" : "Read aloud"}</span>
		</button>
	);
}
