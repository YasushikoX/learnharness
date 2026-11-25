import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import type { LhMessage } from "../src/core/index.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-server-timing-"));
process.env.LH_DATA_DIR = root;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");

const chatRoute = await import("../app/api/chats/[id]/route.ts");
const coursesRoute = await import("../app/api/courses/route.ts");
const courseRoute = await import("../app/api/courses/[id]/route.ts");
const todayRoute = await import("../app/api/today/route.ts");
const impactRoute = await import("../app/api/courses/deletion-impact/route.ts");
const ratingRoute = await import("../app/api/chats/[id]/rating-changes/route.ts");
const lessonRoute = await import("../app/api/chats/[id]/lesson-result/route.ts");
const chatCourseRoute = await import("../app/api/chats/[id]/course/route.ts");
const { stores } = await import("../src/server/stores.ts");
const courses = await import("../src/server/courses.ts");

const SERVER_TIMING_RE = /^[a-z0-9_-]+;dur=\d+\.\d+(, [a-z0-9_-]+;dur=\d+\.\d+)*$/;

function assertValidTiming(res: Response, forbidden: string[]) {
	const header = res.headers.get("server-timing");
	assert.ok(header, "response must carry Server-Timing header");
	assert.match(header, SERVER_TIMING_RE, `unexpected Server-Timing format: ${header}`);
	assert.ok(header.includes("total;dur="), `Server-Timing must include total: ${header}`);
	assert.ok(!header.includes("desc="), `Server-Timing must not carry descriptions/content: ${header}`);
	for (const secret of forbidden) {
		assert.ok(!header.includes(secret), `Server-Timing leaked "${secret}": ${header}`);
	}
}

beforeEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}\n");
	courses.clearCourseEvidenceCache();
});

after(() => {
	courses.clearCourseEvidenceCache();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("Server-Timing headers and lightweight chat views", () => {
	it("sets durations-only Server-Timing on chat record and course routes without leaking content", async () => {
		const secretCourseTitle = "SecretCourseTitleXYZ";
		const secretChatTitle = "SecretChatTitleABC";
		const secretTranscript = "SecretTranscriptSentence999";

		const course = stores.courseStore.createCourse(secretCourseTitle);
		stores.courseStore.updateCourse(course.id, {
			status: "draft",
			draft: {
				createdAt: "2026-10-01T00:00:00Z",
				summary: "Draft",
				skills: [{ key: "s1", name: "SecretSkillName", statement: "Do it", requires: [], restsOn: [] }],
			},
		});
		const approved = courses.approveCourse(course.id);
		assert.ok(approved.ok);
		const skillId = approved.value.skills[0]!;

		const learn = stores.chatStore.createChat(secretChatTitle, undefined, { courseId: course.id, mode: "learn", skillIds: [skillId] });
		stores.chatStore.saveSettings(learn.id, { language: "nb", pace: "crash" });
		stores.chatStore.saveMessages(learn.id, [
			{ id: "u1", role: "user", content: secretTranscript, timestamp: 1000 } as unknown as LhMessage,
		]);

		const practice = stores.chatStore.createChat("Practice Secret", "practice", { courseId: course.id, mode: "practice", skillIds: [skillId] });
		const forbidden = [secretCourseTitle, secretChatTitle, secretTranscript, course.id, learn.id, practice.id, skillId];

		// GET /api/chats/[id] (full, stats, settings, coverage, 404)
		const fullRes = await chatRoute.GET(new Request(`http://localhost/api/chats/${learn.id}`), { params: Promise.resolve({ id: learn.id }) });
		assert.equal(fullRes.status, 200);
		assertValidTiming(fullRes, forbidden);

		const statsRes = await chatRoute.GET(new Request(`http://localhost/api/chats/${learn.id}?view=stats`), { params: Promise.resolve({ id: learn.id }) });
		assert.equal(statsRes.status, 200);
		assertValidTiming(statsRes, forbidden);

		const settingsRes = await chatRoute.GET(new Request(`http://localhost/api/chats/${learn.id}?view=settings`), { params: Promise.resolve({ id: learn.id }) });
		assert.equal(settingsRes.status, 200);
		assertValidTiming(settingsRes, forbidden);
		const settingsBody = (await settingsRes.json()) as Record<string, unknown>;
		assert.equal("messages" in settingsBody, false, "?view=settings must not return transcript messages");
		assert.deepEqual(settingsBody.settings, { language: "nb", pace: "crash" });
		assert.deepEqual(settingsBody.course, { courseId: course.id, mode: "learn", skillIds: [skillId] });

		const covRes = await chatRoute.GET(new Request(`http://localhost/api/chats/${learn.id}?view=coverage`), { params: Promise.resolve({ id: learn.id }) });
		assert.equal(covRes.status, 200);
		assertValidTiming(covRes, forbidden);
		const covBody = (await covRes.json()) as Record<string, unknown>;
		assert.equal("messages" in covBody, false, "?view=coverage must not return transcript messages");
		assert.ok(covBody.coverage && typeof covBody.coverage === "object");

		const missingRes = await chatRoute.GET(new Request("http://localhost/api/chats/missing?view=settings"), { params: Promise.resolve({ id: "missing" }) });
		assert.equal(missingRes.status, 404);
		assertValidTiming(missingRes, forbidden);

		// Course routes
		const coursesRes = await coursesRoute.GET();
		assert.equal(coursesRes.status, 200);
		assertValidTiming(coursesRes, forbidden);

		const courseViewRes = await courseRoute.GET(new Request(`http://localhost/api/courses/${course.id}`), { params: Promise.resolve({ id: course.id }) });
		assert.equal(courseViewRes.status, 200);
		assertValidTiming(courseViewRes, forbidden);

		const todayRes = await todayRoute.GET();
		assert.equal(todayRes.status, 200);
		assertValidTiming(todayRes, forbidden);

		const impactRes = await impactRoute.POST(
			new Request("http://localhost/api/courses/deletion-impact", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chatIds: [learn.id, practice.id] }),
			}),
		);
		assert.equal(impactRes.status, 200);
		assertValidTiming(impactRes, forbidden);

		const ratingsRes = await ratingRoute.GET(new Request(`http://localhost/api/chats/${practice.id}/rating-changes`), { params: Promise.resolve({ id: practice.id }) });
		assert.equal(ratingsRes.status, 200);
		assertValidTiming(ratingsRes, forbidden);

		const lessonRes = await lessonRoute.GET(new Request(`http://localhost/api/chats/${learn.id}/lesson-result`), { params: Promise.resolve({ id: learn.id }) });
		assert.equal(lessonRes.status, 200);
		assertValidTiming(lessonRes, forbidden);

		const chatCourseRes = await chatCourseRoute.GET(new Request(`http://localhost/api/chats/${practice.id}/course`), { params: Promise.resolve({ id: practice.id }) });
		assert.equal(chatCourseRes.status, 200);
		assertValidTiming(chatCourseRes, forbidden);
	});
});
