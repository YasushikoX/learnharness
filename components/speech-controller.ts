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
 * Works offline in Electron on macOS and Windows using system voices, with
 * late-loading voice handling (`voiceschanged`), language-aware voice choice,
 * sequential sentence-sized utterance playback so Stop is prompt, and clean
 * dependency injection for tests.
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
	addEventListener?: (type: string, listener: () => void) => void;
	removeEventListener?: (type: string, listener: () => void) => void;
	onvoiceschanged?: (() => void) | null;
}

export type SpeechUtteranceCtor = new (text: string) => SpeechUtteranceLike;

export interface SpeechControllerDeps {
	synthesis?: SpeechSynthesisLike | null;
	Utterance?: SpeechUtteranceCtor | null;
}

export type SpeechStatus = "ready" | "unsupported" | "no-voices";

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
	subscribe(listener: (state: SpeechState) => void): () => void;
	speak(utterances: readonly string[], options: SpeakOptions): boolean;
	stop(): void;
	refreshVoices(): void;
	dispose(): void;
}

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

/**
 * Choose a voice for the lesson's language, honoring an explicit user choice
 * when present and installed, and falling back sensibly when no voice matches
 * the lesson language.
 */
export function pickSpeechVoice(
	voices: readonly SpeechVoiceLike[],
	language: LessonLanguage,
	preferredVoice: string | null | undefined,
): SpeechVoiceLike | null {
	if (voices.length === 0) return null;

	if (preferredVoice) {
		const exact = voices.find((v) => v.voiceURI === preferredVoice || v.name === preferredVoice);
		if (exact) return exact;
	}

	const prefixes = LANGUAGE_PREFIXES[language];
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

export function createSpeechController(deps?: SpeechControllerDeps): SpeechController {
	const resolved = deps !== undefined
		? { synthesis: deps.synthesis ?? null, Utterance: deps.Utterance ?? null }
		: browserSpeechDeps();
	const { synthesis, Utterance } = resolved;
	const supported = synthesis !== null && Utterance !== null;

	const listeners = new Set<(state: SpeechState) => void>();
	let runId = 0;
	let disposed = false;

	const readVoices = (): readonly SpeechVoiceLike[] => {
		if (!supported) return [];
		try {
			return [...synthesis.getVoices()];
		} catch {
			return [];
		}
	};

	const computeStatus = (voices: readonly SpeechVoiceLike[]): SpeechStatus => {
		if (!supported) return "unsupported";
		return voices.length > 0 ? "ready" : "no-voices";
	};

	let voices = readVoices();
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

	const refreshVoices = () => {
		if (disposed || !supported) return;
		voices = readVoices();
		setState({ voices, status: computeStatus(voices) });
	};

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
			const text = queue[index];
			if (text === undefined) {
				setState({ speaking: false });
				return;
			}
			const utterance = new Utterance(text);
			utterance.rate = rate;
			utterance.lang = lang;
			if (chosenVoice) utterance.voice = chosenVoice;
			utterance.onend = () => {
				if (disposed || currentRun !== runId) return;
				index++;
				speakNext();
			};
			utterance.onerror = () => {
				if (disposed || currentRun !== runId) return;
				setState({ speaking: false });
			};
			try {
				synthesis.speak(utterance);
			} catch {
				if (currentRun === runId) setState({ speaking: false });
			}
		};

		speakNext();
		return true;
	};

	const dispose = () => {
		if (disposed) return;
		stop();
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
