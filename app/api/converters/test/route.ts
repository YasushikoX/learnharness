/**
 * POST /api/converters/test { id } (fork addition, 2026-11-25): runs the converter test
 * (src/server/converters/validator.ts) on one converter with its saved URL and key: the bundled two-page PDF is
 * sent to that converter (to its service, for a remote one) and the answer is checked page by page. Answers the
 * report; never falls back to the built-in reader. Closing the request aborts the conversion.
 */
import { testConverter } from "@/src/server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
	if (!body || typeof body.id !== "string" || !body.id) return Response.json({ error: "id must be a converter id" }, { status: 400, headers: NO_STORE });
	try {
		const result = await testConverter(body.id, request.signal);
		if (!result.ok) return Response.json({ error: result.error }, { status: result.status ?? 400, headers: NO_STORE });
		return Response.json(result.value, { headers: NO_STORE });
	} catch {
		if (request.signal.aborted) return new Response(null, { status: 499 });
		return Response.json({ error: "The test could not run" }, { status: 500, headers: NO_STORE });
	}
}
