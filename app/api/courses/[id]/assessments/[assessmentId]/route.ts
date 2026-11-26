/**
 * One assessment (WP8, src/server/assessments.ts).
 *
 *   PATCH  { kind?, title?, date? (null clears), topics?, skillIds? } → the changed assessment. The old exam date
 *          ("exam-date") becomes a real assessment and the class's examDate is cleared. A learner's edit wins over a later
 *          syllabus pass.
 *   DELETE → { deleted: true } (a tombstone, so the deletion survives a sync; "exam-date" clears the exam date)
 *   400 a bad field · 404 unknown course or assessment · 413 a body over 16 KB
 */
import { CustomBodyLimitError, deleteAssessment, readBoundedJson, updateAssessment } from "@/src/server";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; assessmentId: string }> }) {
	const { id, assessmentId } = await params;
	let body: unknown;
	try {
		body = await readBoundedJson(req, MAX_BODY_BYTES);
	} catch (error) {
		if (error instanceof CustomBodyLimitError) return Response.json({ error: "The request is too large" }, { status: 413 });
		return Response.json({ error: "The body must be JSON" }, { status: 400 });
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "The body must be an object" }, { status: 400 });
	const changed = updateAssessment(id, assessmentId, body as Record<string, unknown>, "manual");
	if (!changed.ok) return Response.json({ error: changed.error }, { status: changed.status });
	return Response.json({ assessment: changed.value.after });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; assessmentId: string }> }) {
	const { id, assessmentId } = await params;
	const out = deleteAssessment(id, assessmentId);
	if (!out.ok) return Response.json({ error: out.error }, { status: out.status });
	return Response.json({ deleted: true });
}
