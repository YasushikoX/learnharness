import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, type FauxResponseStep, type Message } from "@earendil-works/pi-ai";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import type { ChatInput } from "../src/core/input-events.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { TurnTimelineLine } from "../src/server/turn-timeline.ts";

assert.equal(process.env.NODE_ENV, "test");
const scratch = mkdtempSync(join(tmpdir(), "lh-stream-reliability-"));
process.env.LH_DATA_DIR = join(scratch, "data");
process.env.LH_AUTH_FILE = join(scratch, "auth.json");
process.env.OPENROUTER_API_KEY = "test-key-presence-gate";
writeFileSync(process.env.LH_AUTH_FILE, "{}");
after(() => rmSync(scratch, { recursive: true, force: true }));

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
const { newUserMessage } = await import("../src/core/native-messages.ts");
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

function lesson(steps: FauxResponseStep[], disconnect?: (attachment: number) => Response | undefined) {
	const { id } = chatStore.createChat("Planets");
	chatStore.saveSettings(id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	chatStore.saveMessages(id, [
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
				...opts, tools: {}, engine: { model: faux.getModel(), streamFn: faux.streamSimple },
			}));
		}
		if (String(url).endsWith("/stream")) {
			const interrupted = disconnect?.(++attachments);
			if (interrupted) return interrupted;
			const run = runningTurn(id);
			return run ? piTurnResponse(run) : settledTurnResponse(id);
		}
		return readChat(new Request(`http://test${url}`), { params: Promise.resolve({ id }) });
	};
	const saved = () => chatStore.getChat(id)!.messages;
	const session = new SessionModel({ chatId: id, initialMessages: saved(), fetch: fetchView });
	return {
		session, saved, contexts, requests, id, get attachments() { return attachments; },
		assertOneAnswer() {
			assert.equal(requests.filter(input => input.type === "answer").length, 1);
			assert.equal(saved().filter(message => message.role === "toolResult" && message.toolCallId === answer.toolCallId).length, 1);
			assert.equal(saved().filter(message => message.role === "user").length, 1);
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
		assert.match(context, hasText ? /Continue from where you stopped/ : /Try replying to the existing conversation again/);
		if (hasText) assert.match(context, /An incomplete explanation/);
		else assert.doesNotMatch(context, /Fixture-only private thought/);
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
		}, finish], twoBrokenViews);
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
	});
}

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
	const refused = makeGateRefusals(1, gate => timeline.refuse(gate));
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
		graderSpans: [{ startMs: 13, durationMs: 8 }], gateRefusals: { "answer-key": 1, prose: 1 },
		stopReason: "length", streamEnd: "client-dropped", errorKind: null, clientDrops: 1, visibleTextChars: 13, thinkingChars: 15,
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
