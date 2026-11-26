/**
 * "Find quizzes and exams" (WP8, src/server/assessments.ts startAssessmentFind; agent/subagents/assessment-finder.ts).
 *
 *   POST → starts the syllabus pass in the background and answers { finding: true } at once; the proposal (or the failure)
 *          lands on the course record and announces courses-changed. Nothing is added to the list until the learner
 *          approves (POST ./proposal).
 *   400 no class file · 404 unknown course · 409 already running
 */
import { startAssessmentFind } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const started = startAssessmentFind(id);
	if (!started.ok) return Response.json({ error: started.error }, { status: started.status });
	return Response.json({ finding: true });
}
