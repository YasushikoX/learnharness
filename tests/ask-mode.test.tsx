/**
 * Ask mode (fork addition, 2026-11-25 — agent/ask-agent.ts): the course's open-questions conversation. Session birth
 * with and without a skill map, the empty opening, the agent's exact registry, a scripted turn that searches the
 * material and answers with a citation, nothing leaking into progress or the graph, every course-mode switch, the
 * course page's three ways in, and the prompt editor. Deterministic: a scripted faux model, LH_DATA_DIR isolated.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { renderToStaticMarkup as renderBare } from "react-dom/server";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ask-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { InteractionLayersProvider } = await import("../components/interaction-layers.tsx");
const renderToStaticMarkup = (node: React.ReactElement) => renderBare(<InteractionLayersProvider>{node}</InteractionLayersProvider>);
const { mergeSkillLines } = await import("../src/core/skills.ts");
const session = await import("../src/core/course-session.ts");
const mastery = await import("../src/core/mastery.ts");
const { learnerEventsOf } = await import("../src/core/learner-fold.ts");
const { sessionProgress } = await import("../src/core/session-progress.ts");
const { inputAppends } = await import("../src/core/input-events.ts");
const { COURSE_MODES } = await import("../src/core/contracts/course.ts");
const { QUESTION_TOOLS } = await import("../src/core/pending.ts");
const { skillStore } = await import("../src/store/skills.ts");
const { courseStore } = await import("../src/store/courses.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { materialStore } = await import("../src/store/materials.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const courses = await import("../src/server/courses.ts");
const { digestChats } = await import("../src/server/learner-profile.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { materialsForTurn } = await import("../src/server/materials.ts");
const { ASK_TOOL_NAMES, createAskAgent } = await import("../src/agent/ask-agent.ts");
const { agentSystemPrompt, composeInstructions } = await import("../src/agent/teacher-agent.ts");
const { allSegmentPaths, effectivePromptSegments } = await import("../src/agent/prompt-segments.ts");
const { CourseBody } = await import("../components/course-page.tsx");
const { courseModeStates, learnTarget } = await import("../components/course-modes.tsx");
const { sectionedSegments } = await import("../components/settings/agent-section.tsx");
const { initialPromptOwed } = await import("../components/chat.tsx");
const { LEDGER_FILES } = await import("../config.ts");
const sessionsRoute = await import("../app/api/courses/[id]/sessions/route.ts");
const promptsRoute = await import("../app/api/settings/prompts/route.ts");
const promptTextRoute = await import("../app/api/settings/prompts/[...segment]/route.ts");
const extractRoute = await import("../app/api/graph/coverage/extract/route.ts");

import type { ChatCourseLink, CourseView } from "../src/core/contracts.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { CoursePayload } from "../components/course-page.tsx";

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

// ─── fixtures ────────────────────────────────────────────────────────────────

function reset() {
	for (const c of courseStore.listCourses()) courseStore.deleteCourse(c.id);
	for (const c of chatStore.listChats()) chatStore.deleteChat(c.id);
	fs.rmSync(LEDGER_FILES.skills, { force: true });
	fs.rmSync(LEDGER_FILES.nodes, { force: true });
}

/** An approved course a → b. */
function approvedCourse(title = "Linear algebra") {
	const course = courseStore.createCourse(title);
	courseStore.updateCourse(course.id, {
		status: "draft",
		draft: {
			createdAt: "t",
			summary: "s",
			skills: [
				{ key: "s1", name: "Eigenvalues", statement: "Find the eigenvalues of a 2x2 matrix", requires: [], restsOn: [] },
				{ key: "s2", name: "Diagonalise", statement: "Diagonalise a 2x2 matrix", requires: ["s1"], restsOn: [] },
			],
		},
	});
	const approved = courses.approveCourse(course.id);
	assert.ok(approved.ok);
	const byName = Object.fromEntries(mergeSkillLines(skillStore.readSkillLines()).map((s) => [s.name, s.id]));
	return { courseId: course.id, a: byName.Eigenvalues!, b: byName.Diagonalise! };
}

/** A ready text material on the course (no profiler run: it is stamped ready with a profile). */
function addNotes(courseId: string) {
	const text = "# Eigenvalues\n\nAn eigenvalue of A is a scalar λ with Av = λv for some nonzero v.\nThe characteristic polynomial is det(A − λI).\n";
	const m = materialStore.add(courseId, { kind: "text", name: "notes.md", ext: ".md", bytes: new TextEncoder().encode(text) });
	materialStore.update(courseId, m.id, { status: "ready", profile: "## Scope and targets\nEigenvalues.\n\n## Contents\n- Eigenvalues (line 1)" });
	return m;
}

const ASSISTANT_BASE = { api: "faux", provider: "faux", model: "faux", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse" } as const;

/** A course practice session holding one cleanly concluded problem on `skill` (evidence, so the fold has something). */
function practiceEvidence(courseId: string, skill: string) {
	const created = courses.createCourseSession(courseId, "practice", skill);
	assert.ok(created.ok);
	const at = Date.now() - 86_400_000;
	const messages = [
		{ id: "p1", role: "assistant", content: [{ type: "toolCall", id: "pose", name: "problem", arguments: { statement: "x", skills: [skill] } }], ...ASSISTANT_BASE, timestamp: at },
		{ id: "p2", role: "toolResult", toolCallId: "pose", toolName: "problem", content: [{ type: "text", text: "ok" }], isError: false, timestamp: at },
		{ id: "p3", role: "assistant", content: [{ type: "toolCall", id: "done", name: "conclude", arguments: { outcome: "solved" } }], ...ASSISTANT_BASE, timestamp: at + 1000 },
		{ id: "p4", role: "toolResult", toolCallId: "done", toolName: "conclude", content: [{ type: "text", text: "ok" }], isError: false, details: { grades: [{ skill, grade: "good" }] }, timestamp: at + 1000 },
	] as unknown as LhMessage[];
	chatStore.saveMessages(created.value.id, [...(chatStore.getChat(created.value.id)!.messages), ...messages]);
	return created.value.id;
}

/** Pin the scripted turn's model onto the chat (the turn gate needs a configured, keyed model). */
function pinModel(chatId: string) {
	const settings = chatStore.getChat(chatId)!.settings ?? {};
	chatStore.saveSettings(chatId, { ...settings, model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
}

function scripted(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

function post(chatId: string, input: unknown): Request {
	return new Request("http://test/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, input }) });
}

async function runTurn(chatId: string, input: unknown, factory: Parameters<typeof handleChatRequest>[1]) {
	const ack = await handleChatRequest(post(chatId, input), factory);
	if (ack.status !== 200) assert.fail(`expected 200 ack, got ${ack.status}: ${await ack.text()}`);
	const handle = runningTurn(chatId);
	if (handle) await new Response(handle.subscribe()).text();
}

/** Every Ask fragment, in composition order (the conditional ones compose only when their source or tool is offered). */
const ASK_FRAGMENTS = [
	"ask/00-base.md", "ask/10-answers.md", "ask/20-grounding.md", "ask/21-class-material.md", "ask/22-lecture-notes.md",
	"ask/23-no-sources.md", "ask/24-no-tools.md", "ask/30-figure-blocks.md", "ask/31-circuits.md", "ask/32-visual.md", "ask/33-demo.md",
];

const NOT_ASK = ["probe_done", "plan_init", "finish_session", "finish_lesson", "problem", "conclude", "read_sketch", "send_to_user", "probe", "recall", "read", "ls", "find", "grep", "show_image", "research", "pdf"];

// ─── session birth ───────────────────────────────────────────────────────────

describe("Ask sessions: birth", () => {
	beforeEach(reset);

	it("starts on a course with NO approved skill map: a course chat with no skills and no messages", () => {
		const course = courseStore.createCourse("Signals");
		courseStore.updateCourse(course.id, { language: "nb" });
		assert.equal(courses.createCourseSession(course.id, "learn").ok, false, "Learn still needs a skill map");
		const out = courses.createCourseSession(course.id, "ask");
		assert.ok(out.ok, out.ok ? "" : out.error);
		assert.equal(out.value.title, "Questions: Signals");
		assert.equal(out.value.prompt, "", "no generated first learner message");
		const chat = chatStore.getChat(out.value.id)!;
		assert.deepEqual(chat.course, { courseId: course.id, mode: "ask", skillIds: [] } satisfies ChatCourseLink);
		assert.equal(chat.kind, undefined, "an ordinary (non-practice) chat");
		assert.deepEqual(chat.messages, [], "no context marker, no synthetic message: an empty composer");
		assert.equal(chat.settings?.language, "nb", "the course's language is stamped");
		assert.equal(chat.settings?.learnerProfile, undefined, "the Ask agent reads no learner profile");
		assert.equal(initialPromptOwed(chat.messages, out.value.prompt || undefined), false, "the chat sends nothing on open");
	});

	it("starts on a course WITH a skill map, still with no skills; skills, a skill set and retest are refused", () => {
		const { courseId, a } = approvedCourse();
		const out = courses.createCourseSession(courseId, "ask");
		assert.ok(out.ok);
		assert.deepEqual(chatStore.getChat(out.value.id)!.course!.skillIds, []);
		assert.deepEqual(chatStore.getChat(out.value.id)!.messages, []);
		for (const bad of [courses.createCourseSession(courseId, "ask", a), courses.createCourseSession(courseId, "ask", undefined, undefined, [a]), courses.createCourseSession(courseId, "ask", undefined, undefined, undefined, true)]) {
			assert.equal(bad.ok, false);
			if (!bad.ok) assert.equal(bad.status, 400);
		}
		assert.equal(courses.createCourseSession("course_nope", "ask").ok, false);
	});

	it("the sessions route accepts mode ask and answers an empty prompt", async () => {
		const course = courseStore.createCourse("Route");
		assert.ok(COURSE_MODES.includes("ask"));
		const res = await sessionsRoute.POST(
			new Request("http://test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "ask" }) }),
			{ params: Promise.resolve({ id: course.id }) },
		);
		assert.equal(res.status, 201);
		const body = (await res.json()) as { id: string; prompt: string; title: string };
		assert.equal(body.prompt, "");
		assert.equal(chatStore.getChat(body.id)!.course!.mode, "ask");
	});

	it("an Ask session is listed in the course view with its own mode and label, never as finished", () => {
		const { courseId } = approvedCourse();
		const out = courses.createCourseSession(courseId, "ask");
		assert.ok(out.ok);
		const listed = courses.courseView(courseId)!.sessions.find((s) => s.id === out.value.id)!;
		assert.equal(listed.mode, "ask");
		assert.equal(listed.finished, undefined);
		assert.equal(session.COURSE_MODE_LABEL.ask, "Questions", "not \"Ask\": the selection pill is already called Ask");
	});
});

// ─── the agent ───────────────────────────────────────────────────────────────

describe("the Ask agent", () => {
	beforeEach(reset);

	it("is offered exactly the allowed tools: lookups, figures, show_figure, visual, demo — nothing that probes, plans, poses, finishes or grades", () => {
		const { courseId } = approvedCourse();
		addNotes(courseId);
		const out = courses.createCourseSession(courseId, "ask");
		assert.ok(out.ok);
		const materials = materialsForTurn(out.value.id);
		assert.ok(materials, "the course's material reaches the Ask session");
		const agent = createAskAgent(
			{ jobs: { chatId: out.value.id, jobStore, spawn: () => {} } },
			{ engine: scripted([]), materials, chatId: out.value.id, pluginContributions: () => { throw new Error("no plugin contributions for Ask"); } },
		);
		const names = agent.state.tools.map((t) => t.name).sort();
		assert.deepEqual(names, ["circuit_solve", "demo", "figure_guide", "material_read", "material_search", "show_figure", "visual"]);
		for (const name of names) assert.ok((ASK_TOOL_NAMES as readonly string[]).includes(name), name);
		for (const name of [...QUESTION_TOOLS, ...NOT_ASK]) assert.ok(!names.includes(name), `${name} is not an Ask tool`);
	});

	it("drops visual and demo when the learner switched those job tools off; without job wiring there are none", () => {
		const off = createAskAgent({ jobs: { chatId: "c", jobStore, spawn: () => {} } }, { engine: scripted([]), toolToggles: { visual: false, demo: false } });
		assert.deepEqual(off.state.tools.map((t) => t.name).sort(), ["circuit_solve", "figure_guide", "show_figure"]);
		const bare = createAskAgent({}, { engine: scripted([]) });
		assert.deepEqual(bare.state.tools.map((t) => t.name).sort(), ["circuit_solve", "figure_guide", "show_figure"]);
	});

	// Review 1 prompt assessment: the shared fragments are written for lessons, so Ask composes its own directory only.
	it("composes prompts/ask/ only — no shared fragment, no teaching base, no question mechanics", () => {
		const paths = effectivePromptSegments("ask", {}).map((s) => s.path);
		assert.deepEqual(paths, ASK_FRAGMENTS);
		const prompt = composeInstructions("ask");
		assert.match(prompt, /^# Ask — questions about the class/);
		assert.match(prompt, /Answer first\./);
		assert.match(prompt, /\(name, p\. N\)/, "the materials' citation form, with pages");
		assert.doesNotMatch(prompt, /ask_user_question|probe_done|plan_init/, "no question or plan mechanics");
		assert.match(agentSystemPrompt("ask", { language: "en" }), /\*\*Not from the class material:\*\*/, "the label, in the course's language");
		// the course's language directive, the material and the course section join it per turn, like the other agents
		const nb = agentSystemPrompt("ask", { language: "nb", course: { section: session.coursePromptSection("ask", "Signals", []) } });
		assert.match(nb, /<course>\nThis conversation belongs to the course "Signals"\. It is an Ask conversation/);
		assert.notEqual(nb, agentSystemPrompt("ask", { language: "en", course: { section: session.coursePromptSection("ask", "Signals", []) } }), "the language directive differs");
	});

	it("a scripted turn searches the material, then answers with a citation; the record keeps both", async () => {
		const { courseId } = approvedCourse();
		const notes = addNotes(courseId);
		const out = courses.createCourseSession(courseId, "ask");
		assert.ok(out.ok);
		const chatId = out.value.id;
		pinModel(chatId);
		const answer = "An eigenvalue is a scalar $\\lambda$ with $Av = \\lambda v$ for a nonzero $v$ (notes.md, Eigenvalues). You find them as the roots of $\\det(A - \\lambda I)$ (notes.md, Eigenvalues).";
		let searched = "";
		const engine = scripted([
			fauxAssistantMessage([fauxToolCall("material_search", { query: "eigenvalue", literal: true }, { id: "s1" })], { stopReason: "toolUse" }),
			(context) => {
				const result = context.messages.find((m) => m.role === "toolResult") as { content: Array<{ type: string; text?: string }> } | undefined;
				searched = result?.content.map((c) => c.text ?? "").join("") ?? "";
				return fauxAssistantMessage([fauxText(answer)]);
			},
		]);
		let built: ReturnType<typeof createAskAgent> | undefined;
		let seen: Parameters<NonNullable<Parameters<typeof handleChatRequest>[1]>>[0] | undefined;
		const factory: Parameters<typeof handleChatRequest>[1] = (opts) => {
			seen = opts;
			built = createAskAgent({ jobs: { chatId, jobStore, spawn: () => {} } }, { ...opts, engine });
			return built;
		};
		await runTurn(chatId, { type: "text", text: "What is an eigenvalue?" }, factory);
		assert.ok(built && seen);
		assert.equal(seen.course?.tools, undefined, "the handler attaches no finish_session (or any course tool) to an Ask turn");
		assert.match(seen.course!.section, /Ask conversation/);
		assert.ok(seen.materials!.tools.some((t) => t.name === "material_search"));
		assert.match(built.state.systemPrompt, /<source_material>[\s\S]*notes\.md/, "the course's material section is in the prompt");
		assert.match(searched, /eigenvalue/i, "the search found the material's line");
		assert.match(searched, new RegExp(notes.name.replace(".", "\\.")));
		const saved = chatStore.getChat(chatId)!.messages;
		assert.equal(saved[0]!.role, "user", "the learner's own question is the first message");
		const last = saved.at(-1) as { role: string; content: Array<{ type: string; text?: string }> };
		assert.equal(last.role, "assistant");
		assert.match(last.content.map((c) => c.text ?? "").join(""), /\(notes\.md, Eigenvalues\)/);
		// a finish press is refused: an Ask conversation has no end to log
		const finish = await handleChatRequest(post(chatId, { type: "finish" }), factory);
		assert.equal(finish.status, 400);
	});
});

// ─── nothing leaks into progress ─────────────────────────────────────────────

describe("Ask leaves progress untouched", () => {
	beforeEach(reset);

	it("skill states, ratings, readiness, Today, lesson notes, deletion impact and the learner fold are unchanged by Ask turns", async () => {
		const { courseId, a } = approvedCourse();
		courseStore.updateCourse(courseId, { examDate: new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10), skillWeights: { [a]: { w: 3, by: "model" } }, weightsAt: "t", pastExams: 3 });
		addNotes(courseId);
		practiceEvidence(courseId, a);
		const strip = (v: CourseView) => ({ ...v, sessions: [], course: { ...v.course, updatedAt: "" } });
		const beforeView = strip(courses.courseView(courseId)!);
		const beforeToday = courses.todayCourses();
		const beforeSummaries = courses.listCourseSummaries();
		const beforeDigest = digestChats().length;

		const out = courses.createCourseSession(courseId, "ask");
		assert.ok(out.ok);
		const chatId = out.value.id;
		pinModel(chatId);
		// a transcript that LOOKS like evidence (a problem and a clean conclude tagged with a skill, a finish_session):
		// an Ask session still counts for nothing
		const engine = scripted([fauxAssistantMessage([fauxText("Short answer (notes.md, Eigenvalues).")])]);
		await runTurn(chatId, { type: "text", text: "What is det(A − λI)?" }, (opts) => createAskAgent({}, { ...opts, engine }));
		const forged = [
			{ id: "f1", role: "assistant", content: [{ type: "toolCall", id: "fp", name: "problem", arguments: { statement: "x", skills: [a] } }], ...ASSISTANT_BASE, timestamp: Date.now() },
			{ id: "f2", role: "toolResult", toolCallId: "fp", toolName: "problem", content: [{ type: "text", text: "ok" }], isError: false, timestamp: Date.now() },
			{ id: "f3", role: "assistant", content: [{ type: "toolCall", id: "fc", name: "conclude", arguments: { outcome: "solved" } }], ...ASSISTANT_BASE, timestamp: Date.now() },
			{ id: "f4", role: "toolResult", toolCallId: "fc", toolName: "conclude", content: [{ type: "text", text: "ok" }], isError: false, details: { grades: [{ skill: a, grade: "easy" }] }, timestamp: Date.now() },
		] as unknown as LhMessage[];
		chatStore.saveMessages(chatId, [...chatStore.getChat(chatId)!.messages, ...forged]);
		const record = chatStore.getChat(chatId)!;
		assert.deepEqual(mastery.skillEventsOf(record.messages, record.course!), [], "skillEventsOf: never evidence");

		assert.deepEqual(strip(courses.courseView(courseId)!), beforeView, "skills, understanding, review, next up, plan (readiness inputs), misses, lesson notes");
		assert.deepEqual(courses.todayCourses(), beforeToday, "Today");
		assert.deepEqual(courses.listCourseSummaries().map((s) => ({ ...s, updatedAt: "" })), beforeSummaries.map((s) => ({ ...s, updatedAt: "" })), "the sidebar's percent and due counts");
		assert.equal(courses.ratingChanges(chatId), null, "no rating changes for an Ask chat");
		assert.equal(courses.lessonResult(chatId), null);
		assert.equal(courses.courseSessionSkillNames(chatId), null);
		assert.deepEqual(courses.courseDeletionImpact([chatId]), { sessions: 0, courses: [], skills: 0 }, "deleting it takes no progress");
		assert.equal(digestChats().length, beforeDigest, "the learner profile does not read Ask chats");
		assert.deepEqual(learnerEventsOf({ id: chatId, kind: undefined, course: record.course, messages: record.messages } as Parameters<typeof learnerEventsOf>[0]), { concluded: [], answers: [] });
	});

	it("never feeds the knowledge graph: Ask is not an extracting mode, and the manual extract route refuses it", async () => {
		assert.equal(session.COURSE_MODE_EXTRACTS.ask, false);
		assert.equal(session.COURSE_MODE_EXTRACTS.learn, true, "Learn still extracts");
		for (const mode of ["practice", "review", "placement", "check"] as const) assert.equal(session.COURSE_MODE_EXTRACTS[mode], false, mode);
		const course = courseStore.createCourse("Graphless");
		const out = courses.createCourseSession(course.id, "ask");
		assert.ok(out.ok);
		const res = await extractRoute.POST(new Request("http://test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: out.value.id }) }));
		assert.equal(res.status, 409);
		assert.equal(graphStore.readNodes().length, 0);
	});
});

// ─── every course-mode switch handles ask ────────────────────────────────────

describe("every course-mode switch handles ask", () => {
	beforeEach(reset);

	it("labels, titles, first message, prompt section, progress, finish, turn context", () => {
		assert.equal(session.courseSessionTitle("ask", "Calc", []), "Questions: Calc");
		assert.equal(session.courseFirstMessage("ask", "Calc", [], "en"), "");
		assert.equal(session.courseFirstMessage("ask", "Calc", [], "nb"), "");
		const section = session.coursePromptSection("ask", "Calc", []);
		assert.match(section, /^<course>\nThis conversation belongs to the course "Calc"/);
		assert.doesNotMatch(section, /finish_session|finish_lesson|skills\` field/, "no finishing, no tagging law");
		assert.equal(sessionProgress("ask", { messages: [], skillCount: 0, tree: null, statuses: null, finished: false }), 0);
		const askRecord = { id: "c", title: "t", createdAt: "t", updatedAt: "t", messages: [], course: { courseId: "x", mode: "ask", skillIds: [] } };
		assert.throws(() => inputAppends(askRecord as never, { type: "finish" }), /no finish/);

		const course = courseStore.createCourse("Turn");
		const out = courses.createCourseSession(course.id, "ask");
		assert.ok(out.ok);
		const turn = courses.courseForTurn(out.value.id)!;
		assert.equal(turn.mode, "ask");
		assert.equal(turn.skills, undefined, "nothing to tag");
		assert.equal(turn.exam, undefined);
		assert.match(turn.section, /"Turn"/);
	});

	it("an Ask session before the skill map does not hide the placement offer once the map is approved", () => {
		const course = courseStore.createCourse("Offer");
		const ask = courses.createCourseSession(course.id, "ask");
		assert.ok(ask.ok);
		const view = courses.courseView(course.id)!;
		const data: CoursePayload = {
			...view,
			skills: [skillView("a")],
			nextUp: ["a"],
			course: { ...view.course, status: "active", skills: ["a"] },
			drafting: false,
		};
		const html = renderBody(data);
		assert.match(html, /data-testid="placement-offer"/);
	});
});

// ─── the course page ─────────────────────────────────────────────────────────

const skillView = (id: string, over: Partial<CoursePayload["skills"][number]> = {}): CoursePayload["skills"][number] => ({
	id,
	name: id.toUpperCase(),
	statement: `Do ${id}`,
	requires: [],
	understanding: 0,
	learned: false,
	known: false,
	needsReview: false,
	reviewAt: null,
	stability: null,
	lastReview: null,
	missing: [],
	weight: 1,
	priority: 1,
	propositions: [],
	...over,
});

const payload = (over: Partial<CoursePayload> = {}): CoursePayload => ({
	course: { id: "course_a", title: "Calc", createdAt: "t", updatedAt: "t", status: "active", skills: ["a", "b"] },
	skills: [skillView("a", { understanding: 3, learned: true, reviewAt: "2099-01-01T00:00:00Z" }), skillView("b", { requires: ["a"] })],
	review: [],
	reviewBatch: 0,
	notExamined: [],
	plan: { skillsLeft: 1, reviewDue: 0, reviewBatch: 0, lessons: [] },
	nextUp: ["b"],
	learning: ["a"],
	locked: [],
	known: [],
	contextCheck: [],
	sessions: [{ id: "chat_1", title: "Learn: A", mode: "learn", updatedAt: "t" }],
	reused: {},
	drafting: false,
	...over,
});

const renderBody = (data: CoursePayload, onStart: (mode: string, skillId?: string) => void = () => {}) =>
	renderToStaticMarkup(
		<CourseBody data={data} busy={false} error={null} onDraft={() => {}} onApprove={() => {}} onStart={onStart} materialCount={1} onAsk={() => {}} />,
	);

const noMap = (over: Partial<CoursePayload> = {}) =>
	payload({ course: { id: "course_a", title: "Calc", createdAt: "t", updatedAt: "t", status: "new", skills: [] }, skills: [], nextUp: [], learning: [], sessions: [], plan: { skillsLeft: 0, reviewDue: 0, reviewBatch: 0, lessons: [] }, ...over });

describe("the course page: Learn, Ask, Practice", () => {
	const available = (html: string, id: string) => new RegExp(`data-testid="course-mode-${id}" data-available="true"`).test(html);

	it("an active course: all three, Learn names the next lesson, Practice what is being learned", () => {
		const html = renderBody(payload());
		assert.match(html, /data-testid="course-modes"[\s\S]*course-mode-learn[\s\S]*course-mode-ask[\s\S]*course-mode-practice/, "in that order");
		for (const id of ["learn", "ask", "practice"]) assert.ok(available(html, id), id);
		assert.match(html, /data-testid="course-mode-learn-line"[^>]*>Next: B</);
		assert.match(html, /data-testid="course-mode-practice-line"[^>]*>1 skill you are learning</);
		// UI class page (owner, 2026-11-25): "Short question", with no description line while there is nothing to continue
		assert.match(html, />Short question</);
		assert.doesNotMatch(html, /Ask about this class|Short answers from the class material/);
		assert.doesNotMatch(html, /data-testid="course-mode-ask-line"/);
		assert.ok(html.indexOf("course-modes") < html.indexOf("course-exam-plan"), "at the top of the page");
	});

	it("Learn starts the same lesson as the Next up box (today's first lesson wins), Practice is Practice all", () => {
		assert.equal(learnTarget(payload({ plan: { skillsLeft: 2, reviewDue: 0, reviewBatch: 0, lessons: ["c"] }, nextUp: ["b", "c"] })), "c");
		assert.equal(learnTarget(payload()), "b");
		assert.equal(learnTarget(payload({ nextUp: [], notExamined: ["z"] })), "z");
		assert.equal(learnTarget(payload({ nextUp: [] })), undefined);
	});

	it("before a skill map exists, in every such state: only Short question shows (once there is a file), never a 'Waits for' line", () => {
		const states: Array<[string, CoursePayload]> = [
			["new", noMap()],
			["drafting", noMap({ drafting: true })],
			["draft", noMap({ course: { id: "course_a", title: "Calc", createdAt: "t", updatedAt: "t", status: "draft", skills: [], draft: { createdAt: "t", summary: "s", skills: [] } } })],
			["error", noMap({ course: { id: "course_a", title: "Calc", createdAt: "t", updatedAt: "t", status: "error", skills: [], error: "boom" } })],
		];
		for (const [name, data] of states) {
			const html = renderBody(data);
			assert.ok(available(html, "ask"), `${name}: Short question works`);
			assert.doesNotMatch(html, /course-mode-learn|course-mode-practice/, `${name}: Learn and Practice are hidden until they can work`);
			assert.doesNotMatch(html, /Waits for|course-modes-reason/, name);
			const states = courseModeStates(data);
			assert.equal(states.learn.available, false, name);
			assert.equal(states.practice.available, false, name);
		}
		const noFiles = renderToStaticMarkup(<CourseBody data={noMap()} busy={false} error={null} onDraft={() => {}} onApprove={() => {}} onStart={() => {}} materialCount={0} onAsk={() => {}} />);
		assert.doesNotMatch(noFiles, /course-modes/, "no file yet: nothing to ask about, the setup card is the whole center");
	});

	it("nothing left to learn, nothing learned yet, everything known: the unavailable card says why", () => {
		const fresh = courseModeStates(payload({ learning: [], skills: [skillView("a"), skillView("b", { requires: ["a"] })], nextUp: ["a"] }));
		assert.equal(fresh.practice.available, false);
		const known = courseModeStates(payload({ learning: [], nextUp: [], known: ["a", "b"] }));
		assert.equal(known.learn.available, false);
		assert.equal(known.practice.available, false);
		// UI class page: a way in that cannot start is not on the page (no disabled card with an explanation)
		const html = renderBody(payload({ learning: [], nextUp: [], known: ["a", "b"] }));
		assert.doesNotMatch(html, /course-mode-learn|course-mode-practice/);
		assert.ok(available(html, "ask"));
	});

	it("lists Ask sessions with their own label, and the Ask card reopens the newest one with a New button beside it", () => {
		const data = payload({ sessions: [
			{ id: "chat_ask2", title: "Questions: Calc", mode: "ask", updatedAt: "t2" },
			{ id: "chat_1", title: "Learn: A", mode: "learn", updatedAt: "t" },
			{ id: "chat_ask1", title: "Questions: Calc", mode: "ask", updatedAt: "t1" },
		] });
		const html = renderBody(data);
		assert.match(html, /data-testid="course-sessions"[\s\S]*Questions: Calc[\s\S]*>Short question</, "the list labels it");
		assert.match(html, /data-testid="course-mode-ask-new"/);
		assert.match(html, /data-testid="course-mode-ask-line"[^>]*>Continue the last one</, "the default title says nothing: only that there is one");
		assert.equal(courseModeStates(payload({ sessions: [{ id: "chat_q", title: "Why ATP?", mode: "ask", updatedAt: "t" }] })).ask.line, "Continue: Why ATP?");
		assert.equal(courseModeStates(data).ask.reopen, "chat_ask2", "the newest");
		assert.equal(courseModeStates(payload()).ask.reopen, undefined, "no Ask session yet: the card starts one");
		assert.doesNotMatch(renderBody(payload()), /course-mode-ask-new/);
	});
});

// ─── the prompt editor ───────────────────────────────────────────────────────

describe("the prompt editor lists the Ask fragments", () => {
	it("GET /api/settings/prompts carries ask, as composed at runtime", async () => {
		const view = (await (await promptsRoute.GET()).json()) as Record<string, Array<{ path: string; shared: boolean }>>;
		assert.deepEqual(view.ask, JSON.parse(JSON.stringify(effectivePromptSegments("ask", {}))));
		assert.deepEqual(view.ask!.map((s) => s.path), ASK_FRAGMENTS, "every Ask fragment, conditional ones included, and nothing shared");
		assert.ok(!view.ask!.some((s) => s.shared || s.path === "system-prompt.md"));
		for (const p of ASK_FRAGMENTS) assert.ok(allSegmentPaths().includes(p), p);
	});

	it("an Ask section with its own fragments; no shared fragment's usage label names Ask (it composes none)", async () => {
		const view = (await (await promptsRoute.GET()).json()) as Parameters<typeof sectionedSegments>[0];
		const sections = sectionedSegments(view);
		assert.deepEqual(sections.map((s) => s.id), ["teacher", "prober", "practice", "placement", "ask", "shared"]);
		const ask = sections.find((s) => s.id === "ask")!;
		assert.equal(ask.label, "Ask");
		assert.deepEqual(ask.segments.map((s) => s.path), ASK_FRAGMENTS);
		const shared = sections.at(-1)!.segments;
		assert.ok(shared.length > 0);
		for (const s of shared) assert.doesNotMatch(s.usageHint!, /Ask/, s.path);
		assert.match(shared.find((s) => s.path === "shared/40-formatting.md")!.usageHint!, /Placement$/, "the others keep theirs");
	});

	it("an Ask fragment can be overridden through the same route and switch as the others", async () => {
		const segment = ["ask", "10-answers.md"];
		const res = await promptTextRoute.PUT(
			new Request("http://test", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "SYNTHETIC ASK OVERRIDE" }) }),
			{ params: Promise.resolve({ segment }) },
		);
		assert.equal(res.status, 200);
		assert.doesNotMatch(composeInstructions("ask", {}), /SYNTHETIC ASK OVERRIDE/, "text alone does not enable it");
		assert.match(composeInstructions("ask", { "ask/10-answers.md": true }), /SYNTHETIC ASK OVERRIDE/);
		assert.equal((await promptTextRoute.DELETE(new Request("http://test", { method: "DELETE" }), { params: Promise.resolve({ segment }) })).status, 200);
		assert.doesNotMatch(composeInstructions("ask", { "ask/10-answers.md": true }), /SYNTHETIC ASK OVERRIDE/);
	});
});

// ─── review 1 regressions (2026-11-25) ─────────────────────────────────────────

const { ASK_CHAT_VERSION, CURRENT_CHAT_VERSION, NEWEST_CHAT_VERSION, chatVersionFor } = await import("../src/core/contracts/chat.ts");
const { mergeFile } = await import("../src/core/sync-merge.ts");
const { createExtractionPipeline } = await import("../src/agent/subagents/extraction.ts");
const { createSourceDirectory } = await import("../src/server/source-organization.ts");
const { stores } = await import("../src/server/stores.ts");
const { sessionCoverage } = await import("../src/server/chats.ts");
const { requestExtract } = await import("../components/extraction-coverage.tsx");
const { systemPromptTokensFor, compactionKindFor } = await import("../src/server/chat-handler.ts");
const { buildCompactionPrompt } = await import("../src/core/compaction.ts");
const { PaceControl } = await import("../components/pace-control.tsx");
const { ChatSettingsSeedProvider } = await import("../components/chat-settings-client.tsx");
const { askSystemPrompt, ASK_WORDING, ASK_FRAGMENT_CONDITIONS } = await import("../src/agent/ask-prompt.ts");
const { LESSON_LANGUAGES } = await import("../src/core/language.ts");
const { listSourceSegments } = await import("../src/agent/prompt-segments.ts");
const { LECTURE_NOTES_RULES } = await import("../src/core/lecture-note-text.ts");
const { MATERIAL_RULES } = await import("../src/core/materials.ts");

const chatFileOf = (id: string) => path.join(TMP_DATA, "chats", `${id}.json`);
const onDisk = (id: string) => JSON.parse(fs.readFileSync(chatFileOf(id), "utf8")) as { version?: number; course?: ChatCourseLink };

/** The chat reader of e8257bde, the last build without Ask (src/store/chats.ts getChat): it refused only records stamped
 *  above its own CURRENT_CHAT_VERSION, which was 2. Its sync merge (core/sync-merge.ts mergeChat) used the same bound. */
const PREVIOUS_CHAT_VERSION = 2;
const previousReader = (raw: { version?: unknown }) => (typeof raw.version === "number" && raw.version > PREVIOUS_CHAT_VERSION ? null : raw);

/** A forged clean finish_session call: what a synced or imported transcript could hold. */
function forgedFinish(): LhMessage[] {
	const at = Date.now();
	return [
		{ id: "fin1", role: "assistant", content: [{ type: "toolCall", id: "fin", name: "finish_session", arguments: { summary: "done" } }], ...ASSISTANT_BASE, timestamp: at },
		{ id: "fin2", role: "toolResult", toolCallId: "fin", toolName: "finish_session", content: [{ type: "text", text: "ok" }], isError: false, timestamp: at },
	] as unknown as LhMessage[];
}

/** An engine that must never be called: counts calls, then fails them. */
function forbiddenEngine(): { engine: PiEngine; calls: () => number } {
	let calls = 0;
	const faux = createFauxCore({});
	return {
		engine: { model: faux.getModel(), streamFn: (() => { calls++; throw new Error("no model call allowed"); }) as unknown as PiEngine["streamFn"] },
		calls: () => calls,
	};
}

describe("review 1 finding 1: builds without Ask refuse an Ask chat", () => {
	beforeEach(reset);

	it("an Ask chat is stamped above what older builds read, through later writes and sync merges; ordinary chats keep theirs", () => {
		assert.equal(CURRENT_CHAT_VERSION, PREVIOUS_CHAT_VERSION, "ordinary chats keep the version older builds read");
		assert.ok(ASK_CHAT_VERSION > PREVIOUS_CHAT_VERSION);
		assert.equal(NEWEST_CHAT_VERSION, ASK_CHAT_VERSION);
		const course = courseStore.createCourse("Versions");
		const ask = courses.createCourseSession(course.id, "ask");
		assert.ok(ask.ok);
		const plain = chatStore.createChat("plain");
		assert.equal(onDisk(ask.value.id).version, ASK_CHAT_VERSION, "at birth");
		assert.equal(onDisk(plain.id).version, CURRENT_CHAT_VERSION);
		assert.equal(chatStore.getChat(ask.value.id)?.course?.mode, "ask", "this build reads it");
		// the previous reader refuses it, and still reads the ordinary chat
		assert.equal(previousReader(onDisk(ask.value.id)), null, "an older build refuses the Ask chat instead of resuming it as a prober");
		assert.ok(previousReader(onDisk(plain.id)));
		// every later write keeps the stamp
		pinModel(ask.value.id);
		chatStore.saveMessages(ask.value.id, [{ id: "u1", role: "user", content: "q", timestamp: 1 } as unknown as LhMessage]);
		chatStore.renameChat(ask.value.id, "Renamed");
		chatStore.appendTurnUsage(ask.value.id, { id: "t1", at: new Date().toISOString(), model: "m", steps: [] } as never);
		assert.equal(onDisk(ask.value.id).version, ASK_CHAT_VERSION, "after saves, a rename and a usage append");
		assert.equal(previousReader(onDisk(ask.value.id)), null);
		// a sync merge of two Ask copies keeps it; of two ordinary copies keeps theirs
		const local = fs.readFileSync(chatFileOf(ask.value.id), "utf8");
		const remoteRecord = { ...JSON.parse(local), updatedAt: new Date(Date.now() + 1000).toISOString(), messages: [...JSON.parse(local).messages, { id: "u2", role: "user", content: "q2", timestamp: 2 }] };
		const merged = mergeFile({ path: `chats/${ask.value.id}.json`, base: null, prefer: "local", local, remote: JSON.stringify(remoteRecord) });
		assert.equal(merged.skipped, null, "this build merges it");
		assert.equal((JSON.parse(merged.content!) as { version: number }).version, ASK_CHAT_VERSION, "the merge keeps the stamp");
		assert.equal(previousReader(JSON.parse(merged.content!)), null);
		const plainText = fs.readFileSync(chatFileOf(plain.id), "utf8");
		const plainMerged = mergeFile({ path: `chats/${plain.id}.json`, base: null, prefer: "local", local: plainText, remote: JSON.stringify({ ...JSON.parse(plainText), title: "x", updatedAt: new Date(Date.now() + 1000).toISOString() }) });
		assert.equal((JSON.parse(plainMerged.content!) as { version: number }).version, CURRENT_CHAT_VERSION);
		assert.equal(chatVersionFor({ course: { mode: "learn" } }), CURRENT_CHAT_VERSION);
		assert.equal(chatVersionFor({}), CURRENT_CHAT_VERSION);
	});

	it("re-check finding 1: a chat that is not Ask and is stamped with the Ask version is refused, never stamped back down", () => {
		const course = courseStore.createCourse("Ceilings");
		const plain = chatStore.createChat("plain");
		const learn = chatStore.createChat("learn", undefined, { courseId: course.id, mode: "learn", skillIds: [] });
		const ask = courses.createCourseSession(course.id, "ask");
		assert.ok(ask.ok);
		const restamp = (id: string, version: number) => fs.writeFileSync(chatFileOf(id), JSON.stringify({ ...JSON.parse(fs.readFileSync(chatFileOf(id), "utf8")), version }));
		const errors = console.error;
		console.error = () => {};
		try {
			for (const id of [plain.id, learn.id]) {
				restamp(id, ASK_CHAT_VERSION);
				assert.equal(chatStore.getChat(id), null, "refused on read");
				assert.throws(() => chatStore.renameChat(id, "rewritten"), /Chat not found/);
				assert.equal(onDisk(id).version, ASK_CHAT_VERSION, "a write through the store leaves the file as it was");
				assert.notEqual((onDisk(id) as { title?: string }).title, "rewritten");
				assert.ok(!chatStore.listChats().some((c) => c.id === id), "not listed");
			}
			// an Ask chat: the legacy stamp (written before the Ask version existed) reads and is raised on the next write
			restamp(ask.value.id, CURRENT_CHAT_VERSION);
			assert.equal(chatStore.getChat(ask.value.id)?.course?.mode, "ask");
			chatStore.renameChat(ask.value.id, "Raised");
			assert.equal(onDisk(ask.value.id).version, ASK_CHAT_VERSION);
			restamp(ask.value.id, ASK_CHAT_VERSION + 1);
			assert.equal(chatStore.getChat(ask.value.id), null, "an Ask chat above the Ask version is from a newer app");
		} finally {
			console.error = errors;
		}
	});
});

describe("review 1 finding 2: no entry point feeds an Ask transcript to the graph", () => {
	beforeEach(reset);

	it("runExtraction refuses an Ask chat before any stage, usage or ledger write; an ordinary chat still reaches its stages", async () => {
		const course = courseStore.createCourse("Pipeline");
		const ask = courses.createCourseSession(course.id, "ask");
		assert.ok(ask.ok);
		const transcript = [
			{ id: "u1", role: "user", content: "What is an eigenvalue?", timestamp: 1 },
			{ id: "a1", role: "assistant", content: [{ type: "text", text: "A scalar with Av = λv (notes.md, p. 1). ".repeat(40) }], ...ASSISTANT_BASE, stopReason: "stop", timestamp: 2 },
		] as unknown as LhMessage[];
		chatStore.saveMessages(ask.value.id, transcript);
		const extractor = forbiddenEngine();
		const auditor = forbiddenEngine();
		const pipeline = createExtractionPipeline({ chatStore, graphStore, extractor: extractor.engine, auditor: auditor.engine, getChunkTokens: () => 50 });
		assert.deepEqual(await pipeline.runExtraction(ask.value.id), { nodes: 0, chains: 0 });
		assert.equal(extractor.calls() + auditor.calls(), 0, "no stage ran");
		assert.equal(graphStore.readNodes().length, 0, "no node merged");
		assert.ok(!graphStore.readCoverage().some((e) => e.chatId === ask.value.id), "no coverage row");
		assert.equal(chatStore.getChat(ask.value.id)!.extractions, undefined, "no usage written");
		// the control: the same pipeline does run its stages on an ordinary chat
		const plain = chatStore.createChat("plain");
		chatStore.saveMessages(plain.id, transcript);
		await pipeline.runExtraction(plain.id).catch(() => {});
		assert.ok(extractor.calls() > 0, "an ordinary chat reaches the extractor");
	});

	it("the source directory (Chains, practice source picking) does not list Ask chats; ordinary chats stay", () => {
		const course = courseStore.createCourse("Sources");
		const ask = courses.createCourseSession(course.id, "ask");
		assert.ok(ask.ok);
		const plain = chatStore.createChat("plain");
		const ids = createSourceDirectory(stores).read().sources.map((s) => s.id);
		assert.ok(!ids.includes(ask.value.id), "an Ask chat is never a source");
		assert.ok(ids.includes(plain.id));
	});
});

describe("review 1 finding 3: Ask leaves Today's order alone", () => {
	beforeEach(reset);

	it("two courses offering a lesson: creating and using an Ask conversation in the older one keeps the order and the course's timestamp", async () => {
		const a = approvedCourse("Course A");
		await new Promise((r) => setTimeout(r, 15));
		const b = approvedCourse("Course B");
		const order = () => courses.todayCourses().map((c) => c.courseId);
		assert.deepEqual(order(), [b.courseId, a.courseId], "the newer course first");
		const updatedA = courseStore.getCourse(a.courseId)!.updatedAt;
		const summaries = courses.listCourseSummaries();
		await new Promise((r) => setTimeout(r, 15));
		const ask = courses.createCourseSession(a.courseId, "ask");
		assert.ok(ask.ok);
		pinModel(ask.value.id);
		await runTurn(ask.value.id, { type: "text", text: "What is an eigenvalue?" }, (opts) => createAskAgent({}, { ...opts, engine: scripted([fauxAssistantMessage([fauxText("A scalar λ with Av = λv.")])]) }));
		assert.deepEqual(order(), [b.courseId, a.courseId], "Today keeps its order");
		assert.equal(courseStore.getCourse(a.courseId)!.updatedAt, updatedA, "the course record is untouched");
		assert.deepEqual(courses.listCourseSummaries(), summaries, "the course list, timestamps included");
	});
});

describe("review 1 finding 4: Ask chats report no extraction coverage", () => {
	beforeEach(reset);

	it("sessionCoverage is null for an Ask chat, after an answer too; the chat route's coverage view and the extract route agree", async () => {
		const course = courseStore.createCourse("Coverage");
		const ask = courses.createCourseSession(course.id, "ask");
		assert.ok(ask.ok);
		pinModel(ask.value.id);
		await runTurn(ask.value.id, { type: "text", text: "Why?" }, (opts) => createAskAgent({}, { ...opts, engine: scripted([fauxAssistantMessage([fauxText("Because.")])]) }));
		assert.equal(sessionCoverage(ask.value.id), null, "no consumer sees an uncovered Ask message");
		const plain = chatStore.createChat("plain");
		assert.ok(sessionCoverage(plain.id), "an ordinary chat still has coverage");
		const res = await extractRoute.POST(new Request("http://test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: ask.value.id }) }));
		assert.equal(res.status, 409);
		assert.equal(((await res.json()) as { running?: boolean }).running, false, "a refusal, not a run in flight");
	});

	it("the client reads a 409 as running only when the response says an extraction is in flight", async () => {
		const real = globalThis.fetch;
		const answer = (status: number, body: unknown) => {
			globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as typeof fetch;
		};
		try {
			answer(409, { error: "Ask conversations are not added to the knowledge graph", running: false });
			assert.equal(await requestExtract("c"), false, "an Ask refusal is not 'running'");
			answer(409, { error: "x" });
			assert.equal(await requestExtract("c"), false, "a 409 that does not say so is not 'running'");
			answer(409, { error: "An extraction run is already in flight for this session", running: true });
			assert.equal(await requestExtract("c"), true);
			answer(202, { started: true });
			assert.equal(await requestExtract("c"), true);
			answer(500, { error: "boom" });
			assert.equal(await requestExtract("c"), false);
		} finally {
			globalThis.fetch = real;
		}
	});
});

describe("review 1 finding 5: Ask's own prompt size and summary", () => {
	it("context admission and compaction charge Ask's prompt, not the teacher's", () => {
		const ask: { kind: undefined; course: ChatCourseLink } = { kind: undefined, course: { courseId: "c", mode: "ask", skillIds: [] } };
		assert.equal(systemPromptTokensFor(ask), Math.ceil(composeInstructions("ask").length / 4));
		assert.ok(systemPromptTokensFor(ask) * 3 < systemPromptTokensFor({ kind: undefined, course: undefined }), "much smaller than the teacher's");
		assert.equal(systemPromptTokensFor({ kind: "practice", course: undefined }), Math.ceil(composeInstructions("practice").length / 4), "others unchanged");
		assert.equal(compactionKindFor({ ...ask, messages: [] }), "ask");
		assert.equal(compactionKindFor({ kind: "practice", course: undefined, messages: [] }), "practice");
		assert.equal(compactionKindFor({ kind: undefined, course: undefined, messages: [] }), "probe");
	});

	it("an Ask compaction keeps the questions, the answers' claims with sources and pages, and pending figures — no learner assessment or plan", () => {
		const prompt = buildCompactionPrompt({ spanText: "[LEARNER] q", planTreeText: null, kind: "ask" });
		for (const section of ["## Questions and answers", "## Sources read", "## Pending"]) assert.ok(prompt.includes(section), section);
		assert.match(prompt, /page, pages or section/);
		assert.match(prompt, /figure or demo dispatched but not shown yet \(its job id/);
		assert.match(prompt, /no assessment of the learner, no plan/);
		assert.doesNotMatch(prompt, /learner's understanding|teaching arc|plan dependency tree/i);
		assert.match(buildCompactionPrompt({ spanText: "x", planTreeText: null, kind: "teach" }), /## The learner's understanding/, "the tutoring summary is unchanged");
	});
});

describe("review 1 findings 6 and 7: no lesson controls, never finished", () => {
	beforeEach(reset);

	it("an Ask chat shows no Pace control (a lesson's still does)", () => {
		const seed = (mode: "ask" | "learn") => ({ chatId: "chat_p", settings: {}, kind: "teach" as const, course: { courseId: "c", mode, skillIds: [] } });
		const render = (mode: "ask" | "learn") => renderToStaticMarkup(<ChatSettingsSeedProvider value={seed(mode)}><PaceControl chatId="chat_p" /></ChatSettingsSeedProvider>);
		assert.doesNotMatch(render("ask"), /Pace/);
		assert.equal(render("ask"), renderToStaticMarkup(<></>), "renders nothing");
		assert.match(render("learn"), /aria-label="Pace: Thorough"/);
	});

	it("a finish-looking transcript does not make an Ask chat finished, in the list or the course view", () => {
		const { courseId } = approvedCourse();
		const ask = courses.createCourseSession(courseId, "ask");
		assert.ok(ask.ok);
		chatStore.saveMessages(ask.value.id, forgedFinish());
		assert.equal(session.sessionFinishOf(chatStore.getChat(ask.value.id)!.messages) !== null, true, "the transcript does look finished");
		assert.equal(chatStore.listChats().find((c) => c.id === ask.value.id)!.finished, undefined);
		assert.equal(courses.courseView(courseId)!.sessions.find((s) => s.id === ask.value.id)!.finished, undefined);
		assert.equal(sessionProgress("ask", { messages: chatStore.getChat(ask.value.id)!.messages, skillCount: 0, tree: null, statuses: null, finished: true }), 0);
	});
});

describe("review 1: nothing leaks into progress, the review's cases", () => {
	beforeEach(reset);

	it("pipeline extraction, Today with two courses, a finish-looking transcript and the source directory all leave progress as it was", async () => {
		const a = approvedCourse("Leak A");
		await new Promise((r) => setTimeout(r, 15));
		const b = approvedCourse("Leak B");
		practiceEvidence(a.courseId, a.a);
		const before = { view: courses.courseView(a.courseId)!, today: courses.todayCourses(), summaries: courses.listCourseSummaries(), course: courseStore.getCourse(a.courseId)! };
		const sourcesBefore = createSourceDirectory(stores).read().sources.map((s) => s.id).sort();
		const ask = courses.createCourseSession(a.courseId, "ask");
		assert.ok(ask.ok);
		chatStore.saveMessages(ask.value.id, [
			{ id: "u1", role: "user", content: "q", timestamp: Date.now() } as unknown as LhMessage,
			...forgedFinish(),
		]);
		const pipeline = createExtractionPipeline({ chatStore, graphStore, extractor: forbiddenEngine().engine, auditor: forbiddenEngine().engine });
		await pipeline.runExtraction(ask.value.id);
		const strip = (v: CourseView) => ({ ...v, sessions: v.sessions.filter((s) => s.mode !== "ask") });
		assert.deepEqual(strip(courses.courseView(a.courseId)!), strip(before.view), "the course view, course timestamp included");
		assert.deepEqual(courses.todayCourses(), before.today, "Today, in order");
		assert.equal(before.today.length, 2, "both courses are on Today");
		assert.ok([a.courseId, b.courseId].every((id) => before.today.some((c) => c.courseId === id)));
		assert.deepEqual(courses.listCourseSummaries(), before.summaries);
		assert.deepEqual(courseStore.getCourse(a.courseId), before.course);
		assert.equal(graphStore.readNodes().length, 0);
		assert.deepEqual(createSourceDirectory(stores).read().sources.map((s) => s.id).sort(), sourcesBefore, "no new source");
		assert.deepEqual(courses.courseDeletionImpact([ask.value.id]), { sessions: 0, courses: [], skills: 0 });
		assert.equal(courses.ratingChanges(ask.value.id), null);
	});
});

// ─── review 1 item 7: the prompt ─────────────────────────────────────────────

/** Phrases that belong to the shared lesson fragments, the lesson material rules and the lesson language directive. */
const LESSON_PHRASES = [
	"quiz option", "quiz question", "figureCheck", "write the options", "answer key",
	"revisit at the end of the session", "keep a note of it", "structured document", "Use it maximally", "[!IMPORTANT]",
	"A wrong answer is named", "progress is acknowledged", "Conduct this entire lesson", "plan node labels", "hints",
	"TARGET AND SCOPE", "before the lesson ends", "adjust the plan", "dispatch a pdf job", "fit your teaching", "keep teaching",
	"finish_session", "finish_lesson", "Learner–helper conversations", "Nothing in it is graded or tracked", "is tracked",
	"lesson's target", "the lesson's", "this lesson",
];

describe("review 1 item 7: the composed Ask prompt", () => {
	beforeEach(reset);

	/** The prompt a real Ask turn gets, built the handler's way (materialsForTurn, courseForTurn, the agent's registry). */
	function turnPrompt(chatId: string, language: "en" | "nb" = "en", toggles?: Record<string, boolean>) {
		const materials = materialsForTurn(chatId);
		const course = courses.courseForTurn(chatId)!;
		const agent = createAskAgent({ jobs: { chatId, jobStore, spawn: () => {} } }, { engine: scripted([]), materials, course: { section: course.section }, language, chatId, toolToggles: toggles });
		return { prompt: agent.state.systemPrompt, tools: agent.state.tools.map((t) => t.name) };
	}

	function pdfCourse() {
		const course = courseStore.createCourse("Signals");
		const pdf = materialStore.add(course.id, { kind: "pdf", name: "Lecture 3.pdf", ext: ".pdf", bytes: new TextEncoder().encode("%PDF-1.4 fixture") });
		materialStore.update(course.id, pdf.id, { status: "ready", pages: 12, profile: "## Scope and targets\nThe Laplace transform.\n\n## Contents\n- Definition (p. 2)" });
		const ask = courses.createCourseSession(course.id, "ask");
		assert.ok(ask.ok);
		return ask.value.id;
	}

	it("(a) PDF material, every tool on: the lookup, figure, circuit, visual and demo fragments; nothing from the lesson fragments", () => {
		const id = pdfCourse();
		const { prompt, tools } = turnPrompt(id);
		assert.deepEqual([...tools].sort(), ["circuit_solve", "demo", "figure_guide", "material_read", "material_search", "show_figure", "visual"]);
		for (const heading of ["# Ask — questions about the class", "## The shape of an answer", "## Grounded in the class material", "## Looking things up in the class material", "## Figures the app draws", "## Circuit values", "## A figure made in the background: `visual`", "## An interactive figure: `demo`"]) {
			assert.ok(prompt.includes(heading), heading);
		}
		for (const absent of ["## No class material yet", "## No lookups in this reply", "## Using the learner's lecture notes"]) assert.ok(!prompt.includes(absent), absent);
		for (const phrase of LESSON_PHRASES) assert.ok(!prompt.includes(phrase), `no lesson phrase: ${phrase}`);
		assert.ok(!prompt.includes(MATERIAL_RULES.slice(0, 60)), "not the lesson material rules");
		assert.match(prompt, /<material id="[^"]+" name="Lecture 3\.pdf" kind="PDF, 12 pages" path="[^"]+">/, "the material, with its path for visual");
		assert.match(prompt, /Sources in this conversation: the class's PDF material, listed above\./);
		assert.match(prompt, /Nothing here counts toward their progress\./);
		assert.match(prompt, /When you could not check[\s\S]*not available on this device[\s\S]*not "not covered"/, "unavailable evidence differs from uncovered");
		assert.match(prompt, /coverage line comes first, then the answer at once/, "coverage first, answer immediately");
		assert.match(prompt, /the one-line statement about that comes first \(grounding, below\) and the answer follows in the very next sentence/);
		assert.match(prompt, /answer from passages already read|a passage you already read in this conversation answers it/);
		assert.ok(prompt.length / 4 < 4_200, `about the old size: ${Math.round(prompt.length / 4)} tokens`);
	});

	it("(b) no sources: says so, names none, and mentions no lookup tool", () => {
		const course = courseStore.createCourse("Empty");
		const ask = courses.createCourseSession(course.id, "ask");
		assert.ok(ask.ok);
		const { prompt, tools } = turnPrompt(ask.value.id);
		assert.ok(!tools.includes("material_search"));
		assert.match(prompt, /## No class material yet/);
		assert.match(prompt, /Sources in this conversation: none: the class has no material or lecture notes yet\./);
		assert.doesNotMatch(prompt, /material_search|material_read|lecture_note_/);
		assert.doesNotMatch(prompt, /<source_material>/);
	});

	it("names lecture notes when the course has them, and lets the notes tools in only then", () => {
		const caps = (tools: string[], notes: boolean) => askSystemPrompt({ caps: { tools, sources: { pdf: false, other: false, notes } } });
		const withNotes = caps(["lecture_note_search", "lecture_note_read"], true);
		assert.match(withNotes, /## Using the learner's lecture notes/);
		assert.doesNotMatch(withNotes, /## The learner's lecture notes/, "the generated notes index owns that heading (no duplicate)");
		assert.match(withNotes, /Sources in this conversation: the learner's lecture notes, listed above\./);
		assert.doesNotMatch(withNotes, /## No class material yet/);
		assert.doesNotMatch(caps([], false), /lecture_note_search/);
	});

	it("mentions visual and demo only when they are offered (the learner's toggles off: neither)", () => {
		const id = pdfCourse();
		const { prompt, tools } = turnPrompt(id, "en", { visual: false, demo: false });
		assert.ok(!tools.includes("visual") && !tools.includes("demo"));
		assert.doesNotMatch(prompt, /`visual`|`demo`|show_figure/);
		assert.match(prompt, /## Figures the app draws/, "the drawn figures stay");
		const onlyVisual = turnPrompt(id, "en", { demo: false });
		assert.match(onlyVisual.prompt, /`visual`/);
		assert.doesNotMatch(onlyVisual.prompt, /## An interactive figure/);
	});

	it("the visual and demo tools the Ask agent gets speak of answers, and name no tool it lacks", () => {
		const id = pdfCourse();
		const agent = createAskAgent({ jobs: { chatId: id, jobStore, spawn: () => {} } }, { engine: scripted([]) });
		for (const t of agent.state.tools) {
			assert.doesNotMatch(t.description, /\bls\b|lesson|teaching|question/i, `${t.name}: ${t.description}`);
		}
	});

	it("a selection clarification on an Ask chat: no tools, so it is told it cannot look anything up, and no tool is named", () => {
		const id = pdfCourse();
		const prompt = agentSystemPrompt("ask", { materials: materialsForTurn(id), course: { section: courses.courseForTurn(id)!.section }, language: "en" });
		assert.match(prompt, /## No lookups in this reply/);
		assert.match(prompt, /cannot search or read anything now/);
		assert.match(prompt, /You cannot look anything up in this reply\./);
		assert.doesNotMatch(prompt, /material_search|material_read|figure_guide|circuit_solve|show_figure|`visual`|`demo`/);
		assert.doesNotMatch(prompt, /Use material_search/, "the material blocks name no tool either");
	});

	it("re-check finding 3: a clarification on a class with no sources is not told to send the learner to get material checked", () => {
		const none = askSystemPrompt({ caps: { tools: [], sources: { pdf: false, other: false, notes: false } } });
		assert.match(none, /## No class material yet/);
		assert.doesNotMatch(none, /## No lookups in this reply|gets the material checked/);
		const some = askSystemPrompt({ caps: { tools: [], sources: { pdf: false, other: true, notes: false } } });
		assert.match(some, /## No lookups in this reply/);
		// a class whose only material is an image or a web page is not called "text material"
		assert.match(some, /Sources in this conversation: the class's material, listed above\. You cannot look anything up in this reply\./);
	});

	it("the general-knowledge label and the fixed lines are written in the course's language, for every supported language", () => {
		const id = pdfCourse();
		for (const { id: language, promptName } of LESSON_LANGUAGES) {
			const w = ASK_WORDING[language];
			assert.ok(w, language);
			const { prompt } = turnPrompt(id, language);
			assert.ok(prompt.includes(`**${w.label}**`), `${language}: label`);
			assert.ok(prompt.includes(`"${w.notCovered}"`), `${language}: coverage line`);
			assert.ok(prompt.includes(`"${w.unchecked}"`), `${language}: unchecked line`);
			assert.match(prompt, new RegExp(`Write everything the learner sees in ${promptName}`));
			assert.doesNotMatch(prompt, /<lesson_language>/, "not the lesson directive");
		}
		assert.equal(ASK_WORDING.nb.label, "Ikke fra kursmaterialet:");
		assert.equal(ASK_WORDING.en.label, "Not from the class material:");
		assert.ok(!turnPrompt(id, "nb").prompt.includes("Not from the class material:"), "no English label in a Norwegian course");
	});

	it("the lecture-note and material sections are Ask's own short versions", () => {
		assert.ok(!askSystemPrompt({ caps: { tools: [], sources: { pdf: false, other: false, notes: true } }, materials: { section: "x" } }).includes(LECTURE_NOTES_RULES));
		const id = pdfCourse();
		assert.doesNotMatch(materialsForTurn(id)!.section, /TARGET AND SCOPE|lesson/);
	});

	it("every conditional fragment exists, and the always-on ones compose whatever the turn offers", () => {
		const paths = listSourceSegments("ask").map((s) => s.path);
		for (const p of Object.keys(ASK_FRAGMENT_CONDITIONS)) assert.ok(paths.includes(p), p);
		const bare = askSystemPrompt({ caps: { tools: [], sources: { pdf: false, other: false, notes: false } } });
		for (const heading of ["# Ask — questions about the class", "## The shape of an answer", "## Grounded in the class material"]) assert.ok(bare.includes(heading), heading);
	});
});

// ─── review 1 item 8: packaging ──────────────────────────────────────────────

describe("review 1 item 8: the Ask prompt ships", () => {
	it("the composed Ask prompt contains its own fragments: a missing directory cannot leave the generated sections alone", () => {
		const segments = listSourceSegments("ask");
		assert.ok(segments.length >= 3 && segments.every((s) => s.path.startsWith("ask/") && !s.shared), "own fragments only");
		for (const s of effectivePromptSegments("ask", {})) assert.ok(s.sourceText.trim().length > 0, `${s.path} is readable`);
		const composed = composeInstructions("ask");
		assert.match(composed, /^# Ask — questions about the class/);
		assert.match(agentSystemPrompt("ask", {}), /^# Ask — questions about the class/, "the turn prompt starts with them");
	});

	it("the Next trace include and the packaging sanity check name the Ask fragments", () => {
		assert.match(fs.readFileSync("next.config.ts", "utf8"), /"src\/agent\/prompts\/ask\/\*\.md"/);
		assert.match(fs.readFileSync("scripts/build-server.mjs", "utf8"), /path\.join\("src", "agent", "prompts", "ask"\)/);
	});
});

// ─── review 1 item 9: small items ────────────────────────────────────────────

describe("review 1 item 9: draft card copy and conversation titles", () => {
	beforeEach(reset);

	it("the draft-state card points to the draft review below", () => {
		const data = noMap({ course: { id: "course_a", title: "Calc", createdAt: "t", updatedAt: "t", status: "draft", skills: [], draft: { createdAt: "t", summary: "s", skills: [] } } });
		// UI class page: the setup card's skill map step says it; Learn is simply not shown yet
		assert.equal(courseModeStates(data).learn.available, false);
		assert.match(renderBody(data), /data-testid="setup-step-map"[\s\S]*Review the draft below, then approve it\./);
	});

	it("a new Ask conversation is titled by its first question (trimmed), once asked; later questions and a chosen title are kept", async () => {
		const course = courseStore.createCourse("Signals");
		const first = courses.createCourseSession(course.id, "ask");
		assert.ok(first.ok);
		assert.equal(chatStore.getChat(first.value.id)!.title, "Questions: Signals", "until a question is asked");
		pinModel(first.value.id);
		const answer = (opts: Parameters<NonNullable<Parameters<typeof handleChatRequest>[1]>>[0]) => createAskAgent({}, { ...opts, engine: scripted([fauxAssistantMessage([fauxText("Short.")])]) });
		await runTurn(first.value.id, { type: "text", text: "   What does   the region of convergence mean?  " }, answer);
		assert.equal(chatStore.getChat(first.value.id)!.title, "What does the region of convergence mean?");
		await runTurn(first.value.id, { type: "text", text: "And for a left-sided signal?" }, answer);
		assert.equal(chatStore.getChat(first.value.id)!.title, "What does the region of convergence mean?", "the second question does not rename it");
		assert.equal(onDisk(first.value.id).version, ASK_CHAT_VERSION, "the rename keeps the Ask stamp");
		const second = courses.createCourseSession(course.id, "ask");
		assert.ok(second.ok);
		chatStore.renameChat(second.value.id, "My own name");
		pinModel(second.value.id);
		await runTurn(second.value.id, { type: "text", text: "What is a pole?" }, answer);
		assert.equal(chatStore.getChat(second.value.id)!.title, "My own name", "a title the learner chose is kept");
		// re-check finding 2: a chosen title that merely begins like the default is kept too
		const third = courses.createCourseSession(course.id, "ask");
		assert.ok(third.ok);
		chatStore.renameChat(third.value.id, "Questions: Week 3");
		pinModel(third.value.id);
		await runTurn(third.value.id, { type: "text", text: "What is a zero?" }, answer);
		assert.equal(chatStore.getChat(third.value.id)!.title, "Questions: Week 3", "only the exact default is replaced");
		const titles = courses.courseView(course.id)!.sessions.filter((s) => s.mode === "ask").map((s) => s.title).sort();
		assert.deepEqual(titles, ["My own name", "Questions: Week 3", "What does the region of convergence mean?"], "distinguishable");
	});
});
