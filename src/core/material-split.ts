/**
 * Splitting one converted document (`content.md`) into bounded batches for
 * indexing (fork addition, 2026-11-24; the indexer is
 * `src/agent/subagents/material-digest.ts`). Pure.
 *
 * THE PAGE MARKER CONTRACT. `content.md` is always written by the host
 * application, which owns page numbering: it writes every page marker line
 * itself (`formatPageMarker(N)`, `--- Page N ---`, N >= 1, on a line of its own)
 * and passes each page's own text through `escapePageMarkerLines` first, so no
 * line of a page's text looks like a marker. Hence EVERY line matching
 * PAGE_MARKER_PATTERN is a real page boundary, wherever it is (also where a code
 * fence seems to be open). Page numbers may skip (an image-only page left out)
 * or run backwards; a line `--- Page 0 ---` is not a marker. A document without
 * markers (a text note, a web page) is all page 1. Text before the first marker
 * belongs to the first marker's page. (The pdfjs converters `pdf-ops.ts
 * pdfExtract` and `pdf-markdown.ts joinPages` predate this contract and do not
 * escape yet; the host's conversion step must.)
 *
 * Headings are ATX Markdown headings (`#` to `######` and a space); they may be
 * absent (slide decks).
 *
 * Fenced code blocks (``` or ~~~, CommonMark rules: a closing fence of the same
 * character, at least as long, with nothing after it) never span a page
 * boundary: the fence state resets at each marker, and a fence still open at the
 * end of its page is not a fence (its lines are ordinary lines). A heading inside
 * a fence that opens and closes within one page is not a heading, for cutting and
 * heading paths alike.
 *
 * The plan: cut the document into sections at its headings, keep each section
 * that fits the budget whole, and pack consecutive pieces greedily up to the
 * budget. A section over the budget is cut at its page markers, a page still
 * over it at its paragraphs (a blank line), then at line ends, and only a single
 * line over the budget at a character offset. INVARIANT: the batches tile the
 * document exactly (the first starts at 0, each starts where the previous ended,
 * the last ends at its length), so no text is lost or repeated.
 *
 * Cost: one scan of the lines, then binary searches over sorted offsets; no
 * per-line rescan of the markers (linear in the document apart from the token
 * estimates of the pieces).
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
	/**
	 * Every page number the batch's text is on, ascending, unique: the page it starts on (inherited when it starts
	 * mid-page) and each page whose marker is inside it. Numbers a converter skipped (an image-only page) are absent.
	 */
	pages: number[];
	/** The heading titles in force where the batch starts, outermost first ([] before any heading). */
	headingPath: string[];
	/** contentMd.slice(charStart, charEnd). */
	text: string;
	charStart: number;
	charEnd: number;
}

/**
 * A page marker line (one line, without its "\n"; a trailing "\r" and trailing spaces or tabs are allowed): `--- Page N
 * ---` with N >= 1 written without leading zeros; group 1 is N. The single source of truth for what a page boundary
 * is (see the module comment). No `g` flag: safe to share.
 */
export const PAGE_MARKER_PATTERN = /^--- Page ([1-9]\d*) ---[ \t]*\r?$/;

/** The page marker line for page N (no newline): `--- Page N ---`. Throws unless N is a whole number >= 1. Pure. */
export function formatPageMarker(page: number): string {
	if (!Number.isSafeInteger(page) || page < 1) throw new RangeError(`a page marker needs a whole page number of at least 1, got ${page}`);
	return `--- Page ${page} ---`;
}

/** A line that looks like a marker (any number, 0 and leading zeros included) after any number of backslashes. */
const MARKER_LIKE = /^\\*--- Page \d+ ---[ \t]*\r?$/;
/** An escaped marker-like line: one backslash, then a marker-like line (group 1). */
const ESCAPED_MARKER_LIKE = /^\\(\\*--- Page \d+ ---[ \t]*\r?)$/;

/**
 * One page's own text made safe to place after its marker in `content.md`: every line that looks like a page marker
 * (`--- Page N ---` for any N, after any number of leading backslashes) gets one more leading backslash, so
 * `--- Page 3 ---` becomes `\--- Page 3 ---` and `\--- Page 3 ---` becomes `\\--- Page 3 ---`. No line of the result
 * matches PAGE_MARKER_PATTERN. Markdown renders `\-` as `-`, so the text displays unchanged. Every other line, line
 * endings included, is kept as it is. Inverse: unescapePageMarkerLines. Pure.
 */
export function escapePageMarkerLines(pageMarkdown: string): string {
	return pageMarkdown
		.split("\n")
		.map((line) => (MARKER_LIKE.test(line) ? `\\${line}` : line))
		.join("\n");
}

/** The inverse of escapePageMarkerLines: one leading backslash removed from each escaped marker-like line. Pure. */
export function unescapePageMarkerLines(escaped: string): string {
	return escaped
		.split("\n")
		.map((line) => ESCAPED_MARKER_LIKE.exec(line)?.[1] ?? line)
		.join("\n");
}

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t#]*\r?$/;
const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*\r?$/;

interface PageMark {
	start: number;
	page: number;
	/** The start of the first non-blank line after the marker line (the document's length when there is none). */
	firstContent: number;
}

interface HeadingMark {
	start: number;
	level: number;
	title: string;
}

interface Structure {
	/** Line starts, ascending (the first is 0). */
	lineStarts: number[];
	/** contentBefore[i]: how many content lines (not blank, not a page marker, not a heading outside a fence) precede line i. */
	contentBefore: number[];
	/** The page markers (every PAGE_MARKER_PATTERN line), in document order. */
	pages: PageMark[];
	/** The headings outside fences (fences closed on their own page), in document order. */
	headings: HeadingMark[];
	/** Starts of lines that follow a blank line (paragraph starts), ascending. */
	paragraphs: number[];
}

/** The lines of a document: their starts and texts (without the newline; a trailing \r is kept). */
function linesOf(text: string): { starts: number[]; texts: string[] } {
	const starts: number[] = [];
	const texts: string[] = [];
	let start = 0;
	while (start < text.length) {
		const nl = text.indexOf("\n", start);
		const end = nl < 0 ? text.length : nl;
		starts.push(start);
		texts.push(text.slice(start, end));
		start = end + 1;
	}
	return { starts, texts };
}

/**
 * fenced[i]: line i is a delimiter of, or inside, a fence that opens and closes on one page (no marker line between).
 * Linear: for each line, the longest closing fence of each character from there to the end of its page is known, so an
 * opener that is never closed on its page is skipped at once, and a closed one is scanned only up to its closer.
 */
function fencedLines(texts: readonly string[], isMarker: readonly boolean[]): boolean[] {
	const n = texts.length;
	const closer = texts.map((t) => {
		const m = FENCE_CLOSE.exec(t);
		return m ? { char: m[1]![0]!, length: m[1]!.length } : null;
	});
	// longest[c][i]: the longest closer of character c on lines i.. up to the next marker line (0 when none).
	const longest = { "`": new Array<number>(n + 1).fill(0), "~": new Array<number>(n + 1).fill(0) };
	for (let i = n - 1; i >= 0; i--) {
		for (const c of ["`", "~"] as const) {
			const own = closer[i]?.char === c ? closer[i]!.length : 0;
			longest[c][i] = isMarker[i] ? 0 : Math.max(own, longest[c][i + 1]!);
		}
	}
	const fenced = new Array<boolean>(n).fill(false);
	for (let i = 0; i < n; i++) {
		if (isMarker[i]) continue;
		const open = FENCE_OPEN.exec(texts[i]!);
		if (!open) continue;
		const char = open[1]![0] as "`" | "~";
		const length = open[1]!.length;
		// a backtick fence's info string may not contain a backtick (CommonMark)
		if (char === "`" && texts[i]!.slice(open[0].length).includes("`")) continue;
		if (longest[char][i + 1]! < length) continue; // not closed on its page: not a fence
		let close = i + 1;
		while (!(closer[close]?.char === char && closer[close]!.length >= length)) close++;
		for (let j = i; j <= close; j++) fenced[j] = true;
		i = close;
	}
	return fenced;
}

/** The page markers, headings, paragraph starts and content lines of a document (see the module comment). Pure. */
function structureOf(text: string): Structure {
	const { starts, texts } = linesOf(text);
	const isMarker = texts.map((t) => PAGE_MARKER_PATTERN.test(t));
	const fenced = fencedLines(texts, isMarker);
	const pages: PageMark[] = [];
	const headings: HeadingMark[] = [];
	const paragraphs: number[] = [];
	const contentBefore: number[] = [];
	let content = 0;
	let prevBlank = false;
	/** Markers still waiting for their first non-blank line. */
	let waiting: PageMark[] = [];
	for (let i = 0; i < texts.length; i++) {
		const start = starts[i]!;
		const line = texts[i]!;
		contentBefore.push(content);
		const blank = line.trim() === "";
		if (!blank && prevBlank && start > 0) paragraphs.push(start);
		prevBlank = blank;
		if (blank) continue;
		for (const w of waiting) w.firstContent = start;
		waiting = [];
		if (isMarker[i]) {
			const mark = { start, page: Number(PAGE_MARKER_PATTERN.exec(line)![1]), firstContent: text.length };
			pages.push(mark);
			waiting.push(mark);
			continue;
		}
		if (fenced[i]) {
			content++;
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading) {
			const title = heading[2]!.trim();
			if (title) headings.push({ start, level: heading[1]!.length, title });
			continue;
		}
		content++;
	}
	contentBefore.push(content);
	return { lineStarts: starts, contentBefore, pages, headings, paragraphs };
}

/** The index of the last element of an ascending array that is <= value (-1 when none). */
function lastAtOrBefore(sorted: readonly number[], value: number): number {
	let lo = 0;
	let hi = sorted.length; // the first index with sorted[i] > value
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (sorted[mid]! <= value) lo = mid + 1;
		else hi = mid;
	}
	return lo - 1;
}

/** The elements of an ascending array strictly inside (start, end). */
function inside(sorted: readonly number[], start: number, end: number): number[] {
	const from = lastAtOrBefore(sorted, start) + 1;
	const to = lastAtOrBefore(sorted, end - 1) + 1;
	return sorted.slice(from, to);
}

/** The highest page marker number in a document (escaped marker-like lines are text); 1 without markers. Pure. */
export function pageCountOf(contentMd: string): number {
	const { pages } = structureOf(contentMd);
	return pages.reduce((max, p) => Math.max(max, p.page), 1);
}

/** [start, end) ranges cut at the given ascending points, all inside (start, end). */
function cutAt(start: number, end: number, points: readonly number[]): [number, number][] {
	const bounds = [start, ...points, end];
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
	const markerStarts = structure.pages.map((p) => p.start);
	const fits = (start: number, end: number) => estimate(contentMd.slice(start, end)) <= budget;

	/** The last page marker strictly before an offset. */
	const markerBefore = (offset: number): PageMark | undefined => structure.pages[lastAtOrBefore(markerStarts, offset - 1)];
	/** The page a character offset is on. */
	const pageAt = (offset: number): number => {
		if (structure.pages.length === 0) return 1;
		return (structure.pages[lastAtOrBefore(markerStarts, offset)] ?? structure.pages[0]!).page;
	};

	// A cut never separates a page marker from its page's first text (the marker alone would end the previous batch).
	const markerOnlyBefore = (point: number) => {
		const marker = markerBefore(point);
		return marker !== undefined && point <= marker.firstContent;
	};
	// The finer cut levels for a range over the budget: pages, paragraphs, lines (each ascending).
	const levels: readonly (readonly number[])[] = [
		markerStarts,
		structure.paragraphs.filter((p) => !markerOnlyBefore(p)),
		structure.lineStarts.filter((p) => p > 0 && !markerOnlyBefore(p)),
	];

	/**
	 * The longest prefix of [start, end) that fits, at least one character, never inside a surrogate pair. Gallops from
	 * the start (1, 2, 4, … characters) before the binary search, so each probe costs about the piece's own length.
	 */
	function hardCut(start: number, end: number): number {
		let lo = start + 1;
		let step = 1;
		while (start + step * 2 <= end && fits(start, start + step * 2)) step *= 2;
		lo = Math.max(lo, start + step);
		let hi = Math.min(end, start + step * 2);
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
			const points = inside(levels[l]!, start, end);
			if (points.length > 0) return cutAt(start, end, points).flatMap(([s, e]) => pieces(s, e, l + 1));
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
		const marker = markerBefore(h.start);
		return marker && marker.firstContent === h.start ? marker.start : h.start;
	};
	// A section of headings and markers only ("# Kapittel 2" straight above "## 2.1") stays with the next one, so a
	// title is never packed onto the end of the previous batch away from its text. Cuts are line starts.
	const lineIndex = (offset: number) => lastAtOrBefore(structure.lineStarts, offset);
	const contentless = (start: number, end: number) =>
		structure.contentBefore[lineIndex(end - 1) + 1]! - structure.contentBefore[lineIndex(start)]! === 0;
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
		const marker = markerBefore(start + 1);
		if (marker && marker.start === start) return Math.min(end - 1, marker.firstContent);
		let line = lineIndex(start);
		if (structure.lineStarts[line] !== start) return start; // a hard cut inside a line
		while (line < structure.lineStarts.length && contentMd.slice(structure.lineStarts[line]!, structure.lineStarts[line + 1] ?? contentMd.length).trim() === "") line++;
		return Math.min(end - 1, structure.lineStarts[line] ?? contentMd.length);
	};

	// Heading paths by one sweep: the batches' content starts ascend.
	const stack: HeadingMark[] = [];
	let nextHeading = 0;
	const headingPathAt = (offset: number): string[] => {
		while (nextHeading < structure.headings.length && structure.headings[nextHeading]!.start <= offset) {
			const h = structure.headings[nextHeading++]!;
			while (stack.length > 0 && stack[stack.length - 1]!.level >= h.level) stack.pop();
			stack.push(h);
		}
		return stack.map((h) => h.title);
	};

	return ranges.map(([charStart, charEnd], index) => {
		const pageStart = pageAt(charStart);
		const within = inside(markerStarts, charStart - 1, charEnd).map((s) => structure.pages[lastAtOrBefore(markerStarts, s)]!.page);
		return {
			index,
			pageStart,
			pageEnd: pageAt(charEnd - 1),
			pages: [...new Set([pageStart, ...within])].sort((a, b) => a - b),
			headingPath: headingPathAt(contentStart(charStart, charEnd)),
			text: contentMd.slice(charStart, charEnd),
			charStart,
			charEnd,
		};
	});
}
