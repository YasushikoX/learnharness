/**
 * POST /api/converters/drafts/test { id } (fork addition, 2026-11-25): the converter test (the bundled two-page PDF
 * and the three-page PDF with a blank middle page) on a draft, sent only to the service URL the user saved for it,
 * with its key. Answers the draft with its report; a pass is kept (in memory) only for exactly the profile, URL and
 * key tested. Closing the request aborts it; the whole test has its two-minute deadline. The body is read up to 4 KB.
 */
import { CustomBodyLimitError, noteAppRequest, readBoundedJson, testConverterDraft } from "@/src/server";

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
		const result = await testConverterDraft(raw.id, request.signal);
		if (!result.ok) return Response.json({ error: result.error }, { status: result.status ?? 400, headers: NO_STORE });
		return Response.json(result.value, { headers: NO_STORE });
	} catch {
		if (request.signal.aborted) return new Response(null, { status: 499 });
		return Response.json({ error: "The test could not run" }, { status: 500, headers: NO_STORE });
	}
}
