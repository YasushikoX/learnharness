/**
 * Pure text-to-speech preparation for pending questions (no DOM / no Node).
 *
 * Converts displayed Markdown (including LaTeX math, inline code, and fenced
 * code blocks) and displayed options into clean, sentence-sized utterances fit
 * for `window.speechSynthesis`. Never emits raw LaTeX backslash commands.
 *
 * Sentence boundary masking (`maskSpans`) and abbreviation-aware merging
 * (`shouldMergeSegments`) are adapted from `amoghu1s1/twig`
 * (`src/core/sentence-reader.ts`, AGPL-3.0).
 */

import { repairMathForDisplay } from "./math-delims.ts";

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
}

const DEFAULT_MAX_UTTERANCE_CHARS = 220;
const MATH_FALLBACK = "formula";

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
	circ: "degrees",
	degree: "degrees",
	prime: "prime",
	ell: "l",
	hbar: "h bar",
	Re: "real part",
	Im: "imaginary part",
	aleph: "aleph",
};

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

const UNWRAP_COMMANDS = new Set([
	"text",
	"textrm",
	"textbf",
	"textit",
	"textup",
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
	"mbox",
	"hbox",
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

const STRIP_COMMANDS = new Set([
	"left",
	"right",
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
	"vphantom",
	"phantom",
]);

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

/** Convert a LaTeX math expression into spoken words, or `"formula"` when unreliable. */
export function latexToSpeech(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return "";

	// Complex multiline/tabular/matrix environments cannot be reliably spoken linearly.
	if (/\\begin\s*\{/.test(trimmed) || /\\end\s*\{/.test(trimmed)) {
		return MATH_FALLBACK;
	}

	const spoken = verbalizeLatex(trimmed, 0);
	if (spoken === null) return MATH_FALLBACK;
	const cleaned = normalizeSpokenSpacing(spoken);
	if (!cleaned) return MATH_FALLBACK;
	// Hard safety guarantee: never emit raw backslash commands or unbalanced TeX braces.
	if (/\\[A-Za-z]+/.test(cleaned) || /[{}]/.test(cleaned)) return MATH_FALLBACK;
	return cleaned;
}

function verbalizeLatex(src: string, depth: number): string | null {
	if (depth > 8) return null;
	let out = "";
	let i = 0;
	let prevToken: "value" | "op" | "none" = "none";

	const pushWord = (word: string, kind: "value" | "op") => {
		if (!word) return;
		if (out && !out.endsWith(" ")) out += " ";
		out += word;
		prevToken = kind;
	};

	while (i < src.length) {
		const ch = src[i]!;

		if (/\s/.test(ch)) {
			i++;
			continue;
		}
		if (ch === "~") {
			i++;
			continue;
		}
		if (ch === "{") {
			const group = readBraceGroup(src, i);
			if (!group) return null;
			const inner = verbalizeLatex(group.content, depth + 1);
			if (inner === null) return null;
			pushWord(inner, "value");
			i = group.end;
			continue;
		}
		if (ch === "}") {
			return null;
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
				pushWord("percent", "value");
				i += 2;
				continue;
			}
			if (next === "{" || next === "}") {
				i += 2;
				continue;
			}
			if (next === "|") {
				pushWord("norm", "op");
				i += 2;
				continue;
			}
			if (next === "\\") {
				// Line break inside math — too structured to read reliably
				return null;
			}
			if (!/[A-Za-z]/.test(next)) {
				i += 2;
				continue;
			}
			let j = i + 1;
			while (j < src.length && /[A-Za-z]/.test(src[j]!)) j++;
			const cmd = src.slice(i + 1, j);
			i = j;

			if (STRIP_COMMANDS.has(cmd)) {
				continue;
			}

			if (cmd === "frac" || cmd === "dfrac" || cmd === "tfrac" || cmd === "cfrac") {
				const num = readArg(src, i);
				if (!num) return null;
				const den = readArg(src, num.end);
				if (!den) return null;
				i = den.end;
				const numText = verbalizeLatex(num.content, depth + 1);
				const denText = verbalizeLatex(den.content, depth + 1);
				if (numText === null || denText === null || !numText || !denText) return null;
				const numTrim = numText.trim();
				const denTrim = denText.trim();
				if (numTrim === "1" && denTrim === "2") pushWord("one half", "value");
				else if (numTrim === "1" && denTrim === "3") pushWord("one third", "value");
				else if (numTrim === "1" && denTrim === "4") pushWord("one quarter", "value");
				else pushWord(`${numTrim} over ${denTrim}`, "value");
				continue;
			}

			if (cmd === "sqrt") {
				const rootOpt = readBracketGroup(src, i);
				if (rootOpt) i = rootOpt.end;
				const arg = readArg(src, i);
				if (!arg) return null;
				i = arg.end;
				const inner = verbalizeLatex(arg.content, depth + 1);
				if (inner === null || !inner) return null;
				if (!rootOpt) {
					pushWord(`square root of ${inner.trim()}`, "value");
				} else {
					const idx = verbalizeLatex(rootOpt.content, depth + 1);
					if (idx === null || !idx) return null;
					const n = idx.trim();
					if (n === "2") pushWord(`square root of ${inner.trim()}`, "value");
					else if (n === "3") pushWord(`cube root of ${inner.trim()}`, "value");
					else pushWord(`${n}th root of ${inner.trim()}`, "value");
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
				if (lower && upper) pushWord(`${word} from ${lower.trim()} to ${upper.trim()} of`, "op");
				else if (lower) pushWord(`${word} over ${lower.trim()} of`, "op");
				else if (upper) pushWord(`${word} to ${upper.trim()} of`, "op");
				else pushWord(cmd === "sum" || cmd === "prod" ? word : `${word} of`, "op");
				continue;
			}

			if (cmd === "lim") {
				const bounds = readBounds(src, i);
				i = bounds.end;
				if (bounds.lower !== undefined) {
					const sub = verbalizeLatex(bounds.lower, depth + 1);
					if (sub === null) return null;
					const phrase = sub.trim().replace(/\bto\b/, "approaches");
					pushWord(`limit as ${phrase} of`, "op");
				} else {
					pushWord("limit", "op");
				}
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
				if (t === null || b === null) return null;
				pushWord(`${t.trim()} choose ${b.trim()}`, "value");
				continue;
			}

			if (UNWRAP_COMMANDS.has(cmd)) {
				const arg = readArg(src, i);
				if (!arg) return null;
				i = arg.end;
				if (cmd === "text" || cmd === "textrm" || cmd === "textbf" || cmd === "textit" || cmd === "textup" || cmd === "mbox" || cmd === "hbox") {
					pushWord(arg.content.trim(), "value");
				} else {
					const inner = verbalizeLatex(arg.content, depth + 1);
					if (inner === null) return null;
					pushWord(inner, "value");
				}
				continue;
			}

			if (cmd in DECORATOR_SUFFIXES) {
				const arg = readArg(src, i);
				if (!arg) return null;
				i = arg.end;
				const inner = verbalizeLatex(arg.content, depth + 1);
				if (inner === null) return null;
				pushWord(`${inner.trim()} ${DECORATOR_SUFFIXES[cmd]}`, "value");
				continue;
			}

			if (cmd in GREEK_LETTERS) {
				pushWord(GREEK_LETTERS[cmd]!, "value");
				continue;
			}

			if (cmd in MATH_OPERATORS) {
				pushWord(MATH_OPERATORS[cmd]!, "op");
				continue;
			}

			if (cmd in MATH_FUNCTIONS) {
				pushWord(MATH_FUNCTIONS[cmd]!, "op");
				continue;
			}

			// Unknown LaTeX command: fall back to neutral phrase rather than emitting raw command.
			return null;
		}

		if (ch === "^") {
			const arg = readArg(src, i + 1);
			if (!arg) return null;
			i = arg.end;
			const rawExp = arg.content.trim();
			if (rawExp === "\\circ" || rawExp === "\\degree") {
				pushWord("degrees", "value");
				continue;
			}
			if (rawExp === "\\prime" || rawExp === "'") {
				pushWord("prime", "value");
				continue;
			}
			if (rawExp === "T" || rawExp === "\\top") {
				pushWord("transpose", "value");
				continue;
			}
			const exp = verbalizeLatex(rawExp, depth + 1);
			if (exp === null || !exp) return null;
			const expTrim = exp.trim();
			if (expTrim === "2") pushWord("squared", "value");
			else if (expTrim === "3") pushWord("cubed", "value");
			else if (expTrim === "minus 1" || expTrim === "-1") pushWord("to the power of minus 1", "value");
			else pushWord(`to the power of ${expTrim}`, "value");
			continue;
		}

		if (ch === "_") {
			const arg = readArg(src, i + 1);
			if (!arg) return null;
			i = arg.end;
			const sub = verbalizeLatex(arg.content, depth + 1);
			if (sub === null || !sub) return null;
			pushWord(`sub ${sub.trim()}`, "value");
			continue;
		}

		if (ch === "+") {
			pushWord("plus", "op");
			i++;
			continue;
		}
		if (ch === "-") {
			pushWord(prevToken === "value" ? "minus" : "negative", "op");
			i++;
			continue;
		}
		if (ch === "=") {
			pushWord("equals", "op");
			i++;
			continue;
		}
		if (ch === "<") {
			pushWord("less than", "op");
			i++;
			continue;
		}
		if (ch === ">") {
			pushWord("greater than", "op");
			i++;
			continue;
		}
		if (ch === "*") {
			pushWord("times", "op");
			i++;
			continue;
		}
		if (ch === "/") {
			pushWord("over", "op");
			i++;
			continue;
		}
		if (ch === "'") {
			pushWord("prime", "value");
			i++;
			continue;
		}
		if (ch === "!") {
			pushWord("factorial", "value");
			i++;
			continue;
		}
		if (ch === "%") {
			pushWord("percent", "value");
			i++;
			continue;
		}
		if (ch === "(" || ch === ")" || ch === "[" || ch === "]") {
			if (ch === "(" || ch === "[") prevToken = "op";
			else prevToken = "value";
			i++;
			continue;
		}
		if (ch === "|") {
			prevToken = "op";
			i++;
			continue;
		}
		if (ch === "," || ch === ";" || ch === ":") {
			if (out && !out.endsWith(" ")) out += ",";
			prevToken = "op";
			i++;
			continue;
		}

		// Numbers (e.g. 3.14, 100)
		if (/[0-9]/.test(ch)) {
			let j = i;
			while (j < src.length && /[0-9.]/.test(src[j]!)) j++;
			pushWord(src.slice(i, j), "value");
			i = j;
			continue;
		}

		// Plain identifier letters
		if (/[A-Za-z]/.test(ch)) {
			let j = i;
			while (j < src.length && /[A-Za-z]/.test(src[j]!)) j++;
			const letters = src.slice(i, j);
			pushWord(letters, "value");
			i = j;
			continue;
		}

		// Unicode math symbols that may appear directly
		const unicodeSpoken = UNICODE_MATH[ch];
		if (unicodeSpoken) {
			pushWord(unicodeSpoken, "op");
			i++;
			continue;
		}

		i++;
	}

	return out.trim();
}

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

function normalizeSpokenSpacing(text: string): string {
	return text
		.replace(/\s+/g, " ")
		.replace(/\s+([,.;:?!])/g, "$1")
		.trim();
}

/**
 * Strip Markdown syntax and convert inline/display LaTeX & code blocks into
 * clean speakable prose. Pure, no DOM.
 */
export function markdownToSpeech(markdown: string): string {
	if (!markdown.trim()) return "";

	let text = repairMathForDisplay(markdown).replace(/\r\n?/g, "\n");

	// 1. Replace fenced code blocks (and figure fences) before touching inline syntax.
	text = text.replace(/(^|\n)[ \t]*(`{3,}|~{3,})([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, (_, lead: string, _fence: string, info: string) => {
		const lang = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
		const note = lang === "plot" || lang === "blocks" ? "Diagram." : "Code block.";
		return `${lead}${note}\n`;
	});

	// 2. Preserve inline code text as placeholders so underscores/asterisks inside code are never stripped as Markdown or math.
	const inlineCodes: string[] = [];
	text = text.replace(/(`+)([\s\S]*?)\1/g, (_, _ticks: string, body: string) => {
		const idx = inlineCodes.push(body.replace(/\s+/g, " ").trim()) - 1;
		return `\uE000CODE${idx}\uE001`;
	});

	// 3. Verbalize display math ($$...$$ and \[...\]) and inline math (\(...\) and $...$).
	const mathSpans: string[] = [];
	const pushMath = (rawLatex: string) => {
		const idx = mathSpans.push(latexToSpeech(rawLatex)) - 1;
		return ` \uE000MATH${idx}\uE001 `;
	};

	text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, inner: string) => pushMath(inner));
	text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_, inner: string) => pushMath(inner));
	text = text.replace(/\\\(([\s\S]+?)\\\)/g, (_, inner: string) => pushMath(inner));
	// Inline $...$: avoid currency like "$5 and $10" by requiring no space right after opening $ or before closing $,
	// and not immediately followed by a digit after closing $.
	text = text.replace(/(?<!\\)\$(?!\s)([^$\n]+?)(?<!\s)(?<!\\)\$(?!\d)/g, (_, inner: string) => pushMath(inner));

	// 4. Strip Markdown structure & formatting.
	// Images ![alt](url)
	text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt: string) => (alt.trim() ? alt.trim() : "image"));
	// Links [label](url)
	text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
	// Reference-style links [label][ref]
	text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
	// Reference link definitions
	text = text.replace(/^[ \t]*\[[^\]]+\]:[ \t]*\S+.*$/gm, "");
	// Autolinks <https://...>
	text = text.replace(/<(https?:\/\/[^>]+)>/g, "link");
	// Headings: ensure sentence pause after heading
	text = text.replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*$/gm, (_, heading: string) => {
		const h = heading.trim();
		return /[.!?:]$/.test(h) ? h : `${h}.`;
	});
	// Horizontal rules
	text = text.replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, "");
	// Blockquote prefixes
	text = text.replace(/^[ \t]*>[ \t]?/gm, "");
	// Markdown tables: drop delimiter rows and turn cell rows into comma-separated phrases
	text = text.replace(/^[ \t]*\|?(?:[ \t]*:?-{3,}:?[ \t]*\|)+[ \t]*:?-{3,}:?[ \t]*\|?[ \t]*$/gm, "");
	text = text.replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_, row: string) => {
		const cells = row
			.split("|")
			.map((c) => c.trim())
			.filter(Boolean);
		return cells.length ? `${cells.join(", ")}.` : "";
	});
	// Unordered and ordered list markers
	text = text.replace(/^[ \t]*[-*+][ \t]+/gm, "");
	text = text.replace(/^[ \t]*\d+[.)][ \t]+/gm, "");

	// Emphasis & strikethrough
	text = text.replace(/\*\*([\s\S]+?)\*\*/g, "$1");
	text = text.replace(/__([\s\S]+?)__/g, "$1");
	text = text.replace(/~~([\s\S]+?)~~/g, "$1");
	text = text.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, "$1");
	text = text.replace(/(?<![\w\\])_([^_\n]+?)_(?!\w)/g, "$1");

	// Simple HTML tags (keep inner text)
	text = text.replace(/<br\s*\/?>/gi, ". ");
	text = text.replace(/<\/?[a-zA-Z][^>]*>/g, "");

	// Unescape markdown punctuation escapes (\*, \_, \#, etc.)
	text = text.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1");

	// Restore verbalized math spans (already guaranteed free of raw \commands)
	text = text.replace(/\uE000MATH(\d+)\uE001/g, (_, idx: string) => mathSpans[Number(idx)] ?? "");

	// Safety net: strip any stray raw LaTeX command that appeared outside $...$ (and outside inline code)
	text = text.replace(/\\[A-Za-z]+(?:\{[^}]*\})*/g, MATH_FALLBACK);

	// Restore inline code text literally so identifiers and paths are spoken as-is
	text = text.replace(/\uE000CODE(\d+)\uE001/g, (_, idx: string) => inlineCodes[Number(idx)] ?? "");

	// Paragraph breaks become sentence breaks if not already punctuated.
	const paragraphs = text
		.split(/\n{2,}/)
		.map((p) => normalizeSpokenSpacing(p.replace(/\n+/g, " ")))
		.filter(Boolean);

	return paragraphs
		.map((p, idx) => (idx < paragraphs.length - 1 && !/[.!?:]$/.test(p) ? `${p}.` : p))
		.join(" ");
}

// ─── Sentence splitting (adapted from amoghu1s1/twig src/core/sentence-reader.ts, AGPL-3.0) ──

const ABBREVIATIONS = new Set([
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
]);

function shouldMergeSegments(left: string, right: string): boolean {
	const trimmedLeft = left.trimEnd();
	const trimmedRight = right.trimStart();
	if (!trimmedLeft || !trimmedRight) return false;
	const lastWord = trimmedLeft.match(/([A-Za-z]+(?:\.[A-Za-z]+)*\.)$/)?.[1]?.toLowerCase();
	if (!lastWord) return false;
	if (ABBREVIATIONS.has(lastWord)) return true;
	// Single capital initial followed by a capitalized word (e.g. "J. Smith")
	if (/^[a-z]\.$/.test(lastWord) && /^[A-Z]/.test(trimmedRight)) return true;
	return false;
}

function segmentSentences(text: string): string[] {
	const raw: string[] = [];
	if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
		const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
		for (const part of segmenter.segment(text)) {
			if (part.segment.trim()) raw.push(part.segment);
		}
	} else {
		const fallback = text.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) ?? [text];
		for (const part of fallback) {
			if (part.trim()) raw.push(part);
		}
	}

	const merged: string[] = [];
	for (const seg of raw) {
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
export function splitSpeechUtterances(text: string, maxChars = DEFAULT_MAX_UTTERANCE_CHARS): string[] {
	const cleaned = normalizeSpokenSpacing(text);
	if (!cleaned) return [];
	return segmentSentences(cleaned).flatMap((s) => splitLongSentence(s, maxChars));
}

/**
 * Build the ordered list of speakable utterances for a displayed pending question.
 * Only takes what is displayed to the learner: question, optional context, and
 * displayed options in displayed order with displayed letters.
 */
export function buildQuestionSpeech(input: QuestionSpeechInput, maxChars = DEFAULT_MAX_UTTERANCE_CHARS): string[] {
	const utterances: string[] = [];

	const questionText = markdownToSpeech(input.question);
	if (questionText) {
		utterances.push(...splitSpeechUtterances(questionText, maxChars));
	}

	if (input.context) {
		const contextText = markdownToSpeech(input.context);
		if (contextText) {
			utterances.push(...splitSpeechUtterances(contextText, maxChars));
		}
	}

	if (input.options?.length) {
		for (const opt of input.options) {
			const labelText = markdownToSpeech(opt.label);
			if (!labelText) continue;
			const descText = opt.description ? markdownToSpeech(opt.description) : "";
			const body = descText ? `${labelText}${/[.!?:]$/.test(labelText) ? "" : "."} ${descText}` : labelText;
			const prefix = opt.letter ? `${opt.letter}: ` : "";
			utterances.push(...splitSpeechUtterances(`${prefix}${body}`, maxChars));
		}
	}

	return utterances;
}
