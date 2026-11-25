/**
 * POST — approve the pending draft: its skills are written to the graph's
 * skill ledger (reused skills link-append) and become the course's skill
 * set (fork addition — docs/courses.md §1.2). Body (optional, WP5):
 * `{ leaveUnassigned: true }` — the student's explicit "leave N terms
 * unassigned": core terms of the class glossary the draft maps to no skill
 * become excluded ("left out at approval") instead of refusing approval.
 */
import { approveCourse } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as { leaveUnassigned?: unknown } | null;
	const result = approveCourse(id, { leaveUnassigned: body?.leaveUnassigned === true });
	return result.ok ? Response.json({ course: result.value }) : Response.json({ error: result.error }, { status: result.status });
}
