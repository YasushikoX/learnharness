import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { StopReason } from "@earendil-works/pi-ai";
import { PATHS } from "../../config.ts";
import { cliEndingOf, type ClaudeCliEnding } from "../agent/claude-code/constants.ts";
import { sendToUserText } from "../core/native-messages.ts";

export const TURN_TIMELINE_MAX_BYTES = 4 * 1024 * 1024;
const MAX_QUEUED_WRITES = 128;
const timelineFile = join(/* turbopackIgnore: true */ PATHS.data, "logs", "turns.jsonl");

export type TurnActivity = "checker" | "grader" | "processing";
type Span = { startMs: number; durationMs: number };
type ErrorKind = "provider" | "agent-loop" | "settlement" | "preparation";
type Identity = { turnId: string; chatId: string; provider: string; model: string; thinking: boolean };

export type TurnTimelineLine = Identity & {
	startedAt: string;
	durationMs: number;
	firstEventMs: number | null;
	firstVisibleTextMs: number | null;
	longestEventGapMs: number;
	thinkingSpans: (Span & { source: "reported" | "inferred" })[];
	textSpans: Span[];
	tools: (Span & { name: string })[];
	checkerSpans: Span[];
	graderSpans: Span[];
	processingSpans: Span[];
	gateRefusals: Record<string, number>;
	/** Calls a gate would have refused but let through because the turn's refusal budget was spent (WP6). */
	refusalBudgetPasses: Record<string, number>;
	stopReason: StopReason | null;
	/** How the turn ended on the server; a view leaving never ends it (clientDrops counts those). */
	streamEnd: "completed" | "aborted" | "error";
	errorKind: ErrorKind | null;
	clientDrops: number;
	visibleTextChars: number;
	thinkingChars: number;
	/** How the claude CLI ended the turn's last assistant message; null for other providers (follow-ups 1). */
	cliEnding: ClaudeCliEnding | null;
};

/** Written when the turn begins, so a turn abandoned mid-stall (reload, quit) still leaves a trace (follow-ups 1). The
 *  finish line for the same turnId follows when it ends; the summary script lists starts that never got one. */
export type TurnTimelineStartLine = Identity & { kind: "start"; startedAt: string };

/** On disk a line also carries `writeFailures` once this process failed to write an earlier line: how many it lost so far. */
export type TurnTimelineRecord = TurnTimelineLine | TurnTimelineStartLine;

/** Serialize rotation across turns and keep disk I/O off the settlement path. */
export function createTurnTimelineWriter(file: string, maxBytes = TURN_TIMELINE_MAX_BYTES) {
	let pending = Promise.resolve();
	let queued = 0;
	let failures = 0;
	return {
		append(line: TurnTimelineRecord) {
			if (queued >= MAX_QUEUED_WRITES) { failures++; return; }
			queued++;
			pending = pending.then(async () => {
				const json = JSON.stringify(failures ? { ...line, writeFailures: failures } : line) + "\n";
				const bytes = Buffer.byteLength(json);
				if (bytes > maxBytes) { failures++; return; }
				await mkdir(dirname(file), { recursive: true, mode: 0o700 });
				const size = await stat(file).then(s => s.size, (error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error;
					return 0;
				});
				if (size + bytes > maxBytes) await rename(file, file + ".1");
				await appendFile(file, json, { mode: 0o600 });
			}).catch(() => { failures++; }).finally(() => { queued--; });
		},
		flush: () => pending,
		get failures() { return failures; },
	};
}

const runtime = globalThis as typeof globalThis & { __lhTurnTimelineWriter?: ReturnType<typeof createTurnTimelineWriter> };
const writer = runtime.__lhTurnTimelineWriter ??= createTurnTimelineWriter(timelineFile);
export const turnTimelineWriteFailures = () => writer.failures;
const context = new AsyncLocalStorage<TurnTimeline>();

export async function observeTurnActivity<T>(activity: TurnActivity, run: () => Promise<T>): Promise<T> {
	const end = context.getStore()?.beginActivity(activity);
	try { return await run(); }
	finally { end?.(); }
}

export async function observeAnswerKey(run: () => Promise<string[]>): Promise<string[]> {
	const problems = await observeTurnActivity("checker", run);
	if (problems.length) context.getStore()?.refuse("answer-key");
	return problems;
}

export class TurnTimeline {
	private readonly startedAt = new Date().toISOString();
	private readonly start: number;
	private lastEvent: number | null = null;
	private firstEvent: number | null = null;
	private firstVisibleText: number | null = null;
	private longestEventGap = 0;
	private visibleTextChars = 0;
	private thinkingChars = 0;
	private stopReason: StopReason | null = null;
	private clientDrops = 0;
	private finished = false;
	private begun = false;
	private cliEnding: ClaudeCliEnding | null = null;
	private modelWait: number | null = null;
	private thinkingStart: number | null = null;
	private textStart: number | null = null;
	private readonly thinkingSpans: TurnTimelineLine["thinkingSpans"] = [];
	private readonly textSpans: Span[] = [];
	private readonly tools: TurnTimelineLine["tools"] = [];
	private readonly runningTools = new Map<string, { name: string; start: number; proseChars?: number }>();
	private readonly activities = new Map<number, TurnActivity>();
	private nextActivity = 0;
	private readonly checkerSpans: Span[] = [];
	private readonly graderSpans: Span[] = [];
	private readonly processingSpans: Span[] = [];
	private readonly gateRefusals = new Map<string, number>();
	private readonly refusalBudgetPasses = new Map<string, number>();
	private onActivity?: (activity: TurnActivity | null) => void;

	constructor(
		private identity: Identity,
		private readonly write: ((line: TurnTimelineLine) => void) | undefined = process.env.NODE_ENV === "test" ? undefined : writer.append,
		private readonly clock = () => performance.now(),
		private readonly writeStart: ((line: TurnTimelineStartLine) => void) | undefined = process.env.NODE_ENV === "test" ? undefined : writer.append,
	) { this.start = clock(); }

	private now() { return Math.round(this.clock() - this.start); }
	private span(startMs: number, endMs: number): Span { return { startMs, durationMs: endMs - startMs }; }

	setModel(provider: string, model: string, thinking: boolean) {
		this.identity = { ...this.identity, provider, model, thinking };
	}

	run<T>(run: () => T): T { return context.run(this, run); }

	/** The start line: ids, provider, model and start time only, like the rest of the log (no prompt or answer text). Once. */
	begin() {
		if (this.begun || this.finished) return;
		this.begun = true;
		try { this.writeStart?.({ kind: "start", ...this.identity, startedAt: this.startedAt }); }
		catch { /* Diagnostics cannot interfere with the turn. */ }
	}

	bindActivity(listener: (activity: TurnActivity | null) => void) {
		this.onActivity = listener;
	}

	beginActivity(activity: TurnActivity): () => void {
		const id = ++this.nextActivity;
		const start = this.now();
		this.activities.set(id, activity);
		this.onActivity?.(activity);
		return () => {
			const span = this.span(start, this.now());
			(activity === "checker" ? this.checkerSpans : activity === "grader" ? this.graderSpans : this.processingSpans).push(span);
			this.activities.delete(id);
			this.onActivity?.([...this.activities.values()].at(-1) ?? null);
		};
	}

	refuse(gate: string) {
		this.gateRefusals.set(gate, (this.gateRefusals.get(gate) ?? 0) + 1);
	}

	/** A gate's call passed because the refusal budget was spent (gate name and count only). */
	passOverBudget(gate: string) {
		this.refusalBudgetPasses.set(gate, (this.refusalBudgetPasses.get(gate) ?? 0) + 1);
	}

	dropped() { this.clientDrops++; }

	event(event: AgentEvent) {
		const now = this.now();
		this.firstEvent ??= now;
		// The wait before the first event is a gap too (re-check 2, finding 3): a turn that stalls before the model says
		// anything is the stall this number exists to show.
		this.longestEventGap = Math.max(this.longestEventGap, now - (this.lastEvent ?? 0));
		this.lastEvent = now;
		if (event.type === "turn_start" && this.identity.thinking) this.modelWait = now;
		if (event.type === "message_update") {
			switch (event.assistantMessageEvent.type) {
				case "thinking_start":
					// Reported thinking: the wait before it is not an inferred thinking span.
					this.modelWait = null;
					this.closeThinking(now);
					this.thinkingStart = now;
					break;
				case "thinking_end": this.closeThinking(now); break;
				case "text_start": this.textStart = now; this.closeThinking(now); break;
				case "text_delta":
					if (event.assistantMessageEvent.delta.trim()) this.firstVisibleText ??= now;
					break;
				case "text_end": this.closeText(now); break;
				case "toolcall_start": this.closeThinking(now); break;
			}
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			const message = event.message;
			this.stopReason = message.stopReason;
			this.cliEnding = cliEndingOf(message);
			this.closeThinking(now);
			this.closeText(now);
			for (const block of message.content) {
				if (block.type === "thinking") this.thinkingChars += block.thinking.length;
				if (block.type === "text" && block.text.trim()) {
					this.visibleTextChars += block.text.length;
					this.firstVisibleText ??= now;
				}
			}
		}
		if (event.type === "tool_execution_start") {
			const proseChars = sendToUserText({ type: "toolCall", name: event.toolName, id: event.toolCallId, arguments: event.args })?.length;
			this.runningTools.set(event.toolCallId, { name: event.toolName, start: now, proseChars });
		}
		if (event.type === "tool_execution_end") {
			const chars = this.runningTools.get(event.toolCallId)?.proseChars;
			this.closeTool(event.toolCallId, now);
			if (!event.isError && chars) { this.visibleTextChars += chars; this.firstVisibleText ??= now; }
		}
	}

	private closeThinking(now: number) {
		if (this.thinkingStart !== null) this.thinkingSpans.push({ ...this.span(this.thinkingStart, now), source: "reported" });
		else if (this.modelWait !== null && now > this.modelWait) this.thinkingSpans.push({ ...this.span(this.modelWait, now), source: "inferred" });
		this.thinkingStart = this.modelWait = null;
	}

	private closeText(now: number) {
		if (this.textStart !== null) this.textSpans.push(this.span(this.textStart, now));
		this.textStart = null;
	}

	private closeTool(id: string, now: number) {
		const tool = this.runningTools.get(id);
		if (!tool) return;
		this.tools.push({ name: tool.name, ...this.span(tool.start, now) });
		this.runningTools.delete(id);
	}

	finish(aborted: boolean, errorKind: ErrorKind | null = null) {
		if (this.finished) return;
		this.finished = true;
		const now = this.now();
		// The silence before the end is the stall this log exists to find.
		this.longestEventGap = Math.max(this.longestEventGap, now - (this.lastEvent ?? 0));
		this.closeThinking(now);
		this.closeText(now);
		for (const id of this.runningTools.keys()) this.closeTool(id, now);
		if (this.stopReason === "error") errorKind ??= "provider";
		const streamEnd = errorKind ? "error" : aborted ? "aborted" : "completed";
		try {
			this.write?.({
				...this.identity, startedAt: this.startedAt, durationMs: now,
				firstEventMs: this.firstEvent, firstVisibleTextMs: this.firstVisibleText, longestEventGapMs: this.longestEventGap,
				thinkingSpans: this.thinkingSpans, textSpans: this.textSpans, tools: this.tools,
				checkerSpans: this.checkerSpans, graderSpans: this.graderSpans, processingSpans: this.processingSpans, gateRefusals: Object.fromEntries(this.gateRefusals),
				refusalBudgetPasses: Object.fromEntries(this.refusalBudgetPasses),
				stopReason: this.stopReason, streamEnd, errorKind, clientDrops: this.clientDrops,
				visibleTextChars: this.visibleTextChars, thinkingChars: this.thinkingChars, cliEnding: this.cliEnding,
			});
		} catch { /* Diagnostics cannot interfere with settlement. */ }
	}
}
