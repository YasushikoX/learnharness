"use client";

import {
	DEFAULT_READ_ALOUD_RATE,
	READ_ALOUD_RATE_MAX,
	READ_ALOUD_RATE_MIN,
	type LessonLanguage,
} from "@/src/core";

/**
 * Small controller around `window.speechSynthesis` for question read-aloud.
 *
 * Works offline in Electron on macOS and Windows using system voices, with:
 * - late-loading voice handling (`voiceschanged`),
 * - language-matched voice selection (honoring an explicit setting only when
 *   its language matches the lesson),
 * - Chromium/Electron reliability guards: strong reference to the active
 *   utterance (prevents GC before `onend`), `resume()` before `speak()`,
 *   short gap between `cancel()` and `speak()`, and a length-scaled watchdog
 *   so the control can never stay stuck on Stop.
 */

export interface SpeechVoiceLike {
	readonly voiceURI: string;
	readonly name: string;
	readonly lang: string;
	readonly default?: boolean;
	readonly localService?: boolean;
}

export interface SpeechUtteranceLike {
	text: string;
	lang: string;
	rate: number;
	voice: SpeechVoiceLike | null;
	onend: ((event: unknown) => void) | null;
	onerror: ((event: { error?: string } | unknown) => void) | null;
}

export interface SpeechSynthesisLike {
	getVoices(): readonly SpeechVoiceLike[];
	speak(utterance: SpeechUtteranceLike): void;
	cancel(): void;
	resume?: () => void;
	addEventListener?: (type: string, listener: () => void) => void;
	removeEventListener?: (type: string, listener: () => void) => void;
	onvoiceschanged?: (() => void) | null;
}

export type SpeechUtteranceCtor = new (text: string) => SpeechUtteranceLike;

export interface SpeechControllerDeps {
	synthesis?: SpeechSynthesisLike | null;
	Utterance?: SpeechUtteranceCtor | null;
	/** Gap in ms between `cancel()` and the next `speak()` (default 40 ms). */
	cancelGapMs?: number;
	/** Minimum watchdog timeout in ms per utterance (default 8000 ms). */
	watchdogMinMs?: number;
	/** Extra watchdog budget per character at 1× rate in ms (default 150 ms). */
	watchdogMsPerChar?: number;
	/**
	 * How long to wait for a first `voiceschanged` before an empty voice list counts as "no voices"
	 * (default 2000 ms). Chromium fills the list asynchronously, so an empty list at start means "loading".
	 */
	voiceSettleMs?: number;
	/** Optional timer hooks for deterministic tests. */
	scheduleTimer?: (fn: () => void, ms: number) => unknown;
	cancelTimer?: (handle: unknown) => void;
}

/** `loading`: supported, but the voice list is empty and has not settled yet (Chromium loads it asynchronously). */
export type SpeechStatus = "ready" | "unsupported" | "loading" | "no-voices";

export interface SpeechState {
	status: SpeechStatus;
	speaking: boolean;
	voices: readonly SpeechVoiceLike[];
}

export interface SpeakOptions {
	language: LessonLanguage;
	rate?: number;
	voice?: string | null;
}

export interface SpeechController {
	getState(): SpeechState;
	/** Current strongly-retained utterance while speaking, or null when idle. */
	getActiveUtterance(): SpeechUtteranceLike | null;
	subscribe(listener: (state: SpeechState) => void): () => void;
	speak(utterances: readonly string[], options: SpeakOptions): boolean;
	stop(): void;
	refreshVoices(): void;
	dispose(): void;
}

export const DEFAULT_CANCEL_GAP_MS = 40;
export const DEFAULT_WATCHDOG_MIN_MS = 8_000;
export const DEFAULT_WATCHDOG_MS_PER_CHAR = 150;
export const DEFAULT_WATCHDOG_MAX_MS = 120_000;
export const DEFAULT_VOICE_SETTLE_MS = 2_000;

const LANGUAGE_PREFIXES: Readonly<Record<LessonLanguage, readonly string[]>> = {
	en: ["en"],
	nb: ["nb-no", "nb", "no-no", "no", "nn-no", "nn"],
};

const DEFAULT_BCP47: Readonly<Record<LessonLanguage, string>> = {
	en: "en-US",
	nb: "nb-NO",
};

function normalizeLang(lang: string): string {
	return lang.trim().toLowerCase().replace(/_/g, "-");
}

function matchRank(voiceLang: string, prefixes: readonly string[]): number {
	const norm = normalizeLang(voiceLang);
	for (let i = 0; i < prefixes.length; i++) {
		const prefix = prefixes[i]!;
		if (norm === prefix || norm.startsWith(`${prefix}-`)) return i;
	}
	return -1;
}

/** True when a voice's BCP-47 language tag matches the given lesson language. */
export function voiceMatchesLanguage(voice: SpeechVoiceLike, language: LessonLanguage): boolean {
	return matchRank(voice.lang, LANGUAGE_PREFIXES[language]) !== -1;
}

/**
 * Choose a voice for the lesson's language.
 *
 * An explicit voice chosen in Settings is used only when its language matches
 * the lesson language; otherwise a matching voice for the lesson language is
 * preferred. Falls back to the explicit voice, system default, or first voice
 * only when no installed voice matches the lesson language at all.
 */
export function pickSpeechVoice(
	voices: readonly SpeechVoiceLike[],
	language: LessonLanguage,
	preferredVoice: string | null | undefined,
): SpeechVoiceLike | null {
	if (voices.length === 0) return null;

	const prefixes = LANGUAGE_PREFIXES[language];
	const explicit = preferredVoice
		? voices.find((v) => v.voiceURI === preferredVoice || v.name === preferredVoice) ?? null
		: null;

	if (explicit && matchRank(explicit.lang, prefixes) !== -1) {
		return explicit;
	}

	let best: SpeechVoiceLike | null = null;
	let bestScore = -Infinity;

	for (const voice of voices) {
		const rank = matchRank(voice.lang, prefixes);
		if (rank === -1) continue;
		// Prefer earlier prefix match, local offline voices, and system default.
		const score = (prefixes.length - rank) * 10 + (voice.localService ? 4 : 0) + (voice.default ? 2 : 0);
		if (score > bestScore) {
			bestScore = score;
			best = voice;
		}
	}

	if (best) return best;
	if (explicit) return explicit;
	return voices.find((v) => v.default) ?? voices[0] ?? null;
}

/** Read system speech synthesis from the global browser window when available. */
export function browserSpeechDeps(): { synthesis: SpeechSynthesisLike | null; Utterance: SpeechUtteranceCtor | null } {
	if (typeof window === "undefined") return { synthesis: null, Utterance: null };
	const win = window as unknown as {
		speechSynthesis?: SpeechSynthesisLike;
		SpeechSynthesisUtterance?: SpeechUtteranceCtor;
	};
	const synthesis = win.speechSynthesis && typeof win.speechSynthesis.speak === "function" && typeof win.speechSynthesis.cancel === "function"
		? win.speechSynthesis
		: null;
	const Utterance = typeof win.SpeechSynthesisUtterance === "function"
		? win.SpeechSynthesisUtterance
		: typeof globalThis !== "undefined" && typeof (globalThis as unknown as { SpeechSynthesisUtterance?: SpeechUtteranceCtor }).SpeechSynthesisUtterance === "function"
			? (globalThis as unknown as { SpeechSynthesisUtterance: SpeechUtteranceCtor }).SpeechSynthesisUtterance
			: null;
	return { synthesis, Utterance };
}

function clampRate(rate: number | undefined): number {
	if (typeof rate !== "number" || !Number.isFinite(rate)) return DEFAULT_READ_ALOUD_RATE;
	return Math.min(READ_ALOUD_RATE_MAX, Math.max(READ_ALOUD_RATE_MIN, rate));
}

/** Compute a generous watchdog timeout (ms) scaled to utterance length and playback rate. */
export function utteranceWatchdogMs(
	text: string,
	rate: number,
	minMs = DEFAULT_WATCHDOG_MIN_MS,
	msPerChar = DEFAULT_WATCHDOG_MS_PER_CHAR,
): number {
	const safeRate = clampRate(rate);
	const scaled = Math.ceil((text.length * msPerChar) / safeRate) + minMs;
	return Math.min(DEFAULT_WATCHDOG_MAX_MS, Math.max(minMs, scaled));
}

export function createSpeechController(deps?: SpeechControllerDeps): SpeechController {
	const resolved = deps !== undefined
		? { synthesis: deps.synthesis ?? null, Utterance: deps.Utterance ?? null }
		: browserSpeechDeps();
	const { synthesis, Utterance } = resolved;
	const supported = synthesis !== null && Utterance !== null;

	const cancelGapMs = deps?.cancelGapMs ?? DEFAULT_CANCEL_GAP_MS;
	const watchdogMinMs = deps?.watchdogMinMs ?? DEFAULT_WATCHDOG_MIN_MS;
	const watchdogMsPerChar = deps?.watchdogMsPerChar ?? DEFAULT_WATCHDOG_MS_PER_CHAR;
	const voiceSettleMs = deps?.voiceSettleMs ?? DEFAULT_VOICE_SETTLE_MS;
	const scheduleTimer = deps?.scheduleTimer ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms));
	const cancelTimer = deps?.cancelTimer ?? ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));

	const listeners = new Set<(state: SpeechState) => void>();
	let runId = 0;
	let disposed = false;
	// Strong reference to the active utterance prevents Chromium/Electron GC before `onend`.
	let activeUtterance: SpeechUtteranceLike | null = null;
	let gapTimer: unknown = null;
	let watchdogTimer: unknown = null;
	let settleTimer: unknown = null;

	const clearGapTimer = () => {
		if (gapTimer !== null) {
			cancelTimer(gapTimer);
			gapTimer = null;
		}
	};

	const clearWatchdogTimer = () => {
		if (watchdogTimer !== null) {
			cancelTimer(watchdogTimer);
			watchdogTimer = null;
		}
	};

	const readVoices = (): readonly SpeechVoiceLike[] => {
		if (!supported) return [];
		try {
			return [...synthesis.getVoices()];
		} catch {
			return [];
		}
	};

	let voices = readVoices();
	// The voice list has settled once it was non-empty, `voiceschanged` fired, or the settle wait ran out.
	let voicesSettled = voices.length > 0;

	const computeStatus = (list: readonly SpeechVoiceLike[]): SpeechStatus => {
		if (!supported) return "unsupported";
		if (list.length > 0) return "ready";
		return voicesSettled ? "no-voices" : "loading";
	};

	let state: SpeechState = {
		status: computeStatus(voices),
		speaking: false,
		voices,
	};

	const emit = () => {
		for (const listener of listeners) listener(state);
	};

	const setState = (next: Partial<SpeechState>) => {
		state = { ...state, ...next };
		emit();
	};

	const clearSettleTimer = () => {
		if (settleTimer !== null) {
			cancelTimer(settleTimer);
			settleTimer = null;
		}
	};

	const refreshVoices = () => {
		if (disposed || !supported) return;
		voicesSettled = true;
		clearSettleTimer();
		voices = readVoices();
		setState({ voices, status: computeStatus(voices) });
	};

	if (supported && !voicesSettled) {
		settleTimer = scheduleTimer(() => {
			settleTimer = null;
			refreshVoices();
		}, voiceSettleMs);
	}

	const onVoicesChanged = () => refreshVoices();
	let boundPropertyHandler = false;
	if (supported) {
		if (typeof synthesis.addEventListener === "function") {
			synthesis.addEventListener("voiceschanged", onVoicesChanged);
		} else {
			synthesis.onvoiceschanged = onVoicesChanged;
			boundPropertyHandler = true;
		}
	}

	const stop = () => {
		runId++;
		clearGapTimer();
		clearWatchdogTimer();
		activeUtterance = null;
		if (supported) {
			try {
				synthesis.cancel();
			} catch {
				// Best-effort cancel across Electron/browser engines.
			}
		}
		if (state.speaking) setState({ speaking: false });
	};

	const speak = (utterances: readonly string[], options: SpeakOptions): boolean => {
		if (disposed || !supported) return false;
		const queue = utterances.map((u) => u.trim()).filter(Boolean);
		if (queue.length === 0) return false;

		// Refresh voice list right before speaking in case voices loaded silently.
		voices = readVoices();
		const status = computeStatus(voices);
		if (status !== "ready") {
			setState({ voices, status, speaking: false });
			return false;
		}

		const currentRun = ++runId;
		clearGapTimer();
		clearWatchdogTimer();
		activeUtterance = null;

		try {
			synthesis.cancel();
		} catch {
			// Ignore cancel errors when nothing was queued.
		}

		const chosenVoice = pickSpeechVoice(voices, options.language, options.voice);
		const rate = clampRate(options.rate);
		const lang = chosenVoice?.lang || DEFAULT_BCP47[options.language];

		setState({ voices, status: "ready", speaking: true });

		let index = 0;
		const speakNext = () => {
			if (disposed || currentRun !== runId) return;
			clearWatchdogTimer();
			const text = queue[index];
			if (text === undefined) {
				activeUtterance = null;
				setState({ speaking: false });
				return;
			}
			const utterance = new Utterance(text);
			utterance.rate = rate;
			utterance.lang = lang;
			if (chosenVoice) utterance.voice = chosenVoice;
			// Retain a strong reference until completion, error, stop, or watchdog expiry.
			activeUtterance = utterance;

			let settled = false;
			utterance.onend = () => {
				if (settled || disposed || currentRun !== runId) return;
				settled = true;
				clearWatchdogTimer();
				if (activeUtterance === utterance) activeUtterance = null;
				index++;
				speakNext();
			};
			utterance.onerror = () => {
				if (settled || disposed || currentRun !== runId) return;
				settled = true;
				clearWatchdogTimer();
				if (activeUtterance === utterance) activeUtterance = null;
				setState({ speaking: false });
			};

			const timeoutMs = utteranceWatchdogMs(text, rate, watchdogMinMs, watchdogMsPerChar);
			watchdogTimer = scheduleTimer(() => {
				if (settled || disposed || currentRun !== runId) return;
				settled = true;
				watchdogTimer = null;
				stop();
			}, timeoutMs);

			try {
				synthesis.resume?.();
			} catch {
				// Best-effort resume before speak in case the engine paused after OS sleep.
			}
			try {
				synthesis.speak(utterance);
			} catch {
				if (currentRun === runId) {
					settled = true;
					clearWatchdogTimer();
					activeUtterance = null;
					setState({ speaking: false });
				}
			}
		};

		// Leave a short gap after cancel() so Chromium/Electron doesn't drop the first utterance.
		if (cancelGapMs > 0) {
			gapTimer = scheduleTimer(() => {
				gapTimer = null;
				speakNext();
			}, cancelGapMs);
		} else {
			speakNext();
		}
		return true;
	};

	const dispose = () => {
		if (disposed) return;
		stop();
		clearSettleTimer();
		disposed = true;
		if (supported) {
			if (typeof synthesis.removeEventListener === "function") {
				synthesis.removeEventListener("voiceschanged", onVoicesChanged);
			} else if (boundPropertyHandler && synthesis.onvoiceschanged === onVoicesChanged) {
				synthesis.onvoiceschanged = null;
			}
		}
		listeners.clear();
	};

	return {
		getState: () => state,
		getActiveUtterance: () => activeUtterance,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		speak,
		stop,
		refreshVoices,
		dispose,
	};
}
