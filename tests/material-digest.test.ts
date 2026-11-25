/**
 * Indexing a converted document into its digest (fork addition, 2026-11-24; agent/subagents/material-digest.ts) and
 * merging digests into a class glossary (core/glossary.ts). The model is a scripted fake injected through the deps,
 * never a real one: call counts (one for a single batch, batches + 1 otherwise), the retry with the validation error,
 * failed batches recorded while the others succeed, the merge of duplicate terms, stable ids, and alias matching.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { digestMaterial, MATERIAL_INDEXER_VERSION, validateBatchReply, type DigestModelCall } from "../src/agent/subagents/material-digest.ts";
import { conceptId, findTerm, mergeGlossary, slugOf, termId } from "../src/core/glossary.ts";
import { splitMaterial } from "../src/core/material-split.ts";
import type { MaterialDigest } from "../src/core/contracts/material-digest.ts";

const META = { sourceHash: "sha256:abc", converter: "pdfjs-markdown", converterVersion: "5.4.0" };

/** A budget that splits the 40-page test deck into several batches (the default gives two). */
const SMALL = { budgetTokens: 2_000 };

const PROFILE ="## Scope and targets\nDeriver funksjoner (p. 1).\n\n## Contents\nDerivasjon (p. 1-3).";

interface Call {
	system: string;
	user: string;
}

/** A fake model: `reply(call, n)` answers the n-th call (0-based). */
function fakeModel(reply: (call: Call, n: number) => string): { complete: DigestModelCall; calls: Call[] } {
	const calls: Call[] = [];
	const complete: DigestModelCall = async (request) => {
		calls.push(request);
		return reply(request, calls.length - 1);
	};
	return { complete, calls };
}

/** The page range a batch request states. */
function requestRange(user: string): { from: number; to: number } {
	const m = /, pages? (\d+)(?:-(\d+))?\./.exec(user)!;
	return { from: Number(m[1]), to: Number(m[2] ?? m[1]) };
}

const isReduce = (call: Call) => call.user.includes("<notes>");

/** Notes for a batch request: one term per page in range plus whatever `extra` adds. */
function notesFor(user: string, extra: Record<string, unknown> = {}): string {
	const { from } = requestRange(user);
	return JSON.stringify({
		summaryBullets: [`Del fra side ${from}`],
		terms: [{ term: `Begrep ${from}`, aliases: [], definition: `Definisjon av begrep ${from}.`, page: from, tier: "supporting" }],
		concepts: [{ name: `Ide ${from}`, statement: `Ide ${from} gjelder.`, page: from }],
		figures: [{ page: from, caption: `Figur på side ${from}` }],
		...extra,
	});
}

function slideDeck(pages: number, charsPerPage: number): string {
	const out: string[] = [];
	for (let n = 1; n <= pages; n++) out.push(`--- Page ${n} ---\n\nLysbilde ${n}\n\n${"Den deriverte er grensen av differensekvotienten. ".repeat(Math.ceil(charsPerPage / 50))}`);
	return out.join("\n\n");
}

describe("digestMaterial", () => {
	it("a single-batch document (a slide deck) costs exactly one call, which also writes the profile", async () => {
		const doc = slideDeck(3, 200);
		const model = fakeModel((call) => notesFor(call.user, { profile: `Some preamble.\n\n${PROFILE}` }));
		const digest = await digestMaterial(doc, { ...META, complete: model.complete, name: "Forelesning 1" });
		assert.equal(model.calls.length, 1);
		assert.match(model.calls[0]!.user, /the whole document/);
		assert.match(model.calls[0]!.user, /"profile" field/);
		assert.match(model.calls[0]!.user, /<material>\n--- Page 1 ---/);
		assert.match(model.calls[0]!.system, /EVERY technical term/);
		assert.match(model.calls[0]!.system, /material's own language/);
		assert.equal(digest.profile, PROFILE, "the profile from its first ## heading on");
		assert.deepEqual(digest.batches, [{ index: 0, pageStart: 1, pageEnd: 3 }]);
		assert.deepEqual(digest.failedBatches, []);
		assert.equal(digest.version, 1);
		assert.equal(digest.indexerVersion, MATERIAL_INDEXER_VERSION);
		assert.equal(digest.sourceHash, META.sourceHash);
		assert.equal(digest.converter, META.converter);
		assert.equal(digest.converterVersion, META.converterVersion);
		assert.equal(digest.pageCount, 3);
		assert.deepEqual(digest.terms, [{ id: "t_begrep-1", term: "Begrep 1", aliases: [], definition: "Definisjon av begrep 1.", page: 1, tier: "supporting" }]);
		assert.deepEqual(digest.concepts, [{ id: "c_ide-1", name: "Ide 1", statement: "Ide 1 gjelder.", page: 1 }]);
		assert.deepEqual(digest.figures, [{ page: 1, caption: "Figur på side 1" }]);
		assert.ok(!("profile" in (digest.terms[0] as object)));
	});

	it("a multi-batch document makes one call per batch plus one reduce call for the profile", async () => {
		const doc = slideDeck(40, 1_500);
		const batches = splitMaterial(doc);
		assert.ok(batches.length >= 2);
		const model = fakeModel((call) => (isReduce(call) ? `Here is the profile.\n\n${PROFILE}` : notesFor(call.user)));
		const digest = await digestMaterial(doc, { ...META, complete: model.complete });
		assert.equal(model.calls.length, batches.length + 1);
		const reduce = model.calls.at(-1)!;
		assert.ok(isReduce(reduce));
		assert.match(reduce.system, /## Definitions and terminology/);
		for (const b of batches) assert.match(reduce.user, new RegExp(`### Part ${b.index + 1}: pages ${b.pageStart}-${b.pageEnd}`));
		assert.match(reduce.user, /Begrep 1 \[supporting, p\. 1\]: Definisjon av begrep 1\./);
		assert.ok(model.calls.slice(0, -1).every((c) => !/"profile" field/.test(c.user)), "batch calls do not ask for the profile");
		assert.equal(digest.profile, PROFILE);
		assert.deepEqual(
			digest.batches,
			batches.map((b) => ({ index: b.index, pageStart: b.pageStart, pageEnd: b.pageEnd })),
		);
		assert.equal(digest.terms.length, batches.length);
		assert.equal(digest.pageCount, 40);
	});

	it("an invalid reply is retried once with the validation error; a batch that fails twice is recorded and the others succeed", async () => {
		const doc = slideDeck(40, 1_500);
		const batches = splitMaterial(doc, SMALL);
		assert.ok(batches.length >= 3, `three batches needed, got ${batches.length}`);
		const second = batches[1]!;
		const third = batches[2]!;
		let thirdTries = 0;
		const model = fakeModel((call) => {
			if (isReduce(call)) return PROFILE;
			const { from } = requestRange(call.user);
			if (from === second.pageStart) return "Sorry, here are some notes: not JSON at all.";
			if (from === third.pageStart && thirdTries++ === 0) return notesFor(call.user, { terms: [{ term: "Feil", aliases: [], definition: "", page: 999, tier: "key" }] });
			return notesFor(call.user);
		});
		const digest = await digestMaterial(doc, { ...META, complete: model.complete, split: SMALL });

		// batch 2: asked twice, the second time with the first reply and its error
		const secondCalls = model.calls.filter((c) => !isReduce(c) && requestRange(c.user).from === second.pageStart);
		assert.equal(secondCalls.length, 2);
		assert.match(secondCalls[1]!.user, /Your previous reply was rejected: the reply is not one JSON object/);
		assert.match(secondCalls[1]!.user, /<previous_reply>\nSorry, here are some notes: not JSON at all\.\n<\/previous_reply>/);
		// batch 3: the schema errors are fed back, the retry succeeds
		const thirdCalls = model.calls.filter((c) => !isReduce(c) && requestRange(c.user).from === third.pageStart);
		assert.equal(thirdCalls.length, 2);
		assert.match(thirdCalls[1]!.user, /\/terms\/0\/definition: /);
		assert.match(thirdCalls[1]!.user, /\/terms\/0\/tier: /);

		assert.equal(model.calls.length, batches.length + 2 + 1, "two retries plus the reduce");
		assert.deepEqual(
			digest.failedBatches.map(({ error: _e, ...ref }) => ref),
			[{ index: 1, pageStart: second.pageStart, pageEnd: second.pageEnd }],
		);
		assert.match(digest.failedBatches[0]!.error, /not one JSON object/);
		assert.equal(digest.batches.length, batches.length, "the failed batch stays in the plan");
		assert.equal(digest.terms.length, batches.length - 1);
		assert.ok(digest.terms.some((t) => t.id === termId(`Begrep ${third.pageStart}`)), "the retried batch is indexed");
		const reduce = model.calls.at(-1)!;
		assert.match(reduce.user, new RegExp(`Not indexed, the notes are missing: pages ${second.pageStart}-${second.pageEnd}`));
	});

	it("a model call that throws records the batch; an abort throws; all batches failing throws", async () => {
		const doc = slideDeck(40, 1_500);
		const batches = splitMaterial(doc);
		const flaky = fakeModel((call, n) => {
			if (n === 0) throw new Error("rate limited");
			return isReduce(call) ? PROFILE : notesFor(call.user);
		});
		const digest = await digestMaterial(doc, { ...META, complete: flaky.complete });
		assert.equal(digest.failedBatches.length, 1);
		assert.match(digest.failedBatches[0]!.error, /the model call failed: rate limited/);
		assert.equal(flaky.calls.length, batches.length + 1, "a thrown call is not retried");

		const controller = new AbortController();
		const aborting = fakeModel(() => {
			controller.abort();
			throw Object.assign(new Error("aborted"), { name: "AbortError" });
		});
		await assert.rejects(digestMaterial(doc, { ...META, complete: aborting.complete, signal: controller.signal }), /aborted/);
		assert.equal(aborting.calls.length, 1);

		const broken = fakeModel(() => "no");
		await assert.rejects(digestMaterial(slideDeck(2, 100), { ...META, complete: broken.complete }), /no part of the material could be indexed/);
		assert.equal(broken.calls.length, 2);
		await assert.rejects(digestMaterial("  \n", { ...META, complete: broken.complete }), /empty/);
	});

	it("a reduce reply without a profile heading is retried once, then throws", async () => {
		const doc = slideDeck(40, 1_500);
		const model = fakeModel((call) => (isReduce(call) ? "I could not write it." : notesFor(call.user)));
		await assert.rejects(digestMaterial(doc, { ...META, complete: model.complete }), /the profile could not be written/);
		assert.equal(model.calls.filter(isReduce).length, 2);
		assert.match(model.calls.at(-1)!.user, /Your previous reply was rejected: the profile has no "## " section heading/);
	});

	it("duplicate terms across batches merge: same id, aliases unioned, the earliest page, core if any batch said core", async () => {
		const doc = slideDeck(40, 1_500);
		const batches = splitMaterial(doc, SMALL);
		assert.ok(batches.length >= 3);
		const model = fakeModel((call) => {
			if (isReduce(call)) return PROFILE;
			const { from } = requestRange(call.user);
			const idx = batches.findIndex((b) => b.pageStart === from);
			const variants = [
				{ term: "Den deriverte", aliases: ["f'(x)"], definition: "Grensen av differensekvotienten.", page: from, tier: "supporting" },
				{ term: "den  DERIVERTE", aliases: ["derivert", "f'(x)"], definition: "Senere definisjon.", page: from, tier: "core" },
				{ term: "Den-deriverte", aliases: ["Derivert", "dy/dx"], definition: "Enda senere.", page: from, tier: "supporting" },
			];
			return JSON.stringify({
				summaryBullets: [],
				terms: [variants[idx % variants.length]],
				concepts: [{ name: "Kjerneregelen", statement: `Kjerneregelen, side ${from}.`, page: from }],
				figures: [],
			});
		});
		const digest = await digestMaterial(doc, { ...META, complete: model.complete, split: SMALL });
		assert.equal(digest.terms.length, 1);
		const [term] = digest.terms;
		assert.equal(term!.id, "t_den-deriverte");
		assert.equal(term!.term, "Den deriverte", "the earliest occurrence's spelling");
		assert.equal(term!.definition, "Grensen av differensekvotienten.");
		assert.equal(term!.page, 1);
		assert.equal(term!.tier, "core");
		assert.deepEqual(term!.aliases, ["f'(x)", "derivert", "dy/dx"]);
		assert.deepEqual(digest.concepts, [{ id: "c_kjerneregelen", name: "Kjerneregelen", statement: "Kjerneregelen, side 1.", page: 1 }]);
	});
});

describe("validateBatchReply", () => {
	it("accepts a fenced JSON reply, refuses pages outside the batch, and requires the profile for a single batch", () => {
		const notes = { summaryBullets: ["a"], terms: [], concepts: [], figures: [{ page: 4, caption: "x" }] };
		assert.equal(validateBatchReply("```json\n" + JSON.stringify(notes) + "\n```", { pageStart: 3, pageEnd: 5 }, false).ok, true);
		const outside = validateBatchReply(JSON.stringify(notes), { pageStart: 1, pageEnd: 2 }, false);
		assert.equal(outside.ok, false);
		assert.match((outside as { error: string }).error, /this part is pages 1-2, but \/figures\/0 has page 4/);
		const noProfile = validateBatchReply(JSON.stringify(notes), { pageStart: 4, pageEnd: 4 }, true);
		assert.equal(noProfile.ok, false);
		assert.match((noProfile as { error: string }).error, /profile/);
		const flatProfile = validateBatchReply(JSON.stringify({ ...notes, profile: "just text" }), { pageStart: 4, pageEnd: 4 }, true);
		assert.match((flatProfile as { error: string }).error, /no "## " section heading/);
	});
});

describe("ids", () => {
	it("are stable: the same name in any case, spacing or punctuation gives the same id; scripts and symbols keep distinct ids", () => {
		assert.equal(termId("Eigenvalue"), "t_eigenvalue");
		assert.equal(termId("  eigen-VALUE "), termId("Eigen value"));
		assert.equal(termId("Første ordens ligning"), "t_første-ordens-ligning");
		assert.notEqual(termId("første"), termId("forste"), "diacritics are kept");
		assert.equal(termId("ﬁnite"), termId("finite"), "NFKC folds ligatures");
		assert.equal(termId("λ"), "t_λ");
		assert.equal(termId("∇"), "t_u2207");
		assert.notEqual(termId("∇"), termId("∆"));
		assert.equal(conceptId("Kjerneregelen"), "c_kjerneregelen");
		assert.equal(slugOf("x".repeat(200)).length, 96);
		assert.equal(termId("Den deriverte"), termId("Den deriverte"));
	});

	it("re-indexing the same document gives the same ids", async () => {
		const doc = slideDeck(40, 1_500);
		const run = async () => {
			const model = fakeModel((call) => (isReduce(call) ? PROFILE : notesFor(call.user)));
			return digestMaterial(doc, { ...META, complete: model.complete });
		};
		const [a, b] = [await run(), await run()];
		assert.deepEqual(a.terms.map((t) => t.id), b.terms.map((t) => t.id));
		assert.deepEqual(a.concepts.map((c) => c.id), b.concepts.map((c) => c.id));
	});
});

describe("mergeGlossary and findTerm", () => {
	const term = (name: string, page: number, tier: "core" | "supporting", aliases: string[] = [], definition = `${name} er …`) => ({
		id: termId(name),
		term: name,
		aliases,
		definition,
		page,
		tier,
	});
	const digest = (sourceHash: string, terms: MaterialDigest["terms"]): Pick<MaterialDigest, "sourceHash" | "terms"> => ({ sourceHash, terms });

	it("merges documents by id and by alias, keeps per-document citations, core if any says core", () => {
		const a = digest("doc-a", [term("Egenverdi", 4, "supporting", ["λ"], "Et tall λ slik at Av = λv."), term("Matrise", 1, "core")]);
		const b = digest("doc-b", [term("λ", 12, "core", [], "Egenverdien."), term("matrise", 2, "supporting")]);
		const c = digest("doc-c", [term("Eigenvalue", 7, "supporting", ["Egenverdi"])]);
		const glossary = mergeGlossary([a, b, c]);

		assert.deepEqual(Object.keys(glossary.terms).sort(), ["t_egenverdi", "t_matrise"]);
		const eigen = glossary.terms["t_egenverdi"]!;
		assert.deepEqual(eigen.ids, ["t_egenverdi", "t_eigenvalue", "t_λ"]);
		assert.equal(eigen.term, "Egenverdi");
		assert.equal(eigen.definition, "Et tall λ slik at Av = λv.");
		assert.equal(eigen.tier, "core", "doc-b says core");
		assert.deepEqual(eigen.aliases, ["λ", "Eigenvalue"]);
		assert.deepEqual(eigen.citations, [
			{ sourceHash: "doc-a", page: 4, definition: "Et tall λ slik at Av = λv.", tier: "supporting" },
			{ sourceHash: "doc-b", page: 12, definition: "Egenverdien.", tier: "core" },
			{ sourceHash: "doc-c", page: 7, definition: "Eigenvalue er …", tier: "supporting" },
		]);
		const matrise = glossary.terms["t_matrise"]!;
		assert.equal(matrise.tier, "core");
		assert.deepEqual(matrise.citations.map((x) => [x.sourceHash, x.page]), [["doc-a", 1], ["doc-b", 2]]);
		assert.deepEqual(matrise.aliases, [], "a different case of the term is not an alias");
	});

	it("the canonical id does not depend on the order documents come in", () => {
		const a = digest("doc-a", [term("Egenverdi", 4, "supporting", ["λ"])]);
		const b = digest("doc-b", [term("λ", 12, "core")]);
		const c = digest("doc-c", [term("Egenverdi", 2, "core")]);
		const orders = [[a, b, c], [c, b, a], [b, a, c]];
		for (const order of orders) assert.deepEqual(Object.keys(mergeGlossary(order).terms), ["t_egenverdi"]);
		// a tie between two own ids goes to the smaller one
		assert.deepEqual(Object.keys(mergeGlossary([b, a]).terms), Object.keys(mergeGlossary([a, b]).terms));
	});

	it("findTerm matches a term, an alias or an id, normalised; unknown text and prototype names match nothing", () => {
		const glossary = mergeGlossary([
			digest("doc-a", [term("Egenverdi", 4, "core", ["λ", "Eigen value"]), term("Den deriverte", 1, "core", ["f'(x)"])]),
		]);
		assert.equal(findTerm(glossary, "egenverdi")?.id, "t_egenverdi");
		assert.equal(findTerm(glossary, "  EGENVERDI ")?.id, "t_egenverdi");
		assert.equal(findTerm(glossary, "λ")?.id, "t_egenverdi");
		assert.equal(findTerm(glossary, "eigen-value")?.id, "t_egenverdi");
		assert.equal(findTerm(glossary, "t_egenverdi")?.id, "t_egenverdi");
		assert.equal(findTerm(glossary, "den deriverte")?.id, "t_den-deriverte");
		assert.equal(findTerm(glossary, "F'(X)")?.id, "t_den-deriverte");
		assert.equal(findTerm(glossary, "integral"), undefined);
		assert.equal(findTerm(glossary, ""), undefined);
		assert.equal(findTerm(glossary, "constructor"), undefined);
		assert.equal(findTerm(glossary, "__proto__"), undefined);
		// the glossary survives a JSON round trip (it is meant to be stored)
		const revived = JSON.parse(JSON.stringify(glossary)) as typeof glossary;
		assert.equal(findTerm(revived, "λ")?.id, "t_egenverdi");
	});
});
