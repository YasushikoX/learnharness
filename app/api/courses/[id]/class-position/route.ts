/**
 * How far the CLASS has got (WP9, src/server/lectures.ts setClassPosition; core/lectures.ts classPositionOf).
 *
 *   PUT { lectureId?, coveredThrough?, note? } → { classPosition } (what the learner says; it holds until a lecture dated
 *       after that day has passed)
 *   PUT null, or DELETE → { classPosition: null } (back to the lecture dates)
 *   400 a bad field · 404 unknown course · 413 a body over 4 KB
 */
import { CustomBodyLimitError, readBoundedJson, setClassPosition } from "@/src/server";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4 * 1024;

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	let body: unknown;
	try {
		body = await readBoundedJson(req, MAX_BODY_BYTES);
	} catch (error) {
		if (error instanceof CustomBodyLimitError) return Response.json({ error: "The request is too large" }, { status: 413 });
		return Response.json({ error: "The body must be JSON" }, { status: 400 });
	}
	if (body !== null && (typeof body !== "object" || Array.isArray(body))) return Response.json({ error: "The body must be an object or null" }, { status: 400 });
	const out = setClassPosition(id, body as Record<string, unknown> | null);
	if (!out.ok) return Response.json({ error: out.error }, { status: out.status });
	return Response.json({ classPosition: out.value.after });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const out = setClassPosition(id, null);
	if (!out.ok) return Response.json({ error: out.error }, { status: out.status });
	return Response.json({ classPosition: null });
}
