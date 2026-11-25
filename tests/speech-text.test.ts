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
		assert.equal(latexToSpeech(String.raw`\frac{x+1}{3}`), "x plus 1 over 3");
		assert.equal(latexToSpeech(String.raw`x^2 + y^3`), "x squared plus y cubed");
		assert.equal(latexToSpeech(String.raw`2^{n+1}`), "2 to the power of n plus 1");
		assert.equal(latexToSpeech(String.raw`a_0 + a_{n+1}`), "a sub 0 plus a sub n plus 1");
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
		assert.match(limit, /limit as x approaches 0 of sine x over x/i);
	});

	it("falls back to a neutral phrase for complex or unknown LaTeX and never emits raw backslash commands", () => {
		const matrix = latexToSpeech(String.raw`\begin{pmatrix} 1 & 2 \\ 3 & 4 \end{pmatrix}`);
		assert.equal(matrix, "formula");
		assert.doesNotMatch(matrix, /\\[a-zA-Z]+/);

		const unknown = latexToSpeech(String.raw`\mysteryoperator{x, y}`);
		assert.equal(unknown, "formula");
		assert.doesNotMatch(unknown, /\\[a-zA-Z]+/);
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

	it("preserves literal backslashes inside inline code while still stripping raw LaTeX commands in prose", () => {
		const spoken = markdownToSpeech("Open `C:\\Users\\name` and evaluate $\\unknowncmd{x}$.");
		assert.match(spoken, /C:\\Users\\name/);
		assert.match(spoken, /formula/);
		assert.doesNotMatch(spoken, /unknowncmd/);
	});

	it("replaces fenced code blocks with a short spoken note and figure fences with Diagram", () => {
		const md = [
			"Consider this function:",
			"",
			"```python",
			"def f(x):",
			"    return x * x",
			"```",
			"",
			"And the system:",
			"",
			"```plot",
			"axes t 0..5, y",
			"```",
		].join("\n");
		const spoken = markdownToSpeech(md);
		assert.match(spoken, /Code block\./);
		assert.match(spoken, /Diagram\./);
		assert.doesNotMatch(spoken, /def f\(x\)/);
		assert.doesNotMatch(spoken, /axes t/);
	});

	it("verbalises inline and display math inside Markdown without leaking backslashes", () => {
		const spoken = markdownToSpeech(String.raw`Compute $\frac{1}{2} m v^2$ when $v = 4$.`);
		assert.equal(spoken, "Compute one half m v squared when v equals 4.");
		assert.doesNotMatch(spoken, /\\[a-zA-Z]+/);
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
});
