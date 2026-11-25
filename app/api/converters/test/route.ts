/**
 * POST /api/converters/test { id } (fork addition, 2026-11-25): runs the converter test
 * (src/server/converters/validator.ts) on one converter with its saved URL and key: the bundled two-page PDF is
 * sent to that converter (to its service, for a remote one) and the answer is checked page by page. Answers the
 * report; never falls back to the built-in reader. Closing the request aborts the conversion; the whole test has a
 * two-minute deadline of its own. The body is read up to 4 KB.
 */
import { CustomBodyLimitError, noteAppRequest, readBoundedJson, testConverter } from "@/src/server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_BODY_BYTES = 4 * 1024;

export async function POST(request: Request) {
	noteAppRequest(request.url);
	let body: { id?: unknown } | null = null;
	try {
		body = (await readBoundedJson(request, MAX_BODY_BYTES)) as { id?: unknown } | null;
	} catch (error) {
		if (error instanceof CustomBodyLimitError) return Response.json({ error: "The request is too large" }, { status: 413, headers: NO_STORE });
	}
	if (!body || typeof body !== "object" || typeof body.id !== "string" || !body.id) return Response.json({ error: "id must be a converter id" }, { status: 400, headers: NO_STORE });
	try {
		const result = await testConverter(body.id, request.signal);
		if (!result.ok) return Response.json({ error: result.error }, { status: result.status ?? 400, headers: NO_STORE });
		return Response.json(result.value, { headers: NO_STORE });
	} catch {
		if (request.signal.aborted) return new Response(null, { status: 499 });
		return Response.json({ error: "The test could not run" }, { status: 500, headers: NO_STORE });
	}
}
