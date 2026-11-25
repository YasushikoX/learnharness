/**
 * POST — the class's vocabulary coverage (WP5 — docs/courses.md "Vocabulary coverage").
 *
 *   { map: true }                       → start "Map the class's terms" (the planner's mapping-only pass; returns at once)
 *   { target: "approved" | "draft", action, … } → one edit of the approved mapping or of the draft's proposal:
 *       assign { key, skill } · unassign { key, skill } · exclude { key, reason } · link { keys } · unlink { key }
 *       · remove { key } · remap { key, to }   (key: a glossary entry id, a sense key, or an existing item's key)
 */
import { parseCoverageEdit } from "@/src/core";
import { editCourseCoverage, startCourseTermMap } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body) return Response.json({ error: "a JSON body is required" }, { status: 400 });
	if (body.map === true) {
		const started = startCourseTermMap(id);
		return started.ok ? Response.json({ course: started.value }) : Response.json({ error: started.error }, { status: started.status });
	}
	const target = body.target === "draft" ? "draft" : body.target === "approved" ? "approved" : null;
	if (!target) return Response.json({ error: 'target must be "approved" or "draft"' }, { status: 400 });
	const edit = parseCoverageEdit(body);
	if (typeof edit === "string") return Response.json({ error: edit }, { status: 400 });
	const result = editCourseCoverage(id, target, edit);
	return result.ok ? Response.json({ course: result.value }) : Response.json({ error: result.error }, { status: result.status });
}
