/**
 * The Short question change cards' state (WP8, src/server/assessments.ts classChangeStatuses).
 *
 *   GET → { [toolCallId]: "applied" | "changed" }: applied = Undo is offered; changed = undone or changed since
 */
import { classChangeStatuses } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return Response.json(classChangeStatuses(id));
}
