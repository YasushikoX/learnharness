/**
 * Rewrite the converter test PDF's committed copy (fork addition, 2026-11-25):
 *
 *   npx tsx scripts/converter-fixture.ts
 *
 * The PDF is built by src/server/converters/validation-fixture.ts, byte for byte the same every time;
 * tests/pdf-converter-validator.test.ts checks the copy equals it.
 */
import fs from "node:fs";
import path from "node:path";
import { validationPdf } from "../src/server/converters/validation-fixture.ts";

const file = path.join(import.meta.dirname, "..", "tests", "fixtures", "converters", "validation-two-page.pdf");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, validationPdf());
console.log(`wrote ${path.relative(process.cwd(), file)} (${fs.statSync(file).size} bytes)`);
