/**
 * A class's lecture timeline (WP9, src/server/lectures.ts; docs/courses.md "Lectures and where you stand").
 *
 *   GET  → { lectures } (stored, plus those the class's file names give, in timeline order)
 *   POST { n?, title?, date?, topics?, materialIds?, skillIds? } → the new lecture (source "manual"); skillIds marks its
 *        skills as the learner's (the linking step never changes them)
 *   400 a bad field · 404 unknown course · 409 the list is full · 413 a body over 16 KB
 */
import { classLectures, createLecture, CustomBodyLimitError, readBoundedJson, stores } from "@/src/server";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const course = stores.courseStore.getCourse(id);
	if (!course) return Response.json({ error: "Unknown course" }, { status: 404 });
	return Response.json({ lectures: classLectures(course) });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	let body: unknown;
	try {
		body = await readBoundedJson(req, MAX_BODY_BYTES);
	} catch (error) {
		if (error instanceof CustomBodyLimitError) return Response.json({ error: "The request is too large" }, { status: 413 });
		return Response.json({ error: "The body must be JSON" }, { status: 400 });
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "The body must be an object" }, { status: 400 });
	const made = createLecture(id, body as Record<string, unknown>, "manual");
	if (!made.ok) return Response.json({ error: made.error }, { status: made.status });
	return Response.json({ lecture: made.value.after });
}
