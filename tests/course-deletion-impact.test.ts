import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, it } from "node:test";
import { folderDeletionScope, type LhMessage } from "../src/core/index.ts";

// Merge review finding 1: a placement session was put in a folder and the folder deleted with mode=preserve-graph; the
// skill's progress vanished although the dialog said everything added to the graph stays. Skill evidence is derived from
// the course sessions' transcripts (server/courses.ts courseEvidence), so it goes with them in either mode. Evidence
// retention is a later design change; the dialogs now ask POST /api/courses/deletion-impact and say so.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-deletion-"));
process.env.LH_DATA_DIR = root; process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
const { POST } = await import("../app/api/courses/deletion-impact/route.ts");
const { DELETE: deleteFolderRoute } = await import("../app/api/graph/sources/folders/[id]/route.ts");
const { stores } = await import("../src/server/stores.ts");
const { sourceDirectory } = await import("../src/server/source-organization.ts");
const courses = await import("../src/server/courses.ts");
beforeEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root); fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}\n"); });
after(() => fs.rmSync(root, { recursive: true, force: true }));

let ts = 1000;
const call = (id: string, skill: string): LhMessage => ({
	id: `a_${ts}`, role: "assistant", content: [{ type: "toolCall", id, name: "probe", arguments: { skill } }],
	api: "faux", provider: "faux", model: "faux", stopReason: "toolUse", timestamp: ts++,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
}) as unknown as LhMessage;
const graded = (id: string, skill: string): LhMessage => {
	const details = { kind: "quiz", correct: true, confidence: 90, placementGrade: { skill, grade: "easy" } };
	return { id: `r_${ts}`, role: "toolResult", toolCallId: id, toolName: "probe", content: [{ type: "text", text: JSON.stringify(details) }], details, isError: false, timestamp: ts++ } as unknown as LhMessage;
};

function approvedCourse(title: string, names: string[]) {
	const course = stores.courseStore.createCourse(title);
	stores.courseStore.updateCourse(course.id, {
		status: "draft",
		draft: { createdAt: "t", summary: "s", skills: names.map((name, i) => ({ key: `s${i}`, name, statement: `Do ${name}`, requires: [], restsOn: [] })) },
	});
	const approved = courses.approveCourse(course.id);
	assert.ok(approved.ok);
	return { courseId: course.id, skills: approved.value.skills };
}

/** A placement session that credited `skill`, a placement session that recorded nothing yet, and a plain lesson. */
function setup() {
	const calc = approvedCourse("Calculus", ["Limits", "Derivatives"]);
	const phys = approvedCourse("Physics", ["Forces"]);
	const placement = stores.chatStore.createChat("Calculus placement", undefined, { courseId: calc.courseId, mode: "placement", skillIds: calc.skills });
	stores.chatStore.saveMessages(placement.id, [call("p1", calc.skills[0]!), graded("p1", calc.skills[0]!)]);
	const physics = stores.chatStore.createChat("Physics placement", undefined, { courseId: phys.courseId, mode: "placement", skillIds: phys.skills });
	stores.chatStore.saveMessages(physics.id, [call("p2", phys.skills[0]!), graded("p2", phys.skills[0]!)]);
	const empty = stores.chatStore.createChat("Unstarted placement", undefined, { courseId: calc.courseId, mode: "placement", skillIds: calc.skills });
	const plain = stores.chatStore.createChat("A plain lesson");
	stores.sourceOrganizationStore.write({ version: 1, folders: [{ id: "f", name: "Term", parentId: null, createdAt: "now" }], placements: {
		[placement.id]: { folderId: "f" }, [physics.id]: { folderId: "f" }, [empty.id]: { folderId: "f" }, [plain.id]: { folderId: "f" },
	} });
	return { calc, phys, placement, physics, empty, plain };
}

const impactOf = async (chatIds: unknown) => POST(new Request("http://localhost/api/courses/deletion-impact", {
	method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatIds }),
}));

it("names the course sessions that recorded progress, their courses and how many skills; others don't count", async () => {
	const { calc, phys, placement, physics, empty, plain } = setup();
	const folder = folderDeletionScope(sourceDirectory.read(), "f")!;
	assert.equal(folder.chatIds.length, 4);
	const response = await impactOf(folder.chatIds);
	assert.equal(response.status, 200);
	const impact = await response.json();
	assert.equal(impact.sessions, 2, "the unstarted placement and the plain lesson take no course progress");
	assert.deepEqual(new Map(impact.courses.map((c: { id: string; title: string; sessions: number }) => [c.id, [c.title, c.sessions]])),
		new Map([[calc.courseId, ["Calculus", 1]], [phys.courseId, ["Physics", 1]]]));
	assert.equal(impact.skills, 2);
	// Single-session deletion has the same loss: the session dialog asks about its one id.
	assert.deepEqual(courses.courseDeletionImpact([placement.id]), { sessions: 1, courses: [{ id: calc.courseId, title: "Calculus", sessions: 1 }], skills: 1 });
	assert.deepEqual(courses.courseDeletionImpact([empty.id, plain.id, "chat_unknown"]), { sessions: 0, courses: [], skills: 0 });
	// A course deleted since still counts (its skills keep the session's evidence); it has no title to name.
	stores.courseStore.deleteCourse(phys.courseId);
	assert.deepEqual(courses.courseDeletionImpact([physics.id]).courses, [{ id: phys.courseId, title: null, sessions: 1 }]);
	assert.equal((await impactOf("nope")).status, 400);
});

it("the reviewer's case: deleting the folder in preserve-graph mode really takes the placement's skill progress", async () => {
	const { calc } = setup();
	const learned = () => courses.courseView(calc.courseId)!.skills.find((s) => s.id === calc.skills[0])!.learned;
	assert.equal(learned(), true, "the placement credited the skill");
	assert.equal(courses.courseDeletionImpact(folderDeletionScope(sourceDirectory.read(), "f")!.chatIds).sessions, 2, "so the dialog warns");
	const scope = folderDeletionScope(sourceDirectory.read(), "f");
	const res = await deleteFolderRoute(new Request("http://localhost/api/graph/sources/folders/f?mode=preserve-graph", {
		method: "DELETE", body: JSON.stringify(scope), headers: { "Content-Type": "application/json" },
	}), { params: Promise.resolve({ id: "f" }) });
	assert.equal(res.status, 200);
	assert.equal(learned(), false, "the progress went with the transcript, as the warning says");
});
