/**
 * Your own PDF converter profiles (fork addition, 2026-11-25; src/server/converters/custom-profiles.ts).
 *
 *   POST { profile }   profile: the JSON text or the parsed object. Validated (core/http-converter-spec.ts) and
 *                      stored as <dataDir>/converters/<id>.json, replacing one with the same id → { id, replaced,
 *                      overview }; 400 { error, errors } when it is not valid. Profiles are data; nothing in them runs.
 *   DELETE ?id=custom:<id>   removes the file, its key and its URL; a selected profile falls back to the built-in reader.
 */
import { deleteConverterProfile, importConverterProfile } from "@/src/server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
/** The request body: a 64 KB profile, JSON-escaped inside { profile } (the profile itself is capped by the validator). */
const MAX_BODY_CHARS = 256 * 1024;

export async function POST(request: Request) {
	const text = await request.text().catch(() => "");
	if (text.length > MAX_BODY_CHARS) return Response.json({ error: "The profile is too large", errors: [] }, { status: 413, headers: NO_STORE });
	let body: { profile?: unknown } | null = null;
	try {
		body = JSON.parse(text) as { profile?: unknown };
	} catch {
		body = null;
	}
	if (!body || typeof body !== "object" || body.profile === undefined) return Response.json({ error: "Send { profile }", errors: [] }, { status: 400, headers: NO_STORE });
	const result = importConverterProfile(body.profile);
	if (!result.ok) return Response.json({ error: result.error, errors: "errors" in result ? result.errors : [] }, { status: result.status ?? 400, headers: NO_STORE });
	return Response.json(result.value, { headers: NO_STORE });
}

export async function DELETE(request: Request) {
	const id = new URL(request.url).searchParams.get("id") ?? "";
	try {
		const result = deleteConverterProfile(id);
		if (!result.ok) return Response.json({ error: result.error }, { status: result.status ?? 400, headers: NO_STORE });
		return Response.json(result.value, { headers: NO_STORE });
	} catch {
		return Response.json({ error: "The profile could not be removed" }, { status: 500, headers: NO_STORE });
	}
}
