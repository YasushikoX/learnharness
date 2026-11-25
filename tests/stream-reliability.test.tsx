import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, it } from "node:test";
import type { Agent, AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, type FauxResponseStep, type Message } from "@earendil-works/pi-ai";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import type { ChatInput } from "../src/core/input-events.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { TurnTimelineLine, TurnTimelineObservationLine, TurnTimelineStartLine } from "../src/server/turn-timeline.ts";

assert.equal(process.env.NODE_ENV, "test");
const scratch = mkdtempSync(join(tmpdir(), "lh-stream-reliability-"));
process.env.LH_DATA_DIR = join(scratch, "data");
process.env.LH_AUTH_FILE = join(scratch, "auth.json");
process.env.OPENROUTER_API_KEY = "test-key-presence-gate";
writeFileSync(process.env.LH_AUTH_FILE, "{}");
after(() => rmSync(scratch, { recursive: true, force: true }));
const TIMELINE_SCRIPT = fileURLToPath(new URL("../scripts/turn-timeline.mjs", import.meta.url));

const { MODEL_TEXT_PAUSE_MS, SessionModel, sseEvents } = await import("../components/session-core.ts");
const { CutOffReplyNotice } = await import("../components/turn-error.tsx");
const { PendingTurnIndicator } = await import("../components/chat.tsx");
const { TURN_ACTIVITY_LABELS } = await import("../components/pending-label.ts");
const { createTeacherAgent, makeGateRefusals } = await import("../src/agent/teacher-agent.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { runningTurn, settledTurnResponse } = await import("../src/server/turn-runs.ts");
const { runPiTurn, piTurnResponse, TURN_KEEPALIVE, TURN_KEEPALIVE_MS } = await import("../src/server/pi/ui-stream.ts");
const { createTurnTimelineWriter, observeAnswerKey, observeTurnActivity, TurnTimeline } = await import("../src/server/turn-timeline.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { newAnswerResult, newUserMessage } = await import("../src/core/native-messages.ts");
const { buildAnswer, normalizeOptions } = await import("../src/core/question-core.ts");
const { GET: readChat } = await import("../app/api/chats/[id]/route.ts");

const quiz = {
	lead: "The inner planets have an order.", question: "Which planet is closest to the Sun?",
	type: "check", nodeId: "planets", options: [{ label: "Venus" }, { label: "Mercury" }],
	correctAnswer: "Mercury", explanation: "Mercury is the innermost planet.",
};
const answer = {
	type: "answer", toolCallId: "planet-question",
	answer: buildAnswer({
		id: "planet-question", kind: "quiz", question: quiz.question, mode: "single-select",
		options: normalizeOptions(quiz.options), correctIndices: [1], createdAt: new Date().toISOString(),
	}, { values: ["Mercury"], thinking: "I remember the order.", confidence: 90 }),
} satisfies ChatInput;
const streamFrame = (event: object) => `data: ${JSON.stringify(event)}\n\n`;
const draft = { ...fauxAssistantMessage("The first half of the reply"), stopReason: "pending" };
const finish = () => fauxAssistantMessage("The remaining explanation.");

function lesson(steps: FauxResponseStep[], disconnect?: (attachment: number) => Response | undefined | Promise<Response | undefined>, options: { tools?: Record<string, AgentTool<any>>; seed?: LhMessage[] } = {}) {
	const { id } = chatStore.createChat("Planets");
	chatStore.saveSettings(id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	chatStore.saveMessages(id, options.seed ?? [
		newUserMessage("Teach me the planets."),
		{ ...fauxAssistantMessage([fauxToolCall("quiz", quiz, { id: answer.toolCallId })], { stopReason: "toolUse" }), id: "question" },
	]);
	const requests: ChatInput[] = [];
	const contexts: Message[][] = [];
	let attachments = 0;
	const faux = createFauxCore({});
	faux.setResponses(steps.map(step => (context, options, state, model) => {
		contexts.push(structuredClone(context.messages));
		return typeof step === "function" ? step(context, options, state, model) : step;
	}));
	const fetchView: typeof fetch = async (url, init) => {
		if (url === "/api/chat") {
			requests.push(JSON.parse(String(init?.body)).input as ChatInput);
			return handleChatRequest(new Request("http://test/api/chat", init), opts => createTeacherAgent(undefined, {
				...opts, tools: options.tools ?? {}, engine: { model: faux.getModel(), streamFn: faux.streamSimple },
			}));
		}
		if (String(url).endsWith("/stream")) {
			const interrupted = await disconnect?.(++attachments);
			if (interrupted) return interrupted;
			const run = runningTurn(id);
			return run ? piTurnResponse(run) : settledTurnResponse(id);
		}
		return readChat(new Request(`http://test${url}`), { params: Promise.resolve({ id }) });
	};
	const saved = () => chatStore.getChat(id)!.messages;
	const session = new SessionModel({ chatId: id, initialMessages: saved(), fetch: fetchView });
	return {
		session, saved, contexts, requests, id, fetch: fetchView, get attachments() { return attachments; },
		/** `learnerMessages`: the seed's message plus any the test sent after recovery. */
		assertOneAnswer(learnerMessages = 1) {
			assert.equal(requests.filter(input => input.type === "answer").length, 1);
			assert.equal(saved().filter(message => message.role === "toolResult" && message.toolCallId === answer.toolCallId).length, 1);
			assert.equal(saved().filter(message => message.role === "user").length, learnerMessages);
			assert.equal(new Set(saved().map(message => message.id)).size, saved().length);
			for (const messages of contexts) assert.equal(messages.filter(message => message.role === "toolResult" && message.toolCallId === answer.toolCallId).length, 1);
		},
	};
}

for (const hasText of [true, false]) {
	it(`offers ${hasText ? "Continue with partial text" : "Retry when length stopped before visible text"}`, async () => {
		const initial = hasText ? "An incomplete explanation…" : fauxThinking("Fixture-only private thought");
		const l = lesson([fauxAssistantMessage(initial, { stopReason: "length" }), finish]);
		await l.session.send(answer);
		assert.equal(l.session.getState().cutOffReply?.hasText, hasText);
		const notice = renderToStaticMarkup(<CutOffReplyNotice hasText={hasText} disabled={false} recover={() => {}} />);
		assert.match(notice, hasText ? /reply was cut off\.<\/span>.*>Continue</ : /before any text appeared\.<\/span>.*>Retry</);
		const before = l.saved();
		if (hasText) assert.match(JSON.stringify(l.session.getState().messages), /An incomplete explanation/);

		await l.session.recoverReply();
		assert.deepEqual(l.requests.map(input => input.type), ["answer", "continue-reply"]);
		l.assertOneAnswer();
		assert.deepEqual(l.saved().slice(0, before.length), before);
		assert.equal(l.session.getState().cutOffReply, undefined);
		const context = JSON.stringify(l.contexts.at(-1));
		assert.doesNotMatch(context, /lhCutoffHasText/);
		if (hasText) {
			assert.match(context, /Continue from where you stopped/);
			assert.match(context, /An incomplete explanation/);
		} else {
			// Nothing to continue: the turn re-runs from the saved answer, like Retry, with no marker and no cut-off.
			assert.doesNotMatch(context, /Fixture-only private thought|cut off/);
			assert.equal(l.contexts.at(-1)!.at(-1)?.role, "toolResult");
			assert.equal(l.saved().filter(message => message.role === "custom" && message.customType === "reply-recovery").length, 0);
		}
		assert.match(JSON.stringify(l.session.getState().messages), /The remaining explanation/);
	});
}

function twoBrokenViews(attachment: number) {
	if (attachment === 1) return new Response(TURN_KEEPALIVE + streamFrame({ type: "message_start", message: draft }));
	if (attachment === 2) return new Response(TURN_KEEPALIVE + streamFrame({ type: "agent_start" }));
}

for (const serverState of ["running", "finished", "failed"] as const) {
	it(`offers Retry after two drops when the server turn is ${serverState}`, async () => {
		const gate = Promise.withResolvers<void>();
		const output = lesson([async () => {
			await gate.promise;
			if (serverState === "failed") return fauxAssistantMessage("The first half of the reply", { stopReason: "error", errorMessage: "scripted connection failure" });
			return fauxAssistantMessage("The final saved response.");
		}, finish, () => fauxAssistantMessage("The next answer.")], twoBrokenViews);
		await output.session.send(answer);
		assert.equal(output.attachments, 2);
		assert.equal(output.session.getState().droppedStream, true);
		assert.match(JSON.stringify(output.session.getState().messages), /The first half of the reply/);
		assert.deepEqual(output.requests.map(request => request.type), ["answer"]);

		const handle = runningTurn(output.id);
		assert.ok(handle);
		if (serverState !== "running") {
			const settle = new Response(handle.subscribe()).text();
			gate.resolve();
			await settle;
			assert.equal(runningTurn(output.id), undefined);
		}
		const result = output.session.recoverReply();
		if (serverState === "running") {
			while (output.attachments < 3) await new Promise<void>(resolve => setImmediate(resolve));
			assert.equal(output.requests.length, 1);
			assert.match(JSON.stringify(output.session.getState().messages), /The first half of the reply/);
			gate.resolve();
		}
		await result;
		assert.equal(output.session.getState().droppedStream, false);
		assert.equal(output.session.getState().error, null);
		assert.match(JSON.stringify(output.session.getState().messages), serverState === "failed" ? /The remaining explanation/ : /The final saved response/);
		assert.deepEqual(output.requests.map(request => request.type), serverState === "failed" ? ["answer", "retry"] : ["answer"]);
		assert.equal(output.session.getState().nativeMessages.filter(message => message.role === "assistant" &&
			message.content.some(block => block.type === "text" && block.text === "The first half of the reply")).length, serverState === "failed" ? 1 : 0);
		output.assertOneAnswer();

		// The turn after recovery: the model receives the recovered reply once, and the learner sees it once.
		assert.equal(await output.session.send({ type: "text", text: "What comes next?" }), true);
		const [reply, nextReply] = serverState === "failed" ? ["The remaining explanation.", "The next answer."] : ["The final saved response.", "The remaining explanation."];
		assert.equal(JSON.stringify(output.contexts.at(-1)).split(reply).length - 1, 1);
		assert.equal(visibleTexts(output.session).filter(text => text === reply).length, 1);
		assert.equal(visibleTexts(output.session).filter(text => text === nextReply).length, 1);
		assert.equal(output.session.getState().error, null);
		output.assertOneAnswer(2);
	});
}

const visibleTexts = (session: InstanceType<typeof SessionModel>) =>
	session.getState().messages.flatMap(message => message.parts.flatMap(part => part.type === "text" && typeof part.text === "string" ? [part.text] : []));

function controlledAgent(run: (emit: (event: AgentEvent) => void) => Promise<void>) {
	let emit: (event: AgentEvent) => void = () => {};
	return {
		state: { messages: [] },
		subscribe(listener: typeof emit) { emit = listener; },
		continue: () => run(emit),
		abort() {},
	} as unknown as Agent;
}

it("writes keepalives immediately and only during idle time, including on reattach", async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const first = Promise.withResolvers<void>();
	const next = Promise.withResolvers<void>();
	const done = Promise.withResolvers<void>();
	const handle = runPiTurn({ agent: controlledAgent(async emit => {
		await first.promise;
		emit({ type: "agent_start" });
		await next.promise;
		emit({ type: "turn_start" });
		await done.promise;
		emit({ type: "agent_end", messages: [] });
	}), onFinish() {} });
	const view = handle.subscribe().getReader();
	const read = async (reader = view) => new TextDecoder().decode((await reader.read()).value);
	assert.equal(await read(), TURN_KEEPALIVE);
	first.resolve();
	assert.match(await read(), /agent_start/);
	t.mock.timers.tick(TURN_KEEPALIVE_MS - 1);
	next.resolve();
	assert.match(await read(), /turn_start/);
	const reattached = handle.subscribe().getReader();
	assert.equal(await read(reattached), TURN_KEEPALIVE);
	assert.match(await read(reattached), /agent_start/);
	assert.match(await read(reattached), /turn_start/);

	let pinged = false;
	const nextPing = read().then(frame => { pinged = true; return frame; });
	t.mock.timers.tick(1); // the previous deadline, before the newest write
	await Promise.resolve();
	assert.equal(pinged, false);
	t.mock.timers.tick(TURN_KEEPALIVE_MS - 1);
	assert.equal(await nextPing, TURN_KEEPALIVE);
	assert.equal(await read(reattached), TURN_KEEPALIVE);
	done.resolve();
	const parsed = sseEvents(reattached);
	assert.deepEqual(await parsed.next(), { done: false, value: { type: "agent_end", messages: [] } });
	assert.match(await read(view), /agent_end/);
	assert.deepEqual(await parsed.next(), { done: true, value: true });
	t.mock.timers.tick(TURN_KEEPALIVE_MS * 2);
	assert.equal((await reattached.read()).done, true);
	assert.equal(await read(view), "data: [DONE]\n\n");
	assert.equal((await view.read()).done, true);

	const onlyData = sseEvents(new Response(TURN_KEEPALIVE + streamFrame({ type: "agent_start" }) + TURN_KEEPALIVE + "data: [DONE]\n\n").body!.getReader());
	assert.deepEqual(await onlyData.next(), { done: false, value: { type: "agent_start" } });
	assert.deepEqual(await onlyData.next(), { done: true, value: true });
});

const identity = { turnId: "turn-fixture", chatId: "chat-fixture", provider: "claude-code", model: "opus", thinking: true };

it("shows Thinking again when a partial assistant response falls silent", async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let wire!: ReadableStreamDefaultController<Uint8Array>;
	const firstText = Promise.withResolvers<void>();
	const resumed = Promise.withResolvers<void>();
	const encoder = new TextEncoder();
	const frame = (type: string, message: unknown) => wire.enqueue(encoder.encode(streamFrame({ type, message })));
	const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; } }));
	const saved = { ...fauxAssistantMessage("Text resumed"), id: "saved" };
	const model = new SessionModel({
		chatId: identity.chatId, initialMessages: [], fetch: async url => String(url).endsWith("/stream") ? response : Response.json({ messages: [saved] }),
		onChange() {
			if (model.status !== "streaming" || model.getState().activity !== null) return;
			firstText.resolve();
			if (JSON.stringify(model.getState().messages).includes("Text resumed")) resumed.resolve();
		},
	});
	const watching = model.resumeStream(false);
	frame("message_start", draft);
	await firstText.promise;
	t.mock.timers.tick(MODEL_TEXT_PAUSE_MS - 1);
	assert.equal(model.getState().activity, null);
	t.mock.timers.tick(1);
	assert.equal(model.getState().activity, "thinking");
	frame("message_update", saved);
	await resumed.promise;
	assert.equal(model.getState().activity, null);
	frame("message_end", saved);
	wire.enqueue(encoder.encode("data: [DONE]\n\n"));
	wire.close();
	await watching;
	t.mock.timers.tick(MODEL_TEXT_PAUSE_MS * 2);
	assert.equal(model.getState().activity, null);
});

it("replays held checker and grader status on the existing line and writes a content-free timeline", async () => {
	const checker = Promise.withResolvers<string[]>();
	const grader = Promise.withResolvers<void>();
	const lines: TurnTimelineLine[] = [];
	let now = 0;
	const timeline = new TurnTimeline(identity, line => lines.push(line), () => now);
	const refused = makeGateRefusals(1, gate => timeline.refuse(gate), 3, gate => timeline.passOverBudget(gate));
	const message = fauxAssistantMessage([fauxThinking("private thought"), fauxText("visible words")], { stopReason: "length" });
	const handle = runPiTurn({
		timeline, agent: controlledAgent(async emit => {
			emit({ type: "agent_start" });
			emit({ type: "turn_start" });
			now = 4;
			emit({ type: "tool_execution_start", toolCallId: "tool-private-id", toolName: "quiz", args: { prompt: "private prompt" } });
			await observeAnswerKey(() => checker.promise);
			refused("prose", true, "private refusal reason");
			refused("prose", true, "another private refusal");
			await observeTurnActivity("grader", () => grader.promise);
			now = 23;
			emit({ type: "tool_execution_end", toolCallId: "tool-private-id", toolName: "quiz", isError: true, result: { details: "private answer" } });
			emit({ type: "turn_start" });
			emit({ type: "message_update", message, assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: message } });
			now = 29;
			emit({ type: "message_update", message, assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "private thought", partial: message } });
			emit({ type: "message_update", message, assistantMessageEvent: { type: "text_start", contentIndex: 1, partial: message } });
			now = 31;
			emit({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "visible words", partial: message } });
			now = 34;
			emit({ type: "message_end", message });
			emit({ type: "agent_end", messages: [message] });
		}), onFinish() {},
	});
	const checked = Promise.withResolvers<void>();
	const graded = Promise.withResolvers<void>();
	const reached: string[] = [];
	const model = new SessionModel({
		chatId: identity.chatId, initialMessages: [], fetch: async (url) => String(url).endsWith("/stream") ? piTurnResponse(handle) : Response.json({ messages: [{ ...message, id: "saved" }] }),
		onChange() {
			const activity = model.getState().activity;
			if (activity !== "checker" && activity !== "grader") return;
			reached.push(renderToStaticMarkup(<PendingTurnIndicator evaluating={false} label={TURN_ACTIVITY_LABELS[activity]} />));
			if (activity === "checker") checked.resolve();
			else graded.resolve();
		},
	});
	const watching = model.resumeStream(false);
	await checked.promise;
	assert.match(reached.at(-1)!, /CHECKING THE ANSWER KEY…/);
	const departing = handle.subscribe();
	await departing.cancel();
	now = 13;
	checker.resolve(["private checker feedback"]);
	await graded.promise;
	assert.match(reached.at(-1)!, /GRADING…/);
	now = 21;
	grader.resolve();
	await watching;
	assert.equal(model.getState().activity, null);
	const [line] = lines;
	assert.ok(line);
	assert.deepEqual(line, {
		...identity, startedAt: line.startedAt, durationMs: 34, firstEventMs: 0, firstVisibleTextMs: 31, longestEventGapMs: 19,
		thinkingSpans: [{ startMs: 23, durationMs: 6, source: "reported" }], textSpans: [{ startMs: 29, durationMs: 5 }],
		tools: [{ name: "quiz", startMs: 4, durationMs: 19 }], checkerSpans: [{ startMs: 4, durationMs: 9 }],
		graderSpans: [{ startMs: 13, durationMs: 8 }], processingSpans: [], gateRefusals: { "answer-key": 1, prose: 1 },
		// WP6: the second prose refusal is over its budget, so the call passed and the pass is counted
		refusalBudgetPasses: { prose: 1 },
		// A view leaving never ends a turn: it settled cleanly, and the departure is counted.
		stopReason: "length", streamEnd: "completed", errorKind: null, clientDrops: 1, visibleTextChars: 13, thinkingChars: 15,
		cliEnding: null, // a faux message: not from the claude CLI
	});
	assert.equal(lines.length, 1);
	assert.doesNotMatch(JSON.stringify(line), /private|visible words/);

	const encodedBytes = Buffer.byteLength(JSON.stringify(line) + "\n");
	const file = join(scratch, "logs", "turns.jsonl");
	const writer = createTurnTimelineWriter(file, 2 * encodedBytes);
	for (let i = 0; i < 3; i++) writer.append({ ...line, turnId: `turn-fixtur${i}` });
	await writer.flush();
	assert.equal((await stat(file)).size, encodedBytes);
	assert.equal((await stat(file + ".1")).size, 2 * encodedBytes);
	assert.equal(JSON.parse((await readFile(file, "utf8")).trim()).turnId, "turn-fixtur2");
});

it("counts a timeline write failure without breaking settlement", async () => {
	const writer = createTurnTimelineWriter(join(scratch, "auth.json", "turns.jsonl"));
	let saved = false;
	const handle = runPiTurn({
		agent: controlledAgent(async emit => { await Promise.resolve(); emit({ type: "agent_end", messages: [] }); }),
		timeline: new TurnTimeline(identity, writer.append),
		onFinish() { saved = true; },
	});
	assert.match(await new Response(handle.subscribe()).text(), /data: \[DONE\]/);
	await writer.flush();
	assert.equal(saved, true);
	assert.equal(writer.failures, 1);
});

it("follow-ups 1, timeline: a turn writes a content-free start line, and the summary lists turns that started and never finished", async t => {
	const lines: TurnTimelineLine[] = [];
	const starts: TurnTimelineStartLine[] = [];
	let now = 0;
	const timeline = new TurnTimeline(identity, line => lines.push(line), () => now, line => starts.push(line));
	timeline.begin();
	timeline.begin();
	assert.deepEqual(starts, [{ kind: "start", ...identity, startedAt: starts[0]?.startedAt }]);
	assert.equal(lines.length, 0, "the full line still waits for the end");
	now = 7;
	timeline.event({ type: "turn_start" });
	now = 9;
	timeline.finish(false);
	assert.equal(lines.length, 1);
	assert.equal(starts.length, 1);
	const [finished] = lines;
	assert.ok(finished);

	// On disk the start and the finish of one turn may sit on either side of a rotation; both files are read.
	const dir = mkdtempSync(join(scratch, "timeline-"));
	const file = join(dir, "turns.jsonl");
	const start = (turnId: string, minutesAgo: number): TurnTimelineStartLine => ({ ...starts[0]!, turnId, startedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString() });
	const startBytes = Buffer.byteLength(JSON.stringify(start("turn-a", 5)) + "\n");
	const finishBytes = Buffer.byteLength(JSON.stringify({ ...finished, turnId: "turn-a" }) + "\n");
	const maxBytes = 2 * startBytes + finishBytes - 1;
	const writer = createTurnTimelineWriter(file, maxBytes);
	writer.append(start("turn-a", 5));
	writer.append(start("turn-b", 90)); // hung, then the app was quit
	writer.append({ ...finished, turnId: "turn-a" }); // rotates: both starts move to turns.jsonl.1
	writer.append({ ...finished, turnId: "x".repeat(maxBytes) }); // too long: a counted write failure
	writer.append(start("turn-c", 0)); // still running
	await writer.flush();
	assert.equal(writer.failures, 1);
	assert.equal((await readFile(file + ".1", "utf8")).trim().split("\n").length, 2);
	const summary = (path: string) => JSON.parse(execFileSync(process.execPath, [TIMELINE_SCRIPT, path], { encoding: "utf8" }));
	const report = summary(file);
	assert.equal(report.turns, 1);
	assert.equal(report.timelineWriteFailures, 1);
	assert.deepEqual(report.turnsStartedNeverFinished.turns.map((turn: { turnId: string; startedMinutesAgo: number }) => [turn.turnId, turn.startedMinutesAgo]), [["turn-b", 90], ["turn-c", 0]]);
	assert.equal(report.turnsStartedNeverFinished.count, 2);
	assert.equal(report.slowestTurns[0].firstEventMs, 7);
	assert.equal(report.slowestTurns[0].cliEnding, null);
	assert.doesNotMatch(await readFile(file + ".1", "utf8"), /prompt|answer|text/i);

	// Observation lines (follow-ups 1, final round): not turns; counted, and shown beside the turns that never finished.
	const observed = join(dir, "observed.jsonl");
	const observation = (turnId: string): TurnTimelineObservationLine => ({ kind: "observation", turnId, chatId: identity.chatId, at: new Date().toISOString(), note: "result-before-stream-end" });
	writeFileSync(observed, [start("turn-hung", 30), observation("turn-hung"), start("turn-done", 40), observation("turn-done"), { ...finished, turnId: "turn-done" }, start("turn-quiet", 20)]
		.map(line => JSON.stringify(line)).join("\n") + "\n");
	const observedReport = summary(observed);
	assert.equal(observedReport.turns, 1, "an observation line is not a turn");
	assert.deepEqual(observedReport.claudeCliObservations, { "result-before-stream-end": { count: 2, inUnfinishedTurns: 1 } });
	assert.deepEqual(observedReport.turnsStartedNeverFinished.turns.map((turn: { turnId: string; observations: object }) => [turn.turnId, turn.observations]),
		[["turn-hung", { "result-before-stream-end": 1 }], ["turn-quiet", {}]]);

	// A log written before start lines existed (no `kind`, no cliEnding) still reads, with nothing unfinished.
	const old = join(dir, "old.jsonl");
	const { cliEnding: _cliEnding, ...oldLine } = finished;
	writeFileSync(old, JSON.stringify({ ...oldLine, turnId: "old-1" }) + "\n" + JSON.stringify({ ...oldLine, turnId: "old-2" }) + "\n");
	const oldReport = summary(old);
	assert.equal(oldReport.turns, 2);
	assert.equal(oldReport.unreadableLines, 0);
	assert.equal(oldReport.turnsStartedNeverFinished.count, 0);
	assert.equal(oldReport.timelineWriteFailures, 0);

	// The chat route begins the timeline of every claimed turn.
	const begin = t.mock.method(TurnTimeline.prototype, "begin");
	const l = lesson([fauxAssistantMessage("A short reply.")], undefined, { seed: [{ ...newUserMessage("Hello."), id: "hello" }, { ...fauxAssistantMessage("Hi."), id: "hi" }] });
	assert.equal(await l.session.send({ type: "text", text: "Teach me the planets." }), true);
	assert.equal(begin.mock.callCount(), 1);
});

// ─── Review 1 fixes (wp1-review-1.md): one regression test per item, and one end-to-end test per recovery path that
// asserts together what the learner sees, what the stored chat holds, and what the model receives on the next turn. ──

const { projectView } = await import("../src/core/view.ts");
const { sendToUserTool } = await import("../src/agent/tools/send-to-user.ts");
const { cutOffReplyAtEnd, requireCutOffReply, retryTurnDrops, RETRY_AFTER_COMPACTION_TEXT } = await import("../src/core/input-events.ts");
const { malformedQuestionsOf, newReplyRecoveryMarker } = await import("../src/core/native-messages.ts");
const { newCompactionMarker, serializeForSummary } = await import("../src/core/compaction.ts");
const { viewKeepalive } = await import("../src/server/pi/ui-stream.ts");
const { claimPreparingTurn } = await import("../src/server/turn-preparation.ts");
const { placementGradedBeforeTurn } = await import("../src/server/chat-handler.ts");
const { cutOffRecoveryDisabled, RetryUnavailableNote } = await import("../components/turn-error.tsx");

const cutOff = (content: Parameters<typeof fauxAssistantMessage>[0] = fauxThinking("Fixture-only private thought")) =>
	fauxAssistantMessage(content, { stopReason: "length" });
const say = (message: string, id: string) => fauxAssistantMessage([fauxToolCall("send_to_user", { message }, { id })], { stopReason: "toolUse" });
const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;
const lengthStops = (context: Message[] | undefined) => (context ?? []).filter(message => message.role === "assistant" && message.stopReason === "length").length;
const recoveryMarkers = (messages: LhMessage[]) => messages.filter(message => message.role === "custom" && message.customType === "reply-recovery").length;

it("item 1: a continuation stays visible after a send_to_user cut-off, every part exactly once", () => {
	let n = 0;
	const id = () => `m${++n}`;
	const delivered = (message: string): LhMessage[] => {
		const call = `say-${++n}`;
		return [{ ...say(message, call), id: id() }, {
			id: id(), role: "toolResult", toolCallId: call, toolName: "send_to_user",
			content: [{ type: "text", text: "Message received for display." }], details: {}, isError: false, timestamp: 1,
		}];
	};
	const cut = (content?: Parameters<typeof cutOff>[0]): LhMessage => ({ ...cutOff(content), id: id(), lhCutoffHasText: true });
	const prose = (text: string): LhMessage => ({ ...fauxAssistantMessage(text), id: id() });
	const learner = { ...newUserMessage("Teach me the planets."), id: "learner" };
	const sequences: [string, LhMessage[], string[]][] = [
		["the reviewer's sequence", [learner, ...delivered("Part one before cut-off"), cut(), newReplyRecoveryMarker(), prose("Part two after continuation.")],
			["Part one before cut-off", "Part two after continuation."]],
		["a continuation that itself uses send_to_user", [learner, ...delivered("Part one before cut-off"), cut(), newReplyRecoveryMarker(),
			...delivered("Part two through the tool, in full."), prose("Part two through the tool, in full.")], ["Part one before cut-off", "Part two through the tool, in full."]],
		["a cut-off that mixed plain text and send_to_user", [learner, ...delivered("Part one before cut-off"), cut([fauxText("Some plain prose before the limit")]),
			newReplyRecoveryMarker(), prose("Part two after continuation.")], ["Part one before cut-off", "Some plain prose before the limit", "Part two after continuation."]],
		["two cut-offs in a row", [learner, ...delivered("Part one before cut-off"), cut(), newReplyRecoveryMarker(), ...delivered("Part two before another cut"),
			cut(), newReplyRecoveryMarker(), prose("Part three closes the reply.")], ["Part one before cut-off", "Part two before another cut", "Part three closes the reply."]],
	];
	for (const [name, record, parts] of sequences) {
		const texts = projectView(record).filter(message => message.role === "assistant")
			.flatMap(message => message.parts.flatMap(part => part.type === "text" ? [part.text as string] : []));
		for (const part of parts) assert.equal(texts.filter(text => text === part).length, 1, `${name}: ${part}`);
		assert.equal(texts.length, parts.length, name);
	}
});

it("end to end, Continue: a send_to_user cut-off continues; seen once, stored once, sent once on the next turn", async () => {
	const l = lesson([
		say("Part one before the cut.", "say-1"),
		cutOff(),
		fauxAssistantMessage("Part two after continuation."),
		fauxAssistantMessage("The next answer."),
	], undefined, { tools: { send_to_user: sendToUserTool } });
	await l.session.send(answer);
	assert.equal(l.session.getState().cutOffReply?.hasText, true);
	await l.session.recoverReply();
	assert.deepEqual(l.requests.map(input => input.type), ["answer", "continue-reply"]);
	assert.equal(l.session.getState().cutOffReply, undefined);
	for (const part of ["Part one before the cut.", "Part two after continuation."]) assert.equal(visibleTexts(l.session).filter(text => text === part).length, 1, part);
	assert.equal(recoveryMarkers(l.saved()), 1);
	l.assertOneAnswer();

	await l.session.send({ type: "text", text: "What comes next?" });
	const next = JSON.stringify(l.contexts.at(-1));
	assert.equal(occurrences(next, "Part one before the cut."), 1);
	assert.equal(occurrences(next, "Part two after continuation."), 1);
	assert.equal(occurrences(next, "Your previous reply was cut off"), 1, "the answered Continue instruction stays between the two halves");
	assert.equal(visibleTexts(l.session).filter(text => text === "Part two after continuation.").length, 1);
	l.assertOneAnswer(2);
});

for (const whitespace of [false, true]) it(`follow-ups 1, item 6${whitespace ? " and concern 2" : ""}: a kept cut-off of thinking alone${whitespace ? " and whitespace-only text" : ""} (after send_to_user prose) never reaches the model as a thinking-only turn`, async () => {
	const l = lesson([
		say("Part one before the cut.", "say-1"),
		whitespace ? cutOff([fauxThinking("Fixture-only private thought"), fauxText(" \n ")]) : cutOff(),
		fauxAssistantMessage("Part two after continuation."),
		fauxAssistantMessage("The next answer."),
	], undefined, { tools: { send_to_user: sendToUserTool } });
	await l.session.send(answer);
	const kept = l.saved().find(message => message.role === "assistant" && message.stopReason === "length");
	const noText = (message: Message) => message.role === "assistant" && message.content.every(block => block.type === "thinking" || (block.type === "text" && !block.text.trim()));
	assert.ok(kept?.role === "assistant" && kept.lhCutoffHasText === true && noText(kept), "the kept cut-off holds thinking only");
	if (whitespace) assert.ok(kept.content.some(block => block.type === "text"), "with a whitespace-only text block beside it");
	await l.session.recoverReply();
	await l.session.send({ type: "text", text: "What comes next?" });
	const thinkingOnly = (messages: Message[]) => messages.filter(noText).length;
	assert.equal(l.contexts.length, 4);
	for (const context of l.contexts.slice(2)) {
		assert.equal(thinkingOnly(context), 0);
		assert.doesNotMatch(JSON.stringify(context), /Fixture-only private thought/);
		assert.equal(occurrences(JSON.stringify(context), "Part one before the cut."), 1);
	}
	assert.equal(occurrences(JSON.stringify(l.contexts[2]), "Your previous reply was cut off"), 1, "Continue still asks for the rest");
	assert.ok(l.saved().some(message => message.id === kept.id), "the cut-off stays in the record");
	l.assertOneAnswer(2);
});

it("follow-ups 1, item 7: a Continue cut off before it added text says so, and its Retry re-runs the continuation; an empty cut-off right after a reply is refused", async () => {
	const l = lesson([fauxAssistantMessage("Part one of the reply", { stopReason: "length" }), cutOff(), fauxAssistantMessage("Part two of the reply.")]);
	await l.session.send(answer);
	assert.equal(l.session.getState().cutOffReply?.hasText, true);
	await l.session.recoverReply();
	const cutoff = l.session.getState().cutOffReply;
	assert.deepEqual({ hasText: cutoff?.hasText, afterContinue: cutoff?.afterContinue }, { hasText: false, afterContinue: true });
	const notice = renderToStaticMarkup(<CutOffReplyNotice hasText={false} afterContinue disabled={false} recover={() => {}} />);
	assert.match(notice, /The continuation was cut off before it added any text\.<\/span>.*>Retry</);
	assert.doesNotMatch(notice, /before any text appeared/);
	assert.match(renderToStaticMarkup(<CutOffReplyNotice hasText={false} disabled={false} recover={() => {}} />), /before any text appeared/, "a first reply keeps its wording");
	await l.session.recoverReply();
	assert.deepEqual(l.requests.map(input => input.type), ["answer", "continue-reply", "continue-reply"]);
	for (const part of ["Part one of the reply", "Part two of the reply."]) assert.equal(visibleTexts(l.session).filter(text => text === part).length, 1, part);
	assert.equal(l.session.getState().cutOffReply, undefined);
	l.assertOneAnswer();

	const learner: LhMessage = { ...newUserMessage("Teach me the planets."), id: "learner" };
	const reply: LhMessage = { ...fauxAssistantMessage("A complete reply."), id: "reply" };
	const empty: LhMessage = { ...cutOff(), id: "empty" };
	assert.equal(cutOffReplyAtEnd([learner, empty])?.afterContinue, undefined);
	assert.doesNotThrow(() => requireCutOffReply([learner, empty], "empty"));
	assert.throws(() => requireCutOffReply([learner, reply, empty], "empty"), /no input to retry from/);
	assert.throws(() => requireCutOffReply([empty], "empty"), /no input to retry from/);
});

it("end to end, Retry for an empty cut-off: the cut-off stays stored but never reaches the model again", async () => {
	const l = lesson([cutOff(), fauxAssistantMessage("The full reply."), fauxAssistantMessage("The next answer.")]);
	await l.session.send(answer);
	assert.equal(l.session.getState().cutOffReply?.hasText, false);
	await l.session.recoverReply();
	assert.equal(l.session.getState().cutOffReply, undefined);
	assert.equal(l.session.getState().error, null);
	assert.equal(visibleTexts(l.session).filter(text => text === "The full reply.").length, 1);
	assert.equal(l.saved().filter(message => message.role === "assistant" && message.stopReason === "length").length, 1, "failed attempts stay on disk");
	assert.equal(recoveryMarkers(l.saved()), 0);
	assert.equal(lengthStops(l.contexts.at(-1)), 0);

	await l.session.send({ type: "text", text: "What comes next?" });
	const next = l.contexts.at(-1);
	assert.equal(lengthStops(next), 0);
	assert.doesNotMatch(JSON.stringify(next), /cut off|Fixture-only private thought/);
	assert.equal(occurrences(JSON.stringify(next), "The full reply."), 1);
	l.assertOneAnswer(2);
});

it("item 3: when the recovery turn of an empty cut-off fails, its Retry continues from the same answer", async () => {
	const l = lesson([
		cutOff(),
		fauxAssistantMessage("The first half", { stopReason: "error", errorMessage: "scripted provider failure" }),
		fauxAssistantMessage("The full reply."),
		fauxAssistantMessage("The next answer."),
	]);
	await l.session.send(answer);
	await l.session.recoverReply();
	assert.match(l.session.getState().error?.message ?? "", /scripted provider failure/);
	assert.equal(l.session.getState().cutOffReply, undefined, "one recovery UI: the failure banner's Retry");
	await l.session.send({ type: "retry" });
	assert.deepEqual(l.requests.map(input => input.type), ["answer", "continue-reply", "retry"]);
	assert.equal(l.session.getState().error, null);
	const retried = l.contexts.at(-1)!;
	assert.equal(lengthStops(retried), 0);
	assert.equal(retried.at(-1)?.role, "toolResult");
	assert.equal(visibleTexts(l.session).filter(text => text === "The full reply.").length, 1);

	await l.session.send({ type: "text", text: "What comes next?" });
	assert.equal(lengthStops(l.contexts.at(-1)), 0);
	assert.doesNotMatch(JSON.stringify(l.contexts.at(-1)), /cut off/);
	l.assertOneAnswer(2);
});

it("item 3: two empty cut-offs in a row recover without replaying either", async () => {
	const l = lesson([cutOff(), cutOff(), fauxAssistantMessage("The full reply.")]);
	await l.session.send(answer);
	await l.session.recoverReply();
	assert.equal(l.session.getState().cutOffReply?.hasText, false);
	await l.session.recoverReply();
	assert.equal(l.session.getState().error, null);
	assert.equal(lengthStops(l.contexts.at(-1)), 0);
	assert.equal(l.contexts.at(-1)!.at(-1)?.role, "toolResult");
	assert.equal(visibleTexts(l.session).filter(text => text === "The full reply.").length, 1);
	l.assertOneAnswer();
});

it("item 3: the recovery marker never reaches a compaction summary, and neither does an empty cut-off", () => {
	const summary = serializeForSummary([
		newUserMessage("Teach me the planets."),
		{ ...fauxAssistantMessage("A first half"), stopReason: "length", id: "half" },
		newReplyRecoveryMarker(),
		{ ...fauxAssistantMessage("The second half."), id: "second" },
		{ ...cutOff(), id: "empty" },
	]);
	assert.doesNotMatch(summary, /cut off|SYSTEM NOTE|Fixture-only private thought/);
	assert.match(summary, /A first half[\s\S]*The second half\./);
});

it("item 3 and 4: an empty cut-off that compaction kept first offers no Retry, says why, and compaction keeps working", async () => {
	const seed: LhMessage[] = [
		{ ...newUserMessage("OLD HISTORY the summary replaced"), id: "old" },
		{ ...fauxAssistantMessage("An old reply"), id: "old-reply" },
		{ ...newUserMessage("Teach me the planets."), id: "ask" },
		{ ...cutOff(), id: "cut" },
	];
	seed.push(newCompactionMarker("SUMMARY of the earlier lesson", { firstKeptMessageId: "cut", tokensBefore: 1, model: "fixture", at: new Date().toISOString() }));
	const l = lesson([fauxAssistantMessage("A reply after compaction.")], undefined, { seed });
	const cutoff = l.session.getState().cutOffReply;
	assert.deepEqual({ hasText: cutoff?.hasText, blocked: cutoff?.blockedByCompaction }, { hasText: false, blocked: true });
	const notice = renderToStaticMarkup(<CutOffReplyNotice hasText={false} blockedByCompaction disabled={false} recover={() => {}} />);
	assert.match(notice, /cannot be retried after compaction/);
	assert.doesNotMatch(notice, /<button/);
	assert.throws(() => requireCutOffReply(l.saved(), "cut"), /cannot be retried after compaction/);
	const refused = await handleChatRequest(new Request("http://test/api/chat", { method: "POST", body: JSON.stringify({ chatId: l.id, input: { type: "continue-reply", messageId: "cut" } }) }));
	assert.equal(refused.status, 400);
	await l.session.recoverReply();
	assert.deepEqual(l.requests, [], "the client never sends a blocked recovery");

	await l.session.send({ type: "text", text: "Let us go on." });
	const next = JSON.stringify(l.contexts.at(-1));
	assert.match(next, /SUMMARY of the earlier lesson/);
	assert.doesNotMatch(next, /OLD HISTORY|Fixture-only private thought/);
	assert.equal(lengthStops(l.contexts.at(-1)), 0);
	assert.equal(visibleTexts(l.session).filter(text => text === "A reply after compaction.").length, 1);
});

it("item 2: a recovery whose turn settles before the reattach leaves no banner and no dropped flag", async () => {
	const gate = Promise.withResolvers<void>();
	const l: ReturnType<typeof lesson> = lesson([async () => {
		await gate.promise;
		return fauxAssistantMessage("The final saved response.");
	}, () => fauxAssistantMessage("The next answer.")], async attachment => {
		if (attachment <= 2) return twoBrokenViews(attachment);
		// The record said the turn was running; it settles before this view attaches (turn-settled, no agent_start).
		const handle = runningTurn(l.id)!;
		const settled = new Response(handle.subscribe()).text();
		gate.resolve();
		await settled;
		assert.equal(runningTurn(l.id), undefined);
		return settledTurnResponse(l.id);
	});
	await l.session.send(answer);
	assert.equal(l.session.getState().droppedStream, true);
	await l.session.recoverReply();
	const state = l.session.getState();
	assert.deepEqual({ status: state.status, droppedStream: state.droppedStream, error: state.error }, { status: "ready", droppedStream: false, error: null });
	assert.equal(visibleTexts(l.session).filter(text => text === "The final saved response.").length, 1);
	assert.deepEqual(l.requests.map(input => input.type), ["answer"]);
	l.assertOneAnswer();
	await l.session.send({ type: "text", text: "What comes next?" });
	assert.equal(occurrences(JSON.stringify(l.contexts.at(-1)), "The final saved response."), 1);
	l.assertOneAnswer(2);
});

it("item 4: a retained failure before a compaction cannot be retried, and the banner says why", async () => {
	const learner: LhMessage = { ...newUserMessage("Teach me the planets."), id: "learner" };
	const compaction = newCompactionMarker("SUMMARY", { firstKeptMessageId: "learner", tokensBefore: 1, model: "fixture", at: new Date().toISOString() });
	assert.throws(() => retryTurnDrops([learner, compaction], compaction.id, "Network failure"), /Network failure[\s\S]*cannot be retried after compaction/);
	assert.deepEqual([...retryTurnDrops([compaction, learner], learner.id, "Network failure")], [], "a failure after compaction still retries");

	// The dropped-stream Retry reads server truth: a retained failure behind a compaction ends as that explained state.
	let record: Record<string, unknown> = { messages: [learner], turnInFlight: true };
	const posts: string[] = [];
	const model = new SessionModel({
		chatId: "retained-failure", initialMessages: [learner],
		fetch: async (url, init) => {
			if (String(url) === "/api/chat") { posts.push(String(init?.body)); return new Response("unexpected", { status: 500 }); }
			if (String(url).endsWith("/stream")) return new Response(streamFrame({ type: "agent_start" }));
			return Response.json(record);
		},
	});
	await model.resumeStream(false);
	assert.equal(model.getState().droppedStream, true);
	record = { messages: [learner, compaction], turnInFlight: false, turnError: "Network failure" };
	await model.recoverReply();
	const state = model.getState();
	assert.deepEqual(posts, []);
	assert.deepEqual({ dropped: state.droppedStream, error: state.error?.message, blocked: state.retryBlocked }, { dropped: false, error: "Network failure", blocked: true });
	assert.match(renderToStaticMarkup(<RetryUnavailableNote />), new RegExp(RETRY_AFTER_COMPACTION_TEXT.replace(/\./g, "\\.")));

	const provider = { ...fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "fetch failed" }), id: "failed" } as LhMessage;
	assert.equal(new SessionModel({ chatId: "a", initialMessages: [learner, provider, compaction], fetch }).getState().retryBlocked, true);
	assert.equal(new SessionModel({ chatId: "b", initialMessages: [learner, compaction, provider], fetch }).getState().retryBlocked, false);
	assert.equal(new SessionModel({ chatId: "c", initialMessages: [compaction, learner], initialError: "Network failure", fetch }).getState().retryBlocked, false);
});

// ─── Follow-ups 1 (wp1-review-2.md, open follow-ups 1, 2 and 4) ──────────────────────────────────────────────────────
// After any order of drop, reattach, settle, Retry and sync the learner sees exactly one of: the reply with no banner; a
// failure with a working Retry; the dropped banner with a working Retry.

/** A session against a scripted server: `record()` answers every record GET (a Response is sent as is), `views` each
 *  /stream attach in order, `post` every POST. */
function scriptedSession(chatId: string, initial: LhMessage[], record: () => object | Response, views: (() => Response)[], post: (input: ChatInput) => Response = () => Response.json({ ok: true })) {
	const posts: ChatInput[] = [];
	let view = 0;
	const session = new SessionModel({
		chatId, initialMessages: initial,
		fetch: async (url, init) => {
			if (String(url) === "/api/chat") {
				const input = JSON.parse(String(init?.body)).input as ChatInput;
				posts.push(input);
				return post(input);
			}
			if (String(url).endsWith("/stream")) return views[view++]?.() ?? new Response("no view scripted", { status: 500 });
			const value = record();
			return value instanceof Response ? value : Response.json(value);
		},
	});
	return { session, posts };
}
const learnerAsk: LhMessage = { ...newUserMessage("Teach me the planets."), id: "learner" };
const dropMidReply = () => new Response(TURN_KEEPALIVE + streamFrame({ type: "message_start", message: draft }));
const fullReplay = (reply: object) => () => new Response(streamFrame({ type: "agent_start" }) + streamFrame({ type: "message_start", message: reply }) +
	streamFrame({ type: "message_end", message: reply }) + streamFrame({ type: "agent_end", messages: [] }) + "data: [DONE]\n\n");
const banner = (session: InstanceType<typeof SessionModel>) => {
	const state = session.getState();
	return { status: state.status, droppedStream: state.droppedStream, error: state.error?.message ?? null };
};

it("follow-ups 1, finding 1: a reply that fully arrived while the settle read failed loses its drop banner at the next successful sync", async () => {
	const reply = { ...fauxAssistantMessage("The whole reply, longer than the part seen before the drop."), id: "reply" };
	let record: object | Response = { messages: [learnerAsk], turnInFlight: true };
	const { session } = scriptedSession("finding-1", [learnerAsk], () => record, [dropMidReply, () => {
		record = new Response("unavailable", { status: 503 }); // the settle read after [DONE] fails
		return fullReplay(reply)();
	}]);
	await session.resumeStream(false);
	assert.equal(session.getState().reconciliation, "failed");
	assert.equal(visibleTexts(session).filter(text => text === "The whole reply, longer than the part seen before the drop.").length, 1);

	record = { messages: [learnerAsk, reply], turnInFlight: false };
	assert.equal(await session.reconcile(), true, "Retry syncing");
	assert.deepEqual(banner(session), { status: "ready", droppedStream: false, error: null });
	assert.equal(visibleTexts(session).filter(text => text === "The whole reply, longer than the part seen before the drop.").length, 1);
	assert.doesNotMatch(JSON.stringify(session.getState().messages), /The first half of the reply/);
});

it("follow-ups 1, finding 2: a Retry refused because another tab retried first leaves no banner once the record recovers", async () => {
	const failed = { ...fauxAssistantMessage("The first half of the reply", { stopReason: "error", errorMessage: "scripted connection failure" }), id: "failed" } as LhMessage;
	const retried = { ...fauxAssistantMessage("The other tab's reply."), id: "retried" } as LhMessage;
	let record: object = { messages: [learnerAsk], turnInFlight: true };
	const { session, posts } = scriptedSession("finding-2", [learnerAsk], () => record, [dropMidReply, () => {
		record = { messages: [learnerAsk, failed], turnInFlight: false }; // the server turn failed meanwhile
		return new Response(streamFrame({ type: "agent_start" }));
	}], () => {
		record = { messages: [learnerAsk, failed, retried], turnInFlight: false }; // tab B's Retry landed first
		return Response.json({ error: "The session changed before Retry. Refresh the session." }, { status: 400 });
	});
	await session.resumeStream(false);
	assert.equal(session.getState().droppedStream, true);
	await session.recoverReply();
	assert.deepEqual(posts, [{ type: "retry", failedHead: "failed" }]);
	assert.match(session.getState().error?.message ?? "", /session changed before Retry/);

	await session.readRecord(); // the page's sync after record-changed
	assert.deepEqual(banner(session), { status: "ready", droppedStream: false, error: null });
	assert.equal(visibleTexts(session).filter(text => text === "The other tab's reply.").length, 1);
	assert.equal(posts.length, 1, "nothing was sent again");
});

it("follow-ups 1, finding 4: when the server lost the turn (a restart) the partial stays under the dropped banner, and its Retry sends the turn again", async () => {
	const reply = { ...fauxAssistantMessage("The reply after the restart, longer than the lost part."), id: "after-restart" };
	let record: object | Response = { messages: [learnerAsk], turnInFlight: true };
	const { session, posts } = scriptedSession("finding-4", [learnerAsk], () => record, [dropMidReply, () => {
		record = { messages: [learnerAsk], turnInFlight: false }; // the restarted server has no turn and no reply
		return settledTurnResponse();
	}, () => {
		record = { messages: [learnerAsk, reply], turnInFlight: false }; // the turn sent again settles
		return fullReplay(reply)();
	}], () => {
		record = { messages: [learnerAsk], turnInFlight: true };
		return Response.json({ ok: true });
	});
	await session.resumeStream(false);
	assert.deepEqual(banner(session), { status: "ready", droppedStream: true, error: "The connection dropped before the turn completed." });
	assert.match(JSON.stringify(session.getState().messages), /The first half of the reply/);

	await session.readRecord(); // a later sync keeps it: the record still holds no reply
	assert.equal(session.getState().droppedStream, true);
	assert.match(JSON.stringify(session.getState().messages), /The first half of the reply/);
	assert.deepEqual(posts, [], "no automatic retry");

	const saved = record;
	record = new Response("offline", { status: 503 });
	await session.recoverReply(); // offline: the same banner and its Retry stay
	assert.deepEqual(banner(session), { status: "ready", droppedStream: true, error: "The connection dropped before the turn completed." });
	assert.match(JSON.stringify(session.getState().messages), /The first half of the reply/);
	record = saved;
	await session.recoverReply();
	assert.deepEqual(posts, [{ type: "continue" }], "the turn runs again from the saved input; the input is not sent again");
	assert.deepEqual(banner(session), { status: "ready", droppedStream: false, error: null });
	assert.equal(visibleTexts(session).filter(text => text === "The reply after the restart, longer than the lost part.").length, 1);
	assert.doesNotMatch(JSON.stringify(session.getState().messages), /The first half of the reply/);
});

it("follow-ups 1, finding 4: the server runs a continue on a record that ends on the learner's input, with one saved input", async () => {
	for (const seed of [
		[{ ...newUserMessage("Teach me the planets."), id: "ask" }],
		[{ ...newUserMessage("Teach me the planets."), id: "ask" }, { ...fauxAssistantMessage([fauxToolCall("quiz", quiz, { id: answer.toolCallId })], { stopReason: "toolUse" }), id: "question" },
			{ ...newAnswerResult(answer.toolCallId, "quiz", answer.answer), id: "saved-answer" }],
	] as LhMessage[][]) {
		const l = lesson([fauxAssistantMessage("The reply after the restart.")], undefined, { seed });
		assert.equal(await l.session.send({ type: "continue" }), true);
		assert.equal(visibleTexts(l.session).filter(text => text === "The reply after the restart.").length, 1);
		assert.equal(l.saved().filter(message => message.role === "user").length, 1);
		assert.equal(l.saved().filter(message => message.role === "toolResult").length, seed.length - 1 ? 1 : 0);
		assert.equal(l.session.getState().error, null);
	}
});

// ─── Follow-ups 1, fix round (council/reviews/followups-1-review-1.md, findings 2 and 3, concern 1, item 7) ──────────

const { owesTutorReply, newNextMessage, newSketchDisputeMarker, newProblemDismissedMarker, newThinkingMessage } = await import("../src/core/native-messages.ts");
const { newLessonFinishedMarker } = await import("../src/core/course-session.ts");
const { CONTINUE_NOT_OWED_TEXT } = await import("../src/core/input-events.ts");
const { dismissedAnswer } = await import("../src/core/question-core.ts");
const { READ_SKETCH_TOOL } = await import("../src/core/sketch-gate.ts");

const STREAM_DROPPED_TEXT = "The connection dropped before the turn completed.";
const quizCall: LhMessage = { ...fauxAssistantMessage([fauxToolCall("quiz", quiz, { id: answer.toolCallId })], { stopReason: "toolUse" }), id: "question" };
const quizAnswered: LhMessage = { ...newAnswerResult(answer.toolCallId, "quiz", answer.answer), id: "answered" };
const earlierReply: LhMessage = { ...fauxAssistantMessage("An earlier reply."), id: "earlier-reply" };
const POSE_LEAD = "Here is a problem to try on your own, longer than the part seen before the drop.";
const poseCall: LhMessage = { ...fauxAssistantMessage([fauxText(POSE_LEAD), fauxToolCall("problem", { statement: "Order the inner planets." }, { id: "pose" })], { stopReason: "toolUse" }), id: "pose-call" };
const posed: LhMessage = { id: "posed", role: "toolResult", toolCallId: "pose", toolName: "problem", content: [{ type: "text", text: "Problem posed." }], isError: false, timestamp: 0 };
const readCall: LhMessage = { ...fauxAssistantMessage([fauxToolCall(READ_SKETCH_TOOL, { sketchId: "sk_1" }, { id: "read" })], { stopReason: "toolUse" }), id: "read-call" };
const doubtfulRead: LhMessage = { id: "doubtful", role: "toolResult", toolCallId: "read", toolName: READ_SKETCH_TOOL, content: [{ type: "text", text: "Two marks are unclear." }], details: { doubts: 2 }, isError: false, timestamp: 0 } as LhMessage;
const quizDismissed: LhMessage = { ...newAnswerResult(answer.toolCallId, "quiz", dismissedAnswer("quiz", quiz.question)), id: "dismissed" };
const failedReply: LhMessage = { ...fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "fetch failed" }), id: "failed-reply" } as LhMessage;
const compactionAtEnd = () => newCompactionMarker("SUMMARY", { firstKeptMessageId: "learner", tokensBefore: 1, model: "fixture", at: new Date().toISOString() });

it("follow-ups 1 fix round, finding 3 and concern 1: one definition of a record the tutor still owes a reply, and the server's continue guard uses it", async () => {
	const owed: [string, LhMessage[]][] = [
		["a learner message", [learnerAsk]],
		["an answered question", [learnerAsk, quizCall, quizAnswered]],
		["Next", [learnerAsk, earlierReply, newNextMessage()]],
		["a dispute", [learnerAsk, earlierReply, newSketchDisputeMarker("sk_1", "That is a 3, not an 8.")]],
		["Finish", [learnerAsk, earlierReply, newLessonFinishedMarker("learn")]],
		["Continue", [learnerAsk, { ...fauxAssistantMessage("A first half"), stopReason: "length", id: "half" } as LhMessage, newReplyRecoveryMarker()]],
		["a practice submission", [learnerAsk, poseCall, posed, newThinkingMessage("pose", "Mercury, Venus, Earth, Mars.")]],
		["a learner message with a compaction marker after it", [learnerAsk, compactionAtEnd()]],
	];
	const settled: [string, LhMessage[]][] = [
		["an empty record", []],
		["an assistant reply", [learnerAsk, earlierReply]],
		["a failed reply", [learnerAsk, failedReply]],
		["a posed problem", [learnerAsk, poseCall, posed]],
		["a doubtful sketch read", [learnerAsk, readCall, doubtfulRead]],
		["a dismissed question", [learnerAsk, quizCall, quizDismissed]],
		["a dismissed problem", [learnerAsk, poseCall, posed, newProblemDismissedMarker("pose")]],
	];
	for (const [what, record] of owed) assert.equal(owesTutorReply(record), true, what);
	for (const [what, record] of settled) assert.equal(owesTutorReply(record), false, what);

	for (const [what, seed] of settled.filter(([what]) => what !== "an empty record")) {
		const l = lesson([fauxAssistantMessage("A turn that must not run.")], undefined, { seed });
		const refused = await handleChatRequest(new Request("http://test/api/chat", { method: "POST", body: JSON.stringify({ chatId: l.id, input: { type: "continue" } }) }));
		assert.equal(refused.status, 400, what);
		assert.equal((await refused.json()).error, CONTINUE_NOT_OWED_TEXT, what);
		assert.equal(l.contexts.length, 0, `${what}: no turn ran`);
		assert.deepEqual(l.saved(), seed, `${what}: nothing saved`);
	}
	for (const [what, seed] of owed.slice(0, 3)) {
		const l = lesson([fauxAssistantMessage("The owed reply.")], undefined, { seed });
		assert.equal(await l.session.send({ type: "continue" }), true, what);
		assert.equal(visibleTexts(l.session).filter(text => text === "The owed reply.").length, 1, what);
		assert.equal(l.session.getState().error, null, what);
	}
});

it("follow-ups 1 fix round, finding 3a: a completed turn that posed a problem, dropped twice, gets no tutor turn from Retry", async () => {
	let record: object = { messages: [learnerAsk], turnInFlight: true };
	const { session, posts } = scriptedSession("finding-3a", [learnerAsk], () => record, [dropMidReply, () => {
		record = { messages: [learnerAsk, poseCall, posed], turnInFlight: false }; // the turn ended normally on the pose
		return dropMidReply();
	}]);
	await session.resumeStream(false);
	assert.equal(session.getState().droppedStream, true);
	await session.recoverReply();
	assert.deepEqual(posts, [], "no continue after a posed problem");
	assert.deepEqual(banner(session), { status: "ready", droppedStream: false, error: null });
	assert.match(JSON.stringify(session.getState().messages), new RegExp(POSE_LEAD));
});

it("follow-ups 1 fix round, finding 3b: after a failed settle read, the next sync clears the banner beside a completed pose", async () => {
	let record: object | Response = { messages: [learnerAsk], turnInFlight: true };
	const { session, posts } = scriptedSession("finding-3b", [learnerAsk], () => record, [dropMidReply, () => {
		record = new Response("unavailable", { status: 503 }); // the settle read after the full replay fails
		return fullReplay(poseCall)();
	}]);
	await session.resumeStream(false);
	assert.equal(session.getState().reconciliation, "failed");
	record = { messages: [learnerAsk, poseCall, posed], turnInFlight: false };
	await session.readRecord();
	assert.deepEqual(banner(session), { status: "ready", droppedStream: false, error: null });
	await session.recoverReply();
	assert.deepEqual(posts, []);
	assert.deepEqual(banner(session), { status: "ready", droppedStream: false, error: null });
});

it("follow-ups 1 fix round, finding 2: a continue refused with 409 or 'moved on' reattaches and syncs, never posts again, and leaves no banner", async () => {
	const reply = { ...fauxAssistantMessage("The other tab's reply, longer than the part seen before the drop."), id: "other-tab" } as LhMessage;
	for (const refusal of ["409", "moved on"] as const) {
		for (const producer of ["Retry", "the continuation fold"] as const) {
			const seed = producer === "Retry" ? [learnerAsk] : [learnerAsk, quizCall, quizAnswered];
			let record: object = { messages: seed, turnInFlight: true };
			const views = [
				...(producer === "Retry" ? [dropMidReply, () => { record = { messages: seed, turnInFlight: false }; return settledTurnResponse(); }] : []),
				refusal === "409" ? fullReplay(reply) : () => settledTurnResponse(),
			];
			const { session, posts } = scriptedSession(`finding-2-${refusal}-${producer}`, seed, () => record, views, () => {
				// another tab's continue got there first: still running (409), or already answered (the server's 400)
				record = refusal === "409" ? { messages: seed, turnInFlight: true } : { messages: [...seed, reply], turnInFlight: false };
				const refused = refusal === "409" ? Response.json({ error: "A turn is already running for this session" }, { status: 409 }) : Response.json({ error: CONTINUE_NOT_OWED_TEXT }, { status: 400 });
				if (refusal === "409") setTimeout(() => { record = { messages: [...seed, reply], turnInFlight: false }; }, 0);
				return refused;
			});
			if (producer === "Retry") {
				await session.resumeStream(false);
				assert.equal(session.getState().droppedStream, true);
				await session.recoverReply();
			} else {
				record = { messages: seed, turnInFlight: false };
				await session.continueIfOwed(seed);
			}
			const what = `${refusal}, ${producer}`;
			assert.deepEqual(posts, [{ type: "continue" }], `${what}: posted once`);
			if (refusal === "409") await new Promise(resolve => setTimeout(resolve, 5));
			await session.readRecord(); // the page's sync after record-changed
			assert.deepEqual(banner(session), { status: "ready", droppedStream: false, error: null }, what);
			assert.match(JSON.stringify(session.getState().messages), /The other tab's reply/, what);
			assert.equal(posts.length, 1, `${what}: nothing was posted again`);
		}
	}
});

it("follow-ups 1 fix round, finding 2: two tabs pressing Retry on a server-lost turn run one turn; the second reattaches and both show the reply with no banner", async () => {
	const gate = Promise.withResolvers<void>();
	const REPLY = "The one reply after the restart, longer than the part seen before the drop.";
	const l = lesson([async () => { await gate.promise; return fauxAssistantMessage(REPLY); }],
		attachment => attachment <= 4 ? twoBrokenViews(attachment <= 2 ? attachment : attachment - 2) : undefined, { seed: [learnerAsk] });
	const tabA = l.session;
	const bRead = Promise.withResolvers<void>();
	const aAccepted = Promise.withResolvers<void>();
	const fetchA = tabA.fetch;
	tabA.fetch = async (url, init) => {
		const response = await fetchA(url, init);
		if (url === "/api/chat") aAccepted.resolve();
		return response;
	};
	const tabB = new SessionModel({ chatId: l.id, initialMessages: l.saved(), pollMs: 5, fetch: async (url, init) => {
		if (url === "/api/chat") await aAccepted.promise; // tab A's Retry lands between tab B's read and its post
		const response = await l.fetch(url, init);
		if (String(url) === `/api/chats/${l.id}`) bRead.resolve();
		return response;
	} });
	await tabA.resumeStream(false);
	await tabB.resumeStream(false);
	for (const tab of [tabA, tabB]) assert.equal(tab.getState().droppedStream, true);
	const retryB = tabB.recoverReply();
	await bRead.promise;
	const retryA = tabA.recoverReply();
	await aAccepted.promise;
	await new Promise(resolve => setTimeout(resolve, 20));
	gate.resolve();
	await Promise.all([retryA, retryB]);
	await new Promise(resolve => setTimeout(resolve, 20));
	for (const tab of [tabA, tabB]) {
		await tab.readRecord().catch(() => {});
		assert.deepEqual(banner(tab), { status: "ready", droppedStream: false, error: null });
		assert.equal(visibleTexts(tab).filter(text => text === REPLY).length, 1);
	}
	assert.deepEqual(l.requests.map(input => input.type), ["continue", "continue"], "tab B posted once and was refused");
	assert.equal(l.contexts.length, 1, "one tutor turn ran");
	assert.equal(l.saved().filter(message => message.role === "assistant").length, 1);
	const stored = await (await readChat(new Request(`http://test/api/chats/${l.id}`), { params: Promise.resolve({ id: l.id }) })).json();
	assert.equal(stored.turnError, undefined, "no server error on the session");
});

it("follow-ups 1 fix round: a drop before any text on a turn the server lost keeps the dropped banner, and its Retry runs the turn once", async () => {
	const reply = { ...fauxAssistantMessage("The reply after the restart."), id: "after-restart" } as LhMessage;
	let record: object = { messages: [learnerAsk], turnInFlight: true };
	const { session, posts } = scriptedSession("lost-before-text", [learnerAsk], () => record, [
		() => new Response(TURN_KEEPALIVE + streamFrame({ type: "agent_start" })), // dropped before any text
		() => { record = { messages: [learnerAsk], turnInFlight: false }; return settledTurnResponse(); }, // the restarted server has no turn
		() => { record = { messages: [learnerAsk, reply], turnInFlight: false }; return fullReplay(reply)(); },
	], () => { record = { messages: [learnerAsk], turnInFlight: true }; return Response.json({ ok: true }); });
	await session.resumeStream(false);
	assert.deepEqual(banner(session), { status: "ready", droppedStream: true, error: STREAM_DROPPED_TEXT }, "never nothing with no control");
	await session.readRecord();
	assert.equal(session.getState().droppedStream, true, "a sync keeps it: the record still owes the reply");
	assert.deepEqual(posts, []);
	await session.recoverReply();
	assert.deepEqual(posts, [{ type: "continue" }]);
	assert.deepEqual(banner(session), { status: "ready", droppedStream: false, error: null });
	assert.equal(visibleTexts(session).filter(text => text === "The reply after the restart.").length, 1);
});

it("follow-ups 1 final round: a restart between accepting the learner's message and the attach shows the dropped banner, and its Retry runs the turn once", async () => {
	const reply = { ...fauxAssistantMessage("The reply after the restart."), id: "after-restart" } as LhMessage;
	let record: object = { messages: [], turnInFlight: false };
	const { session, posts } = scriptedSession("lost-before-attach", [], () => record, [
		settledTurnResponse, // the restarted server has no turn: the attach finds it settled
		() => { record = { messages: [learnerAsk, reply], turnInFlight: false }; return fullReplay(reply)(); },
	], (input) => {
		// Accepted and saved, then the server restarts before the view attaches: the record ends on the learner's message.
		record = input.type === "text" ? { messages: [learnerAsk], turnInFlight: false } : { messages: [learnerAsk], turnInFlight: true };
		return Response.json({ ok: true });
	});
	assert.equal(await session.send({ type: "text", text: "Teach me the planets." }), true);
	assert.deepEqual(banner(session), { status: "ready", droppedStream: true, error: STREAM_DROPPED_TEXT }, "never nothing with no control");
	await session.readRecord();
	assert.equal(session.getState().droppedStream, true, "a sync keeps it: the record still owes the reply");
	await session.recoverReply();
	assert.deepEqual(posts.map(input => input.type), ["text", "continue"], "the learner's message is not sent again");
	assert.deepEqual(banner(session), { status: "ready", droppedStream: false, error: null });
	assert.equal(visibleTexts(session).filter(text => text === "The reply after the restart.").length, 1);
	assert.equal(visibleTexts(session).filter(text => text === "Teach me the planets.").length, 1);
});

it("follow-ups 1 final round: a client turn that settled before the attach with its reply saved, or with its failure saved, shows no dropped banner", async () => {
	const reply = { ...fauxAssistantMessage("The quick reply."), id: "quick" } as LhMessage;
	for (const [what, after, expected] of [
		["its reply", { messages: [learnerAsk, reply], turnInFlight: false }, { status: "ready", droppedStream: false, error: null }],
		["its failure", { messages: [learnerAsk], turnInFlight: false, turnError: "Provider failure" }, { status: "ready", droppedStream: false, error: "Provider failure" }],
	] as const) {
		let record: object = { messages: [], turnInFlight: false };
		const { session } = scriptedSession(`settled-before-attach-${what}`, [], () => record, [settledTurnResponse], () => { record = after; return Response.json({ ok: true }); });
		await session.send({ type: "text", text: "Teach me the planets." });
		assert.deepEqual(banner(session), expected, what);
	}
});

// Item 7: the recovery rule as a matrix. Every case runs one sequence of steps against a scripted server for one record
// ending, then checks the rule after every step and once more after a final sync: the learner sees exactly one of the
// reply with no banner, a failure with a working Retry, or the dropped banner with a working Retry; never a banner beside
// a complete reply, never a tutor turn nobody asked for, never nothing with no control.
{
	const REPLY_TEXT = "The tutor's whole reply, longer than the part seen before the drop.";
	const tutorReply: LhMessage = { ...fauxAssistantMessage(REPLY_TEXT), id: "tutor-reply" };
	const ENDINGS = {
		"a learner message": { input: [learnerAsk], output: [tutorReply], owed: true, text: REPLY_TEXT },
		"an answered question": { input: [learnerAsk, quizCall, quizAnswered], output: [tutorReply], owed: true, text: REPLY_TEXT },
		"a custom input (Next)": { input: [learnerAsk, earlierReply, { ...newNextMessage(), id: "next" }], output: [tutorReply], owed: true, text: REPLY_TEXT },
		"a posed problem": { input: [learnerAsk], output: [poseCall, posed], owed: false, text: POSE_LEAD },
		"a complete reply": { input: [learnerAsk], output: [tutorReply], owed: false, text: REPLY_TEXT },
	} satisfies Record<string, { input: LhMessage[]; output: LhMessage[]; owed: boolean; text: string }>;
	type Recovery = "reattach after the turn ended" | "reattach while it runs (a restart cuts an owed one)" | "second drop";
	// "Retry, lost to a restart before its attach" (final round): the server accepts the Retry's continue, then restarts before
	// the view attaches, so the attach finds no turn and the record still owes the reply.
	type Step = "read fails" | "sync" | "Retry" | "offline Retry" | "second tab" | "second tab racing" | "Retry, its views drop twice" | "Retry, lost to a restart before its attach";
	const RECOVERIES: Recovery[] = ["reattach after the turn ended", "reattach while it runs (a restart cuts an owed one)", "second drop"];
	const SEQUENCES: Step[][] = [
		[], ["read fails"], ["read fails", "sync"], ["sync"], ["Retry"], ["read fails", "Retry"], ["offline Retry"], ["offline Retry", "Retry"],
		["second tab"], ["second tab", "Retry"], ["second tab racing", "Retry"], ["read fails", "second tab racing", "Retry"],
		["Retry, its views drop twice"], ["Retry, its views drop twice", "Retry"], ["offline Retry", "second tab", "Retry"],
		["Retry, lost to a restart before its attach"], ["Retry, lost to a restart before its attach", "sync", "Retry"], ["Retry, lost to a restart before its attach", "second tab"],
	];
	let cases = 0;
	for (const [ending, spec] of Object.entries(ENDINGS)) for (const recovery of RECOVERIES) for (const steps of SEQUENCES) {
		cases++;
		it(`item 7 matrix: record ending on ${ending}; drop, ${recovery}${steps.length ? ", " + steps.join(", ") : ""}`, async () => {
			const server = { messages: [...spec.input] as LhMessage[], running: true, online: true, failReads: 0, failSettleRead: false, served: 0, raceNextPost: false, restartAfterNextPost: false, turnsRun: 0, ourContinues: 0, retryPresses: 0 };
			const views: ("drop" | "drop, then the turn ends" | "auto")[] = [];
			/** The client's last record read succeeded (after a failed one, a banner may wait for the next sync). */
			let readable = true;
			const endTurn = () => {
				server.running = false;
				if (!spec.owed) server.messages = [...spec.input, ...spec.output]; // an owed ending's turn is lost (a restart)
			};
			const runTurn = () => { server.running = true; server.turnsRun++; };
			const replay = () => {
				const frames = [streamFrame({ type: "agent_start" })];
				for (const message of spec.output) if (message.role === "assistant") frames.push(streamFrame({ type: "message_start", message }), streamFrame({ type: "message_end", message }));
				return new Response(frames.join("") + streamFrame({ type: "agent_end", messages: [] }) + "data: [DONE]\n\n");
			};
			const session = new SessionModel({ chatId: `matrix-${cases}`, initialMessages: spec.input, fetch: async (url, init) => {
				if (!server.online) { if (!String(url).endsWith("/stream") && String(url) !== "/api/chat") readable = false; throw new TypeError("fetch failed (offline)"); }
				if (String(url) === "/api/chat") {
					const input = JSON.parse(String(init?.body)).input as ChatInput;
					assert.equal(input.type, "continue", "nothing but continue is ever owed here");
					server.ourContinues++;
					if (server.raceNextPost && owesTutorReply(server.messages)) { server.raceNextPost = false; runTurn(); }
					if (server.running) return Response.json({ error: "A turn is already running for this session" }, { status: 409 });
					if (!owesTutorReply(server.messages)) return Response.json({ error: CONTINUE_NOT_OWED_TEXT }, { status: 400 });
					if (server.restartAfterNextPost) { server.restartAfterNextPost = false; return Response.json({ ok: true }); } // accepted, then lost: no turn
					runTurn();
					return Response.json({ ok: true });
				}
				if (String(url).endsWith("/stream")) {
					const view = views.shift() ?? "auto";
					const recoveryAttach = ++server.served === 2;
					// "read fails": the read after the recovery attach's terminal (its settle read) fails, once
					const terminal = (response: Response) => { if (recoveryAttach && server.failSettleRead) server.failReads = 1; return response; };
					// A drop shows the running turn's partial; with no turn running, the stream had nothing to show before it broke.
					if (view === "drop") return server.running ? dropMidReply() : new Response(TURN_KEEPALIVE);
					if (view === "drop, then the turn ends") { endTurn(); return dropMidReply(); }
					if (!server.running) return terminal(settledTurnResponse());
					if (server.turnsRun > 0) { server.messages = [...server.messages, ...spec.output]; server.running = false; return terminal(replay()); } // a turn a continue started
					if (spec.owed) { endTurn(); return dropMidReply(); } // the restart cuts the replay
					endTurn();
					return terminal(replay());
				}
				if (server.failReads > 0) { server.failReads--; readable = false; return new Response("unavailable", { status: 503 }); }
				readable = true;
				return Response.json({ messages: server.messages, turnInFlight: server.running });
			} });
			const check = (when: string) => {
				const state = session.getState();
				const live = state.status === "submitted" || state.status === "streaming";
				assert.equal(live, false, `${when}: nothing is left running`);
				const shown = occurrences(JSON.stringify(state.messages), spec.text);
				const outcome = state.error === null && !state.droppedStream ? "reply" : state.droppedStream && state.error?.message === STREAM_DROPPED_TEXT ? "dropped" : state.error !== null ? "failure" : "invalid";
				assert.notEqual(outcome, "invalid", `${when}: one of the three states`);
				if (outcome === "reply") assert.equal(shown, 1, `${when}: no banner means the reply is there, once (never nothing with no control)`);
				// A settle read that failed may leave the banner until the next successful sync (follow-ups 1, finding 1).
				if (readable && shown > 0) assert.equal(outcome, "reply", `${when}: never a banner beside a complete reply`);
				assert.ok(server.turnsRun <= (spec.owed ? 1 : 0), `${when}: never a tutor turn nobody asked for`);
				assert.ok(server.ourContinues <= server.retryPresses, `${when}: continue is posted only by a Retry press`);
				return outcome;
			};

			// The view attached mid-turn and dropped; the automatic recovery attach then happens as `recovery` says.
			if (recovery === "reattach after the turn ended") views.push("drop, then the turn ends", "auto");
			else if (recovery === "second drop") views.push("drop, then the turn ends", "drop");
			else views.push("drop", "auto");
			if (steps[0] === "read fails") server.failSettleRead = true;
			await session.resumeStream(false);
			check("after the drop and the recovery attach");
			let ranOrAnswered = false;
			for (const [index, step] of steps.entries()) {
				if (step === "read fails" && index === 0) continue;
				if (step === "read fails") { server.failReads = 1; await session.readRecord().catch(() => {}); check(`after ${step}`); continue; }
				if (step === "sync") await session.readRecord().catch(() => {});
				if (step === "Retry") { server.retryPresses++; await session.recoverReply(); if (spec.owed) ranOrAnswered = true; }
				if (step === "offline Retry") { server.online = false; server.retryPresses++; await session.recoverReply(); server.online = true; check(`after ${step}`); continue; }
				if (step === "second tab" && owesTutorReply(server.messages)) { server.turnsRun++; server.messages = [...server.messages, ...spec.output]; ranOrAnswered = true; }
				if (step === "second tab racing") server.raceNextPost = true;
				if (step === "Retry, its views drop twice") { views.push("drop", "drop"); server.retryPresses++; await session.recoverReply(); if (spec.owed) ranOrAnswered = true; }
				if (step === "Retry, lost to a restart before its attach") { server.restartAfterNextPost = true; server.retryPresses++; await session.recoverReply(); server.restartAfterNextPost = false; }
				check(`after ${step}`);
			}
			await session.readRecord().catch(() => {}); // the page's next sync
			const outcome = check("after the final sync");
			// Expected: the reply once nothing is owed any more (the turn completed, a Retry ran it, or another tab did); the
			// dropped banner while it is (no Retry yet, or the Retry's own views dropped while its turn still runs).
			const owedStill = spec.owed && !ranOrAnswered;
			const retryStillRunning = spec.owed && server.running;
			assert.equal(outcome, owedStill || retryStillRunning ? "dropped" : "reply", owedStill || retryStillRunning ? "the dropped banner with its Retry" : "the reply, no banner");
			if (outcome !== "reply") {
				// The Retry works: one press brings the reply, with one tutor turn.
				server.retryPresses++;
				await session.recoverReply();
				views.length = 0;
				await session.readRecord().catch(() => {});
				assert.equal(check("after the final Retry"), "reply");
			}
			assert.equal(server.turnsRun, spec.owed ? 1 : 0, spec.owed ? "the lost turn ran exactly once" : "no tutor turn ran");
		});
	}
	it(`item 7 matrix: ${cases} cases (${Object.keys(ENDINGS).length} endings × ${RECOVERIES.length} recovery attaches × ${SEQUENCES.length} step sequences)`, () => assert.equal(cases, 270));
}

it("item 5: a cut-off with an unanswered question call has the malformed-question recovery only", () => {
	const messages: LhMessage[] = [
		{ ...newUserMessage("Teach me the planets."), id: "learner" },
		{ ...fauxAssistantMessage([fauxText("Here is a question."), fauxToolCall("quiz", { lead: "Partial" }, { id: "cut-question" })], { stopReason: "length" }), id: "cut" },
	];
	assert.equal(malformedQuestionsOf(messages).length, 1);
	assert.equal(cutOffReplyAtEnd(messages), undefined);
	assert.throws(() => requireCutOffReply(messages, "cut"), /no longer the latest reply/);
	assert.equal(new SessionModel({ chatId: "malformed", initialMessages: messages, fetch }).getState().cutOffReply, undefined);
});

it("item 6: the timeline's longest gap includes the silence before the end, and reported thinking is not inferred", () => {
	const lines: TurnTimelineLine[] = [];
	let now = 0;
	const timeline = new TurnTimeline(identity, line => lines.push(line), () => now);
	const message = fauxAssistantMessage([fauxThinking("")], { stopReason: "stop" });
	timeline.event({ type: "turn_start" });
	now = 800;
	timeline.event({ type: "message_update", message, assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: message } });
	now = 5_000;
	timeline.event({ type: "message_update", message, assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "", partial: message } });
	now = 50_000;
	timeline.finish(false);
	assert.equal(lines[0]?.longestEventGapMs, 45_000);
	assert.deepEqual(lines[0]?.thinkingSpans, [{ startMs: 800, durationMs: 4_200, source: "reported" }]);
});

it("re-check 2, finding 3: the timeline's longest gap includes the wait before the first event", () => {
	const lines: TurnTimelineLine[] = [];
	let now = 0;
	const timeline = new TurnTimeline(identity, line => lines.push(line), () => now);
	now = 40_000;
	timeline.event({ type: "turn_start" });
	now = 41_000;
	timeline.finish(false);
	assert.equal(lines[0]?.firstEventMs, 40_000);
	assert.equal(lines[0]?.longestEventGapMs, 40_000);
});

it("item 7: the cut-off notice stays usable after a failed background sync", () => {
	const idle = { localStream: false, turnInFlight: false, reconciliation: "failed" as const, compacting: false, retryingStream: false };
	assert.equal(cutOffRecoveryDisabled(idle), false);
	assert.equal(cutOffRecoveryDisabled({ ...idle, reconciliation: "syncing" }), true);
	for (const busy of ["localStream", "turnInFlight", "compacting", "retryingStream"] as const) assert.equal(cutOffRecoveryDisabled({ ...idle, [busy]: true }), true, busy);
});

it("item 8: a refused keepalive write stops its timer instead of throwing from it", t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let writes = 0;
	const closed = viewKeepalive({ desiredSize: 1, enqueue() { writes++; throw new TypeError("Invalid state: Controller is already closed"); } });
	assert.doesNotThrow(() => closed.ping());
	t.mock.timers.tick(TURN_KEEPALIVE_MS * 3);
	assert.equal(writes, 1);
	const errored = viewKeepalive({ desiredSize: null, enqueue() { writes++; } });
	errored.ping();
	t.mock.timers.tick(TURN_KEEPALIVE_MS * 3);
	assert.equal(writes, 1);
});

it("item 8: waiting views are told what holds the turn, and only when it really is grading", async () => {
	const frames = async (activity?: "grader" | "processing") => {
		const chatId = `activity-${activity ?? "none"}`;
		const prep = claimPreparingTurn(chatId, undefined, activity)!;
		const view = runningTurn(chatId)!.subscribe().getReader();
		const first = new TextDecoder().decode((await view.read()).value);
		let second = "";
		const next = view.read().then(result => { second = new TextDecoder().decode(result.value); });
		await new Promise<void>(resolve => setImmediate(resolve));
		await view.cancel();
		await next;
		prep.finish();
		return [first, second];
	};
	assert.deepEqual(await frames("processing"), [TURN_KEEPALIVE, streamFrame({ type: "turn-activity", activity: "processing" })]);
	assert.deepEqual(await frames(), [TURN_KEEPALIVE, ""], "a sketched placement answer is graded later, after read_sketch");
	assert.equal(TURN_ACTIVITY_LABELS.processing, "Evaluating");

	const answerData = (extra: object) => ({ role: "toolResult", toolName: "probe", toolCallId: "p", isError: false, content: [], details: { kind: "quiz", ...extra } });
	assert.equal(placementGradedBeforeTurn(answerData({})), true);
	assert.equal(placementGradedBeforeTurn(answerData({ sketch: { id: "sk_1" } })), false);
	assert.equal(placementGradedBeforeTurn(answerData({ dismissed: true })), false);

	const lines: TurnTimelineLine[] = [];
	const timeline = new TurnTimeline(identity, line => lines.push(line));
	await timeline.run(() => observeTurnActivity("processing", async () => {}));
	timeline.finish(false);
	assert.equal(lines[0]?.processingSpans.length, 1);
	assert.equal(lines[0]?.graderSpans.length, 0);
	const held = new Response(new ReadableStream<Uint8Array>());
	const session = new SessionModel({ chatId: "processing", initialMessages: [], fetch: async () => held });
	const watching = session.resumeStream(false);
	assert.equal(session.status, "submitted");
	session.applyWireEvent({ type: "turn-activity", activity: "processing" });
	assert.equal(session.getState().activity, "processing");
	await held.body!.cancel();
	await watching;
});

it("item 10: Thinking returns when send_to_user prose falls silent", async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let wire!: ReadableStreamDefaultController<Uint8Array>;
	const streaming = Promise.withResolvers<void>();
	const encoder = new TextEncoder();
	const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { wire = controller; } }));
	const prose = { ...fauxAssistantMessage([fauxToolCall("send_to_user", { message: "Prose so far" }, { id: "say" })]), stopReason: "pending" };
	const model = new SessionModel({
		chatId: identity.chatId, initialMessages: [], fetch: async url => String(url).endsWith("/stream") ? response : Response.json({ messages: [] }),
		onChange() { if (model.status === "streaming" && JSON.stringify(model.getState().messages).includes("Prose so far")) streaming.resolve(); },
	});
	const watching = model.resumeStream(false);
	wire.enqueue(encoder.encode(streamFrame({ type: "message_start", message: prose })));
	await streaming.promise;
	assert.equal(model.getState().activity, null);
	t.mock.timers.tick(MODEL_TEXT_PAUSE_MS);
	assert.equal(model.getState().activity, "thinking");
	wire.enqueue(encoder.encode("data: [DONE]\n\n"));
	wire.close();
	await watching;
});
