import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildQuestionSpeech,
	latexToSpeech,
	markdownToSpeech,
	splitSpeechUtterances,
} from "../src/core/speech-text.ts";

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
		for (const pattern of ["*a", "_a", "~a", "**a", "~~a"]) {
			const input = pattern.repeat(50_000);
			const t0 = performance.now();
			const out = markdownToSpeech(input);
			const elapsed = performance.now() - t0;
			assert.ok(out.length > 0);
			assert.ok(elapsed < 1500, `markdownToSpeech(${pattern} x 50000) took ${elapsed.toFixed(1)}ms (expected < 1500ms)`);
		}
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
