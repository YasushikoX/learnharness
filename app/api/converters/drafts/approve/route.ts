/**
 * POST /api/converters/drafts/approve { id, shown, acknowledged? } (fork addition, 2026-11-25): the draft becomes an
 * ordinary custom profile (its URL and key move with it) → { id: "custom:<id>", overview }. Refused (409) unless
 * `shown` names the draft as it is now, its last Test passed for exactly this profile, URL and key, and, when fixed
 * values name an address, `acknowledged` is true. Approval never selects the converter: "Use for new PDFs" is a
 * separate step. The body is read up to 4 KB.
 */
import { CustomBodyLimitError, approveConverterDraft, noteAppRequest, parseApproveDraftBody, readBoundedJson } from "@/src/server";

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
	const parsed = parseApproveDraftBody(body);
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
	try {
		const result = approveConverterDraft(parsed.value);
		if (!result.ok) return Response.json({ error: result.error, errors: result.errors ?? [] }, { status: result.status ?? 400, headers: NO_STORE });
		return Response.json(result.value, { headers: NO_STORE });
	} catch {
		return Response.json({ error: "The draft could not be approved" }, { status: 500, headers: NO_STORE });
	}
}
