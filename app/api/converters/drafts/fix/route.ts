/**
 * POST /api/converters/drafts/fix { id } (fork addition, 2026-11-25): "Ask AI to fix". ONE model call with the
 * draft's previous profile and the server's own record of its last failed Test, redacted (no key, no service
 * address, no page text, the service's answers reduced to their shape with strings cut short), or the validator's
 * errors for a draft that is not valid. The body takes only the id: no report or text from the client reaches the
 * model. Nothing is fetched. Closing the request aborts the call. The body is read up to 4 KB.
 */
import { CustomBodyLimitError, fixConverterDraft, noteAppRequest, readBoundedJson } from "@/src/server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_BODY_BYTES = 4 * 1024;

export async function POST(request: Request) {
	noteAppRequest(request.url);
	let body: unknown = null;
	try {
		body = await readBoundedJson(request, MAX_BODY_BYTES);
	} catch (error) {
		if (error instanceof CustomBodyLimitError) return Response.json({ error: "The request is too large" }, { status: 413, headers: NO_STORE });
	}
	const raw = body as { id?: unknown } | null;
	if (!raw || typeof raw !== "object" || Object.keys(raw).some((k) => k !== "id") || typeof raw.id !== "string") return Response.json({ error: "Send { id }" }, { status: 400, headers: NO_STORE });
	try {
		const result = await fixConverterDraft(raw.id, request.signal);
		if (!result.ok) return Response.json({ error: result.error }, { status: result.status ?? 400, headers: NO_STORE });
		return Response.json(result.value, { headers: NO_STORE });
	} catch (error) {
		if (request.signal.aborted) return new Response(null, { status: 499 });
		return Response.json({ error: `The fix could not be written: ${String((error as Error)?.message ?? error).slice(0, 300)}` }, { status: 502, headers: NO_STORE });
	}
}
