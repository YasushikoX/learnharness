import fs from "node:fs/promises";
import path from "node:path";
import { createDoclingConverter } from "../src/server/converters/docling.ts";
import { normaliseConversion } from "../src/server/converters/normalise.ts";
import { probePdfInput } from "../src/server/material-conversion.ts";

async function main() {
	const filename = process.argv[2];
	const baseUrl = process.env.DOCLING_BASE_URL;
	if (!filename || !baseUrl) {
		console.error("Usage: DOCLING_BASE_URL=http://host:5001 [DOCLING_API_KEY=…] npx tsx scripts/docling-smoke.ts file.pdf");
		process.exitCode = 2;
		return;
	}
	const controller = new AbortController();
	const bytes = new Uint8Array(await fs.readFile(filename));
	const input = await probePdfInput(bytes, path.basename(filename), controller.signal);
	const converter = createDoclingConverter({ baseUrl, apiKey: process.env.DOCLING_API_KEY });
	const started = Date.now();
	const result = await converter.convert(input, {
		signal: controller.signal,
		onProgress: (stage, done, total) => console.error(`[docling] ${stage}${done === undefined ? "" : ` ${done}/${total ?? "?"}`}`),
	});
	const normalised = normaliseConversion(result, input.pageCount);
	console.log(`Pages: ${input.pageCount}`);
	console.log(`Failed pages: ${normalised.failedPages.length ? normalised.failedPages.map((page) => `${page.page} (${page.status})`).join(", ") : "none"}`);
	console.log(`Elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`);
	for (const warning of result.warnings ?? []) console.log(`Warning: ${warning}`);
	for (const page of result.pages) {
		const lines = page.status === "ok" ? page.markdown.split("\n").filter((line) => line.trim()).slice(0, 3) : [];
		console.log(`\n--- Page ${page.page} (${page.status}) ---\n${lines.join("\n")}${page.status === "ok" ? "" : (page.reason ?? "")}`);
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
	process.exitCode = 1;
});
