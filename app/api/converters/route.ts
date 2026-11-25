/**
 * Settings → PDF conversion (fork addition, 2026-11-25; src/server/converters/settings-service.ts).
 *
 *   GET → ConvertersOverview: the selected converter; every converter (built-in reader, Docling, each preset, each
 *         of your own profiles) with its URL, where PDFs go, whether a key is stored (never the key) and its
 *         options; the profile files that failed validation.
 *   PUT { id, select?, baseUrl?, apiKey?, removeKey?, ocr?, formulaEnrichment? } → the new overview.
 *         A key is bound to the converter's URL; changing the URL without a key removes the stored one.
 */
import { configureConverter, convertersOverview, parseConfigureBody } from "@/src/server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
	return Response.json(convertersOverview(), { headers: NO_STORE });
}

export async function PUT(request: Request) {
	const parsed = parseConfigureBody(await request.json().catch(() => null));
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
	try {
		const result = configureConverter(parsed.value);
		if (!result.ok) return Response.json({ error: result.error }, { status: result.status ?? 400, headers: NO_STORE });
		return Response.json(result.value, { headers: NO_STORE });
	} catch {
		// The credential store is unreadable or damaged: nothing was changed, and no detail (it could hold a key) is returned.
		return Response.json({ error: "The credential store could not be updated" }, { status: 500, headers: NO_STORE });
	}
}
