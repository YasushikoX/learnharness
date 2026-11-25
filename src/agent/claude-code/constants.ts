export { CLAUDE_CODE_PROVIDER } from "../../core/contracts/claude-code.ts";

export const CLAUDE_CODE_API = "claude-code-cli";

export enum ClaudeCodeError {
	CliNotFound = "claude CLI not found",
	NotSignedIn = "not signed in",
}

/** How the claude CLI ended one assistant message, for the turn timeline only (fork, follow-ups 1). `message-stop` is the
 *  stream's own end; `tool-admission` hands held tool calls to the app; `result-without-stream-end` is a successful final
 *  `result` line with no `message_stop` before it (never seen from the real CLI, settled defensively). */
export const CLAUDE_CLI_ENDINGS = ["message-stop", "tool-admission", "result-without-stream-end", "result-error", "assistant-error", "process-exit", "aborted", "start-failed", "adapter-error"] as const;
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
