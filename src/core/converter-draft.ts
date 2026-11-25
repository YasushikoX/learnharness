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
import { KEY_MASK, NO_BASE_URL, type FixedValue, type ProfilePreflight } from "./converter-draft-view.ts";
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
 *     with the user's own origin joined to every path and the key masked; EVERY fixed value it sends exactly as
 *     written (headers, fields, every query parameter of every path, the paths) is listed (`fixedValues`), and when
 *     there is one beyond a bare path Approve needs "I have read these values", tied to the version on screen. A
 *     heuristic (`addressReason`, `nameReason`) only decides which are shown first, in red, with a reason.
 *   - a draft may not carry a key, a token or an account of its own (`draftCredentialProblems`): the page's
 *     credentials are never the user's.
 *   - the format documentation the model reads (`profileFormatGuide`) is generated from the validator's schema and
 *     constants, so it cannot drift from what the validator accepts (a test checks every schema field is described).
 *   - after a failed Test, what the model is told about it (`reportForModel`) has the key and the user's address
 *     removed, and of the service's answers only their shape: a string is its length unless it is a short status
 *     token, a field name is a marker unless it is a plain identifier (`replyShape`).
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
	return cleanText(text).replace(new RegExp(`<\\s*(\\/?)\\s*(${QUOTE_TAGS.join("|")})\\b`, "gi"), "‹$1$2");
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

/** A second valid example, for the JSON body form and a job id (a test checks it passes the validator). */
export const PROFILE_EXAMPLE_JSON: HttpConverterProfile = {
	format: HTTP_CONVERTER_PROFILE_FORMAT,
	id: "example-json-ocr",
	name: "Example JSON OCR",
	version: "1",
	auth: { header: "Authorization", value: "Bearer {{API_KEY}}" },
	submit: { method: "POST", path: "/v2/jobs", body: { type: "json-base64", filePointer: "/document/content", encoding: "base64", json: { document: { mime_type: "application/pdf" }, output: "markdown" } } },
	poll: { jobIdPointer: "/id", path: "/v2/jobs/{{JOB_ID}}", statusPointer: "/status", done: ["succeeded"], running: ["queued", "running"], failed: ["failed"], errorPointer: "/error/message" },
	extract: { type: "pages", pagesPointer: "/result/pages", numberPointer: "/index", numberBase: 0, markdownPointer: "/markdown" },
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
		"Example (a multipart upload, pages in the answer):",
		JSON.stringify(PROFILE_EXAMPLE),
		"",
		`Example (the PDF as base64 inside a JSON body at filePointer, which must not already hold a value in "json"; a job id; pages counted from 0):`,
		JSON.stringify(PROFILE_EXAMPLE_JSON),
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

/**
 * A draft profile checked exactly as an import is (never as a bundled preset), and then for the credentials a draft
 * may not carry (draftCredentialProblems; a hand-written import is not checked for those).
 */
export function validateDraftProfile(profile: unknown): { ok: true; profile: HttpConverterProfile } | { ok: false; errors: string[] } {
	const checked = validateHttpConverterProfile(profile, { bundled: false });
	if (!checked.ok) return checked;
	const credentials = draftCredentialProblems(checked.profile);
	return credentials.length ? { ok: false, errors: credentials } : checked;
}

// ── What the profile would send, in plain words ──────────────────────────────

function urlFor(baseUrl: string | undefined, path: string): string {
	const shown = path.replace(/\{\{JOB_ID\}\}/g, "<job id>");
	if (!baseUrl) return `${NO_BASE_URL}${shown}`;
	profileUrl(baseUrl, path, "job"); // throws when the path would leave the base URL (the validator already refused it)
	return `${baseUrl.replace(/\/+$/, "")}${shown}`;
}

// ── Fixed values: every one is listed; the heuristic only puts some first, in red ──

const DECODE_ROUNDS = 2;

/** `text` percent-decoded (up to twice, for a doubly encoded value), or as it is where it cannot be decoded. */
function percentDecoded(text: string): string {
	let out = text;
	for (let i = 0; i < DECODE_ROUNDS && /%[0-9a-f]{2}/i.test(out); i++) {
		try {
			out = decodeURIComponent(out);
		} catch {
			break;
		}
	}
	return out;
}

const COMMON_TLDS = "com|net|org|io|dev|app|ai|co|xyz|me|info|biz|cloud|site|online|tech|link|sh|run|page|so|top|club|shop|store|live|pro|work|space|website|fun|icu|vip|email|zone|host|services|digital";
/** What makes a value look like an address, each with its reason (the first that matches is shown). */
const ADDRESS_VALUE_RULES: readonly [RegExp, string][] = [
	[/[a-z][a-z0-9+.-]*:\/\//i, "it is a URL"],
	[/(?:^|[\s"'(<=,;])\/\/[^\s/]/, "it is an address without a scheme (//host)"],
	[/\b(?:mailto|javascript|data|file|ftp):/i, "it is a URL"],
	[/[^\s@"'<>]+@[^\s@"'<>]+\.[a-z]{2,}/i, "it is an e-mail address"],
	[/\[[0-9a-f:.]*:[0-9a-f:.]*\]/i, "it is an IPv6 address"],
	[/(?:^|[^\w:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/i, "it is an IPv6 address"],
	[/\b(?:\d{1,3}\.){3}\d{1,3}\b/, "it is an IP address"],
	[/(?:^|[^\w.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5}\b|\/)/i, "it is a host name with a path or port"],
	[new RegExp(`(?:^|[^\\w.-])www\\.`, "i"), "it is a host name"],
	[new RegExp(`(?:^|[^\\w.-])(?:[a-z0-9-]+\\.)+(?:${COMMON_TLDS}|[a-z]{2})(?![\\w.-])`, "i"), "it is a host name"],
];

/** Names (header names, field names, any segment of a JSON Pointer, query parameters) that suggest an address. */
const ADDRESS_NAME = /callback|webhook|hook|notif|redirect|return_?(?:url|to|address)|url|uri|endpoint|e-?mail|mail_?to|forward|upload_?to|destination|^dest(?:ination)?$|target|bucket|^s3|sink|host|domain|server|address|^addr|recipient|channel|href|^link|send_?to|reply_?to|^to$|^cc$|^bcc$|^ip$|proxy|^ping/i;
/** Names that suggest a key, a token or someone's account, workspace or channel. */
const ACCOUNT_NAME = /key|token|secret|auth|passw|credential|tenant|account|organi[sz]ation|^org$|org_?id|workspace|project|^user|owner|customer|client_?id|team|session|signature|recipient|channel/i;

/** Why a value looks like an address (pure; exported for tests), or undefined. Checked as written and decoded. */
export function addressReason(value: string): string | undefined {
	const plain = value.replace(/\{\{(?:DELIMITER|JOB_ID)\}\}/g, "");
	for (const form of new Set([plain, percentDecoded(plain), percentDecoded(plain.replace(/\+/g, " "))])) {
		for (const [rule, reason] of ADDRESS_VALUE_RULES) if (rule.test(form)) return reason;
	}
	return undefined;
}

/** Why a name (or one segment of a pointer) stands out, or undefined (pure; exported for tests). */
export function nameReason(name: string): string | undefined {
	const decoded = percentDecoded(name);
	if (ADDRESS_NAME.test(decoded)) return "its name suggests an address the service would send data to";
	if (ACCOUNT_NAME.test(decoded)) return "its name suggests a key, a token or an account: your documents could go to someone else's account";
	return undefined;
}

/** The segments of a JSON Pointer, unescaped ("/a~1b/0" → ["a/b", "0"]). */
function pointerSegments(pointer: string): string[] {
	return pointer.split("/").slice(1).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** A query string split into its parameters: the name and value decoded (+ as a space), and the raw text of each. */
export function queryParameters(path: string): { name: string; value: string; raw: string }[] {
	const at = path.indexOf("?");
	if (at < 0) return [];
	const decode = (text: string) => {
		try {
			return decodeURIComponent(text.replace(/\+/g, " "));
		} catch {
			return text;
		}
	};
	return path.slice(at + 1).split("&").filter((part) => part !== "").map((raw) => {
		const eq = raw.indexOf("=");
		return eq < 0 ? { name: decode(raw), value: "", raw } : { name: decode(raw.slice(0, eq)), value: decode(raw.slice(eq + 1)), raw };
	});
}

/** The key header's value is only the key, or a one-word scheme and the key ("Bearer {{API_KEY}}"). */
const PLAIN_AUTH_VALUE = /^(?:[A-Za-z]{1,16} )?\{\{API_KEY\}\}$/;

/**
 * Every fixed value a profile would send exactly as written (pure; exported for tests): fixed headers, a key header's
 * fixed text around the key, fixed form fields (each value of a list), every leaf of a fixed JSON body by its
 * pointer, every query parameter of every path (decoded, with the raw text when it differs), and the paths. Red ones
 * (by name or value) first; the order of the profile otherwise.
 */
export function fixedValues(profile: HttpConverterProfile): FixedValue[] {
	const out: FixedValue[] = [];
	const add = (kind: FixedValue["kind"], request: FixedValue["request"], label: string, value: string, names: readonly string[], extra: { raw?: string; acknowledge?: boolean } = {}) => {
		const byValue = addressReason(value) ?? (extra.raw !== undefined ? addressReason(extra.raw) : undefined);
		const byName = names.map(nameReason).find((r) => r !== undefined);
		const reason = byValue ? `its value looks like an address (${byValue}): a service told to send results or notifications there would send your documents' text to it` : byName;
		out.push({ kind, request, label, value, ...(extra.raw !== undefined && extra.raw !== value ? { raw: extra.raw } : {}), ...(reason ? { warning: reason } : {}), acknowledge: extra.acknowledge ?? true });
	};
	for (const [name, value] of Object.entries(profile.submit.headers ?? {})) add("header", "every request", name, value, [name]);
	if (profile.auth && !PLAIN_AUTH_VALUE.test(profile.auth.value)) add("auth", "every request", `${profile.auth.header} (the key header)`, profile.auth.value.replace("{{API_KEY}}", "<your key>"), [], { raw: profile.auth.value });
	const body = profile.submit.body;
	if (body.type === "multipart") {
		for (const [name, value] of Object.entries(body.fields ?? {})) {
			if (Array.isArray(value)) value.forEach((v, i) => add("field", "submit", `${name}[${i}]`, v, [name]));
			else add("field", "submit", name, value, [name]);
		}
	} else {
		const walk = (node: unknown, at: string) => {
			if (node !== null && typeof node === "object") {
				const entries = Array.isArray(node) ? node.map((v, i) => [String(i), v] as const) : Object.entries(node);
				if (entries.length === 0) add("field", "submit", at || "/", Array.isArray(node) ? "[]" : "{}", pointerSegments(at));
				for (const [key, value] of entries) walk(value, `${at}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`);
			} else add("field", "submit", at, JSON.stringify(node) ?? "null", pointerSegments(at));
		};
		walk(body.json ?? {}, "");
	}
	const paths: [FixedValue["request"], string | undefined][] = [["submit", profile.submit.path], ["poll", profile.poll?.path], ["result", profile.result?.path]];
	for (const [request, path] of paths) {
		if (path === undefined) continue;
		for (const q of queryParameters(path)) add("query", request, q.name, q.value, [q.name], { ...(q.raw !== `${q.name}=${q.value}` ? { raw: q.raw } : {}), acknowledge: q.value !== "{{JOB_ID}}" });
	}
	for (const [request, path] of paths) {
		if (path === undefined) continue;
		const bare = path.split("?")[0]!;
		const segments = bare.split("/").filter((s) => s && !/^\{\{\w+\}\}$/.test(s));
		add("path", request, `${request} path`, bare, segments, { acknowledge: false });
	}
	for (const value of out) if (value.warning) value.acknowledge = true;
	return [...out.filter((v) => v.warning), ...out.filter((v) => !v.warning)];
}

/** The red values' reasons, one line each (pure; exported for tests). */
export function addressWarnings(profile: HttpConverterProfile): string[] {
	return fixedValues(profile).filter((v) => v.warning).map((v) => `${v.label} (${KIND_WORDS[v.kind]}) = ${v.value}: ${v.warning}.`);
}

const KIND_WORDS: Record<FixedValue["kind"], string> = { header: "fixed header", field: "fixed field", query: "query parameter", auth: "key header", path: "path" };

// ── Credentials in a drafted profile (refused; a hand-written import keeps its own rules) ──

/** Header names that commonly carry a key, refused as fixed headers of a draft. */
export const DRAFT_CREDENTIAL_HEADER_NAMES = ["x-api-key", "api-key", "apikey", "x-auth-token", "x-access-token", "ocp-apim-subscription-key"] as const;
/** A name containing one of these carries a key or routes to an account: refused in a draft as described below. */
export const DRAFT_CREDENTIAL_NAME = /key|token|secret|auth|passw|tenant|account|organi[sz]ation/i;
/** A value that is only a short enumerated word or number ("bearer", "json", "4096", "true"): allowed under such a name. */
const SHORT_WORD = /^(?:[A-Za-z][A-Za-z_-]{0,15}|\d{1,6})$/;
const SHORT_NUMBER = /^(?:\d{1,6}|true|false)$/;
const KEY_PREFIX = /(?:^|[^A-Za-z0-9])(?:(?:sk|pk|rk)[-_](?:(?:live|test|proj|ant)[-_])?[A-Za-z0-9]{8,}|(?:Bearer|Basic|Token)\s+\S{8,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16})/;

/**
 * Whether a fixed value looks like a key, whatever its name: a known key prefix (sk-…, Bearer …, ghp_…, AIza…, AKIA…),
 * or an unbroken run of 24 or more letters, digits, _, +, / or = holding at least two digits and two letters (hex and
 * base64 keys; a hyphenated model name such as "mistral-ocr-latest-2025" is not one run).
 */
export function looksLikeKey(value: string): boolean {
	if (KEY_PREFIX.test(value)) return true;
	return (value.match(/[A-Za-z0-9_+/=]{24,}/g) ?? []).some((run) => (run.match(/\d/g)?.length ?? 0) >= 2 && (run.match(/[A-Za-z]/g)?.length ?? 0) >= 2);
}

/**
 * Why a DRAFTED profile may not send what it sends (pure; exported for tests). A model writes the draft from a page
 * that may be hostile, and a credential or an account it writes is the page's, never the user's, so:
 *   - a fixed header named like a key or an account (DRAFT_CREDENTIAL_HEADER_NAMES, or containing DRAFT_CREDENTIAL_NAME)
 *     is refused whatever its value (the one key header is `auth`, which the validator keeps out of the fixed headers);
 *   - a fixed field (any segment of its pointer) or query parameter with such a name is refused when its value is more
 *     than a short enumerated word (letters, _ and -, at most 16 characters) or a number of at most 6 digits; without
 *     `auth` it is refused unless it is such a number or true/false (no key, so no reason to name an account);
 *   - any fixed value that looks like a key (looksLikeKey) is refused, whatever its name.
 * Each message says what to remove, so the author's repair call can.
 */
export function draftCredentialProblems(profile: HttpConverterProfile): string[] {
	const errors: string[] = [];
	const remove = "a drafted profile may not send a key, a token or an account of its own: remove it (the user's key goes only through auth, entered in the app)";
	for (const [name, value] of Object.entries(profile.submit.headers ?? {})) {
		const lower = name.toLowerCase();
		if ((DRAFT_CREDENTIAL_HEADER_NAMES as readonly string[]).includes(lower) || DRAFT_CREDENTIAL_NAME.test(lower)) errors.push(`/submit/headers/${name}: this header carries a key or an account; ${remove}`);
		else if (looksLikeKey(value)) errors.push(`/submit/headers/${name}: its value looks like a key; ${remove}`);
	}
	if (profile.auth && !PLAIN_AUTH_VALUE.test(profile.auth.value) && looksLikeKey(profile.auth.value.replace("{{API_KEY}}", ""))) errors.push(`/auth/value: holds a key besides {{API_KEY}}; ${remove}`);
	const named = (where: string, names: readonly string[], scalar: unknown) => {
		if (scalar === null || typeof scalar === "object") return;
		const value = String(scalar);
		if (looksLikeKey(value)) return void errors.push(`${where}: its value looks like a key; ${remove}`);
		if (!names.some((n) => DRAFT_CREDENTIAL_NAME.test(percentDecoded(n)))) return;
		const allowed = profile.auth ? SHORT_WORD.test(value) || value === "" : SHORT_NUMBER.test(value) || value === "";
		if (!allowed || /\{\{/.test(value)) errors.push(`${where}: its name suggests a key or an account${profile.auth ? " and its value is more than a short word" : " and the profile takes no key"}; ${remove}`);
	};
	const body = profile.submit.body;
	if (body.type === "multipart") {
		for (const [name, value] of Object.entries(body.fields ?? {})) for (const v of Array.isArray(value) ? value : [value]) named(`/submit/body/fields/${name}`, [name], v);
	} else {
		const walk = (node: unknown, at: string) => {
			if (node !== null && typeof node === "object") for (const [key, value] of Array.isArray(node) ? node.map((v, i) => [String(i), v] as const) : Object.entries(node)) walk(value, `${at}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`);
			else named(`/submit/body/json${at}`, pointerSegments(at), node);
		};
		walk(body.json ?? {}, "");
	}
	for (const [where, path] of [["/submit/path", profile.submit.path], ["/poll/path", profile.poll?.path], ["/result/path", profile.result?.path]] as const) {
		if (path === undefined) continue;
		for (const q of queryParameters(path)) if (q.value !== "{{JOB_ID}}") named(`${where} (query parameter ${q.name})`, [q.name], q.value);
		if (looksLikeKey(percentDecoded(path.split("?")[0]!))) errors.push(`${where}: holds what looks like a key; ${remove}`);
	}
	return errors;
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
	const fixed = fixedValues(profile);
	const masked = credential?.stored && credential.hint ? `${KEY_MASK}${credential.hint.replace(/^…/, "")}` : KEY_MASK;
	const poll = profile.poll;
	const statuses = poll ? `done: ${poll.done.map((v) => JSON.stringify(v)).join(", ")}; still working: ${poll.running.map((v) => JSON.stringify(v)).join(", ")}${poll.failed?.length ? `; failed: ${poll.failed.map((v) => JSON.stringify(v)).join(", ")}` : ""}` : "";
	const origin = baseUrl ? new URL(baseUrl).origin : NO_BASE_URL;
	return {
		submit: `${profile.submit.method} ${urlFor(baseUrl, profile.submit.path)}`,
		body: body.type === "multipart"
			? `The PDF is uploaded as the form field "${body.fileField}" (multipart/form-data).`
			: `The PDF is sent inside a JSON body at ${body.filePointer}, as ${body.encoding === "data-url" ? "a base64 data URL" : "base64 text"}.`,
		...(profile.auth ? { auth: { header: profile.auth.header, value: profile.auth.value.replace("{{API_KEY}}", masked) } } : {}),
		fixed,
		acknowledgeNeeded: fixed.some((v) => v.acknowledge),
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
/** A string value kept as it is: a short status-like token (`done`, `PROCESSING`, `page_count`, `v2`). */
export const FIX_TOKEN = /^[A-Za-z0-9_-]{1,16}$/;
/** A field name kept as it is: a plain identifier of at most 40 characters. */
export const FIX_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,39}$/;
const STRING_MARKER = /^<text, \d+ chars>$/;
const NAME_MARKER = /^<name \d+, \d+ chars>$/;

/**
 * A JSON value reduced to its shape (pure), for the fix call: a string value becomes `<text, N chars>` unless it is a
 * short status-like token (FIX_TOKEN) that `allowed` accepts; a field name becomes `<name i, N chars>` unless it is
 * a plain identifier (FIX_FIELD_NAME) that `allowed` accepts; lists are cut to 3 entries plus a count, objects to 30
 * fields, depth to 8, and FIX_SHAPE_MAX_NODES values in all. Nothing of a free-form string reaches the model, only
 * its length. Reducing an already reduced shape changes nothing.
 */
export function replyShape(value: unknown, allowed: (text: string) => boolean = () => true): unknown {
	let budget = FIX_SHAPE_MAX_NODES;
	const walk = (node: unknown, depth: number): unknown => {
		if (--budget < 0) return "…";
		if (typeof node === "string") {
			if (STRING_MARKER.test(node) || node === "…" || node === "[…]" || node === "{…}" || /^…\(\d+ entries in all\)$/.test(node)) return node;
			return FIX_TOKEN.test(node) && allowed(node) ? node : `<text, ${node.length} chars>`;
		}
		if (node === null || typeof node !== "object") return typeof node === "number" || typeof node === "boolean" ? node : null;
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
			const name = NAME_MARKER.test(key) || key === "…" || (FIX_FIELD_NAME.test(key) && allowed(key)) ? key : `<name ${fields}, ${key.length} chars>`;
			Object.defineProperty(out, name, { value: walk((node as Record<string, unknown>)[key], depth + 1), enumerable: true, configurable: true, writable: true });
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
 * What the fix call sees of a failed Test (pure): which checks failed and why, with every secret and the user's
 * service address removed, and the shape of the service's answers (replyShape: lengths, not strings). No page text.
 */
export function reportForModel(report: ConverterValidationReport, answers: readonly TestAnswerShape[], redact: (text: string) => string, allowed: (text: string) => boolean = () => true): FixReport {
	const line = (text: string, max: number) => plainLine(redact(text), max);
	return {
		checks: report.checks.map((c) => ({ id: c.id, status: c.status, message: line(c.message, 300) })),
		...(report.error ? { error: { kind: report.error.kind, message: line(report.error.message, 400) } } : {}),
		pages: report.pages.map((p) => ({ page: p.page, chars: p.text.length })),
		warnings: report.warnings.slice(0, 5).map((w) => line(w, 200)),
		answers: answers.slice(0, 6).map((a) => ({ ...a, shape: replyShape(a.shape, allowed) })),
	};
}

