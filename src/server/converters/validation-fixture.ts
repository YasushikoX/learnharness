/**
 * The converter test PDFs (fork addition, 2026-11-25), built byte for byte the same every time (no dates, no ids),
 * so a converter's answer can be checked page by page:
 *
 *   validationPdf()       two pages, each with its own sentence (tests/fixtures/converters/validation-two-page.pdf);
 *   blankPageTestPdf()    three pages: a sentence, a BLANK page, another sentence
 *                         (tests/fixtures/converters/validation-blank-middle.pdf). A converter that cannot place a
 *                         blank page shifts page 3's text onto page 2, or fails honestly.
 *
 * `npx tsx scripts/converter-fixture.ts` rewrites both copies; a test checks they equal these builders' output. Every
 * sentence is plain Helvetica text at 20 pt, so a text reader and an OCR service can read it.
 */

export const VALIDATION_SENTENCES = [
	"The heron counted seven lanterns on the north bridge.",
	"A violet kettle hummed beside the copper map.",
] as const;

/** The three-page PDF's sentences by page; page 2 is blank. */
export const BLANK_PAGE_SENTENCES = [
	"An amber lighthouse guided nine paper boats home.",
	undefined,
	"The quiet glacier kept a silver compass under its snow.",
] as const;

export const VALIDATION_FILENAME = "learnharness-converter-test.pdf";
export const BLANK_PAGE_FILENAME = "learnharness-converter-test-blank-page.pdf";

function pdfText(text: string): string {
	if (!/^[\x20-\x7e]*$/.test(text)) throw new Error("validation sentences are plain ASCII");
	return `(${text.replace(/[()\\]/g, (ch) => `\\${ch}`)})`;
}

/** A PDF with one page per entry: the sentence, or an empty content stream for undefined (a blank page). */
function buildPdf(sentences: readonly (string | undefined)[]): Uint8Array<ArrayBuffer> {
	const pages = sentences.map((sentence) => (sentence === undefined ? "" : `BT /F1 20 Tf 1 0 0 1 60 700 Tm ${pdfText(sentence)} Tj ET`));
	const objects: string[] = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] >>`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
	];
	for (const [i, stream] of pages.entries()) {
		objects.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
			`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		);
	}
	let pdf = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (const [i, body] of objects.entries()) {
		offsets.push(pdf.length);
		pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
	}
	const xref = pdf.length;
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Uint8Array.from(pdf, (ch) => ch.charCodeAt(0));
}

export function validationPdf(): Uint8Array<ArrayBuffer> {
	return buildPdf(VALIDATION_SENTENCES);
}

export function blankPageTestPdf(): Uint8Array<ArrayBuffer> {
	return buildPdf(BLANK_PAGE_SENTENCES);
}
