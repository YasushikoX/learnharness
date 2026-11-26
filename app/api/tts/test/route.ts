/**
 * POST /api/tts/test (WP10, 2026-11-26): Settings → Read aloud's Test. One real Gemini TTS call (an English sentence,
 * the saved model, the default voice; not answered from the cache). → { ok: true } and the engine is marked verified,
 * or { ok: false, kind, error }.
 */
import { noteAppRequest, ttsService, ttsTestInput } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	noteAppRequest(request.url);
	const result = await ttsService().speak(ttsTestInput());
	return Response.json(result.ok ? { ok: true } : { ok: false, kind: result.kind, error: result.message }, { headers: { "Cache-Control": "no-store" } });
}
