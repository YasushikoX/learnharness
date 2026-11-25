/**
 * Rewrite the converter test PDFs' committed copies (fork addition, 2026-11-25):
 *
 *   npx tsx scripts/converter-fixture.ts
 *
 * The PDFs are built by src/server/converters/validation-fixture.ts, byte for byte the same every time;
 * tests/pdf-converter-validator.test.ts checks the copies equal them.
 */
import fs from "node:fs";
import path from "node:path";
import { blankPageTestPdf, validationPdf } from "../src/server/converters/validation-fixture.ts";

const dir = path.join(import.meta.dirname, "..", "tests", "fixtures", "converters");
fs.mkdirSync(dir, { recursive: true });
for (const [name, bytes] of [["validation-two-page.pdf", validationPdf()], ["validation-blank-middle.pdf", blankPageTestPdf()]] as const) {
	const file = path.join(dir, name);
	fs.writeFileSync(file, bytes);
	console.log(`wrote ${path.relative(process.cwd(), file)} (${fs.statSync(file).size} bytes)`);
}
