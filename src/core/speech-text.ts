/**
 * Pure text-to-speech preparation for pending questions (no DOM / no Node).
 *
 * Parses displayed Markdown through the same CommonMark/GFM/math + raw HTML +
 * HAST sanitisation pipeline as `ToolContentResponse`, ensuring nothing hidden
 * on screen (HTML comments, `<script>`/`<style>`, collapsed `<details>` bodies,
 * unclosed code/figure fences) is ever spoken. Never emits raw LaTeX backslash
 * commands.
 *
 * Sentence boundary merging (`shouldMergeSegments`) is adapted from
 * `amoghu1s1/twig` (`src/core/sentence-reader.ts`, AGPL-3.0).
 */

import type { Element, ElementContent, Root, RootContent } from "hast";
import { raw } from "hast-util-raw";
import { defaultSchema, sanitize, type Schema } from "hast-util-sanitize";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFootnoteFromMarkdown } from "mdast-util-gfm-footnote";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTaskListItemFromMarkdown } from "mdast-util-gfm-task-list-item";
import { mathFromMarkdown } from "mdast-util-math";
import { toHast } from "mdast-util-to-hast";
import { gfmFootnote } from "micromark-extension-gfm-footnote";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTaskListItem } from "micromark-extension-gfm-task-list-item";
import { math } from "micromark-extension-math";
import { DEFAULT_LESSON_LANGUAGE, type LessonLanguage } from "./language.ts";
import { repairMathForDisplay, transformMathDelimiters } from "./math-delims.ts";

export interface SpeechQuestionOption {
	/** Displayed letter (e.g. "A", "B", …), if shown. */
	letter?: string;
	/** Displayed option label (Markdown / LaTeX). */
	label: string;
	/** Optional displayed description (ask options only; never quiz). */
	description?: string;
}

export interface QuestionSpeechInput {
	/** Displayed question Markdown. */
	question: string;
	/** Optional displayed context/details Markdown. */
	context?: string;
	/** Displayed options in displayed order with displayed letters. */
	options?: readonly SpeechQuestionOption[];
	/** Active lesson language (controls spoken phrases and sentence splitting). */
	language?: LessonLanguage;
}

export interface SpeechPhrases {
	/** Locale passed to Intl.Segmenter for sentence splitting. */
	readonly locale: string;
	/** Spoken placeholder for formulas (fallback in English, used for all formulas in non-English languages). */
	readonly formula: string;
	/** Spoken placeholder for a fenced code block. */
	readonly codeBlock: string;
	/** Spoken placeholder for inline code that contains a backslash command. */
	readonly inlineCode: string;
	/** Spoken placeholder for a diagram or figure fence. */
	readonly diagram: string;
	/** Spoken placeholder for an image without alt text. */
	readonly image: string;
	/** Spoken placeholder for a bare URL link. */
	readonly link: string;
	/** True only for languages with a dedicated spoken math vocabulary. */
	readonly verbalizeMath: boolean;
}

/**
 * Compact per-language phrase table for speech placeholders and locale.
 * Adding a new lesson language only requires adding one entry here.
 */
export const SPEECH_PHRASES: Readonly<Record<LessonLanguage, SpeechPhrases>> = {
	en: {
		locale: "en",
		formula: "formula",
		codeBlock: "Code block.",
		inlineCode: "code",
		diagram: "Diagram.",
		image: "image",
		link: "link",
		verbalizeMath: true,
	},
	nb: {
		locale: "nb",
		formula: "formel",
		codeBlock: "Kodeblokk.",
		inlineCode: "kode",
		diagram: "Diagram.",
		image: "bilde",
		link: "lenke",
		verbalizeMath: false,
	},
};

function phrasesFor(language?: LessonLanguage): SpeechPhrases {
	return SPEECH_PHRASES[language ?? DEFAULT_LESSON_LANGUAGE] ?? SPEECH_PHRASES[DEFAULT_LESSON_LANGUAGE];
}

const DEFAULT_MAX_UTTERANCE_CHARS = 220;

/** All figure and diagram fence languages rendered as visuals (docs/figures.md + md-blocks.tsx). */
const DIAGRAM_LANGUAGES = new Set(["plot", "blocks", "circuit", "logic", "timing", "mermaid"]);

const ALERT_MARKER_RE = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)/i;
const RAW_BACKSLASH_COMMAND_RE = /\\[A-Za-z]/;

// The sanitisation schema Streamdown/ToolContentResponse uses (hast-util-sanitize's
// default plus `tel:` links and code `metastring`, as in Streamdown's
// `defaultRehypePlugins.sanitize`), also stripping `<style>` bodies so CSS text is
// never read aloud. Kept a copy so this module stays free of React; the test
// `tests/speech-text.test.ts` fails when it drifts from the renderer's schema.
export const SPEECH_SANITIZE_SCHEMA: Schema = {
	...defaultSchema,
	protocols: { ...defaultSchema.protocols, href: [...(defaultSchema.protocols?.href ?? []), "tel"] },
	attributes: { ...defaultSchema.attributes, code: [...(defaultSchema.attributes?.code ?? []), "metastring"] },
	strip: [...(defaultSchema.strip ?? ["script"]), "style"],
};

// Structural GFM extensions (tables, footnotes, task lists) plus math.
// Micromark's attention/strikethrough/autolink-literal tokenizers have
// quadratic worst cases on repeated `*`/`_`/`~`; emphasis is stripped in a
// dedicated linear pass over prose text nodes instead.
const MD_EXTENSIONS = [
	gfmTable(),
	gfmFootnote(),
	gfmTaskListItem(),
	math({ singleDollarTextMath: true }),
	{ disable: { null: ["attention"] } },
];
const MDAST_EXTENSIONS = [
	gfmTableFromMarkdown(),
	gfmFootnoteFromMarkdown(),
	gfmTaskListItemFromMarkdown(),
	mathFromMarkdown(),
];

// ─── English LaTeX verbalization ─────────────────────────────────────────────

const GREEK_LETTERS: Readonly<Record<string, string>> = {
	alpha: "alpha",
	beta: "beta",
	gamma: "gamma",
	delta: "delta",
	epsilon: "epsilon",
	varepsilon: "epsilon",
	zeta: "zeta",
	eta: "eta",
	theta: "theta",
	vartheta: "theta",
	iota: "iota",
	kappa: "kappa",
	lambda: "lambda",
	mu: "mu",
	nu: "nu",
	xi: "xi",
	omicron: "omicron",
	pi: "pi",
	varpi: "pi",
	rho: "rho",
	varrho: "rho",
	sigma: "sigma",
	varsigma: "sigma",
	tau: "tau",
	upsilon: "upsilon",
	phi: "phi",
	varphi: "phi",
	chi: "chi",
	psi: "psi",
	omega: "omega",
	Gamma: "capital gamma",
	Delta: "capital delta",
	Theta: "capital theta",
	Lambda: "capital lambda",
	Xi: "capital xi",
	Pi: "capital pi",
	Sigma: "capital sigma",
	Upsilon: "capital upsilon",
	Phi: "capital phi",
	Psi: "capital psi",
	Omega: "capital omega",
};

const MATH_OPERATORS: Readonly<Record<string, string>> = {
	pm: "plus or minus",
	mp: "minus or plus",
	times: "times",
	cdot: "times",
	ast: "times",
	star: "star",
	div: "divided by",
	le: "less than or equal to",
	leq: "less than or equal to",
	leqslant: "less than or equal to",
	ge: "greater than or equal to",
	geq: "greater than or equal to",
	geqslant: "greater than or equal to",
	ne: "not equal to",
	neq: "not equal to",
	approx: "approximately equal to",
	simeq: "approximately equal to",
	cong: "congruent to",
	equiv: "equivalent to",
	sim: "similar to",
	propto: "proportional to",
	ll: "much less than",
	gg: "much greater than",
	to: "to",
	rightarrow: "to",
	longrightarrow: "to",
	leftarrow: "from",
	longleftarrow: "from",
	leftrightarrow: "if and only if",
	longleftrightarrow: "if and only if",
	Rightarrow: "implies",
	implies: "implies",
	Leftarrow: "is implied by",
	Leftrightarrow: "if and only if",
	iff: "if and only if",
	mapsto: "maps to",
	infty: "infinity",
	partial: "partial",
	nabla: "nabla",
	forall: "for all",
	exists: "there exists",
	nexists: "there does not exist",
	neg: "not",
	lnot: "not",
	land: "and",
	wedge: "and",
	lor: "or",
	vee: "or",
	in: "in",
	notin: "not in",
	ni: "contains",
	subset: "subset of",
	subseteq: "subset or equal to",
	supset: "superset of",
	supseteq: "superset or equal to",
	cup: "union",
	cap: "intersection",
	setminus: "minus",
	emptyset: "empty set",
	varnothing: "empty set",
	dots: "dot dot dot",
	ldots: "dot dot dot",
	cdots: "dot dot dot",
	vdots: "dot dot dot",
	ddots: "dot dot dot",
	therefore: "therefore",
	because: "because",
	angle: "angle",
	perp: "perpendicular to",
	parallel: "parallel to",
	// `\circ` on its own is function composition; `^\circ` (degrees) is handled by the superscript reader.
	circ: "composed with",
	degree: "degrees",
	prime: "prime",
	ell: "l",
	hbar: "h bar",
	Re: "real part",
	Im: "imaginary part",
	aleph: "aleph",
};

const ATOMIC_SYMBOL_COMMANDS = new Set(["infty", "emptyset", "varnothing", "ell", "hbar", "aleph"]);

const MATH_FUNCTIONS: Readonly<Record<string, string>> = {
	sin: "sine",
	cos: "cosine",
	tan: "tangent",
	cot: "cotangent",
	sec: "secant",
	csc: "cosecant",
	arcsin: "arc sine",
	arccos: "arc cosine",
	arctan: "arc tangent",
	sinh: "hyperbolic sine",
	cosh: "hyperbolic cosine",
	tanh: "hyperbolic tangent",
	ln: "natural log",
	log: "log",
	exp: "exp",
	det: "determinant",
	max: "max",
	min: "min",
	sup: "supremum",
	inf: "infimum",
	arg: "arg",
	deg: "degree",
	dim: "dimension",
	gcd: "gcd",
	lcm: "lcm",
	ker: "kernel",
	mod: "mod",
	bmod: "mod",
	pmod: "mod",
};

const FUNCTION_LETTERS = new Set(["f", "g", "h", "F", "G", "H", "P", "Q"]);

/** Named functions whose `^{-1}` is read as the inverse function ("inverse sine of x"); any other named function with `^{-1}` is "formula". */
const INVERSE_NAMED_FUNCTIONS = new Set(["sin", "cos", "tan", "cot", "sec", "csc", "sinh", "cosh", "tanh"]);

/**
 * Relations end the body of a sum, product, integral or limit ("sum … of i equals …").
 * Additive operators after such a body make the reading ambiguous, so the formula is "formula".
 */
const RELATION_COMMANDS = new Set([
	"le", "leq", "leqslant", "ge", "geq", "geqslant", "ne", "neq", "approx", "simeq", "cong", "equiv", "sim",
	"propto", "ll", "gg", "to", "rightarrow", "longrightarrow", "leftarrow", "longleftarrow", "leftrightarrow",
	"longleftrightarrow", "Rightarrow", "implies", "Leftarrow", "Leftrightarrow", "iff", "mapsto", "in", "notin",
	"ni", "subset", "subseteq", "supset", "supseteq", "perp", "parallel",
]);
const ADDITIVE_COMMANDS = new Set(["pm", "mp"]);
const UNICODE_RELATIONS = new Set(["≤", "≥", "≠", "≈", "≡", "→", "←", "↔", "⇒", "⇔", "∈", "∉", "⊂", "⊆"]);
const UNICODE_ADDITIVE = new Set(["±", "∓"]);

const TEXT_UNWRAP_COMMANDS = new Set([
	"text",
	"textrm",
	"textbf",
	"textit",
	"textup",
	"mbox",
	"hbox",
]);

const MATH_UNWRAP_COMMANDS = new Set([
	"mathrm",
	"mathbf",
	"mathit",
	"mathsf",
	"mathtt",
	"mathcal",
	"mathbb",
	"mathfrak",
	"boldsymbol",
	"bm",
	"operatorname",
	"boxed",
]);

const DECORATOR_SUFFIXES: Readonly<Record<string, string>> = {
	hat: "hat",
	widehat: "hat",
	bar: "bar",
	overline: "bar",
	vec: "vector",
	tilde: "tilde",
	widetilde: "tilde",
	dot: "dot",
	ddot: "double dot",
};

const SPACING_COMMANDS = new Set([
	"displaystyle",
	"textstyle",
	"scriptstyle",
	"scriptscriptstyle",
	"limits",
	"nolimits",
	"quad",
	"qquad",
	"enspace",
	"thinspace",
	"medspace",
	"thickspace",
	"negthinspace",
	"hfill",
]);

const DELIM_SIZE_COMMANDS = new Set([
	"big",
	"Big",
	"bigg",
	"Bigg",
	"bigl",
	"bigr",
	"Bigl",
	"Bigr",
	"biggl",
	"biggr",
	"Biggl",
	"Biggr",
]);

const UNICODE_MATH: Readonly<Record<string, string>> = {
	"±": "plus or minus",
	"×": "times",
	"·": "times",
	"÷": "divided by",
	"≤": "less than or equal to",
	"≥": "greater than or equal to",
	"≠": "not equal to",
	"≈": "approximately equal to",
	"≡": "equivalent to",
	"→": "to",
	"←": "from",
	"↔": "if and only if",
	"⇒": "implies",
	"⇔": "if and only if",
	"∞": "infinity",
	"∂": "partial",
	"∇": "nabla",
	"√": "square root of",
	"∑": "sum",
	"∏": "product",
	"∫": "integral",
	"∈": "in",
	"∉": "not in",
	"⊂": "subset of",
	"⊆": "subset or equal to",
	"∪": "union",
	"∩": "intersection",
	"∅": "empty set",
	"∀": "for all",
	"∃": "there exists",
	"¬": "not",
	"∧": "and",
	"∨": "or",
	"−": "minus",
	"°": "degrees",
	"π": "pi",
	"θ": "theta",
	"α": "alpha",
	"β": "beta",
	"γ": "gamma",
	"δ": "delta",
	"ε": "epsilon",
	"λ": "lambda",
	"μ": "mu",
	"σ": "sigma",
	"ω": "omega",
	"Δ": "capital delta",
	"Σ": "capital sigma",
	"Ω": "capital omega",
	"²": "squared",
	"³": "cubed",
};

const UNICODE_ATOMIC_VALUES = new Set(["∞", "∅", "π", "θ", "α", "β", "γ", "δ", "ε", "λ", "μ", "σ", "ω", "Δ", "Σ", "Ω"]);

/** Read a braced `{...}` group starting at `start`, returning its inner text and next index. */
function readBraceGroup(src: string, start: number): { content: string; end: number } | null {
	let i = start;
	while (i < src.length && /\s/.test(src[i]!)) i++;
	if (src[i] !== "{") return null;
	let depth = 0;
	const innerStart = i + 1;
	for (; i < src.length; i++) {
		if (src[i] === "\\" && i + 1 < src.length) {
			i++;
			continue;
		}
		if (src[i] === "{") depth++;
		else if (src[i] === "}") {
			depth--;
			if (depth === 0) return { content: src.slice(innerStart, i), end: i + 1 };
		}
	}
	return null;
}

/** Read a bracketed `[...]` group starting at `start`, returning its inner text and next index. */
function readBracketGroup(src: string, start: number): { content: string; end: number } | null {
	let i = start;
	while (i < src.length && /\s/.test(src[i]!)) i++;
	if (src[i] !== "[") return null;
	let depth = 0;
	const innerStart = i + 1;
	for (; i < src.length; i++) {
		if (src[i] === "\\" && i + 1 < src.length) {
			i++;
			continue;
		}
		if (src[i] === "[") depth++;
		else if (src[i] === "]") {
			depth--;
			if (depth === 0) return { content: src.slice(innerStart, i), end: i + 1 };
		}
	}
	return null;
}

/** Read a single LaTeX argument: either `{...}`, `\command`, or one character. */
function readArg(src: string, start: number): { content: string; end: number } | null {
	let i = start;
	while (i < src.length && /\s/.test(src[i]!)) i++;
	if (i >= src.length) return null;
	if (src[i] === "{") return readBraceGroup(src, i);
	if (src[i] === "\\") {
		let j = i + 1;
		while (j < src.length && /[A-Za-z]/.test(src[j]!)) j++;
		if (j === i + 1 && j < src.length) j++;
		return { content: src.slice(i, j), end: j };
	}
	return { content: src[i]!, end: i + 1 };
}

/** Read optional `_{...}` and `^{...}` bounds in either order (e.g. `\sum_{i=1}^{n}` or `\int^b_a`). */
function readBounds(src: string, start: number): { lower?: string; upper?: string; end: number } {
	let i = start;
	let lower: string | undefined;
	let upper: string | undefined;
	for (let pass = 0; pass < 2; pass++) {
		let j = i;
		while (j < src.length && /\s/.test(src[j]!)) j++;
		if (j < src.length && src[j] === "_" && lower === undefined) {
			const arg = readArg(src, j + 1);
			if (!arg) break;
			lower = arg.content;
			i = arg.end;
		} else if (j < src.length && src[j] === "^" && upper === undefined) {
			const arg = readArg(src, j + 1);
			if (!arg) break;
			upper = arg.content;
			i = arg.end;
		} else {
			break;
		}
	}
	return { lower, upper, end: i };
}

type DelimKind = "paren" | "square" | "brace" | "abs" | "norm";

interface DelimToken {
	kind: DelimKind;
	dir: "open" | "close" | "either";
	end: number;
}

/** Read an opening or closing delimiter token starting at `start` (handling `\left` / `\right` / size prefixes). */
function readDelimToken(src: string, start: number): DelimToken | null {
	let i = start;
	let side: "open" | "close" | null = null;
	if (src[i] === "\\") {
		let j = i + 1;
		while (j < src.length && /[A-Za-z]/.test(src[j]!)) j++;
		const cmd = src.slice(i + 1, j);
		if (cmd === "left") {
			side = "open";
			i = j;
			while (i < src.length && /\s/.test(src[i]!)) i++;
		} else if (cmd === "right") {
			side = "close";
			i = j;
			while (i < src.length && /\s/.test(src[i]!)) i++;
		} else if (DELIM_SIZE_COMMANDS.has(cmd)) {
			i = j;
			while (i < src.length && /\s/.test(src[i]!)) i++;
		} else if (cmd === "" && i + 1 < src.length) {
			const next = src[i + 1];
			if (next === "{") return { kind: "brace", dir: "open", end: i + 2 };
			if (next === "}") return { kind: "brace", dir: "close", end: i + 2 };
			if (next === "|") return { kind: "norm", dir: "either", end: i + 2 };
			return null;
		} else {
			return null;
		}
	}

	if (i >= src.length) return null;
	const ch = src[i]!;
	if (ch === "(") return { kind: "paren", dir: side ?? "open", end: i + 1 };
	if (ch === ")") return { kind: "paren", dir: side ?? "close", end: i + 1 };
	if (ch === "[") return { kind: "square", dir: side ?? "open", end: i + 1 };
	if (ch === "]") return { kind: "square", dir: side ?? "close", end: i + 1 };
	if (ch === "|") return { kind: "abs", dir: side ?? "either", end: i + 1 };
	if (ch === "\\" && i + 1 < src.length) {
		const next = src[i + 1];
		if (next === "{") return { kind: "brace", dir: side ?? "open", end: i + 2 };
		if (next === "}") return { kind: "brace", dir: side ?? "close", end: i + 2 };
		if (next === "|") return { kind: "norm", dir: side ?? "either", end: i + 2 };
	}
	return null;
}

/**
 * Scan from just after an opening delimiter of `openKind` until its matching
 * closing delimiter, rejecting mismatched or unclosed delimiters (returns null).
 */
function readBalancedDelimContent(
	src: string,
	contentStart: number,
	openKind: DelimKind,
): { content: string; end: number } | null {
	const stack: DelimKind[] = [openKind];
	let braceDepth = 0;
	let i = contentStart;

	while (i < src.length) {
		const ch = src[i]!;
		if (ch === "{") {
			braceDepth++;
			i++;
			continue;
		}
		if (ch === "}") {
			if (braceDepth === 0) return null;
			braceDepth--;
			i++;
			continue;
		}
		if (braceDepth > 0) {
			if (ch === "\\" && i + 1 < src.length) i += 2;
			else i++;
			continue;
		}

		// Reject invisible \left. or \right. (piecewise/evaluation bars -> formula)
		if (ch === "\\") {
			let j = i + 1;
			while (j < src.length && /[A-Za-z]/.test(src[j]!)) j++;
			const cmd = src.slice(i + 1, j);
			if (cmd === "left" || cmd === "right") {
				let k = j;
				while (k < src.length && /\s/.test(src[k]!)) k++;
				if (src[k] === ".") return null;
			}
		}

		const tok = readDelimToken(src, i);
		if (tok) {
			if (tok.dir === "open") {
				stack.push(tok.kind);
				i = tok.end;
				continue;
			}
			if (tok.dir === "close") {
				const top = stack[stack.length - 1];
				if (top !== tok.kind) return null;
				stack.pop();
				if (stack.length === 0) {
					return { content: src.slice(contentStart, i), end: tok.end };
				}
				i = tok.end;
				continue;
			}
			// Symmetric delimiter (`|` or `\|`): closes if matching top of stack, else ambiguous/nested.
			if (tok.dir === "either") {
				const top = stack[stack.length - 1];
				if (top === tok.kind) {
					stack.pop();
					if (stack.length === 0) {
						return { content: src.slice(contentStart, i), end: tok.end };
					}
					i = tok.end;
					continue;
				}
				// Symmetric delimiter inside non-matching group (e.g. P(A|B) or nested |...|):
				// if it's already on the stack we can't disambiguate, otherwise push only if not inside parens with single bar.
				if (stack.includes(tok.kind)) return null;
				stack.push(tok.kind);
				i = tok.end;
				continue;
			}
		}

		if (ch === "\\" && i + 1 < src.length) {
			let j = i + 1;
			while (j < src.length && /[A-Za-z]/.test(src[j]!)) j++;
			i = j === i + 1 ? i + 2 : j;
			continue;
		}
		i++;
	}

	return null;
}

interface VerbalizedLatex {
	text: string;
	/** Number of top-level tokens; 1 means atomic (safe to leave unwrapped in frac/pow/sub/sqrt). */
	tokens: number;
	/** True when the whole expression is already enclosed by an outer `open bracket ... close bracket`. */
	alreadyBracketed: boolean;
	/** True when the expression contains a comma/list separator. */
	hasComma: boolean;
	/** True when a sum/product/integral/limit body is still open at the end (no relation closed it). */
	openEnded: boolean;
}

/** Wrap a verbalized sub-expression when it holds more than one token and is not already bracketed. */
function wrapIfCompound(part: VerbalizedLatex): string {
	if (part.tokens <= 1 || part.alreadyBracketed) return part.text;
	return `open bracket ${part.text} close bracket`;
}

function skipSpaces(src: string, pos: number): number {
	let k = pos;
	while (k < src.length && /\s/.test(src[k]!)) k++;
	return k;
}

/**
 * True when a script just read (ending at `pos`) is followed by a second script of the same kind on the
 * same base (`a^b^c`, `e^{-x}^2`, `x_1_2`, `x^2'`), which KaTeX rejects with a "Double superscript" error.
 */
function hasDoubleScript(src: string, pos: number, kind: "^" | "_"): boolean {
	let k = skipSpaces(src, pos);
	const other = kind === "^" ? "_" : "^";
	if (src[k] === kind || (kind === "^" && src[k] === "'")) return true;
	if (src[k] !== other) return false;
	const next = readArg(src, k + 1);
	if (!next) return false;
	k = skipSpaces(src, next.end);
	return src[k] === "^" || src[k] === "_" || (other === "^" && src[k] === "'");
}

/** True when an unbraced one-character script is followed by a digit (`x_12`, `x^23`): TeX scripts only the first digit, which cannot be heard. */
function bareScriptRunsOn(src: string, argStart: number, argEnd: number): boolean {
	const k = skipSpaces(src, argStart);
	if (src[k] === "{" || src[k] === "\\") return false;
	return /[0-9]/.test(src[skipSpaces(src, argEnd)] ?? "");
}

/** True when nothing after a function argument could be heard as part of it (end, an operator, a relation or a closing delimiter). */
function isArgumentBoundary(src: string, pos: number): boolean {
	const k = skipSpaces(src, pos);
	if (k >= src.length) return true;
	const ch = src[k]!;
	if ("+-=<>,;:)]|".includes(ch)) return true;
	if (UNICODE_MATH[ch] && !UNICODE_ATOMIC_VALUES.has(ch)) return true;
	if (ch !== "\\") return false;
	let j = k + 1;
	while (j < src.length && /[A-Za-z]/.test(src[j]!)) j++;
	const cmd = src.slice(k + 1, j);
	if (cmd === "right") return true;
	if (cmd === "" ) return src[k + 1] === "|" || src[k + 1] === "}";
	return cmd in MATH_OPERATORS && !ATOMIC_SYMBOL_COMMANDS.has(cmd);
}

/**
 * Read the argument of a function written without a call bracket or with one (`\log_2 8`, `\sin^{-1} x`,
 * `\sin^{-1}(x)`). Returns its spoken form, wrapped by the usual rule, or null when the argument's extent
 * is not clear from the notation.
 */
function readFunctionArgument(src: string, pos: number, depth: number): { text: string; end: number } | null {
	const k = skipSpaces(src, pos);
	if (k >= src.length) return null;
	const delim = readDelimToken(src, k);
	if (delim && delim.kind === "paren" && delim.dir === "open") {
		const balanced = readBalancedDelimContent(src, delim.end, "paren");
		if (!balanced) return null;
		const inner = verbalizeLatex(balanced.content, depth + 1);
		if (inner === null || !inner.text || inner.openEnded) return null;
		// `\sin^{-1}(x)^2` — whether the power applies to the call or the argument is not spoken here.
		if (src[skipSpaces(src, balanced.end)] === "^") return null;
		const text = inner.tokens === 1 && !inner.hasComma && !inner.alreadyBracketed ? inner.text : wrapIfCompound(inner);
		return { text, end: balanced.end };
	}
	let text: string;
	let end: number;
	const ch = src[k]!;
	if (ch === "{") {
		const group = readBraceGroup(src, k);
		if (!group) return null;
		const inner = verbalizeLatex(group.content, depth + 1);
		if (inner === null || !inner.text || inner.openEnded) return null;
		text = wrapIfCompound(inner);
		end = group.end;
	} else if (/[0-9]/.test(ch)) {
		let j = k;
		while (j < src.length && /[0-9.]/.test(src[j]!)) j++;
		if (src[j - 1] === ".") return null;
		text = src.slice(k, j);
		end = j;
	} else if (/[A-Za-z]/.test(ch)) {
		text = ch;
		end = k + 1;
	} else if (ch === "\\") {
		let j = k + 1;
		while (j < src.length && /[A-Za-z]/.test(src[j]!)) j++;
		const cmd = src.slice(k + 1, j);
		if (!(cmd in GREEK_LETTERS)) return null;
		text = GREEK_LETTERS[cmd]!;
		end = j;
	} else {
		return null;
	}
	return isArgumentBoundary(src, end) ? { text, end } : null;
}

/** Convert a LaTeX math expression into spoken words, or the localised `"formula"` placeholder when unreliable or non-English. */
export function latexToSpeech(rawLatex: string, language: LessonLanguage = DEFAULT_LESSON_LANGUAGE): string {
	const trimmed = rawLatex.trim();
	if (!trimmed) return "";

	const phrases = phrasesFor(language);
	if (!phrases.verbalizeMath) return phrases.formula;

	// Complex multiline/tabular/matrix environments cannot be reliably spoken linearly.
	if (/\\begin\s*\{/.test(trimmed) || /\\end\s*\{/.test(trimmed)) {
		return phrases.formula;
	}

	const spoken = verbalizeLatex(trimmed, 0);
	if (!spoken || !spoken.text || /\\[A-Za-z]/.test(spoken.text)) {
		return phrases.formula;
	}
	return normalizeSpokenSpacing(spoken.text);
}

function verbalizeLatex(src: string, depth: number): VerbalizedLatex | null {
	if (depth > 8) return null;
	let out = "";
	let tokens = 0;
	let hasComma = false;
	let soleBracketed = false;
	let leadingUnaryMinus = false;
	// A sum/product/integral/limit whose body runs on: further additive terms make the reading ambiguous.
	let openBigOp = false;
	// Start (in `out`) of the function name a call bracket applies to, so `2 + f(x)^2` wraps only `f of x`.
	let fnStart = 0;
	const tokenState: { prev: "start" | "op" | "value" | "fn" | "fn-letter" } = { prev: "start" };
	let i = 0;

	const pushPart = (
		word: string,
		nextKind: "op" | "value" | "fn" | "fn-letter",
		tokenWeight = 1,
		isBracketed = false,
	) => {
		const w = word.trim();
		if (!w) return;
		const prevKind = tokenState.prev;
		if (out && !out.endsWith(" ")) out += " ";
		if ((nextKind === "fn" || nextKind === "fn-letter") && prevKind !== "fn" && prevKind !== "fn-letter") fnStart = out.length;
		out += w;
		if (tokens === 0 && isBracketed) soleBracketed = true;
		else soleBracketed = false;
		tokens += tokenWeight;
		tokenState.prev = nextKind;
	};

	const nextNonSpaceChar = (pos: number): string | undefined => {
		let k = pos;
		while (k < src.length && /\s/.test(src[k]!)) k++;
		return src[k];
	};

	while (i < src.length) {
		const ch = src[i]!;
		if (/\s/.test(ch)) {
			i++;
			continue;
		}
		if (ch === "{") {
			const group = readBraceGroup(src, i);
			if (!group) return null;
			const inner = verbalizeLatex(group.content, depth + 1);
			if (inner === null) return null;
			pushPart(inner.text, "value", inner.tokens, inner.alreadyBracketed);
			if (inner.hasComma) hasComma = true;
			// Braces are invisible: a sum inside them still runs on into what follows.
			if (inner.openEnded) openBigOp = true;
			i = group.end;
			continue;
		}
		if (ch === "}") {
			return null;
		}

		// Handle delimiters — including `\left(`, `\big[`, `(`, `[`, `\{`, `|`, `\|`.
		const delim = readDelimToken(src, i);
		if (delim) {
			if (delim.dir === "close") return null;
			const balanced = readBalancedDelimContent(src, delim.end, delim.kind);
			if (!balanced) return null;
			const inner = verbalizeLatex(balanced.content, depth + 1);
			if (inner === null || !inner.text) return null;
			i = balanced.end;

			if (delim.kind === "paren") {
				const isFnCall = tokenState.prev === "fn" || tokenState.prev === "fn-letter";
				if (isFnCall) {
					const followedByPower = nextNonSpaceChar(i) === "^";
					const argSpoken =
						inner.tokens === 1 && !inner.hasComma && !inner.alreadyBracketed && !followedByPower
							? inner.text
							: wrapIfCompound(inner);
					// If `f(x)^2`, wrap `open bracket f of x close bracket` so `^2` applies unambiguously to the call
					// (only the call: `2 + f(x)^2` keeps "2 plus" outside the bracket).
					if (followedByPower) {
						const head = out.slice(0, fnStart).trimEnd();
						const call = out.slice(fnStart).trim();
						out = `${head ? `${head} ` : ""}open bracket ${call} of ${argSpoken} close bracket`;
						tokens += 1 + inner.tokens;
						soleBracketed = head === "";
						tokenState.prev = "value";
					} else {
						pushPart(`of ${argSpoken}`, "value", 1 + inner.tokens);
					}
				} else {
					pushPart(`open bracket ${inner.text} close bracket`, "value", Math.max(2, inner.tokens + 1), true);
				}
				continue;
			}
			if (delim.kind === "square") {
				pushPart(`open square bracket ${inner.text} close square bracket`, "value", Math.max(2, inner.tokens + 1));
				continue;
			}
			if (delim.kind === "brace") {
				pushPart(`open brace ${inner.text} close brace`, "value", Math.max(2, inner.tokens + 1));
				continue;
			}
			if (delim.kind === "abs") {
				const body = wrapIfCompound(inner);
				pushPart(`absolute value of ${body}`, "value", Math.max(2, inner.tokens + 1));
				continue;
			}
			if (delim.kind === "norm") {
				const body = wrapIfCompound(inner);
				pushPart(`norm of ${body}`, "value", Math.max(2, inner.tokens + 1));
				continue;
			}
		}

		if (ch === "\\") {
			const next = src[i + 1];
			if (!next) return null;
			// Spacing & punctuation escapes
			if (next === "," || next === ";" || next === ":" || next === "!" || next === " ") {
				i += 2;
				continue;
			}
			if (next === "%") {
				pushPart("percent", "value");
				i += 2;
				continue;
			}
			if (next === "$") {
				pushPart("dollars", "value");
				i += 2;
				continue;
			}
			if (next === "\\") {
				// Line break inside math — too structured to read reliably
				return null;
			}
			if (!/[A-Za-z]/.test(next)) {
				return null;
			}
			let j = i + 1;
			while (j < src.length && /[A-Za-z]/.test(src[j]!)) j++;
			const cmd = src.slice(i + 1, j);
			i = j;

			if (SPACING_COMMANDS.has(cmd)) {
				continue;
			}

			if (cmd === "left" || cmd === "right") {
				// Unrecognized delimiter after \left/\right (e.g. \left. or \left\langle)
				return null;
			}

			if (cmd === "frac" || cmd === "dfrac" || cmd === "tfrac" || cmd === "cfrac") {
				const num = readArg(src, i);
				if (!num) return null;
				const den = readArg(src, num.end);
				if (!den) return null;
				i = den.end;
				const numRes = verbalizeLatex(num.content, depth + 1);
				const denRes = verbalizeLatex(den.content, depth + 1);
				if (numRes === null || denRes === null || !numRes.text || !denRes.text) return null;
				if (numRes.tokens === 1 && denRes.tokens === 1 && numRes.text === "1" && denRes.text === "2") {
					pushPart("one half", "value", 2);
				} else if (numRes.tokens === 1 && denRes.tokens === 1 && numRes.text === "1" && denRes.text === "3") {
					pushPart("one third", "value", 2);
				} else if (numRes.tokens === 1 && denRes.tokens === 1 && numRes.text === "1" && denRes.text === "4") {
					pushPart("one quarter", "value", 2);
				} else {
					pushPart(`${wrapIfCompound(numRes)} over ${wrapIfCompound(denRes)}`, "value", 2);
				}
				continue;
			}

			if (cmd === "sqrt") {
				const rootOpt = readBracketGroup(src, i);
				if (rootOpt) i = rootOpt.end;
				const arg = readArg(src, i);
				if (!arg) return null;
				i = arg.end;
				const inner = verbalizeLatex(arg.content, depth + 1);
				if (inner === null || !inner.text) return null;
				const body = wrapIfCompound(inner);
				if (!rootOpt) {
					pushPart(`square root of ${body}`, "value", 2);
				} else {
					const idx = verbalizeLatex(rootOpt.content, depth + 1);
					if (idx === null || !idx.text || idx.tokens > 1) return null;
					const n = idx.text;
					if (n === "2") pushPart(`square root of ${body}`, "value", 2);
					else if (n === "3") pushPart(`cube root of ${body}`, "value", 2);
					else pushPart(`${n}th root of ${body}`, "value", 2);
				}
				continue;
			}

			if (cmd === "sum" || cmd === "prod" || cmd === "int" || cmd === "iint" || cmd === "iiint" || cmd === "oint") {
				const word =
					cmd === "sum"
						? "sum"
						: cmd === "prod"
							? "product"
							: cmd === "oint"
								? "contour integral"
								: cmd === "iint"
									? "double integral"
									: cmd === "iiint"
										? "triple integral"
										: "integral";
				const bounds = readBounds(src, i);
				i = bounds.end;
				const lower = bounds.lower !== undefined ? verbalizeLatex(bounds.lower, depth + 1) : undefined;
				const upper = bounds.upper !== undefined ? verbalizeLatex(bounds.upper, depth + 1) : undefined;
				if (lower === null || upper === null) return null;
				if (lower && upper) pushPart(`${word} from ${lower.text} to ${upper.text} of`, "op", 2);
				else if (lower) pushPart(`${word} over ${lower.text} of`, "op", 2);
				else if (upper) pushPart(`${word} to ${upper.text} of`, "op", 2);
				else pushPart(cmd === "sum" || cmd === "prod" ? word : `${word} of`, "op", 2);
				openBigOp = true;
				continue;
			}

			if (cmd === "lim") {
				const bounds = readBounds(src, i);
				i = bounds.end;
				if (bounds.lower !== undefined) {
					const sub = verbalizeLatex(bounds.lower, depth + 1);
					if (sub === null) return null;
					const phrase = sub.text.replace(/\bto\b/, "approaches");
					pushPart(`limit as ${phrase} of`, "op", 2);
				} else {
					pushPart("limit", "op", 1);
				}
				openBigOp = true;
				continue;
			}

			if (cmd === "binom" || cmd === "dbinom" || cmd === "tbinom") {
				const top = readArg(src, i);
				if (!top) return null;
				const bot = readArg(src, top.end);
				if (!bot) return null;
				i = bot.end;
				const t = verbalizeLatex(top.content, depth + 1);
				const b = verbalizeLatex(bot.content, depth + 1);
				if (t === null || b === null || !t.text || !b.text) return null;
				pushPart(`${wrapIfCompound(t)} choose ${wrapIfCompound(b)}`, "value", 2);
				continue;
			}

			if (TEXT_UNWRAP_COMMANDS.has(cmd)) {
				const arg = readArg(src, i);
				if (!arg) return null;
				i = arg.end;
				const textContent = arg.content.trim();
				if (!textContent) continue;
				const wordCount = textContent.split(/\s+/).filter(Boolean).length;
				pushPart(textContent, "value", wordCount);
				continue;
			}

			if (MATH_UNWRAP_COMMANDS.has(cmd)) {
				const arg = readArg(src, i);
				if (!arg) return null;
				i = arg.end;
				const trimmedArg = arg.content.trim();
				if (/^[A-Za-z]+$/.test(trimmedArg)) {
					pushPart(trimmedArg, cmd === "operatorname" ? "fn" : "value", 1);
				} else {
					const inner = verbalizeLatex(arg.content, depth + 1);
					if (inner === null) return null;
					pushPart(inner.text, cmd === "operatorname" ? "fn" : "value", inner.tokens, inner.alreadyBracketed);
					if (inner.openEnded && cmd !== "boxed") openBigOp = true;
				}
				continue;
			}

			if (cmd in DECORATOR_SUFFIXES) {
				const arg = readArg(src, i);
				if (!arg) return null;
				i = arg.end;
				const inner = verbalizeLatex(arg.content, depth + 1);
				if (inner === null || !inner.text) return null;
				pushPart(`${wrapIfCompound(inner)} ${DECORATOR_SUFFIXES[cmd]}`, "value", 2);
				continue;
			}

			if (cmd in GREEK_LETTERS) {
				pushPart(GREEK_LETTERS[cmd]!, "value", 1);
				continue;
			}

			if (cmd in MATH_OPERATORS) {
				if (ADDITIVE_COMMANDS.has(cmd) && openBigOp) return null;
				if (RELATION_COMMANDS.has(cmd)) openBigOp = false;
				pushPart(MATH_OPERATORS[cmd]!, ATOMIC_SYMBOL_COMMANDS.has(cmd) ? "value" : "op", 1);
				continue;
			}

			if (cmd in MATH_FUNCTIONS) {
				const afterName = skipSpaces(src, i);
				// `\sin^{-1} x` is the inverse function, not a reciprocal power; other named functions with `^{-1}` are "formula".
				if (src[afterName] === "^") {
					const power = readArg(src, afterName + 1);
					if (power && power.content.trim() === "-1") {
						if (!INVERSE_NAMED_FUNCTIONS.has(cmd) || hasDoubleScript(src, power.end, "^")) return null;
						const arg = readFunctionArgument(src, power.end, depth);
						if (!arg) return null;
						pushPart(`inverse ${MATH_FUNCTIONS[cmd]!} of ${arg.text}`, "value", 2);
						i = arg.end;
						continue;
					}
				}
				// `\log_2 8` is "log base 2 of 8".
				if (cmd === "log" && src[afterName] === "_") {
					const base = readArg(src, afterName + 1);
					if (!base || hasDoubleScript(src, base.end, "_")) return null;
					if (src[skipSpaces(src, base.end)] === "^") return null;
					const baseSpoken = verbalizeLatex(base.content, depth + 1);
					if (baseSpoken === null || !baseSpoken.text) return null;
					const arg = readFunctionArgument(src, base.end, depth);
					if (!arg) return null;
					pushPart(`log base ${wrapIfCompound(baseSpoken)} of ${arg.text}`, "value", 2);
					i = arg.end;
					continue;
				}
				pushPart(MATH_FUNCTIONS[cmd]!, "fn", 1);
				continue;
			}

			// Unknown LaTeX command: fall back to neutral phrase rather than emitting raw command.
			return null;
		}

		if (ch === "^") {
			if (tokenState.prev === "start" || tokenState.prev === "op") return null;
			const wasFn = tokenState.prev === "fn";
			const arg = readArg(src, i + 1);
			if (!arg) return null;
			if (hasDoubleScript(src, arg.end, "^") || bareScriptRunsOn(src, i + 1, arg.end)) return null;
			i = arg.end;
			const rawExp = arg.content.trim();
			if (!rawExp) return null;
			// `f^{-1}(x)`: the inverse function applied to x. A bare `x^{-1}` stays a power.
			if (rawExp === "-1" && tokenState.prev === "fn-letter" && nextNonSpaceChar(i) === "(") {
				pushPart("inverse", "fn-letter", 1);
				continue;
			}
			if (rawExp === "\\circ" || rawExp === "\\degree") {
				pushPart("degrees", "value", 1);
				continue;
			}
			if (rawExp === "\\prime" || rawExp === "'") {
				pushPart("prime", tokenState.prev === "fn-letter" ? "fn-letter" : "value", 1);
				continue;
			}
			if (rawExp === "T" || rawExp === "\\top") {
				pushPart("transpose", "value", 1);
				continue;
			}
			const exp = verbalizeLatex(rawExp, depth + 1);
			if (exp === null || !exp.text) return null;
			const nextKind = wasFn ? "fn" : "value";
			if (exp.tokens === 1 && exp.text === "2") {
				pushPart("squared", nextKind, 1);
			} else if (exp.tokens === 1 && exp.text === "3") {
				pushPart("cubed", nextKind, 1);
			} else {
				pushPart(`to the power of ${wrapIfCompound(exp)}`, nextKind, 2);
			}
			continue;
		}

		if (ch === "_") {
			if (tokenState.prev === "start" || tokenState.prev === "op") return null;
			const wasFnLetter = tokenState.prev === "fn-letter";
			const arg = readArg(src, i + 1);
			if (!arg) return null;
			if (hasDoubleScript(src, arg.end, "_") || bareScriptRunsOn(src, i + 1, arg.end)) return null;
			i = arg.end;
			const sub = verbalizeLatex(arg.content, depth + 1);
			if (sub === null || !sub.text) return null;
			pushPart(`sub ${wrapIfCompound(sub)}`, wasFnLetter ? "fn-letter" : "value", 2);
			continue;
		}

		if (ch === "+") {
			if (openBigOp) return null;
			pushPart("plus", "op", 1);
			i++;
			continue;
		}
		if (ch === "-") {
			if (tokenState.prev === "value" || tokenState.prev === "fn-letter") {
				if (openBigOp) return null;
				pushPart("minus", "op", 1);
			} else {
				if (tokens === 0) leadingUnaryMinus = true;
				pushPart("negative", "op", 1);
			}
			i++;
			continue;
		}
		if (ch === "=") {
			openBigOp = false;
			pushPart("equals", "op", 1);
			i++;
			continue;
		}
		if (ch === "<") {
			openBigOp = false;
			pushPart("less than", "op", 1);
			i++;
			continue;
		}
		if (ch === ">") {
			openBigOp = false;
			pushPart("greater than", "op", 1);
			i++;
			continue;
		}
		if (ch === "*") {
			pushPart("times", "op", 1);
			i++;
			continue;
		}
		if (ch === "/") {
			pushPart("over", "op", 1);
			i++;
			continue;
		}
		if (ch === "'") {
			pushPart("prime", tokenState.prev === "fn-letter" ? "fn-letter" : "value", 1);
			i++;
			continue;
		}
		if (ch === "!") {
			pushPart("factorial", "value", 1);
			i++;
			continue;
		}
		if (ch === "%") {
			pushPart("percent", "value", 1);
			i++;
			continue;
		}
		if (ch === "," || ch === ";" || ch === ":") {
			if (openBigOp) return null;
			if (out && !out.endsWith(" ")) out += ",";
			hasComma = true;
			tokens += 1;
			soleBracketed = false;
			tokenState.prev = "op";
			i++;
			continue;
		}

		// Numbers (e.g. 3.14, 100)
		if (/[0-9]/.test(ch)) {
			let j = i;
			while (j < src.length && /[0-9.]/.test(src[j]!)) j++;
			// `0.\overline{3}`: a trailing point before more notation would be heard as a pause.
			if (src[j - 1] === "." && skipSpaces(src, j) < src.length) return null;
			pushPart(src.slice(i, j), "value", 1);
			i = j;
			continue;
		}

		// Plain identifier letters: single math variables separated so `ab` reads as "a b" (2 tokens)
		if (/[A-Za-z]/.test(ch)) {
			let j = i;
			while (j < src.length && /[A-Za-z]/.test(src[j]!)) j++;
			const letters = src.slice(i, j);
			if (letters.length === 1) {
				pushPart(letters, FUNCTION_LETTERS.has(letters) ? "fn-letter" : "value", 1);
			} else {
				for (let k = 0; k < letters.length; k++) {
					const letter = letters[k]!;
					pushPart(letter, "value", 1);
				}
			}
			i = j;
			continue;
		}

		// Unicode math symbols that may appear directly
		const unicodeSpoken = UNICODE_MATH[ch];
		if (unicodeSpoken) {
			if (ch === "−") {
				if (tokenState.prev === "value" || tokenState.prev === "fn-letter") {
					if (openBigOp) return null;
					pushPart("minus", "op", 1);
				} else {
					if (tokens === 0) leadingUnaryMinus = true;
					pushPart("negative", "op", 1);
				}
			} else {
				if (UNICODE_ADDITIVE.has(ch) && openBigOp) return null;
				if (UNICODE_RELATIONS.has(ch)) openBigOp = false;
				pushPart(unicodeSpoken, UNICODE_ATOMIC_VALUES.has(ch) ? "value" : "op", 1);
			}
			i++;
			continue;
		}

		// Unrecognized character in math: fall back to "formula" rather than silently dropping it.
		return null;
	}

	const text = out.trim();
	// A single signed atom like `-1`, `-3`, or `-x` (leading unary minus + one atom) is unambiguous unwrapped.
	const effectiveTokens = leadingUnaryMinus && tokens === 2 ? 1 : tokens;
	return {
		text,
		tokens: effectiveTokens,
		alreadyBracketed: soleBracketed,
		hasComma,
		openEnded: openBigOp,
	};
}

// ─── Linear-time Markdown emphasis stripping & prose normalization ───────────

/**
 * Strip paired Markdown emphasis/strikethrough delimiters (`**`, `__`, `~~`, `*`, `_`)
 * in strictly linear O(n) time without backtracking regexes.
 */
function stripLinearEmphasis(text: string): string {
	let result = stripPairedDouble(text, "*", false);
	result = stripPairedDouble(result, "_", true);
	result = stripPairedDouble(result, "~", false);
	result = stripPairedSingle(result, "*", false);
	result = stripPairedSingle(result, "_", true);
	return result;
}

function isWordChar(ch: string | undefined): boolean {
	return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

function stripPairedDouble(text: string, marker: string, respectWordBoundary: boolean): string {
	const drop = new Uint8Array(text.length);
	const stack: number[] = [];
	let i = 0;
	while (i < text.length - 1) {
		if (text[i] === marker && text[i + 1] === marker) {
			const prev = i > 0 ? text[i - 1] : undefined;
			const next = i + 2 < text.length ? text[i + 2] : undefined;
			const canClose =
				stack.length > 0 &&
				prev !== undefined &&
				!/\s/.test(prev) &&
				(!respectWordBoundary || !isWordChar(next));
			const canOpen =
				next !== undefined &&
				!/\s/.test(next) &&
				(!respectWordBoundary || !isWordChar(prev));

			if (canClose) {
				const openPos = stack.pop()!;
				drop[openPos] = 1;
				drop[openPos + 1] = 1;
				drop[i] = 1;
				drop[i + 1] = 1;
			} else if (canOpen) {
				stack.push(i);
			}
			i += 2;
			continue;
		}
		i++;
	}
	if (stack.length === 0 && !drop.includes(1)) return text;
	let out = "";
	for (let k = 0; k < text.length; k++) {
		if (!drop[k]) out += text[k]!;
	}
	return out;
}

function stripPairedSingle(text: string, marker: string, respectWordBoundary: boolean): string {
	const drop = new Uint8Array(text.length);
	const stack: number[] = [];
	for (let i = 0; i < text.length; i++) {
		if (text[i] !== marker) continue;
		const prev = i > 0 ? text[i - 1] : undefined;
		const next = i + 1 < text.length ? text[i + 1] : undefined;
		// Do not consume part of an unpaired double marker
		if (prev === marker || next === marker) continue;

		const canClose =
			stack.length > 0 &&
			prev !== undefined &&
			!/\s/.test(prev) &&
			(!respectWordBoundary || !isWordChar(next));
		const canOpen =
			next !== undefined &&
			!/\s/.test(next) &&
			(!respectWordBoundary || !isWordChar(prev));

		if (canClose) {
			const openPos = stack.pop()!;
			drop[openPos] = 1;
			drop[i] = 1;
		} else if (canOpen) {
			stack.push(i);
		}
	}
	if (!drop.includes(1)) return text;
	let out = "";
	for (let k = 0; k < text.length; k++) {
		if (!drop[k]) out += text[k]!;
	}
	return out;
}

function normalizeSpokenSpacing(text: string): string {
	return text
		.replace(/\s+/g, " ")
		.replace(/\s+([,.;:?!])/g, "$1")
		.trim();
}

function cleanProseText(rawText: string, language: LessonLanguage): string {
	const phrases = phrasesFor(language);
	let text = stripLinearEmphasis(rawText);
	// Strip stray unreferenced footnote markers like [^1]
	if (text.includes("[^")) {
		text = text.replace(/\[\^[^\]\s]{1,64}\]/g, "");
	}
	// Handle bare scientific/math superscripts & subscripts outside $...$ (e.g. 10^{-3}, a_{n+1})
	if (text.includes("^{")) {
		text = text.replace(/(?<![A-Za-z0-9])([A-Za-z0-9]{1,24})\^\{([^{}]{1,200})\}/g, (match) => latexToSpeech(match, language));
	}
	if (text.includes("_{")) {
		text = text.replace(/(?<![A-Za-z0-9])([A-Za-z0-9]{1,24})_\{([^{}]{1,200})\}/g, (match) => latexToSpeech(match, language));
	}
	// Replace bare URLs in prose with localised link word
	if (text.includes("://")) {
		text = text.replace(/https?:\/\/\S+/gi, phrases.link);
	}
	// Safety net: never emit a raw LaTeX command in prose
	if (text.includes("\\")) {
		text = text.replace(/\\[A-Za-z]+(?:\{[^}]{0,200}\})*/g, phrases.formula);
	}
	return text;
}

// ─── HAST walking (mirrors ToolContentResponse's visible DOM) ────────────────

function classList(node: Element): string[] {
	const cls: unknown = node.properties?.className;
	if (Array.isArray(cls)) return cls.map(String);
	if (typeof cls === "string") return cls.split(/\s+/).filter(Boolean);
	return [];
}

function codeLanguage(node: Element): string {
	for (const cls of classList(node)) {
		if (cls.startsWith("language-")) return cls.slice("language-".length).toLowerCase();
	}
	return "";
}

function rawTextOf(node: Root | Element | ElementContent): string {
	if (node.type === "text") return node.value;
	if ("children" in node && Array.isArray(node.children)) {
		return node.children.map((c) => rawTextOf(c as ElementContent)).join("");
	}
	return "";
}

function isFootnoteRefLink(node: Element): boolean {
	if (node.tagName !== "a") return false;
	const props = node.properties ?? {};
	return "dataFootnoteRef" in props || "dataFootnoteBackref" in props;
}

function isDetailsOpen(node: Element): boolean {
	const props = node.properties ?? {};
	return "open" in props && props.open !== false && props.open !== undefined;
}

/** What a `<details>` shows: everything when open, otherwise only its FIRST `<summary>` child (a browser shows no other). */
function visibleDetailsChildren(node: Element): ElementContent[] {
	if (isDetailsOpen(node)) return node.children;
	const summary = node.children.find((c): c is Element => c.type === "element" && c.tagName === "summary");
	return summary ? [summary] : [];
}

function isBlockElement(tagName: string): boolean {
	return (
		tagName === "p" ||
		tagName === "div" ||
		tagName === "section" ||
		tagName === "article" ||
		tagName === "blockquote" ||
		tagName === "pre" ||
		tagName === "ul" ||
		tagName === "ol" ||
		tagName === "li" ||
		tagName === "dl" ||
		tagName === "dt" ||
		tagName === "dd" ||
		tagName === "table" ||
		tagName === "tr" ||
		tagName === "details" ||
		tagName === "summary" ||
		/^h[1-6]$/.test(tagName)
	);
}

function stripBlockquoteAlertMarker(children: ElementContent[]): ElementContent[] {
	const firstElIdx = children.findIndex((c) => c.type === "element" || (c.type === "text" && c.value.trim() !== ""));
	if (firstElIdx === -1) return children;
	const first = children[firstElIdx]!;
	if (first.type !== "element" || first.tagName !== "p") return children;
	const pFirstIdx = first.children.findIndex((c) => c.type === "element" || (c.type === "text" && c.value.trim() !== ""));
	if (pFirstIdx === -1) return children;
	const lead = first.children[pFirstIdx]!;
	if (lead.type !== "text") return children;
	const m = ALERT_MARKER_RE.exec(lead.value);
	if (!m) return children;
	const restText = lead.value.slice(m[0].length);
	const nextParagraphChildren = first.children
		.map((c, idx) => (idx === pFirstIdx ? { type: "text" as const, value: restText } : c))
		.filter((c) => !(c.type === "text" && c.value === ""));
	const updatedFirst: Element = { ...first, children: nextParagraphChildren };
	return children.map((c, idx) => (idx === firstElIdx ? updatedFirst : c));
}

function collectBlocksFromHast(root: Root, language: LessonLanguage): string[] {
	const phrases = phrasesFor(language);
	const blocks: string[] = [];
	let current = "";

	const flush = () => {
		const cleaned = normalizeSpokenSpacing(current);
		if (cleaned) blocks.push(cleaned);
		current = "";
	};

	const appendInline = (chunk: string) => {
		if (!chunk) return;
		if (current && !/\s$/.test(current) && !/^[\s,.;:?!]/.test(chunk)) {
			current += " ";
		}
		current += chunk;
	};

	const walkInline = (node: RootContent): string => {
		if (node.type === "text") {
			return cleanProseText(node.value, language);
		}
		if (node.type !== "element") return "";
		const tag = node.tagName;
		const classes = classList(node);
		if (classes.includes("sr-only")) return "";
		if (tag === "br") return " ";
		if (tag === "hr") return "";
		if (tag === "img") {
			const alt = typeof node.properties?.alt === "string" ? node.properties.alt.trim() : "";
			return alt || phrases.image;
		}
		if (isFootnoteRefLink(node)) return "";
		if (tag === "sup") {
			const nonEmpty = node.children.filter((c) => !(c.type === "text" && !c.value.trim()));
			if (nonEmpty.length > 0 && nonEmpty.every((c) => c.type === "element" && isFootnoteRefLink(c))) {
				return "";
			}
		}
		if (tag === "a") {
			const inner = node.children.map(walkInline).join("").trim();
			if (!inner) return "";
			if (/^https?:\/\/\S+$/i.test(inner)) return phrases.link;
			return inner;
		}
		if (tag === "code") {
			const lang = codeLanguage(node);
			const rawCode = rawTextOf(node);
			if (lang === "math" || classes.includes("math-inline") || classes.includes("math-display")) {
				const spoken = latexToSpeech(rawCode, language);
				return spoken ? ` ${spoken} ` : "";
			}
			const normalized = rawCode.replace(/\s+/g, " ").trim();
			if (!normalized) return "";
			if (RAW_BACKSLASH_COMMAND_RE.test(normalized)) {
				return ` ${phrases.inlineCode} `;
			}
			return normalized;
		}
		if (tag === "details") {
			return visibleDetailsChildren(node).map(walkInline).join(" ");
		}
		return node.children.map(walkInline).join("");
	};

	const walkBlock = (node: RootContent): void => {
		if (node.type === "text") {
			if (node.value.trim()) appendInline(cleanProseText(node.value, language));
			return;
		}
		if (node.type !== "element") return;
		const tag = node.tagName;
		const classes = classList(node);
		if (classes.includes("sr-only")) return;
		if (tag === "hr") {
			flush();
			return;
		}

		// Collapsed <details> contributes ONLY its <summary>; open <details> contributes summary + body.
		if (tag === "details") {
			flush();
			for (const child of visibleDetailsChildren(node)) walkBlock(child);
			flush();
			return;
		}

		if (tag === "blockquote") {
			flush();
			const kids = stripBlockquoteAlertMarker(node.children);
			for (const child of kids) walkBlock(child);
			flush();
			return;
		}

		if (tag === "pre") {
			flush();
			const codeEl = node.children.find((c): c is Element => c.type === "element" && c.tagName === "code");
			const lang = codeEl ? codeLanguage(codeEl) : "";
			if (lang === "math" || (codeEl && classList(codeEl).includes("math-display"))) {
				const spoken = latexToSpeech(rawTextOf(codeEl ?? node), language);
				if (spoken) blocks.push(spoken);
			} else if (DIAGRAM_LANGUAGES.has(lang)) {
				blocks.push(phrases.diagram);
			} else {
				blocks.push(phrases.codeBlock);
			}
			return;
		}

		if (tag === "table") {
			flush();
			const walkRows = (el: Element) => {
				for (const child of el.children) {
					if (child.type !== "element") continue;
					if (child.tagName === "tr") {
						const cells = child.children
							.filter((c): c is Element => c.type === "element" && (c.tagName === "th" || c.tagName === "td"))
							.map((cell) => normalizeSpokenSpacing(cell.children.map(walkInline).join("")))
							.filter(Boolean);
						if (cells.length > 0) blocks.push(`${cells.join(", ")}.`);
					} else {
						walkRows(child);
					}
				}
			};
			walkRows(node);
			return;
		}

		if (isBlockElement(tag)) {
			flush();
			const hasBlockChild = node.children.some((c) => c.type === "element" && isBlockElement(c.tagName));
			if (hasBlockChild) {
				for (const child of node.children) walkBlock(child);
			} else {
				for (const child of node.children) appendInline(walkInline(child));
			}
			flush();
			return;
		}

		appendInline(walkInline(node));
	};

	for (const child of root.children) {
		walkBlock(child);
	}
	flush();
	return blocks;
}

/**
 * The parse stage on its own: displayed Markdown through the same CommonMark/GFM/math + raw HTML + HAST sanitisation
 * pipeline as `ToolContentResponse`, as the sanitised HAST the screen is built from. No speech vocabulary here, so other
 * readers of "what is on screen" (core/visible-text.ts, the vocabulary ledger) share it. Pure, no DOM.
 */
export function displayedMarkdownHast(markdown: string): Root {
	const needsMathPrepass = markdown.includes("\\") || (markdown.includes("$") && /[\b\t\n\v\f\r]/.test(markdown));
	const prepared = (needsMathPrepass ? transformMathDelimiters(repairMathForDisplay(markdown)) : markdown).replace(/\r\n?/g, "\n");
	const mdast = fromMarkdown(prepared, {
		extensions: MD_EXTENSIONS,
		mdastExtensions: MDAST_EXTENSIONS,
	});
	const rawHast = raw(toHast(mdast, { allowDangerousHtml: true }) as Root) as Root;
	return sanitize(rawHast, SPEECH_SANITIZE_SCHEMA) as Root;
}

/**
 * Parse and sanitise displayed Markdown through the same CommonMark/GFM/math
 * + raw HTML + HAST sanitisation pipeline as `ToolContentResponse`, converting
 * only visible content into clean speakable prose. Pure, no DOM.
 */
export function markdownToSpeech(markdown: string, language: LessonLanguage = DEFAULT_LESSON_LANGUAGE): string {
	if (!markdown.trim()) return "";

	const blocks = collectBlocksFromHast(displayedMarkdownHast(markdown), language);
	return blocks
		.map((b, idx) => (idx < blocks.length - 1 && !/[.!?:]$/.test(b) ? `${b}.` : b))
		.join(" ");
}

// ─── Sentence splitting (adapted from amoghu1s1/twig src/core/sentence-reader.ts, AGPL-3.0) ──

const ABBREVIATIONS = new Set([
	// English
	"mr.",
	"mrs.",
	"ms.",
	"dr.",
	"prof.",
	"sr.",
	"jr.",
	"st.",
	"vs.",
	"etc.",
	"eg.",
	"e.g.",
	"ie.",
	"i.e.",
	"fig.",
	"eq.",
	"eqs.",
	"no.",
	"vol.",
	"ch.",
	"sec.",
	"cf.",
	"al.",
	"inc.",
	"ltd.",
	"approx.",
	"min.",
	"max.",
	"avg.",
	"dept.",
	"est.",
	"jan.",
	"feb.",
	"mar.",
	"apr.",
	"jun.",
	"jul.",
	"aug.",
	"sep.",
	"sept.",
	"oct.",
	"nov.",
	"dec.",
	// Norwegian
	"f.eks.",
	"bl.a.",
	"osv.",
	"ca.",
	"nr.",
	"kap.",
	"dvs.",
	"m.m.",
	"o.l.",
	"jf.",
]);

function shouldMergeSegments(left: string, right: string): boolean {
	const trimmedLeft = left.trimEnd();
	const trimmedRight = right.trimStart();
	if (!trimmedLeft || !trimmedRight) return false;
	const lastWord = trimmedLeft.match(/([A-Za-zÆØÅæøå]+(?:\.[A-Za-zÆØÅæøå]+)*\.)$/)?.[1]?.toLowerCase();
	if (!lastWord) return false;
	if (ABBREVIATIONS.has(lastWord)) return true;
	// Single capital initial followed by a capitalized word (e.g. "J. Smith")
	if (/^[a-zæøå]\.$/.test(lastWord) && /^[A-ZÆØÅ]/.test(trimmedRight)) return true;
	return false;
}

function segmentSentences(text: string, locale: string): string[] {
	const rawSegments: string[] = [];
	if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
		const segmenter = new Intl.Segmenter(locale, { granularity: "sentence" });
		for (const part of segmenter.segment(text)) {
			if (part.segment.trim()) rawSegments.push(part.segment);
		}
	} else {
		const fallback = text.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) ?? [text];
		for (const part of fallback) {
			if (part.trim()) rawSegments.push(part);
		}
	}

	const merged: string[] = [];
	for (const seg of rawSegments) {
		if (merged.length > 0 && shouldMergeSegments(merged[merged.length - 1]!, seg)) {
			merged[merged.length - 1] = `${merged[merged.length - 1]!.trimEnd()} ${seg.trim()}`;
		} else {
			merged.push(seg.trim());
		}
	}
	return merged.filter(Boolean);
}

/** Split an overly long sentence at clause or word boundaries so Stop is prompt and TTS engines don't truncate. */
function splitLongSentence(sentence: string, maxChars: number): string[] {
	if (sentence.length <= maxChars) return [sentence];
	const chunks: string[] = [];
	let remaining = sentence.trim();
	while (remaining.length > maxChars) {
		const slice = remaining.slice(0, maxChars);
		// Prefer splitting after a semicolon, colon, dash, or comma in the back half of the window.
		const minPos = Math.floor(maxChars * 0.35);
		let splitAt = -1;
		for (const sep of ["; ", ": ", " — ", " - ", ", "]) {
			const idx = slice.lastIndexOf(sep);
			if (idx >= minPos) {
				splitAt = idx + sep.length;
				break;
			}
		}
		if (splitAt === -1) {
			const spaceIdx = slice.lastIndexOf(" ");
			splitAt = spaceIdx > 0 ? spaceIdx + 1 : maxChars;
		}
		const head = remaining.slice(0, splitAt).trim();
		if (head) chunks.push(head);
		remaining = remaining.slice(splitAt).trim();
	}
	if (remaining) chunks.push(remaining);
	return chunks;
}

/** Split spoken text into sentence-sized utterances bounded by `maxChars`. */
export function splitSpeechUtterances(
	text: string,
	maxChars = DEFAULT_MAX_UTTERANCE_CHARS,
	language: LessonLanguage = DEFAULT_LESSON_LANGUAGE,
): string[] {
	const cleaned = normalizeSpokenSpacing(text);
	if (!cleaned) return [];
	const { locale } = phrasesFor(language);
	return segmentSentences(cleaned, locale).flatMap((s) => splitLongSentence(s, maxChars));
}

/**
 * Build the ordered list of speakable utterances for a displayed pending question.
 * Only takes what is displayed to the learner: question, optional context, and
 * displayed options in displayed order with displayed letters.
 */
export function buildQuestionSpeech(input: QuestionSpeechInput, maxChars = DEFAULT_MAX_UTTERANCE_CHARS): string[] {
	const language = input.language ?? DEFAULT_LESSON_LANGUAGE;
	const utterances: string[] = [];

	const questionText = markdownToSpeech(input.question, language);
	if (questionText) {
		utterances.push(...splitSpeechUtterances(questionText, maxChars, language));
	}

	if (input.context) {
		const contextText = markdownToSpeech(input.context, language);
		if (contextText) {
			utterances.push(...splitSpeechUtterances(contextText, maxChars, language));
		}
	}

	if (input.options?.length) {
		for (const opt of input.options) {
			const labelText = markdownToSpeech(opt.label, language);
			if (!labelText) continue;
			const descText = opt.description ? markdownToSpeech(opt.description, language) : "";
			const body = descText ? `${labelText}${/[.!?:]$/.test(labelText) ? "" : "."} ${descText}` : labelText;
			const prefix = opt.letter ? `${opt.letter}: ` : "";
			utterances.push(...splitSpeechUtterances(`${prefix}${body}`, maxChars, language));
		}
	}

	return utterances;
}
