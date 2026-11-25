import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import type { Agent, AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
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
		session, saved, contexts, requests, id, get attachments() { return attachments; },
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
