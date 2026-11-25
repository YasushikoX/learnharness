import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
	MATERIAL_DIGEST_VERSION,
	type DigestBatchRef,
	type DigestConcept,
	type DigestFailedBatch,
	type DigestFigure,
	type DigestTerm,
	type MaterialDigest,
} from "../../core/contracts/material-digest.ts";
import { conceptId, slugOf, termId } from "../../core/glossary.ts";
import { pageCountOf, splitMaterial, type MaterialBatch, type SplitOptions } from "../../core/material-split.ts";

/**
 * The material indexer (fork addition, 2026-11-24): reads the WHOLE of one
 * converted document (`content.md`, page-marked Markdown) in bounded batches
 * (core/material-split.ts) and writes its digest (contracts/material-digest.ts):
 * every term with its definition and page, the checkable concepts, the figures,
 * and the source profile the catalog already reads (core/materials.ts).
 *
 * Calls: one per batch, each a JSON object validated against BATCH_SCHEMA (pages
 * inside the batch's range); an invalid reply is asked again once with the
 * validation errors; a batch that still fails, or whose call throws, is recorded
 * in `failedBatches` and the rest carry on. With more than one batch one more
 * call (the reduce) writes the profile from the batch notes; a single batch's one
 * call writes the profile too, so a slide deck costs exactly one call. The reduce
 * gets the same one retry; a profile that still fails, or no batch indexed at
 * all, throws (there is no digest without a profile). Aborts always throw.
 *
 * The model call is injected (`DigestModelCall`): no engine, store or file here.
 * Batches run one after another.
 */

/** Bump when the prompts, schema or merge rules change enough to re-index. */
export const MATERIAL_INDEXER_VERSION = 1;

/** One model call, no tools: system prompt and user text in, the reply text out. */
export type DigestModelCall = (request: { system: string; user: string }, signal?: AbortSignal) => Promise<string>;

export interface MaterialDigestDeps {
	complete: DigestModelCall;
	sourceHash: string;
	converter: string;
	converterVersion: string;
	/** The document's display name, for the prompts. */
	name?: string;
	signal?: AbortSignal;
	/** The batch budget and token estimate (core/material-split.ts defaults). */
	split?: SplitOptions;
	onActivity?: (line: string) => void;
}

const nonEmpty = Type.String({ minLength: 1 });
const pageNumber = Type.Integer({ minimum: 1 });

const BATCH_FIELDS = {
	summaryBullets: Type.Array(nonEmpty),
	terms: Type.Array(
		Type.Object({
			term: nonEmpty,
			aliases: Type.Array(Type.String()),
			definition: nonEmpty,
			page: pageNumber,
			tier: Type.Union([Type.Literal("core"), Type.Literal("supporting")]),
		}),
	),
	concepts: Type.Array(Type.Object({ name: nonEmpty, statement: nonEmpty, page: pageNumber })),
	figures: Type.Array(Type.Object({ page: pageNumber, caption: nonEmpty })),
};

/** A batch's notes. */
export const BATCH_SCHEMA = Type.Object(BATCH_FIELDS);
/** A single-batch document's one call: the notes and the profile. */
export const SINGLE_SCHEMA = Type.Object({ ...BATCH_FIELDS, profile: nonEmpty });

export type BatchNotes = Static<typeof BATCH_SCHEMA>;

/** The profile format of material-profiler.ts PROFILE_DELIVERABLE (the catalog cuts its "## " sections, core/materials.ts). */
const PROFILE_FORMAT = `A SOURCE PROFILE of this material. A teacher keeps it in front of them for the whole lesson: it sets the lesson's target and keeps the teaching in line with the material. Markdown, these sections (leave one out only when the material has nothing for it):

## Scope and targets
What a learner who has mastered this material can do — concrete, checkable targets, each cited.
## Contents
The outline (chapters, sections), with page ranges for a PDF.
## Definitions and terminology
The key terms exactly as the material defines them (quote short definitions verbatim), cited.
## Notation and conventions
Symbols, sign and naming conventions, units, and the forms formulas are written in.
## Approach and order
How the material builds the topic: what it assumes, what comes first, how it argues or derives.
## Exercises
The kinds of problems it poses and what they test, if any.

Cite every claim: (p. N) for a PDF, the section heading otherwise. Keep the material's own language for its terms — never translate them. 400-1200 words, dense, no filler. If the material is not teaching material (a single figure, a photo of a board), describe what it shows and what it means for a lesson on it.`;

const EXTRACTION_RULES = `You are an indexing specialist inside a learning application. You read one part of a student's course material (a slide deck, a textbook chapter, notes) and index it completely, so that nothing a student must learn from it is missed.

The material is Markdown. A line "--- Page N ---" starts page N; text without such a line is on the page stated in the request.

Reply with ONE JSON object and nothing else (no prose, no code fence), with these fields:
- "summaryBullets": short bullets, in order, of what this part covers.
- "terms": EVERY technical term this part defines or relies on, not only the prominent ones. Each: {"term", "aliases", "definition", "page", "tier"}.
  - "term": as the material writes it. "aliases": other names, abbreviations or symbols the material uses for it ([] if none).
  - "definition": taken from the material (quote it when it is short). When the material uses a term without defining it, state the meaning the material relies on, in its own words; never invent a definition it does not support.
  - "page": the page the term first appears on in this part.
  - "tier": "core" if the material treats it as something a student must know (defined, stressed, examined, built on), "supporting" if it appears in passing.
- "concepts": the checkable ideas — claims, rules, theorems, methods, results a student could be tested on — not single words. Each: {"name", "statement", "page"}: a short name, the idea stated as the material states it, and its page.
- "figures": each figure, diagram, table or chart: {"page", "caption"} (its caption, or one sentence on what it shows).

Write everything in the material's own language; never translate its terms. Use [] for a field with nothing in it. Every page must be a page of this part.`;

const REDUCE_RULES = `You are a reading specialist inside a learning application. You receive the notes another reader made, part by part, of the WHOLE of one document of a student's course material: each part's page range and section, its summary, its terms with definitions, its concepts and its figures. Write the document's profile from them.

Reply with the profile only (Markdown, starting at its first "## " heading):

${PROFILE_FORMAT}`;

/** The profile proper: from its first section heading on (same rule as material-profiler.ts profileBody). */
function profileBody(text: string): string {
	const at = text.search(/^## /m);
	return (at > 0 ? text.slice(at) : text).trim();
}

/** The JSON object a reply carries: the whole reply, a fenced block, or its outermost braces. */
function parseReply(reply: string): unknown {
	const text = reply.trim();
	const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/i.exec(text);
	const body = fenced ? fenced[1]! : text;
	try {
		return JSON.parse(body);
	} catch (err) {
		const open = body.indexOf("{");
		const close = body.lastIndexOf("}");
		if (open >= 0 && close > open) {
			try {
				return JSON.parse(body.slice(open, close + 1));
			} catch {
				// fall through to the first error
			}
		}
		throw new Error(`the reply is not one JSON object (${(err as Error).message})`);
	}
}

/** How many validation errors the retry is shown. */
const MAX_ERRORS_SHOWN = 12;
/** How much of the rejected reply the retry is shown. */
const MAX_REJECTED_CHARS = 4_000;

/** The notes of one reply, or the problems with it. Pure. */
export function validateBatchReply(
	reply: string,
	batch: Pick<MaterialBatch, "pageStart" | "pageEnd">,
	withProfile: boolean,
): { ok: true; notes: BatchNotes & { profile?: string } } | { ok: false; error: string } {
	let value: unknown;
	try {
		value = parseReply(reply);
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
	const schema = withProfile ? SINGLE_SCHEMA : BATCH_SCHEMA;
	if (!Value.Check(schema, value)) {
		const errors = [...Value.Errors(schema, value)].slice(0, MAX_ERRORS_SHOWN).map((e) => `${e.instancePath || "/"}: ${e.message}`);
		return { ok: false, error: `the JSON does not match the format: ${errors.join("; ")}` };
	}
	const notes = Value.Clean(schema, structuredClone(value)) as BatchNotes & { profile?: string };
	const outside: string[] = [];
	const check = (where: string, page: number) => {
		if (page < batch.pageStart || page > batch.pageEnd) outside.push(`${where} has page ${page}`);
	};
	notes.terms.forEach((t, i) => check(`/terms/${i} ("${t.term}")`, t.page));
	notes.concepts.forEach((c, i) => check(`/concepts/${i} ("${c.name}")`, c.page));
	notes.figures.forEach((f, i) => check(`/figures/${i}`, f.page));
	if (outside.length > 0) {
		const range = batch.pageStart === batch.pageEnd ? `page ${batch.pageStart}` : `pages ${batch.pageStart}-${batch.pageEnd}`;
		return { ok: false, error: `this part is ${range}, but ${outside.slice(0, MAX_ERRORS_SHOWN).join("; ")}` };
	}
	if (withProfile && !/^## /m.test(notes.profile ?? "")) return { ok: false, error: `"profile" has no "## " section heading` };
	return { ok: true, notes };
}

/** The request for one batch. */
function batchRequest(batch: MaterialBatch, total: number, name: string | undefined, withProfile: boolean): string {
	const range = batch.pageStart === batch.pageEnd ? `page ${batch.pageStart}` : `pages ${batch.pageStart}-${batch.pageEnd}`;
	const lines = [
		`The material: ${name ? `"${name}"` : "one document"}${total > 1 ? `, part ${batch.index + 1} of ${total}` : " (the whole document)"}, ${range}.`,
		`The text begins on page ${batch.pageStart}.`,
	];
	if (batch.headingPath.length > 0) lines.push(`It begins inside the section: ${batch.headingPath.join(" > ")}.`);
	if (withProfile)
		lines.push(
			`This part is the whole document, so also add a "profile" field: a string holding ${PROFILE_FORMAT.replace(/^A SOURCE PROFILE/, "the SOURCE PROFILE")}`,
		);
	return `${lines.join("\n")}\n\n<material>\n${batch.text}\n</material>`;
}

/** The request again, with what was wrong with the last reply. */
function retryRequest(request: string, rejected: string, error: string): string {
	const shown = rejected.length > MAX_REJECTED_CHARS ? `${rejected.slice(0, MAX_REJECTED_CHARS)}\n[… cut]` : rejected;
	return `${request}\n\nYour previous reply was rejected: ${error}\n\n<previous_reply>\n${shown}\n</previous_reply>\n\nReply again with the corrected JSON object only.`;
}

function isAbort(err: unknown, signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true || (err instanceof Error && err.name === "AbortError");
}

/** A validated call: the reply, asked once more with its errors when it fails `validate`. */
async function callValidated<T>(
	deps: MaterialDigestDeps,
	system: string,
	user: string,
	validate: (reply: string) => { ok: true; value: T } | { ok: false; error: string },
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
	let request = user;
	let last = "";
	for (let attempt = 0; attempt < 2; attempt++) {
		deps.signal?.throwIfAborted();
		let reply: string;
		try {
			reply = await deps.complete({ system, user: request }, deps.signal);
		} catch (err) {
			if (isAbort(err, deps.signal)) throw err;
			return { ok: false, error: `the model call failed: ${err instanceof Error ? err.message : String(err)}` };
		}
		const result = validate(reply);
		if (result.ok) return result;
		last = result.error;
		request = retryRequest(user, reply, result.error);
	}
	return { ok: false, error: last };
}

/** Merge the batches' terms by id: aliases unioned, the earliest page (and its spelling and definition), core if any. Pure. */
export function mergeTerms(perBatch: readonly BatchNotes["terms"][]): DigestTerm[] {
	const byId = new Map<string, DigestTerm & { aliasKeys: Set<string> }>();
	for (const terms of perBatch) {
		for (const t of terms) {
			const id = termId(t.term);
			if (id === "t_") continue;
			const seen = byId.get(id);
			if (!seen) {
				const entry = { id, term: t.term.trim(), aliases: [] as string[], definition: t.definition.trim(), page: t.page, tier: t.tier, aliasKeys: new Set([slugOf(t.term)]) };
				for (const a of t.aliases) addAlias(entry, a);
				byId.set(id, entry);
				continue;
			}
			if (t.page < seen.page) {
				seen.page = t.page;
				seen.term = t.term.trim();
				seen.definition = t.definition.trim();
			}
			if (t.tier === "core") seen.tier = "core";
			addAlias(seen, t.term);
			for (const a of t.aliases) addAlias(seen, a);
		}
	}
	return [...byId.values()].map(({ aliasKeys: _keys, ...term }) => term);
}

function addAlias(entry: { aliases: string[]; aliasKeys: Set<string> }, alias: string): void {
	const key = slugOf(alias);
	if (key === "" || entry.aliasKeys.has(key)) return;
	entry.aliasKeys.add(key);
	entry.aliases.push(alias.trim());
}

/** Merge the batches' concepts by id: the earliest page and its statement. Pure. */
export function mergeConcepts(perBatch: readonly BatchNotes["concepts"][]): DigestConcept[] {
	const byId = new Map<string, DigestConcept>();
	for (const concepts of perBatch) {
		for (const c of concepts) {
			const id = conceptId(c.name);
			if (id === "c_") continue;
			const seen = byId.get(id);
			if (!seen) byId.set(id, { id, name: c.name.trim(), statement: c.statement.trim(), page: c.page });
			else if (c.page < seen.page) Object.assign(seen, { name: c.name.trim(), statement: c.statement.trim(), page: c.page });
		}
	}
	return [...byId.values()];
}

/** The batches' figures, in page order, each page and caption once. Pure. */
function mergeFigures(perBatch: readonly BatchNotes["figures"][]): DigestFigure[] {
	const seen = new Set<string>();
	const out: DigestFigure[] = [];
	for (const figures of perBatch) {
		for (const f of figures) {
			const key = `${f.page}\u0000${f.caption.trim()}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ page: f.page, caption: f.caption.trim() });
		}
	}
	return out.sort((a, b) => a.page - b.page);
}

/** The reduce call's input: every indexed batch's notes. Pure. */
export function batchNotesText(notes: readonly { batch: MaterialBatch; notes: BatchNotes }[], failed: readonly DigestFailedBatch[]): string {
	const pages = (a: number, b: number) => (a === b ? `page ${a}` : `pages ${a}-${b}`);
	const parts = notes.map(({ batch, notes: n }) => {
		const lines = [`### Part ${batch.index + 1}: ${pages(batch.pageStart, batch.pageEnd)}${batch.headingPath.length > 0 ? ` (in ${batch.headingPath.join(" > ")})` : ""}`];
		if (n.summaryBullets.length > 0) lines.push("Summary:", ...n.summaryBullets.map((b) => `- ${b}`));
		if (n.terms.length > 0)
			lines.push("Terms:", ...n.terms.map((t) => `- ${t.term}${t.aliases.length > 0 ? ` (${t.aliases.join(", ")})` : ""} [${t.tier}, p. ${t.page}]: ${t.definition}`));
		if (n.concepts.length > 0) lines.push("Concepts:", ...n.concepts.map((c) => `- ${c.name} (p. ${c.page}): ${c.statement}`));
		if (n.figures.length > 0) lines.push("Figures:", ...n.figures.map((f) => `- p. ${f.page}: ${f.caption}`));
		return lines.join("\n");
	});
	if (failed.length > 0) parts.push(`(Not indexed, the notes are missing: ${failed.map((f) => pages(f.pageStart, f.pageEnd)).join(", ")}.)`);
	return parts.join("\n\n");
}

/** Index one converted document. Throws when it is empty, no batch could be indexed, the profile failed, or on abort. */
export async function digestMaterial(contentMd: string, deps: MaterialDigestDeps): Promise<MaterialDigest> {
	if (!contentMd.trim()) throw new Error("the material is empty");
	const batches = splitMaterial(contentMd, deps.split);
	const single = batches.length === 1;
	const done: { batch: MaterialBatch; notes: BatchNotes }[] = [];
	const failedBatches: DigestFailedBatch[] = [];
	let profile: string | undefined;

	for (const batch of batches) {
		deps.onActivity?.(`indexing ${deps.name ?? "the material"}: part ${batch.index + 1} of ${batches.length} (p. ${batch.pageStart}-${batch.pageEnd})`);
		const result = await callValidated(deps, EXTRACTION_RULES, batchRequest(batch, batches.length, deps.name, single), (reply) => {
			const v = validateBatchReply(reply, batch, single);
			return v.ok ? { ok: true, value: v.notes } : v;
		});
		if (!result.ok) {
			failedBatches.push({ index: batch.index, pageStart: batch.pageStart, pageEnd: batch.pageEnd, error: result.error });
			continue;
		}
		const { profile: own, ...notes } = result.value;
		if (single) profile = profileBody(own ?? "");
		done.push({ batch, notes });
	}

	if (done.length === 0) throw new Error(`no part of the material could be indexed: ${failedBatches.map((f) => f.error).join(" | ")}`);

	if (!single) {
		deps.onActivity?.(`indexing ${deps.name ?? "the material"}: writing the profile`);
		const request = `The material: ${deps.name ? `"${deps.name}"` : "one document"}, ${pageCountOf(contentMd)} pages, read in ${batches.length} parts.\n\n<notes>\n${batchNotesText(done, failedBatches)}\n</notes>`;
		const result = await callValidated(deps, REDUCE_RULES, request, (reply) => {
			const body = profileBody(reply);
			return /^## /m.test(body) ? { ok: true, value: body } : { ok: false, error: `the profile has no "## " section heading` };
		});
		if (!result.ok) throw new Error(`the profile could not be written: ${result.error}`);
		profile = result.value;
	}

	const batchRefs: DigestBatchRef[] = batches.map((b) => ({ index: b.index, pageStart: b.pageStart, pageEnd: b.pageEnd }));
	return {
		version: MATERIAL_DIGEST_VERSION,
		sourceHash: deps.sourceHash,
		converter: deps.converter,
		converterVersion: deps.converterVersion,
		indexerVersion: MATERIAL_INDEXER_VERSION,
		pageCount: pageCountOf(contentMd),
		batches: batchRefs,
		failedBatches,
		terms: mergeTerms(done.map((d) => d.notes.terms)),
		concepts: mergeConcepts(done.map((d) => d.notes.concepts)),
		figures: mergeFigures(done.map((d) => d.notes.figures)),
		profile: profile ?? "",
	};
}
