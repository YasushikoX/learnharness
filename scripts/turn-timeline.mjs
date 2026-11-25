import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const data = process.env.LH_DATA_DIR ?? fileURLToPath(new URL("../data", import.meta.url));
const file = process.argv[2] ?? resolve(data, "logs", "turns.jsonl");
const turns = [];
// Start lines (follow-ups 1): a turn whose start has no finish line hung and was abandoned, or is still running. Older logs
// have none, so every line without `kind` is a finished turn.
const starts = new Map();
let writeFailures = 0;
let unreadable = 0;
for (const name of [file + ".1", file]) {
	let content;
	try { content = await readFile(name, "utf8"); }
	catch (error) { if (error.code === "ENOENT") continue; throw error; }
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		let parsed;
		try { parsed = JSON.parse(line); }
		catch { unreadable++; continue; }
		writeFailures = Math.max(writeFailures, Number(parsed.writeFailures) || 0);
		if (parsed.kind === "start") starts.set(parsed.turnId, parsed);
		else turns.push(parsed);
	}
}

const slowest = [...turns].sort((a, b) => b.durationMs - a.durationMs);
const describe = ({ turnId, chatId, model, provider, durationMs, firstEventMs, firstVisibleTextMs, longestEventGapMs, stopReason, streamEnd, errorKind, cliEnding }) =>
	({ turnId, chatId, provider, model, durationMs, firstEventMs, firstVisibleTextMs, longestEventGapMs, stopReason, streamEnd, errorKind, cliEnding });
const finished = new Set(turns.map(turn => turn.turnId));
const now = Date.now();
const unfinished = [...starts.values()].filter(start => !finished.has(start.turnId))
	.map(({ turnId, chatId, provider, model, startedAt }) => ({ turnId, chatId, provider, model, startedAt, startedMinutesAgo: Math.round((now - Date.parse(startedAt)) / 60_000) }))
	.sort((a, b) => b.startedMinutesAgo - a.startedMinutesAgo);
const endings = {};
for (const turn of turns) if (turn.cliEnding) endings[turn.cliEnding] = (endings[turn.cliEnding] ?? 0) + 1;
const empty = slowest.filter(turn => turn.visibleTextChars === 0);
const refusals = new Map();
for (const turn of turns) {
	for (const [gate, count] of Object.entries(turn.gateRefusals ?? {})) {
		refusals.set(gate, (refusals.get(gate) ?? 0) + count);
	}
}

console.log(JSON.stringify({
	turns: turns.length,
	unreadableLines: unreadable,
	// The most lines one app run failed to write before a line that made it (the count restarts with the app).
	timelineWriteFailures: writeFailures,
	turnsStartedNeverFinished: { count: unfinished.length, turns: unfinished.slice(0, 20) },
	claudeCliEndings: endings,
	slowestTurns: slowest.slice(0, 10).map(describe),
	turnsWithoutVisibleText: { count: empty.length, slowest: empty.slice(0, 10).map(describe) },
	mostRefusedGates: Object.fromEntries([...refusals].sort((a, b) => b[1] - a[1])),
}, null, 2));
