/**
 * GET /api/tts (WP10, 2026-11-26): what Settings → Read aloud shows about Google voices: where the AI Studio key comes
 * from (the PDF converter's own key, the Google provider's, or none; never the key), whether a real call has succeeded,
 * the models, the voices and the defaults. The key itself is saved through PUT /api/converters { id: "gemini", apiKey },
 * the same place the PDF converter keeps it.
 */
import { noteAppRequest, ttsService } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(request?: Request) {
	if (request) noteAppRequest(request.url);
	return Response.json(ttsService().status(), { headers: { "Cache-Control": "no-store" } });
}
