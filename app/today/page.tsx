import { TodayPage } from "@/components/today-page";
import { listCourseSummaries, todayCourses } from "@/src/server";

export const dynamic = "force-dynamic";

/** The Today page (owner, 2026-11-16): every course's plan for today. Server-read for the first frame; the client
 *  refetches on events. On a first run (no class at all) it offers New class (UI round 8). */
export default function TodayRoute() {
	return <TodayPage initial={todayCourses()} hasClasses={listCourseSummaries().length > 0} />;
}
