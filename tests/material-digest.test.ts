/**
 * Indexing a converted document into its digest (fork addition, 2026-11-24; agent/subagents/material-digest.ts) and
 * merging digests into a class glossary (core/glossary.ts). The model is a scripted fake injected through the deps,
 * never a real one: call counts (one for a single batch, batches + 1 otherwise), the retry with the validation error,
 * failed batches recorded while the others succeed, the merge of duplicate terms, stable ids, and alias matching.
 * Tests named "review 1, defect N" / "concern N" reproduce the findings of the first WP3b review
 * (council/reviews/wp3b-review-1.md), and "review 2, finding N" / "concern" / "contract" those of the second
 * (council/reviews/wp3b-review-2.md), with the reviewers' cases.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	batchFromRef,
	batchNotesText,
	buildReduceRequest,
	digestMaterial,
	EXTRACTION_OVERHEAD_MAX_CHARS,
	formatHeadingPath,
	HEADING_PATH_MAX_CHARS,
	MATERIAL_INDEXER_VERSION,
	mergeConcepts,
	mergeTerms,
	REDUCE_REQUEST_MAX_CHARS,
	rewriteProfile,
	validateBatchReply,
	validateProfile,
	type BatchNotes,
	type BatchTerm,
	type DigestModelCall,
	type ReduceFailedPart,
	type ReducePart,
} from "../src/agent/subagents/material-digest.ts";
import {
	conceptId,
	findTerm,
	findTermById,
	findTermCandidates,
	mergeGlossary,
	normalizeName,
	SLUG_MAX_CHARS,
	SLUG_PREFIX_CHARS,
	slugOf,
	termId,
} from "../src/core/glossary.ts";
import { splitMaterial, type MaterialBatch } from "../src/core/material-split.ts";
import { MATERIAL_DIGEST_VERSION, type DigestTerm, type MaterialDigest } from "../src/core/contracts/material-digest.ts";

const META = { sourceHash: "sha256:abc", converter: "pdfjs-markdown", converterVersion: "5.4.0" };

/** A budget that splits the 40-page test deck into several batches (the default gives two). */
const SMALL = { budgetTokens: 2_000 };

const PROFILE = "## Scope and targets\nDeriver funksjoner (p. 1).\n\n## Contents\nDerivasjon (p. 1-3).";

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

/** The page numbers a batch request lists ("This part's pages: 1-4, 7."). */
function requestPages(user: string): number[] {
	const list = /This part's pages: ([^\n]*)\./.exec(user)![1]!;
	return list.split(", ").flatMap((r) => {
		const [a, b] = r.split("-").map(Number);
		return Array.from({ length: (b ?? a!) - a! + 1 }, (_, i) => a! + i);
	});
}

/** The text inside a request's <material> block. */
const materialOf = (user: string) => /<material>\n([\s\S]*)\n<\/material>/.exec(user)![1]!;

const isReduce = (call: Call) => call.user.includes("<notes>");

/** A term as the model writes it, defined on its page unless `definition` is null. */
function modelTerm(term: string, page: number, tier: "core" | "supporting" = "supporting", definition: string | null = `Definisjon av ${term}.`, aliases: string[] = []): BatchTerm {
	return { term, aliases, page, tier, definition, definitionPage: definition === null ? null : page };
}

/** Notes for a batch request: one term per page in range plus whatever `extra` adds. */
function notesFor(user: string, extra: Record<string, unknown> = {}): string {
	const { from } = requestRange(user);
	return JSON.stringify({
		summaryBullets: [`Del fra side ${from}`],
		terms: [modelTerm(`Begrep ${from}`, from, "supporting", `Definisjon av begrep ${from}.`)],
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

/** A split batch with only the fields a helper reads. */
function batchOf(pages: number[], index = 0): MaterialBatch {
	return { index, pageStart: pages[0]!, pageEnd: pages.at(-1)!, pages, headingPath: [], text: "", charStart: 0, charEnd: 1 };
}

/** An indexed part as the reduce notes read it (0-based index). */
function part(index: number, pageStart: number, pageEnd: number, summaryBullets: string[], headingPath: string[] = []): ReducePart {
	return { index, pageStart, pageEnd, headingPath, summaryBullets };
}

/** A failed part as the reduce notes read it (0-based index). */
function failedPart(index: number, pageStart: number, pageEnd = pageStart): ReduceFailedPart {
	return { index, pageStart, pageEnd };
}

/** Every "Part N" / "Parts A-B" the notes name, as 1-based part numbers. */
function namedParts(text: string): Set<number> {
	const covered = new Set<number>();
	for (const m of text.matchAll(/Parts? (\d+)(?:-(\d+))?/g)) for (let p = Number(m[1]); p <= Number(m[2] ?? m[1]); p++) covered.add(p);
	return covered;
}

describe("digestMaterial", () => {
	it("a single-batch document (a slide deck) costs exactly one call, which also writes the profile", async () => {
		const doc = slideDeck(3, 200);
		const model = fakeModel((call) => notesFor(call.user, { profile: `Some preamble.\n\n${PROFILE}` }));
		const digest = await digestMaterial(doc, { ...META, complete: model.complete, name: "Forelesning 1" });
		assert.equal(model.calls.length, 1);
		assert.match(model.calls[0]!.user, /the whole document/);
		assert.match(model.calls[0]!.user, /"profile" field/);
		assert.match(model.calls[0]!.user, /This part's pages: 1-3\./);
		assert.match(model.calls[0]!.user, /<material>\n--- Page 1 ---/);
		assert.match(model.calls[0]!.system, /EVERY technical term/);
		assert.match(model.calls[0]!.system, /material's own language/);
		assert.equal(digest.profile, PROFILE, "the profile from its first ## heading on");
		assert.equal(digest.profileError, undefined);
		assert.deepEqual(digest.batches, [
			{ index: 0, pageStart: 1, pageEnd: 3, pages: [1, 2, 3], headingPath: [], charStart: 0, charEnd: doc.length, status: "indexed", summaryBullets: ["Del fra side 1"] },
		]);
		assert.deepEqual(digest.failedBatches, []);
		assert.equal(digest.version, 3);
		assert.equal(digest.version, MATERIAL_DIGEST_VERSION);
		assert.equal(digest.indexerVersion, MATERIAL_INDEXER_VERSION);
		assert.equal(MATERIAL_INDEXER_VERSION, 3);
		assert.equal(digest.sourceHash, META.sourceHash);
		assert.equal(digest.converter, META.converter);
		assert.equal(digest.converterVersion, META.converterVersion);
		assert.equal(digest.pageCount, 3);
		assert.equal(digest.sourcePageCount, null);
		assert.deepEqual(digest.terms, [{ id: "t_begrep-1", term: "Begrep 1", aliases: [], page: 1, tier: "supporting", definition: "Definisjon av begrep 1.", definitionPage: 1 }]);
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
		assert.match(reduce.user, /- Begrep 1 \[supporting, p\. 1; defined p\. 1\]: Definisjon av begrep 1\./);
		assert.ok(model.calls.slice(0, -1).every((c) => !/"profile" field/.test(c.user)), "batch calls do not ask for the profile");
		assert.equal(digest.profile, PROFILE);
		assert.deepEqual(
			digest.batches,
			batches.map((b) => ({
				index: b.index,
				pageStart: b.pageStart,
				pageEnd: b.pageEnd,
				pages: b.pages,
				headingPath: b.headingPath,
				charStart: b.charStart,
				charEnd: b.charEnd,
				status: "indexed",
				summaryBullets: [`Del fra side ${b.pageStart}`],
			})),
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
			if (from === third.pageStart && thirdTries++ === 0)
				return notesFor(call.user, { terms: [{ term: "Feil", aliases: [], definition: "", definitionPage: 999, page: 999, tier: "key" }] });
			return notesFor(call.user);
		});
		const digest = await digestMaterial(doc, { ...META, complete: model.complete, split: SMALL });

		// batch 2: asked twice, the second time with the first reply and its error
		const secondCalls = model.calls.filter((c) => !isReduce(c) && requestRange(c.user).from === second.pageStart);
		assert.equal(secondCalls.length, 2);
		assert.match(secondCalls[1]!.user, /Your previous reply was rejected: the reply is not one JSON object/);
		assert.match(secondCalls[1]!.user, /<previous_reply>\nSorry, here are some notes: not JSON at all\.\n<\/previous_reply>/);
		assert.match(secondCalls[1]!.user, /Reply again with the corrected JSON object only\.$/);
		// batch 3: the schema errors are fed back, the retry succeeds
		const thirdCalls = model.calls.filter((c) => !isReduce(c) && requestRange(c.user).from === third.pageStart);
		assert.equal(thirdCalls.length, 2);
		assert.match(thirdCalls[1]!.user, /\/terms\/0\/definition: /);
		assert.match(thirdCalls[1]!.user, /\/terms\/0\/tier: /);

		assert.equal(model.calls.length, batches.length + 2 + 1, "two retries plus the reduce");
		assert.deepEqual(
			digest.failedBatches.map(({ error: _e, ...ref }) => ref),
			[{ index: 1, pageStart: second.pageStart, pageEnd: second.pageEnd, pages: second.pages, headingPath: [], charStart: second.charStart, charEnd: second.charEnd, status: "failed" }],
		);
		assert.match(digest.failedBatches[0]!.error, /not one JSON object/);
		assert.equal(digest.batches.length, batches.length, "the failed batch stays in the plan");
		assert.deepEqual(digest.batches[1], digest.failedBatches[0]);
		assert.equal(digest.terms.length, batches.length - 1);
		assert.ok(digest.terms.some((t) => t.id === termId(`Begrep ${third.pageStart}`)), "the retried batch is indexed");
		const reduce = model.calls.at(-1)!;
		assert.match(reduce.user, new RegExp(`Not indexed, so the notes are missing for this part: part 2, pages ${second.pageStart}-${second.pageEnd}\\.\\)`));
	});

	// Changed for the new contract: every batch failing returns a digest instead of throwing.
	it("a model call that throws records the batch (not retried); an abort throws; all batches failing returns an empty digest", async () => {
		const doc = slideDeck(40, 1_500);
		const batches = splitMaterial(doc);
		const flaky = fakeModel((call, n) => {
			if (n === 0) throw new Error("rate limited");
			return isReduce(call) ? PROFILE : notesFor(call.user);
		});
		const digest = await digestMaterial(doc, { ...META, complete: flaky.complete });
		assert.equal(digest.failedBatches.length, 1);
		assert.match(digest.failedBatches[0]!.error, /the model call failed: rate limited/);
		assert.equal(flaky.calls.length, batches.length + 1, "a thrown call is not retried (transport retries are the caller's)");

		const controller = new AbortController();
		const aborting = fakeModel(() => {
			controller.abort();
			throw Object.assign(new Error("aborted"), { name: "AbortError" });
		});
		await assert.rejects(digestMaterial(doc, { ...META, complete: aborting.complete, signal: controller.signal }), /aborted/);
		assert.equal(aborting.calls.length, 1);

		const broken = fakeModel(() => "no");
		const deck = slideDeck(40, 1_500);
		const nothing = await digestMaterial(deck, { ...META, complete: broken.complete });
		const plan = splitMaterial(deck);
		assert.equal(broken.calls.length, plan.length * 2, "each batch asked twice, no reduce");
		assert.deepEqual(nothing.failedBatches.map((f) => f.index), plan.map((b) => b.index));
		assert.deepEqual(nothing.batches.length, plan.length);
		assert.deepEqual([nothing.terms, nothing.concepts, nothing.figures], [[], [], []]);
		assert.equal(nothing.profile, null);
		assert.match(nothing.profileError!, /no part of the material could be indexed/);

		const single = await digestMaterial(slideDeck(2, 100), { ...META, complete: fakeModel(() => "no").complete });
		assert.equal(single.profile, null);
		assert.equal(single.failedBatches.length, 1);
		await assert.rejects(digestMaterial("  \n", { ...META, complete: broken.complete }), /empty/);
	});

	// Changed for the new contract: a failed profile keeps the notes (review 1, defect 5 and the manager's ruling).
	it("a reduce reply without a profile heading is retried once with a Markdown instruction, then the digest keeps its notes without a profile", async () => {
		const doc = slideDeck(40, 1_500);
		const batches = splitMaterial(doc);
		const model = fakeModel((call) => (isReduce(call) ? "I could not write it." : notesFor(call.user)));
		const digest = await digestMaterial(doc, { ...META, complete: model.complete });
		assert.equal(model.calls.filter(isReduce).length, 2);
		assert.match(model.calls.at(-1)!.user, /Your previous reply was rejected: the profile has none of the section headings/);
		assert.match(model.calls.at(-1)!.user, /Reply again with the corrected profile only: Markdown starting at its first "## " heading, not JSON\.$/);
		assert.equal(digest.profile, null);
		assert.match(digest.profileError!, /the profile could not be written/);
		assert.equal(digest.terms.length, batches.length, "every batch's terms are kept");
		assert.deepEqual(digest.failedBatches, []);
	});

	it("duplicate terms across batches merge: same id, aliases unioned, the earliest page, the core mention's definition, core if any batch said core", async () => {
		const doc = slideDeck(40, 1_500);
		const batches = splitMaterial(doc, SMALL);
		assert.ok(batches.length >= 3);
		const model = fakeModel((call) => {
			if (isReduce(call)) return PROFILE;
			const { from } = requestRange(call.user);
			const idx = batches.findIndex((b) => b.pageStart === from);
			const variants = [
				modelTerm("Den deriverte", from, "supporting", "Grensen av differensekvotienten.", ["f'(x)"]),
				modelTerm("den  DERIVERTE", from, "core", "Senere definisjon.", ["derivert", "f′(x)"]),
				modelTerm("Den-deriverte", from, "supporting", "Enda senere.", ["Derivert", "dy/dx"]),
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
		// previously the earliest mention's wording; now the core mention's explicit definition (review 1, defect 10)
		assert.equal(term!.definition, "Senere definisjon.");
		assert.equal(term!.definitionPage, batches[1]!.pageStart);
		assert.equal(term!.page, 1);
		assert.equal(term!.tier, "core");
		assert.deepEqual(term!.aliases, ["f'(x)", "derivert", "dy/dx"], "f′(x) reads as f'(x)");
		assert.deepEqual(digest.concepts, [{ id: "c_kjerneregelen", name: "Kjerneregelen", statement: "Kjerneregelen, side 1.", page: 1 }]);
	});

	// Review 1, defect 2: 200 pages with 30 terms per page gave the reducer 767,018 characters; a model with a 128,000-
	// character limit rejected it and digestMaterial threw away all the successful batches.
	it("review 1, defect 2: the reduce request stays within REDUCE_REQUEST_MAX_CHARS for a 200-page, 30-terms-a-page document, retry included", async () => {
		const pages: string[] = [];
		for (let n = 1; n <= 200; n++) pages.push(`--- Page ${n} ---\n\n${"Termodynamikk handler om energi og entropi. ".repeat(40)}`);
		const doc = pages.join("\n\n");
		const plan = splitMaterial(doc);
		assert.ok(plan.length >= 5);
		const LIMIT = 128_000;
		let reduceTries = 0;
		const model = fakeModel((call) => {
			if (call.system.length + call.user.length > LIMIT) throw new Error(`input too long: ${call.system.length + call.user.length}`);
			if (isReduce(call)) return reduceTries++ === 0 ? "No headings here." : PROFILE;
			const onPages = requestPages(call.user);
			const long = (s: string) => `${s} ${"forklart i detalj med eksempler og merknader ".repeat(4)}`;
			return JSON.stringify({
				summaryBullets: onPages.flatMap((p) => [long(`Side ${p} om energi`), long(`Side ${p} om entropi`), long(`Side ${p} om varme`)]),
				terms: onPages.flatMap((p) => [
					...Array.from({ length: 10 }, (_, k) => modelTerm(`Felles ${k}`, p, "core", long(`Felles ${k}`))),
					...Array.from({ length: 20 }, (_, k) => modelTerm(`Begrep ${p}-${k}`, p, k % 2 ? "core" : "supporting", long(`Begrep ${p}-${k}`))),
				]),
				concepts: onPages.flatMap((p) => Array.from({ length: 5 }, (_, k) => ({ name: `Regel ${p}-${k}`, statement: long(`Regel ${p}-${k}`), page: p }))),
				figures: onPages.map((p) => ({ page: p, caption: long(`Figur ${p}`) })),
			});
		});
		const digest = await digestMaterial(doc, { ...META, complete: model.complete });
		assert.deepEqual(digest.failedBatches, []);
		assert.equal(digest.profile, PROFILE);
		assert.equal(digest.terms.length, 10 + 200 * 20, "every term kept, shared ones once");
		const reduces = model.calls.filter(isReduce);
		assert.equal(reduces.length, 2);
		for (const r of reduces) assert.ok(r.user.length <= REDUCE_REQUEST_MAX_CHARS, `reduce request ${r.user.length} chars`);
		for (const b of plan) assert.match(reduces[0]!.user, new RegExp(`Part ${b.index + 1}\\b`), `part ${b.index + 1} is in the notes`);
		assert.match(reduces[0]!.user, /Felles 0/, "core terms survive before supporting ones");
	});

	it("review 1, defect 2: a 100,000-character heading is capped in every extraction request; the request is its text plus bounded overhead", async () => {
		const doc = `# ${"H".repeat(100_000)}\n\n${"Avsnitt om mengder og funksjoner. ".repeat(1_200)}`;
		const plan = splitMaterial(doc);
		assert.ok(plan.length >= 4);
		const model = fakeModel((call) => (isReduce(call) ? PROFILE : notesFor(call.user)));
		const digest = await digestMaterial(doc, { ...META, complete: model.complete, name: "N".repeat(50_000) });
		assert.deepEqual(digest.failedBatches, []);
		for (const call of model.calls.filter((c) => !isReduce(c))) {
			const overhead = call.user.length - materialOf(call.user).length;
			assert.ok(overhead <= EXTRACTION_OVERHEAD_MAX_CHARS, `overhead ${overhead}`);
		}
		const shown = formatHeadingPath(["A".repeat(500), "B".repeat(500), "C".repeat(500)]);
		assert.ok(shown.length <= HEADING_PATH_MAX_CHARS);
		assert.ok(model.calls.filter(isReduce).every((c) => c.user.length <= REDUCE_REQUEST_MAX_CHARS));
	});

	// Review 1, defect 4: a batch with only markers 2 and 5 accepted a figure cited to page 3; with markers 5 then 2 the
	// validator rejected citations to both real pages.
	it("review 1, defect 4: citations must be on a page the batch's text is actually on", async () => {
		const notes = (page: number) => JSON.stringify({ summaryBullets: [], terms: [], concepts: [], figures: [{ page, caption: "Et bilde" }] });
		const skipped = splitMaterial("--- Page 2 ---\n\nTwo\n\n--- Page 5 ---\n\nFive\n")[0]!;
		const missing = validateBatchReply(notes(3), skipped);
		assert.equal(missing.ok, false);
		assert.match((missing as { error: string }).error, /this part is on pages 2, 5, but \/figures\/0 has page 3/);
		assert.equal(validateBatchReply(notes(5), skipped).ok, true);
		const backward = splitMaterial("--- Page 5 ---\nFive\n--- Page 2 ---\nTwo\n")[0]!;
		assert.equal(validateBatchReply(notes(5), backward).ok, true);
		assert.equal(validateBatchReply(notes(2), backward).ok, true);
		// a definition page is checked too
		const term = JSON.stringify({ summaryBullets: [], terms: [{ ...modelTerm("Matrise", 2), definitionPage: 4 }], concepts: [], figures: [] });
		assert.match((validateBatchReply(term, skipped) as { error: string }).error, /definitionPage has page 4/);

		// end to end: the retry is told which pages exist
		const withProfile = (page: number) => JSON.stringify({ ...(JSON.parse(notes(page)) as object), profile: PROFILE });
		const model = fakeModel((_call, n) => withProfile(n === 0 ? 3 : 5));
		const digest = await digestMaterial("--- Page 2 ---\n\nTwo\n\n--- Page 5 ---\n\nFive\n", { ...META, complete: model.complete });
		assert.equal(model.calls.length, 2);
		assert.match(model.calls[0]!.user, /This part's pages: 2, 5\./);
		assert.match(model.calls[1]!.user, /\/figures\/0 has page 3/);
		assert.deepEqual(digest.figures, [{ page: 5, caption: "Et bilde" }]);
	});

	// Review 1, defect 5: the reduce retry said "Reply again with the corrected JSON object only."; a profile sent as JSON
	// as instructed failed, and the successful batches were lost. A single batch's valid term with a malformed profile
	// twice gave "no part of the material could be indexed".
	it("review 1, defect 5: the reduce retry asks for Markdown, a JSON-wrapped profile is still accepted, and a single batch keeps valid notes when only its profile fails", async () => {
		const doc = slideDeck(40, 1_500);
		let reduceTries = 0;
		const model = fakeModel((call) => {
			if (!isReduce(call)) return notesFor(call.user);
			return reduceTries++ === 0 ? "**Profile**: the material covers derivatives." : JSON.stringify({ profile: PROFILE });
		});
		const digest = await digestMaterial(doc, { ...META, complete: model.complete });
		assert.equal(digest.profile, PROFILE);
		assert.doesNotMatch(model.calls.at(-1)!.user, /JSON object only/);
		assert.match(model.calls.at(-1)!.user, /not JSON\.$/);

		const matrix = modelTerm("matrix", 1, "core", "A rectangular array of numbers.");
		const single = fakeModel(() => JSON.stringify({ summaryBullets: ["Matrices"], terms: [matrix], concepts: [], figures: [], profile: "## Nope" }));
		const one = await digestMaterial("--- Page 1 ---\n\nA matrix is a rectangular array of numbers.\n", { ...META, complete: single.complete });
		assert.equal(single.calls.length, 2, "asked again for the profile");
		assert.match(single.calls[1]!.user, /"profile": the profile has none of the section headings/);
		assert.deepEqual(one.failedBatches, []);
		assert.deepEqual(one.terms.map((t) => [t.id, t.definition]), [["t_matrix", "A rectangular array of numbers."]]);
		assert.equal(one.profile, null);
		assert.match(one.profileError!, /the profile could not be written/);

		// each half of the single call is kept from whichever reply had it right
		const halves = fakeModel((_call, n) =>
			n === 0
				? JSON.stringify({ summaryBullets: ["Matrices"], terms: [matrix], concepts: [], figures: [], profile: "flat text" })
				: JSON.stringify({ summaryBullets: [], terms: [{ term: " " }], concepts: [], figures: [], profile: PROFILE }),
		);
		const both = await digestMaterial("--- Page 1 ---\n\nA matrix.\n", { ...META, complete: halves.complete });
		assert.deepEqual(both.terms.map((t) => t.id), ["t_matrix"]);
		assert.equal(both.profile, PROFILE);
	});

	// Review 1, defect 6: a whitespace-only core term, a whitespace-only concept name, a blank definition, a blank
	// caption and the profile "## Nope" passed as a successful index.
	it("review 1, defect 6: blank text and a heading-only or unrecognised profile are rejected and retried", async () => {
		const bad = {
			summaryBullets: ["Matriser"],
			terms: [modelTerm("   ", 1, "core"), { ...modelTerm("matrix", 1, "core"), definition: "" }],
			concepts: [{ name: " ", statement: "Noe gjelder.", page: 1 }],
			figures: [{ page: 1, caption: "  " }],
			profile: "## Nope",
		};
		const good = { summaryBullets: ["Matriser"], terms: [modelTerm("matrix", 1, "core")], concepts: [{ name: "Regel", statement: "Noe gjelder.", page: 1 }], figures: [{ page: 1, caption: "Figur" }], profile: PROFILE };
		const model = fakeModel((_call, n) => JSON.stringify(n === 0 ? bad : good));
		const digest = await digestMaterial("--- Page 1 ---\n\nMatriser.\n", { ...META, complete: model.complete });
		assert.equal(model.calls.length, 2);
		const retry = model.calls[1]!.user;
		for (const path of ["/terms/0/term", "/terms/1/definition", "/concepts/0/name", "/figures/0/caption"]) assert.ok(retry.includes(`${path}:`), `${path} reported`);
		assert.match(retry, /"profile": the profile has none of the section headings/);
		assert.equal(digest.profile, PROFILE);
		assert.deepEqual(digest.terms.map((t) => t.term), ["matrix"]);

		assert.equal(validateProfile("## Nope\nSome text.").ok, false);
		assert.match((validateProfile("## Scope and targets\n\n## Contents\n") as { error: string }).error, /sections are empty/);
		assert.equal(validateProfile("Intro.\n\n## Contents\nKapittel 1 (p. 1-3).").ok, true, "the other sections may be left out");
		assert.equal(validateProfile("## Definitions and terminology\n- **matrise**: et rektangulært tallskjema (p. 2)").ok, true);
		assert.equal(validateProfile("plain prose, no headings").ok, false);
	});

	// Review 1, defect 7: aborting inside `complete` and resolving with a valid response returned a digest.
	it("review 1, defect 7: an abort during the last call throws, on the single-batch and the reduce path", async () => {
		const single = new AbortController();
		const onlyCall = fakeModel((call) => {
			single.abort();
			return notesFor(call.user, { profile: PROFILE });
		});
		await assert.rejects(digestMaterial(slideDeck(3, 200), { ...META, complete: onlyCall.complete, signal: single.signal }), { name: "AbortError" });

		const reduce = new AbortController();
		const reduceCall = fakeModel((call) => {
			if (!isReduce(call)) return notesFor(call.user);
			reduce.abort();
			return PROFILE;
		});
		await assert.rejects(digestMaterial(slideDeck(40, 1_500), { ...META, complete: reduceCall.complete, signal: reduce.signal }), { name: "AbortError" });
		assert.equal(reduceCall.calls.filter(isReduce).length, 1);
	});

	// Review 1, defect 8 (the digest half): a fenced example marker gave pageCount 99. Changed for the new contract: the
	// host escapes the example ("\--- Page 99 ---"), and the prompt says an unescaped marker line always starts a page.
	it("review 1, defect 8: an escaped example marker does not count as a page, and the prompt explains both forms", async () => {
		const doc = "--- Page 1 ---\n\n# Intro\n\nText.\n\n```md\n\\--- Page 99 ---\n# Fake\n```\n\n# Real\n\nBody.\n";
		const model = fakeModel((call) => notesFor(call.user, { profile: PROFILE }));
		const digest = await digestMaterial(doc, { ...META, complete: model.complete });
		assert.equal(digest.pageCount, 1);
		assert.match(model.calls[0]!.user, /This part's pages: 1\./);
		assert.match(model.calls[0]!.system, /Every line "--- Page N ---" starts page N, wherever it is/);
		assert.match(model.calls[0]!.system, /A line that starts with a backslash \("\\--- Page N ---"\) is ordinary text/);
		assert.match(model.calls[0]!.system, /A "#" line inside a fenced code block/);
	});

	// Concern 1: what to emit for a term the material uses without defining it.
	it("concern 1: a term the material uses without defining it is kept with a null definition, and the prompt asks for exactly that", async () => {
		const model = fakeModel(() =>
			JSON.stringify({ summaryBullets: ["Egenverdier"], terms: [modelTerm("determinant", 1, "supporting", null), modelTerm("egenverdi", 1, "core")], concepts: [], figures: [], profile: PROFILE }),
		);
		const digest = await digestMaterial("--- Page 1 ---\n\nEgenverdiene finnes med determinanten.\n", { ...META, complete: model.complete });
		assert.deepEqual(digest.terms[0], { id: "t_determinant", term: "determinant", aliases: [], page: 1, tier: "supporting", definition: null, definitionPage: null });
		assert.match(model.calls[0]!.system, /or null when this part uses the term without defining it/);
		assert.match(model.calls[0]!.system, /include terms it uses without defining them/);
		assert.match(model.calls[0]!.system, /An empty list is right only for a part with no technical vocabulary/);
		// a definition without its page (or the reverse) is refused
		const half = JSON.stringify({ summaryBullets: [], terms: [{ ...modelTerm("x", 1), definitionPage: null }], concepts: [], figures: [] });
		assert.match((validateBatchReply(half, batchOf([1])) as { error: string }).error, /not both null or both set/);
	});

	// Concern 2: three batches of page 1 persisted the same page range; pageCount of a PDF ending in an image-only page.
	it("concern 2: batches and failed batches persist their character ranges; pageCount is the highest marker, sourcePageCount the caller's", async () => {
		const doc = Array.from({ length: 30 }, (_, i) => `Avsnitt ${i}: ${"tekst ".repeat(60)}`).join("\n\n");
		const plan = splitMaterial(doc, { budgetTokens: 1_000 });
		assert.ok(plan.length >= 3);
		const model = fakeModel((call) => (isReduce(call) ? PROFILE : materialOf(call.user) === plan[1]!.text ? "nope" : notesFor(call.user)));
		const digest = await digestMaterial(doc, { ...META, complete: model.complete, split: { budgetTokens: 1_000 } });
		assert.ok(digest.batches.every((b) => b.pageStart === 1 && b.pageEnd === 1));
		assert.equal(new Set(digest.batches.map((b) => `${b.charStart}-${b.charEnd}`)).size, digest.batches.length, "distinct ranges");
		assert.equal(digest.batches[0]!.charStart, 0);
		assert.equal(digest.batches.at(-1)!.charEnd, doc.length);
		const failed = digest.failedBatches[0]!;
		assert.equal(failed.index, 1);
		assert.equal(doc.slice(failed.charStart, failed.charEnd), materialOf(model.calls[1]!.user), "the failed slice can be re-run alone");

		// pdf-markdown joinPages leaves out an image-only last page: the markers say 1, the PDF has 2
		const pdf = await digestMaterial("--- Page 1 ---\n\nTekst.", { ...META, sourcePageCount: 2, complete: fakeModel((call) => notesFor(call.user, { profile: PROFILE })).complete });
		assert.equal(pdf.pageCount, 1);
		assert.equal(pdf.sourcePageCount, 2);
	});
});

describe("validateBatchReply and batchNotesText", () => {
	it("accepts a fenced JSON reply and refuses pages the batch is not on", () => {
		const notes = { summaryBullets: ["a"], terms: [], concepts: [], figures: [{ page: 4, caption: "x" }] };
		assert.equal(validateBatchReply("```json\n" + JSON.stringify(notes) + "\n```", batchOf([3, 4, 5])).ok, true);
		const outside = validateBatchReply(JSON.stringify(notes), batchOf([1, 2]));
		assert.equal(outside.ok, false);
		assert.match((outside as { error: string }).error, /this part is on pages 1-2, but \/figures\/0 has page 4/);
		// blank aliases are dropped, not retried; a definition page before the first mention moves the mention
		const term = JSON.stringify({ summaryBullets: [], terms: [{ ...modelTerm("Rang", 4, "core", "Antall pivoter.", ["", " r "]), definitionPage: 3 }], concepts: [], figures: [] });
		const ok = validateBatchReply(term, batchOf([3, 4]));
		assert.ok(ok.ok);
		assert.deepEqual((ok as { value: BatchNotes }).value.terms[0], { term: "Rang", aliases: ["r"], page: 3, tier: "core", definition: "Antall pivoter.", definitionPage: 3 });
	});

	it("review 1, defect 2: the reduce notes fit any budget and name every part, grouping parts past the detail ladder", () => {
		const parts = Array.from({ length: 5_000 }, (_, i) => part(i, i * 3 + 1, i * 3 + 3, [`Del ${i} handler om noe viktig.`, "Mer.", "Enda mer."], ["Kapittel", `Seksjon ${i}`]));
		for (const max of [200_000, 20_000, 2_000]) {
			const text = batchNotesText({ parts, failed: [], terms: [], concepts: [], figures: [] }, max);
			assert.ok(text.length <= max, `${text.length} <= ${max}`);
			const covered = namedParts(text);
			for (let p = 1; p <= parts.length; p++) assert.ok(covered.has(p), `part ${p} is named at budget ${max}`);
		}
	});

	// Review 2, finding 6, case 1: 1,000 parts with 200 core terms at the default budget gave no "## Terms" and none of
	// the 200 core terms.
	it("review 2, finding 6: past the detail ladder the core term names keep their reserved share", () => {
		const parts = Array.from({ length: 1_000 }, (_, i) => part(i, i + 1, i + 1, [`Del ${i} handler om noe viktig og forklarer det grundig.`], ["Kapittel", `Seksjon ${i}`]));
		const core = Array.from({ length: 200 }, (_, k) => ({ id: termId(`Kjernebegrep ${k}`), term: `Kjernebegrep ${k}`, aliases: [], page: k + 1, tier: "core" as const, definition: "En lang definisjon. ".repeat(10), definitionPage: k + 1 }));
		const supporting = Array.from({ length: 300 }, (_, k) => ({ ...core[0]!, id: termId(`Støtte ${k}`), term: `Støtte ${k}`, tier: "supporting" as const }));
		const text = batchNotesText({ parts, failed: [], terms: [...core, ...supporting], concepts: [], figures: [] });
		assert.ok(text.length <= REDUCE_REQUEST_MAX_CHARS, `${text.length}`);
		assert.match(text, /^## Terms$/m);
		for (const t of core) assert.ok(new RegExp(`\\b${t.term}\\b`).test(text), `${t.term} is listed`);
		assert.match(text, /300 supporting terms/);
		const covered = namedParts(text);
		for (let p = 1; p <= parts.length; p++) assert.ok(covered.has(p), `part ${p} is named`);
		// at every budget the core names get their share: as many as fit in a quarter of it
		for (const max of [40_000, 8_000, 2_000]) {
			const small = batchNotesText({ parts, failed: [], terms: core, concepts: [], figures: [] }, max);
			assert.ok(small.length <= max);
			const listed = core.filter((t) => new RegExp(`\\b${t.term}\\b`).test(small)).length;
			// a name and its separator are at most 18 characters; the label and the count take about 100
			assert.ok(listed >= Math.min(200, Math.floor((max / 4 - 100) / 18)), `${listed} core names at budget ${max}`);
			if (listed < 200) assert.ok(small.includes(`(+${200 - listed} more core terms left out for length)`), `the rest is counted at budget ${max}`);
		}
	});

	// Review 2, finding 6, case 2: 1,500 indexed odd-numbered parts with 1,000 failed even ones read "Parts 1-3, pages
	// 1-3" (implying the failed part 2 was included), and the failed line was clipped at 1,000 characters without a count.
	it("review 2, finding 6: parts are never grouped across a gap, and the failed parts are always counted", () => {
		const parts = Array.from({ length: 1_500 }, (_, k) => part(2 * k, 2 * k + 1, 2 * k + 1, [`Oddetall ${2 * k + 1} handler om noe.`]));
		const failed = Array.from({ length: 1_000 }, (_, k) => failedPart(2 * k + 1, 2 * k + 2));
		const text = batchNotesText({ parts, failed, terms: [], concepts: [], figures: [] });
		assert.ok(text.length <= REDUCE_REQUEST_MAX_CHARS);
		const failedLine = text.split("\n").find((l) => l.startsWith("(Not indexed"))!;
		assert.ok(failedLine, "the failed line is there");
		assert.match(failedLine, /^\(Not indexed, so the notes are missing for these 1000 parts: /);
		assert.match(failedLine, /\.\)$/, "the failed line ends cleanly");
		const listed = [...failedLine.matchAll(/part (\d+), page/g)].map((m) => Number(m[1]));
		const unlisted = Number(/\(\+(\d+) more not listed\)/.exec(failedLine)?.[1] ?? 0);
		assert.equal(listed.length + unlisted, 1_000, "every failed part is listed or counted");
		assert.ok(listed.every((p) => p % 2 === 0));
		// every group of parts the notes name holds only indexed (odd) parts: no range spans a failed one
		const partsBlock = text.slice(0, text.indexOf("(Not indexed"));
		for (const m of partsBlock.matchAll(/Parts? (\d+)(?:-(\d+))?/g)) {
			for (let p = Number(m[1]); p <= Number(m[2] ?? m[1]); p++) assert.equal(p % 2, 1, `${m[0]} includes the failed part ${p}`);
		}
		for (let p = 1; p <= 3_000; p += 2) assert.ok(namedParts(partsBlock).has(p), `indexed part ${p} is named`);
		// a gap splits runs in the ladder levels too: two runs, two groups
		const two = batchNotesText({ parts: [part(0, 1, 1, ["a"]), part(1, 2, 2, ["b"]), part(3, 4, 4, ["d"])], failed: [failedPart(2, 3)], terms: [], concepts: [], figures: [] }, 120);
		assert.ok(two.length <= 120);
		assert.doesNotMatch(two, /Parts 1-4|Parts 2-4/);
	});

	// Review 2, finding 6, case 3: maxChars = 100 with 10 failed batches cut mid-word, and the failed line could vanish.
	it("review 2, finding 6: a tiny budget still counts the failed parts and cuts nothing mid-word", () => {
		const words = "Ordaaaaaaaa Ordbbbbbbbb Ordcccccccc Orddddddddd Ordeeeeeeee";
		const parts = Array.from({ length: 5 }, (_, i) => part(i * 3, i * 3 + 1, i * 3 + 1, [words, words]));
		const failed = Array.from({ length: 10 }, (_, i) => failedPart(15 + i, 16 + i));
		const core = [{ id: "t_x", term: "Kjerneord", aliases: [], page: 1, tier: "core" as const, definition: null, definitionPage: null }];
		for (const max of [100, 160, 300, 1_000, 3_000]) {
			const text = batchNotesText({ parts, failed, terms: core, concepts: [], figures: [] }, max);
			assert.ok(text.length <= max, `${text.length} <= ${max}`);
			assert.match(text, /10 parts/, `the failed count at budget ${max}`);
			for (const m of text.matchAll(/Ord[a-z]*/g)) assert.equal(m[0].length, 11, `"${m[0]}" is cut mid-word at budget ${max}`);
			assert.doesNotMatch(text, /Kjerne(?!ord)/, `a core name is cut at budget ${max}`);
		}
	});

	it("property: the reduce notes stay within any budget, count the failed parts and keep core names whole", () => {
		const rand = mulberry32(11);
		for (let round = 0; round < 150; round++) {
			const total = 1 + Math.floor(rand() * 400);
			const parts: ReducePart[] = [];
			const failed: ReduceFailedPart[] = [];
			for (let i = 0; i < total; i++) {
				if (rand() < 0.3) failed.push(failedPart(i, i + 1));
				else parts.push(part(i, i + 1, i + 1 + Math.floor(rand() * 2), Array.from({ length: Math.floor(rand() * 4) }, (_, b) => `Punkt ${b} om emnet i del ${i} med flere ord`), rand() < 0.5 ? ["Kap", `Seksjon ${i}`] : []));
			}
			const terms: DigestTerm[] = Array.from({ length: Math.floor(rand() * 300) }, (_, k) => {
				const definition = rand() < 0.5 ? null : "Definisjon med mange ord i seg.";
				return { id: `t_k${k}`, term: `Begrepnavn${k}`, aliases: rand() < 0.3 ? [`B${k}`] : [], page: 1, tier: rand() < 0.5 ? "core" : "supporting", definition, definitionPage: definition === null ? null : 1 };
			});
			const max = [300, 1_000, 5_000, 20_000, 58_000][Math.floor(rand() * 5)]!;
			const text = batchNotesText({ parts, failed, terms, concepts: [], figures: [] }, max);
			assert.ok(text.length <= max, `round ${round}: ${text.length} > ${max}`);
			if (failed.length > 0) assert.match(text, new RegExp(`(these ${failed.length} parts|this part|${failed.length} parts?)`), `round ${round}: the failed count`);
			for (const m of text.matchAll(/Begrepnavn\d*/g)) assert.ok(terms.some((t) => t.term === m[0]), `round ${round}: "${m[0]}" is a cut name`);
		}
	});
});

describe("ids", () => {
	it("are stable: the same name in any case, spacing or hyphenation gives the same id; scripts keep distinct ids", () => {
		assert.equal(termId("Eigenvalue"), "t_eigenvalue");
		assert.equal(termId("  eigen-VALUE "), termId("Eigen value"));
		assert.equal(termId("Første ordens ligning"), "t_første-ordens-ligning");
		assert.notEqual(termId("første"), termId("forste"), "diacritics are kept");
		assert.equal(termId("ﬁnite"), termId("finite"), "ligatures are folded (targeted, no longer by NFKC)");
		assert.equal(termId("λ"), "t_λ");
		assert.equal(termId("∇"), "t__2207");
		assert.notEqual(termId("∇"), termId("∆"));
		assert.equal(termId("Newton’s law"), termId("Newton's law"), "apostrophe-like marks read as '");
		assert.equal(conceptId("Kjerneregelen"), "c_kjerneregelen");
		assert.equal([...slugOf("x".repeat(200))].length, 96);
		assert.equal(termId("Den deriverte"), termId("Den deriverte"));
	});

	// Review 1, defect 1: C and C++ were both t_c, f(x) and f′(x) both t_f-x, ∇ collided with "u2207", and names
	// differing only after character 96 collided; mergeTerms returned one definition for two terms.
	it("review 1, defect 1: distinct names never share an id", () => {
		const pairs: [string, string][] = [
			["C", "C++"],
			["f(x)", "f′(x)"],
			["∇", "u2207"],
			["a+b", "a b"],
			[`${"lang ".repeat(30)}slutt A`, `${"lang ".repeat(30)}slutt B`],
			[`${"x".repeat(200)}a`, `${"x".repeat(200)}b`],
		];
		for (const [a, b] of pairs) {
			assert.notEqual(termId(a), termId(b), `${a} / ${b}`);
			assert.notEqual(conceptId(a), conceptId(b), `${a} / ${b}`);
			assert.equal(termId(a), termId(a.toUpperCase().toLowerCase()), "and stay stable");
		}
		assert.ok([...slugOf(`${"x".repeat(200)}a`)].length <= 96, "a long key is still bounded");
		const merged = mergeTerms([[modelTerm("C", 1, "core", "Et programmeringsspråk.")], [modelTerm("C++", 2, "core", "En etterfølger av C.")]]);
		assert.deepEqual(merged.map((t) => [t.id, t.definition]), [
			["t_c", "Et programmeringsspråk."],
			["t_c-_2b-_2b", "En etterfølger av C."],
		]);
		const derivatives = mergeTerms([[modelTerm("f(x)", 1, "core", "Funksjonen."), modelTerm("f′(x)", 1, "core", "Den deriverte.")]]);
		assert.equal(derivatives.length, 2);
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

describe("merging terms within a document", () => {
	// Review 1, defect 3 (the batch half): one digest kept "ordinary least squares" and its declared alias "OLS" as two
	// terms with separate pages and tiers.
	it("review 1, defect 3: a term and its own declared alias unify; an alias declared by two terms merges nothing", () => {
		const merged = mergeTerms([
			[modelTerm("ordinary least squares", 3, "supporting", "Minimerer summen av kvadrerte residualer.", ["OLS"]), modelTerm("velocity", 3, "core", "Fart med retning.", ["v"])],
			[modelTerm("OLS", 2, "core", null), modelTerm("voltage", 4, "core", "Spenning.", ["v", "U"]), modelTerm("v", 4, "supporting", null)],
		]);
		const ols = merged.find((t) => t.id === "t_ordinary-least-squares")!;
		assert.deepEqual(
			{ term: ols.term, aliases: ols.aliases, page: ols.page, tier: ols.tier, definition: ols.definition, definitionPage: ols.definitionPage },
			{ term: "ordinary least squares", aliases: ["OLS"], page: 2, tier: "core", definition: "Minimerer summen av kvadrerte residualer.", definitionPage: 3 },
		);
		assert.ok(!merged.some((t) => t.id === "t_ols"));
		assert.deepEqual(merged.map((t) => t.id).sort(), ["t_ordinary-least-squares", "t_v", "t_velocity", "t_voltage"], "v is ambiguous: nothing merges through it");
	});

	// Review 1, defect 10: a supporting mention of Entropy on page 1 followed by its formal core definition on page 7
	// produced a core entry holding only the introductory wording.
	it("review 1, defect 10: the earliest mention keeps its page; the formal definition keeps its wording and its own page", () => {
		for (const intro of ["Uorden, løst sagt.", null]) {
			const [entropy] = mergeTerms([[modelTerm("Entropy", 1, "supporting", intro)], [modelTerm("Entropy", 7, "core", "S = k ln W, der W er antall mikrotilstander.")]]);
			assert.deepEqual(
				{ page: entropy!.page, tier: entropy!.tier, definition: entropy!.definition, definitionPage: entropy!.definitionPage },
				{ page: 1, tier: "core", definition: "S = k ln W, der W er antall mikrotilstander.", definitionPage: 7 },
			);
		}
		const [undefinedTerm] = mergeTerms([[modelTerm("Entropy", 2, "core", null)], [modelTerm("entropy", 5, "supporting", null)]]);
		assert.deepEqual([undefinedTerm!.definition, undefinedTerm!.definitionPage, undefinedTerm!.page], [null, null, 2]);
	});
});

describe("mergeGlossary and findTerm", () => {
	const term = (name: string, page: number, tier: "core" | "supporting", aliases: string[] = [], definition: string | null = `${name} er …`) => ({
		id: termId(name),
		term: name,
		aliases,
		page,
		tier,
		definition,
		definitionPage: definition === null ? null : page,
	});
	const digest = (sourceHash: string, terms: MaterialDigest["terms"]): Pick<MaterialDigest, "sourceHash" | "terms"> => ({ sourceHash, terms });

	// Changed for the manager's merge ruling after review 2: doc-c's "Eigenvalue" (alias Egenverdi) no longer chains into
	// Egenverdi + λ (Egenverdi declares λ, which Eigenvalue does not know); the definition is chosen by pickDefinition
	// (doc-b's core definition over doc-a's supporting one).
	it("merges documents by id and by unambiguous alias, keeps per-document citations, core if any says core", () => {
		const a = digest("doc-a", [term("Egenverdi", 4, "supporting", ["λ"], "Et tall λ slik at Av = λv."), term("Matrise", 1, "core")]);
		const b = digest("doc-b", [term("λ", 12, "core", [], "Egenverdien."), term("matrise", 2, "supporting", [], null)]);
		const glossary = mergeGlossary([a, b]);

		assert.deepEqual(Object.keys(glossary.terms).sort(), ["t_egenverdi", "t_matrise"]);
		const eigen = glossary.terms["t_egenverdi"]!;
		assert.deepEqual(eigen.ids, ["t_egenverdi", "t_λ"]);
		assert.equal(eigen.term, "Egenverdi");
		assert.equal(eigen.definition, "Egenverdien.", "the core mention's definition (pickDefinition)");
		assert.equal(eigen.tier, "core", "doc-b says core");
		assert.deepEqual(eigen.aliases, ["λ"]);
		assert.deepEqual(eigen.citations, [
			{ sourceHash: "doc-a", page: 4, definition: "Et tall λ slik at Av = λv.", definitionPage: 4, tier: "supporting" },
			{ sourceHash: "doc-b", page: 12, definition: "Egenverdien.", definitionPage: 12, tier: "core" },
		]);
		const matrise = glossary.terms["t_matrise"]!;
		assert.equal(matrise.tier, "core");
		assert.deepEqual(matrise.citations.map((x) => [x.sourceHash, x.page, x.definition]), [["doc-a", 1, "Matrise er …"], ["doc-b", 2, null]]);
		assert.deepEqual(matrise.aliases, [], "a different case of the term is not an alias");

		// a chain merges nothing: Eigenvalue → Egenverdi → λ stays three entries
		const c = digest("doc-c", [term("Eigenvalue", 7, "supporting", ["Egenverdi"])]);
		assert.deepEqual(Object.keys(mergeGlossary([a, b, c]).terms).sort(), ["t_egenverdi", "t_eigenvalue", "t_matrise", "t_λ"]);
		// …unless every pair is linked directly: Eigenvalue knows both names, so Eigenvalue and Egenverdi merge; λ, which
		// both declare, is ambiguous and stays its own entry
		const c2 = digest("doc-c", [term("Eigenvalue", 7, "supporting", ["Egenverdi", "λ"])]);
		const merged = mergeGlossary([a, b, c2]);
		assert.deepEqual(Object.keys(merged.terms).sort(), ["t_egenverdi", "t_matrise", "t_λ"]);
		assert.deepEqual(merged.terms["t_egenverdi"]!.ids, ["t_egenverdi", "t_eigenvalue"]);
		assert.equal(findTerm(merged, "λ"), undefined, "λ is its own entry's name and an alias of another: ambiguous");
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

	// Review 1, defect 3: velocity → v, voltage → v, U and internal energy → U in three documents made one entry, and
	// looking up "velocity" returned internal energy.
	it("review 1, defect 3: an alias shared by different terms merges nothing and is an ambiguous lookup", () => {
		const glossary = mergeGlossary([
			digest("doc-1", [term("velocity", 1, "core", ["v"])]),
			digest("doc-2", [term("voltage", 1, "core", ["v", "U"])]),
			digest("doc-3", [term("internal energy", 1, "core", ["U"])]),
		]);
		assert.deepEqual(Object.keys(glossary.terms).sort(), ["t_internal-energy", "t_velocity", "t_voltage"]);
		assert.equal(findTerm(glossary, "velocity")?.id, "t_velocity");
		assert.equal(findTerm(glossary, "internal energy")?.id, "t_internal-energy");
		assert.equal(findTerm(glossary, "v"), undefined, "ambiguous: no arbitrary pick");
		assert.equal(findTerm(glossary, "U"), undefined);
		assert.deepEqual(findTermCandidates(glossary, "v").map((e) => e.id), ["t_velocity", "t_voltage"]);
		assert.deepEqual(findTermCandidates(glossary, "u").map((e) => e.id), ["t_internal-energy", "t_voltage"]);
		assert.deepEqual(glossary.aliases["v"], ["t_velocity", "t_voltage"]);
		// two terms that only share an alias are not merged either
		const shared = mergeGlossary([digest("doc-a", [term("Egenverdi", 1, "core", ["λ"])]), digest("doc-b", [term("Eigenvalue", 1, "core", ["λ"])])]);
		assert.equal(Object.keys(shared.terms).length, 2);
		// Changed for the lookup ruling after review 2: an entry's own name that other terms use as an alias is ambiguous
		// too (it used to return t_v); the candidates list all three
		const own = mergeGlossary([digest("doc-a", [term("v", 1, "core"), term("velocity", 1, "core", ["v"]), term("voltage", 1, "core", ["v"])])]);
		assert.equal(findTerm(own, "v"), undefined);
		assert.deepEqual(findTermCandidates(own, "v").map((e) => e.id), ["t_v", "t_velocity", "t_voltage"]);
		assert.equal(findTermById(own, "t_v")?.id, "t_v");
	});

	// Review 1, defect 9: A (Beta, alias Alpha) and B (Alpha) gave t_alpha; [A, B, A] gave t_beta and citations [a, b, a].
	it("review 1, defect 9: a repeated source counts once, for the canonical id and the citations", () => {
		const a = digest("a", [term("Beta", 1, "core", ["Alpha"])]);
		const b = digest("b", [term("Alpha", 2, "core")]);
		const once = mergeGlossary([a, b]);
		const repeated = mergeGlossary([a, b, a]);
		assert.deepEqual(Object.keys(once.terms), ["t_alpha"]);
		assert.deepEqual(Object.keys(repeated.terms), ["t_alpha"]);
		assert.deepEqual(repeated.terms["t_alpha"]!.citations.map((c) => c.sourceHash), ["a", "b"]);
		assert.deepEqual(repeated, once);
	});

	it("findTerm matches a term, an alias or an id, normalised; unknown text and prototype names match nothing", () => {
		const glossary = mergeGlossary([
			digest("doc-a", [term("Egenverdi", 4, "core", ["λ", "Eigen value"]), term("Den deriverte", 1, "core", ["f'(x)"])]),
		]);
		assert.equal(findTerm(glossary, "egenverdi")?.id, "t_egenverdi");
		assert.equal(findTerm(glossary, "  EGENVERDI ")?.id, "t_egenverdi");
		assert.equal(findTerm(glossary, "λ")?.id, "t_egenverdi");
		assert.equal(findTerm(glossary, "eigen-value")?.id, "t_egenverdi");
		// changed for the lookup ruling: an id is looked up by findTermById; plain text is never read as an id
		assert.equal(findTerm(glossary, "t_egenverdi"), undefined);
		assert.equal(findTermById(glossary, "t_egenverdi")?.id, "t_egenverdi");
		assert.equal(findTermById(glossary, "egenverdi"), undefined);
		assert.equal(findTermById(glossary, "t_constructor"), undefined);
		assert.equal(findTerm(glossary, "den deriverte")?.id, "t_den-deriverte");
		assert.equal(findTerm(glossary, "F'(X)")?.id, "t_den-deriverte");
		assert.equal(findTerm(glossary, "f′(x)")?.id, "t_den-deriverte");
		assert.equal(findTerm(glossary, "f(x)"), undefined, "f(x) is not f'(x)");
		assert.equal(findTerm(glossary, "integral"), undefined);
		assert.equal(findTerm(glossary, ""), undefined);
		assert.equal(findTerm(glossary, "constructor"), undefined);
		assert.equal(findTerm(glossary, "__proto__"), undefined);
		assert.deepEqual(findTermCandidates(glossary, "constructor"), []);
		// the glossary survives a JSON round trip (it is meant to be stored)
		const revived = JSON.parse(JSON.stringify(glossary)) as typeof glossary;
		assert.equal(findTerm(revived, "λ")?.id, "t_egenverdi");
		const proto = mergeGlossary([digest("doc-a", [term("constructor", 1, "core", ["__proto__"])])]);
		assert.equal(findTerm(JSON.parse(JSON.stringify(proto)) as typeof proto, "constructor")?.id, "t_constructor");
	});

	// Review 2, finding 1: unifyByAlias merged unrelated terms through a flipped alias direction or a hub.
	it("review 2, finding 1: a flipped alias, a hub or a chain merges nothing, in any input order", () => {
		const velocity = digest("doc-1", [term("velocity", 1, "core", ["v"], "rate of change of position")]);
		const v = digest("doc-2", [term("v", 1, "core", ["voltage"], "electric potential difference")]);
		const voltage = digest("doc-3", [term("voltage", 1, "core", [])]);
		const permutations = <T>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));

		// all three documents: was ONE entry t_v with ids [t_v, t_velocity, t_voltage]
		for (const order of permutations([velocity, v, voltage])) {
			const g = mergeGlossary(order);
			assert.deepEqual(Object.keys(g.terms).sort(), ["t_v", "t_velocity", "t_voltage"]);
			for (const entry of Object.values(g.terms)) assert.equal(entry.ids.length, 1);
			assert.deepEqual(g, mergeGlossary([velocity, v, voltage]), "the same glossary in any order");
		}
		// docs 1 and 2 only: velocity and v merged, and findTerm("velocity") returned voltage's definition
		for (const order of permutations([velocity, v])) {
			const g = mergeGlossary(order);
			assert.deepEqual(Object.keys(g.terms).sort(), ["t_v", "t_velocity"]);
			assert.equal(findTerm(g, "velocity")?.definition, "rate of change of position");
			assert.equal(findTerm(g, "voltage")?.id, "t_v", "voltage is only v's alias");
		}
		// a hub: v declares both velocity and voltage, which are terms of their own
		const hub = [digest("doc-1", [term("v", 1, "core", ["velocity", "voltage"])]), digest("doc-2", [term("velocity", 1, "core")]), digest("doc-3", [term("voltage", 1, "core")])];
		for (const order of permutations(hub)) assert.deepEqual(Object.keys(mergeGlossary(order).terms).sort(), ["t_v", "t_velocity", "t_voltage"]);
		// the same cases inside one document (mergeTerms across batches)
		const flipped = mergeTerms([[modelTerm("velocity", 1, "core", "rate of change of position", ["v"])], [modelTerm("v", 1, "core", "electric potential difference", ["voltage"])], [modelTerm("voltage", 1, "core", null)]]);
		assert.deepEqual(flipped.map((t) => t.id).sort(), ["t_v", "t_velocity", "t_voltage"]);
		const hubTerms = mergeTerms([[modelTerm("v", 1, "core", null, ["velocity", "voltage"])], [modelTerm("velocity", 1, "core")], [modelTerm("voltage", 1, "core")]]);
		assert.deepEqual(hubTerms.map((t) => t.id).sort(), ["t_v", "t_velocity", "t_voltage"]);
		// review 1's shared symbol still merges nothing, and a clear synonym still merges, in any order
		const shared = [digest("d1", [term("velocity", 1, "core", ["v"])]), digest("d2", [term("voltage", 1, "core", ["v", "U"])]), digest("d3", [term("internal energy", 1, "core", ["U"])])];
		for (const order of permutations(shared)) assert.equal(Object.keys(mergeGlossary(order).terms).length, 3);
		const ols = [digest("d1", [term("ordinary least squares", 3, "core", ["OLS"])]), digest("d2", [term("OLS", 2, "supporting", [], null)])];
		for (const order of permutations(ols)) assert.deepEqual(Object.values(mergeGlossary(order).terms).map((e) => e.ids), [["t_ols", "t_ordinary-least-squares"]]);
		// mutual aliases are a clear synonym too
		const mutual = mergeGlossary([digest("d1", [term("ordinary least squares", 3, "core", ["OLS"])]), digest("d2", [term("OLS", 2, "core", ["ordinary least squares"])])]);
		assert.equal(Object.keys(mutual.terms).length, 1);
		// but not when the aliased entry declares a name the other does not know
		const extra = mergeGlossary([digest("d1", [term("ordinary least squares", 3, "core", ["OLS"])]), digest("d2", [term("OLS", 2, "core", ["optimal load sharing"])])]);
		assert.equal(Object.keys(extra.terms).length, 2);
	});

	// Review 2, finding 3: findTerm picked one entry when a term's own name was also an alias of others, and the t_
	// prefix shadowed literal terms.
	it("review 2, finding 3: plain-text lookup refuses an ambiguous name, and ids have their own lookup", () => {
		const g = mergeGlossary([
			digest("doc-1", [term("velocity", 1, "core", ["v"]), term("voltage", 2, "core", ["v"])]),
			digest("doc-2", [term("v", 3, "supporting", [], null)]),
		]);
		assert.equal(findTerm(g, "v"), undefined, "was the supporting t_v");
		assert.deepEqual(findTermCandidates(g, "v").map((e) => e.id), ["t_v", "t_velocity", "t_voltage"]);
		const tc = mergeGlossary([digest("doc-1", [term("c", 1, "core", [], "speed of light"), term("t_c", 2, "core", [], "critical temperature")])]);
		assert.equal(findTerm(tc, "t_c")?.definition, "critical temperature", "was c");
		assert.equal(findTerm(tc, "c")?.definition, "speed of light");
		assert.equal(findTermById(tc, "t_c")?.definition, "speed of light");
		assert.equal(findTermById(tc, termId("t_c"))?.definition, "critical temperature");
		assert.deepEqual(findTermCandidates(tc, "t_c").map((e) => e.id), [termId("t_c")]);
	});

	// Review 2, finding 5: the top-level definition and the display form depended on input order.
	it("review 2, finding 5: the definition is chosen by pickDefinition and the display form deterministically, in any order", () => {
		const d1 = digest("d1", [term("Entropy", 1, "supporting", [], "Informal intro gloss.")]);
		const d2 = digest("d2", [term("entropy", 1, "core", [], "S = k ln W.")]);
		const forward = mergeGlossary([d1, d2]);
		const backward = mergeGlossary([d2, d1]);
		assert.deepEqual(forward, backward);
		assert.equal(forward.terms["t_entropy"]!.definition, "S = k ln W.");
		assert.equal(forward.terms["t_entropy"]!.term, "Entropy", "the smallest sourceHash's spelling");
		// a tie in tier and page goes to the smaller sourceHash
		const b = digest("b", [term("Rang", 2, "core", [], "Definisjon fra b.")]);
		const a = digest("a", [term("rang", 2, "core", [], "Definisjon fra a.")]);
		for (const order of [[a, b], [b, a]]) {
			const entry = mergeGlossary(order).terms["t_rang"]!;
			assert.equal(entry.definition, "Definisjon fra a.");
			assert.equal(entry.term, "rang");
			assert.deepEqual(entry.citations.map((c) => c.sourceHash), ["a", "b"]);
		}
	});

	it("a digest term without a name is refused, not dropped", () => {
		assert.throws(() => mergeGlossary([digest("d", [term(String.fromCharCode(0x200b), 1, "core")])]), /without a name/);
	});
});

describe("review 2: ids", () => {
	// Review 2, finding 2: hyphens, "_" and NFKC folding made distinct notation share an id; "_" and "---" vanished.
	it("review 2, finding 2: maths and CS notation keep distinct ids", () => {
		const families: string[][] = [
			["C", "C--", "C++"],
			["-1", "1"],
			["f^-1(x)", "f^1(x)"],
			["O(n-1)", "O(n 1)"],
			["x-y", "x_y"],
			["a−b", "a-b"],
			["x²", "x₂", "x2"],
			["ℝ²", "R2"],
			["ℝ", "R"],
			["ℂ", "C"],
			["10²", "102"],
		];
		for (const family of families) {
			const ids = family.map(termId);
			assert.equal(new Set(ids).size, family.length, `${family.join(" / ")} → ${ids.join(" / ")}`);
			assert.equal(new Set(family.map(conceptId)).size, family.length);
		}
		// still one key: a dash between two letters, case, spacing, ligatures, full-width forms, primes
		assert.equal(termId("Navier–Stokes"), termId("navier stokes"));
		assert.equal(termId("ＡＢＣ＋"), termId("abc+"));
		assert.equal(termId("f″(x)"), termId("f''(x)"));
		// not folded, as ruled: Turkish dotted I and ß keep JS lower-casing
		assert.notEqual(termId("İstanbul"), termId("Istanbul"));
		assert.notEqual(termId("Maß"), termId("MASS"));
	});

	it("review 2, finding 2: a name of symbols only has an id and is kept; a name with no visible character is a retry", async () => {
		assert.equal(termId("_"), "t__5f");
		assert.equal(conceptId("---"), "c__2d-_2d-_2d");
		const kept = mergeTerms([[modelTerm("_", 1, "core", "Plassholder.")]]);
		assert.deepEqual(kept.map((t) => t.id), ["t__5f"]);
		assert.deepEqual(mergeConcepts([[{ name: "---", statement: "En skillelinje.", page: 1 }]]).map((c) => c.id), ["c__2d-_2d-_2d"]);

		const zw = String.fromCharCode(0x200b);
		const soft = String.fromCharCode(0xad);
		const bad = { summaryBullets: ["Tegn"], terms: [modelTerm(zw, 1, "core"), modelTerm("_", 1, "core")], concepts: [{ name: `${soft} `, statement: "Noe.", page: 1 }, { name: "---", statement: "Linje.", page: 1 }], figures: [] };
		const good = { ...bad, terms: [modelTerm("_", 1, "core")], concepts: [{ name: "---", statement: "Linje.", page: 1 }] };
		const model = fakeModel((_call, n) => JSON.stringify({ ...(n === 0 ? bad : good), profile: PROFILE }));
		const digest = await digestMaterial("--- Page 1 ---\n\nTegn.\n", { ...META, complete: model.complete });
		assert.equal(model.calls.length, 2, "the invisible names go into the retry");
		assert.match(model.calls[1]!.user, /\/terms\/0\/term: has only invisible characters/);
		assert.match(model.calls[1]!.user, /\/concepts\/0\/name: has only invisible characters/);
		assert.deepEqual(digest.terms.map((t) => t.id), ["t__5f"]);
		assert.deepEqual(digest.concepts.map((c) => c.id), ["c__2d-_2d-_2d"]);
		assert.throws(() => mergeTerms([[modelTerm(zw, 1, "core")]]), /without a name/);
		assert.throws(() => mergeConcepts([[{ name: zw, statement: "x", page: 1 }]]), /without a name/);
	});

	// Review 2, finding 8: soft hyphens and zero-width characters from PDF extraction split one term into several ids.
	it("review 2, finding 8: soft hyphens and zero-width characters do not change an id", () => {
		const plain = termId("eigenvalue");
		for (const code of [0xad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]) assert.equal(termId(`eigen${String.fromCharCode(code)}value`), plain, `U+${code.toString(16)}`);
		const [merged, ...rest] = mergeTerms([[modelTerm("eigenvalue", 1, "core")], [modelTerm(`eigen${String.fromCharCode(0xad)}value`, 2, "supporting")]]);
		assert.equal(rest.length, 0);
		assert.equal(merged!.id, plain);
	});

	// Review 2, contract: the comment said long keys keep their start and end; the code keeps the start plus a hash.
	it("review 2, contract: a long key is its first SLUG_PREFIX_CHARS code points, then ~ and an 11-character hash", () => {
		const name = `${"ø".repeat(150)}a`;
		const key = slugOf(name);
		assert.equal([...key].length, SLUG_MAX_CHARS);
		assert.equal(key.slice(0, SLUG_PREFIX_CHARS), "ø".repeat(SLUG_PREFIX_CHARS));
		assert.match(key, new RegExp(`^ø{${SLUG_PREFIX_CHARS}}~[0-9a-z]{11}$`));
		assert.notEqual(key, slugOf(`${"ø".repeat(150)}b`));
		assert.equal(slugOf("~"), "_7e", "a ~ in a name never looks like the hash separator");
	});

	it("property: distinct names from the collision families of both reviews get distinct ids; presentation never matters; normalising is idempotent", () => {
		// each atom is one name; atoms that start and end with a word character may also be joined by a space
		const atoms = [
			"c", "c++", "c--", "-1", "1", "f^-1(x)", "f^1(x)", "o(n-1)", "o(n", "1)", "x_y", "x", "y", "a−b", "a", "b", "x²", "x₂", "x2", "ℝ²", "r2",
			"ℝ", "r", "ℂ", "10²", "102", "_", "---", "f(x)", "f'(x)", "f''(x)", "∇", "u2207", "a+b", "eigenvalue", "eigen", "value", "v", "velocity",
			"voltage", "t_c", "ℝⁿ", "x⁻¹", "𝔸", "første", "forste", "λ", "~", "_7e", `${"x".repeat(120)}a`, `${"x".repeat(120)}b`, "navier", "stokes",
		];
		const wordBounded = atoms.filter((a) => /^[\p{L}\p{N}]/u.test(a) && /[\p{L}\p{N}]$/u.test(a) && !/[^\p{L}\p{N}]/u.test(a));
		const invisible = [0xad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff].map((c) => String.fromCharCode(c));
		const primes = ["'", "′", "’", "ʼ"];
		const rand = mulberry32(23);
		const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
		/** One presentation of a canonical name: case, invisible characters, spacing, full-width forms, primes, NFD. */
		const present = (canonical: string): string => {
			let out = "";
			for (const ch of canonical.replace(/''/g, () => (rand() < 0.3 ? "″" : "''"))) {
				let c = ch;
				if (c === "'") c = pick(primes);
				else if (/[a-z]/.test(c) && rand() < 0.3) c = c.toUpperCase();
				if (/[!-~]/.test(c) && c !== " " && rand() < 0.1) c = String.fromCharCode(c.charCodeAt(0) + 0xfee0);
				if (c === " ") c = pick([" ", "  ", "\t", " \n "]);
				out += c;
				if (rand() < 0.1) out += pick(invisible);
			}
			const padded = `${rand() < 0.2 ? " " : ""}${out}${rand() < 0.2 ? "  " : ""}`;
			return rand() < 0.2 ? padded.normalize("NFD") : padded;
		};
		const idOf = new Map<string, string>();
		const canonicalOf = new Map<string, string>();
		for (let i = 0; i < 4_000; i++) {
			const canonical = rand() < 0.7 ? pick(atoms) : `${pick(wordBounded)} ${pick(wordBounded)}`;
			const name = present(canonical);
			const id = termId(name);
			assert.equal(idOf.get(canonical) ?? id, id, `${JSON.stringify(name)} is ${canonical}, so ${idOf.get(canonical)}, got ${id}`);
			idOf.set(canonical, id);
			assert.equal(canonicalOf.get(id) ?? canonical, canonical, `${JSON.stringify(canonical)} and ${JSON.stringify(canonicalOf.get(id))} share ${id}`);
			canonicalOf.set(id, canonical);
			assert.equal(normalizeName(normalizeName(name)), normalizeName(name), `normalising ${JSON.stringify(name)} twice`);
			assert.equal(slugOf(normalizeName(name)), slugOf(name));
			assert.notEqual(slugOf(name), "");
		}
		assert.ok(idOf.size > 300, `${idOf.size} distinct names checked`);
	});
});

describe("review 2: concerns and the version 3 contract", () => {
	// Review 2, concern 1: a profile wrapped in a code fence was accepted with its trailing fence.
	it("review 2, concern 1: a profile wrapped in a code fence is unwrapped before validation", async () => {
		for (const wrapped of [`\`\`\`markdown\n${PROFILE}\n\`\`\``, `Here is the profile:\n\n\`\`\`md\n${PROFILE}\n\`\`\`\n`, `~~~~\n${PROFILE}\n~~~~`]) {
			const checked = validateProfile(wrapped);
			assert.ok(checked.ok, wrapped);
			assert.equal((checked as { value: string }).value, PROFILE);
		}
		// a code block inside a section is part of the profile
		const withCode = `${PROFILE}\n\n## Exercises\nOppgaver som denne:\n\`\`\`\nf(x) = x^2\n\`\`\``;
		assert.equal((validateProfile(withCode) as { value: string }).value, withCode);
		const twoBlocks = `## Contents\nA\n\`\`\`\nx\n\`\`\`\n## Exercises\n\`\`\`\ny\n\`\`\``;
		assert.equal((validateProfile(twoBlocks) as { value: string }).value, twoBlocks);
		// end to end, on the reduce path and inside the JSON of a single batch
		const reduceModel = fakeModel((call) => (isReduce(call) ? `\`\`\`markdown\n${PROFILE}\n\`\`\`` : notesFor(call.user)));
		assert.equal((await digestMaterial(slideDeck(40, 1_500), { ...META, complete: reduceModel.complete })).profile, PROFILE);
		const singleModel = fakeModel((call) => notesFor(call.user, { profile: `\`\`\`markdown\n${PROFILE}\n\`\`\`` }));
		assert.equal((await digestMaterial(slideDeck(3, 200), { ...META, complete: singleModel.complete })).profile, PROFILE);
	});

	// Review 2, concern 2: a pre-aborted digestMaterial called onActivity once before throwing.
	it("review 2, concern 2: no onActivity line once an abort is requested", async () => {
		const pre = new AbortController();
		pre.abort();
		const lines: string[] = [];
		const unused = fakeModel(() => "no");
		await assert.rejects(digestMaterial(slideDeck(40, 1_500), { ...META, complete: unused.complete, signal: pre.signal, onActivity: (l) => lines.push(l) }), { name: "AbortError" });
		assert.deepEqual(lines, []);
		assert.equal(unused.calls.length, 0);

		const during = new AbortController();
		const seen: string[] = [];
		const aborting = fakeModel((call) => {
			during.abort();
			return notesFor(call.user);
		});
		await assert.rejects(digestMaterial(slideDeck(40, 1_500), { ...META, complete: aborting.complete, signal: during.signal, onActivity: (l) => seen.push(l) }), { name: "AbortError" });
		assert.equal(seen.length, 1, "only the line before the first call");
		assert.equal(aborting.calls.length, 1);
	});

	// Review 2, contract: digest.json did not persist per-batch summaries, pages or heading paths, so the profile could not
	// be rewritten nor a failed batch re-run without re-extracting.
	it("review 2, contract: the reduce request is rebuilt exactly from a stored digest, and rewriteProfile re-runs only the profile", async () => {
		const doc = `# Kapittel 1\n\n${slideDeck(40, 1_500)}`;
		const plan = splitMaterial(doc, SMALL);
		const failing = plan[2]!;
		const model = fakeModel((call) => (isReduce(call) ? "no profile" : materialOf(call.user) === failing.text ? "nope" : notesFor(call.user)));
		const digest = await digestMaterial(doc, { ...META, complete: model.complete, split: SMALL, name: "Forelesning 3" });
		assert.equal(digest.profile, null, "the profile failed twice");
		assert.equal(digest.failedBatches.length, 1);
		const stored = JSON.parse(JSON.stringify(digest)) as MaterialDigest;
		// every batch persists its pages and heading path; an indexed one its bullets
		for (const [i, b] of stored.batches.entries()) {
			assert.deepEqual(b.pages, plan[i]!.pages);
			assert.deepEqual(b.headingPath, plan[i]!.headingPath);
			if (b.status === "indexed") assert.deepEqual(b.summaryBullets, [`Del fra side ${b.pageStart}`]);
			else assert.equal(b.index, failing.index);
		}
		// the rebuilt request is the one the model saw, with no model call
		const reduceCalls = model.calls.filter(isReduce);
		assert.deepEqual(buildReduceRequest(stored, "Forelesning 3"), { system: reduceCalls[0]!.system, user: reduceCalls[0]!.user });

		// re-run only the profile: one call, everything else kept
		const again = fakeModel((call) => (isReduce(call) ? PROFILE : "an extraction call"));
		const rewritten = await rewriteProfile(stored, { complete: again.complete, name: "Forelesning 3" });
		assert.equal(again.calls.length, 1);
		assert.equal(again.calls[0]!.user, reduceCalls[0]!.user);
		assert.equal(rewritten.profile, PROFILE);
		assert.equal(rewritten.profileError, undefined);
		assert.ok(!("profileError" in rewritten));
		const { profile: _a, profileError: _b, ...kept } = stored;
		const { profile: _c, ...keptAfter } = rewritten;
		assert.deepEqual(keptAfter, kept);
		// a failing rewrite keeps the notes too; a digest with nothing indexed makes no call; another version is refused
		const bad = await rewriteProfile(stored, { complete: fakeModel(() => "still no").complete });
		assert.equal(bad.profile, null);
		assert.match(bad.profileError!, /the profile could not be written/);
		const nothing = await digestMaterial(slideDeck(40, 1_500), { ...META, complete: fakeModel(() => "no").complete });
		const idle = fakeModel(() => PROFILE);
		assert.equal(buildReduceRequest(nothing), null);
		assert.match((await rewriteProfile(nothing, { complete: idle.complete })).profileError!, /no part of the material could be indexed/);
		assert.equal(idle.calls.length, 0);
		await assert.rejects(rewriteProfile({ ...stored, version: 2 } as unknown as MaterialDigest, { complete: idle.complete }), /version 2/);
		const aborted = new AbortController();
		aborted.abort();
		await assert.rejects(rewriteProfile(stored, { complete: idle.complete, signal: aborted.signal }), { name: "AbortError" });

		// a failed batch is rebuilt from content.md and its stored ref exactly as it was split, ready to re-run alone
		const failedRef = stored.failedBatches[0]!;
		assert.deepEqual(batchFromRef(doc, failedRef), failing);
		for (const [i, b] of stored.batches.entries()) assert.deepEqual(batchFromRef(doc, b), plan[i]);
		assert.equal(validateBatchReply(notesFor(`, pages ${failing.pageStart}-${failing.pageEnd}.`), batchFromRef(doc, failedRef)).ok, true);
		assert.throws(() => batchFromRef(doc.slice(0, 10), failedRef), RangeError);
	});
});

/** A seeded PRNG (mulberry32): the property tests' inputs are the same on every run. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
