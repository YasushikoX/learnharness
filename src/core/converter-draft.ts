import {
	CREDENTIAL_HEADER_NAMES,
	HTTP_CONVERTER_PROFILE_FORMAT,
	HTTP_CONVERTER_PROFILE_MAX_BYTES,
	HTTP_CONVERTER_PROFILE_MAX_DEPTH,
	HTTP_CONVERTER_PROFILE_MAX_NODES,
	HTTP_CONVERTER_PROFILE_SCHEMA,
	POLL_DEFAULT_INTERVAL_MS,
	POLL_MAX_COUNT,
	POLL_MAX_INTERVAL_MS,
	POLL_MIN_INTERVAL_MS,
	RESERVED_HEADER_NAMES,
	profileShapeProblem,
	profileUrl,
	validateHttpConverterProfile,
	type HttpConverterProfile,
} from "./http-converter-spec.ts";
import type { ConverterValidationReport, CredentialStatus } from "./converter-settings.ts";
import { KEY_MASK, NO_BASE_URL, type ProfileLine, type ProfilePreflight } from "./converter-draft-view.ts";
export * from "./converter-draft-view.ts";

/**
 * "Draft with AI" (fork addition, 2026-11-25): the pure part of the connector wizard. A model reads a PDF service's
 * documentation and drafts a declarative converter profile (http-converter-spec.ts: data the app interprets, never
 * code). The documentation is UNTRUSTED (a web page can address the model), so everything the model writes is
 * treated as untrusted input:
 *
 *   - its reply is one JSON envelope (`parseAuthorReply`): a profile or "cannot be expressed", plus a short note.
 *     Text around the JSON is dropped and never shown; any other envelope field is refused.
 *   - the profile goes through the ONE validator (validateHttpConverterProfile, as an untrusted, non-bundled profile:
 *     no `defaultBaseUrl`, no credential headers, paths relative to the base URL only), after the app has set the
 *     fields it owns itself (`withAppFields`: id, name, version, description, docsUrl; never `unverified`).
 *   - what the profile would send is shown to the user in plain words before anything is sent (`describeProfile`),
 *     with the user's own origin joined to every path, the key masked, and every fixed value; a fixed value that
 *     names an address (a webhook, a callback, an e-mail) is flagged (`addressWarnings`) and must be acknowledged.
 *   - the format documentation the model reads (`profileFormatGuide`) is generated from the validator's schema and
 *     constants, so it cannot drift from what the validator accepts (a test checks every schema field is described).
 *   - after a failed Test, what the model is told about it (`reportForModel`) has the key and the user's address
 *     removed and every string of the service's answer truncated.
 *
 * Pure and browser-safe (the wizard renders `describeProfile` itself from the server's view).
 */

export const CONVERTER_DRAFT_PREFIX = "draft:";
/** A draft's id (its file name without `.json`). */
export const CONVERTER_DRAFT_ID_PATTERN = /^d[0-9a-f]{12}$/;
/** The service name the user types. */
export const DRAFT_SERVICE_NAME_MAX = 80;
/** The documentation text the model sees (a fetched page reduced to text, or a paste). Longer text is cut. */
export const DRAFT_DOCS_MAX_CHARS = 60_000;
/** The optional sample request or response. */
export const DRAFT_SAMPLE_MAX_CHARS = 8_000;
/** The model's note to the user, and its "cannot be expressed" reason. */
export const DRAFT_NOTE_MAX_CHARS = 600;
/** The largest model reply read. */
export const AUTHOR_REPLY_MAX_CHARS = 128 * 1024;
/** Strings of the service's answer, as the fix call sees them. */
export const FIX_STRING_MAX_CHARS = 24;

export function draftConverterId(draftId: string): string {
	return `${CONVERTER_DRAFT_PREFIX}${draftId}`;
}

export function draftIdOf(converterId: string): string | undefined {
	if (!converterId.startsWith(CONVERTER_DRAFT_PREFIX)) return undefined;
	const id = converterId.slice(CONVERTER_DRAFT_PREFIX.length);
	return CONVERTER_DRAFT_ID_PATTERN.test(id) ? id : undefined;
}

// ── Text hygiene ───────────────────────────────────────────────────────────

/** Invisible and direction-changing characters: a page can hide text from the user, but not from a model. */
const INVISIBLE = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/** Text with invisible and control characters removed (line breaks and tabs kept), line endings normalised. */
export function cleanText(text: string): string {
	return text.replace(/\r\n?/g, "\n").replace(INVISIBLE, "").replace(CONTROL, "");
}

/** One plain line of at most `max` characters (a name, a note, a reason). */
export function plainLine(text: string, max: number): string {
	const line = cleanText(text).replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** `text` cut to at most `max` characters at a line break when there is one near the end; `cut` when it was. */
export function boundText(text: string, max: number): { text: string; cut: boolean; totalChars: number } {
	if (text.length <= max) return { text, cut: false, totalChars: text.length };
	const head = text.slice(0, max);
	const at = head.lastIndexOf("\n");
	return { text: (at > max * 0.8 ? head.slice(0, at) : head).trimEnd(), cut: true, totalChars: text.length };
}

/** The tags the author's prompt quotes untrusted text in. */
export const QUOTE_TAGS = ["documentation", "sample", "previous_draft", "test_report", "previous_reply"] as const;

/** Untrusted text made safe to quote inside one of QUOTE_TAGS: it cannot open or close any of them. */
export function quoteSafe(text: string): string {
	return cleanText(text).replace(new RegExp(`<(\\/?)\\s*(${QUOTE_TAGS.join("|")})\\b`, "gi"), "‹$1$2");
}

// ── The format guide (generated from the validator's schema) ─────────────────

/**
 * What each field of the profile schema means, by its path in the schema. A union of objects names each variant by
 * its `type` constant (or, without one, its first required field): `submit.body.multipart.fileField`. A test checks
 * that these keys are exactly the schema's fields, so a field added to the format without a description fails it.
 */
export const PROFILE_FIELD_NOTES: Readonly<Record<string, string>> = {
	format: "always this constant",
	id: "set by the app (you may omit it)",
	name: "set by the app from the name the user typed (you may omit it)",
	version: "set by the app (you may omit it)",
	description: "set by the app (you may omit it)",
	docsUrl: "set by the app (you may omit it)",
	defaultBaseUrl: "FORBIDDEN in your profile: the user types the service's address in the app",
	unverified: "set by the app (omit it)",
	auth: "the ONE header that carries the API key; omit when the service takes no key",
	"auth.header": "the header's name, e.g. Authorization or X-Api-Key",
	"auth.value": 'the header\'s value, containing {{API_KEY}} exactly once, e.g. "Bearer {{API_KEY}}" or "{{API_KEY}}"',
	limits: "the service's documented limits, only when the documentation states them",
	"limits.maxBytes": "the largest PDF in bytes",
	"limits.maxPages": "the most pages per PDF",
	submit: "the one upload request (never sent twice)",
	"submit.method": "the HTTP method",
	"submit.path": 'the path relative to the base URL the user types, starting with "/", e.g. "/v1/convert" (may have a fixed query string)',
	"submit.headers": "fixed headers sent with every request of the job (never a key, never an address)",
	"submit.body": "how the PDF is sent",
	"submit.body.multipart.type": "a multipart/form-data upload",
	"submit.body.multipart.fileField": "the form field that carries the PDF file",
	"submit.body.multipart.fields": "fixed form fields (a list sends the field once per value)",
	"submit.body.json-base64.type": "a JSON body with the PDF inside it as base64",
	"submit.body.json-base64.filePointer": 'the JSON Pointer where the PDF goes, e.g. "/document/data"',
	"submit.body.json-base64.encoding": '"base64": bare base64; "data-url": data:application/pdf;base64,…',
	"submit.body.json-base64.json": "the fixed rest of the JSON body (must not already hold a value at filePointer)",
	poll: "only for services that answer the upload with a job id and finish later",
	"poll.jobIdPointer": "the JSON Pointer of the job id in the upload's answer",
	"poll.method": "the status request's method (default GET)",
	"poll.path": "the status request's path, containing {{JOB_ID}}",
	"poll.statusPointer": "the JSON Pointer of the job's state in a status answer",
	"poll.done": "the state values that mean finished",
	"poll.running": "the state values that mean still working",
	"poll.failed": "the state values that mean failed",
	"poll.errorPointer": "the JSON Pointer of the service's failure message in a status answer",
	"poll.intervalMs": "milliseconds between status requests",
	"poll.maxPolls": "the most status requests",
	result: "only when the finished text is fetched with a separate request after polling",
	"result.method": "the result request's method (default GET)",
	"result.path": "the result request's path; may contain {{JOB_ID}}",
	extract: "where the text is in the final answer (the upload's, the last status answer, or the result request's)",
	"extract.pages.type": "the answer holds a list with one entry per PDF page",
	"extract.pages.pagesPointer": 'the JSON Pointer of the page list ("" when the answer itself is the list)',
	"extract.pages.numberPointer": "inside one entry: the JSON Pointer of its page number or index",
	"extract.pages.numberBase": "0 when the service counts pages from 0, 1 when from 1",
	"extract.pages.markdownPointer": "inside one entry: the JSON Pointer of its text",
	"extract.delimited.type": "the answer holds one text with a page separator the service writes for EVERY page",
	"extract.delimited.markdownPointer": "the JSON Pointer of that text",
	"extract.delimited.delimiter": "the separator",
	"extract.delimited.delimiter.literal.literal": "a fixed separator the service always writes, e.g. \"\\f\"",
	"extract.delimited.delimiter.random.random": "the app makes a unique separator per job and sends it as {{DELIMITER}} in a body field the documentation names for that",
	"extract.delimited.placement": '"between" pages (default), "after" every page, or "before" every page',
};

type SchemaNode = {
	type?: string;
	const?: unknown;
	anyOf?: SchemaNode[];
	properties?: Record<string, SchemaNode>;
	required?: string[];
	patternProperties?: Record<string, SchemaNode>;
	items?: SchemaNode;
	pattern?: string;
	minLength?: number;
	maxLength?: number;
	minimum?: number;
	maximum?: number;
	minItems?: number;
	maxItems?: number;
};

function variantName(node: SchemaNode): string {
	const typeConst = node.properties?.type?.const;
	return typeof typeConst === "string" ? typeConst : (node.required?.[0] ?? "variant");
}

function typeText(node: SchemaNode): string {
	if (node.const !== undefined) return JSON.stringify(node.const);
	if (node.anyOf) {
		if (node.anyOf.every((n) => n.const !== undefined)) return node.anyOf.map((n) => JSON.stringify(n.const)).join(" | ");
		if (node.anyOf.every((n) => n.type !== "object")) return node.anyOf.map(typeText).join(" | ");
		return "one of the forms below";
	}
	const limits: string[] = [];
	if (node.pattern) limits.push(`matching ${node.pattern}`);
	if (node.minLength !== undefined && node.minLength > 0) limits.push(`at least ${node.minLength} character${node.minLength === 1 ? "" : "s"}`);
	if (node.maxLength !== undefined) limits.push(`at most ${node.maxLength} characters`);
	if (node.minimum !== undefined) limits.push(`≥ ${node.minimum}`);
	if (node.maximum !== undefined) limits.push(`≤ ${node.maximum}`);
	if (node.minItems !== undefined && node.minItems > 0) limits.push(`at least ${node.minItems} item${node.minItems === 1 ? "" : "s"}`);
	if (node.maxItems !== undefined) limits.push(`at most ${node.maxItems} items`);
	let base = node.type ?? "any JSON value";
	if (node.type === "array" && node.items) base = `list of ${node.items.anyOf ? `(${typeText(node.items)})` : typeText(node.items)}`;
	if (node.type === "object" && node.patternProperties) {
		const value = Object.values(node.patternProperties)[0];
		base = value && Object.keys(value).length > 0 ? `object of name → ${typeText(value)}` : "object of any JSON values";
	}
	return limits.length ? `${base} (${limits.join(", ")})` : base;
}

/** Every field path of the schema, as PROFILE_FIELD_NOTES keys them (exported for the drift test). */
export function profileSchemaPaths(): string[] {
	const out: string[] = [];
	const walk = (node: SchemaNode, at: string) => {
		if (node.anyOf && node.anyOf.some((n) => n.type === "object" && n.properties)) {
			for (const variant of node.anyOf) walk(variant, `${at}.${variantName(variant)}`);
			return;
		}
		for (const [key, child] of Object.entries(node.properties ?? {})) {
			const path = at ? `${at}.${key}` : key;
			out.push(path);
			walk(child, path);
		}
	};
	walk(HTTP_CONVERTER_PROFILE_SCHEMA as unknown as SchemaNode, "");
	return out;
}

function fieldLines(node: SchemaNode, at: string, indent: string): string[] {
	const lines: string[] = [];
	const required = new Set(node.required ?? []);
	for (const [key, child] of Object.entries(node.properties ?? {})) {
		const path = at ? `${at}.${key}` : key;
		const note = PROFILE_FIELD_NOTES[path];
		lines.push(`${indent}- ${key}${required.has(key) ? " (required)" : ""}: ${typeText(child)}${note ? `. ${note}` : ""}`);
		if (child.anyOf && child.anyOf.some((n) => n.type === "object" && n.properties)) {
			for (const variant of child.anyOf) {
				const name = variantName(variant);
				lines.push(`${indent}  form "${name}":`);
				lines.push(...fieldLines(variant, `${path}.${name}`, `${indent}    `));
			}
		} else if (child.type === "object" && child.properties) {
			lines.push(...fieldLines(child, path, `${indent}  `));
		}
	}
	return lines;
}

/** A small valid example (a test checks it passes the validator). */
export const PROFILE_EXAMPLE: HttpConverterProfile = {
	format: HTTP_CONVERTER_PROFILE_FORMAT,
	id: "example-ocr",
	name: "Example OCR",
	version: "1",
	auth: { header: "X-Api-Key", value: "{{API_KEY}}" },
	submit: { method: "POST", path: "/v1/ocr", body: { type: "multipart", fileField: "file", fields: { output_format: "markdown" } } },
	extract: { type: "pages", pagesPointer: "/pages", numberPointer: "/page_number", numberBase: 1, markdownPointer: "/markdown" },
};

/** The profile format, for the model: generated from the validator's schema and constants. */
export function profileFormatGuide(): string {
	const fields = fieldLines(HTTP_CONVERTER_PROFILE_SCHEMA as unknown as SchemaNode, "", "");
	return [
		`A profile is one JSON object with these fields (unknown fields anywhere are refused):`,
		...fields,
		"",
		"Rules the validator enforces:",
		`- Data is located only by JSON Pointer (RFC 6901): "" is the whole value, "/a/0/b" a path; write ~1 for / and ~0 for ~ inside a name.`,
		"- The only placeholders: {{API_KEY}} (only in auth.value), {{JOB_ID}} (only in poll.path and result.path; poll.path must contain it), {{DELIMITER}} (only in submit body fields or JSON values, and only with a random delimiter, which must be sent that way). Any other {{ is refused.",
		"- Every path starts with /, is relative to the base URL the user types, and stays under it: no scheme or host, no //, no \\, no . or .. segments, no encoded / or \\, no fragment.",
		`- Header names set by the app or meaningful to it are refused: ${RESERVED_HEADER_NAMES.join(", ")}.`,
		`- Credential headers (${CREDENTIAL_HEADER_NAMES.join(", ")}) are never fixed headers in submit.headers; the key goes only through auth, and the auth header is not repeated in submit.headers. Cookie and Proxy-Authorization cannot carry the key either.`,
		"- Header values contain no line breaks or control characters and only Latin-1 characters.",
		"- done, running and failed status values do not overlap; a result request needs a poll section.",
		`- poll.intervalMs is ${POLL_MIN_INTERVAL_MS}–${POLL_MAX_INTERVAL_MS} (default ${POLL_DEFAULT_INTERVAL_MS}); poll.maxPolls at most ${POLL_MAX_COUNT}.`,
		`- At most ${HTTP_CONVERTER_PROFILE_MAX_BYTES / 1024} KB as compact JSON, nested at most ${HTTP_CONVERTER_PROFILE_MAX_DEPTH} levels, at most ${HTTP_CONVERTER_PROFILE_MAX_NODES} values.`,
		"",
		"How the app checks pages: a page list must have exactly one entry per PDF page, with page numbers from numberPointer; a delimited text must have exactly one segment per page for \"between\", or one more (the empty last one for \"after\", the empty first one for \"before\"). Anything else fails the conversion.",
		"",
		"Example:",
		JSON.stringify(PROFILE_EXAMPLE),
	].join("\n");
}

// ── The model's reply ─────────────────────────────────────────────────────

export type AuthorReply =
	| { ok: true; kind: "profile"; profile: unknown; note: string; droppedText: boolean }
	| { ok: true; kind: "cannot_express"; reason: string; note: string; droppedText: boolean }
	| { ok: false; errors: string[] };

const ENVELOPE_KEYS = { profile: ["result", "profile", "note"], cannot_express: ["result", "reason", "note"] } as const;

/**
 * The model's reply read as the one JSON envelope it must be. The JSON is the first fenced block, or else the text
 * from the first `{` to the last `}`; anything around it is dropped (`droppedText`), never shown and never acted on.
 * An envelope with any other field is refused (an address, a URL to fetch, a second request: none is a field).
 */
export function parseAuthorReply(reply: string): AuthorReply {
	if (reply.length > AUTHOR_REPLY_MAX_CHARS) return { ok: false, errors: [`The reply is longer than ${AUTHOR_REPLY_MAX_CHARS} characters`] };
	const text = reply.trim();
	const fence = /```(?:json)?[ \t]*\n([\s\S]*?)\n?```/i.exec(text);
	let json: string;
	if (fence) json = fence[1]!;
	else {
		const start = text.indexOf("{");
		const end = text.lastIndexOf("}");
		if (start < 0 || end < start) return { ok: false, errors: ["The reply is not a JSON object"] };
		json = text.slice(start, end + 1);
	}
	const droppedText = text.replace(fence ? fence[0] : json, "").trim().length > 0;
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch (error) {
		return { ok: false, errors: [`The reply is not valid JSON: ${(error as Error).message}`] };
	}
	const shape = profileShapeProblem(value);
	if (shape) return { ok: false, errors: [shape] };
	if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, errors: ["The reply must be one JSON object"] };
	const envelope = value as Record<string, unknown>;
	const result = envelope.result;
	if (result !== "profile" && result !== "cannot_express") return { ok: false, errors: ['/result: must be "profile" or "cannot_express"'] };
	const allowed: readonly string[] = ENVELOPE_KEYS[result];
	const extra = Object.keys(envelope).filter((k) => !allowed.includes(k));
	if (extra.length) return { ok: false, errors: [`The reply has fields that are not allowed: ${extra.join(", ")} (only ${allowed.join(", ")})`] };
	if (envelope.note !== undefined && typeof envelope.note !== "string") return { ok: false, errors: ["/note: must be a string"] };
	const note = plainLine((envelope.note as string | undefined) ?? "", DRAFT_NOTE_MAX_CHARS);
	if (result === "cannot_express") {
		if (typeof envelope.reason !== "string" || !envelope.reason.trim()) return { ok: false, errors: ["/reason: say why the service cannot be described"] };
		return { ok: true, kind: "cannot_express", reason: plainLine(envelope.reason, DRAFT_NOTE_MAX_CHARS), note, droppedText };
	}
	if (envelope.profile === null || typeof envelope.profile !== "object" || Array.isArray(envelope.profile)) return { ok: false, errors: ["/profile: must be a JSON object"] };
	return { ok: true, kind: "profile", profile: envelope.profile, note, droppedText };
}

export interface AppOwnedFields {
	id: string;
	name: string;
	/** The documentation URL the user typed (shown in Settings, never fetched by the interpreter). */
	docsUrl?: string;
	/** Where the draft came from, written by the app. */
	description: string;
}

/**
 * The profile with the fields the app owns set by the app: the model (or a hand edit) never chooses its id (which
 * could replace another profile), its name or description (which Settings shows), its docs link, or the
 * `unverified` flag. `defaultBaseUrl` is NOT removed: the validator refuses it, so the model is told.
 */
export function withAppFields(profile: unknown, own: AppOwnedFields): unknown {
	if (profile === null || typeof profile !== "object" || Array.isArray(profile)) return profile;
	const owned = new Set(["format", "id", "name", "version", "description", "docsUrl", "unverified"]);
	const rest = Object.entries(profile as Record<string, unknown>).filter(([k]) => !owned.has(k));
	return {
		format: HTTP_CONVERTER_PROFILE_FORMAT,
		id: own.id,
		name: own.name,
		version: "1",
		description: own.description,
		...(own.docsUrl ? { docsUrl: own.docsUrl } : {}),
		...Object.fromEntries(rest),
	};
}

/** A draft profile checked exactly as an import is (never as a bundled preset). */
export function validateDraftProfile(profile: unknown): { ok: true; profile: HttpConverterProfile } | { ok: false; errors: string[] } {
	return validateHttpConverterProfile(profile, { bundled: false });
}

// ── What the profile would send, in plain words ──────────────────────────────

function urlFor(baseUrl: string | undefined, path: string): string {
	const shown = path.replace(/\{\{JOB_ID\}\}/g, "<job id>");
	if (!baseUrl) return `${NO_BASE_URL}${shown}`;
	profileUrl(baseUrl, path, "job"); // throws when the path would leave the base URL (the validator already refused it)
	return `${baseUrl.replace(/\/+$/, "")}${shown}`;
}

const ADDRESS_VALUE = /(?:[a-z][a-z0-9+.-]*:\/\/)|(?:^|[\s"'(<])(?:www\.)|[^\s@"']+@[^\s@"']+\.[a-z]{2,}|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|ai|co|xyz|me|info|biz|cloud|site|online|tech|link|sh|run|page|so)\b/i;
const ADDRESS_NAME = /callback|webhook|hook|notify|notification|redirect|return_?url|url$|uri$|endpoint|email|e-mail|mail_?to|forward|upload_?to|destination|target_?url|bucket|s3/i;

/** Every fixed value of a profile, by where it is, as plain lines (headers, form fields, JSON values). */
function fixedValues(profile: HttpConverterProfile): { headers: ProfileLine[]; fields: ProfileLine[] } {
	const headers = Object.entries(profile.submit.headers ?? {}).map(([label, value]) => ({ label, value }));
	const fields: ProfileLine[] = [];
	const body = profile.submit.body;
	if (body.type === "multipart") {
		for (const [name, value] of Object.entries(body.fields ?? {})) fields.push({ label: name, value: Array.isArray(value) ? value.join(", ") : value });
	} else {
		const walk = (node: unknown, at: string) => {
			if (node !== null && typeof node === "object") {
				const entries = Array.isArray(node) ? node.map((v, i) => [String(i), v] as const) : Object.entries(node);
				if (entries.length === 0) fields.push({ label: at || "/", value: Array.isArray(node) ? "[]" : "{}" });
				for (const [key, value] of entries) walk(value, `${at}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`);
			} else fields.push({ label: at, value: JSON.stringify(node) });
		};
		walk(body.json ?? {}, "");
	}
	return { headers, fields };
}

/** Fixed values that name an address (pure; exported for tests). */
export function addressWarnings(profile: HttpConverterProfile): string[] {
	const { headers, fields } = fixedValues(profile);
	const out: string[] = [];
	const check = (kind: string, line: ProfileLine) => {
		const value = line.value.replace(/\{\{DELIMITER\}\}/g, "");
		if (ADDRESS_VALUE.test(value) || (ADDRESS_NAME.test(line.label) && value.replace(/^"|"$/g, "").trim() !== "")) {
			out.push(`The ${kind} ${line.label} is ${line.value}: it looks like an address. A service told to send results or notifications there would send your documents' text to it. Remove it unless you know what it is.`);
		}
	};
	headers.forEach((h) => check("fixed header", h));
	fields.forEach((f) => check("fixed field", f));
	if (profile.auth && ADDRESS_VALUE.test(profile.auth.value.replace("{{API_KEY}}", ""))) out.push(`The key header's value ${profile.auth.value} contains an address.`);
	return out;
}

function pagesSentence(profile: HttpConverterProfile): string {
	const extract = profile.extract;
	if (extract.type === "pages") {
		return `The answer's list at ${extract.pagesPointer || "its top level"} must have one entry per PDF page; each entry's page number is at ${extract.numberPointer} (counted from ${extract.numberBase}) and its text at ${extract.markdownPointer}.`;
	}
	const sep = "random" in extract.delimiter ? "a separator the app makes for each job and sends to the service" : `the fixed separator ${JSON.stringify(extract.delimiter.literal)}`;
	const placement = extract.placement ?? "between";
	return `The answer's text at ${extract.markdownPointer || "its top level"} is split into pages at ${sep}, written ${placement === "between" ? "between pages" : `${placement} every page`}.`;
}

/**
 * What a valid profile would send and read, for the pre-flight screen: the user's base URL (or a placeholder when
 * none is saved yet) joined with each path, the key masked, and every fixed header and field. Pure.
 */
export function describeProfile(profile: HttpConverterProfile, baseUrl: string | undefined, credential?: CredentialStatus): ProfilePreflight {
	const body = profile.submit.body;
	const { headers, fields } = fixedValues(profile);
	const masked = credential?.stored && credential.hint ? `${KEY_MASK}${credential.hint.replace(/^…/, "")}` : KEY_MASK;
	const poll = profile.poll;
	const statuses = poll ? `done: ${poll.done.map((v) => JSON.stringify(v)).join(", ")}; still working: ${poll.running.map((v) => JSON.stringify(v)).join(", ")}${poll.failed?.length ? `; failed: ${poll.failed.map((v) => JSON.stringify(v)).join(", ")}` : ""}` : "";
	const origin = baseUrl ? new URL(baseUrl).origin : NO_BASE_URL;
	return {
		submit: `${profile.submit.method} ${urlFor(baseUrl, profile.submit.path)}`,
		body: body.type === "multipart"
			? `The PDF is uploaded as the form field "${body.fileField}" (multipart/form-data), with the fixed fields below.`
			: `The PDF is sent inside a JSON body at ${body.filePointer}, as ${body.encoding === "data-url" ? "a base64 data URL" : "base64 text"}, with the fixed values below.`,
		...(profile.auth ? { auth: { header: profile.auth.header, value: profile.auth.value.replace("{{API_KEY}}", masked) } } : {}),
		headers,
		fields,
		...(poll ? { poll: `The upload's answer holds a job id at ${poll.jobIdPointer}. Then ${poll.method ?? "GET"} ${urlFor(baseUrl, poll.path)} every ${((poll.intervalMs ?? POLL_DEFAULT_INTERVAL_MS) / 1000).toString()} s${poll.maxPolls ? `, at most ${poll.maxPolls} times` : ""}, reading the state at ${poll.statusPointer} (${statuses}).` } : {}),
		...(profile.result ? { result: `${profile.result.method ?? "GET"} ${urlFor(baseUrl, profile.result.path)} fetches the finished answer.` } : {}),
		pages: pagesSentence(profile),
		warnings: addressWarnings(profile),
		origins: [origin],
	};
}

// ── What the fix call is told about a failed Test ─────────────────────────────

/** The most values one reduced answer holds (the fix call needs the shape, not the content). */
export const FIX_SHAPE_MAX_NODES = 200;
const CUT_STRING = new RegExp(`^[\\s\\S]{0,${FIX_STRING_MAX_CHARS}}…\\(\\d+ chars\\)$`);

/**
 * A JSON value reduced to its shape (pure): every string cut to FIX_STRING_MAX_CHARS after `redact`, lists cut to 3
 * entries plus a count, objects to 30 fields, depth to 8, and FIX_SHAPE_MAX_NODES values in all.
 */
export function replyShape(value: unknown, redact: (text: string) => string = (t) => t): unknown {
	let budget = FIX_SHAPE_MAX_NODES;
	const walk = (node: unknown, depth: number): unknown => {
		if (--budget < 0) return "…";
		if (typeof node === "string") {
			const clean = redact(node);
			if (clean.length <= FIX_STRING_MAX_CHARS || CUT_STRING.test(clean)) return clean; // already cut: reducing twice keeps the first count
			return `${clean.slice(0, FIX_STRING_MAX_CHARS)}…(${clean.length} chars)`;
		}
		if (node === null || typeof node !== "object") return node;
		if (depth >= 8) return Array.isArray(node) ? "[…]" : "{…}";
		if (Array.isArray(node)) {
			const head = node.slice(0, 3).map((v) => walk(v, depth + 1));
			return node.length > 3 ? [...head, `…(${node.length} entries in all)`] : head;
		}
		const out: Record<string, unknown> = {};
		let fields = 0;
		for (const key in node) {
			if (!Object.hasOwn(node, key)) continue;
			if (++fields > 30) {
				out["…"] = "more fields";
				break;
			}
			Object.defineProperty(out, redact(key).slice(0, 60), { value: walk((node as Record<string, unknown>)[key], depth + 1), enumerable: true, configurable: true, writable: true });
		}
		return out;
	};
	return walk(value, 0);
}

/** The service's answers seen during a Test, by request, already reduced to their shape. */
export interface TestAnswerShape {
	pdf: "two-page" | "blank-middle";
	stage: "submit" | "poll" | "result";
	shape: unknown;
}

export interface FixReport {
	checks: { id: string; status: string; message: string }[];
	error?: { kind: string; message: string };
	pages: { page: number; chars: number }[];
	warnings: string[];
	answers: TestAnswerShape[];
}

/**
 * What the fix call sees of a failed Test (pure): which checks failed and why, and the shape of the service's
 * answers, with every secret and the user's service address removed and every string truncated. No page text.
 */
export function reportForModel(report: ConverterValidationReport, answers: readonly TestAnswerShape[], redact: (text: string) => string): FixReport {
	const line = (text: string, max: number) => plainLine(redact(text), max);
	return {
		checks: report.checks.map((c) => ({ id: c.id, status: c.status, message: line(c.message, 300) })),
		...(report.error ? { error: { kind: report.error.kind, message: line(report.error.message, 400) } } : {}),
		pages: report.pages.map((p) => ({ page: p.page, chars: p.text.length })),
		warnings: report.warnings.slice(0, 5).map((w) => line(w, 200)),
		answers: answers.slice(0, 6).map((a) => ({ ...a, shape: replyShape(a.shape, redact) })),
	};
}

