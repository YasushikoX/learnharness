/**
 * Your own PDF converter profiles (fork addition, 2026-11-25; src/server/converters/custom-profiles.ts).
 *
 *   POST { profile }   profile: the JSON text or the parsed object. Validated (core/http-converter-spec.ts) and
 *                      stored as <dataDir>/converters/<id>.json, replacing one with the same id → { id, replaced,
 *                      overview }; 400 { error, errors } when it is not valid (a profile may not name its own
 *                      service address: that is entered in Settings). Profiles are data; nothing in them runs.
 *                      The body is refused before it is buffered when its Content-Length is over the limit, and
 *                      read with a byte limit otherwise (413).
 *   DELETE ?id=custom:<id>   removes the file, its key and its URL; a selected profile falls back to the built-in reader.
 */
import { CustomBodyLimitError, deleteConverterProfile, importConverterProfile, noteAppRequest, readBoundedJson } from "@/src/server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
/** The request body in bytes: a 64 KB profile, JSON-escaped inside { profile } (the profile itself is capped by the validator). */
const MAX_BODY_BYTES = 256 * 1024;

export async function POST(request: Request) {
	noteAppRequest(request.url);
	let body: { profile?: unknown } | null = null;
	try {
		body = (await readBoundedJson(request, MAX_BODY_BYTES)) as { profile?: unknown } | null;
	} catch (error) {
		if (error instanceof CustomBodyLimitError) return Response.json({ error: "The profile is too large", errors: [] }, { status: 413, headers: NO_STORE });
		body = null;
	}
	if (!body || typeof body !== "object" || body.profile === undefined) return Response.json({ error: "Send { profile }", errors: [] }, { status: 400, headers: NO_STORE });
	const result = importConverterProfile(body.profile);
	if (!result.ok) return Response.json({ error: result.error, errors: "errors" in result ? result.errors : [] }, { status: result.status ?? 400, headers: NO_STORE });
	return Response.json(result.value, { headers: NO_STORE });
}

export async function DELETE(request: Request) {
	noteAppRequest(request.url);
	const id = new URL(request.url).searchParams.get("id") ?? "";
	try {
		const result = deleteConverterProfile(id);
		if (!result.ok) return Response.json({ error: result.error }, { status: result.status ?? 400, headers: NO_STORE });
		return Response.json(result.value, { headers: NO_STORE });
	} catch {
		return Response.json({ error: "The profile could not be removed" }, { status: 500, headers: NO_STORE });
	}
}
