/**
 * Point LearnHarness at a Docling Serve service before the settings screen
 * exists (fork addition, 2026-11-24). Reads the URL and key from the
 * environment and stores them through configureDocling
 * (src/server/converters/auth.ts): the key goes to auth.json only, bound to
 * the URL; the URL goes to the pdfConversion settings section, and Docling
 * becomes the PDF converter unless DOCLING_SELECT=0. The key is never printed.
 *
 *   DOCLING_BASE_URL=http://host:5001 DOCLING_API_KEY=… npx tsx scripts/docling-credential.ts
 *
 * Without DOCLING_API_KEY (or with it empty) a stored Docling key is removed.
 * The data and auth locations are the dev defaults unless LH_DATA_DIR and
 * LH_AUTH_FILE point elsewhere (the packaged app's profile, for example).
 */
import { AUTH_FILE, SETTINGS_FILE } from "../config.ts";
import { configureDocling } from "../src/server/converters/auth.ts";

function main() {
	const baseUrl = process.env.DOCLING_BASE_URL;
	if (!baseUrl) {
		console.error("Usage: DOCLING_BASE_URL=http://host:5001 [DOCLING_API_KEY=…] [DOCLING_SELECT=0] npx tsx scripts/docling-credential.ts");
		process.exitCode = 2;
		return;
	}
	const apiKey = process.env.DOCLING_API_KEY;
	const select = process.env.DOCLING_SELECT !== "0";
	const canonical = configureDocling({ baseUrl, apiKey, select });
	console.log(`Docling URL: ${canonical} (settings: ${SETTINGS_FILE})`);
	console.log(apiKey?.trim() ? `Docling key: stored, bound to that URL (${AUTH_FILE})` : `Docling key: none stored (${AUTH_FILE})`);
	console.log(select ? "PDF converter: docling" : "PDF converter: unchanged");
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
