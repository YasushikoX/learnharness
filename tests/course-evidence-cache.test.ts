import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import type { LhMessage } from "../src/core/index.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-evidence-cache-"));
process.env.LH_DATA_DIR = root;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");

const { stores } = await import("../src/server/stores.ts");
const courses = await import("../src/server/courses.ts");
const { PATHS } = await import("../config.ts");

let ts = 1_700_000_000_000;
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function probeMessages(callId: string, skillId: string, grade: "again" | "hard" | "good" | "easy" = "easy"): LhMessage[] {
	const tCall = ts++;
	const tRes = ts++;
	const details = { kind: "quiz", correct: grade !== "again", confidence: 90, placementGrade: { skill: skillId, grade } };
	return [
		{
			id: `a_${tCall}`,
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: "probe", arguments: { skill: skillId } }],
			api: "faux",
			provider: "faux",
			model: "faux",
			stopReason: "toolUse",
			usage,
			timestamp: tCall,
		} as unknown as LhMessage,
		{
			id: `r_${tRes}`,
			role: "toolResult",
			toolCallId: callId,
			toolName: "probe",
			content: [{ type: "text", text: JSON.stringify(details) }],
			details,
			isError: false,
			timestamp: tRes,
		} as unknown as LhMessage,
	];
}

function concludeMessages(
	prefix: string,
	skillId: string,
	outcome: "solved" | "solvedWithHints" | "surrendered",
	grade: "again" | "hard" | "good" | "easy",
): LhMessage[] {
	const poseId = `${prefix}_pose`;
	const concId = `${prefix}_conc`;
	const t1 = ts++;
	const t2 = ts++;
	const t3 = ts++;
	const t4 = ts++;
	const t5 = ts++;
	return [
		{
			id: `${prefix}_pa`,
			role: "assistant",
			content: [{ type: "toolCall", id: poseId, name: "problem", arguments: { statement: `Problem ${prefix}`, solution: "42", skills: [skillId] } }],
			api: "faux",
			provider: "faux",
			model: "faux",
			stopReason: "toolUse",
			usage,
			timestamp: t1,
		} as unknown as LhMessage,
		{
			id: `${prefix}_pr`,
			role: "toolResult",
			toolCallId: poseId,
			toolName: "problem",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: t2,
		} as unknown as LhMessage,
		{
			id: `${prefix}_u`,
			role: "user",
			content: "42",
			timestamp: t3,
		} as unknown as LhMessage,
		{
			id: `${prefix}_ca`,
			role: "assistant",
			content: [{ type: "toolCall", id: concId, name: "conclude", arguments: { outcome } }],
			api: "faux",
			provider: "faux",
			model: "faux",
			stopReason: "toolUse",
			usage,
			timestamp: t4,
		} as unknown as LhMessage,
		{
			id: `${prefix}_cr`,
			role: "toolResult",
			toolCallId: concId,
			toolName: "conclude",
			content: [{ type: "text", text: "done" }],
			details: { grades: [{ skill: skillId, grade }] },
			isError: false,
			timestamp: t5,
		} as unknown as LhMessage,
	];
}

function finishLessonMessages(callId: string, skillId: string, summary: string, grade: "good" | "easy" = "good"): LhMessage[] {
	const t1 = ts++;
	const t2 = ts++;
	return [
		{
			id: `fa_${t1}`,
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: "finish_lesson", arguments: { summary } }],
			api: "faux",
			provider: "faux",
			model: "faux",
			stopReason: "toolUse",
			usage,
			timestamp: t1,
		} as unknown as LhMessage,
		{
			id: `fr_${t2}`,
			role: "toolResult",
			toolCallId: callId,
			toolName: "finish_lesson",
			content: [{ type: "text", text: "finished" }],
			details: { grades: [{ skill: skillId, grade }] },
			isError: false,
			timestamp: t2,
		} as unknown as LhMessage,
	];
}

function approvedCourse(title: string, names: string[]) {
	const course = stores.courseStore.createCourse(title);
	stores.courseStore.updateCourse(course.id, {
		status: "draft",
		draft: {
			createdAt: "2026-10-01T00:00:00Z",
			summary: "Draft",
			skills: names.map((name, i) => ({
				key: `s${i}`,
				name,
				statement: `Apply ${name}`,
				requires: i === 0 ? [] : [`s${i - 1}`],
				restsOn: [],
			})),
		},
	});
	const approved = courses.approveCourse(course.id);
	assert.ok(approved.ok);
	return { courseId: course.id, skills: approved.value.skills };
}

beforeEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}\n");
	courses.clearCourseEvidenceCache();
	courses.setCourseEvidenceCacheLimit();
});

after(() => {
	courses.clearCourseEvidenceCache();
	courses.setCourseEvidenceCacheLimit();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("course evidence cache", () => {
	it("produces byte-for-byte identical results cached vs uncached and skips re-parsing unchanged files", () => {
		const { courseId, skills } = approvedCourse("Linear Algebra", ["Vectors", "Matrices", "Eigenvalues"]);
		const placement = stores.chatStore.createChat("Placement", undefined, { courseId, mode: "placement", skillIds: skills });
		stores.chatStore.saveMessages(placement.id, probeMessages("p1", skills[0]!, "easy"));

		const learn = stores.chatStore.createChat("Learn Matrices", undefined, { courseId, mode: "learn", skillIds: [skills[1]!] });
		stores.chatStore.saveMessages(learn.id, finishLessonMessages("fl1", skills[1]!, "Mastered matrix multiplication.", "good"));

		const practice = stores.chatStore.createChat("Practice", "practice", { courseId, mode: "practice", skillIds: [skills[0]!, skills[1]!] });
		stores.chatStore.saveMessages(practice.id, [
			...concludeMessages("c1", skills[0]!, "solvedWithHints", "hard"),
			...concludeMessages("c2", skills[1]!, "solved", "easy"),
		]);

		// Freeze clock so `now`-dependent fields (reviewAt, plan) are byte-for-byte identical.
		const fixedNow = Date.now();
		const realNow = Date.now;
		Date.now = () => fixedNow;
		try {
			courses.clearCourseEvidenceCache();
			const uncached = {
				summaries: JSON.stringify(courses.listCourseSummaries()),
				today: JSON.stringify(courses.todayCourses()),
				view: JSON.stringify(courses.courseView(courseId)),
				ratings: JSON.stringify(courses.ratingChanges(practice.id)),
				lesson: JSON.stringify(courses.lessonResult(learn.id)),
				names: JSON.stringify(courses.courseSessionSkillNames(practice.id)),
				impact: JSON.stringify(courses.courseDeletionImpact([placement.id, learn.id, practice.id])),
			};

			// Spy on chatStore.getChat: a warm pass must not call getChat at all.
			const origGetChat = stores.chatStore.getChat;
			let getChatCalls = 0;
			stores.chatStore.getChat = (id: string) => {
				getChatCalls++;
				return origGetChat(id);
			};
			try {
				const cached = {
					summaries: JSON.stringify(courses.listCourseSummaries()),
					today: JSON.stringify(courses.todayCourses()),
					view: JSON.stringify(courses.courseView(courseId)),
					ratings: JSON.stringify(courses.ratingChanges(practice.id)),
					lesson: JSON.stringify(courses.lessonResult(learn.id)),
					names: JSON.stringify(courses.courseSessionSkillNames(practice.id)),
					impact: JSON.stringify(courses.courseDeletionImpact([placement.id, learn.id, practice.id])),
				};
				assert.equal(getChatCalls, 0, "warm reads must not re-parse unchanged chat files");
				assert.deepEqual(cached, uncached, "cached reads must be byte-for-byte identical to uncached reads");
			} finally {
				stores.chatStore.getChat = origGetChat;
			}
		} finally {
			Date.now = realNow;
		}
	});

	it("invalidates on answered question, finished lesson, mid-session creation, deletion, and external/sync rewrites", () => {
		const { courseId, skills } = approvedCourse("Calculus", ["Limits", "Derivatives", "Integrals"]);
		const placement = stores.chatStore.createChat("Placement", undefined, { courseId, mode: "placement", skillIds: skills });

		// Warm the cache when placement has no answers yet.
		assert.equal(courses.courseView(courseId)!.known.length, 0);
		assert.equal(courses.courseDeletionImpact([placement.id]).sessions, 0);

		// 1. Answered question (placement probe saved)
		stores.chatStore.saveMessages(placement.id, probeMessages("q1", skills[0]!, "easy"));
		assert.ok(courses.courseView(courseId)!.known.includes(skills[0]!), "answered question must be reflected");
		assert.equal(courses.courseDeletionImpact([placement.id]).sessions, 1);

		// 2. Chat created mid-session + 3. Finished lesson
		const learn = stores.chatStore.createChat("Learn Derivatives", undefined, { courseId, mode: "learn", skillIds: [skills[1]!] });
		assert.equal(courses.lessonResult(learn.id)!.summary, null);
		stores.chatStore.saveMessages(learn.id, finishLessonMessages("fin1", skills[1]!, "Solid grasp of derivatives.", "good"));
		const finished = courses.lessonResult(learn.id)!;
		assert.equal(finished.summary, "Solid grasp of derivatives.");
		assert.equal(finished.learned, true);
		assert.equal(courses.courseView(courseId)!.skills.find((s) => s.id === skills[1])!.lessonNote?.summary, "Solid grasp of derivatives.");

		// 4a. External / sync rewrite via atomic rename with IDENTICAL byte size and IDENTICAL mtime (inode changes)
		const learnFile = path.join(PATHS.chats, `${learn.id}.json`);
		const beforeStat = fs.statSync(learnFile);
		const raw = fs.readFileSync(learnFile, "utf-8");
		const replaced = raw.replace("Solid grasp of derivatives.", "Sharp grasp of derivatives.");
		assert.equal(Buffer.byteLength(replaced), Buffer.byteLength(raw), "test precondition: identical byte size");
		const tmpFile = `${learnFile}.sync-tmp`;
		fs.writeFileSync(tmpFile, replaced, "utf-8");
		fs.utimesSync(tmpFile, beforeStat.atime, beforeStat.mtime);
		fs.renameSync(tmpFile, learnFile);
		assert.equal(
			courses.lessonResult(learn.id)!.summary,
			"Sharp grasp of derivatives.",
			"atomic rename rewrite (sync / another process) must invalidate even with identical size & mtime",
		);

		// 4b. In-place external write changing size/mtime
		const longer = replaced.replace("Sharp grasp of derivatives.", "Very thorough mastery of derivatives!");
		fs.writeFileSync(learnFile, longer, "utf-8");
		fs.utimesSync(learnFile, new Date(beforeStat.atimeMs + 5000), new Date(beforeStat.mtimeMs + 5000));
		assert.equal(
			courses.lessonResult(learn.id)!.summary,
			"Very thorough mastery of derivatives!",
			"in-place external write must invalidate cache",
		);

		// 5. Deleted chat disappears immediately and is pruned from cache
		const sizeBeforeDelete = courses.courseEvidenceCacheSize();
		stores.chatStore.deleteChat(learn.id);
		assert.equal(courses.lessonResult(learn.id), null, "deleted chat must return null");
		assert.equal(courses.courseDeletionImpact([learn.id]).sessions, 0, "deleted chat must have zero deletion impact");
		assert.equal(
			courses.courseView(courseId)!.skills.find((s) => s.id === skills[1])!.lessonNote,
			undefined,
			"deleted chat's lesson note must disappear from courseView",
		);
		assert.ok(courses.courseEvidenceCacheSize() < sizeBeforeDelete, "deleted chat entry must be pruned from cache");
	});

	it("bounds memory via LRU cap", () => {
		const { courseId, skills } = approvedCourse("Bounded Course", ["S1", "S2"]);
		courses.setCourseEvidenceCacheLimit(4);
		for (let i = 0; i < 10; i++) {
			const c = stores.chatStore.createChat(`Session ${i}`, undefined, { courseId, mode: "learn", skillIds: [skills[0]!] });
			stores.chatStore.saveMessages(c.id, finishLessonMessages(`f_${i}`, skills[0]!, `Note ${i}`, "good"));
		}
		const view = courses.courseView(courseId);
		assert.ok(view);
		assert.equal(courses.courseEvidenceCacheSize(), 4, "cache size must never exceed configured LRU cap");
	});

	it("uses a versioned globalThis key and ignores stale entries stored under old or unversioned keys", () => {
		assert.ok(Number.isInteger(courses.COURSE_EVIDENCE_CACHE_VERSION) && courses.COURSE_EVIDENCE_CACHE_VERSION >= 1);
		const keyName = Symbol.keyFor(courses.COURSE_EVIDENCE_CACHE_KEY);
		assert.equal(keyName, `lh.courseEvidenceCache.v${courses.COURSE_EVIDENCE_CACHE_VERSION}`);
		assert.notEqual(courses.COURSE_EVIDENCE_CACHE_KEY, Symbol.for("lh.courseEvidenceCache"));

		const { courseId, skills } = approvedCourse("Hot Reload Course", ["S1"]);
		const learn = stores.chatStore.createChat("Learn S1", undefined, { courseId, mode: "learn", skillIds: [skills[0]!] });
		stores.chatStore.saveMessages(learn.id, finishLessonMessages("fl_hr", skills[0]!, "Fresh extraction summary.", "good"));
		const learnFile = path.join(PATHS.chats, `${learn.id}.json`);
		const st = fs.statSync(learnFile);

		// Plant poisoned stale entries under the old unversioned key and a prior version key
		const g = globalThis as Record<symbol, unknown>;
		const legacyKey = Symbol.for("lh.courseEvidenceCache");
		const oldVersionKey = Symbol.for("lh.courseEvidenceCache.v0");
		const poisoned = new Map([
			[
				learnFile,
				{
					mtimeMs: st.mtimeMs,
					size: st.size,
					ino: st.ino,
					evidence: {
						link: { courseId, mode: "learn", skillIds: [skills[0]!] },
						events: [],
						note: { summary: "STALE FROM OLD CODE", at: 1, chatId: learn.id },
						problems: [],
						concludeCalls: [],
					},
				},
			],
		]);
		g[legacyKey] = { entries: poisoned, maxEntries: 1000 };
		g[oldVersionKey] = { entries: poisoned, floor: 1000, ceiling: 20000, maxEntries: 1000 };
		try {
			courses.clearCourseEvidenceCache();
			const res = courses.lessonResult(learn.id);
			assert.ok(res);
			assert.equal(res.summary, "Fresh extraction summary.", "must ignore cache entries from unversioned or older version keys");
		} finally {
			delete g[legacyKey];
			delete g[oldVersionKey];
		}
	});

	it("scales the cache cap dynamically from scanned course chats without thrashing, while respecting the hard ceiling", () => {
		assert.equal(courses.COURSE_EVIDENCE_CACHE_FLOOR, 1_000);
		assert.equal(courses.COURSE_EVIDENCE_CACHE_CEILING, 20_000);

		const { courseId, skills } = approvedCourse("Large Course", ["S1", "S2"]);
		// 13 course chats with floor=5, ceiling=50: fixed cap=5 thrashed every pass; dynamic cap grows to hold all 13.
		courses.setCourseEvidenceCacheBounds({ floor: 5, ceiling: 50 });
		for (let i = 0; i < 13; i++) {
			const c = stores.chatStore.createChat(`Session ${i}`, undefined, { courseId, mode: "learn", skillIds: [skills[0]!] });
			stores.chatStore.saveMessages(c.id, finishLessonMessages(`dyn_${i}`, skills[0]!, `Note ${i}`, "good"));
		}

		// First pass populates all 13 without evicting earlier entries mid-scan.
		assert.ok(courses.courseView(courseId));
		assert.equal(courses.courseEvidenceCacheSize(), 13);
		assert.ok(courses.courseEvidenceCacheLimit() >= 13 && courses.courseEvidenceCacheLimit() <= 50);

		// Second pass must hit the cache for all 13 chats (0 getChat calls — no thrashing).
		const origGetChat = stores.chatStore.getChat;
		let getChatCalls = 0;
		stores.chatStore.getChat = (id: string) => {
			getChatCalls++;
			return origGetChat(id);
		};
		try {
			assert.ok(courses.courseView(courseId));
			assert.equal(getChatCalls, 0, "second scan above floor but below ceiling must not thrash");
		} finally {
			stores.chatStore.getChat = origGetChat;
		}

		// Hard memory ceiling must still be enforced when course chats exceed ceiling.
		courses.setCourseEvidenceCacheBounds({ floor: 5, ceiling: 8 });
		assert.ok(courses.courseView(courseId));
		assert.equal(courses.courseEvidenceCacheLimit(), 8);
		assert.equal(courses.courseEvidenceCacheSize(), 8, "cache must never exceed its hard ceiling");
	});
});
