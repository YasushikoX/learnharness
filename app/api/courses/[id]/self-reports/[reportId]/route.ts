/**
 * One self-report (WP8, src/server/assessments.ts): "you said you know this" removed from a skill's detail.
 *
 *   DELETE → { deleted: true } (a tombstone, so the removal survives a sync)
 *   404 unknown course or report
 */
import { deleteSelfReport } from "@/src/server";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; reportId: string }> }) {
	const { id, reportId } = await params;
	const out = deleteSelfReport(id, reportId);
	if (!out.ok) return Response.json({ error: out.error }, { status: out.status });
	return Response.json({ deleted: true });
}
