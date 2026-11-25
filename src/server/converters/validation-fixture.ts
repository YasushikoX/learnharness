/**
 * The converter test PDF (fork addition, 2026-11-25): two pages, each with its own sentence, built byte for byte
 * the same every time (no dates, no ids), so a converter's answer can be checked page by page. A copy lives in
 * tests/fixtures/converters/validation-two-page.pdf (`npx tsx scripts/converter-fixture.ts` rewrites it; a test
 * checks it equals this builder's output). Both sentences are plain Helvetica text at 20 pt, so a text reader and an
 * OCR service can read them.
 */

export const VALIDATION_SENTENCES = [
	"The heron counted seven lanterns on the north bridge.",
	"A violet kettle hummed beside the copper map.",
] as const;

export const VALIDATION_FILENAME = "learnharness-converter-test.pdf";

function pdfText(text: string): string {
	if (!/^[\x20-\x7e]*$/.test(text)) throw new Error("validation sentences are plain ASCII");
	return `(${text.replace(/[()\\]/g, (ch) => `\\${ch}`)})`;
}

export function validationPdf(): Uint8Array<ArrayBuffer> {
	const pages = VALIDATION_SENTENCES.map((sentence) => `BT /F1 20 Tf 1 0 0 1 60 700 Tm ${pdfText(sentence)} Tj ET`);
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
