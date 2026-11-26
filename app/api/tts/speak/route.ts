/**
 * POST /api/tts/speak (WP10, 2026-11-26; src/server/tts/service.ts): read text aloud with a Google voice.
 *
 *   { text, language: "en"|"nb", voice?, model?, prefetch? }
 *     → 200 audio/wav (X-TTS-Cache: hit|miss), or with `prefetch` 204 once the audio is cached;
 *     → a JSON { error, kind, retryAfterMs? } when Google cannot read it (kind: no_key, quota, rate_limit, auth,
 *       offline, timeout, bad_request, bad_response, unavailable): the renderer then reads with system voices.
 *
 * The AI Studio key stays on the server. The body is read up to 16 KB and the text is at most GOOGLE_TTS_MAX_TEXT_CHARS.
 */
import { GOOGLE_TTS_MAX_TEXT_CHARS, isLessonLanguage, type GoogleTtsFailure } from "@/src/core";
import { CustomBodyLimitError, readBoundedJson, ttsService } from "@/src/server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_BODY_BYTES = 16 * 1024;

const STATUS: Readonly<Record<GoogleTtsFailure, number>> = {
	no_key: 409,
	quota: 429,
	rate_limit: 429,
	auth: 502,
	offline: 503,
	unavailable: 503,
	timeout: 504,
	bad_request: 502,
	bad_response: 502,
};

export async function POST(request: Request) {
	let body: Record<string, unknown> | null = null;
	try {
		body = (await readBoundedJson(request, MAX_BODY_BYTES)) as Record<string, unknown> | null;
	} catch (error) {
		if (error instanceof CustomBodyLimitError) return Response.json({ error: "The request is too large" }, { status: 413, headers: NO_STORE });
	}
	if (!body || typeof body !== "object") return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: NO_STORE });
	const { text, language, voice, model, prefetch } = body;
	if (typeof text !== "string" || !text.trim() || text.length > GOOGLE_TTS_MAX_TEXT_CHARS) {
		return Response.json({ error: `text must be 1–${GOOGLE_TTS_MAX_TEXT_CHARS} characters` }, { status: 400, headers: NO_STORE });
	}
	if (!isLessonLanguage(language)) return Response.json({ error: "language must be en or nb" }, { status: 400, headers: NO_STORE });
	if ((voice !== undefined && typeof voice !== "string") || (model !== undefined && typeof model !== "string")) {
		return Response.json({ error: "voice and model must be strings" }, { status: 400, headers: NO_STORE });
	}
	const result = await ttsService().speak({ text, language, ...(voice ? { voice } : {}), ...(model ? { model } : {}) });
	if (!result.ok) {
		return Response.json(
			{ error: result.message, kind: result.kind, ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}) },
			{ status: STATUS[result.kind], headers: NO_STORE },
		);
	}
	const cache = result.cached ? "hit" : "miss";
	if (prefetch === true) return new Response(null, { status: 204, headers: { ...NO_STORE, "X-TTS-Cache": cache } });
	return new Response(new Uint8Array(result.wav), {
		headers: { ...NO_STORE, "Content-Type": "audio/wav", "Content-Length": String(result.wav.byteLength), "X-TTS-Cache": cache },
	});
}
