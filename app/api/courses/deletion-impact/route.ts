/**
 * What deleting some sessions takes from the courses (merge review finding 1): the delete dialogs ask before they
 * confirm, because skill progress is derived from the course sessions' transcripts and goes with them in either mode.
 *
 *   POST { chatIds: string[] } → CourseDeletionImpact { sessions, courses: [{ id, title, sessions }], skills }
 *   400 when chatIds is not an array of strings.
 */
import { courseDeletionImpact, startServerTiming } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
	const timing = startServerTiming();
	const body = (await req.json().catch(() => null)) as { chatIds?: unknown } | null;
	const ids = body?.chatIds;
	if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
		return timing.json({ error: "chatIds must be an array of session ids" }, { status: 400 });
	}
	const impact = timing.measure("impact", () => courseDeletionImpact(ids));
	return timing.json(impact);
}
