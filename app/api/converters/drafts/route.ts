/**
 * "Draft with AI" (fork addition, 2026-11-25; src/server/converters/drafts.ts, docs/pdf-converters.md). A draft is a
 * converter profile a model wrote from a service's documentation; it is never a usable converter until approved.
 *
 *   GET → { model, drafts }: the model that drafts (null: none configured, the wizard offers import only) and every
 *         draft with its plain-words pre-flight, its Test and whether it can be approved. Never a key.
 *   POST { serviceName, docsUrl | docsText, sample? } → the new draft. With docsUrl the app fetches that page ONCE
 *         (public addresses only, same-site redirects, size, type and time capped); then one model call and at most
 *         one repair call. The body is refused over 256 KB (before it is buffered when Content-Length says so).
 *   PUT { id, baseUrl?, apiKey?, removeKey?, profile? } → the draft: its service URL and key (bound to that URL, the
 *         same rules as every converter key), or its edited JSON (validated; the app sets its own fields).
 *   DELETE ?id=<draft id> → { model, drafts } without it: its file, its key and its Test pass are removed.
 * Closing the POST request aborts the fetch and the model call.
 */
import {
	CustomBodyLimitError,
	configureConverterDraft,
	createConverterDraft,
	discardConverterDraft,
	draftsOverview,
	noteAppRequest,
	parseConfigureDraftBody,
	parseCreateDraftBody,
	readBoundedJson,
} from "@/src/server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
/** 60,000 characters of pasted documentation and an 8,000-character sample, JSON-escaped (a 64 KB profile for PUT). */
const MAX_BODY_BYTES = 256 * 1024;

async function body(request: Request): Promise<{ value: unknown } | Response> {
	try {
		return { value: await readBoundedJson(request, MAX_BODY_BYTES) };
	} catch (error) {
		if (error instanceof CustomBodyLimitError) return Response.json({ error: "The request is too large" }, { status: 413, headers: NO_STORE });
		return { value: null };
	}
}

export async function GET(request?: Request) {
	if (request) noteAppRequest(request.url);
	return Response.json(draftsOverview(), { headers: NO_STORE });
}

export async function POST(request: Request) {
	noteAppRequest(request.url);
	const read = await body(request);
	if (read instanceof Response) return read;
	const parsed = parseCreateDraftBody(read.value);
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
	try {
		const result = await createConverterDraft(parsed.value, request.signal);
		if (!result.ok) return Response.json({ error: result.error }, { status: result.status ?? 400, headers: NO_STORE });
		return Response.json(result.value, { headers: NO_STORE });
	} catch (error) {
		if (request.signal.aborted) return new Response(null, { status: 499 });
		return Response.json({ error: `The draft could not be written: ${String((error as Error)?.message ?? error).slice(0, 300)}` }, { status: 502, headers: NO_STORE });
	}
}

export async function PUT(request: Request) {
	noteAppRequest(request.url);
	const read = await body(request);
	if (read instanceof Response) return read;
	const parsed = parseConfigureDraftBody(read.value);
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
	try {
		const result = configureConverterDraft(parsed.value);
		if (!result.ok) return Response.json({ error: result.error, errors: result.errors ?? [] }, { status: result.status ?? 400, headers: NO_STORE });
		return Response.json(result.value, { headers: NO_STORE });
	} catch {
		// the credential store is unreadable or damaged: no detail (it could hold a key) is returned
		return Response.json({ error: "The draft could not be updated" }, { status: 500, headers: NO_STORE });
	}
}

export async function DELETE(request: Request) {
	noteAppRequest(request.url);
	const id = new URL(request.url).searchParams.get("id") ?? "";
	try {
		const result = discardConverterDraft(id);
		if (!result.ok) return Response.json({ error: result.error }, { status: result.status ?? 400, headers: NO_STORE });
		return Response.json(result.value, { headers: NO_STORE });
	} catch {
		return Response.json({ error: "The draft could not be discarded" }, { status: 500, headers: NO_STORE });
	}
}
