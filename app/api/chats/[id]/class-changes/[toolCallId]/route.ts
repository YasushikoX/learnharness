/**
 * Undo one Short question change card (WP8, src/server/assessments.ts undoClassChange). The change is read from the chat
 * record, never from the request.
 *
 *   POST → { status: "undone" }
 *   404 no such change · 409 already undone or changed since (Undo never overwrites a later edit)
 */
import { undoClassChange } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string; toolCallId: string }> }) {
	const { id, toolCallId } = await params;
	const out = undoClassChange(id, toolCallId);
	if (!out.ok) return Response.json({ error: out.error }, { status: out.status });
	return Response.json(out.value);
}
