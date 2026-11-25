import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const data = process.env.LH_DATA_DIR ?? fileURLToPath(new URL("../data", import.meta.url));
const file = process.argv[2] ?? resolve(data, "logs", "turns.jsonl");
const turns = [];
let unreadable = 0;
for (const name of [file + ".1", file]) {
	let content;
	try { content = await readFile(name, "utf8"); }
	catch (error) { if (error.code === "ENOENT") continue; throw error; }
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try { turns.push(JSON.parse(line)); }
		catch { unreadable++; }
	}
}

const slowest = [...turns].sort((a, b) => b.durationMs - a.durationMs);
const describe = ({ turnId, chatId, model, provider, durationMs, firstVisibleTextMs, longestEventGapMs, stopReason, streamEnd, errorKind }) =>
	({ turnId, chatId, provider, model, durationMs, firstVisibleTextMs, longestEventGapMs, stopReason, streamEnd, errorKind });
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
	slowestTurns: slowest.slice(0, 10).map(describe),
	turnsWithoutVisibleText: { count: empty.length, slowest: empty.slice(0, 10).map(describe) },
	mostRefusedGates: Object.fromEntries([...refusals].sort((a, b) => b[1] - a[1])),
}, null, 2));
