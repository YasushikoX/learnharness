/**
 * Splitting one converted document (`content.md`) into bounded batches for
 * indexing (fork addition, 2026-11-24; the indexer is
 * `src/agent/subagents/material-digest.ts`). Pure.
 *
 * Page markers are the lines the pdfjs converters write: `--- Page N ---` on a
 * line of its own (`pdf-ops.ts pdfExtract` puts one newline after it and joins
 * pages with one; `pdf-markdown.ts joinPages` puts a blank line after it, joins
 * with a blank line and leaves out image-only pages, so numbers may skip). A
 * document without markers (a text note, a web page) is all page 1. Text
 * before the first marker belongs to the first marker's page.
 *
 * Headings are ATX Markdown headings (`#` to `######` and a space), outside
 * fenced code blocks; they may be absent (slide decks).
 *
 * The plan: cut the document into sections at its headings, keep each section
 * that fits the budget whole, and pack consecutive pieces greedily up to the
 * budget. A section over the budget is cut at its page markers, a page still
 * over it at its paragraphs (a blank line), then at line ends, and only a single
 * line over the budget at a character offset. INVARIANT: the batches tile the
 * document exactly (the first starts at 0, each starts where the previous ended,
 * the last ends at its length), so no text is lost or repeated.
 */

/** The batch budget in estimated tokens (the design's "about 8,000"). */
export const DEFAULT_BATCH_TOKENS = 8_000;

/** Characters per token in the app-wide estimate (chars/4, ceil: core/coverage.ts viewTokens, core/compaction.ts). */
export const CHARS_PER_TOKEN = 4;

/** The default estimate: chars/4, ceil. */
export function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface SplitOptions {
	/** The budget per batch, in estimated tokens (default DEFAULT_BATCH_TOKENS). */
	budgetTokens?: number;
	/** The token estimate (default estimateTextTokens). Must not decrease as text grows. */
	estimateTokens?: (text: string) => number;
}

export interface MaterialBatch {
	/** 0-based, in document order. */
	index: number;
	/** The page the batch's first character is on. */
	pageStart: number;
	/** The page its last character is on. */
	pageEnd: number;
	/** The heading titles in force where the batch starts, outermost first ([] before any heading). */
	headingPath: string[];
	/** contentMd.slice(charStart, charEnd). */
	text: string;
	charStart: number;
	charEnd: number;
}

/** A page marker line, exactly as the converters write it. */
const PAGE_MARKER = /^--- Page (\d+) ---[ \t]*\r?$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t#]*\r?$/;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;

interface Line {
	start: number;
	/** The line's text without its newline (a trailing \r is kept). */
	text: string;
}

function linesOf(text: string): Line[] {
	const out: Line[] = [];
	let start = 0;
	while (start < text.length) {
		const nl = text.indexOf("\n", start);
		const end = nl < 0 ? text.length : nl;
		out.push({ start, text: text.slice(start, end) });
		start = end + 1;
	}
	return out;
}

interface PageMark {
	start: number;
	page: number;
}

interface HeadingMark {
	start: number;
	level: number;
	title: string;
}

interface Structure {
	pages: PageMark[];
	headings: HeadingMark[];
	/** Starts of lines that follow a blank line (paragraph starts). */
	paragraphs: number[];
	/** Starts of every line after the first. */
	lineStarts: number[];
}

/** The page markers, headings and paragraph starts of a document. Pure. */
function structureOf(text: string): Structure {
	const pages: PageMark[] = [];
	const headings: HeadingMark[] = [];
	const paragraphs: number[] = [];
	const lineStarts: number[] = [];
	let fence: string | null = null;
	let prevBlank = false;
	for (const line of linesOf(text)) {
		if (line.start > 0) lineStarts.push(line.start);
		const blank = line.text.trim() === "";
		if (!blank && prevBlank && line.start > 0) paragraphs.push(line.start);
		prevBlank = blank;
		const marker = PAGE_MARKER.exec(line.text);
		if (marker) {
			pages.push({ start: line.start, page: Number(marker[1]) });
			fence = null; // a page never continues a code fence the converter left open
			continue;
		}
		const fenceOpen = FENCE.exec(line.text);
		if (fenceOpen) {
			const mark = fenceOpen[1]!;
			if (fence === null) fence = mark;
			else if (mark[0] === fence[0] && mark.length >= fence.length) fence = null;
			continue;
		}
		if (fence !== null) continue;
		const heading = HEADING.exec(line.text);
		if (heading && heading[2]!.trim()) headings.push({ start: line.start, level: heading[1]!.length, title: heading[2]!.trim() });
	}
	return { pages, headings, paragraphs, lineStarts };
}

/** The page a character offset is on. */
function pageAt(pages: readonly PageMark[], offset: number): number {
	if (pages.length === 0) return 1;
	let page = pages[0]!.page;
	for (const mark of pages) {
		if (mark.start > offset) break;
		page = mark.page;
	}
	return page;
}

/** The heading titles in force at a character offset (a heading starting there counts). */
function headingPathAt(headings: readonly HeadingMark[], offset: number): string[] {
	const stack: HeadingMark[] = [];
	for (const h of headings) {
		if (h.start > offset) break;
		while (stack.length > 0 && stack[stack.length - 1]!.level >= h.level) stack.pop();
		stack.push(h);
	}
	return stack.map((h) => h.title);
}

/** The highest page marker number in a document; 1 without markers. Pure. */
export function pageCountOf(contentMd: string): number {
	const { pages } = structureOf(contentMd);
	return pages.reduce((max, p) => Math.max(max, p.page), 1);
}

/** [start, end) ranges cut at the given points inside (start, end). */
function cutAt(start: number, end: number, points: readonly number[]): [number, number][] {
	const inside = [...new Set(points.filter((p) => p > start && p < end))].sort((a, b) => a - b);
	const bounds = [start, ...inside, end];
	const out: [number, number][] = [];
	for (let i = 0; i + 1 < bounds.length; i++) out.push([bounds[i]!, bounds[i + 1]!]);
	return out;
}

/** Split a document into batches that tile it exactly. "" gives []. Pure. */
export function splitMaterial(contentMd: string, opts: SplitOptions = {}): MaterialBatch[] {
	const budget = Math.max(1, opts.budgetTokens ?? DEFAULT_BATCH_TOKENS);
	const estimate = opts.estimateTokens ?? estimateTextTokens;
	if (contentMd.length === 0) return [];
	const structure = structureOf(contentMd);
	const fits = (start: number, end: number) => estimate(contentMd.slice(start, end)) <= budget;

	// A cut never separates a page marker from its page's first text (the marker alone would end the previous batch).
	const markerOnlyBefore = (point: number) => {
		const marker = structure.pages.filter((p) => p.start < point).at(-1);
		return marker !== undefined && contentMd.slice(marker.start, point).replace(/^[^\n]*\n?/, "").trim() === "";
	};
	// The finer cut levels for a range over the budget: pages, paragraphs, lines.
	const levels: readonly (readonly number[])[] = [
		structure.pages.map((p) => p.start),
		structure.paragraphs.filter((p) => !markerOnlyBefore(p)),
		structure.lineStarts.filter((p) => !markerOnlyBefore(p)),
	];

	/** The longest prefix of [start, end) that fits, at least one character, never inside a surrogate pair. */
	function hardCut(start: number, end: number): number {
		let lo = start + 1;
		let hi = end;
		while (lo < hi) {
			const mid = Math.ceil((lo + hi) / 2);
			if (fits(start, mid)) lo = mid;
			else hi = mid - 1;
		}
		const code = contentMd.charCodeAt(lo - 1);
		if (lo < end && code >= 0xd800 && code <= 0xdbff) lo = lo - 1 > start ? lo - 1 : lo + 1;
		return lo;
	}

	/** Pieces of [start, end), each within the budget unless it is a single character. */
	function pieces(start: number, end: number, level: number): [number, number][] {
		if (fits(start, end)) return [[start, end]];
		for (let l = level; l < levels.length; l++) {
			const parts = cutAt(start, end, levels[l]!);
			if (parts.length > 1) return parts.flatMap(([s, e]) => pieces(s, e, l + 1));
		}
		const out: [number, number][] = [];
		let at = start;
		while (at < end) {
			const next = hardCut(at, end);
			out.push([at, next]);
			at = next;
		}
		return out;
	}

	// A heading that opens its page ("--- Page 3 ---\n\n# Chapter 2") cuts before the page's marker, so the marker
	// starts the heading's section instead of ending the previous one.
	const sectionStart = (h: HeadingMark) => {
		const marker = structure.pages.filter((p) => p.start < h.start).at(-1);
		if (!marker) return h.start;
		const between = contentMd.slice(marker.start, h.start).replace(/^[^\n]*\n?/, "");
		return between.trim() === "" ? marker.start : h.start;
	};
	// A section of headings and markers only ("# Kapittel 2" straight above "## 2.1") stays with the next one, so a
	// title is never packed onto the end of the previous batch away from its text.
	const contentless = (start: number, end: number) =>
		contentMd
			.slice(start, end)
			.split("\n")
			.every((line) => line.trim() === "" || PAGE_MARKER.test(line) || HEADING.test(line));
	const cuts: number[] = [];
	for (const cut of structure.headings.map(sectionStart)) {
		if (cut <= (cuts.at(-1) ?? 0)) continue;
		if (!contentless(cuts.at(-1) ?? 0, cut)) cuts.push(cut);
	}
	const sections = cutAt(0, contentMd.length, cuts);
	const atoms = sections.flatMap(([s, e]) => pieces(s, e, 0));

	// Greedy packing of consecutive atoms.
	const ranges: [number, number][] = [];
	let current: [number, number] | null = null;
	for (const [s, e] of atoms) {
		if (current && fits(current[0], e)) current = [current[0], e];
		else {
			if (current) ranges.push(current);
			current = [s, e];
		}
	}
	if (current) ranges.push(current);

	/** Where a batch's own content starts: past a leading page marker line and blank lines (its heading may follow). */
	const contentStart = (start: number, end: number) => {
		const lead = /^(?:--- Page \d+ ---[ \t]*\r?\n)?\s*/.exec(contentMd.slice(start, Math.min(end, start + 200)));
		return Math.min(end - 1, start + (lead?.[0].length ?? 0));
	};

	return ranges.map(([charStart, charEnd], index) => ({
		index,
		pageStart: pageAt(structure.pages, charStart),
		pageEnd: pageAt(structure.pages, charEnd - 1),
		headingPath: headingPathAt(structure.headings, contentStart(charStart, charEnd)),
		text: contentMd.slice(charStart, charEnd),
		charStart,
		charEnd,
	}));
}
