/**
 * The visible text of displayed Markdown (WP5 rework, 2026-11-25). PURE, browser-safe.
 *
 * What the screen shows of a Markdown string, as plain text, for readers that must not count what the learner never
 * saw (the vocabulary ledger, core/coverage-ledger.ts). It reuses the read-aloud package's parse stage
 * (core/speech-text.ts displayedMarkdownHast: the same CommonMark/GFM/math + raw HTML + sanitisation pipeline as
 * `ToolContentResponse`) and walks the sanitised HAST WITHOUT the speech vocabulary (no "link", "formula" or
 * "code block" placeholders, no verbalised LaTeX):
 *
 *   - a link shows its label, never its target; an image shows nothing (its alt text is not on screen); HTML
 *     attributes never reach text (the walk reads text nodes only);
 *   - a collapsed `<details>` shows only its `<summary>`; `sr-only` text and footnote reference marks show nothing;
 *   - inline math shows as itself when it is a plain run of letters and digits (`$R$-module` reads "R-module"), and
 *     otherwise as one stand-in letter "𝑥" (U+1D465): it joins the words around it like the rendered formula does and
 *     never matches a name; display math, fenced code and diagrams are their own blocks and show no words;
 *   - inline code counts nothing (an identifier is not a term introduced): it reads as the same stand-in letter, so it
 *     still occupies a word's place (review 2);
 *   - bold and italic markers are removed the way the screen removes them before words are formed, by the read-aloud
 *     package's linear pass (core/speech-text.ts stripLinearEmphasis, with the Unicode intraword test; the parse stage
 *     leaves emphasis unparsed because micromark's emphasis tokenizer is quadratic): `**sub**group` reads "subgroup"
 *     (review 2);
 *   - struck-through text counts nothing (review 3): `~~…~~`, `~…~` (GFM) and `<del>`/`<s>`/`<strike>` read as the
 *     stand-in letter;
 *   - a bare URL (`http://…`, `www.…`), which GFM shows as its own link label, reads as the stand-in letter: no segment
 *     of it is a word (review 3);
 *   - a soft line break inside a paragraph is a space, except after a line-break hyphen: a hyphen that ends a line
 *     followed by a line that begins with a lower-case letter joins the two halves into one word (`homo-` / `morphism`
 *     reads "homomorphism", as a PDF line quoted into a reply shows it); every block (paragraph, heading, list item,
 *     table cell, blockquote line, summary) starts on its own line, so a reader that treats a line start as a sentence
 *     start sees a heading or a table cell start one.
 *
 * Two VARIANTS of a text are also read (readVisibleVariants), for names the main reading would miss (review 3): the
 * text with its line-break hyphens kept (`well-` / `defined` also reads "well-defined"), and the text with its `*` and
 * `_` kept (for a name that contains one, such as "C*-algebra"; the ledger matches only such names against it).
 *
 * BOUNDED (reviews 2 and 3: one hostile text could stall or crash a whole class's page). A text is not parsed at all, and
 * so counts nothing, when it is longer than VISIBLE_TEXT_MAX_CHARS, or VISIBLE_TEXT_MAX_CHARS_TEX when it has a legacy
 * TeX opener `\(` or `\[` (the display's delimiter reader, core/content-reader.ts readContentSpans, scans to the end for
 * every opener it cannot close: the square of the length), or when one line starts with more than
 * VISIBLE_TEXT_MAX_DEPTH stacked container markers (`1. 1. 1. …`, `> - > - …`: the parse's cost grows fastest with
 * those). Anything else that fails, a stack overflow included, is caught: `readVisibleMarkdown` returns null and the text
 * counts nothing. The limits and what they leave out are measured below.
 *
 * Plain one-line text with no Markdown character skips the parser (the common case for short tutor lines).
 */

import type { Element, ElementContent, Root, RootContent } from "hast";
import { displayedMarkdownHast, stripLinearEmphasis } from "./speech-text.ts";

/** The stand-in for a formula that is not a plain word, and for inline code: a letter, so it joins hyphenated words,
 *  and never a name. */
export const FORMULA_STAND_IN = "\u{1D465}";

/**
 * The longest text that is parsed (characters). Measured (review 3, warm, best of three, this machine, through the
 * parse and the walk) at 5,000 characters: the slowest shapes without a TeX opener are a run of `[` and `]` (about
 * 72 ms; about 105 ms at 6,000 and 170 ms at 8,000, so the limit stays here), a run of `>` (about 55 ms, ending in a
 * caught stack overflow) and GFM tables (about 16 ms); 1,666 stacked `1. ` markers on one line would cost 124 ms and are
 * cut by the depth bound below; ordinary Markdown-heavy tutor text costs about 0.5 ms per 1,000 characters. Tutor texts
 * in the golden fixtures: median 286 characters, longest 3,835.
 */
export const VISIBLE_TEXT_MAX_CHARS = 5_000;
/**
 * The longest text with a legacy TeX opener (`\(`, `\[`) that is parsed. The display's delimiter reader scans to the
 * end for every opener it cannot close, so it is quadratic on unclosed ones (review 3: 3,000 characters of `\(` cost
 * about 70 ms, 3,600 about 97 ms, 5,000 about 180 ms); closed delimiters, `cases` and matrix rows (`\\`) and dollar math
 * are linear and are not counted against this tier (16,000 characters of ordinary maths: about 15 ms). The longest
 * fixture reply with `\(` is 1,834 characters.
 */
export const VISIBLE_TEXT_MAX_CHARS_TEX = 3_000;
/** The most container markers stacked at one line's start that is parsed (`> - 1. …`). The parse's cost grows fastest
 *  with these (see VISIBLE_TEXT_MAX_CHARS); no rendered reply stacks more than a few. Nesting spread over several lines
 *  needs indentation, which the length limit keeps shallow (measured: 6.6 ms at 5,000 characters), and a deep HTML
 *  nest costs under 6 ms at the length limit, so neither is estimated: this is a cost bound, not crash protection
 *  (the catch in readVisibleMarkdown is that). */
export const VISIBLE_TEXT_MAX_DEPTH = 100;

const TEX_OPENER = /\\[([]/;
const LINE_CONTAINER = /^[ \t]{0,3}(?:>|[-+*](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$))[ \t]?/;

/** The most container markers stacked at one line's start (`> > - 1.`), counted up to VISIBLE_TEXT_MAX_DEPTH + 1.
 *  Linear. */
export function nestingDepth(text: string): number {
	let lineDepth = 0;
	for (const raw of text.split("\n")) {
		let line = raw;
		let d = 0;
		for (let m = LINE_CONTAINER.exec(line); m && m[0].length > 0; m = LINE_CONTAINER.exec(line)) {
			d++;
			line = line.slice(m[0].length);
			if (d > VISIBLE_TEXT_MAX_DEPTH) break;
		}
		if (d > lineDepth) lineDepth = d;
	}
	return lineDepth;
}

/** Can this text be parsed within the bounds above? */
export function withinVisibleTextBounds(text: string): boolean {
	if (text.length > VISIBLE_TEXT_MAX_CHARS) return false;
	if (text.length > VISIBLE_TEXT_MAX_CHARS_TEX && TEX_OPENER.test(text)) return false;
	return nestingDepth(text) <= VISIBLE_TEXT_MAX_DEPTH;
}

const LINE_BREAK_HYPHEN = /([\p{L}\p{N}\p{M}])([-\u2010])\n[^\S\n]*(?=\p{Ll})/gu;

/** A line-break hyphen joins its two halves: "homo-\nmorphism" → "homomorphism" (the next line starts lower-case). */
export function joinLineBreakHyphens(text: string): string {
	return text.includes("\n") ? text.replace(LINE_BREAK_HYPHEN, "$1") : text;
}

/** The same halves joined with the hyphen kept: "well-\ndefined" → "well-defined". */
export function keepLineBreakHyphens(text: string): string {
	return text.includes("\n") ? text.replace(LINE_BREAK_HYPHEN, "$1$2") : text;
}

/** A bare URL as GFM autolinks it: every segment is part of one link label, never a word. */
const BARE_URL = /(?:\b[A-Za-z][A-Za-z0-9+.-]{0,30}:\/\/|\bwww\.)[^\s<>]*/gu;

/**
 * Struck-through text (GFM `~~…~~` and `~…~`: a closing run as long as its opening one, flanked like emphasis) replaced
 * by the stand-in letter. Linear: one pass with a stack per run length; nested or overlapping pairs collapse into the
 * outermost. Unpaired tildes stay as they are.
 */
export function replaceStruck(text: string): string {
	if (!text.includes("~")) return text;
	const ranges: Array<[number, number]> = [];
	const open: [number[], number[]] = [[], []];
	for (let i = 0; i < text.length; ) {
		if (text[i] !== "~") {
			i++;
			continue;
		}
		let j = i;
		while (j < text.length && text[j] === "~") j++;
		const len = j - i;
		if (len <= 2) {
			const stack = open[len - 1]!;
			const prev = text[i - 1];
			const next = text[j];
			if (stack.length > 0 && prev !== undefined && !/\s/u.test(prev)) ranges.push([stack.pop()!, j]);
			else if (next !== undefined && !/\s/u.test(next)) stack.push(i);
		}
		i = j;
	}
	if (ranges.length === 0) return text;
	ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
	let out = "";
	let at = 0;
	for (const [start, end] of ranges) {
		if (start < at) continue; // inside an earlier (outer) range
		out += text.slice(at, start) + FORMULA_STAND_IN;
		at = end;
	}
	return out + text.slice(at);
}

/** One line of visible text as the screen shows it: struck text and bare URLs out, emphasis markers removed. */
const finishLine = (line: string): string => stripLinearEmphasis(replaceStruck(line), { unicodeWords: true }).replace(BARE_URL, FORMULA_STAND_IN).trim();

const BLOCKS = new Set(["p", "div", "section", "article", "blockquote", "pre", "ul", "ol", "li", "dl", "dt", "dd", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "details", "summary", "figure", "figcaption", "h1", "h2", "h3", "h4", "h5", "h6", "hr"]);
const ALERT_MARKER = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)/i;
/** Characters that can make plain text render differently from itself. */
const MARKDOWN_CHARS = /[\n\\`*_~[\]<>$|#!&]|^\s*(?:[-+]|\d+[.)])\s|^\s*>|^\s{4}/u;

const classList = (node: Element): string[] => {
	const cls: unknown = node.properties?.className;
	if (Array.isArray(cls)) return cls.map(String);
	if (typeof cls === "string") return cls.split(/\s+/).filter(Boolean);
	return [];
};

const rawTextOf = (node: RootContent | ElementContent): string =>
	node.type === "text" ? node.value : "children" in node && Array.isArray(node.children) ? node.children.map((c) => rawTextOf(c as ElementContent)).join("") : "";

const isFootnoteRef = (node: Element): boolean => node.tagName === "a" && ("dataFootnoteRef" in (node.properties ?? {}) || "dataFootnoteBackref" in (node.properties ?? {}));

const detailsOpen = (node: Element): boolean => {
	const open = node.properties?.open;
	return open !== undefined && open !== false && open !== null;
};

/** A formula as the screen reads it for word matching (see the module comment). */
function formulaText(latex: string): string {
	const t = latex.trim();
	if (t === "") return "";
	return /^[\p{L}\p{N}]+$/u.test(t) ? t : FORMULA_STAND_IN;
}

/** The visible text of displayed Markdown: one line per block, soft breaks as spaces; "" for a text that is not read
 *  (see readVisibleMarkdown). Pure. */
export function visibleMarkdownText(markdown: string): string {
	return readVisibleMarkdown(markdown) ?? "";
}

/** The visible text of displayed Markdown, or null when it is not read: longer or deeper than the bounds above, or a
 *  parse or walk that failed. Never throws. Pure. */
export function readVisibleMarkdown(markdown: string): string | null {
	return readVisibleVariants(markdown)?.text ?? null;
}

/** A text's visible reading and its variants (see the module comment); a variant is present only when it differs. */
export interface VisibleVariants {
	text: string;
	/** Line-break hyphens kept ("well-defined" for `well-` / `defined`). */
	hyphenated?: string;
	/** `*` and `_` kept (matched only against names that contain one). */
	marked?: string;
}

/** readVisibleMarkdown with the variants. Null when the text is not read. Never throws. Pure. */
export function readVisibleVariants(markdown: string): VisibleVariants | null {
	try {
		if (typeof markdown !== "string") return null;
		if (!withinVisibleTextBounds(markdown)) return null;
		if (!markdown.trim()) return { text: "" };
		if (!MARKDOWN_CHARS.test(markdown)) return { text: markdown.replace(/\s+/g, " ").replace(BARE_URL, FORMULA_STAND_IN).trim() };
		return visibleHastVariants(displayedMarkdownHast(markdown));
	} catch {
		return null;
	}
}

/** The visible text of a sanitised HAST (see visibleMarkdownText). Pure. */
export function visibleHastText(root: Root): string {
	return visibleHastVariants(root).text;
}

function visibleHastVariants(root: Root): VisibleVariants {
	const lines: string[] = [];
	const hyphenated: string[] = [];
	const marked: string[] = [];
	let hasHyphenated = false;
	let hasMarked = false;
	let current = "";
	const flush = () => {
		const joined = joinLineBreakHyphens(current).replace(/\s+/g, " ");
		const line = finishLine(joined);
		if (line) lines.push(line);
		const kept = keepLineBreakHyphens(current);
		if (kept !== current) {
			hasHyphenated = true;
			hyphenated.push(finishLine(kept.replace(/\s+/g, " ")));
		}
		if (/[*_]/u.test(joined)) {
			hasMarked = true;
			marked.push(replaceStruck(joined).replace(BARE_URL, FORMULA_STAND_IN).trim());
		}
		current = "";
	};
	// text keeps its line breaks until the line is flushed (a line-break hyphen is read there)
	const inline = (node: RootContent | ElementContent): string => {
		if (node.type === "text") return node.value;
		if (node.type !== "element") return "";
		const tag = node.tagName;
		const classes = classList(node);
		if (classes.includes("sr-only") || isFootnoteRef(node)) return "";
		if (tag === "br") return "\n";
		if (tag === "img" || tag === "hr" || tag === "script" || tag === "style") return "";
		if (tag === "code") {
			if (classes.includes("math-inline") || classes.includes("math-display") || classes.includes("language-math")) return formulaText(rawTextOf(node));
			return rawTextOf(node).trim() === "" ? "" : FORMULA_STAND_IN; // inline code: an identifier, not a term
		}
		// struck-through text counts nothing (review 3)
		if (tag === "del" || tag === "s" || tag === "strike") return rawTextOf(node).trim() === "" ? "" : FORMULA_STAND_IN;
		if (tag === "sup" && node.children.every((c) => (c.type === "text" && !c.value.trim()) || (c.type === "element" && isFootnoteRef(c)))) return "";
		if (tag === "details") return (detailsOpen(node) ? node.children : node.children.filter((c) => c.type === "element" && c.tagName === "summary").slice(0, 1)).map(inline).join(" ");
		return node.children.map(inline).join("");
	};
	const block = (node: RootContent | ElementContent): void => {
		if (node.type === "text") {
			current += node.value;
			return;
		}
		if (node.type !== "element") return;
		const tag = node.tagName;
		if (classList(node).includes("sr-only")) return;
		if (!BLOCKS.has(tag)) {
			current += inline(node);
			return;
		}
		flush();
		if (tag === "hr") return;
		if (tag === "pre") return; // fenced code, display math, diagrams: no words on screen to count
		let children: ElementContent[] = node.children;
		if (tag === "details" && !detailsOpen(node)) children = node.children.filter((c): c is Element => c.type === "element" && c.tagName === "summary").slice(0, 1);
		if (tag === "blockquote") children = withoutAlertMarker(children);
		for (const child of children) block(child);
		flush();
	};
	for (const child of root.children) block(child);
	flush();
	return {
		text: lines.join("\n"),
		...(hasHyphenated ? { hyphenated: hyphenated.filter(Boolean).join("\n") } : {}),
		...(hasMarked ? { marked: marked.filter(Boolean).join("\n") } : {}),
	};
}

/** A GitHub alert's "[!NOTE]" marker is chrome, not text. */
function withoutAlertMarker(children: ElementContent[]): ElementContent[] {
	const at = children.findIndex((c) => c.type === "element" || (c.type === "text" && c.value.trim() !== ""));
	const first = children[at];
	if (!first || first.type !== "element" || first.tagName !== "p") return children;
	const lead = first.children.find((c) => c.type === "element" || (c.type === "text" && c.value.trim() !== ""));
	if (!lead || lead.type !== "text") return children;
	const m = ALERT_MARKER.exec(lead.value);
	if (!m) return children;
	const p: Element = { ...first, children: first.children.map((c) => (c === lead ? { type: "text" as const, value: lead.value.slice(m[0].length) } : c)) };
	return children.map((c, i) => (i === at ? p : c));
}
