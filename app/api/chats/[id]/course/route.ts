/**
 * A review or practice course session's course and skills — the source of
 * the "Learn <skill>" buttons on a concluded problem (practice-cards.tsx).
 *
 *   GET → { courseId, skills: [{ id, name }] }
 *   404 when the chat is unknown or is not a review/practice course session.
 */
import { courseSessionSkillNames, startServerTiming } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const timing = startServerTiming();
	const { id } = await params;
	const found = timing.measure("course", () => courseSessionSkillNames(id));
	if (!found) return timing.json({ error: "Not a review or practice course session" }, { status: 404 });
	return timing.json(found);
}
