/**
 * The sidebar's Today list (src/server/courses.ts todayCourses, owner 2026-11-13).
 *
 *   GET → { courses: TodayCourse[] }: the active courses with something to do, soonest exam first, each with its due
 *         reviews and the lessons to take today. "Today" is the learner's (the X-LH-Time-Zone header; WP9 review 1,
 *         finding 10).
 */
import { requestTimeZone, startServerTiming, todayCourses } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(req?: Request) {
	const timing = startServerTiming();
	const courses = timing.measure("today", () => todayCourses(req ? requestTimeZone(req) : undefined));
	return timing.json({ courses });
}
