/**
 * One course (fork addition — docs/courses.md §5).
 *
 *   GET    → CourseView + { drafting } — the record, every skill's box and
 *            state, the route (review / next up / locked / known), sessions
 *   PATCH  { title? , note? , language? , pace? , examDate? , weights? , folder? } → rename, set the time note
 *            ("exam Thursday, 4 concepts"; blank clears it), set the course's
 *            language (what its next draft and its sessions are written in),
 *            its default pace (null clears it: the global default), its exam
 *            date ("2026-12-12"; null clears it), and/or skills' exam weights
 *            ({ skillId: 0-3 | null }; a hand edit survives a re-weigh), and/or its
 *            sidebar folder (a name, 1 to 60 characters; null or blank takes it out)
 *   DELETE → the record and its material; its skills stay in the graph
 */
import { isLessonLanguage, type Pace } from "@/src/core";
import {
	courseDrafting,
	courseView,
	courseWeighing,
	deleteCourse,
	parseExamDateField,
	parseFolderField,
	parsePaceField,
	parsePaceNoteField,
	parseTitleField,
	parseWeightsField,
	renameCourse,
	requestTimeZone,
	setCourseExamDate,
	setCourseFolder,
	setCourseLanguage,
	setCourseNote,
	setCoursePace,
	setCourseSkillWeights,
	startServerTiming,
} from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const timing = startServerTiming();
	const { id } = await params;
	// every "today" of the page (the class position, the next assessment) is the learner's (WP9 review 1, finding 10)
	const timeZone = requestTimeZone(req);
	const view = timing.measure("course", () => courseView(id, timeZone ? { timeZone } : {}));
	if (!view) return timing.json({ error: "Unknown course" }, { status: 404 });
	return timing.json({ ...view, drafting: courseDrafting(id), weighing: courseWeighing(id) });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as { title?: unknown; note?: unknown; language?: unknown; pace?: unknown; examDate?: unknown; weights?: unknown; folder?: unknown } | null;
	const hasNote = body?.note !== undefined;
	const hasLanguage = body?.language !== undefined;
	const hasPace = body?.pace !== undefined;
	const hasExamDate = body?.examDate !== undefined;
	const hasWeights = body?.weights !== undefined;
	const hasFolder = body?.folder !== undefined;
	// A body with none of the other fields keeps the original rejection (a rename needs a title).
	if (body?.title !== undefined || (!hasNote && !hasLanguage && !hasPace && !hasExamDate && !hasWeights && !hasFolder)) {
		// the same check Short question's class_update makes (WP9 review 1, finding 14)
		const parsed = parseTitleField(body?.title);
		if (!parsed.ok) {
			return Response.json({ error: parsed.error }, { status: 400 });
		}
	}
	let note: string | undefined;
	if (hasNote) {
		const parsed = parsePaceNoteField(body?.note);
		if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
		note = parsed.note;
	}
	if (hasLanguage && !isLessonLanguage(body?.language)) {
		return Response.json({ error: "Unsupported language" }, { status: 400 });
	}
	// pace: a pace sets the course's default; null clears it (back to the global default)
	let pace: Pace | undefined;
	if (hasPace && body?.pace !== null) {
		const parsed = parsePaceField(body?.pace);
		if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
		pace = parsed.pace;
	}
	let examDate: string | undefined;
	if (hasExamDate) {
		const parsed = parseExamDateField(body?.examDate);
		if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
		examDate = parsed.date;
	}
	let folder: string | undefined;
	if (hasFolder) {
		const parsed = parseFolderField(body?.folder);
		if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
		folder = parsed.folder;
	}
	let weights: Record<string, number | null> | undefined;
	if (hasWeights) {
		const parsed = parseWeightsField(body?.weights);
		if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
		weights = parsed.weights;
	}
	let course = null;
	if (typeof body?.title === "string") course = renameCourse(id, body.title);
	if (hasNote && (typeof body?.title !== "string" || course)) course = setCourseNote(id, note);
	if (isLessonLanguage(body?.language) && (typeof body?.title !== "string" || course)) course = setCourseLanguage(id, body.language);
	if (hasPace && (typeof body?.title !== "string" || course)) course = setCoursePace(id, pace);
	if (hasExamDate && (typeof body?.title !== "string" || course)) course = setCourseExamDate(id, examDate);
	if (hasFolder && (typeof body?.title !== "string" || course)) course = setCourseFolder(id, folder);
	if (weights) {
		const set = setCourseSkillWeights(id, weights);
		if (!set.ok) return Response.json({ error: set.error }, { status: set.status });
		course = set.value;
	}
	return course
		? Response.json({
				title: course.title,
				...(course.note ? { note: course.note } : {}),
				...(course.language ? { language: course.language } : {}),
				...(course.pace ? { pace: course.pace } : {}),
				...(course.examDate ? { examDate: course.examDate } : {}),
				...(course.folder ? { folder: course.folder } : {}),
			})
		: Response.json({ error: "Unknown course" }, { status: 404 });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return deleteCourse(id) ? Response.json({ ok: true }) : Response.json({ error: "Unknown course" }, { status: 404 });
}
