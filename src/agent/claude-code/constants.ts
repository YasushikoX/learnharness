export { CLAUDE_CODE_PROVIDER } from "../../core/contracts/claude-code.ts";

export const CLAUDE_CODE_API = "claude-code-cli";

export enum ClaudeCodeError {
	CliNotFound = "claude CLI not found",
	NotSignedIn = "not signed in",
}

/** How the claude CLI ended one assistant message, for the turn timeline only (fork, follow-ups 1). `message-stop` is the
 *  stream's own end; `tool-admission` hands held tool calls to the app; the rest are the adapter's failure paths. Recorded
 *  only: nothing reads it back to decide anything. */
export const CLAUDE_CLI_ENDINGS = ["message-stop", "tool-admission", "result-error", "assistant-error", "process-exit", "aborted", "start-failed", "adapter-error"] as const;
export type ClaudeCliEnding = (typeof CLAUDE_CLI_ENDINGS)[number];

const CLI_ENDING = Symbol.for("lh.claudeCliEnding");

/** Non-enumerable, so it never reaches the record, the wire, a clone or the reuse comparison. */
export function markCliEnding(message: object, ending: ClaudeCliEnding): void {
	Object.defineProperty(message, CLI_ENDING, { value: ending, configurable: true, enumerable: false, writable: true });
}

export function cliEndingOf(message: object): ClaudeCliEnding | null {
	const value = (message as Record<symbol, unknown>)[CLI_ENDING];
	return (CLAUDE_CLI_ENDINGS as readonly unknown[]).includes(value) ? value as ClaudeCliEnding : null;
}

/** Something the adapter saw and only records (fork, follow-ups 1). `result-before-stream-end`: a successful `result` line
 *  arrived while the turn had not finished. The turn carries on unchanged; this only leaves a trace for the next stall. */
export type ClaudeCliObservation = "result-before-stream-end";
export type ClaudeCliObservationSink = (note: ClaudeCliObservation) => void;

/** Set by the server's turn timeline (the adapter never imports the server). Called when a turn's stream function is
 *  entered, inside that turn's context, it returns where that turn's observations go. Held on globalThis so a duplicated
 *  module instance (dev bundles) still finds it. */
const observation = globalThis as typeof globalThis & { __lhClaudeCliObservationCapture?: () => ClaudeCliObservationSink | undefined };

/** Returns the capture it replaces (tests restore it). */
export function setClaudeCliObservationCapture(capture: (() => ClaudeCliObservationSink | undefined) | undefined): (() => ClaudeCliObservationSink | undefined) | undefined {
	const previous = observation.__lhClaudeCliObservationCapture;
	observation.__lhClaudeCliObservationCapture = capture;
	return previous;
}

export function captureClaudeCliObservationSink(): ClaudeCliObservationSink | undefined {
	try { return observation.__lhClaudeCliObservationCapture?.(); }
	catch { return undefined; /* Diagnostics cannot interfere with the turn. */ }
}
