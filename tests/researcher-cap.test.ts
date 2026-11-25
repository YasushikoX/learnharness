/** The cap salvage (owner, 2026-11-18): a run an explicit maxTurns cap cuts off mid-work gets one more request to write its
 * answer, instead of losing everything. Since the v0.7.0 merge the researcher has no cap (upstream c7dd027b), so it no longer
 * opts in. Scripted offline: no network, no model.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { runResearcherAgent } from "../src/agent/subagents/researcher.ts";
import { runSubagent } from "../src/agent/subagents/pi-run.ts";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { SearchProvider } from "../src/core/search.ts";

const provider: SearchProvider = { id: "tavily", async search() { return []; } };
const searchStep = (id: string): FauxResponseStep => () =>
	fauxAssistantMessage([fauxToolCall("web_search", { query: "q " + id }, { id })], { stopReason: "toolUse" });
const BRIEF = "## Summary\nBrief written from the salvage request.";
const lastText = (context: { messages: Array<{ role: string; content?: unknown }> }): string =>
	JSON.stringify(context.messages.at(-1)?.content);

function engineWith(steps: FauxResponseStep[]) {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

/* Upstream v0.7.0 (c7dd027b) removed the researcher's 12-request cap, the root cause the salvage was added for: research now
 * runs to its natural end, so its work is never cut off. The merge keeps salvagePrompt as an opt-in on runSubagent (below) and
 * these researcher tests check the uncapped behaviour instead of the cap. */
describe("researcher without a request cap (upstream v0.7.0)", () => {
	it("a run past 12 requests is not cut off: it gets no salvage request and returns its natural brief", async () => {
		let requests = 0;
		let salvageSeen = false;
		const steps: FauxResponseStep[] = Array.from({ length: 13 }, (_, i) => searchStep("s" + i));
		steps.push((context) => {
			requests++;
			salvageSeen = /request budget is used up/.test(lastText(context));
			return fauxAssistantMessage([fauxText(BRIEF)]);
		});
		const brief = await runResearcherAgent("Anything", { engine: engineWith(steps), search: () => provider });
		assert.equal(brief, BRIEF);
		assert.equal(requests, 1, "the brief request comes after all 13 searches");
		assert.ok(!salvageSeen, "no budget message is ever sent");
	});

	it("a run that finishes early never sends the salvage request", async () => {
		let requests = 0;
		const steps: FauxResponseStep[] = [
			searchStep("s0"),
			(context) => { requests++; assert.ok(!/request budget is used up/.test(lastText(context))); return fauxAssistantMessage([fauxText(BRIEF)]); },
		];
		assert.equal(await runResearcherAgent("Anything", { engine: engineWith(steps), search: () => provider }), BRIEF);
		assert.equal(requests, 1);
	});

	it("the researcher prompt states no request budget (there is none)", async () => {
		let prompt = "";
		const steps: FauxResponseStep[] = [(context) => {
			const system = context.messages.find((m) => m.role === "system");
			prompt = typeof system?.content === "string" ? system.content : "";
			return fauxAssistantMessage([fauxText(BRIEF)]);
		}];
		await runResearcherAgent("Anything", { engine: engineWith(steps), search: () => provider });
		// The prompt was really captured (an empty string would pass the negative check below on its own).
		assert.match(prompt, /You are a research specialist/);
		assert.doesNotMatch(prompt, /at most 12 model requests|request budget/);
	});
});

describe("runSubagent salvagePrompt is opt-in", () => {
	const tool = { name: "again", label: "again", description: "Again", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: null }) };
	const cutRun = (extra: Record<string, unknown>) => runSubagent([tool], {
		engine: engineWith([
			() => fauxAssistantMessage([fauxText("Interim note."), fauxToolCall("again", {}, { id: "a1" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Salvaged answer.")]),
		]),
		systemPrompt: "Fixture", prompt: "Fixture", maxTurns: 1, ...extra,
	});

	it("without salvagePrompt a cut-off run behaves as before (no extra request)", async () => {
		const result = await cutRun({});
		assert.equal(result.text, "Interim note.");
	});

	it("with salvagePrompt the same cut-off run returns the salvage reply", async () => {
		const result = await cutRun({ salvagePrompt: "Write the answer now." });
		assert.equal(result.text, "Salvaged answer.");
	});

	// Moved here from the researcher's tests (the researcher no longer opts in): the generic rule.
	it("a salvage reply that still asks for tools yields no text, not interim narration", async () => {
		const result = await runSubagent([tool], {
			engine: engineWith([
				() => fauxAssistantMessage([fauxText("Interim note."), fauxToolCall("again", {}, { id: "a1" })], { stopReason: "toolUse" }),
				() => fauxAssistantMessage([fauxText("Let me look once more."), fauxToolCall("again", {}, { id: "a2" })], { stopReason: "toolUse" }),
			]),
			systemPrompt: "Fixture", prompt: "Fixture", maxTurns: 1, salvagePrompt: "Write the answer now.",
		});
		assert.equal(result.text, "");
	});

	it("without a cap, salvagePrompt never fires", async () => {
		let requests = 0;
		const result = await runSubagent([tool], {
			engine: engineWith([
				() => { requests++; return fauxAssistantMessage([fauxText("Interim note."), fauxToolCall("again", {}, { id: "a1" })], { stopReason: "toolUse" }); },
				() => { requests++; return fauxAssistantMessage([fauxText("Done.")]); },
			]),
			systemPrompt: "Fixture", prompt: "Fixture", salvagePrompt: "Write the answer now.",
		});
		assert.equal(result.text, "Done.");
		assert.equal(requests, 2);
	});

	// Review finding 7: a cap that exists but did not end the run must not trigger the salvage.
	it("a stop rule that ends the run before the cap sends no salvage request and keeps its text", async () => {
		let requests = 0;
		const result = await runSubagent([tool], {
			engine: engineWith([
				() => { requests++; return fauxAssistantMessage([fauxText("Submitted."), fauxToolCall("again", {}, { id: "a1" })], { stopReason: "toolUse" }); },
				() => { requests++; return fauxAssistantMessage([fauxText("Salvaged answer.")]); },
			]),
			systemPrompt: "Fixture", prompt: "Fixture", maxTurns: 10, salvagePrompt: "Write the answer now.",
			shouldStop: (_message, toolResults) => toolResults.some((r) => r.toolName === "again" && !r.isError),
		});
		assert.equal(requests, 1, "no salvage request after an early stop");
		assert.equal(result.text, "Submitted.");
	});

	it("a stop rule firing on the cap's own turn counts as stopped, not cut off", async () => {
		let requests = 0;
		const result = await runSubagent([tool], {
			engine: engineWith([
				() => { requests++; return fauxAssistantMessage([fauxText("Submitted."), fauxToolCall("again", {}, { id: "a1" })], { stopReason: "toolUse" }); },
				() => { requests++; return fauxAssistantMessage([fauxText("Salvaged answer.")]); },
			]),
			systemPrompt: "Fixture", prompt: "Fixture", maxTurns: 1, salvagePrompt: "Write the answer now.",
			shouldStop: () => true,
		});
		assert.equal(requests, 1);
		assert.equal(result.text, "Submitted.");
	});

	it("the same cap reached without a stop rule still salvages", async () => {
		let requests = 0;
		const result = await runSubagent([tool], {
			engine: engineWith([
				() => { requests++; return fauxAssistantMessage([fauxText("Interim note."), fauxToolCall("again", {}, { id: "a1" })], { stopReason: "toolUse" }); },
				() => { requests++; return fauxAssistantMessage([fauxText("Salvaged answer.")]); },
			]),
			systemPrompt: "Fixture", prompt: "Fixture", maxTurns: 1, salvagePrompt: "Write the answer now.",
			shouldStop: () => false,
		});
		assert.equal(requests, 2);
		assert.equal(result.text, "Salvaged answer.");
	});
});
