import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../../config.ts";
import type { LessonLanguage } from "../../core/language.ts";
import {
	GOOGLE_TTS_DEFAULT_MODEL,
	GOOGLE_TTS_DEFAULT_VOICES,
	GOOGLE_TTS_KEY_URL,
	GOOGLE_TTS_MODELS,
	GOOGLE_TTS_PRIVACY_NOTE,
	GOOGLE_TTS_PREVIEW_TEXT,
	GOOGLE_TTS_STYLE,
	GOOGLE_TTS_VOICES,
	googleModelFor,
	googleVoiceFor,
	isGoogleTtsModel,
	isGoogleTtsVoice,
	isGoogleTtsLimit,
	type GoogleTtsFailure,
	type ReadAloudStatus,
} from "../../core/tts.ts";
import { credentialStatus, geminiKeySource, readConverterCredential } from "../converters/credentials.ts";
import { GEMINI_BASE_URL, GEMINI_CONVERTER_ID } from "../converters/gemini.ts";
import { readSettings } from "../../store/settings.ts";
import { createTtsCache, type TtsCache, type TtsCacheKey } from "./cache.ts";
import { synthesizeGeminiSpeech, type GeminiTtsRequest, type GeminiTtsResult } from "./gemini-tts.ts";

/**
 * Read-aloud with Google voices, server side (WP10, 2026-11-26), behind app/api/tts/.
 *
 * THE KEY is the Gemini PDF converter's: its own key (Settings → PDF conversion, or saved from Settings → Read aloud,
 * which stores it in the same place), else the Google model provider's key (GEMINI_API_KEY). It is read at the moment of
 * use (converters/credentials.ts) and never leaves the server.
 *
 * A REQUEST: the cache first (a hit costs no call); else one Gemini TTS call, deduplicated with any identical call in
 * flight (a prefetch and the play that follows it), then cached. After a 429 Google is not called again until its
 * limit lasts (the daily quota: midnight Pacific; a per-minute limit: what Google says, else a minute), and every read
 * answers `quota`/`rate_limit` at once, so the renderer uses system voices. The first successful call marks the engine
 * verified on this device (`<data>/tts/state.json`).
 */

export const TTS_RATE_LIMIT_DEFAULT_MS = 60_000;

export interface SpeakInput {
	text: string;
	language: LessonLanguage;
	/** A voice to try (the ▶ preview in Settings); else the saved voice for the language. */
	voice?: string;
	/** A model to try; else the saved one. */
	model?: string;
	/** Skip the cache read (Settings → Test: a real call); the answer is still cached. */
	fresh?: boolean;
}

export type SpeakResult =
	| { ok: true; wav: Uint8Array; cached: boolean }
	| { ok: false; kind: GoogleTtsFailure; message: string; retryAfterMs?: number };

export interface TtsServiceDeps {
	readKey?: () => string | undefined;
	readGeneral?: () => { readAloudModel?: string; readAloudVoices?: Partial<Record<LessonLanguage, string>> } | undefined;
	synthesize?: (request: GeminiTtsRequest) => Promise<GeminiTtsResult>;
	cache?: TtsCache;
	stateFile?: string;
	now?: () => number;
}

export interface TtsService {
	speak(input: SpeakInput): Promise<SpeakResult>;
	status(): ReadAloudStatus;
	/** When Google may be tried again (ms since epoch), or 0 (tests). */
	limitedUntil(): number;
}

export function createTtsService(deps: TtsServiceDeps = {}): TtsService {
	const readKey = deps.readKey ?? (() => readConverterCredential(GEMINI_CONVERTER_ID, GEMINI_BASE_URL));
	const readGeneral = deps.readGeneral ?? (() => readSettings()?.general);
	const synthesize = deps.synthesize ?? synthesizeGeminiSpeech;
	const cache = deps.cache ?? createTtsCache(path.join(/* turbopackIgnore: true */ PATHS.data, "tts-cache"));
	const stateFile = deps.stateFile ?? path.join(/* turbopackIgnore: true */ PATHS.data, "tts", "state.json");
	const now = deps.now ?? Date.now;
	const inFlight = new Map<string, Promise<SpeakResult>>();
	let limited: { until: number; kind: GoogleTtsFailure; message: string } | null = null;

	const readVerified = (): boolean => {
		try {
			const state = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ stateFile, "utf8")) as { verifiedAt?: unknown };
			return typeof state.verifiedAt === "string";
		} catch {
			return false;
		}
	};
	let verified: boolean | undefined;
	const markVerified = () => {
		if (verified) return;
		verified = true;
		try {
			fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(stateFile), { recursive: true });
			fs.writeFileSync(/* turbopackIgnore: true */ stateFile, JSON.stringify({ verifiedAt: new Date(now()).toISOString() }, null, "\t"));
		} catch {
			// only the "unverified" label depends on it
		}
	};

	async function speak(input: SpeakInput): Promise<SpeakResult> {
		const text = input.text.trim();
		if (!text) return { ok: false, kind: "bad_request", message: "Nothing to read" };
		const general = readGeneral();
		const model = isGoogleTtsModel(input.model) ? input.model : googleModelFor(general?.readAloudModel);
		const voice = isGoogleTtsVoice(input.voice) ? input.voice : googleVoiceFor(input.language, general?.readAloudVoices);
		const key: TtsCacheKey = { model, voice, style: GOOGLE_TTS_STYLE, text };
		const hit = input.fresh ? undefined : cache.get(key);
		if (hit) return { ok: true, wav: hit, cached: true };

		if (limited && now() < limited.until) return { ok: false, kind: limited.kind, message: limited.message, retryAfterMs: limited.until - now() };
		limited = null;
		const apiKey = readKey();
		if (!apiKey) return { ok: false, kind: "no_key", message: "No Google AI Studio key is saved" };

		const id = JSON.stringify(key);
		const running = inFlight.get(id);
		if (running) return running;
		// (a fresh Test call joins an identical call in flight: that one is just as real)
		const call = (async (): Promise<SpeakResult> => {
			// No caller's signal: a prefetch whose question went away still fills the cache for whoever waits on it.
			const result = await synthesize({ apiKey, model, voice, text, style: GOOGLE_TTS_STYLE });
			if (result.ok) {
				cache.put(key, result.wav);
				markVerified();
				return { ok: true, wav: result.wav, cached: false };
			}
			if (isGoogleTtsLimit(result.kind)) {
				limited = { until: now() + (result.retryAfterMs ?? TTS_RATE_LIMIT_DEFAULT_MS), kind: result.kind, message: result.message };
			}
			return result;
		})();
		inFlight.set(id, call);
		try {
			return await call;
		} finally {
			inFlight.delete(id);
		}
	}

	function status(): ReadAloudStatus {
		if (verified === undefined) verified = readVerified();
		const source = deps.readKey ? (readKey() ? "own" : null) : (geminiKeySource() ?? null);
		const own = source === "own" && !deps.readKey ? credentialStatus(GEMINI_CONVERTER_ID, GEMINI_BASE_URL) : undefined;
		return {
			key: { source, ...(own?.hint ? { hint: own.hint } : {}) },
			verified,
			keyUrl: GOOGLE_TTS_KEY_URL,
			privacyNote: GOOGLE_TTS_PRIVACY_NOTE,
			models: GOOGLE_TTS_MODELS,
			voices: GOOGLE_TTS_VOICES,
			defaults: { model: GOOGLE_TTS_DEFAULT_MODEL, voices: GOOGLE_TTS_DEFAULT_VOICES },
		};
	}

	return { speak, status, limitedUntil: () => (limited && now() < limited.until ? limited.until : 0) };
}

/** A test call for Settings: the English preview sentence with the default model and voice (cached like any read). */
export function testInput(): SpeakInput {
	return { text: GOOGLE_TTS_PREVIEW_TEXT.en, language: "en", fresh: true };
}

let shared: TtsService | undefined;
/** The app's one service (its cooldown and in-flight calls are shared by every request). */
export function ttsService(): TtsService {
	shared ??= createTtsService();
	return shared;
}
