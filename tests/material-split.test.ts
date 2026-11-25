/**
 * Splitting a converted document into indexing batches (fork addition, 2026-11-24; core/material-split.ts): the tiling
 * invariant on a slide deck without headings and on a multi-chapter book with an oversized chapter, page and line, both
 * page-marker formats the converters write, and documents without markers. Pure, no model.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_BATCH_TOKENS,
	escapePageMarkerLines,
	estimateTextTokens,
	formatPageMarker,
	PAGE_MARKER_PATTERN,
	pageCountOf,
	splitMaterial,
	unescapePageMarkerLines,
	type MaterialBatch,
} from "../src/core/material-split.ts";

/** The batches tile the document exactly: in order, no gap, no overlap, each text its own slice. */
function assertTiles(doc: string, batches: readonly MaterialBatch[]): void {
	assert.ok(batches.length > 0);
	let at = 0;
	batches.forEach((b, i) => {
		assert.equal(b.index, i);
		assert.equal(b.charStart, at, `batch ${i} starts where the previous ended`);
		assert.ok(b.charEnd > b.charStart, `batch ${i} is not empty`);
		assert.equal(b.text, doc.slice(b.charStart, b.charEnd));
		// pageEnd < pageStart only when markers run backwards; the page list always holds both
		assert.ok(b.pages.includes(b.pageStart) && b.pages.includes(b.pageEnd));
		assert.deepEqual(b.pages, [...new Set(b.pages)].sort((x, y) => x - y));
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

	// Review 1, defect 8: a fenced example of a page marker and a heading gave pageCount 99, a fake section and a missed
	// real heading. Changed for the new contract (manager's ruling after review 2): the host escapes a marker-like line in
	// a page's text, so the example arrives as "\--- Page 99 ---"; an unescaped marker line is always a page boundary.
	it("an escaped marker and a heading inside a fenced code block are content, for pages, counting, cuts and heading paths", () => {
		const doc = `--- Page 1 ---\n\n# Intro\n\nText.\n\n${escapePageMarkerLines("```md\n--- Page 99 ---\n# Fake\n```")}\n\n# Real\n\nBody after the fence.\n`;
		assert.match(doc, /^\\--- Page 99 ---$/m);
		assert.equal(pageCountOf(doc), 1);
		for (const budgetTokens of [3, 5, 8, 12, 1_000]) {
			const batches = splitMaterial(doc, { budgetTokens });
			assertTiles(doc, batches);
			for (const b of batches) {
				assert.deepEqual([b.pageStart, b.pageEnd, b.pages], [1, 1, [1]], `budget ${budgetTokens}`);
				assert.ok(!b.headingPath.includes("Fake"));
			}
			const last = batches.at(-1)!;
			if (budgetTokens < 1_000) assert.deepEqual(last.headingPath, ["Real"], "the real heading after the fence is found");
		}
		// a fenced section is not cut off as a section of its own: with room for the sections, Real starts a batch
		const sections = splitMaterial(doc, { budgetTokens: 12 });
		assert.ok(sections.some((b) => b.text.startsWith("# Real")));
		assert.ok(!sections.some((b) => b.text.startsWith("# Fake")));
		// ~~~ fences too, and a longer closing fence closes a shorter opening one
		const tilde = "--- Page 3 ---\nA\n~~~\n\\--- Page 98 ---\n# Not a heading\n~~~~\n--- Page 4 ---\n# Four\nB\n";
		assert.equal(pageCountOf(tilde), 4);
		const tildeBatches = splitMaterial(tilde, { budgetTokens: 4 });
		assertTiles(tilde, tildeBatches);
		assert.deepEqual([...new Set(tildeBatches.flatMap((b) => b.pages))].sort((a, b) => a - b), [3, 4]);
		assert.ok(!tildeBatches.some((b) => b.headingPath.includes("Not a heading")));
		assert.ok(tildeBatches.some((b) => b.headingPath[0] === "Four"));
	});

	// The new contract: an unescaped marker line inside what looks like an open fence is a real page boundary, and the
	// fence ends there (it was never closed on its page, so it is not a fence).
	it("a marker line is a page boundary even where a fence seems open; a fence never spans pages", () => {
		const doc = "--- Page 1 ---\nIntro\n```md\ncode\n--- Page 2 ---\n# Kapittel 2\nTo\n```\n--- Page 3 ---\nTre\n";
		assert.equal(pageCountOf(doc), 3);
		for (const budgetTokens of [3, 6, 1_000]) {
			const batches = splitMaterial(doc, { budgetTokens });
			assertTiles(doc, batches);
			assert.deepEqual([...new Set(batches.flatMap((b) => b.pages))].sort((a, b) => a - b), [1, 2, 3], `budget ${budgetTokens}`);
			if (budgetTokens < 1_000) assert.ok(batches.some((b) => b.headingPath[0] === "Kapittel 2"), "the heading after the marker is a heading");
		}
	});

	// Review 2, finding 4: an unclosed ```python on page 1 and a real closed block on page 52 swallowed every marker and
	// heading between them (pages [1, 53], headings []).
	it("review 2, finding 4: an unclosed fence on page 1 swallows nothing up to a closed fence 51 pages later", () => {
		const pages: string[] = [];
		for (let n = 1; n <= 53; n++) {
			let body = `# Kapittel ${n}\n\nTekst på side ${n}.`;
			if (n === 1) body += "\n\n```python\nprint('never closed')";
			if (n === 52) body += "\n\n```\nreal = True\n```";
			pages.push(`--- Page ${n} ---\n\n${body}`);
		}
		const doc = pages.join("\n\n");
		assert.equal(pageCountOf(doc), 53);
		const batches = splitMaterial(doc, { budgetTokens: 10 });
		assertTiles(doc, batches);
		assert.deepEqual([...new Set(batches.flatMap((b) => b.pages))].sort((a, b) => a - b), Array.from({ length: 53 }, (_, i) => i + 1));
		const headings = new Set(batches.flatMap((b) => b.headingPath));
		for (let n = 1; n <= 53; n++) assert.ok(headings.has(`Kapittel ${n}`), `Kapittel ${n} is a heading`);
		assert.equal(splitMaterial(doc).length, 1);
		assert.deepEqual(splitMaterial(doc)[0]!.pages.length, 53);
	});

	// Review 2, finding 7: "--- Page 0 ---" gave a batch pages [0], which no citation can satisfy.
	it("review 2, finding 7: page 0 (and a number with leading zeros) is not a marker", () => {
		assert.equal(PAGE_MARKER_PATTERN.test("--- Page 0 ---"), false);
		assert.equal(PAGE_MARKER_PATTERN.test("--- Page 007 ---"), false);
		assert.equal(PAGE_MARKER_PATTERN.test("--- Page 7 ---"), true);
		assert.equal(PAGE_MARKER_PATTERN.test("--- Page 7 --- \r"), true);
		const doc = "--- Page 0 ---\n\nNull\n\n--- Page 1 ---\n\nEn\n";
		const batches = splitMaterial(doc, { budgetTokens: 3 });
		assertTiles(doc, batches);
		for (const b of batches) assert.ok(b.pages.every((p) => p >= 1), `batch ${b.index} pages ${b.pages.join(",")}`);
		assert.equal(pageCountOf("--- Page 0 ---\nNull\n"), 1);
		assert.deepEqual(splitMaterial("--- Page 0 ---\nNull\n")[0]!.pages, [1]);
		assert.throws(() => formatPageMarker(0), RangeError);
		assert.throws(() => formatPageMarker(1.5), RangeError);
		assert.throws(() => formatPageMarker(-3), RangeError);
	});

	// The exported contract the host writes content.md with.
	it("formatPageMarker, PAGE_MARKER_PATTERN and escapePageMarkerLines agree, and the escape round-trips", () => {
		assert.equal(formatPageMarker(12), "--- Page 12 ---");
		assert.equal(PAGE_MARKER_PATTERN.exec(formatPageMarker(12))![1], "12");
		assert.equal(escapePageMarkerLines("--- Page 3 ---"), "\\--- Page 3 ---");
		assert.equal(escapePageMarkerLines("\\--- Page 3 ---"), "\\\\--- Page 3 ---");
		assert.equal(escapePageMarkerLines("--- Page 0 ---\r\nTekst\n  --- Page 3 ---"), "\\--- Page 0 ---\r\nTekst\n  --- Page 3 ---");
		assert.equal(unescapePageMarkerLines("\\--- Page 3 ---\n\\\\--- Page 4 ---\n\\other"), "--- Page 3 ---\n\\--- Page 4 ---\n\\other");
		// a document the host writes: every page's own text escaped, so only the host's markers count
		const pageTexts = ["En\n--- Page 9 ---\n", "--- Page 1 ---", "\\--- Page 2 ---\nTo"];
		const doc = pageTexts.map((t, i) => `${formatPageMarker(i + 1)}\n\n${escapePageMarkerLines(t)}`).join("\n\n");
		assert.equal(pageCountOf(doc), 3);
		assert.deepEqual(splitMaterial(doc)[0]!.pages, [1, 2, 3]);
		const rand = mulberry32(7);
		const lineKinds = ["--- Page 3 ---", "--- Page 0 ---", "\\--- Page 5 ---", "\\\\\\--- Page 12 --- ", "--- Page 4 ---\r", "--- Page x ---", "text", "", "\\", "--- Page 3 --- tail"];
		for (let i = 0; i < 500; i++) {
			const text = Array.from({ length: Math.floor(rand() * 8) }, () => lineKinds[Math.floor(rand() * lineKinds.length)]!).join("\n");
			const escaped = escapePageMarkerLines(text);
			assert.equal(unescapePageMarkerLines(escaped), text, JSON.stringify(text));
			assert.ok(escaped.split("\n").every((l) => !PAGE_MARKER_PATTERN.test(l)), JSON.stringify(escaped));
			assert.equal(escapePageMarkerLines(unescapePageMarkerLines(escaped)), escaped);
		}
	});

	// Review 2, concern 3: fencedLines was quadratic on adversarial input (6,000 nested openers: 53 ms).
	it("review 2, concern 3: fence detection is linear on many openers that never close", () => {
		const lines: string[] = [];
		for (let i = 0; i < 50_000; i++) lines.push("```a", "~~~");
		const doc = `--- Page 1 ---\n${lines.join("\n")}\n# Slutt\nTekst\n`;
		const started = performance.now();
		const batches = splitMaterial(doc, { budgetTokens: 2_000 });
		const ms = performance.now() - started;
		assertTiles(doc, batches);
		// the old scan compared each of the 50,000 openers with up to 100,000 closers; linear takes milliseconds
		assert.ok(ms < 2_000, `took ${Math.round(ms)} ms`);
	});

	it("a fence that is never closed is not a fence: the page markers after it still count", () => {
		const doc = "--- Page 1 ---\nIntro\n```python\nprint(1)\n--- Page 2 ---\n# Kapittel 2\nTwo\n--- Page 3 ---\nThree\n";
		assert.equal(pageCountOf(doc), 3);
		const batches = splitMaterial(doc, { budgetTokens: 4 });
		assertTiles(doc, batches);
		assert.equal(batches.at(-1)!.pageEnd, 3);
		assert.ok(batches.some((b) => b.headingPath[0] === "Kapittel 2"));
	});

	// Review 1, defect 4 (the splitter half): the validator needs the pages actually present in a batch.
	it("each batch lists the pages its text is on: skipped numbers absent, backward markers kept, a mid-page start inherits its page", () => {
		const skipped = "--- Page 2 ---\n\nTwo\n\n--- Page 5 ---\n\nFive\n";
		assert.deepEqual(splitMaterial(skipped).map((b) => b.pages), [[2, 5]]);
		const backward = "--- Page 5 ---\nFive\n--- Page 2 ---\nTwo\n";
		const [one] = splitMaterial(backward);
		assert.deepEqual([one!.pageStart, one!.pageEnd, one!.pages], [5, 2, [2, 5]]);
		const midPage = `--- Page 7 ---\n${prose("Sju", 300)}\n\n${prose("Mer", 300)}\n--- Page 8 ---\nAtte\n`;
		const batches = splitMaterial(midPage, { budgetTokens: 100 });
		assertTiles(midPage, batches);
		const second = batches[1]!;
		assert.ok(!second.text.startsWith("--- Page"), "the second batch starts mid-page");
		assert.equal(second.pages[0], 7, "it inherits page 7");
		assert.ok(batches.at(-1)!.pages.includes(8));
	});

	// Review 1, defect 11: every line rescanned every marker (2,000 pages 170 ms, 4,000 pages 653 ms, quadratic).
	it("splits a 20,000-page document in linear time", () => {
		const pages: string[] = [];
		for (let n = 1; n <= 20_000; n++) pages.push(`--- Page ${n} ---\n\nLine a ${n}\nLine b\n\nPara ${"x".repeat(1_000)}`);
		const doc = pages.join("\n\n");
		const started = performance.now();
		const batches = splitMaterial(doc);
		const ms = performance.now() - started;
		assertTiles(doc, batches);
		assert.equal(batches.at(-1)!.pageEnd, 20_000);
		// quadratic behaviour took about 16 s here; linear takes tens of milliseconds
		assert.ok(ms < 3_000, `took ${Math.round(ms)} ms`);
	});

	// Extended after review 2 (it generated only closed fences, which is why finding 4 was missed): unclosed fences,
	// fences left open across a page marker, escaped marker-like lines (page 0 only in this escaped form) and doubly
	// escaped ones.
	it("property: seeded random documents (markers, fences open or closed, escaped markers, CRLF, empty pages, very long lines, emoji) always tile", () => {
		let checks = 0;
		for (let seed = 1; seed <= 400; seed++) {
			const rand = mulberry32(seed);
			const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
			const nl = rand() < 0.3 ? "\r\n" : "\n";
			const parts: string[] = [];
			let page = 0;
			const count = 1 + Math.floor(rand() * 40);
			const kinds = ["marker", "marker", "text", "text", "text", "heading", "fence", "unclosed", "across", "escaped", "blank", "long", "emoji", "empty-page", "backward"] as const;
			for (let i = 0; i < count; i++) {
				const kind = pick(kinds);
				if (kind === "marker") parts.push(`--- Page ${(page += 1 + Math.floor(rand() * 2))} ---${nl}${rand() < 0.5 ? nl : ""}`);
				else if (kind === "backward") parts.push(`--- Page ${Math.max(1, page - 1 - Math.floor(rand() * 3))} ---${nl}`);
				else if (kind === "empty-page") parts.push(`--- Page ${++page} ---${nl}${nl}--- Page ${++page} ---${nl}`);
				else if (kind === "text") parts.push(`${prose(`Tekst ${i}`, 1 + Math.floor(rand() * 400))}${nl}`);
				else if (kind === "heading") parts.push(`${"#".repeat(1 + Math.floor(rand() * 6))} Heading ${i}${nl}`);
				else if (kind === "fence") {
					// closed on its page, the closer as long or longer; the example marker inside is escaped as the host does
					const open = pick(["```", "~~~", "````"]);
					const close = rand() < 0.3 ? `${open}${open[0]}` : open;
					const example = escapePageMarkerLines(`--- Page ${pick([0, 900 + i])} ---`);
					parts.push(`${open}md${nl}${example}${nl}# FencedFake ${i}${nl}code ${i}${nl}${close}${nl}`);
				} else if (kind === "unclosed") parts.push(`${pick(["```python", "~~~", "````", "```"])}${nl}code ${i}${nl}`);
				else if (kind === "across") {
					// opened on one page, a real marker, then a closer: not a fence (it would span the boundary)
					const open = pick(["```", "~~~"]);
					parts.push(`${open}${nl}--- Page ${(page += 1)} ---${nl}# Across ${i}${nl}${open}${nl}`);
				} else if (kind === "escaped") parts.push(`${escapePageMarkerLines(pick([`--- Page ${900 + i} ---`, "--- Page 0 ---", `\\--- Page ${900 + i} ---`]))}${nl}`);
				else if (kind === "blank") parts.push(pick([nl, `${nl}${nl}`, `  ${nl}`]));
				else if (kind === "long") parts.push(`${"L".repeat(1 + Math.floor(rand() * 60_000))}${nl}`);
				else parts.push(`${"🙂".repeat(1 + Math.floor(rand() * 30))}${nl}`);
			}
			const doc = parts.join("");
			const budgetTokens = pick([1, 2, 7, 50, 300, 2_000, 8_000]);
			const opts = rand() < 0.2 ? { budgetTokens, estimateTokens: (t: string) => Math.ceil([...t].length / 3) } : { budgetTokens };
			const estimate = opts.estimateTokens ?? estimateTextTokens;
			const batches = splitMaterial(doc, opts);
			if (doc.length === 0) {
				assert.deepEqual(batches, []);
				continue;
			}
			assertTiles(doc, batches);
			// the real markers are exactly the unescaped marker lines the generator wrote (escaped ones start with "\")
			const realPages = new Set([...doc.matchAll(/^--- Page (\d+) ---\r?$/gm)].map((m) => Number(m[1])));
			assert.ok(![...realPages].some((p) => p === 0 || p >= 900), `seed ${seed}: the generator wrote page 0 or 900+ unescaped`);
			const seenPages = new Set<number>();
			for (const b of batches) {
				assert.ok(estimate(b.text) <= budgetTokens || [...b.text].length === 1, `seed ${seed}: batch ${b.index} over the budget`);
				assert.ok(!/[\ud800-\udbff]$/.test(b.text), `seed ${seed}: a surrogate pair is cut`);
				assert.ok(b.pages.includes(b.pageStart) && b.pages.includes(b.pageEnd), `seed ${seed}: pages hold start and end`);
				for (const p of b.pages) {
					assert.ok(p >= 1 && (realPages.size === 0 ? p === 1 : realPages.has(p)), `seed ${seed}: page ${p} is a real marker`);
					seenPages.add(p);
				}
				assert.ok(!b.headingPath.some((h) => h.startsWith("FencedFake")), `seed ${seed}: a fenced heading in a path`);
				checks++;
			}
			// no fence, open or closed, hides a real marker: every real page is some batch's page
			for (const p of realPages) assert.ok(seenPages.has(p), `seed ${seed}: real page ${p} is missing from the batches`);
			assert.equal(pageCountOf(doc), realPages.size === 0 ? 1 : Math.max(...realPages), `seed ${seed}: pageCount is the highest real marker`);
		}
		assert.ok(checks > 1_000, `${checks} batch checks`);
	});
});

/** A seeded PRNG (mulberry32): the property test's documents are the same on every run. */
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
