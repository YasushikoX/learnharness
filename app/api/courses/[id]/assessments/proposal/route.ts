/**
 * The syllabus pass's proposal (WP8, src/server/assessments.ts actOnProposal).
 *
 *   POST { action: "approve", keys?: string[], edits?: { [key]: { kind?, title?, date?, topics?, skillIds? } } }
 *        → writes the chosen new and update items (all of them without `keys`); an edited item becomes the learner's own
 *   POST { action: "drop", key } → drops one item · POST { action: "discard" } → drops the whole proposal
 *   400 a bad body or field · 404 unknown course or item · 409 no proposal · 413 a body over 64 KB
 */
import { actOnProposal, CustomBodyLimitError, readBoundedJson, type AssessmentInput } from "@/src/server";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	let body: unknown;
	try {
		body = await readBoundedJson(req, MAX_BODY_BYTES);
	} catch (error) {
		if (error instanceof CustomBodyLimitError) return Response.json({ error: "The request is too large" }, { status: 413 });
		return Response.json({ error: "The body must be JSON" }, { status: 400 });
	}
	const b = (body ?? {}) as { action?: unknown; key?: unknown; keys?: unknown; edits?: unknown };
	let action: Parameters<typeof actOnProposal>[1];
	if (b.action === "discard") action = { action: "discard" };
	else if (b.action === "drop") {
		if (typeof b.key !== "string") return Response.json({ error: "drop needs a key" }, { status: 400 });
		action = { action: "drop", key: b.key };
	} else if (b.action === "approve") {
		if (b.keys !== undefined && (!Array.isArray(b.keys) || b.keys.some((k) => typeof k !== "string"))) return Response.json({ error: "keys must be a list of item keys" }, { status: 400 });
		if (b.edits !== undefined && (typeof b.edits !== "object" || b.edits === null || Array.isArray(b.edits))) return Response.json({ error: "edits must be an object of item key to fields" }, { status: 400 });
		action = { action: "approve", ...(b.keys ? { keys: b.keys as string[] } : {}), ...(b.edits ? { edits: b.edits as Record<string, AssessmentInput> } : {}) };
	} else return Response.json({ error: "action must be approve, drop or discard" }, { status: 400 });
	const out = actOnProposal(id, action);
	if (!out.ok) return Response.json({ error: out.error }, { status: out.status });
	return Response.json({ ok: true });
}
