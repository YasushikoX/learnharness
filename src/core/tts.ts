import type { LessonLanguage } from "./language.ts";

/**
 * Read-aloud voices (WP10, 2026-11-26): what the renderer, the Settings section and the server share about the
 * Google (Gemini TTS) engine. Pure and browser-safe; no type here carries a key.
 *
 * THE ENGINES. "google": Gemini TTS through the learner's Google AI Studio key, called only from the server
 * (src/server/tts/). "system": the browser's `speechSynthesis` with the system voices (components/speech-controller.ts),
 * which is also the fallback for every Google failure (no key, offline, an error, a quota hit).
 *
 * CHECKED IN GOOGLE'S DOCS ON 2026-11-26 (aistudio.google.com/docs/speech-generation, which ai.google.dev/gemini-api/docs
 * redirects to; aistudio.google.com/docs/pricing): see src/server/tts/gemini-tts.ts for the request format. The voices
 * below are the 30 prebuilt voices with Google's own one-word descriptions. The models detect the input language
 * themselves (there is no language parameter); both 3.8 models list Norwegian Bokmål.
 */

export type ReadAloudEngine = "google" | "system";

export function isReadAloudEngine(value: unknown): value is ReadAloudEngine {
	return value === "google" || value === "system";
}

/** The default (quality) model, and the "Faster" one. Both have a free tier on the Standard plan (pricing, 2026-11-26). */
export const GOOGLE_TTS_DEFAULT_MODEL = "gemini-3.8-flash-tts";
export const GOOGLE_TTS_FAST_MODEL = "gemini-3.8-flash-lite-tts";
export const GOOGLE_TTS_MODELS: readonly { id: string; label: string }[] = [
	{ id: GOOGLE_TTS_DEFAULT_MODEL, label: "Natural" },
	{ id: GOOGLE_TTS_FAST_MODEL, label: "Faster" },
];

export function isGoogleTtsModel(value: unknown): value is string {
	return typeof value === "string" && GOOGLE_TTS_MODELS.some((m) => m.id === value);
}

/** Google's 30 prebuilt voices and their descriptions (speech-generation docs, 2026-11-26). Every voice speaks every language. */
export const GOOGLE_TTS_VOICES: readonly { name: string; description: string }[] = [
	{ name: "Achernar", description: "Soft" },
	{ name: "Achird", description: "Friendly" },
	{ name: "Algenib", description: "Gravelly" },
	{ name: "Algieba", description: "Smooth" },
	{ name: "Alnilam", description: "Firm" },
	{ name: "Aoede", description: "Breezy" },
	{ name: "Autonoe", description: "Bright" },
	{ name: "Callirrhoe", description: "Easy-going" },
	{ name: "Charon", description: "Informative" },
	{ name: "Despina", description: "Smooth" },
	{ name: "Enceladus", description: "Breathy" },
	{ name: "Erinome", description: "Clear" },
	{ name: "Fenrir", description: "Excitable" },
	{ name: "Gacrux", description: "Mature" },
	{ name: "Iapetus", description: "Clear" },
	{ name: "Kore", description: "Firm" },
	{ name: "Laomedeia", description: "Upbeat" },
	{ name: "Leda", description: "Youthful" },
	{ name: "Orus", description: "Firm" },
	{ name: "Puck", description: "Upbeat" },
	{ name: "Pulcherrima", description: "Forward" },
	{ name: "Rasalgethi", description: "Informative" },
	{ name: "Sadachbia", description: "Lively" },
	{ name: "Sadaltager", description: "Knowledgeable" },
	{ name: "Schedar", description: "Even" },
	{ name: "Sulafat", description: "Warm" },
	{ name: "Umbriel", description: "Easy-going" },
	{ name: "Vindemiatrix", description: "Gentle" },
	{ name: "Zephyr", description: "Bright" },
	{ name: "Zubenelgenubi", description: "Casual" },
];

export function isGoogleTtsVoice(value: unknown): value is string {
	return typeof value === "string" && GOOGLE_TTS_VOICES.some((v) => v.name === value);
}

/** A calm, clear default per lesson language (both "Clear" in Google's list; to be confirmed by ear). */
export const GOOGLE_TTS_DEFAULT_VOICES: Readonly<Record<LessonLanguage, string>> = {
	en: "Erinome",
	nb: "Iapetus",
};

/**
 * The delivery asked for (`speech_metadata.style`, the 3.8 models' sustained-style field). Google's migration notes
 * say to keep age, gender and accent out of it, and the text itself verbatim.
 */
export const GOOGLE_TTS_STYLE = "calm, clear and unhurried, like a patient teacher reading aloud";

/** One sentence per language for the ▶ preview in Settings. */
export const GOOGLE_TTS_PREVIEW_TEXT: Readonly<Record<LessonLanguage, string>> = {
	en: "Here is the next question. Take your time, and answer when you are ready.",
	nb: "Her er neste spørsmål. Ta den tiden du trenger, og svar når du er klar.",
};

/** The voice to use for a language: the saved one when it is a known voice, else the default. */
export function googleVoiceFor(language: LessonLanguage, saved: Partial<Record<LessonLanguage, string>> | null | undefined): string {
	const pick = saved?.[language];
	return isGoogleTtsVoice(pick) ? pick : GOOGLE_TTS_DEFAULT_VOICES[language];
}

/** The model to use: the saved one when it is offered, else the default. */
export function googleModelFor(saved: string | null | undefined): string {
	return isGoogleTtsModel(saved) ? saved : GOOGLE_TTS_DEFAULT_MODEL;
}

/**
 * Which engine reads aloud: an explicit choice wins ("google" still needs a key, else system voices); with no choice,
 * Google once a key is available, else system voices. Pure.
 */
export function effectiveReadAloudEngine(choice: ReadAloudEngine | null | undefined, googleKeyAvailable: boolean): ReadAloudEngine {
	if (choice === "system") return "system";
	return googleKeyAvailable ? "google" : "system";
}

/** The longest text one synthesis request takes (the route refuses more). */
export const GOOGLE_TTS_MAX_TEXT_CHARS = 2_000;
/** The first chunk is kept short so playback starts quickly; later chunks are larger, so a question costs few calls. */
export const TTS_FIRST_CHUNK_CHARS = 200;
export const TTS_CHUNK_CHARS = 700;

export interface SpeechChunk {
	/** The text sent for synthesis: the lines joined with a space. */
	text: string;
	/** The read-aloud lines (sentences) it holds, in order: the system-voice fallback speaks these. */
	lines: string[];
}

/**
 * Pack sentence-sized lines (buildQuestionSpeech / splitSpeechUtterances output) into synthesis chunks: the first up
 * to `firstChars`, the rest up to `chunkChars`, never splitting a line. A line longer than the cap is a chunk of its
 * own (cut at `GOOGLE_TTS_MAX_TEXT_CHARS`). Blank lines are dropped. Pure.
 */
export function chunkSpeechLines(lines: readonly string[], firstChars = TTS_FIRST_CHUNK_CHARS, chunkChars = TTS_CHUNK_CHARS): SpeechChunk[] {
	const chunks: SpeechChunk[] = [];
	let current: string[] = [];
	let length = 0;
	const flush = () => {
		if (current.length === 0) return;
		chunks.push({ text: current.join(" "), lines: current });
		current = [];
		length = 0;
	};
	for (const raw of lines) {
		const line = raw.trim().slice(0, GOOGLE_TTS_MAX_TEXT_CHARS);
		if (!line) continue;
		const cap = chunks.length === 0 ? firstChars : chunkChars;
		const added = length === 0 ? line.length : length + 1 + line.length;
		if (current.length > 0 && added > cap) flush();
		current.push(line);
		length = length === 0 ? line.length : length + 1 + line.length;
	}
	flush();
	return chunks;
}

/** Why a Google read failed, as the speak route reports it. */
export type GoogleTtsFailure = "no_key" | "quota" | "rate_limit" | "auth" | "offline" | "timeout" | "bad_request" | "bad_response" | "unavailable";

/** Failures after which Google is not tried again for a while (the read falls back to system voices meanwhile). */
export function isGoogleTtsLimit(kind: GoogleTtsFailure): boolean {
	return kind === "quota" || kind === "rate_limit";
}

export const GOOGLE_TTS_LIMIT_NOTICE = "Google's free limit was reached; using system voices until it resets";

/** What Settings → Read aloud gets from GET /api/tts. */
export interface ReadAloudStatus {
	/** Where the key comes from: the converter's own (Settings → PDF conversion or here), the Google provider's, or none. */
	key: { source: "own" | "provider" | null; hint?: string };
	/** A real call has succeeded on this device (until then the engine is marked unverified). */
	verified: boolean;
	keyUrl: string;
	privacyNote: string;
	models: readonly { id: string; label: string }[];
	voices: readonly { name: string; description: string }[];
	defaults: { model: string; voices: Readonly<Record<LessonLanguage, string>> };
}

export const GOOGLE_TTS_KEY_URL = "https://aistudio.google.com/apikey";
export const GOOGLE_TTS_PRIVACY_NOTE =
	"With Google voices on, the text read aloud (questions and options) is sent to Google. On the free tier Google may use it to improve its products, and people may review it.";
