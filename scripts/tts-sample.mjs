#!/usr/bin/env node
/**
 * Read-aloud sample (WP10, 2026-11-26): one English and one Norwegian WAV from Google's Gemini TTS, made with the same
 * client the app uses (src/server/tts/gemini-tts.ts), the default model and the default voice per language, so the
 * owner can listen before relying on it. Nothing is cached or saved anywhere else.
 *
 *   GEMINI_API_KEY=… node scripts/tts-sample.mjs <folder>
 *
 * (The app's TypeScript modules are loaded through tsx, a dev dependency, so plain `node` works after `npm ci`.)
 *
 * Options (environment): TTS_MODEL (default gemini-3.8-flash-tts; gemini-3.8-flash-lite-tts is "Faster"),
 * TTS_VOICE_EN / TTS_VOICE_NB (a voice name from src/core/tts.ts), GEMINI_TTS_BASE_URL (tests only).
 * The key is read from the environment and never printed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { register } from "tsx/esm/api";

register();
const { GOOGLE_TTS_DEFAULT_MODEL, GOOGLE_TTS_DEFAULT_VOICES, GOOGLE_TTS_STYLE } = await import("../src/core/tts.ts");
const { synthesizeGeminiSpeech } = await import("../src/server/tts/gemini-tts.ts");

const SAMPLES = [
	{ language: "en", file: "sample-en.wav", text: "Here is the next question. What happens to the boiling point of water when the air pressure drops? Take your time, and answer when you are ready." },
	{ language: "nb", file: "sample-nb.wav", text: "Her er neste spørsmål. Hva skjer med kokepunktet til vann når lufttrykket synker? Ta den tiden du trenger, og svar når du er klar." },
];

const folder = process.argv[2];
const apiKey = process.env.GEMINI_API_KEY?.trim();
if (!folder || !apiKey) {
	console.error("Usage: GEMINI_API_KEY=<your AI Studio key> node scripts/tts-sample.mjs <folder>");
	process.exit(2);
}
const out = resolve(folder);
mkdirSync(out, { recursive: true });
const model = process.env.TTS_MODEL?.trim() || GOOGLE_TTS_DEFAULT_MODEL;

let failed = 0;
for (const sample of SAMPLES) {
	const voice = process.env[`TTS_VOICE_${sample.language.toUpperCase()}`]?.trim() || GOOGLE_TTS_DEFAULT_VOICES[sample.language];
	const started = Date.now();
	const result = await synthesizeGeminiSpeech({
		apiKey,
		model,
		voice,
		text: sample.text,
		style: GOOGLE_TTS_STYLE,
		...(process.env.GEMINI_TTS_BASE_URL ? { baseUrl: process.env.GEMINI_TTS_BASE_URL } : {}),
	});
	const ms = Date.now() - started;
	if (!result.ok) {
		failed++;
		console.error(`${sample.language}: failed (${result.kind}) after ${ms} ms: ${result.message}`);
		continue;
	}
	const path = join(out, sample.file);
	writeFileSync(path, result.wav);
	const seconds = (result.wav.byteLength - 44) / (24_000 * 2);
	console.log(`${sample.language}: ${path} (${model}, voice ${voice}, ${Math.round(result.wav.byteLength / 1024)} KB, about ${seconds.toFixed(1)} s of audio, ${ms} ms)`);
}
process.exit(failed ? 1 : 0);
