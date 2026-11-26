import { ConverterError } from "../../core/pdf-converter.ts";
import type { GoogleTtsFailure } from "../../core/tts.ts";
import { GEMINI_BASE_URL, isDailyQuota, minutesUntilPacificMidnight, parseGoogleError } from "../converters/gemini.ts";
import { asRecord, readCapped, serviceMessage, storedKeyProblem } from "../converters/http-common.ts";
import { wavFromPcm } from "../stt/wav.ts";

/**
 * One Gemini TTS call (WP10, 2026-11-26): text in, a WAV file out. Server side only; the key never reaches the renderer.
 *
 * CHECKED IN GOOGLE'S DOCS ON 2026-11-26 (aistudio.google.com/docs/speech-generation and api-reference/interactions-api,
 * which ai.google.dev/gemini-api/docs redirects to), written WITHOUT a real call, so it is "unverified" until one is made:
 *   - POST /v1beta/interactions, header `x-goog-api-key`, JSON:
 *       { model, input: [{ type: "user_input", content: [{ type: "text", text, annotations: [{ type: "speech_metadata",
 *         style }] }] }], response_format: { type: "audio" }, generation_config: { speech_config: [{ voice }] } }
 *     `speech_config` is an array for one speaker. There is no language field: "The TTS models detect the input language
 *     automatically." The 3.8 models take `text` as the verbatim transcript; sustained delivery goes in
 *     `speech_metadata.style` (no age, gender or accent there).
 *   - The answer: the audio is base64 in `steps[].content[].data` on the item with `type == "audio"` (the docs' jq:
 *     `[.steps[] | select(.type=="model_output") | .content[] | select(.type=="audio")] | last | .data`). A unary call
 *     answers `audio/wav` by default: a whole WAV (RIFF header), 24 kHz, mono, 16-bit signed little-endian PCM. The
 *     3.1 preview answered raw PCM, so headerless data (or `mime_type` audio/l16) is wrapped as WAV here at the item's
 *     `sample_rate` (default 24000).
 *   - Interaction.status: completed, failed, incomplete, …; `errors[]` holds { code, message }.
 *   - `store`: "By default, the API stores all Interaction objects (store=true)" (1 day on the free tier); this client
 *     sends `store: false`, since nothing here reads an interaction back.
 *   - Errors are Google's usual v1beta errors (converters/gemini.ts parseGoogleError): 429 per minute or per day (a
 *     daily quota resets at midnight Pacific time), 401/403 or API_KEY_INVALID for a bad key, 404 an unknown model.
 *   - Pricing (aistudio.google.com/docs/pricing, 2026-11-26): gemini-3.8-flash-tts and gemini-3.8-flash-lite-tts have a
 *     free tier on Standard; free-tier content is "used to improve our products". Rate limits apply per project.
 */

export const GEMINI_TTS_NAME = "Google Gemini TTS";
export const GEMINI_TTS_SAMPLE_RATE = 24_000;
/** One synthesis request (a chunk of a few sentences). */
export const GEMINI_TTS_TIMEOUT_MS = 45_000;
/** The largest answer read: ~60 s of 24 kHz audio, base64 in JSON, with room to spare. */
export const GEMINI_TTS_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const ERROR_BODY_BYTES = 64 * 1024;

export interface GeminiTtsRequest {
	apiKey: string;
	model: string;
	voice: string;
	text: string;
	style?: string;
	baseUrl?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	fetch?: typeof fetch;
	now?: () => Date;
}

export type GeminiTtsResult =
	| { ok: true; wav: Uint8Array }
	/** `retryAfterMs`: how long Google's limit lasts, when it says or it is a daily quota. */
	| { ok: false; kind: GoogleTtsFailure; message: string; retryAfterMs?: number };

/** The request body (exported for tests). */
export function geminiTtsBody(model: string, voice: string, text: string, style?: string): Record<string, unknown> {
	return {
		model,
		input: [{ type: "user_input", content: [{ type: "text", text, ...(style ? { annotations: [{ type: "speech_metadata", style }] } : {}) }] }],
		response_format: { type: "audio" },
		generation_config: { speech_config: [{ voice }] },
		store: false,
	};
}

function isRiff(bytes: Uint8Array): boolean {
	return bytes.byteLength >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WAVE";
}

/**
 * The audio of an Interaction answer as a WAV file (exported for tests): the last `audio` item of the model output.
 * WAV bytes pass through; raw PCM (audio/l16 or no header) is wrapped at the item's sample rate. Throws a
 * ConverterError("bad_response") when there is no audio.
 */
export function wavFromInteraction(body: unknown): Uint8Array {
	const interaction = asRecord(body);
	if (!interaction) throw new ConverterError("bad_response", `${GEMINI_TTS_NAME}'s answer is not an object`, false);
	const status = typeof interaction.status === "string" ? interaction.status : undefined;
	const errors = Array.isArray(interaction.errors) ? interaction.errors.map(asRecord).filter((e) => typeof e?.message === "string").map((e) => e!.message as string) : [];
	if (status === "failed" || status === "cancelled") {
		throw new ConverterError("bad_response", `${GEMINI_TTS_NAME} could not read the text (${status}${errors.length ? `: ${serviceMessage(errors.join("; "))}` : ""})`, false);
	}
	const audio: Record<string, unknown>[] = [];
	for (const step of Array.isArray(interaction.steps) ? interaction.steps : []) {
		const s = asRecord(step);
		if (!s || (s.type !== undefined && s.type !== "model_output")) continue;
		for (const item of Array.isArray(s.content) ? s.content : []) {
			const c = asRecord(item);
			if (c?.type === "audio" && typeof c.data === "string" && c.data) audio.push(c);
		}
	}
	const last = audio.at(-1);
	if (!last) throw new ConverterError("bad_response", `${GEMINI_TTS_NAME} answered without audio${status && status !== "completed" ? ` (${status})` : ""}`, false);
	const bytes = new Uint8Array(Buffer.from(last.data as string, "base64"));
	if (bytes.byteLength < 2) throw new ConverterError("bad_response", `${GEMINI_TTS_NAME} answered with empty audio`, false);
	if (isRiff(bytes)) return bytes;
	const mime = typeof last.mime_type === "string" ? last.mime_type.toLowerCase() : "audio/l16";
	if (!/l16|pcm|wav/.test(mime)) throw new ConverterError("bad_response", `${GEMINI_TTS_NAME} answered with ${serviceMessage(mime)} audio, which this app does not play`, false);
	const rate = typeof last.sample_rate === "number" && Number.isInteger(last.sample_rate) && last.sample_rate >= 8_000 && last.sample_rate <= 96_000 ? last.sample_rate : GEMINI_TTS_SAMPLE_RATE;
	return wavFromPcm(bytes, rate);
}

/** A Google error as a failure kind (exported for tests). */
export function ttsFailureOf(status: number, text: string, retryAfter: string | null, secrets: readonly string[], now: Date): Extract<GeminiTtsResult, { ok: false }> {
	const error = parseGoogleError(status, text, retryAfter, secrets, now);
	const detail = error.message ? `: ${error.message}` : "";
	if (status === 429) {
		if (isDailyQuota(error)) return { ok: false, kind: "quota", message: `Google's daily free-tier limit for read-aloud is used up (HTTP 429)${detail}`, retryAfterMs: minutesUntilPacificMidnight(now) * 60_000 };
		const wait = error.retryAfterMs ?? error.retryDelayMs;
		return { ok: false, kind: "rate_limit", message: `Google's per-minute limit for read-aloud is reached (HTTP 429)${detail}`, ...(wait !== undefined ? { retryAfterMs: wait } : {}) };
	}
	if (error.reasons.includes("API_KEY_INVALID") || (status === 400 && /api key not valid/i.test(error.message))) return { ok: false, kind: "auth", message: `Google refused the key (HTTP ${status})${detail}` };
	if (status === 401 || status === 403) return { ok: false, kind: "auth", message: `Google refused the key (HTTP ${status})${detail}` };
	if (status === 402) return { ok: false, kind: "quota", message: `Google refused the request: the project's prepaid credit is used up (HTTP 402)${detail}` };
	if (status === 408 || status === 504) return { ok: false, kind: "timeout", message: `${GEMINI_TTS_NAME} timed out (HTTP ${status})${detail}` };
	if (status >= 500) return { ok: false, kind: "unavailable", message: `${GEMINI_TTS_NAME} failed (HTTP ${status})${detail}` };
	return { ok: false, kind: "bad_request", message: `${GEMINI_TTS_NAME} refused the request (HTTP ${status})${detail}` };
}

/** Synthesize `text`; never throws (an abort by the caller answers `timeout`). Nothing is retried: a fallback is cheaper. */
export async function synthesizeGeminiSpeech(request: GeminiTtsRequest): Promise<GeminiTtsResult> {
	const apiKey = request.apiKey.trim();
	const keyProblem = storedKeyProblem(apiKey);
	if (!apiKey || keyProblem) return { ok: false, kind: "no_key", message: keyProblem ?? "No Google AI Studio key is saved" };
	const secrets = [apiKey];
	const baseUrl = (request.baseUrl ?? GEMINI_BASE_URL).replace(/\/+$/, "");
	const doFetch = request.fetch ?? fetch;
	const now = request.now ?? (() => new Date());
	const timeoutMs = request.timeoutMs ?? GEMINI_TTS_TIMEOUT_MS;
	const controller = new AbortController();
	const onAbort = () => controller.abort(request.signal?.reason);
	if (request.signal?.aborted) onAbort();
	else request.signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
	try {
		const response = await doFetch(`${baseUrl}/v1beta/interactions`, {
			method: "POST",
			headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
			body: JSON.stringify(geminiTtsBody(request.model, request.voice, request.text, request.style)),
			redirect: "manual",
			signal: controller.signal,
		});
		if (response.status >= 300 && response.status < 400) {
			await response.body?.cancel().catch(() => {});
			return { ok: false, kind: "bad_response", message: `${GEMINI_TTS_NAME} answered with a redirect (HTTP ${response.status})` };
		}
		if (!response.ok) {
			const text = await readCapped(response, controller.signal, ERROR_BODY_BYTES, GEMINI_TTS_NAME).catch(() => "");
			return ttsFailureOf(response.status, text, response.headers.get("retry-after"), secrets, now());
		}
		const text = await readCapped(response, controller.signal, GEMINI_TTS_MAX_RESPONSE_BYTES, GEMINI_TTS_NAME);
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			return { ok: false, kind: "bad_response", message: `${GEMINI_TTS_NAME} returned invalid JSON` };
		}
		return { ok: true, wav: wavFromInteraction(body) };
	} catch (error) {
		if (controller.signal.aborted) return { ok: false, kind: "timeout", message: request.signal?.aborted ? "The read was cancelled" : `${GEMINI_TTS_NAME} did not answer within ${Math.round(timeoutMs / 1000)} s` };
		if (error instanceof ConverterError) return { ok: false, kind: "bad_response", message: serviceMessage(error.message, secrets) };
		return { ok: false, kind: "offline", message: `Could not reach Google (${serviceMessage(error instanceof Error ? error.message : String(error), secrets)})` };
	} finally {
		clearTimeout(timer);
		request.signal?.removeEventListener("abort", onAbort);
	}
}
