/**
 * The card under a finished course lesson (src/server/courses.ts lessonResult, owner 2026-11-13).
 *
 *   GET → { courseId, skill, understanding, learned, reviewAt, summary, next }
 *   404 when the chat is not a course Learn session.
 */
import { lessonResult, startServerTiming } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const timing = startServerTiming();
	const { id } = await params;
	const result = timing.measure("lesson", () => lessonResult(id));
	if (!result) return timing.json({ error: "Not a course lesson" }, { status: 404 });
	return timing.json(result);
}
