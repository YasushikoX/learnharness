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

	it("composes prompts/ask/ plus voice, accuracy, side conversations, formatting and figures — no teaching base, no question mechanics", () => {
		const paths = effectivePromptSegments("ask", {}).map((s) => s.path);
		assert.deepEqual(paths, [
			"ask/00-base.md", "ask/10-answers.md", "ask/20-grounding.md", "ask/30-visuals.md",
			"shared/10-voice.md", "shared/15-accuracy.md", "shared/35-side-conversations.md", "shared/40-formatting.md", "shared/45-figures.md",
		]);
		const prompt = composeInstructions("ask");
		assert.match(prompt, /^# Ask — questions about the class/);
		assert.match(prompt, /Answer first\./);
		assert.match(prompt, /\(name, p\. N\)/, "the materials' citation form, with pages");
		assert.match(prompt, /Not from the class material:/);
		assert.doesNotMatch(prompt, /ask_user_question|probe_done|plan_init/, "no question or plan mechanics");
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
		assert.match(html, /data-testid="course-mode-practice-line"[^>]*>The 1 skill you are learning\.</);
		assert.match(html, />Ask about this class</);
		assert.ok(html.indexOf("course-modes") < html.indexOf("course-exam-plan"), "at the top of the page");
	});

	it("Learn starts the same lesson as the Next up box (today's first lesson wins), Practice is Practice all", () => {
		assert.equal(learnTarget(payload({ plan: { skillsLeft: 2, reviewDue: 0, reviewBatch: 0, lessons: ["c"] }, nextUp: ["b", "c"] })), "c");
		assert.equal(learnTarget(payload()), "b");
		assert.equal(learnTarget(payload({ nextUp: [], notExamined: ["z"] })), "z");
		assert.equal(learnTarget(payload({ nextUp: [] })), undefined);
	});

	it("before a skill map exists, in every such state: Ask is available, Learn and Practice say what is needed first", () => {
		const states: Array<[string, CoursePayload, RegExp]> = [
			["new", noMap(), /add the class&#x27;s sources and draft one in Course settings/],
			["drafting", noMap({ drafting: true }), /being drafted now/],
			["draft", noMap({ course: { id: "course_a", title: "Calc", createdAt: "t", updatedAt: "t", status: "draft", skills: [], draft: { createdAt: "t", summary: "s", skills: [] } } }), /review and approve the draft in Course settings/],
			["error", noMap({ course: { id: "course_a", title: "Calc", createdAt: "t", updatedAt: "t", status: "error", skills: [], error: "boom" } }), /drafting failed, see Course settings/],
		];
		for (const [name, data, reason] of states) {
			const html = renderBody(data);
			assert.ok(available(html, "ask"), `${name}: Ask works`);
			assert.ok(!available(html, "learn") && !available(html, "practice"), `${name}: Learn and Practice wait`);
			assert.match(html, /<button[^>]*disabled=""[^>]*data-testid="course-mode-learn-start"/, name);
			assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*data-testid="course-mode-ask-start"/, name);
			assert.match(html, new RegExp(`data-testid="course-mode-learn-line"[^>]*>[^<]*${reason.source}`), name);
			assert.match(html, new RegExp(`data-testid="course-mode-practice-line"[^>]*>[^<]*${reason.source}`), name);
		}
	});

	it("nothing left to learn, nothing learned yet, everything known: the unavailable card says why", () => {
		const fresh = courseModeStates(payload({ learning: [], skills: [skillView("a"), skillView("b", { requires: ["a"] })], nextUp: ["a"] }));
		assert.equal(fresh.practice.available, false);
		assert.match(fresh.practice.line, /Finish a lesson first/);
		const known = courseModeStates(payload({ learning: [], nextUp: [], known: ["a", "b"] }));
		assert.equal(known.learn.available, false);
		assert.match(known.learn.line, /Every skill is learned/);
		assert.match(known.practice.line, /Every skill is known/);
	});

	it("lists Ask sessions with their own label, and the Ask card reopens the newest one with a New button beside it", () => {
		const data = payload({ sessions: [
			{ id: "chat_ask2", title: "Questions: Calc", mode: "ask", updatedAt: "t2" },
			{ id: "chat_1", title: "Learn: A", mode: "learn", updatedAt: "t" },
			{ id: "chat_ask1", title: "Questions: Calc", mode: "ask", updatedAt: "t1" },
		] });
		const html = renderBody(data);
		assert.match(html, /data-testid="course-sessions"[\s\S]*Questions: Calc[\s\S]*>Questions</, "the list labels it");
		assert.match(html, /data-testid="course-mode-ask-new"/);
		assert.match(html, /Continue your questions/);
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
		assert.deepEqual(view.ask!.filter((s) => !s.shared).map((s) => s.path), ["ask/00-base.md", "ask/10-answers.md", "ask/20-grounding.md", "ask/30-visuals.md"]);
		assert.ok(!view.ask!.some((s) => s.path === "system-prompt.md"));
		for (const p of ["ask/00-base.md", "ask/30-visuals.md"]) assert.ok(allSegmentPaths().includes(p), p);
	});

	it("an Ask section, and the shared fragments it composes say \"… and Ask\"", async () => {
		const view = (await (await promptsRoute.GET()).json()) as Parameters<typeof sectionedSegments>[0];
		const sections = sectionedSegments(view);
		assert.deepEqual(sections.map((s) => s.id), ["teacher", "prober", "practice", "placement", "ask", "shared"]);
		assert.equal(sections.find((s) => s.id === "ask")!.label, "Ask");
		const shared = sections.at(-1)!.segments;
		assert.match(shared.find((s) => s.path === "shared/40-formatting.md")!.usageHint!, /and Ask$/);
		assert.doesNotMatch(shared.find((s) => s.path === "shared/20-question-tools.md")!.usageHint!, /Ask/, "Ask does not compose question mechanics");
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
