import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { defaultRehypePlugins } from "streamdown";
import { streamdownRehypePlugins } from "../components/ai-elements/message.tsx";
import {
	buildQuestionSpeech,
	latexToSpeech,
	markdownToSpeech,
	SPEECH_SANITIZE_SCHEMA,
	splitSpeechUtterances,
} from "../src/core/speech-text.ts";

/**
 * A pathological input must cost time in proportion to its length. Measured as growth, not as a wall-clock bound: a
 * bound in milliseconds fails when the machine is busy (the full suite beside another build took four times as long).
 * Quadruple the input: linear work takes about 4 times as long, quadratic work 16 times. Best of three runs each.
 */
function assertLinearTime(what: string, run: (n: number) => { length: number }, n: number): void {
	const best = (size: number) => {
		let ms = Infinity;
		for (let i = 0; i < 3; i++) {
			const t0 = performance.now();
			assert.ok(run(size).length > 0);
			ms = Math.min(ms, performance.now() - t0);
		}
		return ms;
	};
	const small = best(n / 4);
	const large = best(n);
	assert.ok(large < Math.max(small, 5) * 10, `${what}: ${n / 4} repetitions took ${small.toFixed(1)}ms, ${n} took ${large.toFixed(1)}ms (more than 10 times as long: not linear)`);
}

describe("latexToSpeech", () => {
	it("verbalises fractions, powers, subscripts, roots, Greek letters, and operators", () => {
		assert.equal(latexToSpeech(String.raw`\frac{1}{2}`), "one half");
		assert.equal(latexToSpeech(String.raw`\frac{x+1}{3}`), "open bracket x plus 1 close bracket over 3");
		assert.equal(latexToSpeech(String.raw`x^2 + y^3`), "x squared plus y cubed");
		assert.equal(latexToSpeech(String.raw`2^{n+1}`), "2 to the power of open bracket n plus 1 close bracket");
		assert.equal(latexToSpeech(String.raw`a_0 + a_{n+1}`), "a sub 0 plus a sub open bracket n plus 1 close bracket");
		assert.equal(latexToSpeech(String.raw`\sqrt{x}`), "square root of x");
		assert.equal(latexToSpeech(String.raw`\sqrt[3]{8}`), "cube root of 8");
		assert.equal(latexToSpeech(String.raw`\alpha + \beta \leq \pi`), "alpha plus beta less than or equal to pi");
		assert.equal(latexToSpeech(String.raw`\Delta x \to 0`), "capital delta x to 0");
		assert.equal(latexToSpeech(String.raw`a \cdot b \neq c`), "a times b not equal to c");
	});

	it("verbalises simple sums, products, integrals, limits, and standard functions", () => {
		const sum = latexToSpeech(String.raw`\sum_{i=1}^{n} i^2`);
		assert.match(sum, /sum from i equals 1 to n of i squared/i);

		const integral = latexToSpeech(String.raw`\int_0^1 x^2 \, dx`);
		assert.match(integral, /integral from 0 to 1 of x squared d x|integral from 0 to 1 of x squared dx/i);

		const limit = latexToSpeech(String.raw`\lim_{x \to 0} \frac{\sin x}{x}`);
		assert.match(limit, /limit as x approaches 0 of open bracket sine x close bracket over x/i);
	});

	it("speaks brackets and compound groups unambiguously and falls back to formula when ambiguous (Item 2)", () => {
		// Every example from the WP7 review:
		assert.equal(latexToSpeech(String.raw`(a+b)^2`), "open bracket a plus b close bracket squared");
		assert.equal(latexToSpeech(String.raw`2(x+1)`), "2 open bracket x plus 1 close bracket");
		assert.equal(
			latexToSpeech(String.raw`\left(\frac{1}{x}\right)^2`),
			"open bracket 1 over x close bracket squared",
		);
		assert.equal(latexToSpeech(String.raw`f(x)`), "f of x");
		assert.equal(latexToSpeech(String.raw`\frac{a+b}{c}`), "open bracket a plus b close bracket over c");
		assert.equal(latexToSpeech(String.raw`x^{n+1}`), "x to the power of open bracket n plus 1 close bracket");
		assert.equal(latexToSpeech(String.raw`\sqrt{x}+1`), "square root of x plus 1");
		assert.equal(latexToSpeech(String.raw`\sqrt{x+1}`), "square root of open bracket x plus 1 close bracket");
		assert.notEqual(latexToSpeech(String.raw`\sqrt{x}+1`), latexToSpeech(String.raw`\sqrt{x+1}`));

		// Additional grouping distinctions and fallbacks:
		assert.equal(latexToSpeech(String.raw`f(x)^2`), "open bracket f of x close bracket squared");
		assert.equal(latexToSpeech(String.raw`f(x^2)`), "f of open bracket x squared close bracket");
		assert.equal(latexToSpeech(String.raw`|x-1|`), "absolute value of open bracket x minus 1 close bracket");
		assert.equal(latexToSpeech(String.raw`|x|-1`), "absolute value of x minus 1");
		assert.equal(latexToSpeech(String.raw`(a+b`), "formula");
		assert.equal(latexToSpeech(String.raw`[0, 1)`), "formula");
	});

	it("falls back to a neutral phrase for complex or unknown LaTeX and never emits raw backslash commands", () => {
		const matrix = latexToSpeech(String.raw`\begin{pmatrix} 1 & 2 \\ 3 & 4 \end{pmatrix}`);
		assert.equal(matrix, "formula");
		assert.doesNotMatch(matrix, /\\[a-zA-Z]+/);

		const unknown = latexToSpeech(String.raw`\mysteryoperator{x, y}`);
		assert.equal(unknown, "formula");
		assert.doesNotMatch(unknown, /\\[a-zA-Z]+/);
	});

	it("uses the localised formula placeholder for Norwegian lessons without English maths words (Item 4)", () => {
		assert.equal(latexToSpeech(String.raw`\frac{1}{2} + x^2`, "nb"), "formel");
		assert.equal(latexToSpeech(String.raw`(a+b)^2`, "nb"), "formel");
		assert.equal(latexToSpeech(String.raw`\sqrt{x}`, "nb"), "formel");
	});
});

describe("markdownToSpeech", () => {
	it("strips Markdown formatting while preserving readable prose and inline code", () => {
		const md = [
			"## Topic Heading",
			"",
			"Use **Newton's law** with *constant* `mass` and [see notes](https://example.com).",
			"",
			"> Remember to check units.",
			"- First item",
			"- Second item",
		].join("\n");
		const spoken = markdownToSpeech(md);
		assert.match(spoken, /Topic Heading/);
		assert.match(spoken, /Newton's law with constant mass and see notes/);
		assert.match(spoken, /Remember to check units/);
		assert.doesNotMatch(spoken, /[#*_`[\]]|https?:\/\//);
	});

	it("never speaks raw backslash commands inside inline code or prose (Item 6)", () => {
		const pathSpoken = markdownToSpeech("Open `C:\\Users\\name` and evaluate $\\unknowncmd{x}$.");
		assert.match(pathSpoken, /\bcode\b/);
		assert.match(pathSpoken, /\bformula\b/);
		assert.doesNotMatch(pathSpoken, /\\Users|\\name|unknowncmd/);

		const latexCode = markdownToSpeech("Write `\\frac{a}{b}` in LaTeX, not `foo_bar`.");
		assert.match(latexCode, /Write code in LaTeX, not foo_bar\./);
		assert.doesNotMatch(latexCode, /\\frac/);
	});

	it("never speaks text hidden on screen: comments, script, style, template, collapsed details (Item 1)", () => {
		const inlineComment = markdownToSpeech("Which is right?<!-- correct answer is B --> Pick one.");
		assert.equal(inlineComment, "Which is right? Pick one.");
		assert.ok(!inlineComment.includes("correct answer"));

		const multiComment = markdownToSpeech("Before.\n<!--\nSECRET_LINE_1\nSECRET_LINE_2\n-->\nAfter.");
		assert.ok(!multiComment.includes("SECRET_LINE"));
		assert.match(multiComment, /Before\..*After\./);

		const collapsedDetails = markdownToSpeech("<details><summary>Hint</summary>The answer is 42</details>");
		assert.equal(collapsedDetails, "Hint");
		assert.ok(!collapsedDetails.includes("42"));

		const unlabeledDetails = markdownToSpeech("Prompt.<details>SECRET_UNLABELED</details>");
		assert.equal(unlabeledDetails, "Prompt.");
		assert.ok(!unlabeledDetails.includes("SECRET_UNLABELED"));

		const openDetails = markdownToSpeech("<details open><summary>Note</summary>Visible body</details>");
		assert.match(openDetails, /Note.*Visible body/);

		const nestedDetails = markdownToSpeech(
			"<details open><summary>Outer</summary>Shown <details><summary>Inner hint</summary>SECRET_NESTED</details></details>",
		);
		assert.match(nestedDetails, /Outer/);
		assert.match(nestedDetails, /Shown/);
		assert.match(nestedDetails, /Inner hint/);
		assert.ok(!nestedDetails.includes("SECRET_NESTED"));

		const scriptTag = markdownToSpeech("Before <script>alert(1)</script> After");
		assert.equal(scriptTag, "Before After");
		assert.ok(!scriptTag.includes("alert"));

		const styleTag = markdownToSpeech("Before <style>.x { content: 'SECRET_CSS'; }</style> After");
		assert.equal(styleTag, "Before After");
		assert.ok(!styleTag.includes("SECRET_CSS"));

		const templateTag = markdownToSpeech("Before <template>SECRET_TEMPLATE</template> After");
		assert.equal(templateTag, "Before After");
		assert.ok(!templateTag.includes("SECRET_TEMPLATE"));

		const alertCallout = markdownToSpeech("> [!IMPORTANT]\n> Check units.");
		assert.equal(alertCallout, "Check units.");
		assert.ok(!alertCallout.includes("IMPORTANT"));
	});

	it("replaces fenced code blocks with a short spoken note and all figure fences with Diagram (Item 7)", () => {
		const md = [
			"Consider this function:",
			"",
			"```python",
			"def f(x):",
			"    return x * x",
			"```",
			"",
			"And the figures:",
			"",
			"```plot",
			"axes t 0..5, y",
			"```",
			"```blocks",
			"box A -> box B",
			"```",
			"```circuit",
			"R1 1 2 10k",
			"```",
			"```logic",
			"AND a b -> c",
			"```",
			"```timing",
			"clk: 0101",
			"```",
			"```mermaid",
			"graph TD; A-->B;",
			"```",
		].join("\n");
		const spoken = markdownToSpeech(md);
		assert.match(spoken, /Code block\./);
		const diagramMatches = spoken.match(/Diagram\./g) ?? [];
		assert.equal(diagramMatches.length, 6, `expected 6 Diagram announcements, got ${diagramMatches.length}: ${spoken}`);
		assert.doesNotMatch(spoken, /def f\(x\)|axes t|box A|R1 1 2|AND a b|clk:|graph TD/);
	});

	it("does not read source from unclosed code or figure fences (Item 7)", () => {
		const unclosedFigure = markdownToSpeech("Look at the diagram:\n```plot\nSECRET_PLOT_SOURCE\naxes x 0..5");
		assert.match(unclosedFigure, /Look at the diagram:/);
		assert.match(unclosedFigure, /Diagram\./);
		assert.ok(!unclosedFigure.includes("SECRET_PLOT_SOURCE"));

		const unclosedCode = markdownToSpeech("Inspect:\n```ts\nconst SECRET_CODE = 99;");
		assert.match(unclosedCode, /Code block\./);
		assert.ok(!unclosedCode.includes("SECRET_CODE"));
	});

	it("handles prose superscripts/subscripts, footnote markers, and escaped dollar signs (Item 7)", () => {
		const prosePower = markdownToSpeech("The tolerance is 10^{-3} and the term is a_{n+1}.");
		assert.equal(
			prosePower,
			"The tolerance is 10 to the power of negative 3 and the term is a sub open bracket n plus 1 close bracket.",
		);
		assert.doesNotMatch(prosePower, /[{}]/);

		const footnotes = markdownToSpeech("See the theorem[^1] and the remark[^note].\n\n[^1]: Proof omitted.");
		assert.doesNotMatch(footnotes, /\[\^[^\]]+\]/);
		assert.match(footnotes, /See the theorem and the remark\./);

		const money = markdownToSpeech("A ticket costs \\$20 today.");
		assert.equal(money, "A ticket costs $20 today.");
		assert.doesNotMatch(money, /\\\$/);
	});

	it("verbalises inline and display math inside Markdown without leaking backslashes", () => {
		const spoken = markdownToSpeech(String.raw`Compute $\frac{1}{2} m v^2$ when $v = 4$.`);
		assert.equal(spoken, "Compute one half m v squared when v equals 4.");
		assert.doesNotMatch(spoken, /\\[a-zA-Z]+/);
	});

	it("localises placeholders and formulas for Norwegian lessons (Item 4)", () => {
		const md = [
			"Regn ut $(a+b)^2$ med `\\frac{1}{2}` og se https://example.com.",
			"",
			"```python",
			"print(1)",
			"```",
			"",
			"```circuit",
			"R1 1 2 10",
			"```",
			"",
			"![](diagram.png)",
		].join("\n");
		const spoken = markdownToSpeech(md, "nb");
		assert.match(spoken, /Regn ut formel med kode og se lenke\./);
		assert.match(spoken, /Kodeblokk\./);
		assert.match(spoken, /Diagram\./);
		assert.match(spoken, /\bbilde\b/);
		assert.doesNotMatch(spoken, /open bracket|squared|Code block|formula|https?:\/\//i);
	});

	it("runs in linear time on pathological repeated emphasis characters (Item 7)", () => {
		for (const pattern of ["*a", "_a", "~a", "**a", "~~a"]) assertLinearTime(`markdownToSpeech(${pattern})`, (n) => markdownToSpeech(pattern.repeat(n)), 50_000);
	});
});

describe("splitSpeechUtterances", () => {
	it("splits prose into sentence-sized utterances while keeping abbreviations and decimals intact", () => {
		const text = "Dr. Smith measured 3.14 seconds, e.g. in Fig. 2. Next, double the value! Does it converge?";
		const parts = splitSpeechUtterances(text);
		assert.deepEqual(parts, [
			"Dr. Smith measured 3.14 seconds, e.g. in Fig. 2.",
			"Next, double the value!",
			"Does it converge?",
		]);
	});

	it("uses Norwegian segmentation rules when language is nb (Item 4)", () => {
		const text = "Bruk f.eks. 3,14 eller bl.a. tabellen. Hva blir svaret? Prøv igjen!";
		const parts = splitSpeechUtterances(text, 220, "nb");
		assert.deepEqual(parts, [
			"Bruk f.eks. 3,14 eller bl.a. tabellen.",
			"Hva blir svaret?",
			"Prøv igjen!",
		]);
	});

	it("chunks overly long single sentences so Stop stays responsive and engines do not cut off", () => {
		const longSentence = Array.from({ length: 12 }, (_, i) => `clause number ${i + 1} with several extra words`).join(", ") + ".";
		const parts = splitSpeechUtterances(longSentence, 120);
		assert.ok(parts.length >= 3, `expected at least 3 chunks, got ${parts.length}`);
		for (const part of parts) {
			assert.ok(part.length <= 140, `chunk too long: ${part.length}`);
		}
	});
});

describe("buildQuestionSpeech", () => {
	it("reads question, context, and options in displayed order using their displayed letters", () => {
		const utterances = buildQuestionSpeech({
			question: "What is $\\sqrt{9}$?",
			context: "Choose the **positive** root.",
			options: [
				{ letter: "A", label: "$-3$" },
				{ letter: "B", label: "$3$" },
				{ letter: "C", label: "$9$", description: "Nine squared is 81." },
			],
		});
		assert.deepEqual(utterances, [
			"What is square root of 9?",
			"Choose the positive root.",
			"A: negative 3",
			"B: 3",
			"C: 9.",
			"Nine squared is 81.",
		]);
	});

	it("handles questions with no options (explain / text ask)", () => {
		const utterances = buildQuestionSpeech({
			question: "Explain why `O(n log n)` beats `O(n^2)` for large `n`.",
		});
		assert.deepEqual(utterances, [
			"Explain why O(n log n) beats O(n^2) for large n.",
		]);
	});

	it("propagates Norwegian language through question, context, and options (Item 4)", () => {
		const utterances = buildQuestionSpeech({
			question: "Hva er $\\frac{a+b}{c}$?",
			context: "Se f.eks. definisjonen.",
			options: [{ letter: "A", label: "$x^2$" }],
			language: "nb",
		});
		assert.deepEqual(utterances, [
			"Hva er formel?",
			"Se f.eks. definisjonen.",
			"A: formel",
		]);
	});
});

// WP7 review 2: the reviewer's formula table. ✗ rows now read with one meaning or as "formula"; ✓ rows keep their reading.
describe("latexToSpeech: review-2 formula table", () => {
	const FIXED: ReadonlyArray<readonly [string, string]> = [
		// Two superscripts on one base: KaTeX shows an error, so nothing is read.
		[String.raw`e^{-x}^2`, "formula"],
		[String.raw`a^b^c`, "formula"],
		// A sum or limit followed by more terms: where the body ends cannot be heard.
		[String.raw`\sum_{i=1}^{n} i^2 + 1`, "formula"],
		[String.raw`\lim_{x\to0} f(x)+1`, "formula"],
		// Inverse functions.
		[String.raw`f^{-1}(x)`, "f inverse of x"],
		[String.raw`\sin^{-1}x`, "inverse sine of x"],
		// Composition, not degrees.
		[String.raw`f\circ g`, "f composed with g"],
		// Log base; TeX scripts only the first digit of a bare subscript.
		[String.raw`\log_2 8`, "log base 2 of 8"],
		[String.raw`x_12`, "formula"],
		// Recurring decimal (the full stop would be heard as a pause).
		[String.raw`0.\overline{3}`, "formula"],
	];
	const KEPT: ReadonlyArray<readonly [string, string]> = [
		[String.raw`(a+b)^2`, "open bracket a plus b close bracket squared"],
		[String.raw`2(x+1)`, "2 open bracket x plus 1 close bracket"],
		[String.raw`\left(\frac{1}{x}\right)^2`, "open bracket 1 over x close bracket squared"],
		[String.raw`\frac{a+b}{c}`, "open bracket a plus b close bracket over c"],
		[String.raw`x^{n+1}`, "x to the power of open bracket n plus 1 close bracket"],
		[String.raw`\sqrt{x}+1`, "square root of x plus 1"],
		[String.raw`\sqrt{x+1}`, "square root of open bracket x plus 1 close bracket"],
		[String.raw`f(x)`, "f of x"],
		[String.raw`g(f(x))`, "g of open bracket f of x close bracket"],
		[String.raw`f(x,y)`, "f of open bracket x, y close bracket"],
		[String.raw`\frac{\frac{1}{2}}{3}`, "open bracket one half close bracket over 3"],
		[String.raw`\frac{1}{\frac{a}{b}}`, "1 over open bracket a over b close bracket"],
		[String.raw`\frac{1}{2}x`, "one half x"],
		[String.raw`\frac{1}{2x}`, "1 over open bracket 2 x close bracket"],
		[String.raw`-x^2`, "negative x squared"],
		[String.raw`(-x)^2`, "open bracket negative x close bracket squared"],
		[String.raw`5-(-3)`, "5 minus open bracket negative 3 close bracket"],
		[String.raw`e^{-x^2}`, "e to the power of open bracket negative x squared close bracket"],
		[String.raw`\sqrt[n]{x}`, "nth root of x"],
		[String.raw`\sum_{i=1}^{n} i^2`, "sum from i equals 1 to n of i squared"],
		[String.raw`\int_0^1 x^2\,dx`, "integral from 0 to 1 of x squared d x"],
		[String.raw`\binom{n}{k}`, "n choose k"],
		[String.raw`\vec{v}`, "v vector"],
		[String.raw`\hat x`, "x hat"],
		[String.raw`\bar x`, "x bar"],
		[String.raw`A^T`, "A transpose"],
		[String.raw`f'(x)`, "f prime of x"],
		[String.raw`|x|`, "absolute value of x"],
		[String.raw`\|v\|`, "norm of v"],
		[String.raw`[0,1)`, "formula"],
		[String.raw`(0,1]`, "formula"],
		[String.raw`\{1,2,3\}`, "open brace 1, 2, 3 close brace"],
		[String.raw`x \in A`, "x in A"],
		[String.raw`A \cup B`, "A union B"],
		[String.raw`A \subseteq B`, "A subset or equal to B"],
		[String.raw`\text{speed}=\frac{d}{t}`, "speed equals d over t"],
		[String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}`, "formula"],
		[String.raw`\ce{H2O}`, "formula"],
		[String.raw`a \cdot b`, "a times b"],
		[String.raw`a \times b`, "a times b"],
		[String.raw`5\,\text{m/s}`, "5 m/s"],
		[String.raw`50\%`, "50 percent"],
		[String.raw`H_2O`, "H sub 2 O"],
		[String.raw`x_{i+1}`, "x sub open bracket i plus 1 close bracket"],
		[String.raw`\sin^2x+\cos^2x=1`, "sine squared x plus cosine squared x equals 1"],
		[
			String.raw`x = \frac{-b \pm \sqrt{b^2-4ac}}{2a}`,
			"x equals open bracket negative b plus or minus square root of open bracket b squared minus 4 a c close bracket close bracket over open bracket 2 a close bracket",
		],
		[String.raw`90^\circ`, "90 degrees"],
	];

	it("reads every previously wrong or ambiguous row with one meaning, or as formula", () => {
		for (const [latex, spoken] of FIXED) assert.equal(latexToSpeech(latex), spoken, latex);
	});

	it("keeps every previously correct row's reading unchanged", () => {
		for (const [latex, spoken] of KEPT) assert.equal(latexToSpeech(latex), spoken, latex);
	});

	it("says formula for every review-2 row in a Norwegian lesson", () => {
		for (const [latex] of [...FIXED, ...KEPT]) assert.equal(latexToSpeech(latex, "nb"), "formel", latex);
	});

	it("detects double scripts on one base, but not a superscript and a subscript", () => {
		assert.equal(latexToSpeech(String.raw`x_1_2`), "formula");
		assert.equal(latexToSpeech(String.raw`x^a_b^c`), "formula");
		assert.equal(latexToSpeech(String.raw`x^2'`), "formula");
		assert.equal(latexToSpeech(String.raw`x^{2}^{3}`), "formula");
		assert.equal(latexToSpeech(String.raw`x'^2`), "x prime squared");
		assert.equal(latexToSpeech(String.raw`x_a^b`), "x sub a to the power of b");
		assert.equal(latexToSpeech(String.raw`a^{b^c}`), "a to the power of open bracket b to the power of c close bracket");
	});

	it("reads a sum, product, integral or limit only when its body is the rest of its side", () => {
		// A relation ends the body.
		assert.equal(
			latexToSpeech(String.raw`\sum_{i=1}^n i = \frac{n(n+1)}{2}`),
			"sum from i equals 1 to n of i equals open bracket n open bracket n plus 1 close bracket close bracket over 2",
		);
		assert.equal(latexToSpeech(String.raw`\lim_{n\to\infty} a_n = L`), "limit as n approaches infinity of a sub n equals L");
		assert.equal(latexToSpeech(String.raw`\int x\,dx = \frac{x^2}{2} + C`), "integral of x d x equals open bracket x squared close bracket over 2 plus C");
		// Products inside the body stay part of it.
		assert.equal(latexToSpeech(String.raw`\sum_i a_i b_i`), "sum over i of a sub i b sub i");
		// Further terms after the body.
		assert.equal(latexToSpeech(String.raw`\int_0^1 x\,dx + 1`), "formula");
		assert.equal(latexToSpeech(String.raw`\sum_i a_i - 1`), "formula");
		assert.equal(latexToSpeech(String.raw`\sum_i a_i \pm b`), "formula");
		assert.equal(latexToSpeech(String.raw`\prod_k a_k, k > 0`), "formula");
		// Braces are invisible on screen, so they do not end the body either.
		assert.equal(latexToSpeech(String.raw`{\sum_i a_i} + 1`), "formula");
		// Visible brackets do.
		assert.equal(latexToSpeech(String.raw`(\sum_i a_i) + 1`), "open bracket sum over i of a sub i close bracket plus 1");
		assert.equal(latexToSpeech(String.raw`\frac{\sum_i a_i}{n}`), "open bracket sum over i of a sub i close bracket over n");
	});

	it("reads inverse functions, and keeps a bare -1 power on a variable", () => {
		assert.equal(latexToSpeech(String.raw`\sin^{-1}(x)`), "inverse sine of x");
		assert.equal(latexToSpeech(String.raw`\cos^{-1}\left(\frac{1}{2}\right)`), "inverse cosine of open bracket one half close bracket");
		assert.equal(latexToSpeech(String.raw`\tan^{-1}\theta`), "inverse tangent of theta");
		assert.equal(latexToSpeech(String.raw`g^{-1}(f(x))`), "g inverse of open bracket f of x close bracket");
		assert.equal(latexToSpeech(String.raw`f^{-1}(x)^2`), "open bracket f inverse of x close bracket squared");
		assert.equal(latexToSpeech(String.raw`x^{-1}`), "x to the power of negative 1");
		// The argument's extent is unclear, or the function has no spoken inverse: formula.
		assert.equal(latexToSpeech(String.raw`\sin^{-1} 2x`), "formula");
		assert.equal(latexToSpeech(String.raw`\sin^{-1}`), "formula");
		assert.equal(latexToSpeech(String.raw`\ln^{-1} x`), "formula");
	});

	it("reads log bases and keeps other uses of log unchanged", () => {
		assert.equal(latexToSpeech(String.raw`\log_{10}(x)`), "log base 10 of x");
		assert.equal(latexToSpeech(String.raw`\log_{n+1} x`), "log base open bracket n plus 1 close bracket of x");
		assert.equal(latexToSpeech(String.raw`\log_2 8 = 3`), "log base 2 of 8 equals 3");
		assert.equal(latexToSpeech(String.raw`\log_b x^2`), "formula");
		assert.equal(latexToSpeech(String.raw`\log x`), "log x");
	});

	it("brackets only the function call a power applies to", () => {
		assert.equal(latexToSpeech(String.raw`2+f(x)^2`), "2 plus open bracket f of x close bracket squared");
		assert.equal(latexToSpeech(String.raw`\sin(x)^2`), "open bracket sine of x close bracket squared");
	});

	it("reads a bare multi-digit script as formula but keeps a normal number", () => {
		assert.equal(latexToSpeech(String.raw`x^23`), "formula");
		assert.equal(latexToSpeech(String.raw`x_1 2`), "formula");
		assert.equal(latexToSpeech(String.raw`x_{12}`), "x sub 12");
		assert.equal(latexToSpeech(String.raw`2^{10}`), "2 to the power of 10");
		assert.equal(latexToSpeech(String.raw`3.14`), "3.14");
	});
});

describe("markdownToSpeech: review-2 findings", () => {
	it("speaks only the first summary of a collapsed details element (finding 6)", () => {
		const spoken = markdownToSpeech("<details><summary>A</summary><summary>SECRET</summary>body</details>");
		assert.equal(spoken, "A");
		assert.ok(!spoken.includes("SECRET"));
		// Open, every child is shown, so every child is read.
		assert.match(markdownToSpeech("<details open><summary>A</summary><summary>Shown</summary>body</details>"), /A.*Shown.*body/);
	});

	it("handles 100,000 repetitions of the footnote and command patterns in linear time (finding 4)", () => {
		for (const pattern of ["[^", "\\a{"]) assertLinearTime(`buildQuestionSpeech(${JSON.stringify(pattern)})`, (n) => buildQuestionSpeech({ question: pattern.repeat(n) }), 100_000);
	});

	it("uses the renderer's sanitise schema, plus stripping style (review-2 concern)", () => {
		const sanitize = (defaultRehypePlugins as unknown as { sanitize: [unknown, Record<string, unknown>] }).sanitize;
		const rendererSchema = sanitize[1];
		// The app's renderer runs Streamdown's own sanitize entry unchanged.
		assert.ok(
			(streamdownRehypePlugins as unknown[]).some((p) => Array.isArray(p) && p[1] === rendererSchema),
			"streamdownRehypePlugins no longer uses Streamdown's default sanitize schema: update SPEECH_SANITIZE_SCHEMA to match",
		);
		const { strip, ...speechRest } = SPEECH_SANITIZE_SCHEMA as Record<string, unknown> & { strip?: string[] };
		const { strip: rendererStrip, ...rendererRest } = rendererSchema as Record<string, unknown> & { strip?: string[] };
		assert.deepEqual(speechRest, rendererRest);
		assert.deepEqual(strip, [...(rendererStrip ?? []), "style"]);
	});
});

describe("speech-text dependencies (review 2, finding 7)", () => {
	it("declares every package speech-text.ts imports in package.json", () => {
		const source = readFileSync(new URL("../src/core/speech-text.ts", import.meta.url), "utf8");
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			dependencies: Record<string, string>;
			devDependencies: Record<string, string>;
		};
		const imported = [...source.matchAll(/^import\s[^;]*?from\s+"([^".][^"]*)";/gm)].map((m) => m[1]!);
		assert.ok(imported.length >= 10, `expected the parser imports, found ${imported.join(", ")}`);
		for (const name of imported) {
			const declared = name.startsWith("@types/") || name === "hast" ? pkg.devDependencies["@types/hast"] : pkg.dependencies[name];
			assert.ok(declared, `${name} is imported by src/core/speech-text.ts but not declared in package.json`);
		}
	});
});
