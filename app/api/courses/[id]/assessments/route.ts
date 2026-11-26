/**
 * A class's quizzes, exams and assignments (WP8, src/server/assessments.ts; docs/courses.md).
 *
 *   GET  → the Upcoming view: { items, nextId?, finding, error?, proposal?, syllabusHint? } (the old exam date included
 *          as an "Exam" with the id "exam-date")
 *   POST { kind, title, date?, topics?, skillIds? } → the new assessment (source "manual")
 *   400 a bad field · 404 unknown course · 409 the list is full · 413 a body over 16 KB
 */
import { CustomBodyLimitError, createAssessment, readBoundedJson, stores, upcomingView } from "@/src/server";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const course = stores.courseStore.getCourse(id);
	if (!course) return Response.json({ error: "Unknown course" }, { status: 404 });
	return Response.json(upcomingView(course));
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
	const made = createAssessment(id, body as Record<string, unknown>, "manual");
	if (!made.ok) return Response.json({ error: made.error }, { status: made.status });
	return Response.json({ assessment: made.value.after });
}
