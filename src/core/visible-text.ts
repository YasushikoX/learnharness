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
 *   - bold, italic and strikethrough markers are removed the way the screen removes them before words are formed, by
 *     the read-aloud package's linear pass (core/speech-text.ts stripLinearEmphasis; the parse stage leaves emphasis
 *     unparsed because micromark's emphasis tokenizer is quadratic): `**sub**group` reads "subgroup" (review 2);
 *   - a soft line break inside a paragraph is a space, except after a line-break hyphen: a hyphen that ends a line
 *     followed by a line that begins with a lower-case letter joins the two halves into one word (`homo-` / `morphism`
 *     reads "homomorphism", as a PDF line quoted into a reply shows it); every block (paragraph, heading, list item,
 *     table cell, blockquote line, summary) starts on its own line, so a reader that treats a line start as a sentence
 *     start sees a heading or a table cell start one.
 *
 * BOUNDED (review 2: one hostile text could stall or crash a whole class's page). A text is not parsed at all, and so
 * counts nothing, when it is longer than VISIBLE_TEXT_MAX_CHARS, or VISIBLE_TEXT_MAX_CHARS_TEX when it has a legacy TeX
 * delimiter or a double backslash (the display's delimiter repair, core/math-delims.ts, costs the square of the length
 * on unclosed ones), or when its nesting (block markers at a line start, open HTML tags) is deeper than
 * VISIBLE_TEXT_MAX_DEPTH (the Markdown libraries recurse once per level and overflow the stack near a thousand). Any
 * other failure of the parse or the walk also counts nothing for that text: `readVisibleMarkdown` returns null.
 *
 * Plain one-line text with no Markdown character skips the parser (the common case for short tutor lines).
 */

import type { Element, ElementContent, Root, RootContent } from "hast";
import { displayedMarkdownHast, stripLinearEmphasis } from "./speech-text.ts";

/** The stand-in for a formula that is not a plain word, and for inline code: a letter, so it joins hyphenated words,
 *  and never a name. */
export const FORMULA_STAND_IN = "\u{1D465}";

/**
 * The longest text that is parsed (characters). Measured (review 2, warm, best of three, this machine): the slowest
 * shapes without a TeX delimiter are a GFM table, long or wide (a 5,000-character wide table about 40 ms, a long one
 * about 16 ms; 8,000 characters cost 90 ms), and deep `>` runs (also cut by the depth bound); ordinary Markdown-heavy
 * tutor text costs about 1 ms per 1,000 characters. Tutor texts in the fixtures: median 290, 99th percentile 3,800.
 */
export const VISIBLE_TEXT_MAX_CHARS = 5_000;
/**
 * The longest text with a legacy TeX delimiter (`\(`, `\[`) or a double backslash that is parsed. The display's
 * delimiter repair is quadratic on unclosed ones: 2,000 characters of `\(` plus line breaks cost about 36 ms, 4,000
 * about 125 ms (the reviewer's 40,000 took 11 s). Closed delimiters and dollar math are linear (16,000 characters of
 * ordinary math about 22 ms), and the tutor is told to write dollar math, so this tier rarely applies.
 */
export const VISIBLE_TEXT_MAX_CHARS_TEX = 2_000;
/** The deepest nesting that is parsed: block markers at one line's start plus open HTML tags. The parse libraries
 *  overflow the stack between 500 and 1,000 levels on a cold start; no rendered reply nests beyond a few. */
export const VISIBLE_TEXT_MAX_DEPTH = 100;

const TEX_DELIMITER = /\\[([]|\\\\/;
const LINE_CONTAINER = /^[ \t]{0,3}(?:>|[-+*](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$))[ \t]?/;
const HTML_TAG = /<(\/?)([A-Za-z][A-Za-z0-9-]*)\b[^<>]*?(\/?)>/g;
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/** How deep a text nests, estimated without parsing: the most block markers at one line's start (`> > - 1.`) plus the
 *  most HTML tags open at once. Linear. */
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
	let open = 0;
	let htmlDepth = 0;
	if (text.includes("<")) {
		for (const m of text.matchAll(HTML_TAG)) {
			const tag = m[2]!.toLowerCase();
			if (m[1]) open = Math.max(0, open - 1);
			else if (!m[3] && !VOID_TAGS.has(tag)) open++;
			if (open > htmlDepth) htmlDepth = open;
		}
	}
	return lineDepth + htmlDepth;
}

/** Can this text be parsed within the bounds above? */
export function withinVisibleTextBounds(text: string): boolean {
	if (text.length > VISIBLE_TEXT_MAX_CHARS) return false;
	if (text.length > VISIBLE_TEXT_MAX_CHARS_TEX && TEX_DELIMITER.test(text)) return false;
	return nestingDepth(text) <= VISIBLE_TEXT_MAX_DEPTH;
}

/** A line-break hyphen joins its two halves: "homo-\nmorphism" → "homomorphism" (the next line starts lower-case). */
export function joinLineBreakHyphens(text: string): string {
	return text.includes("\n") ? text.replace(/([\p{L}\p{N}\p{M}])[-\u2010]\n[^\S\n]*(?=\p{Ll})/gu, "$1") : text;
}

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
	try {
		if (typeof markdown !== "string") return null;
		if (!withinVisibleTextBounds(markdown)) return null;
		if (!markdown.trim()) return "";
		if (!MARKDOWN_CHARS.test(markdown)) return markdown.replace(/\s+/g, " ").trim();
		return visibleHastText(displayedMarkdownHast(markdown));
	} catch {
		return null;
	}
}

/** The visible text of a sanitised HAST (see visibleMarkdownText). Pure. */
export function visibleHastText(root: Root): string {
	const lines: string[] = [];
	let current = "";
	const flush = () => {
		const line = stripLinearEmphasis(joinLineBreakHyphens(current).replace(/\s+/g, " ")).trim();
		if (line) lines.push(line);
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
	return lines.join("\n");
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
