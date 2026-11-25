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
 *   - inline code shows its text;
 *   - a soft line break inside a paragraph is a space; every block (paragraph, heading, list item, table cell,
 *     blockquote line, summary) starts on its own line, so a reader that treats a line start as a sentence start sees
 *     a heading or a table cell start one.
 *
 * Plain one-line text with no Markdown character skips the parser (the common case for short tutor lines).
 */

import type { Element, ElementContent, Root, RootContent } from "hast";
import { displayedMarkdownHast } from "./speech-text.ts";

/** The stand-in for a formula that is not a plain word: a letter, so it joins hyphenated words, and never a name. */
export const FORMULA_STAND_IN = "\u{1D465}";

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

/** The visible text of displayed Markdown: one line per block, soft breaks as spaces. Pure. */
export function visibleMarkdownText(markdown: string): string {
	if (!markdown.trim()) return "";
	if (!MARKDOWN_CHARS.test(markdown)) return markdown.replace(/\s+/g, " ").trim();
	return visibleHastText(displayedMarkdownHast(markdown));
}

/** The visible text of a sanitised HAST (see visibleMarkdownText). Pure. */
export function visibleHastText(root: Root): string {
	const lines: string[] = [];
	let current = "";
	const flush = () => {
		const line = current.replace(/\s+/g, " ").trim();
		if (line) lines.push(line);
		current = "";
	};
	const inline = (node: RootContent | ElementContent): string => {
		if (node.type === "text") return node.value.replace(/\n/g, " ");
		if (node.type !== "element") return "";
		const tag = node.tagName;
		const classes = classList(node);
		if (classes.includes("sr-only") || isFootnoteRef(node)) return "";
		if (tag === "br") return " ";
		if (tag === "img" || tag === "hr" || tag === "script" || tag === "style") return "";
		if (tag === "code") {
			if (classes.includes("math-inline") || classes.includes("math-display") || classes.includes("language-math")) return formulaText(rawTextOf(node));
			return rawTextOf(node);
		}
		if (tag === "sup" && node.children.every((c) => (c.type === "text" && !c.value.trim()) || (c.type === "element" && isFootnoteRef(c)))) return "";
		if (tag === "details") return (detailsOpen(node) ? node.children : node.children.filter((c) => c.type === "element" && c.tagName === "summary").slice(0, 1)).map(inline).join(" ");
		return node.children.map(inline).join("");
	};
	const block = (node: RootContent | ElementContent): void => {
		if (node.type === "text") {
			current += node.value.replace(/\n/g, " ");
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
