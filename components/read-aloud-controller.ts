"use client";

import {
	chunkSpeechLines,
	DEFAULT_READ_ALOUD_RATE,
	GOOGLE_TTS_LIMIT_NOTICE,
	isGoogleTtsLimit,
	READ_ALOUD_RATE_MAX,
	READ_ALOUD_RATE_MIN,
	type GoogleTtsFailure,
	type LessonLanguage,
	type ReadAloudEngine,
} from "@/src/core";
import {
	createSpeechController,
	utteranceWatchdogMs,
	DEFAULT_WATCHDOG_MIN_MS,
	DEFAULT_WATCHDOG_MS_PER_CHAR,
	type SpeakOptions,
	type SpeechController,
	type SpeechControllerDeps,
	type SpeechState,
	type SpeechUtteranceLike,
} from "@/components/speech-controller";

/**
 * The read-aloud controller (WP10, 2026-11-26): the speech controller's interface with two engines behind it.
 *
 *   - "google": the server's Gemini TTS (POST /api/tts/speak; the key never reaches the renderer). The lines are packed
 *     into sentence chunks (core/tts.ts chunkSpeechLines): the first is short, so playback starts after one quick call
 *     while the rest are fetched one at a time behind it. Each chunk plays in an <audio> at the read-aloud rate.
 *   - "system": the browser's speechSynthesis (speech-controller.ts), unchanged.
 *
 * FALLBACK. Any Google failure (no key, offline, an error, a timeout, a 429) reads the rest of that read with system
 * voices, from the chunk that failed. A quota or rate limit also stops Google reads for this app session until it lasts
 * (the server says how long; else a minute), and the state carries a quiet notice, once per app session.
 *
 * NEVER STUCK ON STOP. Waiting for a chunk has a time limit (then system voices take over), and each chunk's playback
 * has the same length-scaled watchdog as a system utterance.
 */

export type GoogleAudioResult =
	| { ok: true; url: string; release(): void }
	| { ok: false; kind: GoogleTtsFailure; retryAfterMs?: number };

/** The renderer's side of POST /api/tts/speak. */
export interface GoogleTtsClient {
	fetchAudio(text: string, language: LessonLanguage, signal: AbortSignal): Promise<GoogleAudioResult>;
	/** Ask the server to synthesize and cache `text` (no audio comes back). */
	prefetch(text: string, language: LessonLanguage): void;
}

/** The part of an <audio> element used here (its handlers typed loosely, as HTMLMediaElement's take an Event). */
export interface AudioLike {
	playbackRate: number;
	onended: ((event: any) => void) | null;
	onerror: ((event: any) => void) | null;
	play(): Promise<void> | void;
	pause(): void;
}

export interface ReadAloudControllerDeps extends SpeechControllerDeps {
	/** null: no Google engine (only system voices). */
	google?: GoogleTtsClient | null;
	createAudio?: (url: string) => AudioLike;
	/** The longest wait for one chunk's audio before system voices take over (default 30 s). */
	fetchTimeoutMs?: number;
	now?: () => number;
}

export interface ReadAloudState extends SpeechState {
	/** The engine reads use now (the chosen one; "system" while Google is limited or absent). */
	engine: ReadAloudEngine;
	/** A quiet one-time notice (the free limit was reached), else null. */
	notice: string | null;
}

export interface ReadAloudController extends SpeechController {
	getState(): ReadAloudState;
	subscribe(listener: (state: ReadAloudState) => void): () => void;
	/** The playing Google chunk's audio while one plays, else null (tests). */
	getActiveAudio(): AudioLike | null;
	setEngine(engine: ReadAloudEngine): void;
	/** Warm the server's cache with the first chunk of these lines (Google only; nothing plays). */
	prefetch(utterances: readonly string[], options: SpeakOptions): void;
}

export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
export const DEFAULT_GOOGLE_LIMIT_MS = 60_000;

// One app session's Google limit and notice, shared by every controller (the dock remounts often).
let googleLimitedUntil = 0;
let limitNoticeShown = false;

/** Forget the session's Google limit and notice (tests). */
export function resetReadAloudSession(): void {
	googleLimitedUntil = 0;
	limitNoticeShown = false;
}

/** The browser client: POST /api/tts/speak, the WAV as an object URL. */
export function browserGoogleTtsClient(): GoogleTtsClient | null {
	if (typeof window === "undefined" || typeof fetch !== "function" || typeof URL?.createObjectURL !== "function") return null;
	const post = (body: Record<string, unknown>, signal?: AbortSignal) =>
		fetch("/api/tts/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
	return {
		async fetchAudio(text, language, signal) {
			let response: Response;
			try {
				response = await post({ text, language }, signal);
			} catch {
				return { ok: false, kind: signal.aborted ? "timeout" : "offline" };
			}
			if (!response.ok) {
				const body = (await response.json().catch(() => null)) as { kind?: GoogleTtsFailure; retryAfterMs?: number } | null;
				return { ok: false, kind: body?.kind ?? "unavailable", ...(typeof body?.retryAfterMs === "number" ? { retryAfterMs: body.retryAfterMs } : {}) };
			}
			try {
				const url = URL.createObjectURL(await response.blob());
				return { ok: true, url, release: () => URL.revokeObjectURL(url) };
			} catch {
				return { ok: false, kind: signal.aborted ? "timeout" : "bad_response" };
			}
		},
		prefetch(text, language) {
			void post({ text, language, prefetch: true }).catch(() => {});
		},
	};
}

function browserAudio(url: string): AudioLike {
	return new Audio(url);
}

function clampRate(rate: number | undefined): number {
	if (typeof rate !== "number" || !Number.isFinite(rate)) return DEFAULT_READ_ALOUD_RATE;
	return Math.min(READ_ALOUD_RATE_MAX, Math.max(READ_ALOUD_RATE_MIN, rate));
}

export function createReadAloudController(deps?: ReadAloudControllerDeps): ReadAloudController {
	const system = createSpeechController(deps);
	const google = deps && "google" in deps ? (deps.google ?? null) : browserGoogleTtsClient();
	const createAudio = deps?.createAudio ?? browserAudio;
	const fetchTimeoutMs = deps?.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
	const watchdogMinMs = deps?.watchdogMinMs ?? DEFAULT_WATCHDOG_MIN_MS;
	const watchdogMsPerChar = deps?.watchdogMsPerChar ?? DEFAULT_WATCHDOG_MS_PER_CHAR;
	const scheduleTimer = deps?.scheduleTimer ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms));
	const cancelTimer = deps?.cancelTimer ?? ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
	const now = deps?.now ?? Date.now;

	const listeners = new Set<(state: ReadAloudState) => void>();
	let chosen: ReadAloudEngine = "system";
	/** Which engine the current read uses (null: idle). */
	let mode: ReadAloudEngine | null = null;
	let googleSpeaking = false;
	let notice: string | null = null;
	let runId = 0;
	let disposed = false;
	let abort: AbortController | null = null;
	let activeAudio: AudioLike | null = null;
	let releaseActive: (() => void) | null = null;
	/** Audio fetched ahead and not played yet: released when the read stops. */
	const held = new Set<() => void>();
	let timer: unknown = null;

	const googleUsable = () => chosen === "google" && google !== null && now() >= googleLimitedUntil;

	const compute = (): ReadAloudState => {
		const sys = system.getState();
		const engine: ReadAloudEngine = googleUsable() ? "google" : "system";
		return {
			...sys,
			// Google needs no system voices; a fallback without any is simply silent
			status: engine === "google" ? "ready" : sys.status,
			speaking: mode === "google" ? googleSpeaking : sys.speaking,
			engine,
			notice,
		};
	};
	let state = compute();
	const emit = () => {
		state = compute();
		for (const listener of listeners) listener(state);
	};
	const unsubscribeSystem = system.subscribe(() => emit());

	const clearTimer = () => {
		if (timer !== null) {
			cancelTimer(timer);
			timer = null;
		}
	};

	/** Stop Google playback and fetching (not the system engine). */
	const haltGoogle = () => {
		clearTimer();
		abort?.abort();
		abort = null;
		if (activeAudio) {
			activeAudio.onended = null;
			activeAudio.onerror = null;
			try {
				activeAudio.pause();
			} catch {
				// best effort
			}
		}
		activeAudio = null;
		releaseActive?.();
		releaseActive = null;
		for (const release of held) release();
		held.clear();
		googleSpeaking = false;
	};

	const stop = () => {
		runId++;
		haltGoogle();
		system.stop();
		mode = null;
		emit();
	};

	const speakSystem = (lines: readonly string[], options: SpeakOptions): boolean => {
		mode = "system";
		const started = system.speak(lines, options);
		if (!started) mode = null;
		emit();
		return started;
	};

	const speak = (utterances: readonly string[], options: SpeakOptions): boolean => {
		if (disposed) return false;
		const lines = utterances.map((u) => u.trim()).filter(Boolean);
		if (lines.length === 0) return false;
		runId++;
		haltGoogle();
		notice = null;
		if (!googleUsable()) {
			return speakSystem(lines, options);
		}
		system.stop();
		const run = runId;
		const client = google!;
		const chunks = chunkSpeechLines(lines);
		const rate = clampRate(options.rate);
		const controller = new AbortController();
		abort = controller;
		mode = "google";
		googleSpeaking = true;
		emit();

		// Fetch one chunk at a time, each starting when the one before it has arrived (free-tier limits).
		const results: Promise<GoogleAudioResult>[] = [];
		let chain: Promise<unknown> = Promise.resolve();
		for (const chunk of chunks) {
			const next = chain.then((): Promise<GoogleAudioResult> | GoogleAudioResult =>
				run === runId && !controller.signal.aborted ? client.fetchAudio(chunk.text, options.language, controller.signal) : { ok: false, kind: "timeout" },
			);
			// audio that arrives after the read moved on is released at once
			next.then((r) => {
				if (!r.ok) return;
				if (run !== runId || controller.signal.aborted) r.release();
				else held.add(r.release);
			}, () => {});
			results.push(next.catch((): GoogleAudioResult => ({ ok: false, kind: "offline" })));
			chain = next.catch(() => {});
		}

		const fallBack = (from: number, kind: GoogleTtsFailure, retryAfterMs?: number) => {
			if (run !== runId) return;
			haltGoogle();
			if (isGoogleTtsLimit(kind)) {
				googleLimitedUntil = now() + (retryAfterMs ?? DEFAULT_GOOGLE_LIMIT_MS);
				if (!limitNoticeShown) {
					limitNoticeShown = true;
					notice = GOOGLE_TTS_LIMIT_NOTICE;
				}
			}
			const rest = chunks.slice(from).flatMap((c) => c.lines);
			speakSystem(rest, options);
		};

		const playAt = (index: number) => {
			if (disposed || run !== runId) return;
			const chunk = chunks[index];
			if (!chunk) {
				mode = null;
				googleSpeaking = false;
				emit();
				return;
			}
			let waited = false;
			timer = scheduleTimer(() => {
				timer = null;
				waited = true;
				fallBack(index, "timeout");
			}, fetchTimeoutMs);
			void results[index]!.then((result) => {
				if (waited || disposed || run !== runId) return;
				clearTimer();
				if (!result.ok) {
					fallBack(index, result.kind, result.retryAfterMs);
					return;
				}
				held.delete(result.release);
				let audio: AudioLike;
				try {
					audio = createAudio(result.url);
				} catch {
					result.release();
					fallBack(index, "bad_response");
					return;
				}
				audio.playbackRate = rate;
				activeAudio = audio;
				releaseActive = result.release;
				let settled = false;
				const finish = (ok: boolean) => {
					if (settled || disposed || run !== runId) return;
					settled = true;
					clearTimer();
					if (activeAudio === audio) {
						activeAudio = null;
						releaseActive?.();
						releaseActive = null;
					}
					if (ok) playAt(index + 1);
					else fallBack(index, "bad_response");
				};
				audio.onended = () => finish(true);
				audio.onerror = () => finish(false);
				timer = scheduleTimer(() => {
					timer = null;
					if (settled || run !== runId) return;
					settled = true;
					stop();
				}, utteranceWatchdogMs(chunk.text, rate, watchdogMinMs, watchdogMsPerChar));
				try {
					const played = audio.play();
					if (played && typeof (played as Promise<void>).catch === "function") (played as Promise<void>).catch(() => finish(false));
				} catch {
					finish(false);
				}
			});
		};
		playAt(0);
		return true;
	};

	const prefetch = (utterances: readonly string[], options: SpeakOptions) => {
		if (disposed || !googleUsable()) return;
		const first = chunkSpeechLines(utterances)[0];
		if (first) google!.prefetch(first.text, options.language);
	};

	return {
		getState: () => state,
		getActiveUtterance: (): SpeechUtteranceLike | null => system.getActiveUtterance(),
		getActiveAudio: () => activeAudio,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		speak,
		stop,
		prefetch,
		setEngine(engine) {
			if (engine === chosen) return;
			chosen = engine;
			emit();
		},
		refreshVoices: () => system.refreshVoices(),
		dispose() {
			if (disposed) return;
			stop();
			disposed = true;
			unsubscribeSystem();
			system.dispose();
			listeners.clear();
		},
	};
}
