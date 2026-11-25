/**
 * Fork addition on top of upstream's Claude CLI provider (docs/android/m14-plan.md, P8): a plain final answer does not end
 * the process. It waits, registered, and takes the same session's next user message live (no new spawn, no replay of
 * the transcript, only the new message written to stdin). Upstream kills the process after such an answer and replays.
 * A different history, a different session, or a process that held tool calls still ends or respawns as before.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import test, { type TestContext } from "node:test";

import type { AssistantMessage, AssistantMessageEvent, Message, Tool } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

import { cliEndingOf, setClaudeCliObservationCapture, type ClaudeCliEnding } from "../src/agent/claude-code/constants.ts";
import { idleReuse } from "../src/agent/claude-code/fork-extensions.ts";
import { CLAUDE_CODE_MODELS } from "../src/agent/claude-code/provider.ts";
import { createClaudeCodeStreamFunction, type RunClaude } from "../src/agent/claude-code/stream.ts";

const READ_TOOL: Tool = { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } };

/** An in-memory `claude -p --input-format stream-json`: answers every user line with the next reply, in the same process. */
function fakeCli(t: TestContext, replies: string[]) {
	const spawned: Array<{ userLines: string[]; killed: boolean }> = [];
	const runClaude: RunClaude = () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const record = { userLines: [] as string[], killed: false };
		spawned.push(record);
		const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
		Object.assign(child, {
			stdin,
			stdout,
			stderr,
			kill: () => {
				record.killed = true;
				setImmediate(() => child.emit("close", null));
				return true;
			},
		});
		t.after(() => (child.kill as () => boolean)());
		const write = (value: unknown) => stdout.write(`${JSON.stringify(value)}\n`);
		const event = (e: unknown) => write({ type: "stream_event", event: e });
		let answered = 0;
		createInterface({ input: stdin }).on("line", (line) => {
			const message = JSON.parse(line) as { type: string; request_id?: string; request?: { subtype?: string } };
			if (message.type === "control_request") {
				if (message.request?.subtype === "initialize") write({ type: "control_response", response: { request_id: message.request_id, subtype: "success" } });
				return;
			}
			record.userLines.push(line);
			const text = replies[Math.min(answered++, replies.length - 1)]!;
			event({ type: "message_start", message: { usage: {} } });
			event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
			event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
			event({ type: "content_block_stop", index: 0 });
			event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} });
			event({ type: "message_stop" });
			write({ type: "result", subtype: "success", is_error: false });
		});
		return child as never;
	};
	return { runClaude, spawned };
}

const model = CLAUDE_CODE_MODELS[0]!;

/** Idle reuse is off by default (LH_CLAUDE_IDLE_REUSE); these tests are about it switched on. */
test.before(() => { idleReuse.current = true; });
test.after(() => { idleReuse.current = false; });

async function turn(stream: ReturnType<typeof createClaudeCodeStreamFunction>, messages: Message[], sessionId = "idle-session"): Promise<AssistantMessage> {
	const context = normalizeContext({ systemPrompt: "You are a tutor.", messages, tools: [READ_TOOL] });
	for await (const event of stream(model, context, { sessionId })) {
		if (event.type === "done") return event.message;
		if (event.type === "error") assert.fail(`the turn failed: ${event.error.errorMessage}`);
	}
	return assert.fail("the stream ended without a result");
}

const user = (text: string, timestamp = 0): Message => ({ role: "user", content: text, timestamp });

// ─── Follow-ups 1, the ordering table (council/reviews/followups-1-review-1.md) ─────────────────────────────────────
// Each row asserts how many times the turn settles, its text and stop reason, the recorded cliEnding, and whether the
// process is reused or killed.

async function turnEvents(stream: ReturnType<typeof createClaudeCodeStreamFunction>, messages: Message[], sessionId = "idle-session"): Promise<AssistantMessageEvent[]> {
	const context = normalizeContext({ systemPrompt: "You are a tutor.", messages, tools: [READ_TOOL] });
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream(model, context, { sessionId })) events.push(event);
	return events;
}

function assertSettledOnce(events: AssistantMessageEvent[], expected: { stopReason: AssistantMessage["stopReason"]; text?: string; error?: RegExp; cliEnding: ClaudeCliEnding }): AssistantMessage {
	const ends = events.filter((event) => event.type === "done" || event.type === "error");
	assert.equal(ends.length, 1, "the turn settles exactly once");
	assert.equal(events.at(-1), ends[0], "nothing follows the settle");
	const end = ends[0]!;
	const message = end.type === "done" ? end.message : (end as Extract<AssistantMessageEvent, { type: "error" }>).error;
	assert.equal(message.stopReason, expected.stopReason);
	if (expected.text !== undefined) assert.equal(message.content.map((b) => (b.type === "text" ? b.text : "")).join(""), expected.text);
	if (expected.error) assert.match(message.errorMessage ?? "", expected.error);
	assert.equal(cliEndingOf(message), expected.cliEnding);
	return message;
}

/** The lines one CLI process writes, scripted per spawn and per prompt (1-based). */
type CliScript = {
	text(value: string, ending: "message-stop" | "none"): void;
	result(error?: string): void;
	line(value: unknown): void;
	exit(code: number): void;
};

/** An in-memory CLI whose output for each prompt of each spawn is scripted; `beforePrompt` writes before the first prompt. */
function scriptedCli(t: TestContext, onPrompt: (cli: CliScript, prompt: number, spawn: number) => void, beforePrompt?: (cli: CliScript) => void) {
	const spawned: Array<{ userLines: string[]; killed: boolean; exited: boolean }> = [];
	const runClaude: RunClaude = () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const record = { userLines: [] as string[], killed: false, exited: false };
		const spawn = spawned.push(record);
		const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
		const close = (code: number | null) => { if (record.exited) return; record.exited = true; setImmediate(() => child.emit("close", code)); };
		Object.assign(child, { stdin, stdout, stderr: new PassThrough(), kill: () => { record.killed = true; close(null); return true; } });
		t.after(() => (child.kill as () => boolean)());
		const write = (value: unknown) => stdout.write(`${JSON.stringify(value)}\n`);
		const event = (e: unknown) => write({ type: "stream_event", event: e });
		const cli: CliScript = {
			text(value, ending) {
				event({ type: "message_start", message: { usage: {} } });
				event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
				event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: value } });
				if (ending === "none") return;
				event({ type: "content_block_stop", index: 0 });
				event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} });
				event({ type: "message_stop" });
			},
			result(error) { write(error ? { type: "result", subtype: "error_during_execution", is_error: true, result: error } : { type: "result", subtype: "success", is_error: false }); },
			line: write,
			exit(code) { stdout.end(); close(code); },
		};
		let prompts = 0;
		createInterface({ input: stdin }).on("line", (line) => {
			const message = JSON.parse(line) as { type: string; request_id?: string; request?: { subtype?: string } };
			if (message.type === "control_request") {
				if (message.request?.subtype !== "initialize") return;
				beforePrompt?.(cli);
				write({ type: "control_response", response: { request_id: message.request_id, subtype: "success" } });
				return;
			}
			record.userLines.push(line);
			onPrompt(cli, ++prompts, spawn);
		});
		return child as never;
	};
	return { runClaude, spawned };
}

test("the next user message of a session takes the idle process live: no new spawn, only the new message is written", async (t) => {
	const { runClaude, spawned } = fakeCli(t, ["first answer", "second answer"]);
	const stream = createClaudeCodeStreamFunction(runClaude);
	const first = await turn(stream, [user("hello")]);
	assert.equal(spawned.length, 1);
	assert.equal(spawned[0]!.killed, false, "the final answer did not end the process");

	const secondEvents = await turnEvents(stream, [user("hello"), first, user("and now a second question", 5)]);
	// Ordering 1, a reused turn: one settle at message_stop, the same process kept for the next message.
	const second = assertSettledOnce(secondEvents, { stopReason: "stop", text: "second answer", cliEnding: "message-stop" });
	assert.equal(spawned[0]!.killed, false, "the reused process is kept again");
	assert.equal(spawned.length, 1, "no second process");
	assert.equal(second.content.map((b) => (b.type === "text" ? b.text : "")).join(""), "second answer");
	assert.equal(spawned[0]!.userLines.length, 2);
	const written = JSON.parse(spawned[0]!.userLines[1]!) as { message: { content: Array<{ type: string; text: string }> } };
	assert.deepEqual(written.message.content, [{ type: "text", text: "and now a second question" }], "the live process gets only the new message, unlabelled");
});

test("a history that is not an extension, or another session, starts a fresh process and ends the idle one", async (t) => {
	const { runClaude, spawned } = fakeCli(t, ["one", "two", "three"]);
	const stream = createClaudeCodeStreamFunction(runClaude);
	const first = await turn(stream, [user("hello")]);
	// the learner's earlier message was edited: not a prefix of what the process holds
	await turn(stream, [user("hello, edited"), first, user("next", 5)]);
	assert.equal(spawned.length, 2, "a fresh process");
	assert.equal(spawned[0]!.killed, true, "the stale idle process was ended");
	// another session never takes this session's process
	const other = await turn(stream, [user("hi")], "another-session");
	assert.ok(other);
	assert.equal(spawned.length, 3);
	assert.equal(spawned[1]!.killed, false, "the first session's new process is untouched");
});

test("a delta that is not user messages only (an assistant message in it) is replayed, not continued live", async (t) => {
	const { runClaude, spawned } = fakeCli(t, ["one", "two"]);
	const stream = createClaudeCodeStreamFunction(runClaude);
	const first = await turn(stream, [user("hello")]);
	const extra: AssistantMessage = { ...first, content: [{ type: "text", text: "something said elsewhere" }] };
	await turn(stream, [user("hello"), first, extra, user("next", 5)]);
	assert.equal(spawned.length, 2);
	assert.equal(spawned[0]!.killed, true);
});

/** Records the adapter's observations (follow-ups 1) for turns started while it is set. */
function observeCli(t: TestContext): string[] {
	const notes: string[] = [];
	const previous = setClaudeCliObservationCapture(() => (note) => notes.push(note));
	t.after(() => setClaudeCliObservationCapture(previous));
	return notes;
}

/** A turn that must stay open: its events over a bounded wait, and whether it settled in that time. */
async function openTurnEvents(stream: ReturnType<typeof createClaudeCodeStreamFunction>, messages: Message[], waitMs = 300): Promise<{ events: AssistantMessageEvent[]; settled: boolean }> {
	const context = normalizeContext({ systemPrompt: "You are a tutor.", messages, tools: [READ_TOOL] });
	const events: AssistantMessageEvent[] = [];
	const settled = (async () => { for await (const event of stream(model, context, { sessionId: "idle-session" })) events.push(event); return true; })();
	return { events, settled: await Promise.race([settled, new Promise<false>((resolve) => setTimeout(() => resolve(false), waitMs))]) };
}

test("known, deliberately unchanged (as main): a reused turn whose answer gets a success result but no message_stop stays open; both results are recorded as observations", async (t) => {
	// The first prompt's result is held back until the second prompt is written; the second answer never gets a
	// message_stop. As on main a successful result settles nothing, so the turn stays open. The adapter records each
	// success result that arrives while the turn is open (it cannot tell the previous prompt's late one from its own).
	const notes = observeCli(t);
	const { runClaude, spawned } = scriptedCli(t, (cli, prompt) => {
		if (prompt === 1) { cli.text("first answer", "message-stop"); return; }
		cli.result(); // the first prompt's, late
		cli.text("second answer", "none");
		cli.result();
	});
	const stream = createClaudeCodeStreamFunction(runClaude);
	const first = assertSettledOnce(await turnEvents(stream, [user("hello")]), { stopReason: "stop", text: "first answer", cliEnding: "message-stop" });
	assert.deepEqual(notes, [], "a normal ending records nothing");
	const second = await openTurnEvents(stream, [user("hello"), first, user("next", 5)]);
	assert.equal(second.settled, false, "the turn is still open");
	assert.equal(second.events.some((event) => event.type === "done" || event.type === "error"), false, "nothing settled it");
	assert.equal(spawned.length, 1, "the second prompt went to the idle process");
	assert.equal(spawned[0]!.killed, false, "nothing killed it");
	assert.deepEqual(notes, ["result-before-stream-end", "result-before-stream-end"]);
});

test("known, deliberately unchanged (as main): a late error result for the previous prompt fails the next turn on the idle process", async (t) => {
	const { runClaude, spawned } = scriptedCli(t, (cli, prompt) => {
		if (prompt === 1) { cli.text("first answer", "message-stop"); return; } // its result is held back
		cli.result("the first prompt's late failure");
		cli.text("second answer", "message-stop");
		cli.result();
	});
	const stream = createClaudeCodeStreamFunction(runClaude);
	const first = assertSettledOnce(await turnEvents(stream, [user("hello")]), { stopReason: "stop", text: "first answer", cliEnding: "message-stop" });
	assertSettledOnce(await turnEvents(stream, [user("hello"), first, user("next", 5)]), { stopReason: "error", error: /the first prompt's late failure/, cliEnding: "result-error" });
	assert.equal(spawned.length, 1, "reused");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(spawned[0]!.killed, true, "a failed turn is not kept idle");
});

test("ordering 16: a process that exits between message_stop and its result settles the turn once; the next turn starts fresh", async (t) => {
	const { runClaude, spawned } = scriptedCli(t, (cli, prompt, spawn) => {
		if (spawn === 1) { cli.text("first answer", "message-stop"); setImmediate(() => cli.exit(1)); return; }
		cli.text("from the fresh process", "message-stop");
		cli.result();
	});
	const stream = createClaudeCodeStreamFunction(runClaude);
	const events = await turnEvents(stream, [user("hello")]);
	const first = assertSettledOnce(events, { stopReason: "stop", text: "first answer", cliEnding: "message-stop" });
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(spawned[0]!.exited, true);
	assert.equal(events.filter((event) => event.type === "done" || event.type === "error").length, 1, "the exit settles nothing again");
	assertSettledOnce(await turnEvents(stream, [user("hello"), first, user("next", 5)]), { stopReason: "stop", text: "from the fresh process", cliEnding: "message-stop" });
	assert.equal(spawned.length, 2, "the exited process is not reused");
});

for (const [kind, errorLine] of [
	["an assistant error", { type: "assistant", error: "rate_limit", message: { content: [{ type: "text", text: "API Error" }] } }],
	["a result error for its prompt", { type: "result", subtype: "error_during_execution", is_error: true, result: "late failure" }],
] as const) test(`ordering 19: ${kind} while idle kills the process without touching the settled turn; the next turn starts fresh`, async (t) => {
	const { runClaude, spawned } = scriptedCli(t, (cli, prompt, spawn) => {
		if (spawn === 1) { cli.text("first answer", "message-stop"); cli.line(errorLine); return; }
		cli.text("from the fresh process", "message-stop");
		cli.result();
	});
	const stream = createClaudeCodeStreamFunction(runClaude);
	const events = await turnEvents(stream, [user("hello")]);
	const first = assertSettledOnce(events, { stopReason: "stop", text: "first answer", cliEnding: "message-stop" });
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(spawned[0]!.killed, true, "an idle process that reports an error is dropped");
	assertSettledOnce(await turnEvents(stream, [user("hello"), first, user("next", 5)]), { stopReason: "stop", text: "from the fresh process", cliEnding: "message-stop" });
	assert.equal(spawned.length, 2);
});

test("a stray success result before the first prompt changes nothing (recorded only); the reply settles at message_stop and the process is kept", async (t) => {
	const notes = observeCli(t);
	const { runClaude, spawned } = scriptedCli(t, (cli) => {
		cli.text("the reply", "message-stop");
		cli.result();
	}, (cli) => cli.result());
	const stream = createClaudeCodeStreamFunction(runClaude);
	assertSettledOnce(await turnEvents(stream, [user("hello")]), { stopReason: "stop", text: "the reply", cliEnding: "message-stop" });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(spawned[0]!.killed, false, "kept idle, as on main");
	assert.deepEqual(notes, ["result-before-stream-end"], "the stray result arrived while the turn was open; the one after message_stop is normal");
});
