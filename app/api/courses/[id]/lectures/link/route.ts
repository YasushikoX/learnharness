/**
 * "Place skills again" (WP9, src/server/lectures.ts startLectureLinking; agent/subagents/lecture-linker.ts).
 *
 *   POST → starts the "link skills to lectures" step in the background and answers { linking: true } at once (the draft's
 *          cites first, then one model pass for what they did not place). A lecture whose skills the learner set is never
 *          changed.
 *   404 unknown course · 409 no skill map yet, or already running
 */
import { startLectureLinking } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const started = startLectureLinking(id);
	if (!started.ok) return Response.json({ error: started.error }, { status: started.status });
	return Response.json({ linking: true });
}
