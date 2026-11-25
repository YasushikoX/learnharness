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
import { conceptId, pickDefinition, slugOf, unifyByAlias } from "../../core/glossary.ts";
import { pageCountOf, splitMaterial, type MaterialBatch, type SplitOptions } from "../../core/material-split.ts";

/**
 * The material indexer (fork addition, 2026-11-24): reads the WHOLE of one
 * converted document (`content.md`, page-marked Markdown) in bounded batches
 * (core/material-split.ts) and writes its digest (contracts/material-digest.ts):
 * every term with its earliest page and, separately, the material's explicit
 * definition and its page (or none, for a term the material uses without
 * defining it), the checkable concepts, the figures, and the source profile the
 * catalog already reads (core/materials.ts).
 *
 * Calls: one per batch, each a JSON object validated against BATCH_SCHEMA (every
 * page one the batch's text is actually on, no blank text); an invalid reply is
 * asked again once with the validation errors; a batch that still fails, or
 * whose call throws, is recorded in `failedBatches` and the rest carry on. A
 * thrown call is not retried here: retrying transient transport errors (rate
 * limits, timeouts) is the injected `complete`'s job. With more than one batch
 * one more call (the reduce) writes the profile from bounded notes (at most
 * REDUCE_REQUEST_MAX_CHARS, whatever the document's size); a single batch's one
 * call writes the profile too, so a slide deck costs exactly one call. The
 * profile is validated on its own (a recognised section with a body) and gets its
 * own one retry; when it still fails, the digest keeps every extracted note and
 * has `profile: null` with `profileError`. When no batch could be indexed the
 * digest has empty lists, every batch in `failedBatches` and no profile. Only an
 * empty document and an abort throw (an abort also when it lands during the last
 * call).
 *
 * The model call is injected (`DigestModelCall`): no engine, store or file here.
 * Batches run one after another.
 */

/** Bump when the prompts, schema, ids or merge rules change enough to re-index. 2: explicit definitions, new ids, alias rules. */
export const MATERIAL_INDEXER_VERSION = 2;

/** One model call, no tools: system prompt and user text in, the reply text out. */
export type DigestModelCall = (request: { system: string; user: string }, signal?: AbortSignal) => Promise<string>;

export interface MaterialDigestDeps {
	complete: DigestModelCall;
	sourceHash: string;
	converter: string;
	converterVersion: string;
	/** The source's physical page count when known (a PDF's, at conversion): stored as `sourcePageCount`. */
	sourcePageCount?: number;
	/** The document's display name, for the prompts. */
	name?: string;
	signal?: AbortSignal;
	/** The batch budget and token estimate (core/material-split.ts defaults). */
	split?: SplitOptions;
	onActivity?: (line: string) => void;
}

/** The longest user message of the reduce call, its retry included, in characters (about 16k tokens). */
export const REDUCE_REQUEST_MAX_CHARS = 64_000;
/**
 * The most an extraction request (its retry included) adds to its batch's text, in characters: the header, the
 * capped name, heading path and page list, the profile format for a single batch, and the rejected reply and errors.
 */
export const EXTRACTION_OVERHEAD_MAX_CHARS = 10_000;
/** The longest heading path shown in any request, in characters (each title is cut to HEADING_TITLE_MAX_CHARS). */
export const HEADING_PATH_MAX_CHARS = 160;
const HEADING_TITLE_MAX_CHARS = 60;
/** The longest document name shown in a request. */
const NAME_MAX_CHARS = 200;
/** The longest page list shown in an extraction request. */
const PAGE_LIST_MAX_CHARS = 300;
/** How many validation errors the retry is shown. */
const MAX_ERRORS_SHOWN = 12;
/** The longest error kept (shown in a retry, stored in failedBatches / profileError). */
const MAX_ERROR_CHARS = 1_000;
/** How much of the rejected reply the retry is shown. */
const MAX_REJECTED_CHARS = 4_000;
/** Room kept in the reduce request for its retry (the rejected reply, the error, the instruction). */
const RETRY_RESERVE_CHARS = MAX_REJECTED_CHARS + MAX_ERROR_CHARS + 600;

const nonBlank = Type.String({ pattern: "\\S" });
const pageNumber = Type.Integer({ minimum: 1 });

/** A batch's notes. */
export const BATCH_SCHEMA = Type.Object({
	summaryBullets: Type.Array(nonBlank),
	terms: Type.Array(
		Type.Object({
			term: nonBlank,
			aliases: Type.Array(Type.String()),
			page: pageNumber,
			tier: Type.Union([Type.Literal("core"), Type.Literal("supporting")]),
			definition: Type.Union([nonBlank, Type.Null()]),
			definitionPage: Type.Union([pageNumber, Type.Null()]),
		}),
	),
	concepts: Type.Array(Type.Object({ name: nonBlank, statement: nonBlank, page: pageNumber })),
	figures: Type.Array(Type.Object({ page: pageNumber, caption: nonBlank })),
});

export type BatchNotes = Static<typeof BATCH_SCHEMA>;
export type BatchTerm = BatchNotes["terms"][number];

/** The six section headings of a profile (material-profiler.ts PROFILE_DELIVERABLE), kept literal in every language. */
export const PROFILE_HEADINGS = ["Scope and targets", "Contents", "Definitions and terminology", "Notation and conventions", "Approach and order", "Exercises"] as const;

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

Write the section headings exactly as above, in English, whatever the material's language. Cite every claim: (p. N) for a PDF, the section heading otherwise. Keep the material's own language for its terms — never translate them. 400-1200 words, dense, no filler. If the material is not teaching material (a single figure, a photo of a board), describe what it shows and what it means for a lesson on it.`;

const EXTRACTION_RULES = `You are an indexing specialist inside a learning application. You read one part of a student's course material (a slide deck, a textbook chapter, notes) and index it completely, so that nothing a student must learn from it is missed.

The material is Markdown. A line "--- Page N ---" starts page N; text before the first such line is on the page stated in the request. Inside a fenced code block (between \`\`\` or ~~~ lines) such a line, or a "#" heading, is only an example in the text, not a page break or a heading.

Reply with ONE JSON object and nothing else (no prose, no code fence), with these fields:
- "summaryBullets": short bullets, in order, of what this part covers.
- "terms": EVERY technical term this part defines, introduces or relies on, not only the prominent ones; include terms it uses without defining them. An empty list is right only for a part with no technical vocabulary at all. Each: {"term", "aliases", "page", "tier", "definition", "definitionPage"}.
  - "term": as the material writes it. "aliases": other names, abbreviations or symbols the material uses for this same term ([] if none).
  - "page": the page this part first mentions the term on.
  - "tier": "core" if the material treats it as something a student must know (defined, stressed, examined, built on), "supporting" if it appears in passing.
  - "definition": the material's own explicit definition of the term, in its words (quote it when it is short), or null when this part uses the term without defining it. Never write a definition the material does not give. When the part gives both a passing explanation and a formal definition, use the formal one.
  - "definitionPage": the page of that definition; null exactly when "definition" is null.
- "concepts": the checkable ideas — claims, rules, theorems, methods, results a student could be tested on — not single words. Each: {"name", "statement", "page"}: a short name, the idea stated as the material states it, and its page.
- "figures": each figure, diagram, table or chart: {"page", "caption"} (its caption, or one sentence on what it shows).

Write everything in the material's own language; never translate its terms. Use [] for a field with nothing in it; no text may be empty or blank. Every page must be one of this part's pages, listed in the request.`;

const REDUCE_RULES = `You are a reading specialist inside a learning application. You receive notes another reader made of the WHOLE of one document of a student's course material: each part's page range, section and summary, then the document's terms (with the page each is first mentioned on, and the material's definition and its page when it gives one), its concepts and its figures. Long documents come with shortened notes. Write the document's profile from them.

Reply with the profile only (Markdown, starting at its first "## " heading; not JSON):

${PROFILE_FORMAT}`;

/** One line of model text: whitespace collapsed, cut to `max` characters with an ellipsis. Pure. */
function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	return `${flat.slice(0, Math.max(0, max - 1)).replace(/[\ud800-\udbff]$/, "")}…`;
}

/** A heading path for a request: each title cut, the whole at most HEADING_PATH_MAX_CHARS (outermost and innermost kept). Pure. */
export function formatHeadingPath(path: readonly string[], max = HEADING_PATH_MAX_CHARS): string {
	const titles = path.map((t) => clip(t, HEADING_TITLE_MAX_CHARS));
	const whole = titles.join(" > ");
	if (whole.length <= max) return whole;
	if (titles.length > 2) {
		const ends = `${titles[0]} > … > ${titles.at(-1)}`;
		if (ends.length <= max) return ends;
	}
	return clip(whole, max);
}

/** Ascending unique page numbers as ranges ("1-4, 7"), cut to `max` characters. Pure. */
function pageList(pages: readonly number[], max: number): string {
	const parts: string[] = [];
	for (let i = 0; i < pages.length; i++) {
		let j = i;
		while (j + 1 < pages.length && pages[j + 1] === pages[j]! + 1) j++;
		parts.push(i === j ? `${pages[i]}` : `${pages[i]}-${pages[j]}`);
		i = j;
	}
	return clip(parts.join(", "), max);
}

const pagesLabel = (a: number, b: number) => (a === b ? `page ${a}` : `pages ${a}-${b}`);

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

type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * A profile, or what is wrong with it: from its first "## " heading on, with at least one of the six PROFILE_HEADINGS
 * (any other section, or a missing one, is allowed) whose section has text. Pure.
 */
export function validateProfile(text: string): Checked<string> {
	const body = profileBody(text);
	const sections = body
		.split(/^(?=## )/m)
		.filter((s) => s.startsWith("## "))
		.map((s) => {
			const [first, ...rest] = s.split("\n");
			return { heading: first!.slice(3).replace(/[\s#:]+$/, "").trim().toLowerCase(), text: rest.filter((l) => l.trim() !== "" && !/^\s*#/.test(l)).join("\n") };
		});
	const known = new Set(PROFILE_HEADINGS.map((h) => h.toLowerCase()));
	const recognised = sections.filter((s) => known.has(s.heading));
	const list = PROFILE_HEADINGS.map((h) => `"## ${h}"`).join(", ");
	if (recognised.length === 0) return { ok: false, error: `the profile has none of the section headings ${list}` };
	if (!recognised.some((s) => s.text.trim() !== "")) return { ok: false, error: "the profile's sections are empty" };
	return { ok: true, value: body };
}

/** The notes of one reply, or the problems with it. Every page must be one the batch is on (`pages`). Pure. */
export function validateBatchReply(reply: string, batch: Pick<MaterialBatch, "pages">): Checked<BatchNotes> {
	let value: unknown;
	try {
		value = parseReply(reply);
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
	if (!Value.Check(BATCH_SCHEMA, value)) {
		const errors = [...Value.Errors(BATCH_SCHEMA, value)].slice(0, MAX_ERRORS_SHOWN).map((e) => `${e.instancePath || "/"}: ${e.message}`);
		return { ok: false, error: clip(`the JSON does not match the format: ${errors.join("; ")}`, MAX_ERROR_CHARS) };
	}
	const notes = Value.Clean(BATCH_SCHEMA, structuredClone(value)) as BatchNotes;
	const problems: string[] = [];
	const onPages = new Set(batch.pages);
	const check = (where: string, page: number) => {
		if (!onPages.has(page)) problems.push(`${where} has page ${page}`);
	};
	notes.terms.forEach((t, i) => {
		const where = `/terms/${i} ("${clip(t.term, 60)}")`;
		check(where, t.page);
		if ((t.definition === null) !== (t.definitionPage === null)) problems.push(`${where} has a "definition" and "definitionPage" that are not both null or both set`);
		else if (t.definitionPage !== null) check(`${where} definitionPage`, t.definitionPage);
	});
	notes.concepts.forEach((c, i) => check(`/concepts/${i} ("${clip(c.name, 60)}")`, c.page));
	notes.figures.forEach((f, i) => check(`/figures/${i}`, f.page));
	if (problems.length > 0) {
		return { ok: false, error: clip(`this part is on ${batch.pages.length === 1 ? "page" : "pages"} ${pageList(batch.pages, PAGE_LIST_MAX_CHARS)}, but ${problems.slice(0, MAX_ERRORS_SHOWN).join("; ")}`, MAX_ERROR_CHARS) };
	}
	for (const t of notes.terms) {
		t.term = t.term.trim();
		t.aliases = t.aliases.map((a) => a.trim()).filter((a) => a !== ""); // a blank alias carries nothing: dropped, not a retry
		t.definition = t.definition?.trim() ?? null;
		// a definition is a mention: the first mention is never after it
		if (t.definitionPage !== null && t.definitionPage < t.page) t.page = t.definitionPage;
	}
	return { ok: true, value: notes };
}

/** The request for one batch. */
function batchRequest(batch: MaterialBatch, total: number, name: string | undefined, withProfile: boolean): string {
	const lines = [
		`The material: ${name ? `"${clip(name, NAME_MAX_CHARS)}"` : "one document"}${total > 1 ? `, part ${batch.index + 1} of ${total}` : " (the whole document)"}, ${pagesLabel(batch.pageStart, batch.pageEnd)}.`,
		`The text begins on page ${batch.pageStart}. This part's pages: ${pageList(batch.pages, PAGE_LIST_MAX_CHARS)}.`,
	];
	if (batch.headingPath.length > 0) lines.push(`It begins inside the section: ${formatHeadingPath(batch.headingPath)}.`);
	if (withProfile)
		lines.push(
			`This part is the whole document, so also add a "profile" field: a string holding ${PROFILE_FORMAT.replace(/^A SOURCE PROFILE/, "the SOURCE PROFILE")}`,
		);
	return `${lines.join("\n")}\n\n<material>\n${batch.text}\n</material>`;
}

const AGAIN_JSON = "Reply again with the corrected JSON object only.";
const AGAIN_PROFILE = 'Reply again with the corrected profile only: Markdown starting at its first "## " heading, not JSON.';

/** The request again, with what was wrong with the last reply and how to answer. */
function retryRequest(request: string, rejected: string, error: string, again: string): string {
	const shown = rejected.length > MAX_REJECTED_CHARS ? `${rejected.slice(0, MAX_REJECTED_CHARS)}\n[… cut]` : rejected;
	return `${request}\n\nYour previous reply was rejected: ${clip(error, MAX_ERROR_CHARS)}\n\n<previous_reply>\n${shown}\n</previous_reply>\n\n${again}`;
}

function isAbort(err: unknown, signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true || (err instanceof Error && err.name === "AbortError");
}

/** One model call: its reply, or the error it threw. Aborts throw, also when the abort lands while the call runs. */
async function ask(deps: MaterialDigestDeps, system: string, user: string): Promise<Checked<string>> {
	deps.signal?.throwIfAborted();
	let reply: string;
	try {
		reply = await deps.complete({ system, user }, deps.signal);
	} catch (err) {
		if (isAbort(err, deps.signal)) throw err;
		return { ok: false, error: clip(`the model call failed: ${err instanceof Error ? err.message : String(err)}`, MAX_ERROR_CHARS) };
	}
	deps.signal?.throwIfAborted();
	return { ok: true, value: reply };
}

/** A validated call: the reply, asked once more with its errors when it fails `validate`. A thrown call is not retried. */
async function callValidated<T>(deps: MaterialDigestDeps, system: string, user: string, again: string, validate: (reply: string) => Checked<T>): Promise<Checked<T>> {
	let request = user;
	let last = "";
	for (let attempt = 0; attempt < 2; attempt++) {
		const reply = await ask(deps, system, request);
		if (!reply.ok) return reply;
		const result = validate(reply.value);
		if (result.ok) return result;
		last = result.error;
		request = retryRequest(user, reply.value, result.error, again);
	}
	return { ok: false, error: last };
}

/**
 * A single-batch document's call: notes and profile in one JSON reply, each validated on its own. One retry asks for
 * what is still wrong; a valid half of either reply is kept. A thrown call is not retried.
 */
async function callSingle(deps: MaterialDigestDeps, batch: MaterialBatch): Promise<{ notes: Checked<BatchNotes>; profile: Checked<string> }> {
	const user = batchRequest(batch, 1, deps.name, true);
	let notes: Checked<BatchNotes> = { ok: false, error: "" };
	let profile: Checked<string> = { ok: false, error: "" };
	let request = user;
	for (let attempt = 0; attempt < 2; attempt++) {
		const reply = await ask(deps, EXTRACTION_RULES, request);
		if (!reply.ok) {
			if (!notes.ok) notes = reply;
			if (!profile.ok) profile = reply;
			break;
		}
		if (!notes.ok) notes = validateBatchReply(reply.value, batch);
		if (!profile.ok) {
			let value: unknown;
			try {
				value = parseReply(reply.value);
			} catch (err) {
				value = undefined;
				profile = { ok: false, error: (err as Error).message };
			}
			if (value !== undefined) {
				const text = value !== null && typeof value === "object" ? (value as { profile?: unknown }).profile : undefined;
				profile = typeof text === "string" ? validateProfile(text) : { ok: false, error: `"profile" is missing or not a string` };
			}
		}
		if (notes.ok && profile.ok) break;
		const problems = [...(notes.ok ? [] : [notes.error]), ...(profile.ok ? [] : [`"profile": ${profile.error}`])];
		request = retryRequest(user, reply.value, [...new Set(problems)].join("; "), AGAIN_JSON);
	}
	return { notes, profile };
}

/** Merge the batches' terms (see the module comment of core/glossary.ts for the alias rule). Pure. */
export function mergeTerms(perBatch: readonly BatchTerm[][]): DigestTerm[] {
	const occurrences = perBatch.flat().flatMap((t, order) => {
		const key = slugOf(t.term);
		return key === "" ? [] : [{ t, order, key, aliasKeys: t.aliases.map(slugOf).filter((k) => k !== "" && k !== key) }];
	});
	const groupOf = new Map<string, typeof occurrences>();
	for (const occ of occurrences) {
		const list = groupOf.get(occ.key);
		if (list) list.push(occ);
		else groupOf.set(occ.key, [occ]);
	}
	const groups = [...groupOf.entries()].map(([key, members]) => ({ key, members, aliasKeys: new Set(members.flatMap((m) => m.aliasKeys)) }));
	const labels = unifyByAlias(groups);
	const components = new Map<number, typeof groups>();
	groups.forEach((g, i) => {
		const list = components.get(labels[i]!);
		if (list) list.push(g);
		else components.set(labels[i]!, [g]);
	});

	const out: { first: number; term: DigestTerm }[] = [];
	for (const parts of components.values()) {
		const members = parts.flatMap((p) => p.members).sort((a, b) => a.order - b.order);
		// The entry's own name: a group no other group declares as its alias (the full name, not the abbreviation);
		// among those (or all, for mutual aliases) the earliest mentioned, ties to the smaller key.
		const claimedByOthers = (g: (typeof parts)[number]) => parts.some((o) => o !== g && o.aliasKeys.has(g.key));
		const roots = parts.filter((g) => !claimedByOthers(g));
		const firstPage = (g: (typeof parts)[number]) => Math.min(...g.members.map((m) => m.t.page));
		const root = (roots.length > 0 ? roots : parts).reduce((best, g) =>
			firstPage(g) < firstPage(best) || (firstPage(g) === firstPage(best) && g.key < best.key) ? g : best,
		);
		const display = root.members.reduce((best, m) => (m.t.page < best.t.page ? m : best));
		const aliases: string[] = [];
		const shown = new Set([root.key]);
		for (const m of members) {
			for (const name of [m.t.term, ...m.t.aliases]) {
				const key = slugOf(name);
				if (key === "" || shown.has(key)) continue;
				shown.add(key);
				aliases.push(name.trim());
			}
		}
		const defined = pickDefinition(members.map((m) => m.t));
		out.push({
			first: members[0]!.order,
			term: {
				id: `t_${root.key}`,
				term: display.t.term.trim(),
				aliases,
				page: Math.min(...members.map((m) => m.t.page)),
				tier: members.some((m) => m.t.tier === "core") ? "core" : "supporting",
				definition: defined?.definition ?? null,
				definitionPage: defined?.definitionPage ?? null,
			},
		});
	}
	return out.sort((a, b) => a.first - b.first).map((e) => e.term);
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

/** How much of the notes the reduce is shown; the ladder runs from the full notes to the shortest. */
interface NotesDetail {
	bullets: number;
	chars: number;
	headingPath: boolean;
	figures: boolean;
	supporting: "full" | "names" | "none";
	concepts: "full" | "names" | "none";
	/** fill: as many core names as the room left holds, in first-mention order, on one line. */
	core: "full" | "names" | "fill" | "none";
}

const FULL: NotesDetail = { bullets: Infinity, chars: 400, headingPath: true, figures: true, supporting: "full", concepts: "full", core: "full" };
/** Fewer bullets per part first, then figures, supporting terms before core ones, concepts, and shorter text; never a part. */
const NOTES_LADDER: readonly NotesDetail[] = [
	FULL,
	{ ...FULL, bullets: 6, chars: 250 },
	{ ...FULL, bullets: 3, chars: 160 },
	{ ...FULL, bullets: 3, chars: 160, figures: false },
	{ ...FULL, bullets: 3, chars: 160, figures: false, supporting: "names" },
	{ ...FULL, bullets: 3, chars: 160, figures: false, supporting: "none" },
	{ ...FULL, bullets: 3, chars: 160, figures: false, supporting: "none", concepts: "names" },
	{ ...FULL, bullets: 3, chars: 160, figures: false, supporting: "none", concepts: "names", core: "names" },
	{ ...FULL, bullets: 1, chars: 100, figures: false, supporting: "none", concepts: "names", core: "names" },
	{ ...FULL, bullets: 1, chars: 100, figures: false, supporting: "none", concepts: "none", core: "names" },
	{ ...FULL, bullets: 1, chars: 100, figures: false, supporting: "none", concepts: "none", core: "fill" },
	{ bullets: 1, chars: 60, headingPath: false, figures: false, supporting: "none", concepts: "none", core: "fill" },
];

export interface ReduceNotesInput {
	/** The indexed batches with their notes, in order. */
	parts: readonly { batch: MaterialBatch; notes: BatchNotes }[];
	failed: readonly DigestFailedBatch[];
	/** The merged lists (deduplicated across batches). */
	terms: readonly DigestTerm[];
	concepts: readonly DigestConcept[];
	figures: readonly DigestFigure[];
}

/** The notes at one level of detail; `maxChars` is the room a "fill" list of core terms may take up to. */
function renderNotes(input: ReduceNotesInput, d: NotesDetail, failedLine: string, maxChars: number): string {
	const blocks: string[] = [];
	const parts = input.parts.map(({ batch, notes }) => {
		const where = d.headingPath && batch.headingPath.length > 0 ? ` (in ${formatHeadingPath(batch.headingPath)})` : "";
		const bullets = notes.summaryBullets.slice(0, d.bullets).map((b) => `- ${clip(b, d.chars)}`);
		const more = notes.summaryBullets.length > bullets.length ? [`- (+${notes.summaryBullets.length - bullets.length} more)`] : [];
		return [`### Part ${batch.index + 1}: ${pagesLabel(batch.pageStart, batch.pageEnd)}${where}`, ...bullets, ...more].join("\n");
	});
	blocks.push(`## Parts\n${parts.join("\n")}`);
	if (failedLine) blocks.push(failedLine);

	const termLine = (t: DigestTerm, full: boolean) => {
		const aliases = t.aliases.length > 0 ? ` (${clip(t.aliases.join(", "), 80)})` : "";
		const head = `- ${clip(t.term, 80)}${aliases} [${t.tier}, p. ${t.page}`;
		if (!full) return `${head}]`;
		return t.definition === null ? `${head}; not defined in the material]` : `${head}; defined p. ${t.definitionPage}]: ${clip(t.definition, d.chars)}`;
	};
	const termLines: string[] = [];
	const left: string[] = [];
	let fill: DigestTerm[] = [];
	for (const [tier, mode] of [["core", d.core], ["supporting", d.supporting]] as const) {
		const list = input.terms.filter((t) => t.tier === tier);
		if (mode === "fill") fill = list;
		else if (mode === "none") {
			if (list.length > 0) left.push(`${list.length} ${tier}`);
		} else termLines.push(...list.map((t) => termLine(t, mode === "full")));
	}
	const termsAt = blocks.length;
	if (termLines.length > 0 || left.length > 0 || fill.length > 0)
		blocks.push([`## Terms (first mention; the material's definition)`, ...termLines, ...(left.length > 0 ? [`(Left out for length: ${left.join(" and ")} terms.)`] : [])].join("\n"));

	if (input.concepts.length > 0) {
		blocks.push(
			d.concepts === "none"
				? `## Concepts\n(${input.concepts.length} concepts, left out for length.)`
				: `## Concepts\n${input.concepts.map((c) => `- ${clip(c.name, 80)} (p. ${c.page})${d.concepts === "full" ? `: ${clip(c.statement, d.chars)}` : ""}`).join("\n")}`,
		);
	}
	if (input.figures.length > 0) {
		blocks.push(d.figures ? `## Figures\n${input.figures.map((f) => `- p. ${f.page}: ${clip(f.caption, d.chars)}`).join("\n")}` : `## Figures\n(${input.figures.length} figures, left out for length.)`);
	}
	if (fill.length > 0) {
		// The core names that fit in the room the rest leaves, in first-mention order, then a count of the others.
		const rest = blocks.join("\n\n").length;
		const label = "Core terms (names only, in order of first mention): ";
		let room = maxChars - rest - label.length - 60;
		const names: string[] = [];
		for (const t of fill) {
			const name = clip(t.term, 60);
			if (name.length + 2 > room) break;
			names.push(name);
			room -= name.length + 2;
		}
		const more = fill.length - names.length;
		const line = `${label}${names.join(", ")}${more > 0 ? ` (+${more} more core terms left out for length)` : ""}`;
		blocks[termsAt] = `${blocks[termsAt]}\n${line}`;
	}
	return blocks.join("\n\n");
}

/**
 * The reduce call's notes, at most `maxChars` characters whatever the document's size: page-cited, the terms, concepts
 * and figures merged across batches (each listed once), and as much detail as fits (NOTES_LADDER; its last steps list as
 * many core term names as the room left holds). Past the ladder's end, consecutive parts share one line each, cut to an
 * equal share, so every part's pages still appear. Pure.
 */
export function batchNotesText(input: ReduceNotesInput, maxChars = REDUCE_REQUEST_MAX_CHARS - RETRY_RESERVE_CHARS): string {
	const failedLine = input.failed.length > 0 ? `(Not indexed, the notes are missing: ${clip(input.failed.map((f) => pagesLabel(f.pageStart, f.pageEnd)).join(", "), 1_000)}.)` : "";
	for (const detail of NOTES_LADDER) {
		const text = renderNotes(input, detail, failedLine, maxChars);
		if (text.length <= maxChars) return text;
	}
	// Grouped parts: 1, 2, 4, … parts per line until the lines fit; a single line always does.
	const head = `## Parts (shortened: one line per group of parts)`;
	const room = maxChars - head.length - failedLine.length - 4;
	for (let size = 1; ; size *= 2) {
		const groups: (typeof input.parts)[] = [];
		for (let i = 0; i < input.parts.length; i += size) groups.push(input.parts.slice(i, i + size));
		const share = Math.floor(room / groups.length) - 1;
		if (share < 40 && groups.length > 1) continue;
		const lines = groups.map((g) => {
			const first = g[0]!.batch;
			const last = g.at(-1)!.batch;
			const label = first === last ? `Part ${first.index + 1}` : `Parts ${first.index + 1}-${last.index + 1}`;
			const pages = pagesLabel(Math.min(...g.map((p) => p.batch.pageStart)), Math.max(...g.map((p) => p.batch.pageEnd)));
			return clip(`- ${label}, ${pages}: ${g.map((p) => p.notes.summaryBullets[0] ?? "").filter(Boolean).join("; ")}`, Math.max(1, share));
		});
		return [head, ...lines, ...(failedLine ? ["", failedLine] : [])].join("\n").slice(0, maxChars);
	}
}

/** Index one converted document. Throws only when it is empty or on abort (see the module comment). */
export async function digestMaterial(contentMd: string, deps: MaterialDigestDeps): Promise<MaterialDigest> {
	if (!contentMd.trim()) throw new Error("the material is empty");
	const batches = splitMaterial(contentMd, deps.split);
	const single = batches.length === 1;
	const label = deps.name ?? "the material";
	const done: { batch: MaterialBatch; notes: BatchNotes }[] = [];
	const failedBatches: DigestFailedBatch[] = [];
	const ref = (b: MaterialBatch): DigestBatchRef => ({ index: b.index, pageStart: b.pageStart, pageEnd: b.pageEnd, charStart: b.charStart, charEnd: b.charEnd });
	let profile: Checked<string> = { ok: false, error: "no part of the material could be indexed" };

	for (const batch of batches) {
		deps.onActivity?.(`indexing ${label}: part ${batch.index + 1} of ${batches.length} (p. ${batch.pageStart}-${batch.pageEnd})`);
		let notes: Checked<BatchNotes>;
		if (single) {
			const result = await callSingle(deps, batch);
			notes = result.notes;
			if (notes.ok) profile = result.profile.ok ? result.profile : { ok: false, error: `the profile could not be written: ${result.profile.error}` };
		} else {
			notes = await callValidated(deps, EXTRACTION_RULES, batchRequest(batch, batches.length, deps.name, false), AGAIN_JSON, (reply) => validateBatchReply(reply, batch));
		}
		if (notes.ok) done.push({ batch, notes: notes.value });
		else failedBatches.push({ ...ref(batch), error: notes.error });
	}

	const terms = mergeTerms(done.map((d) => d.notes.terms));
	const concepts = mergeConcepts(done.map((d) => d.notes.concepts));
	const figures = mergeFigures(done.map((d) => d.notes.figures));
	const pageCount = pageCountOf(contentMd);

	if (!single && done.length > 0) {
		deps.onActivity?.(`indexing ${label}: writing the profile`);
		const header = `The material: ${deps.name ? `"${clip(deps.name, NAME_MAX_CHARS)}"` : "one document"}, ${pageCount} pages, read in ${batches.length} parts.`;
		const notes = batchNotesText({ parts: done, failed: failedBatches, terms, concepts, figures }, REDUCE_REQUEST_MAX_CHARS - RETRY_RESERVE_CHARS - header.length - 20);
		const request = `${header}\n\n<notes>\n${notes}\n</notes>`;
		const result = await callValidated(deps, REDUCE_RULES, request, AGAIN_PROFILE, (reply) => {
			// a profile wrapped in {"profile": "…"} is still the profile
			let text = reply;
			if (/^\s*(```(json)?\s*)?\{/i.test(reply)) {
				try {
					const value = parseReply(reply) as { profile?: unknown } | null;
					if (value && typeof value.profile === "string") text = value.profile;
				} catch {
					// not JSON: judged as Markdown
				}
			}
			return validateProfile(text);
		});
		profile = result.ok ? result : { ok: false, error: `the profile could not be written: ${result.error}` };
	}
	deps.signal?.throwIfAborted();

	const base: Omit<MaterialDigest, "profile" | "profileError"> = {
		version: MATERIAL_DIGEST_VERSION,
		sourceHash: deps.sourceHash,
		converter: deps.converter,
		converterVersion: deps.converterVersion,
		indexerVersion: MATERIAL_INDEXER_VERSION,
		pageCount,
		sourcePageCount: deps.sourcePageCount ?? null,
		batches: batches.map(ref),
		failedBatches,
		terms,
		concepts,
		figures,
	};
	return profile.ok ? { ...base, profile: profile.value } : { ...base, profile: null, profileError: clip(profile.error, MAX_ERROR_CHARS) };
}
