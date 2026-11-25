import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
	MATERIAL_DIGEST_VERSION,
	MAX_TERM_NAMES,
	MAX_TERM_OCCURRENCES,
	type DigestBatch,
	type DigestBatchRef,
	type DigestConcept,
	type DigestFailedBatch,
	type DigestFigure,
	type DigestIndexedBatch,
	type DigestTerm,
	type MaterialDigest,
	type TermOccurrence,
	type TermTier,
} from "../../core/contracts/material-digest.ts";
import { byCodeUnit, conceptId, hasVisibleContent, normalizeName, termId } from "../../core/glossary.ts";
import { pageCountOf, rangePages, splitMaterial, type MaterialBatch, type SplitOptions } from "../../core/material-split.ts";
import { PROFILE_FORMAT_RULES, PROFILE_FORMAT_SECTIONS } from "./material-profiler.ts";

/**
 * The material indexer (fork addition, 2026-11-24; identity reworked 2026-11-25): reads the WHOLE of one converted
 * document (`content.md`, page-marked Markdown) in bounded parts (core/material-split.ts) and writes its digest
 * (contracts/material-digest.ts): every term with each of its occurrences (part, page, tier, the material's explicit
 * definition and its page, or none), the checkable concepts, the figures, each part's summary, and the source profile
 * the catalog already reads (core/materials.ts).
 *
 * Identity is the exact spelling (core/glossary.ts): occurrences are combined only when their ids are equal, never
 * because of aliases or symbols. Combining is a union by id (`combineTerms`), so a part re-run later merges into the
 * stored digest exactly as a clean run would have (`mergeRecoveredBatch`).
 *
 * Calls: one per part, each a JSON object validated against BATCH_SCHEMA (every page one the part's text is actually
 * on, every text visible); an invalid reply is asked again once with the validation errors; a part that still fails,
 * or whose call throws, is recorded as failed and the rest carry on. A thrown call is not retried here: retrying
 * transient transport errors is the injected `complete`'s job. With more than one part one more call (the reduce)
 * writes the profile from bounded notes (at most REDUCE_REQUEST_MAX_CHARS); a single part's one call writes the
 * profile too, so a slide deck costs exactly one call. The profile is validated on its own and gets its own one retry;
 * when it still fails, or its request cannot be built, the digest keeps every extracted note and has `profile: null`
 * with `profileError`. Only an empty document and an abort throw; once an abort is requested no further progress is
 * reported.
 *
 * Later, from the stored digest alone (read through `parseStoredDigest`): `buildReduceRequest` rebuilds the exact
 * reduce request, `rewriteProfile` runs only the profile step again, `batchFromRef` rebuilds a part from content.md to
 * re-run it, and `mergeRecoveredBatch` adds its notes.
 *
 * The model call is injected (`DigestModelCall`): no engine, store or file here. Parts run one after another.
 */

/** Bump when the prompts, schema, ids or merge rules change enough to re-index. 4: exact-spelling ids, occurrences, symbols. */
export const MATERIAL_INDEXER_VERSION = 4;

/** One model call, no tools: system prompt and user text in, the reply text out. `kind` says which step asks. */
export type DigestModelCall = (request: { system: string; user: string; kind: "extraction" | "profile" }, signal?: AbortSignal) => Promise<string>;

/** Where an indexing run is. */
export type DigestProgress = { stage: "part"; part: number; parts: number; pages: number[] } | { stage: "profile" };

export interface MaterialDigestDeps {
	complete: DigestModelCall;
	sourceHash: string;
	converter: string;
	converterVersion: string;
	/** The source's physical page count when known (a PDF's, at conversion): stored as `sourcePageCount`. */
	sourcePageCount?: number;
	/** The document's display name, for the prompts (stored bounded as the digest's `name`). */
	name?: string;
	signal?: AbortSignal;
	/** The part budget and token estimate (core/material-split.ts defaults). */
	split?: SplitOptions;
	/** Structured progress: each part as it starts (`part` 1-based), then the profile step. Never called once `signal` is aborted. */
	onProgress?: (progress: DigestProgress) => void;
}

/** What re-running the profile step needs (the name comes from the stored digest). */
export type ProfileDeps = Pick<MaterialDigestDeps, "complete" | "signal" | "onProgress">;

/** The longest user message of the reduce call, its retry included, in characters (about 16k tokens). */
export const REDUCE_REQUEST_MAX_CHARS = 64_000;
/**
 * The most an extraction request (its retry included) adds to its part's text, in characters: the header, the capped
 * name, heading path and page list, the profile format for a single part, and the rejected reply and errors.
 */
export const EXTRACTION_OVERHEAD_MAX_CHARS = 10_000;
/** The longest heading path shown in any request, in characters (each title is cut to HEADING_TITLE_MAX_CHARS). */
export const HEADING_PATH_MAX_CHARS = 160;
const HEADING_TITLE_MAX_CHARS = 60;
/** The longest heading title stored in digest.json (DigestBatchRef.headingPath). */
const STORED_TITLE_MAX_CHARS = 200;
/** The longest document name shown in a request and stored in the digest. */
export const NAME_MAX_CHARS = 200;
/** The longest page list shown in an extraction request; a longer one is described, never shortened. */
const PAGE_LIST_MAX_CHARS = 300;
/** The longest page list in a reduce label (a longer one ends in "…", and says so). */
const LABEL_PAGES_MAX_CHARS = 80;
/** How many validation errors the retry is shown. */
const MAX_ERRORS_SHOWN = 12;
/** The longest error kept (shown in a retry, stored in a failed batch / profileError). */
const MAX_ERROR_CHARS = 1_000;
/** How much of the rejected reply the retry is shown. */
const MAX_REJECTED_CHARS = 4_000;
/** Room kept in the reduce request for its retry (the rejected reply, the error, the instruction). */
const RETRY_RESERVE_CHARS = MAX_REJECTED_CHARS + MAX_ERROR_CHARS + 600;
/** The longest line of failed parts in the reduce notes. */
const FAILED_LINE_MAX_CHARS = 2_000;

const nonBlank = Type.String({ pattern: "\\S" });
const pageNumber = Type.Integer({ minimum: 1 });

/** A part's notes. */
export const BATCH_SCHEMA = Type.Object({
	summaryBullets: Type.Array(nonBlank),
	terms: Type.Array(
		Type.Object({
			term: nonBlank,
			aliases: Type.Array(Type.String()),
			symbols: Type.Array(Type.String()),
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

/**
 * The profile format: material-profiler.ts's one definition (the catalog cuts its "## " sections, core/materials.ts),
 * with the headings pinned to English because this profile is validated by them (validateProfile).
 */
const PROFILE_FORMAT = `A SOURCE PROFILE of this material. ${PROFILE_FORMAT_SECTIONS}

Write the section headings exactly as above, in English, whatever the material's language; write everything else in the material's own language. ${PROFILE_FORMAT_RULES}`;

const EXTRACTION_RULES = `You are an indexing specialist inside a learning application. You read one part of a student's course material (a slide deck, a textbook chapter, notes) and index it completely, so that nothing a student must learn from it is missed.

The material is Markdown. Every line "--- Page N ---" starts page N, wherever it is; text before the first such line is on the page stated in the request. A line that starts with a backslash ("\\--- Page N ---") is ordinary text, not a page break. A fenced code block (between \`\`\` or ~~~ lines) never continues past a page: a fence that is still open at the next "--- Page N ---" line, or at the end of the part, is not a fence. A "#" line inside a fence that closes on its own page is an example in the text, not a heading. When the request says the first line continues the previous part, the text was cut inside a long line: it may begin mid-word or mid-sentence, and its start is neither a heading nor a page break.

Reply with ONE JSON object and nothing else (no prose, no code fence), with these fields:
- "summaryBullets": short bullets, in order, of what this part covers.
- "terms": EVERY technical term this part defines, introduces or relies on, not only the prominent ones; include terms it uses without defining them. An empty list is right only for a part with no technical vocabulary at all. Each: {"term", "aliases", "symbols", "page", "tier", "definition", "definitionPage"}.
  - "term": the term in the form the material uses in running text. Do not capitalise it because it starts a sentence, a heading, a slide title or a bullet ("entropy" when the text writes "entropy" mid-sentence), but keep proper nouns, acronyms, units and notation exactly as written ("Bayes' theorem", "OLS", "mW", "O(n)", "C++"). The same term must be written the same way every time.
  - "aliases": other names and abbreviations the material uses for this same concept ("OLS" for "ordinary least squares", a translated name it gives); [] if none. Not symbols.
  - "symbols": the notation this part uses for it ("v", "λ", "C", "\\\\mathbb{R}"); [] if none.
  - "page": the page this part first mentions the term on.
  - "tier": "core" if the material treats it as something a student must know (defined, stressed, examined, built on), "supporting" if it appears in passing.
  - "definition": the material's own explicit definition of the term, in its words (quote it when it is short), or null when this part uses the term without defining it. Never write a definition the material does not give. When the part gives both a passing explanation and a formal definition, use the formal one.
  - "definitionPage": the page of that definition; null exactly when "definition" is null.
- "concepts": the checkable ideas — claims, rules, theorems, methods, results a student could be tested on — not single words. Each: {"name", "statement", "page"}: a short name, the idea stated as the material states it, and its page.
- "figures": each figure, diagram, table or chart: {"page", "caption"} (its caption, or one sentence on what it shows).

Write everything in the material's own language; never translate its terms. Use [] for a field with nothing in it; no text may be empty or blank. Every page must be one of this part's pages, as the request states them.`;

const REDUCE_RULES = `You are a reading specialist inside a learning application. You receive notes another reader made of one document of a student's course material: each part's pages, section and summary, then the document's terms (with the page each is first mentioned on, and the material's definition and its page when it gives one), its concepts and its figures. Long documents come with shortened notes, and the request says whether every part was read. Write the document's profile from them.

You see notes, not the material itself. Cite only pages the notes give for that item; leave out a claim the notes do not support rather than guess its page. Quote a definition only when the notes give its complete wording; otherwise name the term with its page. When parts are missing, do not present the notes as the whole document: say in "Scope and targets" which pages were not read. Write the prose in the material's own language (the language of the notes' summaries and terms).

Reply with the profile only (Markdown, starting at its first "## " heading; not JSON):

${PROFILE_FORMAT}`;

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

/**
 * One line of model text: whitespace collapsed, cut to at most `max` characters with an ellipsis. The cut is at a word
 * boundary; only a single word longer than the whole room is cut inside (never inside a surrogate pair). Pure.
 */
function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	if (max < 1) return "";
	const room = max - 1;
	let cut = flat.slice(0, room);
	if (flat[room] !== " ") {
		const space = cut.lastIndexOf(" ");
		if (space > 0) cut = cut.slice(0, space);
	}
	if (cut.length > 0 && isHighSurrogate(cut.charCodeAt(cut.length - 1))) cut = cut.slice(0, -1);
	return `${cut.trimEnd()}…`;
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

/** Ascending unique page numbers as ranges ("1-4, 7"), whole. Pure. */
function pageRanges(pages: readonly number[]): string {
	const parts: string[] = [];
	for (let i = 0; i < pages.length; i++) {
		let j = i;
		while (j + 1 < pages.length && pages[j + 1] === pages[j]! + 1) j++;
		parts.push(i === j ? `${pages[i]}` : `${pages[i]}-${pages[j]}`);
		i = j;
	}
	return parts.join(", ");
}

/** "page 3" or "pages 1-4, 7" (cut with "…" past `max` characters). Pure. */
function pagesLabel(pages: readonly number[], max = LABEL_PAGES_MAX_CHARS): string {
	return pages.length === 1 ? `page ${pages[0]}` : `pages ${clip(pageRanges(pages), max)}`;
}

/** The ascending union of several page sets, without argument spreads. Pure. */
function unionPages(sets: readonly (readonly number[])[]): number[] {
	const all = new Set<number>();
	for (const set of sets) for (const p of set) all.add(p);
	return [...all].sort((a, b) => a - b);
}

/**
 * A reply with its code fence removed when the fence wraps the profile: an opening fence line before the first "## "
 * heading, the matching closing fence as the reply's last line, and a "## " heading inside. Otherwise the reply as it
 * is (a code block inside a profile section stays). Pure.
 */
function unwrapFence(text: string): string {
	const trimmed = text.trim();
	const open = /^(`{3,}|~{3,})[^\n]*\n/m.exec(trimmed);
	if (!open) return trimmed;
	const firstHeading = trimmed.search(/^## /m);
	if (firstHeading >= 0 && firstHeading < open.index) return trimmed;
	const fence = open[1]!;
	const close = new RegExp(`\\n[ \\t]{0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`).exec(trimmed);
	const innerStart = open.index + open[0].length;
	if (!close || close.index < innerStart - 1) return trimmed;
	const inner = trimmed.slice(innerStart, close.index);
	return /^## /m.test(inner) ? inner : trimmed;
}

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

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * A profile, or what is wrong with it: a code fence around it removed, from its first "## " heading on, with at least
 * one of the six PROFILE_HEADINGS (any other section, or a missing one, is allowed) whose section has visible text
 * (the shared check, core/glossary.ts hasVisibleContent). Pure.
 */
export function validateProfile(text: string): Checked<string> {
	const body = profileBody(unwrapFence(text));
	const sections = body
		.split(/^(?=## )/m)
		.filter((s) => s.startsWith("## "))
		.map((s) => {
			const [first, ...rest] = s.split("\n");
			return { heading: first!.slice(3).replace(/[\s#:]+$/, "").trim().toLowerCase(), visible: rest.some((l) => !/^\s*#/.test(l) && hasVisibleContent(l)) };
		});
	const known = new Set(PROFILE_HEADINGS.map((h) => h.toLowerCase()));
	const recognised = sections.filter((s) => known.has(s.heading));
	const list = PROFILE_HEADINGS.map((h) => `"## ${h}"`).join(", ");
	if (recognised.length === 0) return { ok: false, error: `the profile has none of the section headings ${list}` };
	if (!recognised.some((s) => s.visible)) return { ok: false, error: "the profile's sections are empty" };
	return { ok: true, value: body };
}

/** A reduce reply judged as a profile; a profile wrapped in {"profile": "…"} is still the profile. Pure. */
function validateReduceReply(reply: string): Checked<string> {
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
}

/** What validation needs of a part: its pages, and their source order (for a first mention when numbering runs backwards). */
export type PagesOf = Pick<MaterialBatch, "pages"> & Partial<Pick<MaterialBatch, "pageOrder">>;

/** The unique visible names of a list, normalised, the term's own name left out. */
function cleanNames(names: readonly string[], own: string): string[] {
	const out = new Set<string>();
	for (const n of names) {
		const name = normalizeName(n);
		if (name !== "" && name !== own) out.add(name);
	}
	return [...out];
}

/**
 * The notes of one reply, or the problems with it. Every page must be one the part is on (`pages`); every text must
 * have visible content (the shared check); names are normalised (core/glossary.ts normalizeName); blank aliases and
 * symbols are dropped, not retried; a definition placed before the first mention (in source order) moves the mention.
 * Pure.
 */
export function validateBatchReply(reply: string, batch: PagesOf): Checked<BatchNotes> {
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
	const blank: string[] = [];
	const visible = (where: string, text: string) => {
		if (!hasVisibleContent(text)) blank.push(`${where}: has only invisible characters (it must say something)`);
	};
	notes.summaryBullets.forEach((b, i) => visible(`/summaryBullets/${i}`, b));
	notes.terms.forEach((t, i) => {
		visible(`/terms/${i}/term`, t.term);
		if (t.definition !== null) visible(`/terms/${i}/definition`, t.definition);
	});
	notes.concepts.forEach((c, i) => {
		visible(`/concepts/${i}/name`, c.name);
		visible(`/concepts/${i}/statement`, c.statement);
	});
	notes.figures.forEach((f, i) => visible(`/figures/${i}/caption`, f.caption));
	if (blank.length > 0) return { ok: false, error: clip(`the JSON does not match the format: ${blank.slice(0, MAX_ERRORS_SHOWN).join("; ")}`, MAX_ERROR_CHARS) };

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
		return { ok: false, error: clip(`this part is on ${pagesLabel(batch.pages, PAGE_LIST_MAX_CHARS)}, but ${problems.slice(0, MAX_ERRORS_SHOWN).join("; ")}`, MAX_ERROR_CHARS) };
	}
	const position = sourcePosition(batch);
	notes.summaryBullets = notes.summaryBullets.map((b) => b.trim());
	for (const t of notes.terms) {
		t.term = normalizeName(t.term);
		t.aliases = cleanNames(t.aliases, t.term);
		t.symbols = cleanNames(t.symbols, "");
		t.definition = t.definition?.trim() ?? null;
		// a definition is a mention: the first mention (in source order) is never after it
		if (t.definitionPage !== null && position(t.definitionPage) < position(t.page)) t.page = t.definitionPage;
	}
	for (const c of notes.concepts) {
		c.name = normalizeName(c.name);
		c.statement = c.statement.trim();
	}
	for (const f of notes.figures) f.caption = f.caption.trim();
	return { ok: true, value: notes };
}

/** A page's position in a part's source order (pageOrder; ascending pages when it is not known). */
function sourcePosition(batch: PagesOf): (page: number) => number {
	const order = batch.pageOrder ?? batch.pages;
	const at = new Map<number, number>();
	order.forEach((p, i) => {
		if (!at.has(p)) at.set(p, i);
	});
	return (page) => at.get(page) ?? Number.MAX_SAFE_INTEGER;
}

/** The request's page lines: the pages listed whole, or described when the list is too long (never a shortened list). */
function pagesLines(batch: MaterialBatch): string[] {
	const list = pageRanges(batch.pages);
	const begins = `The text begins on page ${batch.pageStart}.`;
	if (list.length <= PAGE_LIST_MAX_CHARS) return [`${begins} This part's pages: ${list}.`];
	return [
		`${begins} This part's pages: ${batch.pages.length} pages between ${batch.pages[0]} and ${batch.pages.at(-1)}, too many to list: page ${batch.pageStart} and every page whose "--- Page N ---" line is in the text below.`,
	];
}

/** The request for one part. */
function batchRequest(batch: MaterialBatch, total: number, name: string | null, withProfile: boolean): string {
	const lines = [
		`The material: ${name !== null ? `"${name}"` : "one document"}${total > 1 ? `, part ${batch.index + 1} of ${total}` : " (the whole document)"}.`,
		...pagesLines(batch),
	];
	if (batch.headingPath.length > 0) lines.push(`It begins inside the section: ${formatHeadingPath(batch.headingPath)}.`);
	if (batch.continuesLine) lines.push("Its first line continues a line of the previous part (the text was cut inside a long line).");
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

/** A progress report, unless an abort was requested (then the abort is thrown instead). */
function report(deps: Pick<MaterialDigestDeps, "signal" | "onProgress">, progress: DigestProgress): void {
	deps.signal?.throwIfAborted();
	deps.onProgress?.(progress);
}

/** One model call: its reply, or the error it threw. Aborts throw, also when the abort lands while the call runs. */
async function ask(deps: Pick<MaterialDigestDeps, "complete" | "signal">, kind: "extraction" | "profile", system: string, user: string): Promise<Checked<string>> {
	deps.signal?.throwIfAborted();
	let reply: string;
	try {
		reply = await deps.complete({ system, user, kind }, deps.signal);
	} catch (err) {
		if (isAbort(err, deps.signal)) throw err;
		return { ok: false, error: clip(`the model call failed: ${err instanceof Error ? err.message : String(err)}`, MAX_ERROR_CHARS) };
	}
	deps.signal?.throwIfAborted();
	return { ok: true, value: reply };
}

/** A validated call: the reply, asked once more with its errors when it fails `validate`. A thrown call is not retried. */
async function callValidated<T>(
	deps: Pick<MaterialDigestDeps, "complete" | "signal">,
	kind: "extraction" | "profile",
	system: string,
	user: string,
	again: string,
	validate: (reply: string) => Checked<T>,
): Promise<Checked<T>> {
	let request = user;
	let last = "";
	for (let attempt = 0; attempt < 2; attempt++) {
		const reply = await ask(deps, kind, system, request);
		if (!reply.ok) return reply;
		const result = validate(reply.value);
		if (result.ok) return result;
		last = result.error;
		request = retryRequest(user, reply.value, result.error, again);
	}
	return { ok: false, error: last };
}

/**
 * A single-part document's call: notes and profile in one JSON reply, each validated on its own. One retry asks for
 * what is still wrong; a valid half of either reply is kept. A thrown call is not retried.
 */
async function callSingle(deps: MaterialDigestDeps, batch: MaterialBatch, name: string | null): Promise<{ notes: Checked<BatchNotes>; profile: Checked<string> }> {
	const user = batchRequest(batch, 1, name, true);
	let notes: Checked<BatchNotes> = { ok: false, error: "" };
	let profile: Checked<string> = { ok: false, error: "" };
	let request = user;
	for (let attempt = 0; attempt < 2; attempt++) {
		const reply = await ask(deps, "extraction", EXTRACTION_RULES, request);
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

// ── Combining by exact id ──────────────────────────────────────────────────

/**
 * An occurrence list in source order cut to MAX_TERM_OCCURRENCES: the first MAX_TERM_OCCURRENCES - 2, plus the
 * occurrence that supplies the definition and the first core one when they come later. Cutting the union of two cut
 * lists gives the cut of the union, so a recovery merge equals a clean run. Pure.
 */
function truncateOccurrences(occurrences: readonly TermOccurrence[]): TermOccurrence[] {
	if (occurrences.length <= MAX_TERM_OCCURRENCES) return [...occurrences];
	const keep = new Set<number>();
	for (let i = 0; i < MAX_TERM_OCCURRENCES - 2; i++) keep.add(i);
	const supplier = definitionIndex(occurrences);
	if (supplier >= 0) keep.add(supplier);
	const core = occurrences.findIndex((o) => o.tier === "core");
	if (core >= 0) keep.add(core);
	return occurrences.filter((_, i) => keep.has(i));
}

/** The occurrence that supplies a term's definition: the first core one with a definition, else the first with one; -1 when none. */
function definitionIndex(occurrences: readonly TermOccurrence[]): number {
	const core = occurrences.findIndex((o) => o.definition !== null && o.tier === "core");
	return core >= 0 ? core : occurrences.findIndex((o) => o.definition !== null);
}

/** The summary fields of a term derived from its occurrences (in source order, possibly cut). Pure. */
export function summarizeOccurrences(occurrences: readonly TermOccurrence[]): Pick<DigestTerm, "page" | "tier" | "definition" | "definitionPage" | "definitionTier"> {
	const supplier = occurrences[definitionIndex(occurrences)];
	return {
		page: occurrences[0]!.page,
		tier: occurrences.some((o) => o.tier === "core") ? "core" : "supporting",
		definition: supplier?.definition ?? null,
		definitionPage: supplier?.definitionPage ?? null,
		definitionTier: supplier ? supplier.tier : null,
	};
}

/** The smallest MAX_TERM_NAMES of a set of names, sorted. */
const boundedNames = (names: Iterable<string>) => [...names].sort(byCodeUnit).slice(0, MAX_TERM_NAMES);

/** Compare sort keys [part, list, rank]. */
const compareKeys = (a: readonly number[], b: readonly number[]) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;

/**
 * Terms of disjoint parts combined: a union by exact id (never by alias or symbol) of their occurrences (stable, by
 * part), aliases and symbols, and exact counts; in order of first occurrence. Combining the stored terms with a
 * recovered part's gives what a clean run of all the parts gives. Pure.
 */
export function combineTerms(lists: readonly (readonly DigestTerm[])[]): DigestTerm[] {
	interface Acc {
		id: string;
		term: string;
		key: number[];
		aliases: Set<string>;
		symbols: Set<string>;
		occurrences: TermOccurrence[];
		count: number;
	}
	const byId = new Map<string, Acc>();
	lists.forEach((list, li) => {
		list.forEach((t, rank) => {
			if (t.occurrences.length === 0) throw new Error(`the term ${JSON.stringify(t.term)} has no occurrence`);
			const key = [t.occurrences[0]!.part, li, rank];
			let acc = byId.get(t.id);
			if (!acc) {
				acc = { id: t.id, term: t.term, key, aliases: new Set(), symbols: new Set(), occurrences: [], count: 0 };
				byId.set(t.id, acc);
			} else if (compareKeys(key, acc.key) < 0) acc.key = key;
			for (const a of t.aliases) if (a !== acc.term) acc.aliases.add(a);
			for (const s of t.symbols) acc.symbols.add(s);
			for (const o of t.occurrences) acc.occurrences.push(o);
			acc.count += t.occurrenceCount;
		});
	});
	return [...byId.values()]
		.sort((a, b) => compareKeys(a.key, b.key))
		.map((acc) => {
			const sorted = acc.occurrences.map((o, i) => ({ o, i })).sort((x, y) => x.o.part - y.o.part || x.i - y.i).map((x) => x.o);
			const occurrences = truncateOccurrences(sorted);
			return {
				id: acc.id,
				term: acc.term,
				aliases: boundedNames(acc.aliases),
				symbols: boundedNames(acc.symbols),
				...summarizeOccurrences(occurrences),
				occurrences,
				occurrenceCount: acc.count,
			};
		});
}

/**
 * One part's validated terms as digest terms (part = its index): each listing is an occurrence, in the part's source
 * order of pages (stable; the reply's order without `pagesOf`), grouped by exact id. Throws on a name with nothing
 * visible (validate first). Pure.
 */
export function partTerms(part: number, terms: readonly BatchTerm[], pagesOf?: PagesOf): DigestTerm[] {
	const position = pagesOf ? sourcePosition(pagesOf) : () => 0;
	const ordered = terms.map((t, i) => ({ t, i })).sort((a, b) => position(a.t.page) - position(b.t.page) || a.i - b.i);
	const singles = ordered.map(({ t }) => {
		const name = normalizeName(t.term);
		if (name === "") throw new Error(`a term without a name reached the merge (${JSON.stringify(t.term)}): validate the notes first`);
		const occurrence: TermOccurrence = { part, page: t.page, tier: t.tier, definition: t.definition, definitionPage: t.definitionPage };
		return {
			id: termId(name),
			term: name,
			aliases: cleanNames(t.aliases, name),
			symbols: cleanNames(t.symbols, ""),
			...summarizeOccurrences([occurrence]),
			occurrences: [occurrence],
			occurrenceCount: 1,
		} satisfies DigestTerm;
	});
	return combineTerms([singles]);
}

/** Every part's terms combined (part = list index unless `parts` says otherwise). Pure. */
export function mergeTerms(perPart: readonly (readonly BatchTerm[])[], pages?: readonly PagesOf[], parts?: readonly number[]): DigestTerm[] {
	return combineTerms(perPart.map((terms, i) => partTerms(parts?.[i] ?? i, terms, pages?.[i])));
}

/** Concepts of disjoint parts combined by exact id: the first occurrence in source order keeps its name, statement and page. Pure. */
export function combineConcepts(lists: readonly (readonly DigestConcept[])[]): DigestConcept[] {
	const byId = new Map<string, { c: DigestConcept; key: number[] }>();
	lists.forEach((list, li) =>
		list.forEach((c, rank) => {
			const key = [c.part, li, rank];
			const seen = byId.get(c.id);
			if (!seen || compareKeys(key, seen.key) < 0) byId.set(c.id, { c, key });
		}),
	);
	return [...byId.values()].sort((a, b) => compareKeys(a.key, b.key)).map((x) => ({ ...x.c }));
}

/** One part's validated concepts (throws on a name with nothing visible). Pure. */
export function partConcepts(part: number, concepts: BatchNotes["concepts"]): DigestConcept[] {
	return combineConcepts([
		concepts.map((c) => {
			const name = normalizeName(c.name);
			if (name === "") throw new Error(`a concept without a name reached the merge (${JSON.stringify(c.name)}): validate the notes first`);
			return { id: conceptId(name), name, statement: c.statement.trim(), page: c.page, part };
		}),
	]);
}

/** Every part's concepts combined (part = list index). Pure. */
export function mergeConcepts(perPart: readonly BatchNotes["concepts"][]): DigestConcept[] {
	return combineConcepts(perPart.map((concepts, i) => partConcepts(i, concepts)));
}

/** Figures of disjoint parts combined: each page and caption once (the first in source order), in source order. Pure. */
export function combineFigures(lists: readonly (readonly DigestFigure[])[]): DigestFigure[] {
	const byKey = new Map<string, { f: DigestFigure; key: number[] }>();
	lists.forEach((list, li) =>
		list.forEach((f, rank) => {
			const id = `${f.page}|${f.caption}`;
			const key = [f.part, li, rank];
			const seen = byKey.get(id);
			if (!seen || compareKeys(key, seen.key) < 0) byKey.set(id, { f, key });
		}),
	);
	return [...byKey.values()].sort((a, b) => compareKeys(a.key, b.key)).map((x) => ({ ...x.f }));
}

/** One part's validated figures. Pure. */
export function partFigures(part: number, figures: BatchNotes["figures"]): DigestFigure[] {
	return combineFigures([figures.map((f) => ({ page: f.page, caption: f.caption.trim(), part }))]);
}

// ── The reduce notes ───────────────────────────────────────────────────────

/** How much of the notes the reduce is shown; the ladder runs from the full notes to the shortest. */
interface NotesDetail {
	bullets: number;
	chars: number;
	headingPath: boolean;
	figures: boolean;
	supporting: "full" | "names" | "none";
	concepts: "full" | "names" | "none";
	/** fill: as many core names as the room left holds (at least their reserved share), in first-mention order, on one line. */
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

/** An indexed part as the reduce notes read it. */
export type ReducePart = Pick<DigestIndexedBatch, "index" | "pages" | "headingPath" | "summaryBullets">;
/** A failed part as the reduce notes read it. */
export type ReduceFailedPart = Pick<DigestFailedBatch, "index" | "pages">;
/** A term as the reduce notes read it. */
export type ReduceTerm = Pick<DigestTerm, "term" | "aliases" | "symbols" | "page" | "tier" | "definition" | "definitionPage">;

export interface ReduceNotesInput {
	/** The indexed parts, in order. */
	parts: readonly ReducePart[];
	/** The failed parts, in order. */
	failed: readonly ReduceFailedPart[];
	/** The combined lists (each term once). */
	terms: readonly ReduceTerm[];
	concepts: readonly Pick<DigestConcept, "name" | "statement" | "page">[];
	figures: readonly Pick<DigestFigure, "page" | "caption">[];
}

/** The share of the notes budget kept for core term names at every level of detail. */
const coreReserve = (maxChars: number) => Math.floor(maxChars / 4);

/** Runs of consecutive part indexes, in order (a gap in the index always starts a new run). */
function runsOf<T extends { index: number }>(items: readonly T[]): T[][] {
	const runs: T[][] = [];
	for (const item of items) {
		const run = runs.at(-1);
		if (run && run.at(-1)!.index + 1 === item.index) run.push(item);
		else runs.push([item]);
	}
	return runs;
}

/** "Part 3" or "Parts 3-5" and the pages (the stored page sets' union) of a run of consecutive parts. */
function runLabel(run: readonly { index: number; pages: readonly number[] }[], capital: boolean): string {
	const first = run[0]!;
	const last = run.at(-1)!;
	const word = capital ? "Part" : "part";
	const which = run.length === 1 ? `${word} ${first.index + 1}` : `${word}s ${first.index + 1}-${last.index + 1}`;
	return `${which}, ${pagesLabel(unionPages(run.map((p) => p.pages)))}`;
}

/**
 * The failed parts in at most `max` characters: always how many, then as many runs of consecutive failed parts (with
 * their pages) as fit, and how many parts are not listed. Never cut inside an item. "" when none failed (or when not
 * even the count fits). Pure.
 */
function failedSummary(failed: readonly ReduceFailedPart[], max: number): string {
	const n = failed.length;
	if (n === 0) return "";
	const head = `(Not indexed, so the notes are missing for ${n === 1 ? "this part" : `these ${n} parts`}: `;
	const runs = runsOf(failed);
	const items = runs.map((r) => runLabel(r, false));
	const tail = (unlisted: number) => (unlisted > 0 ? ` (+${unlisted} more not listed)` : "");
	let length = head.length + 2; // ".)"
	let listed = 0;
	let k = 0;
	for (; k < items.length; k++) {
		const next = length + (k > 0 ? 2 : 0) + items[k]!.length;
		if (next + tail(n - listed - runs[k]!.length).length > max) break;
		length = next;
		listed += runs[k]!.length;
	}
	if (k > 0) return `${head}${items.slice(0, k).join("; ")}${tail(n - listed)}.)`;
	const counted = `(Not indexed, so the notes are missing for ${n} ${n === 1 ? "part" : "parts"}; not listed for length.)`;
	if (counted.length <= max) return counted;
	const tiny = `(Not indexed: ${n} ${n === 1 ? "part" : "parts"}.)`;
	return tiny.length <= max ? tiny : "";
}

const CORE_LABEL = "Core terms (names only, in order of first mention): ";

/** As many core term names as fit in `max` characters, whole, in order, then how many are left out; "" when none. Pure. */
function coreNamesLine(core: readonly ReduceTerm[], max: number): string {
	if (core.length === 0) return "";
	const names = core.map((t) => clip(t.term, 60));
	const tail = (left: number) => (left > 0 ? ` (+${left} more core terms left out for length)` : "");
	let length = CORE_LABEL.length;
	let k = 0;
	for (; k < names.length; k++) {
		const next = length + (k > 0 ? 2 : 0) + names[k]!.length;
		if (next + tail(names.length - k - 1).length > max) break;
		length = next;
	}
	if (k > 0) return `${CORE_LABEL}${names.slice(0, k).join(", ")}${tail(names.length - k)}`;
	const none = `(${core.length} core terms, left out for length.)`;
	return none.length <= max ? none : "";
}

/** The notes at one level of detail, or null when the level cannot give the core names their reserved share. */
function renderNotes(input: ReduceNotesInput, d: NotesDetail, failedLine: string, maxChars: number): string | null {
	const blocks: string[] = [];
	const parts = input.parts.map((part) => {
		const where = d.headingPath && part.headingPath.length > 0 ? ` (in ${formatHeadingPath(part.headingPath)})` : "";
		const bullets = part.summaryBullets.slice(0, d.bullets).map((b) => `- ${clip(b, d.chars)}`);
		const more = part.summaryBullets.length > bullets.length ? [`- (+${part.summaryBullets.length - bullets.length} more)`] : [];
		return [`### Part ${part.index + 1}: ${pagesLabel(part.pages)}${where}`, ...bullets, ...more].join("\n");
	});
	blocks.push(`## Parts\n${parts.join("\n")}`);
	if (failedLine) blocks.push(failedLine);

	const termLine = (t: ReduceTerm, full: boolean) => {
		const names = [...t.aliases, ...t.symbols];
		const aliases = names.length > 0 ? ` (${clip(names.join(", "), 80)})` : "";
		const head = `- ${clip(t.term, 80)}${aliases} [${t.tier}, p. ${t.page}`;
		if (!full) return `${head}]`;
		return t.definition === null ? `${head}; not defined in the material]` : `${head}; defined p. ${t.definitionPage}]: ${clip(t.definition, d.chars)}`;
	};
	const termLines: string[] = [];
	const left: string[] = [];
	let fill: ReduceTerm[] = [];
	for (const [tier, mode] of [["core", d.core], ["supporting", d.supporting]] as const) {
		const list = input.terms.filter((t) => t.tier === tier);
		if (mode === "fill") fill = list;
		else if (mode === "none") {
			if (list.length > 0) left.push(`${list.length} ${tier}`);
		} else for (const t of list) termLines.push(termLine(t, mode === "full")); // no argument spread: any number of terms
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
		// The core names that fit in the room the rest leaves; that room must hold at least their reserved share.
		const room = maxChars - blocks.join("\n\n").length - 1;
		if (room < Math.min(coreNamesLine(fill, Infinity).length, coreReserve(maxChars))) return null;
		const line = coreNamesLine(fill, room);
		if (line) blocks[termsAt] = `${blocks[termsAt]}\n${line}`;
	}
	return blocks.join("\n\n");
}

/**
 * The indexed parts as lines of at most `room` characters in all: runs of consecutive parts (never across a gap) are
 * grouped 1, 2, 4, … parts per line until each line has room for some summary; every part is named when the labels fit
 * at all, else as many labels as fit and how many parts are not listed. Never cut inside a word (one overlong word
 * excepted). Pure.
 */
function partsLines(parts: readonly ReducePart[], room: number): string {
	if (parts.length === 0 || room <= 0) return "";
	const runs = runsOf(parts);
	const longestRun = runs.reduce((m, r) => Math.max(m, r.length), 0);
	for (let size = 1; ; size *= 2) {
		const last = size >= longestRun;
		const groups = runs.flatMap((r) => Array.from({ length: Math.ceil(r.length / size) }, (_, i) => r.slice(i * size, (i + 1) * size)));
		const labels = groups.map((g) => `- ${runLabel(g, true)}`);
		const mandatory = labels.reduce((s, l) => s + l.length, 0) + groups.length - 1;
		if (mandatory > room) {
			if (!last) continue;
			// not even one label per run fits: as many as do, then the count of the rest
			const lines: string[] = [];
			let length = 0;
			let listed = 0;
			for (let i = 0; i < groups.length; i++) {
				const tail = `(+${parts.length - listed - groups[i]!.length} more indexed parts not listed for length)`;
				const next = length + (i > 0 ? 1 : 0) + labels[i]!.length;
				if (next + 1 + tail.length > room) break;
				lines.push(labels[i]!);
				length = next;
				listed += groups[i]!.length;
			}
			if (lines.length === 0) {
				const counted = `(${parts.length} parts indexed, not listed for length.)`;
				return counted.length <= room ? counted : "";
			}
			return [...lines, `(+${parts.length - listed} more indexed parts not listed for length)`].join("\n");
		}
		const share = Math.floor((room - mandatory) / groups.length);
		if (share < 30 && !last) continue;
		return groups
			.map((g, i) => {
				const summary = share >= 8 ? clip(g.map((p) => p.summaryBullets[0] ?? "").filter(Boolean).join("; "), share - 2) : "";
				return summary ? `${labels[i]}: ${summary}` : labels[i]!;
			})
			.join("\n");
	}
}

/** Past the ladder: grouped parts, the failed line, and a terms block that keeps the core names' reserved share. */
function groupedNotes(input: ReduceNotesInput, maxChars: number, failedLine: string): string {
	const SEP = 2; // "\n\n" between two blocks
	const head = "## Parts (shortened)";
	const termsHead = "## Terms";
	const core = input.terms.filter((t) => t.tier === "core");
	const counts = [
		[input.terms.length - core.length, "supporting terms"],
		[input.concepts.length, "concepts"],
		[input.figures.length, "figures"],
	] as const;
	const leftOutList = counts.filter(([n]) => n > 0).map(([n, what]) => `${n} ${what}`);
	const leftOut = leftOutList.length > 0 ? `(Left out for length: ${leftOutList.join(", ")}.)` : "";

	// The blocks are joined by SEP, so every block but the first costs one: `used` counts the blocks taken so far with
	// their separators. The failed line is taken first, so alone it needs no separator.
	let used = 0;
	let blocks = 0;
	const room = (extra = 0) => maxChars - used - (blocks > 0 ? SEP : 0) - extra;
	const take = (block: string) => {
		used += block.length + (blocks > 0 ? SEP : 0);
		blocks++;
	};
	const failedBlock = failedLine && failedLine.length <= room() ? failedLine : "";
	if (failedBlock) take(failedBlock);
	const termsWant = core.length > 0 ? SEP + termsHead.length + 1 + Math.min(coreNamesLine(core, Infinity).length, coreReserve(maxChars)) : 0;
	const partsText = partsLines(input.parts, room(termsWant + head.length + 1));
	const partsBlock = partsText ? `${head}\n${partsText}` : "";
	if (partsBlock) take(partsBlock);

	let termsBlock = "";
	const termsRoom = room(termsHead.length + 1);
	if (termsRoom > 0) {
		const lines: string[] = [];
		const coreLine = coreNamesLine(core, termsRoom);
		if (coreLine) lines.push(coreLine);
		if (leftOut && (coreLine ? coreLine.length + 1 : 0) + leftOut.length <= termsRoom) lines.push(leftOut);
		if (lines.length > 0) termsBlock = `${termsHead}\n${lines.join("\n")}`;
	}
	return [partsBlock, failedBlock, termsBlock].filter(Boolean).join("\n\n");
}

/**
 * The reduce call's notes, at most `maxChars` characters whatever the document's size: page-cited, each term, concept
 * and figure once, and as much detail as fits (NOTES_LADDER). Core term names keep a reserved share of the budget (a
 * quarter) at every level, and the failed parts are always counted. Past the ladder's end, runs of consecutive parts
 * share lines (never across a gap in the index). Nothing is cut inside a word, except one word longer than its whole
 * room. Pure.
 */
export function batchNotesText(input: ReduceNotesInput, maxChars = REDUCE_REQUEST_MAX_CHARS - RETRY_RESERVE_CHARS): string {
	const failedLine = failedSummary(input.failed, Math.min(FAILED_LINE_MAX_CHARS, Math.max(Math.floor(maxChars / 8), Math.min(maxChars, 100))));
	for (const detail of NOTES_LADDER) {
		const text = renderNotes(input, detail, failedLine, maxChars);
		if (text !== null && text.length <= maxChars) return text;
	}
	return groupedNotes(input, maxChars, failedLine);
}

/** The failed parts of a digest, in order: derived from `batches`, never stored. Pure. */
export function failedBatchesOf(digest: Pick<MaterialDigest, "batches">): DigestFailedBatch[] {
	return digest.batches.filter((b): b is DigestFailedBatch => b.status === "failed");
}

/** What a digest needs to rebuild its reduce request. */
export type ReduceSource = Pick<MaterialDigest, "name" | "pageCount" | "batches" | "terms" | "concepts" | "figures">;

/**
 * The reduce (profile) request for a digest, exactly as digestMaterial sends it, from the digest alone (a stored
 * digest.json works, its stored `name` included): no model call. Null when no part was indexed. Pure.
 */
export function buildReduceRequest(digest: ReduceSource): { system: string; user: string } | null {
	const parts = digest.batches.filter((b): b is DigestIndexedBatch => b.status === "indexed");
	if (parts.length === 0) return null;
	const failed = failedBatchesOf(digest);
	const n = digest.batches.length;
	const read =
		failed.length === 0
			? `read in ${n} ${n === 1 ? "part" : "parts"}, every part indexed`
			: `read in ${n} parts, of which ${failed.length} could not be indexed: the notes are missing for them, so they do not cover the whole document`;
	const header = `The material: ${digest.name !== null ? `"${digest.name}"` : "one document"}, ${digest.pageCount} ${digest.pageCount === 1 ? "page" : "pages"}, ${read}.`;
	const notes = batchNotesText({ parts, failed, terms: digest.terms, concepts: digest.concepts, figures: digest.figures }, REDUCE_REQUEST_MAX_CHARS - RETRY_RESERVE_CHARS - header.length - 20);
	return { system: REDUCE_RULES, user: `${header}\n\n<notes>\n${notes}\n</notes>` };
}

/** The reduce call for a digest: its profile, or why there is none. A failure while building the request is a profileError. */
async function writeProfile(deps: ProfileDeps, digest: ReduceSource): Promise<Checked<string>> {
	let request: { system: string; user: string } | null;
	try {
		request = buildReduceRequest(digest);
	} catch (err) {
		return { ok: false, error: `the profile request could not be built: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (!request) return { ok: false, error: "no part of the material could be indexed" };
	report(deps, { stage: "profile" });
	const result = await callValidated(deps, "profile", request.system, request.user, AGAIN_PROFILE, validateReduceReply);
	return result.ok ? result : { ok: false, error: `the profile could not be written: ${result.error}` };
}

/** A digest with a new profile result; everything else kept. */
function withProfile<T extends Omit<MaterialDigest, "profile" | "profileError">>(base: T, profile: Checked<string>): MaterialDigest {
	const { profile: _p, profileError: _e, ...rest } = base as T & { profile?: unknown; profileError?: unknown };
	return profile.ok ? { ...rest, profile: profile.value } : { ...rest, profile: null, profileError: clip(profile.error, MAX_ERROR_CHARS) };
}

/** What rewriteProfile gives: the digest to store, and why the rewrite failed (null when it worked). */
export interface RewriteResult {
	digest: MaterialDigest;
	/** The rewrite's failure; a digest that already had a valid profile keeps it unchanged. */
	error: string | null;
}

/**
 * Run only the profile step again for a stored digest (one reduce call, its one retry), from the digest alone: the
 * terms, concepts, figures and parts are kept as they are. When it works, the digest has the new profile. When it
 * fails (or no part was indexed: then no call is made), a digest that already had a valid profile keeps it unchanged,
 * and one without a profile gets the new profileError; either way `error` says why. Throws on abort.
 */
export async function rewriteProfile(digest: MaterialDigest, deps: ProfileDeps): Promise<RewriteResult> {
	deps.signal?.throwIfAborted();
	const profile = await writeProfile(deps, digest);
	deps.signal?.throwIfAborted();
	if (profile.ok) return { digest: withProfile(digest, profile), error: null };
	const error = clip(profile.error, MAX_ERROR_CHARS);
	if (digest.profile !== null && validateProfile(digest.profile).ok) return { digest, error };
	return { digest: withProfile(digest, profile), error };
}

/**
 * A stored part rebuilt from the content.md it was split from (the same sourceHash), to re-run it alone: the same
 * text, pages and heading path the extraction request used, its source page order and whether it continues a line.
 * Throws when the range is not inside the document. Pure.
 */
export function batchFromRef(contentMd: string, ref: DigestBatchRef): MaterialBatch {
	if (!Number.isSafeInteger(ref.charStart) || !Number.isSafeInteger(ref.charEnd) || ref.charStart < 0 || ref.charEnd > contentMd.length || ref.charStart >= ref.charEnd) {
		throw new RangeError(`part ${ref.index} (${ref.charStart}-${ref.charEnd}) is not inside this document (${contentMd.length} characters)`);
	}
	const { pageOrder, continuesLine } = rangePages(contentMd, ref.charStart, ref.charEnd, ref.pageStart);
	return {
		index: ref.index,
		pageStart: ref.pageStart,
		pageEnd: ref.pageEnd,
		pages: [...ref.pages],
		pageOrder,
		continuesLine,
		headingPath: [...ref.headingPath],
		text: contentMd.slice(ref.charStart, ref.charEnd),
		charStart: ref.charStart,
		charEnd: ref.charEnd,
	};
}

/** A split part as digest.json stores it (heading titles bounded). */
function refOf(b: MaterialBatch): DigestBatchRef {
	return {
		index: b.index,
		pageStart: b.pageStart,
		pageEnd: b.pageEnd,
		pages: [...b.pages],
		headingPath: b.headingPath.map((t) => clip(t, STORED_TITLE_MAX_CHARS)),
		charStart: b.charStart,
		charEnd: b.charEnd,
	};
}

/** The bounded name the requests show and the digest stores; null without one. */
const requestName = (name: string | undefined) => (name !== undefined && hasVisibleContent(name) ? clip(name, NAME_MAX_CHARS) : null);

/**
 * A recovered part's notes added to a stored digest: that part (failed in the digest) becomes indexed, and its terms,
 * concepts and figures are a union by id with the stored ones. The result equals what a clean run that indexed the
 * part the first time would have stored, apart from the profile, which is kept as it was (rewrite it to include the
 * part). Throws when the part is not a failed part of this digest. `notes` must be validated against `batch`. Pure.
 */
export function mergeRecoveredBatch(digest: MaterialDigest, batch: MaterialBatch, notes: BatchNotes): MaterialDigest {
	const at = digest.batches.findIndex((b) => b.index === batch.index);
	const stored = digest.batches[at];
	if (!stored || stored.status !== "failed") throw new Error(`part ${batch.index} is not a failed part of this digest`);
	const ref = refOf(batch);
	if (ref.charStart !== stored.charStart || ref.charEnd !== stored.charEnd) throw new Error(`part ${batch.index} does not have the stored range`);
	const batches = digest.batches.map((b, i): DigestBatch => (i === at ? { ...ref, status: "indexed", summaryBullets: notes.summaryBullets } : b));
	return {
		...digest,
		batches,
		terms: combineTerms([digest.terms, partTerms(batch.index, notes.terms, batch)]),
		concepts: combineConcepts([digest.concepts, partConcepts(batch.index, notes.concepts)]),
		figures: combineFigures([digest.figures, partFigures(batch.index, notes.figures)]),
	};
}

/** Index one converted document. Throws only when it is empty or on abort (see the module comment). */
export async function digestMaterial(contentMd: string, deps: MaterialDigestDeps): Promise<MaterialDigest> {
	deps.signal?.throwIfAborted();
	if (!hasVisibleContent(contentMd)) throw new Error("the material is empty");
	const batches = splitMaterial(contentMd, deps.split);
	const single = batches.length === 1;
	const name = requestName(deps.name);
	const terms: DigestTerm[][] = [];
	const concepts: DigestConcept[][] = [];
	const figures: DigestFigure[][] = [];
	const planned: DigestBatch[] = [];
	let profile: Checked<string> = { ok: false, error: "no part of the material could be indexed" };

	for (const batch of batches) {
		report(deps, { stage: "part", part: batch.index + 1, parts: batches.length, pages: [...batch.pages] });
		// the request shows the same bounded heading titles digest.json stores, so a re-run from the digest asks the same
		const stored = refOf(batch);
		const asked = { ...batch, headingPath: stored.headingPath };
		let notes: Checked<BatchNotes>;
		if (single) {
			const result = await callSingle(deps, asked, name);
			notes = result.notes;
			if (notes.ok) profile = result.profile.ok ? result.profile : { ok: false, error: `the profile could not be written: ${result.profile.error}` };
		} else {
			notes = await callValidated(deps, "extraction", EXTRACTION_RULES, batchRequest(asked, batches.length, name, false), AGAIN_JSON, (reply) => validateBatchReply(reply, batch));
		}
		if (notes.ok) {
			terms.push(partTerms(batch.index, notes.value.terms, batch));
			concepts.push(partConcepts(batch.index, notes.value.concepts));
			figures.push(partFigures(batch.index, notes.value.figures));
			planned.push({ ...stored, status: "indexed", summaryBullets: notes.value.summaryBullets });
		} else planned.push({ ...stored, status: "failed", error: notes.error });
	}

	const base: Omit<MaterialDigest, "profile" | "profileError"> = {
		version: MATERIAL_DIGEST_VERSION,
		sourceHash: deps.sourceHash,
		converter: deps.converter,
		converterVersion: deps.converterVersion,
		indexerVersion: MATERIAL_INDEXER_VERSION,
		name,
		pageCount: pageCountOf(contentMd),
		sourcePageCount: deps.sourcePageCount ?? null,
		batches: planned,
		terms: combineTerms(terms),
		concepts: combineConcepts(concepts),
		figures: combineFigures(figures),
	};
	if (!single && terms.length > 0) profile = await writeProfile(deps, base);
	deps.signal?.throwIfAborted();
	return withProfile(base, profile);
}

// ── The validated read boundary ────────────────────────────────────────────

/** Why a stored digest cannot be used: another version (re-index it), or a file that is not a valid digest. */
export type StoredDigestProblem = { kind: "version"; version: unknown; reason: string } | { kind: "invalid"; reason: string };

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isPage = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1;
const isTier = (v: unknown): v is TermTier => v === "core" || v === "supporting";
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
const isNormalizedName = (v: unknown): v is string => typeof v === "string" && v !== "" && normalizeName(v) === v;

/**
 * THE read boundary for digest.json: parses (a string) or takes a parsed value, and validates the version, every
 * shape, integer offsets that tile from 0, page sets, that every id is the id of its name, that every occurrence,
 * concept and figure names an indexed part and one of its pages, and that every term's summary fields are the ones
 * its occurrences give. Returns the typed digest, or the reason it cannot be used. Pure.
 */
export function parseStoredDigest(input: unknown): { ok: true; digest: MaterialDigest } | { ok: false; problem: StoredDigestProblem } {
	const invalid = (reason: string) => ({ ok: false as const, problem: { kind: "invalid" as const, reason } });
	let value: unknown = input;
	if (typeof input === "string") {
		try {
			value = JSON.parse(input);
		} catch (err) {
			return invalid(`not JSON (${(err as Error).message})`);
		}
	}
	if (!isRecord(value)) return invalid("not a JSON object");
	if (value.version !== MATERIAL_DIGEST_VERSION) {
		return { ok: false, problem: { kind: "version", version: value.version, reason: `digest version ${JSON.stringify(value.version) ?? "missing"}, this indexer writes ${MATERIAL_DIGEST_VERSION}` } };
	}
	for (const key of ["sourceHash", "converter", "converterVersion"] as const) if (typeof value[key] !== "string") return invalid(`"${key}" is not a string`);
	if (!Number.isSafeInteger(value.indexerVersion)) return invalid(`"indexerVersion" is not an integer`);
	if (value.name !== null && !(typeof value.name === "string" && value.name.length <= NAME_MAX_CHARS)) return invalid(`"name" is not null or a bounded string`);
	if (!isPage(value.pageCount)) return invalid(`"pageCount" is not a page number`);
	if (value.sourcePageCount !== null && !isPage(value.sourcePageCount)) return invalid(`"sourcePageCount" is not null or a page number`);
	if (value.profile === null) {
		if (typeof value.profileError !== "string") return invalid(`"profile" is null without a "profileError"`);
	} else if (typeof value.profile !== "string" || value.profileError !== undefined) return invalid(`"profile" is not a string or null`);

	if (!Array.isArray(value.batches) || value.batches.length === 0) return invalid(`"batches" is not a non-empty array`);
	const indexedPages = new Map<number, Set<number>>();
	let end = 0;
	for (const [i, b] of value.batches.entries()) {
		const where = `batches[${i}]`;
		if (!isRecord(b)) return invalid(`${where} is not an object`);
		if (b.index !== i) return invalid(`${where} has index ${JSON.stringify(b.index)}`);
		if (!Number.isSafeInteger(b.charStart) || !Number.isSafeInteger(b.charEnd)) return invalid(`${where} has offsets that are not integers`);
		if (b.charStart !== end || (b.charEnd as number) <= (b.charStart as number)) return invalid(`${where} does not continue the tiling at ${end}`);
		end = b.charEnd as number;
		if (!Array.isArray(b.pages) || b.pages.length === 0 || !b.pages.every(isPage)) return invalid(`${where} has no valid page set`);
		const pages = b.pages as number[];
		if (pages.some((p, k) => k > 0 && p <= pages[k - 1]!)) return invalid(`${where} has pages that are not ascending and unique`);
		if (!isPage(b.pageStart) || !isPage(b.pageEnd) || !pages.includes(b.pageStart) || !pages.includes(b.pageEnd)) return invalid(`${where} has a start or end page outside its pages`);
		if (!isStringArray(b.headingPath)) return invalid(`${where} has no heading path`);
		if (b.status === "indexed") {
			if (!isStringArray(b.summaryBullets)) return invalid(`${where} has no summary bullets`);
			if (b.error !== undefined) return invalid(`${where} is indexed but has an error`);
			indexedPages.set(i, new Set(pages));
		} else if (b.status === "failed") {
			if (typeof b.error !== "string") return invalid(`${where} is failed without an error`);
		} else return invalid(`${where} has status ${JSON.stringify(b.status)}`);
	}
	const onPart = (part: unknown, page: unknown) => Number.isSafeInteger(part) && indexedPages.get(part as number)?.has(page as number) === true;

	if (!Array.isArray(value.terms)) return invalid(`"terms" is not an array`);
	const termIds = new Set<string>();
	for (const [i, t] of value.terms.entries()) {
		const where = `terms[${i}]`;
		if (!isRecord(t) || !isNormalizedName(t.term) || t.id !== termId(t.term)) return invalid(`${where} has no name or not the id of its name`);
		if (termIds.has(t.id)) return invalid(`${where} repeats the id ${t.id}`);
		termIds.add(t.id);
		if (!isStringArray(t.aliases) || !isStringArray(t.symbols)) return invalid(`${where} has no alias or symbol lists`);
		if (!Array.isArray(t.occurrences) || t.occurrences.length === 0 || t.occurrences.length > MAX_TERM_OCCURRENCES) return invalid(`${where} has no bounded occurrence list`);
		let lastPart = -1;
		for (const [k, o] of t.occurrences.entries()) {
			if (!isRecord(o) || !isTier(o.tier) || !onPart(o.part, o.page)) return invalid(`${where}.occurrences[${k}] is not on a page of an indexed part`);
			if ((o.part as number) < lastPart) return invalid(`${where}.occurrences are not in source order`);
			lastPart = o.part as number;
			if (o.definition === null ? o.definitionPage !== null : typeof o.definition !== "string" || !onPart(o.part, o.definitionPage)) return invalid(`${where}.occurrences[${k}] has an inconsistent definition`);
		}
		if (!Number.isSafeInteger(t.occurrenceCount) || (t.occurrenceCount as number) < t.occurrences.length) return invalid(`${where} has an occurrence count below its list`);
		if ((t.occurrenceCount as number) > t.occurrences.length && t.occurrences.length < MAX_TERM_OCCURRENCES - 2) return invalid(`${where} is truncated below the bound`);
		const derived = summarizeOccurrences(t.occurrences as TermOccurrence[]);
		for (const key of ["page", "tier", "definition", "definitionPage", "definitionTier"] as const) {
			if (t[key] !== derived[key]) return invalid(`${where}.${key} is not what its occurrences give`);
		}
	}
	if (!Array.isArray(value.concepts)) return invalid(`"concepts" is not an array`);
	const conceptIds = new Set<string>();
	for (const [i, c] of value.concepts.entries()) {
		if (!isRecord(c) || !isNormalizedName(c.name) || c.id !== conceptId(c.name) || conceptIds.has(c.id)) return invalid(`concepts[${i}] has no name, not the id of its name, or a repeated id`);
		conceptIds.add(c.id);
		if (typeof c.statement !== "string" || !onPart(c.part, c.page)) return invalid(`concepts[${i}] is not on a page of an indexed part`);
	}
	if (!Array.isArray(value.figures)) return invalid(`"figures" is not an array`);
	for (const [i, f] of value.figures.entries()) {
		if (!isRecord(f) || typeof f.caption !== "string" || !onPart(f.part, f.page)) return invalid(`figures[${i}] is not on a page of an indexed part`);
	}
	// Drop anything the contract does not define (an old "failedBatches" field is derived, never trusted).
	const { failedBatches: _f, ...digest } = value as Record<string, unknown>;
	return { ok: true, digest: digest as unknown as MaterialDigest };
}
