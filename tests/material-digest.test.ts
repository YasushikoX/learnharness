/**
 * Indexing a converted document into its digest (fork addition, 2026-11-24; agent/subagents/material-digest.ts) and
 * merging digests into a class glossary (core/glossary.ts), under the identity ruling of 2026-11-25 (PLAN.md "Term
 * identity"): identity is the exact spelling, nothing merges by alias or symbol, occurrences are kept, duplicates are
 * only suggested, lookup never guesses. The model is a scripted fake injected through the deps, never a real one.
 * Tests named "review N, finding/defect M" reproduce the cases of the three WP3b reviews
 * (council/reviews/wp3b-review-{1,2,3}.md) under the new rules.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	batchFromRef,
	batchNotesText,
	buildReduceRequest,
	combineTerms,
	digestMaterial,
	EXTRACTION_OVERHEAD_MAX_CHARS,
	failedBatchesOf,
	formatHeadingPath,
	hasProfile,
	HEADING_PATH_MAX_CHARS,
	MATERIAL_INDEXER_VERSION,
	mergeConcepts,
	mergeRecoveredBatch,
	mergeTerms,
	NAME_MAX_CHARS,
	parseStoredDigest,
	partTerms,
	REDUCE_REQUEST_MAX_CHARS,
	rewriteProfile,
	summarizeOccurrences,
	truncateOccurrences,
	validateBatchReply,
	validateProfile,
	type BatchNotes,
	type BatchTerm,
	type DigestModelCall,
	type DigestProgress,
	type ReduceFailedPart,
	type ReducePart,
	type ReduceTerm,
} from "../src/agent/subagents/material-digest.ts";
import {
	conceptId,
	encodeName,
	findTerm,
	findTermById,
	findTermCandidates,
	hasVisibleContent,
	ID_MAX_CHARS,
	mergeGlossary,
	normalizeName,
	pluralSingulars,
	relaxedKey,
	termId,
	type GlossarySource,
} from "../src/core/glossary.ts";
import { splitMaterial, type MaterialBatch } from "../src/core/material-split.ts";
import { PROFILE_FORMAT_RULES, PROFILE_FORMAT_SECTIONS } from "../src/agent/subagents/material-profiler.ts";
import { MATERIAL_DIGEST_VERSION, MAX_TERM_OCCURRENCES, type DigestTerm, type MaterialDigest, type TermTier } from "../src/core/contracts/material-digest.ts";

const META = { sourceHash: "sha256:abc", converter: "pdfjs-markdown", converterVersion: "5.4.0" };

/** A budget that splits the 40-page test deck into several parts (the default gives two). */
const SMALL = { budgetTokens: 2_000 };

const PROFILE = "## Scope and targets\nDeriver funksjoner (p. 1).\n\n## Contents\nDerivasjon (p. 1-3).";

interface Call {
	system: string;
	user: string;
	kind: "extraction" | "profile";
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

/** The pages a part request states: the page it begins on and its listed pages ("This part's pages: 1-4, 7."). */
function requestPages(user: string): number[] {
	const list = /This part's pages: ([^\n]*)\./.exec(user)![1]!;
	return list.split(", ").flatMap((r) => {
		const [a, b] = r.split("-").map(Number);
		return Array.from({ length: (b ?? a!) - a! + 1 }, (_, i) => a! + i);
	});
}

/** The page a part request begins on and its last listed page. */
function requestRange(user: string): { from: number; to: number } {
	const from = Number(/The text begins on page (\d+)\./.exec(user)![1]);
	return { from, to: requestPages(user).at(-1)! };
}

/** The text inside a request's <material> block. */
const materialOf = (user: string) => /<material>\n([\s\S]*)\n<\/material>/.exec(user)![1]!;

const isReduce = (call: Call) => call.kind === "profile";

/** A term as the model writes it, defined on its page unless `definition` is null. */
function modelTerm(term: string, page: number, tier: TermTier = "supporting", definition: string | null = `Definisjon av ${term}.`, aliases: string[] = [], symbols: string[] = []): BatchTerm {
	return { term, aliases, symbols, page, tier, definition, definitionPage: definition === null ? null : page };
}

/** Notes for a part request: one term per part plus whatever `extra` adds. */
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

/** A split part with only the fields a helper reads. */
function batchOf(pages: number[], index = 0, pageOrder = pages): MaterialBatch {
	return { index, pageStart: pageOrder[0]!, pageEnd: pageOrder.at(-1)!, pages, pageOrder, continuesLine: false, headingPath: [], text: "", charStart: 0, charEnd: 1 };
}

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/** An indexed part as the reduce notes read it (0-based index). */
function part(index: number, pageStart: number, pageEnd: number, summaryBullets: string[], headingPath: string[] = []): ReducePart {
	return { index, pages: range(pageStart, pageEnd), headingPath, summaryBullets };
}

/** A failed part as the reduce notes read it (0-based index). */
function failedPart(index: number, pageStart: number, pageEnd = pageStart): ReduceFailedPart {
	return { index, pages: range(pageStart, pageEnd) };
}

/** A term as the reduce notes read it. */
function reduceTerm(term: string, tier: TermTier, definition: string | null = null, aliases: string[] = []): ReduceTerm {
	return { term, aliases, symbols: [], page: 1, tier, definition, definitionPage: definition === null ? null : 1 };
}

/** Every "Part N" / "Parts A-B" the notes name, as 1-based part numbers. */
function namedParts(text: string): Set<number> {
	const covered = new Set<number>();
	for (const m of text.matchAll(/Parts? (\d+)(?:-(\d+))?/g)) for (let p = Number(m[1]); p <= Number(m[2] ?? m[1]); p++) covered.add(p);
	return covered;
}

/** A digest term from one document as a glossary test writes it (one occurrence, part 0). */
function docTerm(name: string, page: number, tier: TermTier, opts: { aliases?: string[]; symbols?: string[]; definition?: string | null } = {}): DigestTerm {
	const definition = opts.definition === undefined ? `${name} er …` : opts.definition;
	return partTerms(0, [modelTerm(name, page, tier, definition, opts.aliases ?? [], opts.symbols ?? [])])[0]!;
}

/** A glossary source: one indexed part covering every page the terms use, unless `failed` adds failed parts. */
function source(sourceHash: string, terms: DigestTerm[], opts: { failed?: number; indexerVersion?: number } = {}): GlossarySource {
	const pages = [...new Set(terms.flatMap((t) => t.occurrences.map((o) => o.page)).concat(1))].sort((a, b) => a - b);
	const batches: MaterialDigest["batches"] = [{ index: 0, pageStart: pages[0]!, pageEnd: pages.at(-1)!, pages, headingPath: [], charStart: 0, charEnd: 10, status: "indexed", summaryBullets: [] }];
	for (let i = 0; i < (opts.failed ?? 0); i++) batches.push({ index: i + 1, pageStart: 1, pageEnd: 1, pages: [1], headingPath: [], charStart: 10 + i, charEnd: 11 + i, status: "failed", error: "x" });
	return { sourceHash, indexerVersion: opts.indexerVersion ?? MATERIAL_INDEXER_VERSION, batches, terms };
}

const ids = (g: { terms: Record<string, unknown> }) => Object.keys(g.terms);

describe("digestMaterial", () => {
	it("a single-part document (a slide deck) costs exactly one call, which also writes the profile", async () => {
		const doc = slideDeck(3, 200);
		const model = fakeModel((call) => notesFor(call.user, { profile: `Some preamble.\n\n${PROFILE}` }));
		const digest = await digestMaterial(doc, { ...META, complete: model.complete, name: "Forelesning 1" });
		assert.equal(model.calls.length, 1);
		assert.equal(model.calls[0]!.kind, "extraction");
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
		assert.deepEqual(failedBatchesOf(digest), []);
		assert.ok(!("failedBatches" in digest), "derived on read, not stored");
		assert.equal(digest.version, 4);
		assert.equal(digest.version, MATERIAL_DIGEST_VERSION);
		assert.equal(digest.indexerVersion, MATERIAL_INDEXER_VERSION);
		assert.equal(MATERIAL_INDEXER_VERSION, 4);
		assert.equal(digest.name, "Forelesning 1");
		assert.equal(digest.sourceHash, META.sourceHash);
		assert.equal(digest.pageCount, 3);
		assert.equal(digest.sourcePageCount, null);
		const occurrence = { part: 0, page: 1, tier: "supporting", definition: "Definisjon av begrep 1.", definitionPage: 1 };
		assert.deepEqual(digest.terms, [
			{ id: "t_Begrep_1", term: "Begrep 1", aliases: [], symbols: [], page: 1, tier: "supporting", definition: "Definisjon av begrep 1.", definitionPage: 1, definitionTier: "supporting", occurrences: [occurrence], occurrenceCount: 1 },
		]);
		assert.deepEqual(digest.concepts, [{ id: "c_Ide_1", name: "Ide 1", statement: "Ide 1 gjelder.", page: 1, part: 0 }]);
		assert.deepEqual(digest.figures, [{ page: 1, caption: "Figur på side 1", part: 0 }]);
		assert.ok(parseStoredDigest(JSON.stringify(digest)).ok, "what it writes passes the read boundary");
	});

	it("a multi-part document makes one call per part plus one reduce call for the profile, with structured progress", async () => {
		const doc = slideDeck(40, 1_500);
		const batches = splitMaterial(doc);
		assert.ok(batches.length >= 2);
		const progress: DigestProgress[] = [];
		const model = fakeModel((call) => (isReduce(call) ? `Here is the profile.\n\n${PROFILE}` : notesFor(call.user)));
		const digest = await digestMaterial(doc, { ...META, complete: model.complete, onProgress: (p) => progress.push(p) });
		assert.equal(model.calls.length, batches.length + 1);
		const reduce = model.calls.at(-1)!;
		assert.ok(isReduce(reduce));
		assert.match(reduce.system, /## Definitions and terminology/);
		for (const b of batches) assert.match(reduce.user, new RegExp(`### Part ${b.index + 1}: pages ${b.pageStart}-${b.pageEnd}`));
		assert.match(reduce.user, /- Begrep 1 \[supporting, p\. 1; defined p\. 1\]: Definisjon av begrep 1\./);
		assert.match(reduce.user, /every part indexed/);
		assert.ok(model.calls.slice(0, -1).every((c) => !/"profile" field/.test(c.user)), "part calls do not ask for the profile");
		assert.equal(digest.profile, PROFILE);
		assert.deepEqual(progress, [...batches.map((b) => ({ stage: "part", part: b.index + 1, parts: batches.length, pages: b.pages })), { stage: "profile" }]);
		assert.equal(digest.terms.length, batches.length);
		assert.equal(digest.pageCount, 40);
	});

	it("an invalid reply is retried once with the validation error; a part that fails twice is recorded and the others succeed", async () => {
		const doc = slideDeck(40, 1_500);
		const batches = splitMaterial(doc, SMALL);
		assert.ok(batches.length >= 3, `three parts needed, got ${batches.length}`);
		const second = batches[1]!;
		const third = batches[2]!;
		let thirdTries = 0;
		const model = fakeModel((call) => {
			if (isReduce(call)) return PROFILE;
			const { from } = requestRange(call.user);
			if (from === second.pageStart) return "Sorry, here are some notes: not JSON at all.";
			if (from === third.pageStart && thirdTries++ === 0)
				return notesFor(call.user, { terms: [{ term: "Feil", aliases: [], symbols: [], definition: "", definitionPage: 999, page: 999, tier: "key" }] });
			return notesFor(call.user);
		});
		const digest = await digestMaterial(doc, { ...META, complete: model.complete, split: SMALL });
		const secondCalls = model.calls.filter((c) => !isReduce(c) && requestRange(c.user).from === second.pageStart);
		assert.equal(secondCalls.length, 2);
		assert.match(secondCalls[1]!.user, /Your previous reply was rejected: the reply is not one JSON object/);
		assert.match(secondCalls[1]!.user, /<previous_reply>\nSorry, here are some notes: not JSON at all\.\n<\/previous_reply>/);
		assert.match(secondCalls[1]!.user, /Reply again with the corrected JSON object only\.$/);
		const thirdCalls = model.calls.filter((c) => !isReduce(c) && requestRange(c.user).from === third.pageStart);
		assert.equal(thirdCalls.length, 2);
		assert.match(thirdCalls[1]!.user, /\/terms\/0\/definition: /);
		assert.match(thirdCalls[1]!.user, /\/terms\/0\/tier: /);
		assert.equal(model.calls.length, batches.length + 2 + 1, "two retries plus the reduce");
		const failed = failedBatchesOf(digest);
		assert.deepEqual(
			failed.map(({ error: _e, ...ref }) => ref),
			[{ index: 1, pageStart: second.pageStart, pageEnd: second.pageEnd, pages: second.pages, headingPath: [], charStart: second.charStart, charEnd: second.charEnd, status: "failed" }],
		);
		assert.match(failed[0]!.error, /not one JSON object/);
		assert.equal(digest.batches.length, batches.length, "the failed part stays in the plan");
		assert.equal(digest.terms.length, batches.length - 1);
		assert.ok(digest.terms.some((t) => t.id === termId(`Begrep ${third.pageStart}`)), "the retried part is indexed");
		const reduce = model.calls.at(-1)!;
		assert.match(reduce.user, new RegExp(`Not indexed, so the notes are missing for this part: part 2, pages ${second.pageStart}-${second.pageEnd}\\.\\)`));
		assert.match(reduce.user, /of which 1 could not be indexed: the notes are missing for them, so they do not cover the whole document/);
	});

	it("a model call that throws records the part (not retried); an abort throws; all parts failing returns an empty digest", async () => {
		const doc = slideDeck(40, 1_500);
		const batches = splitMaterial(doc);
		const flaky = fakeModel((call, n) => {
			if (n === 0) throw new Error("rate limited");
			return isReduce(call) ? PROFILE : notesFor(call.user);
		});
		const digest = await digestMaterial(doc, { ...META, complete: flaky.complete });
		assert.equal(failedBatchesOf(digest).length, 1);
		assert.match(failedBatchesOf(digest)[0]!.error, /the model call failed: rate limited/);
		assert.equal(flaky.calls.length, batches.length + 1);

		const controller = new AbortController();
		const aborting = fakeModel(() => {
			controller.abort();
			throw Object.assign(new Error("aborted"), { name: "AbortError" });
		});
		await assert.rejects(digestMaterial(doc, { ...META, complete: aborting.complete, signal: controller.signal }), /aborted/);
		assert.equal(aborting.calls.length, 1);

		const broken = fakeModel(() => "no");
		const nothing = await digestMaterial(doc, { ...META, complete: broken.complete });
		assert.equal(broken.calls.length, batches.length * 2, "each part asked twice, no reduce");
		assert.deepEqual(failedBatchesOf(nothing).map((f) => f.index), batches.map((b) => b.index));
		assert.deepEqual([nothing.terms, nothing.concepts, nothing.figures], [[], [], []]);
		assert.equal(nothing.profile, null);
		assert.match(nothing.profileError!, /no part of the material could be indexed/);
		const single = await digestMaterial(slideDeck(2, 100), { ...META, complete: fakeModel(() => "no").complete });
		assert.equal(single.profile, null);
		assert.equal(failedBatchesOf(single).length, 1);
		await assert.rejects(digestMaterial("  \n", { ...META, complete: broken.complete }), /empty/);
		await assert.rejects(digestMaterial(`\u200E\u200B\n`, { ...META, complete: broken.complete }), /empty/, "only invisible characters is empty");
	});

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
		assert.equal(digest.terms.length, batches.length, "every part's terms are kept");
	});

	// Rewritten for the identity ruling: the same spelling across parts is one term with an occurrence per listing;
	// "Den deriverte", "den  DERIVERTE" and "Den-deriverte" used to be one term and are now three.
	it("the same spelling across parts is one term with its occurrences; different spellings stay different terms", async () => {
		const doc = slideDeck(40, 1_500);
		const batches = splitMaterial(doc, SMALL);
		assert.ok(batches.length >= 3);
		const model = fakeModel((call) => {
			if (isReduce(call)) return PROFILE;
			const { from } = requestRange(call.user);
			const idx = batches.findIndex((b) => b.pageStart === from);
			const variants = [
				modelTerm("Den deriverte", from, "supporting", "Grensen av differensekvotienten.", ["f'(x)"]),
				modelTerm("Den\u00AD  deriverte ", from, "core", "Senere definisjon.", ["derivert"], ["f′(x)"]),
				modelTerm("Den deriverte", from, "supporting", "Enda senere.", ["Derivert"], ["dy/dx"]),
			];
			return JSON.stringify({
				summaryBullets: [],
				terms: [variants[idx % variants.length], ...(idx === 0 ? [modelTerm("den deriverte", from, "supporting", null), modelTerm("Den-deriverte", from, "supporting", null)] : [])],
				concepts: [{ name: "Kjerneregelen", statement: `Kjerneregelen, side ${from}.`, page: from }],
				figures: [],
			});
		});
		const digest = await digestMaterial(doc, { ...META, complete: model.complete, split: SMALL });
		assert.deepEqual(digest.terms.map((t) => t.term), ["Den deriverte", "den deriverte", "Den-deriverte"]);
		const term = digest.terms[0]!;
		assert.equal(term.id, "t_Den_deriverte");
		assert.equal(term.occurrenceCount, batches.length, "one occurrence per part (soft hyphen and spacing are not identity)");
		assert.deepEqual(term.occurrences.map((o) => o.part), batches.map((b) => b.index));
		assert.equal(term.definition, "Senere definisjon.", "the first core occurrence's definition");
		assert.equal(term.definitionTier, "core");
		assert.equal(term.definitionPage, batches[1]!.pageStart);
		assert.equal(term.page, 1);
		assert.equal(term.tier, "core");
		assert.deepEqual(term.aliases, ["Derivert", "derivert", "f'(x)"], "aliases are lookup data, sorted, exact");
		assert.deepEqual(term.symbols, ["dy/dx", "f′(x)"]);
		assert.deepEqual(digest.concepts, [{ id: "c_Kjerneregelen", name: "Kjerneregelen", statement: "Kjerneregelen, side 1.", page: 1, part: 0 }]);
	});

	// Review 1, defect 2: 200 pages with 30 terms per page gave the reducer 767,018 characters.
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
		assert.deepEqual(failedBatchesOf(digest), []);
		assert.equal(digest.profile, PROFILE);
		assert.equal(digest.terms.length, 10 + 200 * 20, "every term kept, shared ones once");
		assert.equal(digest.terms.find((t) => t.term === "Felles 0")!.occurrenceCount, 200);
		// bounded: the first MAX - 2 in source order, plus the definition's and the first core occurrence when later
		assert.equal(digest.terms.find((t) => t.term === "Felles 0")!.occurrences.length, MAX_TERM_OCCURRENCES - 2, "bounded, the count exact");
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
		assert.deepEqual(failedBatchesOf(digest), []);
		for (const call of model.calls.filter((c) => !isReduce(c))) {
			const overhead = call.user.length - materialOf(call.user).length;
			assert.ok(overhead <= EXTRACTION_OVERHEAD_MAX_CHARS, `overhead ${overhead}`);
		}
		assert.ok(formatHeadingPath(["A".repeat(500), "B".repeat(500), "C".repeat(500)]).length <= HEADING_PATH_MAX_CHARS);
		assert.ok(model.calls.filter(isReduce).every((c) => c.user.length <= REDUCE_REQUEST_MAX_CHARS));
		assert.ok(digest.name!.length <= NAME_MAX_CHARS, "the stored name is bounded");
	});

	it("review 1, defect 4: citations must be on a page the part's text is actually on", async () => {
		const notes = (page: number) => JSON.stringify({ summaryBullets: [], terms: [], concepts: [], figures: [{ page, caption: "Et bilde" }] });
		const skipped = splitMaterial("--- Page 2 ---\n\nTwo\n\n--- Page 5 ---\n\nFive\n")[0]!;
		const missing = validateBatchReply(notes(3), skipped);
		assert.equal(missing.ok, false);
		assert.match((missing as { error: string }).error, /this part is on pages 2, 5, but \/figures\/0 has page 3/);
		assert.equal(validateBatchReply(notes(5), skipped).ok, true);
		const backward = splitMaterial("--- Page 5 ---\nFive\n--- Page 2 ---\nTwo\n")[0]!;
		assert.equal(validateBatchReply(notes(5), backward).ok, true);
		assert.equal(validateBatchReply(notes(2), backward).ok, true);
		const term = JSON.stringify({ summaryBullets: [], terms: [{ ...modelTerm("Matrise", 2), definitionPage: 4 }], concepts: [], figures: [] });
		assert.match((validateBatchReply(term, skipped) as { error: string }).error, /definitionPage has page 4/);
		const withProfile = (page: number) => JSON.stringify({ ...(JSON.parse(notes(page)) as object), profile: PROFILE });
		const model = fakeModel((_call, n) => withProfile(n === 0 ? 3 : 5));
		const digest = await digestMaterial("--- Page 2 ---\n\nTwo\n\n--- Page 5 ---\n\nFive\n", { ...META, complete: model.complete });
		assert.equal(model.calls.length, 2);
		assert.match(model.calls[0]!.user, /This part's pages: 2, 5\./);
		assert.match(model.calls[1]!.user, /\/figures\/0 has page 3/);
		assert.deepEqual(digest.figures, [{ page: 5, caption: "Et bilde", part: 0 }]);
	});

	it("review 1, defect 5: the reduce retry asks for Markdown, a JSON-wrapped profile is still accepted, and a single part keeps valid notes when only its profile fails", async () => {
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
		assert.deepEqual(failedBatchesOf(one), []);
		assert.deepEqual(one.terms.map((t) => [t.id, t.definition]), [["t_matrix", "A rectangular array of numbers."]]);
		assert.equal(one.profile, null);
		assert.match(one.profileError!, /the profile could not be written/);

		const halves = fakeModel((_call, n) =>
			n === 0
				? JSON.stringify({ summaryBullets: ["Matrices"], terms: [matrix], concepts: [], figures: [], profile: "flat text" })
				: JSON.stringify({ summaryBullets: [], terms: [{ term: " " }], concepts: [], figures: [], profile: PROFILE }),
		);
		const both = await digestMaterial("--- Page 1 ---\n\nA matrix.\n", { ...META, complete: halves.complete });
		assert.deepEqual(both.terms.map((t) => t.id), ["t_matrix"]);
		assert.equal(both.profile, PROFILE);
	});

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
		assert.equal(validateProfile("Intro.\n\n## Contents\nKapittel 1 (p. 1-3).").ok, true);
		assert.equal(validateProfile("plain prose, no headings").ok, false);
	});

	it("review 1, defect 7: an abort during the last call throws, on the single-part and the reduce path", async () => {
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

	it("review 1, defect 8 and review 3 prompts: an escaped marker is text, and the prompt states the page-local fence rule", async () => {
		const doc = "--- Page 1 ---\n\n# Intro\n\nText.\n\n```md\n\\--- Page 99 ---\n# Fake\n```\n\n# Real\n\nBody.\n";
		const model = fakeModel((call) => notesFor(call.user, { profile: PROFILE }));
		const digest = await digestMaterial(doc, { ...META, complete: model.complete });
		assert.equal(digest.pageCount, 1);
		const system = model.calls[0]!.system;
		assert.match(system, /Every line "--- Page N ---" starts page N, wherever it is/);
		assert.match(system, /A line that starts with a backslash \("\\--- Page N ---"\) is ordinary text/);
		assert.match(system, /a fence that is still open at the next "--- Page N ---" line, or at the end of the part, is not a fence/);
		assert.match(system, /When the request says the first line continues the previous part/);
	});

	// Review 3, prompts: distinguish symbols from interchangeable names; the term in its running-text form.
	it("review 3, prompts: the extraction prompt asks for aliases and symbols separately, and for the running-text form of each term", () => {
		const model = fakeModel((call) => notesFor(call.user, { profile: PROFILE }));
		return digestMaterial(slideDeck(2, 100), { ...META, complete: model.complete }).then(() => {
			const system = model.calls[0]!.system;
			assert.match(system, /"aliases": other names and abbreviations the material uses for this same concept/);
			assert.match(system, /"symbols": the notation this part uses for it/);
			assert.match(system, /Do not capitalise it because it starts a sentence, a heading, a slide title or a bullet/);
			assert.match(system, /keep proper nouns, acronyms, units and notation exactly as written/);
		});
	});

	it("concern 1: a term the material uses without defining it is kept with a null definition", async () => {
		const model = fakeModel(() =>
			JSON.stringify({ summaryBullets: ["Egenverdier"], terms: [modelTerm("determinant", 1, "supporting", null), modelTerm("egenverdi", 1, "core")], concepts: [], figures: [], profile: PROFILE }),
		);
		const digest = await digestMaterial("--- Page 1 ---\n\nEgenverdiene finnes med determinanten.\n", { ...META, complete: model.complete });
		assert.deepEqual(
			{ ...digest.terms[0]!, occurrences: undefined },
			{ id: "t_determinant", term: "determinant", aliases: [], symbols: [], page: 1, tier: "supporting", definition: null, definitionPage: null, definitionTier: null, occurrences: undefined, occurrenceCount: 1 },
		);
		assert.match(model.calls[0]!.system, /or null when this part uses the term without defining it/);
		const half = JSON.stringify({ summaryBullets: [], terms: [{ ...modelTerm("x", 1), definitionPage: null }], concepts: [], figures: [] });
		assert.match((validateBatchReply(half, batchOf([1])) as { error: string }).error, /not both null or both set/);
	});

	it("concern 2: parts persist their character ranges; pageCount is the highest marker, sourcePageCount the caller's", async () => {
		const doc = Array.from({ length: 30 }, (_, i) => `Avsnitt ${i}: ${"tekst ".repeat(60)}`).join("\n\n");
		const plan = splitMaterial(doc, { budgetTokens: 1_000 });
		assert.ok(plan.length >= 3);
		const model = fakeModel((call) => (isReduce(call) ? PROFILE : materialOf(call.user) === plan[1]!.text ? "nope" : notesFor(call.user)));
		const digest = await digestMaterial(doc, { ...META, complete: model.complete, split: { budgetTokens: 1_000 } });
		assert.ok(digest.batches.every((b) => b.pageStart === 1 && b.pageEnd === 1));
		assert.equal(new Set(digest.batches.map((b) => `${b.charStart}-${b.charEnd}`)).size, digest.batches.length);
		const failed = failedBatchesOf(digest)[0]!;
		assert.equal(doc.slice(failed.charStart, failed.charEnd), materialOf(model.calls[1]!.user));
		const pdf = await digestMaterial("--- Page 1 ---\n\nTekst.", { ...META, sourcePageCount: 2, complete: fakeModel((call) => notesFor(call.user, { profile: PROFILE })).complete });
		assert.equal(pdf.pageCount, 1);
		assert.equal(pdf.sourcePageCount, 2);
	});
});

describe("validateBatchReply and batchNotesText", () => {
	it("accepts a fenced JSON reply, refuses pages the part is not on, normalises names and drops blank aliases and symbols", () => {
		const notes = { summaryBullets: ["a"], terms: [], concepts: [], figures: [{ page: 4, caption: "x" }] };
		assert.equal(validateBatchReply("```json\n" + JSON.stringify(notes) + "\n```", batchOf([3, 4, 5])).ok, true);
		const outside = validateBatchReply(JSON.stringify(notes), batchOf([1, 2]));
		assert.match((outside as { error: string }).error, /this part is on pages 1-2, but \/figures\/0 has page 4/);
		const term = JSON.stringify({ summaryBullets: [], terms: [{ ...modelTerm(" Rang\u200B ", 4, "core", "Antall pivoter.", ["", " r ", "Rang"], ["\u200E", "rk"]), definitionPage: 3 }], concepts: [], figures: [] });
		const ok = validateBatchReply(term, batchOf([3, 4]));
		assert.ok(ok.ok);
		assert.deepEqual((ok as { value: BatchNotes }).value.terms[0], { term: "Rang", aliases: ["r"], symbols: ["rk"], page: 3, tier: "core", definition: "Antall pivoter.", definitionPage: 3 });
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

	it("review 2, finding 6: past the detail ladder the core term names keep their reserved share", () => {
		const parts = Array.from({ length: 1_000 }, (_, i) => part(i, i + 1, i + 1, [`Del ${i} handler om noe viktig og forklarer det grundig.`], ["Kapittel", `Seksjon ${i}`]));
		const core = Array.from({ length: 200 }, (_, k) => reduceTerm(`Kjernebegrep ${k}`, "core", "En lang definisjon. ".repeat(10)));
		const supporting = Array.from({ length: 300 }, (_, k) => reduceTerm(`Støtte ${k}`, "supporting", "En lang definisjon. ".repeat(10)));
		const text = batchNotesText({ parts, failed: [], terms: [...core, ...supporting], concepts: [], figures: [] });
		assert.ok(text.length <= REDUCE_REQUEST_MAX_CHARS);
		assert.match(text, /^## Terms$/m);
		for (const t of core) assert.ok(new RegExp(`\\b${t.term}\\b`).test(text), `${t.term} is listed`);
		assert.match(text, /300 supporting terms/);
		for (const max of [40_000, 8_000, 2_000]) {
			const small = batchNotesText({ parts, failed: [], terms: core, concepts: [], figures: [] }, max);
			assert.ok(small.length <= max);
			const listed = core.filter((t) => new RegExp(`\\b${t.term}\\b`).test(small)).length;
			assert.ok(listed >= Math.min(200, Math.floor((max / 4 - 100) / 18)), `${listed} core names at budget ${max}`);
		}
	});

	it("review 2, finding 6: parts are never grouped across a gap, and the failed parts are always counted", () => {
		const parts = Array.from({ length: 1_500 }, (_, k) => part(2 * k, 2 * k + 1, 2 * k + 1, [`Oddetall ${2 * k + 1} handler om noe.`]));
		const failed = Array.from({ length: 1_000 }, (_, k) => failedPart(2 * k + 1, 2 * k + 2));
		const text = batchNotesText({ parts, failed, terms: [], concepts: [], figures: [] });
		assert.ok(text.length <= REDUCE_REQUEST_MAX_CHARS);
		const failedLine = text.split("\n").find((l) => l.startsWith("(Not indexed"))!;
		assert.match(failedLine, /^\(Not indexed, so the notes are missing for these 1000 parts: /);
		assert.match(failedLine, /\.\)$/);
		const listed = [...failedLine.matchAll(/part (\d+), page/g)].map((m) => Number(m[1]));
		const unlisted = Number(/\(\+(\d+) more not listed\)/.exec(failedLine)?.[1] ?? 0);
		assert.equal(listed.length + unlisted, 1_000);
		const partsBlock = text.slice(0, text.indexOf("(Not indexed"));
		for (const m of partsBlock.matchAll(/Parts? (\d+)(?:-(\d+))?/g)) {
			for (let p = Number(m[1]); p <= Number(m[2] ?? m[1]); p++) assert.equal(p % 2, 1, `${m[0]} includes the failed part ${p}`);
		}
		const two = batchNotesText({ parts: [part(0, 1, 1, ["a"]), part(1, 2, 2, ["b"]), part(3, 4, 4, ["d"])], failed: [failedPart(2, 3)], terms: [], concepts: [], figures: [] }, 120);
		assert.ok(two.length <= 120);
		assert.doesNotMatch(two, /Parts 1-4|Parts 2-4/);
	});

	// Review 3, finding 10 (the failed line): at budgets 24 and 25 the notes were empty though "(Not indexed: 10 parts.)"
	// fits in 24, because a separator was reserved even when the failed line was the only output.
	it("review 2, finding 6 and review 3, finding 10: a tiny budget still counts the failed parts, cuts nothing mid-word, and reserves no separator it does not use", () => {
		const words = "Ordaaaaaaaa Ordbbbbbbbb Ordcccccccc Orddddddddd Ordeeeeeeee";
		const parts = Array.from({ length: 5 }, (_, i) => part(i * 3, i * 3 + 1, i * 3 + 1, [words, words]));
		const failed = Array.from({ length: 10 }, (_, i) => failedPart(15 + i, 16 + i));
		const core = [reduceTerm("Kjerneord", "core")];
		for (const max of [24, 25, 100, 160, 300, 1_000, 3_000]) {
			const text = batchNotesText({ parts, failed, terms: core, concepts: [], figures: [] }, max);
			assert.ok(text.length <= max, `${text.length} <= ${max}`);
			assert.match(text, /10 parts/, `the failed count at budget ${max}`);
			for (const m of text.matchAll(/Ord[a-z]*/g)) assert.equal(m[0].length, 11);
			assert.doesNotMatch(text, /Kjerne(?!ord)/);
		}
		assert.equal(batchNotesText({ parts, failed, terms: core, concepts: [], figures: [] }, 24), "(Not indexed: 10 parts.)");
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
			const terms = Array.from({ length: Math.floor(rand() * 300) }, (_, k) => reduceTerm(`Begrepnavn${k}`, rand() < 0.5 ? "core" : "supporting", rand() < 0.5 ? null : "Definisjon med mange ord i seg.", rand() < 0.3 ? [`B${k}`] : []));
			const max = [24, 300, 1_000, 5_000, 20_000, 58_000][Math.floor(rand() * 6)]!;
			const text = batchNotesText({ parts, failed, terms, concepts: [], figures: [] }, max);
			assert.ok(text.length <= max, `round ${round}: ${text.length} > ${max}`);
			if (failed.length > 0 && max > 24) assert.match(text, new RegExp(`(these ${failed.length} parts|this part|${failed.length} parts?)`), `round ${round}: the failed count`);
			for (const m of text.matchAll(/Begrepnavn\d*/g)) assert.ok(terms.some((t) => t.term === m[0]), `round ${round}: "${m[0]}" is a cut name`);
		}
	});
});

describe("review 3: page lists, labels and the reduce prompt", () => {
	// Review 3, finding 8, case 1: a part spanning markers 2, 59, 2 stored [2, 59] but its reduce heading said "page 2".
	it("review 3, finding 8: reduce labels use the part's stored page set", async () => {
		const notes = batchNotesText({ parts: [{ index: 0, pages: [2, 59], headingPath: [], summaryBullets: ["a"] }], failed: [{ index: 1, pages: [3, 60] }], terms: [], concepts: [], figures: [] });
		assert.match(notes, /### Part 1: pages 2, 59\n/);
		assert.match(notes, /part 2, pages 3, 60\.\)/);
		const doc = `--- Page 2 ---\n${"To. ".repeat(300)}\n--- Page 59 ---\n${"Femtini. ".repeat(100)}\n--- Page 2 ---\n${"Igjen. ".repeat(100)}\n--- Page 60 ---\n${"Seksti. ".repeat(500)}\n`;
		const plan = splitMaterial(doc, { budgetTokens: 1_000 });
		assert.deepEqual(plan[0]!.pages, [2, 59]);
		const model = fakeModel((call) => (isReduce(call) ? PROFILE : JSON.stringify({ summaryBullets: ["x"], terms: [], concepts: [], figures: [] })));
		await digestMaterial(doc, { ...META, complete: model.complete, split: { budgetTokens: 1_000 } });
		assert.match(model.calls.at(-1)!.user, /### Part 1: pages 2, 59\n/);
	});

	// Review 3, finding 8, case 2: with 150 odd-numbered pages the mandatory page list stopped at "141,…" although the
	// text and the validator included page 299.
	it("review 3, finding 8: the extraction request never shows a shortened page list", async () => {
		const doc = Array.from({ length: 150 }, (_, k) => `--- Page ${2 * k + 1} ---\nSide ${2 * k + 1}.`).join("\n");
		const [batch] = splitMaterial(doc);
		assert.equal(batch!.pages.length, 150);
		const model = fakeModel(() => JSON.stringify({ summaryBullets: ["x"], terms: [modelTerm("siste", 299, "core")], concepts: [], figures: [], profile: PROFILE }));
		const digest = await digestMaterial(doc, { ...META, complete: model.complete });
		const user = model.calls[0]!.user;
		assert.doesNotMatch(user.slice(0, user.indexOf("<material>")), /…/);
		assert.match(user, /This part's pages: 150 pages between 1 and 299, too many to list: page 1 and every page whose "--- Page N ---" line is in the text below\./);
		assert.equal(digest.terms[0]!.page, 299, "page 299 validates");
		// a list that fits is given whole
		const short = splitMaterial(Array.from({ length: 20 }, (_, k) => `--- Page ${2 * k + 1} ---\nS.`).join("\n"))[0]!;
		assert.ok(short.pages.length === 20);
	});

	// Review 3, finding 8, case 3: for markers 5, 2 the first mention on page 5 moved to page 2 only because the later
	// definition's page number was smaller.
	it("review 3, finding 8: the first mention follows source order when page numbers run backwards", () => {
		const backward = splitMaterial("--- Page 5 ---\nFem\n--- Page 2 ---\nTo\n")[0]!;
		const reply = JSON.stringify({ summaryBullets: [], terms: [{ ...modelTerm("Egenverdi", 5, "core", "Definert senere."), definitionPage: 2 }], concepts: [], figures: [] });
		const notes = validateBatchReply(reply, backward);
		assert.ok(notes.ok);
		assert.equal((notes as { value: BatchNotes }).value.terms[0]!.page, 5, "page 5 comes first in the text");
		const forward = splitMaterial("--- Page 2 ---\nTo\n--- Page 5 ---\nFem\n")[0]!;
		const moved = validateBatchReply(JSON.stringify({ summaryBullets: [], terms: [{ ...modelTerm("Egenverdi", 5, "core", "Definert tidlig."), definitionPage: 2 }], concepts: [], figures: [] }), forward);
		assert.equal((moved as { value: BatchNotes }).value.terms[0]!.page, 2, "a definition earlier in the text is the first mention");
		// across parts, a term's page is its first occurrence in source order, not the smallest number
		const terms = mergeTerms([[modelTerm("Egenverdi", 5, "core")], [modelTerm("Egenverdi", 2, "core")]]);
		assert.equal(terms[0]!.page, 5);
	});

	// Review 3, prompts: missing parts, no unsupported citations or verbatim definitions, not "the whole document" after
	// failures, the profile prose in the material's language.
	it("review 3, prompts: the reduce prompt discloses missing parts, asks only for supported citations, and states the prose language", () => {
		const digest = {
			name: null,
			pageCount: 4,
			batches: [
				{ index: 0, pageStart: 1, pageEnd: 2, pages: [1, 2], headingPath: [], charStart: 0, charEnd: 5, status: "indexed" as const, summaryBullets: ["a"] },
				{ index: 1, pageStart: 3, pageEnd: 4, pages: [3, 4], headingPath: [], charStart: 5, charEnd: 9, status: "failed" as const, error: "x" },
			],
			terms: [],
			concepts: [],
			figures: [],
		};
		const request = buildReduceRequest(digest)!;
		assert.doesNotMatch(request.system, /WHOLE/);
		assert.match(request.system, /You see notes, not the material itself/);
		assert.match(request.system, /Cite only pages the notes give for that item; leave out a claim the notes do not support/);
		assert.match(request.system, /Quote a definition only when the notes give its complete wording/);
		assert.match(request.system, /When parts are missing, do not present the notes as the whole document/);
		assert.match(request.system, /Write the prose in the material's own language/);
		assert.match(request.user, /read in 2 parts, of which 1 could not be indexed/);
	});
});

describe("review 4: prompts", () => {
	it("the extraction prompt asks for the singular index-entry form and shows notation unescaped, with the JSON escaping stated", async () => {
		const model = fakeModel((call) => notesFor(call.user, { profile: PROFILE }));
		await digestMaterial(slideDeck(2, 100), { ...META, complete: model.complete });
		const system = model.calls[0]!.system;
		assert.match(system, /Report the singular, uninflected form the material would use as a heading or an index entry \("resistor" even where the text says "resistors", "matrix" where it says "matrices"\), unless the plural is itself the term/);
		assert.ok(system.includes("(v, λ, C, \\mathbb{R})"), "the example is the notation as written");
		assert.ok(system.includes('so \\mathbb{R} is written "\\\\mathbb{R}"'), "the JSON escaping is stated once, explicitly");
		assert.ok(!system.includes('"\\\\mathbb{R}");'), "no doubly escaped example among the plain ones");
	});

	it("the reduce prompt never asks to cite every claim, and the most reduced notes say their names have no pages", () => {
		const digest = { name: null, pageCount: 2, batches: [{ index: 0, pageStart: 1, pageEnd: 2, pages: [1, 2], headingPath: [], charStart: 0, charEnd: 5, status: "indexed" as const, summaryBullets: ["a"] }], terms: [], concepts: [], figures: [] };
		const { system } = buildReduceRequest(digest)!;
		assert.doesNotMatch(system, /Cite every claim/);
		assert.match(system, /Cite a claim as \(p\. N\) with a page the notes give for it, and only so/);
		assert.match(system, /When the notes list terms by name only, without pages \(shortened for length\), name them without a page and say that their pages are not available in the notes; never give them a page/);
		assert.ok(system.includes(PROFILE_FORMAT_SECTIONS), "the same profile sections");
		// the profiler's own prompt still cites every claim (it reads the material)
		assert.match(PROFILE_FORMAT_RULES, /^Cite every claim/);
		// at the most reduced level the core names come without pages, and the notes say so
		const core = Array.from({ length: 400 }, (_, i) => reduceTerm(`Kjernebegrep nummer ${i}`, "core", `Definisjon ${i}.`));
		const text = batchNotesText({ parts: [part(0, 1, 200, ["Oversikt"])], failed: [], terms: core, concepts: [], figures: [] }, 3_000);
		assert.match(text, /Core terms \(names only, in order of first mention; their pages are not available in these notes\): Kjernebegrep nummer 0/);
		assert.doesNotMatch(text, /Kjernebegrep nummer 0 \[core, p\./);
	});
});

describe("ids: identity is the exact spelling", () => {
	it("an id is the normalised name, encoded injectively: case, hyphens, apostrophes and compatibility forms all count", () => {
		const expected: [string, string][] = [
			["C", "t_C"],
			["C++", "t_C~2b~~2b~"],
			["C--", "t_C~2d~~2d~"],
			["MW", "t_MW"],
			["mW", "t_mW"],
			["O(n)", "t_O~28~n~29~"],
			["o(n)", "t_o~28~n~29~"],
			["x²", "t_x²"],
			["x2", "t_x2"],
			["Entropy", "t_Entropy"],
			["entropy", "t_entropy"],
			["COVID-19", "t_COVID~2d~19"],
			["COVID 19", "t_COVID_19"],
			["ordinary least squares", "t_ordinary_least_squares"],
			["OLS", "t_OLS"],
		];
		for (const [name, id] of expected) assert.equal(termId(name), id, name);
		assert.equal(conceptId("Kjerneregelen"), "c_Kjerneregelen");
		// only invisible characters, NFC and whitespace are normalised
		assert.equal(termId(" Eigen\u00ADvalue\u200B "), "t_Eigenvalue");
		assert.equal(termId("første".normalize("NFD")), termId("første"));
		assert.equal(termId("a \t\n b"), termId("a b"));
		assert.equal(termId("\u200ELRM\u2066isolated\u2069"), termId("LRMisolated"));
		for (const [a, b] of [["Newton’s law", "Newton's law"], ["ﬁnite", "finite"], ["ＡＢＣ", "ABC"], ["f″(x)", "f''(x)"], ["Navier–Stokes", "Navier-Stokes"], ["Maß", "MASS"]]) {
			assert.notEqual(termId(a!), termId(b!), `${a} / ${b}`);
		}
		// ids are safe JSON keys
		const keyed = Object.fromEntries(["__proto__", "constructor", "toString", "~", "_", "-", "t_c"].map((n) => [termId(n), n]));
		assert.deepEqual(JSON.parse(JSON.stringify(keyed)), keyed);
		assert.ok(!Object.keys(keyed).includes("__proto__"));
	});

	it("a long name is cut between whole characters with a hash that no short id can equal", () => {
		const a = `${"ø".repeat(150)}a`;
		const b = `${"ø".repeat(150)}b`;
		assert.notEqual(termId(a), termId(b));
		assert.ok([...encodeName(normalizeName(a))].length <= ID_MAX_CHARS);
		assert.match(encodeName(a), /^ø{96}-[0-9a-z]{22}$/);
		assert.ok(!encodeName("x".repeat(ID_MAX_CHARS)).includes("-"), "a name at the limit is kept whole");
		assert.ok(!encodeName("a-b").includes("-"), "a short id never contains -");
		assert.ok(encodeName(`${"+".repeat(40)}`).includes("-"), "40 symbols encode past the limit");
	});

	// Every collision and wrong-merge family of the three reviews: distinct normalised names, distinct ids.
	it("regression: every collision family of reviews 1-3 keeps distinct ids", () => {
		const families: string[][] = [
			["C", "C++", "C--", "c", "ℂ", "C#"],
			["f(x)", "f′(x)", "f'(x)", "f''(x)", "f″(x)"],
			["∇", "u2207", "~2207~", "_2207"],
			["a+b", "a b", "a_b", "a~2b~b"],
			["-1", "1"],
			["f^-1(x)", "f^1(x)"],
			["O(n-1)", "O(n 1)", "O(n−1)"],
			["x-y", "x_y", "x y"],
			["a−b", "a-b"],
			["x²", "x₂", "x2"],
			["ℝ²", "R2", "ℝ", "R"],
			["10²", "102"],
			["_", "---", "~", "-"],
			["MW", "mW", "Mw", "mw"],
			["Pa", "pA", "PA", "pa"],
			["O(n)", "o(n)"],
			["O(n-m)", "O(n m)", "O(n - m)"],
			["Entropy", "entropy"],
			["COVID-19", "COVID 19", "COVID19", "covid-19"],
			["ordinary least squares", "OLS", "Ordinary Least Squares"],
			["eigen-value", "eigen value", "eigenvalue"],
			["İstanbul", "Istanbul", "istanbul"],
			["Morgen", "morgen"],
			["Log", "log"],
			["Cal", "cal"],
		];
		for (const family of families) {
			assert.equal(new Set(family.map(termId)).size, family.length, family.join(" / "));
			assert.equal(new Set(family.map(conceptId)).size, family.length);
		}
		// a name differing only after the first ~100 characters
		assert.notEqual(termId(`${"lang ".repeat(30)}slutt A`), termId(`${"lang ".repeat(30)}slutt B`));
	});

	// The injectivity property over generated names from every collision family: equal normalised names exactly when
	// equal ids; presentation that normalisation removes never changes an id.
	it("property: termId is injective on normalised names and stable across presentations", () => {
		const atoms = [
			"C", "c", "C++", "C--", "C#", "-1", "1", "f^-1(x)", "f^1(x)", "O(n-1)", "O(n", "1)", "x_y", "x-y", "x", "y", "a−b", "a-b", "x²", "x₂", "x2",
			"ℝ²", "R2", "ℝ", "R", "ℂ", "10²", "102", "_", "---", "~", "f(x)", "f'(x)", "f′(x)", "f''(x)", "f″(x)", "∇", "u2207", "~2207~", "a+b", "MW", "mW",
			"Pa", "pA", "O(n)", "o(n)", "Entropy", "entropy", "COVID-19", "COVID", "19", "OLS", "ordinary", "least", "squares", "λ", "første", "forste",
			"İstanbul", "Maß", "MASS", "ﬁnite", "finite", "ＡＢＣ", "ABC", "__proto__", "t_c", "Navier–Stokes", "Navier-Stokes", "kernel", "Kernel",
			"𝔸", "x⁻¹", "\ud800", "%", "~7e~", "-", "–", `${"x".repeat(130)}a`, `${"x".repeat(130)}b`, `${"y".repeat(60)}`,
		];
		const invisible = ["\u00AD", "\u200B", "\u200C", "\u200D", "\u2060", "\uFEFF", "\u200E", "\u200F", "\u202A", "\u202C", "\u2066", "\u2069", "\u0007"];
		const spaces = [" ", "  ", "\t", " \n ", " "];
		const rand = mulberry32(23);
		const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
		const idOf = new Map<string, string>();
		const nameOf = new Map<string, string>();
		for (let i = 0; i < 20_000; i++) {
			const count = 1 + Math.floor(rand() * 3);
			const canonical = Array.from({ length: count }, () => pick(atoms)).join(rand() < 0.2 ? "" : " ");
			// a presentation that normalising must undo: invisible characters, other whitespace, NFD, padding
			let shown = "";
			for (const ch of canonical) {
				shown += ch === " " ? pick(spaces) : ch;
				if (rand() < 0.1) shown += pick(invisible);
			}
			shown = `${rand() < 0.2 ? " " : ""}${rand() < 0.2 ? shown.normalize("NFD") : shown}${rand() < 0.2 ? "\n" : ""}`;
			const name = normalizeName(canonical);
			assert.equal(normalizeName(shown), name, `${JSON.stringify(shown)} normalises to ${JSON.stringify(name)}`);
			const id = termId(shown);
			assert.equal(id, termId(name));
			assert.equal(idOf.get(name) ?? id, id, `${JSON.stringify(name)} got two ids`);
			idOf.set(name, id);
			assert.equal(nameOf.get(id) ?? name, name, `${JSON.stringify(name)} and ${JSON.stringify(nameOf.get(id))} share ${id}`);
			nameOf.set(id, name);
			assert.equal(normalizeName(name), name, "idempotent");
		}
		assert.ok(idOf.size > 5_000, `${idOf.size} distinct names checked`);
	});

	it("a name with nothing visible is a retry; a name of symbols only is a term", async () => {
		assert.equal(termId("_"), "t_~5f~");
		assert.equal(conceptId("---"), "c_~2d~~2d~~2d~");
		const zw = "\u200B";
		const lrm = "\u200E";
		// review 3, finding 10: a left-to-right mark alone passed as a core name, definition and summary
		const bad = { summaryBullets: [lrm], terms: [modelTerm(zw, 1, "core"), modelTerm("_", 1, "core", lrm)], concepts: [{ name: `\u00AD `, statement: "Noe.", page: 1 }, { name: "---", statement: "Linje.", page: 1 }], figures: [] };
		const good = { ...bad, summaryBullets: ["Tegn"], terms: [modelTerm("_", 1, "core", "Plassholder.")], concepts: [{ name: "---", statement: "Linje.", page: 1 }] };
		const model = fakeModel((_call, n) => JSON.stringify({ ...(n === 0 ? bad : good), profile: PROFILE }));
		const digest = await digestMaterial("--- Page 1 ---\n\nTegn.\n", { ...META, complete: model.complete });
		assert.equal(model.calls.length, 2);
		for (const path of ["/summaryBullets/0", "/terms/0/term", "/terms/1/definition", "/concepts/0/name"]) assert.match(model.calls[1]!.user, new RegExp(`${path}: has only invisible characters`));
		assert.deepEqual(digest.terms.map((t) => t.id), ["t_~5f~"]);
		assert.deepEqual(digest.concepts.map((c) => c.id), ["c_~2d~~2d~~2d~"]);
		assert.throws(() => mergeTerms([[modelTerm(zw, 1, "core")]]), /without a name/);
		assert.throws(() => mergeConcepts([[{ name: lrm, statement: "x", page: 1 }]]), /without a name/);
		// review 3, finding 10: "## Contents" followed only by U+200B passed profile validation
		assert.equal(validateProfile("## Contents\n\u200B").ok, false);
		assert.equal(validateProfile(`## Contents\n${lrm}\u2066\u2069`).ok, false);
		assert.equal(hasVisibleContent(`${lrm}${zw}\u00AD \t`), false);
		assert.equal(hasVisibleContent("x"), true);
	});
});

describe("combining by exact id within a document", () => {
	// Review 1, defect 3 (the part half), changed for the identity ruling: "ordinary least squares" (alias OLS) and "OLS"
	// used to be unified; now they are two terms (a suggested duplicate in the class glossary), and v merges nothing.
	it("review 1, defect 3: a declared alias merges nothing; shared symbols merge nothing", () => {
		const merged = mergeTerms([
			[modelTerm("ordinary least squares", 3, "supporting", "Minimerer summen av kvadrerte residualer.", ["OLS"]), modelTerm("velocity", 3, "core", "Fart med retning.", [], ["v"])],
			[modelTerm("OLS", 2, "core", null), modelTerm("voltage", 4, "core", "Spenning.", [], ["v", "U"]), modelTerm("v", 4, "supporting", null)],
		]);
		assert.deepEqual(merged.map((t) => t.id), ["t_ordinary_least_squares", "t_velocity", "t_OLS", "t_voltage", "t_v"]);
		assert.deepEqual(merged[0]!.aliases, ["OLS"], "kept as lookup data");
		assert.equal(merged[2]!.tier, "core");
	});

	// Review 1, defect 10 and review 3, finding 7: a supporting gloss never outranks a core definition, and the chosen
	// definition keeps the tier of the occurrence that supplied it.
	it("review 1, defect 10 / review 3, finding 7: the definition comes from a core occurrence first and keeps its tier", () => {
		for (const intro of ["Uorden, løst sagt.", null]) {
			const [entropy] = mergeTerms([[modelTerm("Entropy", 1, "supporting", intro)], [modelTerm("Entropy", 7, "core", "S = k ln W, der W er antall mikrotilstander.")]]);
			assert.deepEqual(
				{ page: entropy!.page, tier: entropy!.tier, definition: entropy!.definition, definitionPage: entropy!.definitionPage, definitionTier: entropy!.definitionTier },
				{ page: 1, tier: "core", definition: "S = k ln W, der W er antall mikrotilstander.", definitionPage: 7, definitionTier: "core" },
			);
		}
		// review 3, finding 7, document A: a supporting gloss on page 1 and an undefined core occurrence on page 5
		const [a] = mergeTerms([[modelTerm("Entropy", 1, "supporting", "Informal gloss.")], [modelTerm("Entropy", 5, "core", null)]]);
		assert.deepEqual([a!.tier, a!.definition, a!.definitionTier], ["core", "Informal gloss.", "supporting"], "core overall, the gloss stays supporting");
	});

	it("occurrences are bounded per term with an exact count, and the summary is derived from the stored list", () => {
		const many = Array.from({ length: 150_000 }, (_, i) => modelTerm("Energi", 1, i === 149_999 ? "core" : "supporting", i === 100_000 ? "Evnen til å utføre arbeid." : null));
		const started = performance.now();
		const [energi] = partTerms(0, many);
		assert.ok(performance.now() - started < 5_000);
		assert.equal(energi!.occurrenceCount, 150_000);
		assert.equal(energi!.occurrences.length, MAX_TERM_OCCURRENCES);
		assert.equal(energi!.tier, "core", "the first core occurrence is kept");
		assert.equal(energi!.definition, "Evnen til å utføre arbeid.");
		assert.equal(energi!.definitionTier, "supporting");
		const { page, tier, definition, definitionPage, definitionTier } = energi!;
		assert.deepEqual(summarizeOccurrences(energi!.occurrences), { page, tier, definition, definitionPage, definitionTier });
	});
});

describe("recovery: merging a re-run part equals a clean run", () => {
	// Review 3, finding 4: with "velocity → v" and a standalone "v" indexed and a recovered "voltage → v", merging the
	// saved output with the recovered part gave 2 entries and a clean run 3; the saved digest had erased that v was seen.
	it("review 3, finding 4: the stored digest plus a recovered part is the clean run on the same observations", async () => {
		const doc = slideDeck(40, 1_500);
		const plan = splitMaterial(doc, SMALL);
		assert.ok(plan.length >= 4);
		const lost = plan[2]!.index;
		/** What each part reports: the reviewer's probe, a term in every part (with more than MAX occurrences in all), and the lost part's core definition. */
		const observations = (index: number, pages: number[]): string => {
			const p = pages[0]!;
			const terms: BatchTerm[] = [
				...Array.from({ length: 30 }, () => modelTerm("Felles", p, "supporting", null)),
				index === 0 ? modelTerm("velocity", p, "core", "rate of change of position", [], ["v"]) : modelTerm("v", p, "supporting", null),
			];
			if (index === lost) terms.push(modelTerm("voltage", p, "core", "electric potential difference", [], ["v"]), modelTerm("Felles", p, "core", "Den formelle definisjonen."));
			return JSON.stringify({ summaryBullets: [`Del ${index}`], terms, concepts: [{ name: "Regel", statement: `Fra del ${index}.`, page: p }], figures: [{ page: p, caption: "Figur" }] });
		};
		const indexOf = (user: string) => plan.findIndex((b) => b.text === materialOf(user));
		const clean = await digestMaterial(doc, { ...META, split: SMALL, complete: fakeModel((call) => (isReduce(call) ? PROFILE : observations(indexOf(call.user), requestPages(call.user)))).complete });
		const partial = await digestMaterial(doc, {
			...META,
			split: SMALL,
			complete: fakeModel((call) => (isReduce(call) ? PROFILE : indexOf(call.user) === lost ? "nope" : observations(indexOf(call.user), requestPages(call.user)))).complete,
		});
		assert.deepEqual(failedBatchesOf(partial).map((b) => b.index), [lost]);
		assert.ok(!partial.terms.some((t) => t.term === "voltage"));

		const stored = JSON.parse(JSON.stringify(partial)) as MaterialDigest;
		const batch = batchFromRef(doc, failedBatchesOf(stored)[0]!);
		const notes = validateBatchReply(observations(lost, batch.pages), batch);
		assert.ok(notes.ok);
		const recovered = mergeRecoveredBatch(stored, batch, (notes as { value: BatchNotes }).value);
		const strip = ({ profile: _p, profileError: _e, ...rest }: MaterialDigest) => rest;
		assert.deepEqual(strip(recovered), strip(clean));
		assert.deepEqual(recovered.terms.map((t) => t.term), ["Felles", "velocity", "v", "voltage"], "three entries for v, velocity and voltage, as a clean run");
		const felles = recovered.terms[0]!;
		assert.ok(felles.occurrenceCount > MAX_TERM_OCCURRENCES && felles.occurrences.length <= MAX_TERM_OCCURRENCES, `${felles.occurrenceCount} / ${felles.occurrences.length}`);
		assert.ok(felles.occurrences.some((o) => o.part === lost && o.definition !== null), "the late core definition's occurrence is kept");
		assert.equal(felles.definition, "Den formelle definisjonen.");
		assert.ok(parseStoredDigest(JSON.stringify(recovered)).ok);
		assert.throws(() => mergeRecoveredBatch(recovered, batch, (notes as { value: BatchNotes }).value), /not a failed part/);
		// combining is a union by id: the order the lists come in does not change the terms
		const lists = plan.map((b) => partTerms(b.index, (validateBatchReply(observations(b.index, b.pages), b) as { value: BatchNotes }).value.terms, b));
		assert.deepEqual(combineTerms(lists), clean.terms);
		assert.deepEqual(combineTerms([...lists].reverse()), clean.terms);
	});

	// Review 4, finding 2: truncation ran only when the LIST was longer than 64, so a stored digest (62 occurrences,
	// count 65) merged with a recovered part 0 (1 occurrence) kept 63 where a clean run keeps 62; the same inside a clean
	// run when part 0 has 65 occurrences and part 1 has 1.
	it("review 4, finding 2: the reviewer's cases: recovered merge and multi-part combine equal a clean run above the cap", () => {
		const entropy = (part: number, n = 1) => partTerms(part, Array.from({ length: n }, () => modelTerm("Entropy", part + 1, "core", "Uorden.")));
		const parts = Array.from({ length: 66 }, (_, p) => entropy(p));
		const [clean] = combineTerms(parts);
		assert.deepEqual([clean!.occurrences.length, clean!.occurrenceCount], [MAX_TERM_OCCURRENCES - 2, 66]);
		const stored = combineTerms(parts.slice(1));
		assert.deepEqual([stored[0]!.occurrences.length, stored[0]!.occurrenceCount], [MAX_TERM_OCCURRENCES - 2, 65]);
		assert.deepEqual(combineTerms([stored, parts[0]!]), [clean], "the stored digest plus the recovered part 0");
		// inside one clean run: part 0 with 65 occurrences, part 1 with 1
		const [inRun] = combineTerms([entropy(0, 65), entropy(1)]);
		const [whole] = partTerms(0, Array.from({ length: 66 }, () => modelTerm("Entropy", 1, "core", "Uorden.")));
		assert.equal(inRun!.occurrenceCount, 66);
		assert.equal(inRun!.occurrences.length, whole!.occurrences.length);
		assert.equal(inRun!.occurrences.length, MAX_TERM_OCCURRENCES - 2);
	});

	it("property: for counts around and well above the cap, any recovered part merged into the rest equals the clean run", () => {
		/** The stored form of a whole source-ordered list, computed directly from its definition. */
		const expectedCut = (all: readonly DigestTerm["occurrences"][number][]) => {
			if (all.length <= MAX_TERM_OCCURRENCES) return [...all];
			const keep = new Set(Array.from({ length: MAX_TERM_OCCURRENCES - 2 }, (_, i) => i));
			const coreDef = all.findIndex((o) => o.definition !== null && o.tier === "core");
			const supplier = coreDef >= 0 ? coreDef : all.findIndex((o) => o.definition !== null);
			if (supplier >= 0) keep.add(supplier);
			const core = all.findIndex((o) => o.tier === "core");
			if (core >= 0) keep.add(core);
			return all.filter((_, i) => keep.has(i));
		};
		let checks = 0;
		for (const count of [1, 2, 30, 61, 62, 63, 64, 65, 66, 67, 70, 100, 127, 128, 129, 200, 500, 2_000]) {
			for (let seed = 1; seed <= 6; seed++) {
				const rand = mulberry32(count * 31 + seed);
				const partCount = 1 + Math.floor(rand() * Math.min(count, 12));
				// every part gets at least one occurrence; the rest land anywhere; definitions and core occurrences are rare and late
				const perPart = Array.from({ length: partCount }, () => 1);
				for (let i = partCount; i < count; i++) perPart[Math.floor(rand() * partCount)]!++;
				const raw = perPart.map((n, part) =>
					Array.from({ length: n }, () => {
						const tier: TermTier = rand() < 0.05 ? "core" : "supporting";
						return modelTerm("Felles", part + 1, tier, rand() < 0.04 ? `Def ${part}.` : null);
					}),
				);
				const lists = raw.map((terms, part) => partTerms(part, terms));
				const clean = combineTerms(lists);
				assert.equal(clean[0]!.occurrenceCount, count);
				const full = raw.flatMap((terms, part) => terms.map((t) => ({ part, page: t.page, tier: t.tier, definition: t.definition, definitionPage: t.definitionPage })));
				assert.deepEqual(clean[0]!.occurrences, expectedCut(full), `count ${count}, seed ${seed}: the cut of the whole list`);
				for (let lost = 0; lost < partCount; lost++) {
					const rest = combineTerms(lists.filter((_, p) => p !== lost));
					const recovered = rest.length === 0 ? combineTerms([lists[lost]!]) : combineTerms([rest, lists[lost]!]);
					assert.deepEqual(recovered, clean, `count ${count}, seed ${seed}, part ${lost} of ${partCount}`);
					checks++;
				}
				// combining one part at a time (left to right) is the same as combining them all at once
				const stepwise = lists.slice(1).reduce((acc, list) => combineTerms([acc, list]), lists[0]!);
				assert.deepEqual(stepwise, clean, `count ${count}, seed ${seed}: stepwise`);
				// the stored form is idempotent and passes the read boundary's check
				const [t] = clean;
				assert.deepEqual(truncateOccurrences(t!.occurrences, t!.occurrenceCount), t!.occurrences);
			}
		}
		assert.ok(checks > 300, `${checks} recovery checks`);
	});

	// Review 3, finding 4, first half: the issued id depended on which spelling declared the alias.
	it("review 3, finding 4: an id never depends on which spelling declares an alias", () => {
		const one = mergeTerms([[modelTerm("ordinary least squares", 1, "core", null, ["OLS"]), modelTerm("OLS", 1, "supporting", null)]]);
		const two = mergeTerms([[modelTerm("ordinary least squares", 1, "core", null), modelTerm("OLS", 1, "supporting", null, ["ordinary least squares"])]]);
		assert.deepEqual(one.map((t) => t.id), two.map((t) => t.id));
	});
});

describe("mergeGlossary: exact ids, occurrences, suggested duplicates", () => {
	it("groups by exact id across documents, keeps every occurrence with its document, core if any says core", () => {
		const a = source("doc-a", [docTerm("Egenverdi", 4, "supporting", { symbols: ["λ"], definition: "Et tall λ slik at Av = λv." }), docTerm("Matrise", 1, "core")]);
		const b = source("doc-b", [docTerm("Egenverdi", 12, "core", { definition: "Egenverdien." }), docTerm("matrise", 2, "supporting", { definition: null })]);
		const g = mergeGlossary([a, b]);
		assert.deepEqual(ids(g), ["t_Egenverdi", "t_Matrise", "t_matrise"]);
		const eigen = g.terms["t_Egenverdi"]!;
		assert.equal(eigen.tier, "core");
		assert.equal(eigen.definition, "Egenverdien.", "the core occurrence's definition");
		assert.equal(eigen.definitionSource, "doc-b");
		assert.deepEqual(eigen.symbols, ["λ"]);
		assert.deepEqual(eigen.citations.map((c) => [c.sourceHash, c.page, c.tier, c.definitionTier]), [["doc-a", 4, "supporting", "supporting"], ["doc-b", 12, "core", "core"]]);
		assert.deepEqual(eigen.occurrences.map((o) => [o.sourceHash, o.page]), [["doc-a", 4], ["doc-b", 12]]);
		assert.equal(eigen.occurrenceCount, 2);
		assert.deepEqual(g.suggestedDuplicates, [{ ids: ["t_Matrise", "t_matrise"], reasons: ["similar_name"] }]);
		assert.deepEqual(mergeGlossary([b, a]), g, "independent of input order");
		assert.deepEqual(g.conflicts, []);
	});

	// The brief's small realistic glossaries.
	it("suggests ordinary least squares / OLS, Entropy / entropy and COVID-19 / COVID 19, and not two entries that only share a symbol", () => {
		const g = mergeGlossary([
			source("stats", [docTerm("ordinary least squares", 3, "core", { aliases: ["OLS"] }), docTerm("Entropy", 1, "supporting"), docTerm("COVID-19", 2, "core")]),
			source("lecture", [docTerm("OLS", 2, "supporting", { definition: null }), docTerm("entropy", 5, "core"), docTerm("COVID 19", 1, "supporting")]),
			source("physics", [docTerm("velocity", 1, "core", { symbols: ["v"] }), docTerm("voltage", 1, "core", { symbols: ["v", "U"] }), docTerm("internal energy", 1, "core", { symbols: ["U"] })]),
		]);
		assert.equal(ids(g).length, 9, "nothing merged");
		assert.deepEqual(g.suggestedDuplicates, [
			{ ids: ["t_COVID_19", "t_COVID~2d~19"], reasons: ["similar_name"] },
			{ ids: ["t_Entropy", "t_entropy"], reasons: ["similar_name"] },
			{ ids: ["t_OLS", "t_ordinary_least_squares"], reasons: ["alias"] },
		]);
		// the symbol v is lookup data: both are candidates, neither is the answer
		assert.deepEqual(findTermCandidates(g, "v").map((c) => [c.entry.id, c.matchedBy]), [["t_velocity", ["symbol"]], ["t_voltage", ["symbol"]]]);
		assert.equal(findTerm(g, "v"), undefined);
		assert.equal(findTerm(g, "velocity")?.id, "t_velocity");
		// two entries naming each other, and a shared relaxed name plus an alias, are one group with both reasons
		const both = mergeGlossary([source("x", [docTerm("Kernel", 1, "core", { aliases: ["kernel"] }), docTerm("kernel", 2, "core")])]);
		assert.deepEqual(both.suggestedDuplicates, [{ ids: ["t_Kernel", "t_kernel"], reasons: ["alias", "similar_name"] }]);
	});

	// Review 1, defect 3; review 2, finding 1; review 3, finding 2: shared symbols, flipped aliases, hubs, chains and
	// one unopposed alias across subjects merge nothing, in any order.
	it("regression: no alias or symbol configuration of reviews 1-3 merges anything, in any input order", () => {
		const permutations = <T>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
		const cases: [GlossarySource[], string[]][] = [
			[[source("d1", [docTerm("velocity", 1, "core", { aliases: ["v"] })]), source("d2", [docTerm("voltage", 1, "core", { aliases: ["v", "U"] })]), source("d3", [docTerm("internal energy", 1, "core", { aliases: ["U"] })])], ["t_internal_energy", "t_velocity", "t_voltage"]],
			[[source("d1", [docTerm("velocity", 1, "core", { aliases: ["v"] })]), source("d2", [docTerm("v", 1, "core", { aliases: ["voltage"] })]), source("d3", [docTerm("voltage", 1, "core")])], ["t_v", "t_velocity", "t_voltage"]],
			[[source("d1", [docTerm("v", 1, "core", { aliases: ["velocity", "voltage"] })]), source("d2", [docTerm("velocity", 1, "core")]), source("d3", [docTerm("voltage", 1, "core")])], ["t_v", "t_velocity", "t_voltage"]],
			[[source("d1", [docTerm("Eigenvalue", 1, "core", { aliases: ["Egenverdi"] })]), source("d2", [docTerm("Egenverdi", 1, "core", { aliases: ["λ"] })]), source("d3", [docTerm("λ", 1, "core")])], ["t_Egenverdi", "t_Eigenvalue", "t_λ"]],
			[[source("elec", [docTerm("capacitance", 1, "core", { aliases: ["C"], definition: "charge per volt" })]), source("cs", [docTerm("C", 1, "core", { definition: "a programming language" })])], ["t_C", "t_capacitance"]],
			[[source("a", [docTerm("Beta", 1, "core", { aliases: ["Alpha"] })]), source("b", [docTerm("Alpha", 2, "core")])], ["t_Alpha", "t_Beta"]],
			[[source("d1", [docTerm("MW", 1, "core", { definition: "megawatt" })]), source("d2", [docTerm("mW", 1, "core", { definition: "milliwatt" })])], ["t_MW", "t_mW"]],
			[[source("d1", [docTerm("O(n)", 1, "core")]), source("d2", [docTerm("o(n)", 1, "core")])], ["t_O~28~n~29~", "t_o~28~n~29~"]],
		];
		for (const [docs, expected] of cases) {
			const first = mergeGlossary(docs);
			assert.deepEqual(ids(first), expected);
			for (const order of permutations(docs)) assert.deepEqual(mergeGlossary(order), first);
		}
		// review 3, finding 2: "C" names two entries (capacitance's alias, the language's own name): ambiguous, no answer
		const cap = mergeGlossary(cases[4]![0]);
		assert.equal(findTerm(cap, "C"), undefined);
		assert.deepEqual(findTermCandidates(cap, "C").map((c) => [c.entry.id, c.matchedBy]), [["t_C", ["name"]], ["t_capacitance", ["alias"]]]);
		assert.equal(findTerm(cap, "capacitance")?.definition, "charge per volt");
		assert.equal(findTermById(cap, "t_C")?.definition, "a programming language");
		// review 3, finding 1: MW and mW are two coverage targets; plain "mw" is ambiguous
		const watts = mergeGlossary(cases[6]![0]);
		assert.equal(findTerm(watts, "MW"), undefined, "an exact own-name match does not suppress the other entry");
		assert.equal(findTermById(watts, "t_mW")?.definition, "milliwatt");
	});

	// Review 1, defect 9 and review 3, finding 6: a repeated source counts once; two different digests of one source
	// are resolved by rule, never by argument order, and the conflict is reported.
	it("review 3, finding 6: same-sourceHash digests are resolved deterministically and reported", () => {
		const alpha = docTerm("Alpha", 1, "core");
		const beta = docTerm("Beta", 2, "core");
		const partialRun = source("same", [alpha], { failed: 1 });
		const retried = source("same", [alpha, beta]);
		for (const order of [[partialRun, retried], [retried, partialRun]]) {
			const g = mergeGlossary(order);
			assert.deepEqual(ids(g), ["t_Alpha", "t_Beta"]);
			assert.deepEqual(g.conflicts, [{ sourceHash: "same", copies: 2, decidedBy: "fewer_failed_parts" }]);
		}
		const older = source("same", [alpha, beta], { indexerVersion: MATERIAL_INDEXER_VERSION - 1 });
		const newer = source("same", [alpha]);
		for (const order of [[older, newer], [newer, older]]) {
			assert.deepEqual(ids(mergeGlossary(order)), ["t_Alpha"]);
			assert.equal(mergeGlossary(order).conflicts[0]!.decidedBy, "newer_indexer");
		}
		for (const order of [[newer, retried], [retried, newer]]) assert.equal(mergeGlossary(order).conflicts[0]!.decidedBy, "larger");
		const twin = source("same", [docTerm("Gamma", 1, "core")]);
		for (const order of [[newer, twin], [twin, newer]]) {
			assert.deepEqual(mergeGlossary(order), mergeGlossary([newer, twin]));
			assert.equal(mergeGlossary(order).conflicts[0]!.decidedBy, "content_order");
		}
		// identical copies are one, with no conflict and one citation
		const copy = JSON.parse(JSON.stringify(retried)) as GlossarySource;
		const g = mergeGlossary([retried, source("other", [alpha]), copy]);
		assert.deepEqual(g.conflicts, []);
		assert.deepEqual(g.terms["t_Alpha"]!.citations.map((c) => c.sourceHash), ["other", "same"]);
	});

	// Review 3, finding 7, across documents: A's supporting gloss (page 1) with an undefined core occurrence (page 5)
	// beat B's formal core definition (page 8).
	it("review 3, finding 7: across documents a core definition beats a supporting gloss, whatever the document's overall tier", () => {
		const a = source("a", mergeTerms([[modelTerm("Entropy", 1, "supporting", "Informal gloss.")], [modelTerm("Entropy", 5, "core", null)]]));
		const b = source("b", [docTerm("Entropy", 8, "core", { definition: "S = k ln W." })]);
		for (const order of [[a, b], [b, a]]) {
			const entry = mergeGlossary(order).terms["t_Entropy"]!;
			assert.deepEqual([entry.definition, entry.definitionTier, entry.definitionSource], ["S = k ln W.", "core", "b"]);
		}
		// with two core definitions the smaller sourceHash supplies it
		const c = source("c", [docTerm("Entropy", 2, "core", { definition: "Fra c." })]);
		assert.equal(mergeGlossary([c, b]).terms["t_Entropy"]!.definition, "S = k ln W.");
	});

	it("lookup searches names, aliases and symbols by relaxed key, returns one entry only when unambiguous, and never reads text as an id", () => {
		const g = mergeGlossary([source("a", [docTerm("Egenverdi", 4, "core", { aliases: ["Eigen value"], symbols: ["λ"] }), docTerm("Den deriverte", 1, "core", { symbols: ["f'(x)"] }), docTerm("t_c", 1, "core"), docTerm("c", 2, "core")])]);
		assert.equal(findTerm(g, "egenverdi")?.id, "t_Egenverdi");
		assert.equal(findTerm(g, "  EGENVERDI ")?.id, "t_Egenverdi");
		assert.equal(findTerm(g, "λ")?.id, "t_Egenverdi");
		assert.equal(findTerm(g, "eigen-value")?.id, "t_Egenverdi");
		assert.equal(findTerm(g, "F'(X)")?.id, "t_Den_deriverte");
		assert.equal(findTerm(g, "f′(x)"), undefined, "a prime is not an apostrophe, also for lookup");
		assert.equal(findTerm(g, "t_Egenverdi"), undefined, "plain text is never an id");
		assert.equal(findTermById(g, "t_Egenverdi")?.term, "Egenverdi");
		assert.equal(findTermById(g, "Egenverdi"), undefined);
		// review 2, finding 3: the t_ prefix never shadows a literal name
		assert.equal(findTerm(g, "t_c")?.term, "t_c");
		assert.equal(findTerm(g, "c")?.term, "c");
		assert.equal(findTermById(g, "t_c")?.term, "c");
		assert.equal(findTermById(g, termId("t_c"))?.term, "t_c");
		for (const text of ["", "integral", "constructor", "__proto__", "toString"]) assert.equal(findTerm(g, text), undefined, text);
		const revived = JSON.parse(JSON.stringify(g)) as typeof g;
		assert.equal(findTerm(revived, "λ")?.id, "t_Egenverdi");
		const proto = mergeGlossary([source("a", [docTerm("constructor", 1, "core", { aliases: ["__proto__"] })])]);
		const back = JSON.parse(JSON.stringify(proto)) as typeof proto;
		assert.equal(findTerm(back, "__proto__")?.term, "constructor");
		assert.equal(findTermById(back, "__proto__"), undefined);
		// review 2, finding 3: an own name that other entries carry as an alias is ambiguous
		const own = mergeGlossary([source("a", [docTerm("v", 1, "core"), docTerm("velocity", 1, "core", { aliases: ["v"] }), docTerm("voltage", 1, "core", { aliases: ["v"] })])]);
		assert.equal(findTerm(own, "v"), undefined);
		assert.deepEqual(findTermCandidates(own, "v").map((c) => c.entry.id), ["t_v", "t_velocity", "t_voltage"]);
		assert.equal(relaxedKey("COVID-19"), relaxedKey("covid 19"));
		assert.notEqual(relaxedKey("C++"), relaxedKey("C"));
	});

	// Review 4, concerns: "Ohm's law" / "Ohm’s law" and "resistor" / "resistors" were not suggested; OLS and ols beside
	// "ordinary least squares" (alias OLS) gave three overlapping pairs instead of one group.
	it("review 5, finding 5: an acronym is not suggested as the singular of a lower-case plural", () => {
		const g = mergeGlossary([
			source("networks", [docTerm("CAS", 1, "core"), docTerm("cases", 2, "supporting"), docTerm("BIT", 3, "core"), docTerm("bits", 3, "core"), docTerm("GBP", 4, "supporting"), docTerm("Gbps", 4, "supporting")]),
			source("control", [docTerm("case", 1, "supporting")]),
		]);
		assert.deepEqual(g.suggestedDuplicates.filter((d) => d.reasons.includes("plural")).map((d) => d.ids), [["t_case", "t_cases"]]);
		for (const d of g.suggestedDuplicates) for (const acronym of ["t_CAS", "t_BIT", "t_GBP"]) assert.ok(!d.ids.includes(acronym), `${acronym} is in no group`);
	});

	it("review 4: typographic apostrophes share a relaxed key, simple plurals are suggested, and overlapping pairs form one group", () => {
		const rsquo = String.fromCharCode(0x2019);
		const ldquo = String.fromCharCode(0x201c);
		const rdquo = String.fromCharCode(0x201d);
		const prime = String.fromCharCode(0x2032);
		assert.equal(relaxedKey(`Ohm${rsquo}s law`), relaxedKey("Ohm's law"));
		assert.equal(relaxedKey(`${ldquo}big O${rdquo}`), relaxedKey('"big O"'));
		assert.notEqual(relaxedKey(`f${prime}(x)`), relaxedKey("f'(x)"), "a prime is not an apostrophe");
		assert.notEqual(termId(`Ohm${rsquo}s law`), termId("Ohm's law"), "identity is unchanged");

		const g = mergeGlossary([
			source("circuits-1", [docTerm("Ohm's law", 1, "core"), docTerm("resistor", 2, "core"), docTerm("matrix", 3, "core"), docTerm("bus", 3, "supporting"), docTerm("probability", 3, "core")]),
			source("circuits-2", [docTerm(`Ohm${rsquo}s law`, 1, "core"), docTerm("resistors", 4, "supporting"), docTerm("matrices", 5, "core"), docTerm("buses", 5, "supporting"), docTerm("probabilities", 6, "core")]),
			source("geometry", [docTerm("vertex", 1, "core"), docTerm("vertices", 2, "core"), docTerm("switch", 3, "core"), docTerm("switches", 4, "core")]),
		]);
		assert.equal(ids(g).length, 14, "nothing merged");
		assert.deepEqual(g.suggestedDuplicates, [
			{ ids: ["t_Ohm~27~s_law", `t_Ohm${rsquo}s_law`], reasons: ["similar_name"] },
			{ ids: ["t_bus", "t_buses"], reasons: ["plural"] },
			{ ids: ["t_matrices", "t_matrix"], reasons: ["plural"] },
			{ ids: ["t_probabilities", "t_probability"], reasons: ["plural"] },
			{ ids: ["t_resistor", "t_resistors"], reasons: ["plural"] },
			{ ids: ["t_switch", "t_switches"], reasons: ["plural"] },
			{ ids: ["t_vertex", "t_vertices"], reasons: ["plural"] },
		]);
		// lookup finds both spellings of the apostrophe, and answers neither alone
		assert.deepEqual(findTermCandidates(g, `ohm${rsquo}s law`).map((c) => c.entry.id), ["t_Ohm~27~s_law", `t_Ohm${rsquo}s_law`]);
		assert.equal(findTerm(g, "Ohm's law"), undefined);

		// conservative: acronyms, -ss, -us, -is, short stems and the uncovered plurals are not suggested
		const quiet = mergeGlossary([
			source("q", [
				docTerm("CMOS", 1, "core"), docTerm("CMO", 1, "core"), docTerm("class", 1, "core"), docTerm("clas", 1, "core"), docTerm("status", 1, "core"), docTerm("statu", 1, "core"),
				docTerm("analysis", 1, "core"), docTerm("analyses", 1, "core"), docTerm("Cs", 1, "core"), docTerm("C", 1, "core"), docTerm("leaf", 1, "core"), docTerm("leaves", 1, "core"),
				docTerm("criterion", 1, "core"), docTerm("criteria", 1, "core"), docTerm("bas", 1, "core"), docTerm("ba", 1, "core"),
			]),
		]);
		assert.deepEqual(quiet.suggestedDuplicates, []);
		assert.deepEqual(pluralSingulars("resistors"), ["resistor"]);
		assert.ok(pluralSingulars("matrices").includes("matrix") && pluralSingulars("vertices").includes("vertex"));
		assert.deepEqual(pluralSingulars("GPUs"), [], "an upper-case letter before the ending: not read as a plural");
		assert.deepEqual(pluralSingulars("low-pass filters"), ["lowpassfilter"]);

		// overlapping pairs: one group per connected set, with every reason
		const ols = mergeGlossary([source("s", [docTerm("ordinary least squares", 1, "core", { aliases: ["OLS"] }), docTerm("OLS", 2, "core"), docTerm("ols", 3, "supporting")])]);
		assert.deepEqual(ols.suggestedDuplicates, [{ ids: ["t_OLS", "t_ols", "t_ordinary_least_squares"], reasons: ["alias", "similar_name"] }]);
		const chain = mergeGlossary([source("c", [docTerm("resistor", 1, "core"), docTerm("Resistors", 2, "core"), docTerm("resistors", 3, "core"), docTerm("capacitor", 4, "core")])]);
		assert.deepEqual(chain.suggestedDuplicates, [{ ids: ["t_Resistors", "t_resistor", "t_resistors"], reasons: ["plural", "similar_name"] }]);
		for (const g2 of [g, quiet, ols, chain]) {
			const seen = g2.suggestedDuplicates.flatMap((x) => x.ids);
			assert.equal(new Set(seen).size, seen.length, "no entry is in two groups");
		}
	});

	// Review 4, concerns: resolveSources serialised every digest with stableJson, even when its sourceHash appeared once.
	it("review 4: a sourceHash that appears once is never serialised; two copies still are compared", () => {
		let reads = 0;
		const probed = (hash: string): GlossarySource => {
			const t = docTerm("Alpha", 1, "core") as DigestTerm & { probe?: number };
			Object.defineProperty(t, "probe", { enumerable: true, get: () => ++reads });
			return source(hash, [t]);
		};
		const single = mergeGlossary([probed("a"), probed("b"), source("c", [docTerm("Beta", 1, "core")])]);
		assert.equal(reads, 0, "no serialisation for single sources");
		assert.equal(single.terms["t_Alpha"]!.citations.length, 2);
		mergeGlossary([probed("same"), probed("same")]);
		assert.ok(reads > 0, "copies of one source are still compared by content");
	});

	it("a digest term without a visible name is refused, not dropped", () => {
		const bad = { ...docTerm("x", 1, "core"), term: "\u200B" };
		assert.throws(() => mergeGlossary([source("d", [bad])]), /without a name/);
	});
});

describe("the large document and the profile request", () => {
	// Review 3, finding 3: 5,000 pages with 30 distinct terms per page gave 150,000 terms and renderNotes threw
	// "Maximum call stack size exceeded" before the reduce call, losing every extraction.
	it("review 3, finding 3: a 150,000-term document indexes, and its reduce request is built and bounded", async () => {
		const pages: string[] = [];
		for (let n = 1; n <= 5_000; n++) pages.push(`--- Page ${n} ---\n${"Teksten forklarer begrepene på siden grundig. ".repeat(22)}`);
		const doc = pages.join("\n");
		const model = fakeModel((call) => {
			if (isReduce(call)) return PROFILE;
			const onPages = requestPages(call.user);
			return JSON.stringify({ summaryBullets: ["x"], terms: onPages.flatMap((p) => Array.from({ length: 30 }, (_, k) => modelTerm(`Begrep ${p}.${k}`, p, k < 3 ? "core" : "supporting", null))), concepts: [], figures: [] });
		});
		const started = performance.now();
		const digest = await digestMaterial(doc, { ...META, complete: model.complete });
		const ms = performance.now() - started;
		assert.equal(digest.terms.length, 150_000);
		assert.deepEqual(failedBatchesOf(digest), []);
		assert.equal(digest.profile, PROFILE, "the reduce call was made");
		const reduce = model.calls.filter(isReduce);
		assert.equal(reduce.length, 1);
		assert.ok(reduce[0]!.user.length <= REDUCE_REQUEST_MAX_CHARS);
		assert.ok(ms < 60_000, `took ${Math.round(ms)} ms`);
		assert.ok(parseStoredDigest(JSON.stringify(digest)).ok);
	});

	it("review 3, finding 3: a failure while building the profile request is a profileError, never a lost index", async () => {
		const doc = slideDeck(40, 1_500);
		const digest = await digestMaterial(doc, { ...META, complete: fakeModel((call) => (isReduce(call) ? PROFILE : notesFor(call.user))).complete });
		// a stored record that cannot be rendered (a hand-edited batch): rewriteProfile reports it, keeps the index
		const broken = { ...digest, profile: null, profileError: "x", batches: digest.batches.map((b, i) => (i === 0 ? { ...b, summaryBullets: null } : b)) } as unknown as MaterialDigest;
		const idle = fakeModel(() => PROFILE);
		const result = await rewriteProfile(broken, { complete: idle.complete });
		assert.equal(idle.calls.length, 0);
		assert.match(result.error!, /the profile request could not be built/);
		assert.equal(result.digest.terms, broken.terms);
	});
});

describe("stored digests: the validated read boundary, rewrite and re-run", () => {
	const build = async () => {
		const doc = `# Kapittel 1\n\n${slideDeck(40, 1_500)}`;
		const plan = splitMaterial(doc, SMALL);
		const failing = plan[2]!;
		const model = fakeModel((call) => (isReduce(call) ? "no profile" : materialOf(call.user) === failing.text ? "nope" : notesFor(call.user)));
		const digest = await digestMaterial(doc, { ...META, complete: model.complete, split: SMALL, name: "Forelesning 3" });
		return { doc, plan, failing, model, digest, text: JSON.stringify(digest, null, "\t") };
	};

	it("review 2 contract and review 3, finding 9: the reduce request is rebuilt exactly from the stored digest alone, its name included", async () => {
		const { model, text, plan, failing, doc } = await build();
		const parsed = parseStoredDigest(text);
		assert.ok(parsed.ok);
		const stored = (parsed as { digest: MaterialDigest }).digest;
		assert.equal(stored.name, "Forelesning 3");
		const reduceCalls = model.calls.filter(isReduce);
		assert.deepEqual(buildReduceRequest(stored), { system: reduceCalls[0]!.system, user: reduceCalls[0]!.user }, "no name supplied by the caller");
		for (const [i, b] of stored.batches.entries()) {
			assert.deepEqual(b.pages, plan[i]!.pages);
			assert.deepEqual(batchFromRef(doc, b), plan[i]);
		}
		assert.deepEqual(batchFromRef(doc, failedBatchesOf(stored)[0]!), failing);
		assert.throws(() => batchFromRef(doc.slice(0, 10), failedBatchesOf(stored)[0]!), RangeError);
	});

	it("rewriteProfile runs only the profile; a failure keeps an existing valid profile and reports the failure separately", async () => {
		const { model, digest } = await build();
		const stored = (parseStoredDigest(JSON.stringify(digest)) as { digest: MaterialDigest }).digest;
		const again = fakeModel((call) => (isReduce(call) ? PROFILE : "an extraction call"));
		const progress: DigestProgress[] = [];
		const rewritten = await rewriteProfile(stored, { complete: again.complete, onProgress: (p) => progress.push(p) });
		assert.equal(again.calls.length, 1);
		assert.equal(again.calls[0]!.user, model.calls.filter(isReduce)[0]!.user);
		assert.deepEqual(progress, [{ stage: "profile" }]);
		assert.equal(rewritten.error, null);
		assert.equal(rewritten.digest.profile, PROFILE);
		assert.ok(!("profileError" in rewritten.digest));
		const { profile: _a, profileError: _b, ...kept } = stored;
		const { profile: _c, ...keptAfter } = rewritten.digest;
		assert.deepEqual(keptAfter, kept);

		// review 3, concern: a failed rewrite of a valid profile returned profile: null
		const failedAgain = await rewriteProfile(rewritten.digest, { complete: fakeModel(() => "still no").complete });
		assert.equal(failedAgain.digest.profile, PROFILE, "the previous profile is kept");
		assert.match(failedAgain.error!, /the profile could not be written/);
		assert.deepEqual(failedAgain.digest, rewritten.digest);
		// without a previous profile the failure is the new profileError
		const noProfile = await rewriteProfile(stored, { complete: fakeModel(() => "still no").complete });
		assert.equal(noProfile.digest.profile, null);
		assert.match(noProfile.digest.profileError!, /the profile could not be written/);
		const nothing = await digestMaterial(slideDeck(40, 1_500), { ...META, complete: fakeModel(() => "no").complete });
		const idle = fakeModel(() => PROFILE);
		assert.equal(buildReduceRequest(nothing), null);
		assert.match((await rewriteProfile(nothing, { complete: idle.complete })).error!, /no part of the material could be indexed/);
		assert.equal(idle.calls.length, 0);
		const aborted = new AbortController();
		aborted.abort();
		await assert.rejects(rewriteProfile(stored, { complete: idle.complete, signal: aborted.signal }), { name: "AbortError" });
	});

	it("review 2, concern 2: no progress report once an abort is requested", async () => {
		const pre = new AbortController();
		pre.abort();
		const seen: DigestProgress[] = [];
		const unused = fakeModel(() => "no");
		await assert.rejects(digestMaterial(slideDeck(40, 1_500), { ...META, complete: unused.complete, signal: pre.signal, onProgress: (p) => seen.push(p) }), { name: "AbortError" });
		assert.equal(seen.length, 0);
		const during = new AbortController();
		const aborting = fakeModel((call) => {
			during.abort();
			return notesFor(call.user);
		});
		await assert.rejects(digestMaterial(slideDeck(40, 1_500), { ...META, complete: aborting.complete, signal: during.signal, onProgress: (p) => seen.push(p) }), { name: "AbortError" });
		assert.equal(seen.length, 1, "only the report before the first call");
	});

	// Review 3, concerns: buildReduceRequest on old records threw a raw TypeError; a hand-edited record missing
	// summaryBullets likewise; batchFromRef accepted offsets 0.75 and 2.99; failedBatches could diverge from batches.
	it("review 3, concerns: old-version, truncated and hand-edited files are refused with a reason; failedBatches is derived", async () => {
		const { text, digest } = await build();
		const value = () => JSON.parse(text) as Record<string, unknown> & MaterialDigest;
		const reason = (input: unknown) => {
			const parsed = parseStoredDigest(input);
			assert.equal(parsed.ok, false, JSON.stringify(input).slice(0, 80));
			return (parsed as { problem: { kind: string; reason: string } }).problem;
		};
		assert.deepEqual(reason({ ...value(), version: 3 }).kind, "version");
		assert.match(reason({ ...value(), version: 3 }).reason, /digest version 3, this indexer writes 4/);
		assert.equal(reason(text.slice(0, text.length - 40)).kind, "invalid", "truncated");
		assert.match(reason(text.slice(0, text.length - 40)).reason, /not JSON/);
		const edits: [string, (d: MaterialDigest & Record<string, unknown>) => void, RegExp][] = [
			["fractional offsets", (d) => Object.assign(d.batches[1]!, { charStart: 0.75 }), /offsets that are not integers/],
			["a gap in the tiling", (d) => Object.assign(d.batches[1]!, { charStart: d.batches[1]!.charStart + 1 }), /does not continue the tiling/],
			["missing summaryBullets", (d) => delete (d.batches[0] as Partial<{ summaryBullets: unknown }>).summaryBullets, /no summary bullets/],
			["a renamed term", (d) => Object.assign(d.terms[0]!, { term: "Noe annet" }), /not the id of its name/],
			["an edited definition", (d) => Object.assign(d.terms[0]!, { definition: "Endret." }), /definition is not what its occurrences give/],
			["an occurrence on the failed part", (d) => Object.assign(d.terms[0]!.occurrences[0]!, { part: failedBatchesOf(digest)[0]!.index }), /not on a page of an indexed part/],
			["a page outside its part", (d) => Object.assign(d.concepts[0]!, { page: 9_999 }), /concepts\[0\] is not on a page/],
			["an unknown status", (d) => Object.assign(d.batches[0]!, { status: "done" }), /status "done"/],
			["a page set out of order", (d) => Object.assign(d.batches[0]!, { pages: [...d.batches[0]!.pages].reverse() }), /not ascending/],
			["a count below the list", (d) => Object.assign(d.terms[0]!, { occurrenceCount: 0 }), /occurrence count below its list/],
			["an unnormalised name", (d) => Object.assign(d.terms[0]!, { term: ` ${d.terms[0]!.term}` }), /not the id of its name/],
		];
		for (const [what, edit, expected] of edits) {
			const d = value();
			edit(d);
			const problem = reason(d);
			assert.equal(problem.kind, "invalid", what);
			assert.match(problem.reason, expected, what);
		}
		// a stale failedBatches field (an older writer, a hand edit) is never trusted: it is dropped and derived
		const stale = { ...value(), failedBatches: [] };
		const parsed = parseStoredDigest(stale);
		assert.ok(parsed.ok);
		assert.ok(!("failedBatches" in (parsed as { digest: object }).digest));
		assert.equal(failedBatchesOf((parsed as { digest: MaterialDigest }).digest).length, 1);
		assert.throws(() => batchFromRef("x".repeat(10_000), { ...digest.batches[0]!, charEnd: 2.99 }), RangeError);
	});

	// Review 4, finding 3: the reader accepted "profile": "", an invisible or heading-less profile, blank or invisible
	// text fields, unnormalised or blank aliases and symbols, a pageCount below a part's pages, an empty sourceHash, a
	// negative indexerVersion, and kept every extra key but failedBatches.
	it("review 4, finding 3: the reader enforces every invariant the writer enforces and returns only contract fields", async () => {
		const { text } = await build();
		const value = () => JSON.parse(text) as Record<string, unknown> & MaterialDigest;
		const withProfile = (d: Record<string, unknown>, profile: unknown) => {
			d.profile = profile;
			delete d.profileError;
		};
		const firstDefined = (d: MaterialDigest) => d.terms.find((t) => t.definition !== null)!;
		const zw = String.fromCharCode(0x200b); // zero-width space
		const isolate = String.fromCharCode(0x2066); // left-to-right isolate
		const edits: [string, (d: MaterialDigest & Record<string, unknown>) => void, RegExp][] = [
			['"profile": ""', (d) => withProfile(d, ""), /"profile" is not a valid profile/],
			["an invisible profile", (d) => withProfile(d, ` ${zw}${isolate} `), /"profile" is not a valid profile/],
			["a profile without headings", (d) => withProfile(d, "Just some text about the material (p. 1)."), /"profile" is not a valid profile/],
			["a profile with only empty sections", (d) => withProfile(d, `## Contents\n${zw}`), /"profile" is not a valid profile/],
			["a profile not in its validated form", (d) => withProfile(d, `Preamble.\n\n${PROFILE}`), /validated form/],
			["a null profile with a blank error", (d) => Object.assign(d, { profile: null, profileError: "  " }), /without a "profileError"/],
			["a blank summary bullet", (d) => Object.assign(d.batches[0]!, { summaryBullets: ["   "] }), /blank or untrimmed summary bullet/],
			["an invisible summary bullet", (d) => Object.assign(d.batches[0]!, { summaryBullets: [zw] }), /blank or untrimmed summary bullet/],
			["an invisible definition", (d) => {
				const t = firstDefined(d);
				t.occurrences[0]!.definition = zw;
				t.definition = zw;
			}, /inconsistent or blank definition/],
			["an invisible statement", (d) => Object.assign(d.concepts[0]!, { statement: `${zw} ` }), /blank or untrimmed statement/],
			["a blank caption", (d) => Object.assign(d.figures[0]!, { caption: " " }), /blank or untrimmed caption/],
			["an unnormalised alias", (d) => Object.assign(d.terms[0]!, { aliases: ["  OLS "] }), /alias or symbol lists/],
			["a blank alias", (d) => Object.assign(d.terms[0]!, { aliases: [""] }), /alias or symbol lists/],
			["an invisible symbol", (d) => Object.assign(d.terms[0]!, { symbols: [zw] }), /alias or symbol lists/],
			["unsorted symbols", (d) => Object.assign(d.terms[0]!, { symbols: ["v", "U"] }), /alias or symbol lists/],
			["a repeated alias", (d) => Object.assign(d.terms[0]!, { aliases: ["A", "A"] }), /alias or symbol lists/],
			["its own name as an alias", (d) => Object.assign(d.terms[0]!, { aliases: [d.terms[0]!.term] }), /own name as an alias/],
			["a pageCount below a part's pages", (d) => Object.assign(d, { pageCount: 1 }), /beyond the "pageCount" 1/],
			["an empty sourceHash", (d) => Object.assign(d, { sourceHash: "" }), /"sourceHash" is not a non-empty string/],
			["an empty converter", (d) => Object.assign(d, { converter: "" }), /"converter" is not a non-empty string/],
			["a negative indexerVersion", (d) => Object.assign(d, { indexerVersion: -1 }), /"indexerVersion" is not a non-negative integer/],
			["a blank name", (d) => Object.assign(d, { name: "   " }), /"name" is not null/],
			["a blank failed-part error", (d) => Object.assign(failedBatchesOf(d)[0]!, { error: "" }), /failed without an error/],
			["a repeated figure", (d) => d.figures.push({ ...d.figures[0]! }), /repeats a page and caption/],
		];
		for (const [what, edit, expected] of edits) {
			const d = value();
			edit(d);
			const parsed = parseStoredDigest(d);
			assert.equal(parsed.ok, false, what);
			const problem = (parsed as { problem: { kind: string; reason: string } }).problem;
			assert.equal(problem.kind, "invalid", what);
			assert.match(problem.reason, expected, what);
		}
		// the returned digest has only the contract's fields, at every level
		const extra = value() as Record<string, any>;
		extra.note = "hand-written";
		extra.failedBatches = [];
		extra.batches[0].debug = true;
		extra.terms[0].debug = true;
		extra.terms[0].occurrences[0].debug = true;
		extra.concepts[0].debug = true;
		extra.figures[0].debug = true;
		const parsed = parseStoredDigest(extra);
		assert.ok(parsed.ok);
		const digest = (parsed as { digest: MaterialDigest }).digest;
		assert.deepEqual(digest, parseStoredDigest(text).ok ? (parseStoredDigest(text) as { digest: MaterialDigest }).digest : null);
		const keys = (o: object) => Object.keys(o).sort();
		assert.deepEqual(keys(digest), ["batches", "concepts", "converter", "converterVersion", "figures", "indexerVersion", "name", "pageCount", "profile", "profileError", "sourceHash", "sourcePageCount", "terms", "version"]);
		assert.ok(!("debug" in digest.batches[0]!) && !("debug" in digest.terms[0]!) && !("debug" in digest.terms[0]!.occurrences[0]!) && !("debug" in digest.concepts[0]!) && !("debug" in digest.figures[0]!));
		// a valid profile is accepted, and hasProfile is the one test of "has a profile"
		const good = value();
		withProfile(good, PROFILE);
		const ok = parseStoredDigest(good);
		assert.ok(ok.ok);
		assert.equal(hasProfile((ok as { digest: MaterialDigest }).digest), true);
		assert.equal(hasProfile(value()), false);
		assert.equal(hasProfile({ profile: "" } as MaterialDigest), false);
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
