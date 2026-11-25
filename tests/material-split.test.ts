/**
 * Splitting a converted document into indexing batches (fork addition, 2026-11-24; core/material-split.ts): the tiling
 * invariant on a slide deck without headings and on a multi-chapter book with an oversized chapter, page and line, both
 * page-marker formats the converters write, and documents without markers. Pure, no model.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_BATCH_TOKENS, estimateTextTokens, pageCountOf, splitMaterial, type MaterialBatch } from "../src/core/material-split.ts";

/** The batches tile the document exactly: in order, no gap, no overlap, each text its own slice. */
function assertTiles(doc: string, batches: readonly MaterialBatch[]): void {
	assert.ok(batches.length > 0);
	let at = 0;
	batches.forEach((b, i) => {
		assert.equal(b.index, i);
		assert.equal(b.charStart, at, `batch ${i} starts where the previous ended`);
		assert.ok(b.charEnd > b.charStart, `batch ${i} is not empty`);
		assert.equal(b.text, doc.slice(b.charStart, b.charEnd));
		assert.ok(b.pageStart <= b.pageEnd);
		at = b.charEnd;
	});
	assert.equal(at, doc.length, "the last batch ends at the document's end");
	assert.equal(batches.map((b) => b.text).join(""), doc);
}

/** A sentence-ish filler of about `chars` characters. */
function prose(seed: string, chars: number): string {
	const sentence = `${seed} handles the data in a careful and well-defined way. `;
	return sentence.repeat(Math.ceil(chars / sentence.length)).slice(0, chars).trim();
}

/** A slide deck as pdf-markdown joinPages writes it: no headings, a blank line after each marker and between pages. */
function slideDeck(pages: number, charsPerPage: number): string {
	const out: string[] = [];
	for (let n = 1; n <= pages; n++) out.push(`--- Page ${n} ---\n\nSlide ${n}\n\n${prose(`Slide ${n}`, charsPerPage)}`);
	return out.join("\n\n");
}

describe("splitMaterial", () => {
	it("a slide deck with no headings tiles exactly, cut only at page markers, within the budget", () => {
		const doc = slideDeck(40, 1_500);
		const batches = splitMaterial(doc);
		assertTiles(doc, batches);
		assert.ok(batches.length >= 2, `40 pages of 1,500 chars pass one ${DEFAULT_BATCH_TOKENS}-token budget`);
		for (const b of batches) {
			assert.ok(estimateTextTokens(b.text) <= DEFAULT_BATCH_TOKENS);
			assert.match(b.text, /^--- Page \d+ ---\n/, "every batch starts at a page marker");
			assert.deepEqual(b.headingPath, []);
			assert.equal(b.pageStart, Number(/^--- Page (\d+)/.exec(b.text)![1]));
		}
		assert.equal(batches[0]!.pageStart, 1);
		assert.equal(batches.at(-1)!.pageEnd, 40);
		// consecutive batches: the next one starts on the page after the previous one ends
		for (let i = 1; i < batches.length; i++) assert.equal(batches[i]!.pageStart, batches[i - 1]!.pageEnd + 1);
		assert.equal(pageCountOf(doc), 40);
	});

	it("a short slide deck is one batch", () => {
		const doc = slideDeck(12, 300);
		const batches = splitMaterial(doc);
		assertTiles(doc, batches);
		assert.equal(batches.length, 1);
		assert.equal(batches[0]!.pageStart, 1);
		assert.equal(batches[0]!.pageEnd, 12);
	});

	it("a multi-chapter book with one oversized chapter tiles exactly; the big chapter splits at pages, then paragraphs, then lines", () => {
		// pdf-ops pdfExtract format: one newline after each marker, pages joined by one newline
		const budgetTokens = 1_000; // 4,000 characters
		const pages: string[] = [];
		let n = 0;
		const page = (body: string) => pages.push(`--- Page ${++n} ---\n${body}`);
		page(`# Kapittel 1: Mengder\n\n${prose("Mengder", 1_200)}`);
		page(prose("Delmengder", 900));
		page(`# Kapittel 2: Funksjoner\n\n## 2.1 Definisjon\n\n${prose("Funksjoner", 3_000)}`);
		page(prose("Injektive", 3_500));
		// a page over the budget on its own: several paragraphs
		page([prose("Surjektive", 1_800), prose("Bijektive", 1_800), prose("Inverse", 1_800)].join("\n\n"));
		// a page whose single paragraph is over the budget: lines
		page([prose("Linje en", 2_500), prose("Linje to", 2_500)].join("\n"));
		// a single line over the budget: cut at characters
		page(prose("Uendelig", 9_000));
		page(`## 2.2 Sammensetning\n\n${prose("Sammensetning", 1_000)}`);
		page(`# Kapittel 3: Relasjoner\n\n${prose("Relasjoner", 1_500)}`);
		const doc = `${pages.join("\n")}\n`;

		const batches = splitMaterial(doc, { budgetTokens });
		assertTiles(doc, batches);
		for (const b of batches) assert.ok(estimateTextTokens(b.text) <= budgetTokens, `batch ${b.index} (${b.text.length} chars) fits`);

		// chapter 1 (two pages) fits whole and ends before chapter 2's page marker
		assert.deepEqual(batches[0]!.headingPath, ["Kapittel 1: Mengder"]);
		assert.equal(batches[0]!.pageStart, 1);
		assert.equal(batches[0]!.pageEnd, 2);
		const chapter2 = batches.find((b) => b.text.includes("# Kapittel 2"))!;
		assert.match(chapter2.text, /^--- Page 3 ---\n# Kapittel 2/, "a heading opening its page takes the marker with it");
		assert.deepEqual(chapter2.headingPath, ["Kapittel 2: Funksjoner"]);
		assert.equal(chapter2.pageStart, 3);

		// the oversized chapter is in several batches, later ones inside its sections
		const inside = batches.filter((b) => b.headingPath[0] === "Kapittel 2: Funksjoner");
		assert.ok(inside.length >= 5, `chapter 2 spans ${inside.length} batches`);
		assert.ok(inside.some((b) => b.headingPath.join(" > ") === "Kapittel 2: Funksjoner > 2.1 Definisjon"));
		// the paragraph-split page: a batch starts at a paragraph, mid-page, on page 5
		assert.ok(batches.some((b) => b.pageStart === 5 && /^(Bijektive|Inverse)/.test(b.text)));
		// a page marker always starts the text that follows it: no batch ends on a bare marker line
		for (const b of batches) assert.doesNotMatch(b.text, /--- Page \d+ ---[ \t]*\n?\s*$/);
		// the line-split page 6 starts inside a batch with its marker and first line together
		assert.ok(batches.some((b) => /--- Page 6 ---\nLinje en/.test(b.text)));
		// the hard-cut line (9,000 chars on one line, page 7): full-budget pieces, its rest packed with what follows
		const page7 = batches.filter((b) => b.pageStart === 7);
		assert.ok(page7.length >= 3);
		assert.ok(page7.slice(0, -1).every((b) => b.pageEnd === 7 && b.text.length === 4_000));

		// the small sections after it (2.2, chapter 3) are whole and packed into the last batch
		const last = batches.at(-1)!;
		assert.match(last.text, /--- Page 8 ---\n## 2\.2 Sammensetning[\s\S]*--- Page 9 ---\n# Kapittel 3: Relasjoner/);
		assert.equal(last.pageEnd, 9);
		assert.equal(pageCountOf(doc), 9);
	});

	it("small sections are packed together up to the budget", () => {
		const sections = Array.from({ length: 10 }, (_, i) => `# Section ${i + 1}\n\n${prose(`Section ${i + 1}`, 700)}\n`);
		const doc = sections.join("\n");
		const batches = splitMaterial(doc, { budgetTokens: 500 });
		assertTiles(doc, batches);
		assert.ok(batches.length < sections.length, "sections share batches");
		for (const b of batches) assert.match(b.text, /^# Section \d+/, "sections that fit are never cut");
	});

	it("text without page markers is page 1; a heading in a code fence is not a heading", () => {
		const doc = "Intro text.\n\n```md\n# not a heading\n```\n\n# Real heading\n\nBody.\n";
		const batches = splitMaterial(doc, { budgetTokens: 5 });
		assertTiles(doc, batches);
		for (const b of batches) {
			assert.equal(b.pageStart, 1);
			assert.equal(b.pageEnd, 1);
			assert.ok(!b.headingPath.includes("not a heading"));
		}
		assert.ok(batches.some((b) => b.headingPath[0] === "Real heading"));
		assert.equal(pageCountOf(doc), 1);
	});

	it("text before the first marker belongs to the first marker's page; skipped page numbers are kept", () => {
		const doc = "Preamble\n\n--- Page 2 ---\n\nTwo\n\n--- Page 5 ---\n\nFive\n";
		const batches = splitMaterial(doc, { budgetTokens: 4 });
		assertTiles(doc, batches);
		assert.equal(batches[0]!.pageStart, 2);
		assert.equal(batches.at(-1)!.pageEnd, 5);
		assert.equal(pageCountOf(doc), 5);
	});

	it("an injected estimator sets the cuts; an empty document has no batches; surrogate pairs are never cut", () => {
		const doc = slideDeck(6, 100);
		const perPage = splitMaterial(doc, { budgetTokens: 1, estimateTokens: (t) => (t.match(/--- Page/g)?.length ?? 0) });
		assertTiles(doc, perPage);
		assert.equal(perPage.length, 6);
		assert.deepEqual(splitMaterial(""), []);
		const emoji = "🙂".repeat(50);
		const cut = splitMaterial(emoji, { budgetTokens: 3 });
		assertTiles(emoji, cut);
		for (const b of cut) assert.ok(!/[\ud800-\udbff]$/.test(b.text), "no batch ends inside a surrogate pair");
	});

	it("CRLF documents tile and find their markers and headings", () => {
		const doc = "--- Page 1 ---\r\n\r\n# Tittel\r\n\r\nTekst.\r\n\r\n--- Page 2 ---\r\n\r\nMer.\r\n";
		const batches = splitMaterial(doc, { budgetTokens: 8 });
		assert.ok(batches.length > 1);
		assertTiles(doc, batches);
		assert.equal(pageCountOf(doc), 2);
		assert.equal(batches[0]!.headingPath[0], "Tittel");
		assert.equal(batches.at(-1)!.pageEnd, 2);
	});
});
