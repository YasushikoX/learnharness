/**
 * One lecture (WP9, src/server/lectures.ts).
 *
 *   PATCH  { n? (null clears), title?, date? (null clears), topics?, materialIds?, skillIds? } → the changed lecture. A
 *          lecture read from the file names ("lf_…") is stored under its id from then on.
 *   DELETE → { deleted: true } (a tombstone: a lecture read from the file names stays removed while the file is there)
 *   400 a bad field · 404 unknown course or lecture · 409 the list is full · 413 a body over 16 KB
 */
import { CustomBodyLimitError, deleteLecture, readBoundedJson, updateLecture } from "@/src/server";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; lectureId: string }> }) {
	const { id, lectureId } = await params;
	let body: unknown;
	try {
		body = await readBoundedJson(req, MAX_BODY_BYTES);
	} catch (error) {
		if (error instanceof CustomBodyLimitError) return Response.json({ error: "The request is too large" }, { status: 413 });
		return Response.json({ error: "The body must be JSON" }, { status: 400 });
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "The body must be an object" }, { status: 400 });
	const changed = updateLecture(id, lectureId, body as Record<string, unknown>, "manual");
	if (!changed.ok) return Response.json({ error: changed.error }, { status: changed.status });
	return Response.json({ lecture: changed.value.after });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; lectureId: string }> }) {
	const { id, lectureId } = await params;
	const out = deleteLecture(id, lectureId);
	if (!out.ok) return Response.json({ error: out.error }, { status: out.status });
	return Response.json({ deleted: true });
}
