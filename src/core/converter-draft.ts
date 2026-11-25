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
 *     with the user's own origin joined to every path and the key masked; EVERYTHING it decides that goes on the wire
 *     is listed exactly as sent (`fixedValues`, found by walking the profile's schema: a field the format gains later
 *     is listed by default), and Approve always needs "I have read these values", tied to the version on screen. Red
 *     rules (`redReason`: addresses, account-like names, opaque runs, invisible characters) only decide which are
 *     shown first, with a reason.
 *   - a draft is refused only for a credential header of its own or a value that holds a well-known key prefix
 *     (`draftCredentialProblems`); the acknowledgement is the gate for everything else.
 *   - the format documentation the model reads (`profileFormatGuide`) is generated from the validator's schema and
 *     constants, so it cannot drift from what the validator accepts (a test checks every schema field is described).
 *   - after a failed Test, what the model is told about it (`reportForModel`) is the checks in the app's own words,
 *     the error kind and HTTP status, and of at most three answers only their shape (`replyShape`): nothing a service
 *     wrote reaches it as text, and nothing at all of the answers when the service echoed the key.
 *   - the model's note and reason are replaced by a fixed sentence when they carry an address (`screenedAiText`).
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
	const note = screenedAiText((envelope.note as string | undefined) ?? "", "note");
	if (result === "cannot_express") {
		if (typeof envelope.reason !== "string" || !envelope.reason.trim()) return { ok: false, errors: ["/reason: say why the service cannot be described"] };
		return { ok: true, kind: "cannot_express", reason: screenedAiText(envelope.reason, "reason"), note, droppedText };
	}
	if (envelope.profile === null || typeof envelope.profile !== "object" || Array.isArray(envelope.profile)) return { ok: false, errors: ["/profile: must be a JSON object"] };
	return { ok: true, kind: "profile", profile: envelope.profile, note, droppedText };
}

/** What replaces an AI note or reason that carried an address or an invisible character (ruling 5 of fix round 2). */
export const NOTE_REMOVED = "The AI's note was removed because it contained an address.";
export const REASON_REMOVED = "The AI says this service cannot be described by a connector profile. Its explanation was removed because it contained an address.";

/**
 * The model's note or "cannot be expressed" reason as the user may see it (pure; exported for tests): one plain line,
 * or, when the text as written holds anything the address rules match (a scheme, a host-like token, an e-mail) or an
 * invisible or control character (other than line breaks and tabs), the fixed sentence instead, whole. Applied when
 * the reply is read and again whenever a draft file is read.
 */
export function screenedAiText(text: string, kind: "note" | "reason"): string {
	// stricter than for profile values (re-check 3): in the AI's prose any dotted name (word.word) counts as an address,
	// whatever its ending; a note that names a JSON field as `result.pages` is replaced too, which is the safe side
	const dotted = /[a-z0-9-]+\.[a-z]{2,}/i.test(text);
	if (text !== NOTE_REMOVED && text !== REASON_REMOVED && (UNSEEN_IN_PROSE.test(text) || dotted || addressReason(text) !== undefined)) return kind === "note" ? NOTE_REMOVED : REASON_REMOVED;
	return plainLine(text, DRAFT_NOTE_MAX_CHARS);
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

// ── What a drafted profile sends: every value it decides is listed; red rules only put some first ──

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
	[new RegExp(`(?:^|[^\\w.-])(?:[a-z0-9-]+\\.)+(?:${COMMON_TLDS}|[a-z]{2})(?![\\w-]|\\.[a-z0-9])`, "i"), "it is a host name"],
];

/**
 * A name as words (re-check 3, finding 4): split at anything that is not a letter or digit and at camelCase
 * boundaries, lower case. Names are judged word by word, so `security_level` is not red for the `uri` inside it, nor
 * `keywords` for `key`, nor `tokenizer` for `token`.
 */
export function nameWords(name: string): string[] {
	return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Words that suggest an address the service would send data to. */
const ADDRESS_WORDS = new Set([
	"callback", "callbacks", "webhook", "webhooks", "hook", "hooks", "notify", "notification", "notifications", "notif", "redirect", "url", "urls", "uri", "uris",
	"endpoint", "endpoints", "email", "emails", "mail", "mailto", "forward", "destination", "dest", "target", "bucket", "s3", "sink", "host", "hostname", "domain",
	"server", "address", "addr", "recipient", "recipients", "channel", "href", "link", "proxy", "ping", "share", "ip",
]);
/** Whole names that suggest one (too short or too common to count as a word inside a longer name). */
const ADDRESS_WHOLE_NAMES = new Set(["to", "cc", "bcc"]);
/** Word pairs that suggest one: `send_to`, `reply-to`, `returnTo`, `upload_to`, `mail_to`, `forward_to`. */
const ADDRESS_WORD_PAIRS = /(?:^| )(?:send|reply|return|upload|mail|forward|deliver|post|notify) to(?: |$)/;
/** Words that suggest a key, a token, or someone's tenant, account, organisation, workspace, project, user, customer,
 *  team, client or subscription (ruling 2 of fix round 2: red, never refused). */
const ACCOUNT_WORDS = new Set([
	"key", "keys", "apikey", "token", "secret", "secrets", "auth", "password", "passwd", "credential", "credentials", "session", "signature", "tenant", "account",
	"acct", "organization", "organisation", "org", "workspace", "ws", "project", "user", "username", "customer", "team", "client", "subscription", "owner",
	"recipient", "channel",
]);
/** The same without the words every key header has (the key header's own name is judged by these). */
const ACCOUNT_ONLY_WORDS = new Set([...ACCOUNT_WORDS].filter((w) => !["key", "keys", "apikey", "token", "secret", "secrets", "auth", "password", "passwd", "credential", "credentials", "session", "signature", "subscription"].includes(w)));
/** Ordinary options whose names hold one of those words: never red as names. */
const ORDINARY_NAMES = new Set(["idempotency key", "max tokens", "min tokens", "num tokens", "max output tokens", "max new tokens", "max completion tokens", "x idempotency key"]);

const suggestsAddress = (name: string): boolean => {
	const words = nameWords(name);
	return ADDRESS_WHOLE_NAMES.has(words.join(" ")) || words.some((w) => ADDRESS_WORDS.has(w)) || ADDRESS_WORD_PAIRS.test(words.join(" "));
};
const suggestsAccount = (name: string, only = false): boolean => {
	const words = nameWords(name);
	if (ORDINARY_NAMES.has(words.join(" "))) return false;
	return words.some((w) => (only ? ACCOUNT_ONLY_WORDS : ACCOUNT_WORDS).has(w));
};
/** The usual names of the one key header: not red as names. */
const USUAL_KEY_HEADERS = new Set(["authorization", "x-api-key", "api-key", "apikey", "x-key", "key", "x-auth-token", "x-access-token", "x-api-token", "ocp-apim-subscription-key", "x-goog-api-key", "x-functions-key", "subscription-key"]);
/** The usual words before the key in its header ("Bearer {{API_KEY}}"). */
const USUAL_KEY_SCHEMES = new Set(["", "bearer", "token", "key", "apikey", "api-key", "jwt", "basic"]);

/** Invisible, direction-changing and control characters (and other format characters): shown as visible escapes. */
const UNSEEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]|\p{Cf}/gu;
/** The same, except line breaks and tabs (prose may have them; they become spaces). */
const UNSEEN_IN_PROSE = new RegExp(UNSEEN.source.replace("\\u0000-\\u001f", "\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f"), "u");

/** `text` with every invisible or control character written as a visible escape (`\u{200B}`), so it reads as sent. */
export function visibleText(text: string): string {
	return text.replace(UNSEEN, (c) => `\\u{${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}}`);
}

/** Why a value looks like an address (pure; exported for tests), or undefined. Checked as written and decoded. */
export function addressReason(value: string): string | undefined {
	const plain = value.replace(/\{\{(?:DELIMITER|JOB_ID|API_KEY)\}\}/g, "");
	for (const form of new Set([plain, percentDecoded(plain), percentDecoded(plain.replace(/\+/g, " "))])) {
		for (const [rule, reason] of ADDRESS_VALUE_RULES) if (rule.test(form)) return reason;
	}
	return undefined;
}

const ACCOUNT_REASON = "this may send your documents to someone else's account";
const OPAQUE_REASON = "this looks like an identifier or key chosen by the documentation";
const UNSEEN_REASON = "it holds invisible or control characters (shown as \\u{…}), so it may read differently from what is sent";

/** Why a name (or one segment of a pointer or path) stands out, or undefined (pure; exported for tests). */
export function nameReason(name: string): string | undefined {
	const decoded = percentDecoded(name);
	if (suggestsAddress(decoded)) return "its name suggests an address the service would send data to";
	if (suggestsAccount(decoded)) return ACCOUNT_REASON;
	return undefined;
}

/**
 * Whether a value holds a long opaque run (pure; exported for tests): 24 or more letters, digits, `_`, `+` or `=`
 * with at least two digits and two letters (hex and base64 keys and ids). Checked per value and per path segment,
 * never across `/` or `-`, so an ordinary path or a hyphenated model name is not one run.
 */
export function opaqueRun(value: string): boolean {
	return (value.match(/[A-Za-z0-9_+=]{24,}/g) ?? []).some((run) => (run.match(/\d/g)?.length ?? 0) >= 2 && (run.match(/[A-Za-z]/g)?.length ?? 0) >= 2);
}

/** The segments of a JSON Pointer, unescaped ("/a~1b/0" → ["a/b", "0"]). */
function pointerSegments(pointer: string): string[] {
	return pointer.split("/").slice(1).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

const pointerPart = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");

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

/** Placeholders as the list shows them: what the app puts there. */
function shownPlaceholders(text: string, key = KEY_MASK): string {
	return text.replace(/\{\{JOB_ID\}\}/g, "<job id>").replace(/\{\{DELIMITER\}\}/g, "<separator>").replace(/\{\{API_KEY\}\}/g, key);
}

/** One thing a profile sends, before it is shown: what is checked by the red and refusal rules. */
interface SentItem {
	kind: FixedValue["kind"];
	request: FixedValue["request"];
	label: string;
	value: string;
	raw?: string;
	/** Where it is in the profile (a JSON Pointer), for refusal messages. */
	at: string;
	/** Names it carries (a header or field name, pointer and path segments, parameter names). */
	names: string[];
	/** Values it carries as written (placeholders removed), each checked on its own. */
	texts: string[];
	/** A reason of its own kind (the key header's extra text, a file field that is not a plain name). */
	reason?: string;
}

/** What a schema field is for the list: a function lists it, "covered" fields are listed by a neighbour's entry, and
 *  "not sent" fields are read from the service's answers or kept by the app. Any field NOT named here is listed as
 *  it is ("other"): a field the format gains later is shown and acknowledged until someone decides otherwise. */
type FieldRule = "not sent" | "covered" | ((value: unknown, profile: HttpConverterProfile, out: SentItem[]) => void);

const methodOf = (profile: HttpConverterProfile, request: "submit" | "poll" | "result") => (request === "submit" ? profile.submit.method : (profile[request]?.method ?? "GET"));

function pathItems(request: "submit" | "poll" | "result") {
	return (value: unknown, profile: HttpConverterProfile, out: SentItem[]) => {
		const path = String(value);
		const at = `/${request}/path`;
		out.push({ kind: "method", request, label: `${request} method`, value: methodOf(profile, request), at: `/${request}/method`, names: [], texts: [] });
		const bare = path.split("?")[0]!;
		const names: string[] = [];
		const texts: string[] = [];
		for (const segment of bare.split("/")) {
			if (!segment || /^\{\{\w+\}\}$/.test(segment)) continue;
			const decoded = percentDecoded(segment).replace(/\{\{\w+\}\}/g, "");
			texts.push(decoded);
			for (const part of decoded.split(";")) {
				const eq = part.indexOf("=");
				names.push(eq < 0 ? part : part.slice(0, eq));
				if (eq >= 0) texts.push(part.slice(eq + 1));
			}
		}
		out.push({ kind: "path", request, label: `${request} path`, value: shownPlaceholders(bare), at, names, texts });
		for (const q of queryParameters(path)) {
			const raw = q.raw !== `${q.name}=${q.value}` ? q.raw : undefined;
			out.push({ kind: "query", request, label: shownPlaceholders(q.name), value: shownPlaceholders(q.value), ...(raw !== undefined ? { raw } : {}), at: `${at} (query parameter ${q.name})`, names: [q.name], texts: [q.value.replace(/\{\{\w+\}\}/g, "")] });
		}
	};
}

const FIELD_RULES: Readonly<Record<string, FieldRule>> = {
	// set by the app, or refused by the validator in a draft
	format: "not sent", id: "not sent", name: "not sent", version: "not sent", description: "not sent", docsUrl: "not sent", defaultBaseUrl: "not sent", unverified: "not sent",
	auth: (value, _profile, out) => {
		const auth = value as { header: string; value: string };
		const lower = auth.header.toLowerCase();
		const around = auth.value.split("{{API_KEY}}").map((t) => t.trim()).filter(Boolean);
		const usualScheme = around.length <= 1 && USUAL_KEY_SCHEMES.has((around[0] ?? "").toLowerCase()) && auth.value.trimStart().indexOf("{{API_KEY}}") >= auth.value.trimStart().length - "{{API_KEY}}".length;
		const reason = !USUAL_KEY_HEADERS.has(lower) && (suggestsAccount(lower, true) || suggestsAddress(lower)) ? ACCOUNT_REASON
			: !usualScheme ? "the key header sends text besides your key, chosen by the documentation: it may route your key or documents to someone else's account"
			: undefined;
		out.push({ kind: "auth", request: "every request", label: auth.header, value: shownPlaceholders(auth.value), at: "/auth", names: [], texts: around, ...(reason ? { reason } : {}) });
	},
	"auth.header": "covered", "auth.value": "covered",
	// checked by the app before anything is sent
	limits: "not sent", "limits.maxBytes": "not sent", "limits.maxPages": "not sent",
	"submit.method": "covered",
	"submit.path": pathItems("submit"),
	"submit.headers": (value, _profile, out) => {
		for (const [name, text] of Object.entries(value as Record<string, string>)) out.push({ kind: "header", request: "every request", label: name, value: text, at: `/submit/headers/${pointerPart(name)}`, names: [name], texts: [text] });
	},
	"submit.body.multipart.type": "covered",
	"submit.body.multipart.fileField": (value, _profile, out) => {
		const name = String(value);
		out.push({ kind: "file", request: "submit", label: "submit file field", value: name, at: "/submit/body/fileField", names: [name], texts: [name], ...(/^[A-Za-z0-9_.-]{1,64}$/.test(name) ? {} : { reason: "the PDF's form field name is not one plain word: it could carry other form parameters" }) });
	},
	"submit.body.multipart.fields": (value, _profile, out) => {
		for (const [name, item] of Object.entries(value as Record<string, string | string[]>)) {
			const list = Array.isArray(item) ? item : [item];
			list.forEach((v, i) => out.push({ kind: "field", request: "submit", label: Array.isArray(item) ? `${name}[${i}]` : name, value: shownPlaceholders(v), at: `/submit/body/fields/${pointerPart(name)}${Array.isArray(item) ? `/${i}` : ""}`, names: [name], texts: [v.replace(/\{\{\w+\}\}/g, "")] }));
		}
	},
	"submit.body.json-base64.type": "covered",
	"submit.body.json-base64.filePointer": (value, _profile, out) => {
		const pointer = String(value);
		out.push({ kind: "file", request: "submit", label: "submit file pointer", value: pointer, at: "/submit/body/filePointer", names: pointerSegments(pointer), texts: pointerSegments(pointer) });
	},
	"submit.body.json-base64.encoding": (value, _profile, out) => {
		out.push({ kind: "file", request: "submit", label: "submit PDF encoding", value: String(value), at: "/submit/body/encoding", names: [], texts: [] });
	},
	"submit.body.json-base64.json": (value, profile, out) => {
		const body = profile.submit.body;
		const filePointer = body.type === "json-base64" ? body.filePointer : "";
		const walk = (node: unknown, at: string) => {
			if (node !== null && typeof node === "object") {
				const entries = Array.isArray(node) ? node.map((v, i) => [String(i), v] as const) : Object.entries(node);
				// an empty container is sent as it is, unless it is the body itself or the PDF goes into it
				if (entries.length === 0 && at !== "" && !(filePointer === at || filePointer.startsWith(`${at}/`))) {
					out.push({ kind: "field", request: "submit", label: at, value: Array.isArray(node) ? "[]" : "{}", at: `/submit/body/json${at}`, names: pointerSegments(at), texts: [] });
				}
				for (const [key, child] of entries) walk(child, `${at}/${pointerPart(key)}`);
			} else {
				const text = typeof node === "string" ? node : (JSON.stringify(node) ?? "null");
				out.push({ kind: "field", request: "submit", label: at, value: typeof node === "string" ? shownPlaceholders(JSON.stringify(node)) : text, at: `/submit/body/json${at}`, names: pointerSegments(at), texts: [text.replace(/\{\{\w+\}\}/g, "")] });
			}
		};
		walk(value, "");
	},
	// read from the service's answers, or when to ask: never sent
	"poll.jobIdPointer": "not sent", "poll.statusPointer": "not sent", "poll.done": "not sent", "poll.running": "not sent", "poll.failed": "not sent", "poll.errorPointer": "not sent", "poll.intervalMs": "not sent", "poll.maxPolls": "not sent",
	"poll.method": "covered",
	"poll.path": pathItems("poll"),
	"result.method": "covered",
	"result.path": pathItems("result"),
	extract: "not sent",
};

/** Whether a schema path is decided by FIELD_RULES (itself or an ancestor). Exported for the drift test. */
export function fieldRuleOf(schemaPath: string): FieldRule | undefined {
	for (let at = schemaPath; at; at = at.includes(".") ? at.slice(0, at.lastIndexOf(".")) : "") {
		if (FIELD_RULES[at] !== undefined) return at === schemaPath ? FIELD_RULES[at] : FIELD_RULES[at] === "not sent" ? "not sent" : "covered";
	}
	return undefined;
}

/** Every value of a profile that goes on the wire, by walking its schema (FIELD_RULES says what each field is). */
function sentItems(profile: HttpConverterProfile): SentItem[] {
	const out: SentItem[] = [];
	const other = (schemaPath: string, value: unknown, at: string) => {
		const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
		const top = schemaPath.split(".")[0];
		out.push({ kind: "other", request: top === "submit" || top === "poll" || top === "result" ? top : "every request", label: at, value: typeof value === "string" ? JSON.stringify(value) : text, at, names: pointerSegments(at), texts: [text] });
	};
	const walk = (node: SchemaNode, value: unknown, schemaPath: string, at: string) => {
		const rule = schemaPath ? FIELD_RULES[schemaPath] : undefined;
		if (rule === "not sent" || rule === "covered") return;
		if (typeof rule === "function") return rule(value, profile, out);
		if (node.anyOf?.some((n) => n.type === "object" && n.properties) && value !== null && typeof value === "object") {
			const record = value as Record<string, unknown>;
			const variant = node.anyOf.find((n) => n.properties?.type?.const !== undefined ? n.properties.type.const === record.type : n.required?.[0] !== undefined && n.required[0] in record);
			if (variant) return walk(variant, value, `${schemaPath}.${variantName(variant)}`, at);
			return other(schemaPath, value, at);
		}
		if (node.properties && value !== null && typeof value === "object" && !Array.isArray(value)) {
			const record = value as Record<string, unknown>;
			for (const key of Object.keys(node.properties)) if (record[key] !== undefined) walk(node.properties[key]!, record[key], schemaPath ? `${schemaPath}.${key}` : key, `${at}/${pointerPart(key)}`);
			for (const key of Object.keys(record)) if (!(key in node.properties)) other(schemaPath ? `${schemaPath}.${key}` : key, record[key], `${at}/${pointerPart(key)}`);
			return;
		}
		other(schemaPath, value, at);
	};
	walk(HTTP_CONVERTER_PROFILE_SCHEMA as unknown as SchemaNode, profile, "", "");
	return out;
}

/** The first reason an item is red, or undefined. */
function redReason(item: SentItem): string | undefined {
	if ([item.label, item.value, item.raw ?? "", ...item.names, ...item.texts].some((t) => new RegExp(UNSEEN.source, "u").test(t))) return UNSEEN_REASON;
	const address = item.texts.map(addressReason).find(Boolean) ?? (item.raw !== undefined ? addressReason(item.raw) : undefined) ?? item.names.map(addressReason).find(Boolean);
	if (address) return `its value looks like an address (${address}): a service told to send results or notifications there would send your documents' text to it`;
	if (item.reason) return item.reason;
	const byName = item.names.map(nameReason).find(Boolean);
	if (byName) return byName;
	if ([...item.texts, ...item.names].some(opaqueRun)) return OPAQUE_REASON;
	return undefined;
}

/**
 * Everything a profile decides that is sent, exactly as written (pure; exported for tests), found by walking the
 * profile's schema: the method and each path, every query parameter, the key header (its name and its value with the
 * key masked), every fixed header, the PDF's form field or JSON pointer and encoding, every fixed form field and
 * JSON leaf (a {{DELIMITER}} field with its text), and any field the format may gain. Invisible and control
 * characters are shown as escapes. Red ones (with a reason) first; the schema's order otherwise.
 */
export function fixedValues(profile: HttpConverterProfile, credential?: CredentialStatus): FixedValue[] {
	const mask = credential?.stored && credential.hint ? `${KEY_MASK}${credential.hint.replace(/^…/, "")}` : KEY_MASK;
	const out = sentItems(profile).map((item): FixedValue => {
		const warning = redReason(item);
		const value = item.kind === "auth" ? item.value.replaceAll(KEY_MASK, mask) : item.value;
		return { kind: item.kind, request: item.request, label: visibleText(item.label), value: visibleText(value), ...(item.raw !== undefined ? { raw: visibleText(item.raw) } : {}), ...(warning ? { warning } : {}) };
	});
	return [...out.filter((v) => v.warning), ...out.filter((v) => !v.warning)];
}

/** The red values' reasons, one line each (pure; exported for tests). */
export function addressWarnings(profile: HttpConverterProfile): string[] {
	return fixedValues(profile).filter((v) => v.warning).map((v) => `${v.label} (${KIND_WORDS[v.kind]}) = ${v.value}: ${v.warning}.`);
}

const KIND_WORDS: Record<FixedValue["kind"], string> = { method: "method", path: "path", query: "query parameter", header: "fixed header", auth: "key header", file: "the PDF's place", field: "fixed field", other: "field" };

// ── Credentials in a drafted profile: a narrow refusal (a hand-written import keeps its own rules) ──

/** Fixed header names refused in a draft (exactly, in any case), besides any name containing `secret` or `password`. */
export const DRAFT_REFUSED_HEADER_NAMES = ["authorization", "proxy-authorization", "cookie", "x-api-key", "api-key", "apikey", "x-auth-token", "x-access-token", "ocp-apim-subscription-key"] as const;

/**
 * The well-known key prefixes a drafted value may not begin with, each with the shape that must follow it (so a
 * locale such as `sk-SK` or a word such as `xoxo` is not taken for a key).
 */
export const DRAFT_KEY_PREFIXES: readonly (readonly [string, RegExp])[] = [
	["sk-", /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_.:-]{8,}/i],
	["Bearer ", /(?:^|[^A-Za-z0-9])Bearer\s+\S{8,}/i],
	["ghp_", /(?:^|[^A-Za-z0-9])ghp_[A-Za-z0-9]{8,}/i],
	["gho_", /(?:^|[^A-Za-z0-9])gho_[A-Za-z0-9]{8,}/i],
	["AIza", /(?:^|[^A-Za-z0-9])AIza[0-9A-Za-z_-]{8,}/i],
	["AKIA", /(?:^|[^A-Za-z0-9])AKIA[0-9A-Za-z]{8,}/i],
	["xox", /(?:^|[^A-Za-z0-9])xox(?:[a-z]-|e\.xox[a-z]-)[A-Za-z0-9-]{4,}/i],
	["a JWT", /(?:^|[^A-Za-z0-9])eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/],
];

/**
 * The key prefix a value holds, or undefined (pure; exported for tests). Looked for anywhere a word can start, in any
 * letter case, with invisible characters removed first (re-check 3, finding 3): `Token sk-…`, `key=sk-…`, `SK-…` and
 * a zero-width space before the prefix are all the same key.
 */
export function keyPrefixOf(value: string): string | undefined {
	const text = value.replace(new RegExp(UNSEEN.source, "gu"), "");
	return DRAFT_KEY_PREFIXES.find(([, rule]) => rule.test(text))?.[0];
}

const REFUSAL_ADVICE = "remove it, or, if the service really needs it, write the profile by hand and import it (the user's key goes only through auth, entered in the app)";

/**
 * Why a DRAFTED profile is refused (pure; exported for tests). The acknowledgement of everything it sends is the
 * gate, so this is narrow: a fixed header named exactly like a credential header (DRAFT_REFUSED_HEADER_NAMES) or whose
 * name contains `secret` or `password`; and any value or name, in any place, that holds a well-known key
 * prefix (DRAFT_KEY_PREFIXES). Everything else is listed, and at most red.
 */
export function draftCredentialProblems(profile: HttpConverterProfile): string[] {
	const errors: string[] = [];
	for (const item of sentItems(profile)) {
		if (item.kind === "header") {
			const lower = item.label.toLowerCase();
			if ((DRAFT_REFUSED_HEADER_NAMES as readonly string[]).includes(lower) || /secret|password/.test(lower)) {
				errors.push(`${item.at}: a drafted profile may not send a credential header of its own; ${REFUSAL_ADVICE}`);
				continue;
			}
		}
		// the whole text and its parts: "Bearer <token>" needs the whole, "key=sk-…" is found either way
		const pieces = [...item.texts, ...item.names];
		const prefix = pieces.map(keyPrefixOf).find(Boolean);
		if (prefix) errors.push(`${item.at}: holds what looks like a key (it has the key prefix ${prefix}); a drafted profile may not send a key of its own; ${REFUSAL_ADVICE}`);
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
 * none is saved yet) joined with each path, the key masked, and everything the profile decides that is sent. Pure.
 */
export function describeProfile(profile: HttpConverterProfile, baseUrl: string | undefined, credential?: CredentialStatus): ProfilePreflight {
	const body = profile.submit.body;
	const fixed = fixedValues(profile, credential);
	const masked = credential?.stored && credential.hint ? `${KEY_MASK}${credential.hint.replace(/^…/, "")}` : KEY_MASK;
	const poll = profile.poll;
	const statuses = poll ? `done: ${poll.done.map((v) => JSON.stringify(v)).join(", ")}; still working: ${poll.running.map((v) => JSON.stringify(v)).join(", ")}${poll.failed?.length ? `; failed: ${poll.failed.map((v) => JSON.stringify(v)).join(", ")}` : ""}` : "";
	const origin = baseUrl ? new URL(baseUrl).origin : NO_BASE_URL;
	return {
		submit: `${profile.submit.method} ${visibleText(urlFor(baseUrl, profile.submit.path))}`,
		body: body.type === "multipart"
			? `The PDF is uploaded as the form field "${visibleText(body.fileField)}" (multipart/form-data).`
			: `The PDF is sent inside a JSON body at ${visibleText(body.filePointer)}, as ${body.encoding === "data-url" ? "a base64 data URL" : "base64 text"}.`,
		...(profile.auth ? { auth: { header: profile.auth.header, value: profile.auth.value.replaceAll("{{API_KEY}}", masked) } } : {}),
		fixed,
		...(poll ? { poll: visibleText(`The upload's answer holds a job id at ${poll.jobIdPointer}. Then ${poll.method ?? "GET"} ${urlFor(baseUrl, poll.path)} every ${((poll.intervalMs ?? POLL_DEFAULT_INTERVAL_MS) / 1000).toString()} s${poll.maxPolls ? `, at most ${poll.maxPolls} times` : ""}, reading the state at ${poll.statusPointer} (${statuses}).`) } : {}),
		...(profile.result ? { result: visibleText(`${profile.result.method ?? "GET"} ${urlFor(baseUrl, profile.result.path)} fetches the finished answer.`) } : {}),
		pages: visibleText(pagesSentence(profile)),
		warnings: addressWarnings(profile),
		origins: [origin],
	};
}

// ── What the fix call is told about a failed Test, and what the draft file keeps ──────

/** The most values one reduced answer holds (the fix call needs the shape, not the content). */
export const FIX_SHAPE_MAX_VALUES = 60;
/** The most answers kept and sent. */
export const FIX_MAX_ANSWERS = 3;
/** A field name kept as it is: a plain identifier of at most 24 characters. */
export const FIX_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,23}$/;
/** A value at the profile's own status pointer kept as it is: a word of at most 16 letters (`_` and `-` inside). */
export const FIX_STATUS_TOKEN = /^[A-Za-z][A-Za-z_-]{0,15}$/;
const STRING_MARKER = /^<text, \d{1,9} chars>$/;
const NAME_MARKER = /^<name \d{1,2}, \d{1,9} chars>$/;
const COUNT_MARKER = /^…\((?:[1-9] entries in all|more than 9 entries)\)$/;
const NUMBER_MARKER = "<number>";
const MARKERS = new Set(["…", "[…]", "{…}", NUMBER_MARKER, "…(more than 9 entries)"]);

export interface ShapeOptions {
	/** Whether a kept token or name shares nothing with the user's address or key (drafts.ts tokenAllowed). */
	allowed?: (text: string) => boolean;
	/** The profile's status pointer, in a status answer: the only place a short word is kept as it is. */
	statusPointer?: string;
	/**
	 * The value is a shape this function already produced (the draft file's, on its way to the fix call), so its
	 * markers are kept as they are. NEVER set for a service's own answer (re-check 3, finding 1): there a string that
	 * looks like a marker is service text like any other, and is replaced by its length.
	 */
	reduced?: boolean;
}

/**
 * A JSON value reduced to its shape (pure), for the fix call and the draft file: every string becomes
 * `<text, N chars>`, except a short word (FIX_STATUS_TOKEN) at `statusPointer`; a number becomes `<number>` unless it
 * is an integer from 0 to 9; a field name becomes `<name i, N chars>` unless it is a plain identifier of at most 24
 * characters (FIX_FIELD_NAME); kept words and names must pass `allowed`. Lists are cut to 3 entries and a count (up to
 * 9), objects to 30 fields, depth to 8, and FIX_SHAPE_MAX_VALUES values in all. Reducing a reduced shape again
 * changes nothing that matters.
 */
export function replyShape(value: unknown, options: ShapeOptions = {}): unknown {
	const allowed = options.allowed ?? (() => true);
	let budget = FIX_SHAPE_MAX_VALUES;
	const walk = (node: unknown, depth: number, at: string): unknown => {
		if (--budget < 0) return "…";
		if (typeof node === "string") {
			if (options.reduced && (STRING_MARKER.test(node) || MARKERS.has(node) || COUNT_MARKER.test(node))) return node;
			return at === options.statusPointer && FIX_STATUS_TOKEN.test(node) && allowed(node) ? node : `<text, ${node.length} chars>`;
		}
		if (typeof node === "number") return Number.isInteger(node) && node >= 0 && node <= 9 ? node : NUMBER_MARKER;
		if (node === null || typeof node !== "object") return typeof node === "boolean" ? node : null;
		if (depth >= 8) return Array.isArray(node) ? "[…]" : "{…}";
		if (Array.isArray(node)) {
			// a reduced list keeps its own count (its last entry), instead of being counted again as four entries
			const tail = node.at(-1);
			if (options.reduced && node.length <= 4 && typeof tail === "string" && COUNT_MARKER.test(tail)) return [...node.slice(0, -1).map((v, i) => walk(v, depth + 1, `${at}/${i}`)), tail];
			const head = node.slice(0, 3).map((v, i) => walk(v, depth + 1, `${at}/${i}`));
			return node.length > 3 ? [...head, node.length <= 9 ? `…(${node.length} entries in all)` : "…(more than 9 entries)"] : head;
		}
		const out: Record<string, unknown> = {};
		let fields = 0;
		for (const key in node) {
			if (!Object.hasOwn(node, key)) continue;
			if (++fields > 30 || budget <= 0) {
				out["…"] = "…";
				break;
			}
			const name = (options.reduced && (NAME_MARKER.test(key) || key === "…")) || (FIX_FIELD_NAME.test(key) && allowed(key)) ? key : `<name ${fields}, ${key.length} chars>`;
			Object.defineProperty(out, name, { value: walk((node as Record<string, unknown>)[key], depth + 1, `${at}/${pointerPart(key)}`), enumerable: true, configurable: true, writable: true });
		}
		return out;
	};
	return walk(value, 0, "");
}

/** The service's answers seen during a Test, by request, already reduced to their shape. */
export interface TestAnswerShape {
	pdf: "two-page" | "blank-middle";
	stage: "submit" | "poll" | "result";
	shape: unknown;
}

/**
 * The answers kept of a Test (pure): the final answer of each test PDF (the one the text is read from), and the first
 * PDF's upload answer when that is another one; at most FIX_MAX_ANSWERS, in the order they came (so keeping the kept
 * ones again changes nothing).
 */
export function keptAnswers(answers: readonly TestAnswerShape[]): TestAnswerShape[] {
	const last = (pdf: TestAnswerShape["pdf"]) => answers.filter((a) => a.pdf === pdf).at(-1);
	const firstUpload = answers.find((a) => a.pdf === "two-page" && a.stage === "submit");
	const picked = new Set([last("two-page"), firstUpload, last("blank-middle")].filter((a): a is TestAnswerShape => a !== undefined).slice(0, FIX_MAX_ANSWERS));
	return answers.filter((a) => picked.has(a));
}

/** Each check's meaning in the app's own fixed words (the only wording kept on disk and sent to the model). */
export const CHECK_WORDS: Readonly<Record<string, Readonly<Record<"pass" | "fail" | "skipped", string>>>> = {
	converted: { pass: "The service answered for the two-page test PDF.", fail: "The two-page test PDF could not be converted (see the error kind).", skipped: "Not checked." },
	markers: { pass: "Both pages are present, in order, as valid page-marked Markdown.", fail: "The answer could not be placed on pages 1 and 2.", skipped: "Not checked, because an earlier check failed." },
	page_1: { pass: "Page 1 has its own sentence.", fail: "Page 1 does not have its own sentence.", skipped: "Not checked, because an earlier check failed." },
	page_2: { pass: "Page 2 has its own sentence.", fail: "Page 2 does not have its own sentence.", skipped: "Not checked, because an earlier check failed." },
	own_pages: { pass: "Neither page has the other page's sentence.", fail: "Text is on the wrong page: the page numbers are shifted or page breaks are missing.", skipped: "Not checked, because an earlier check failed." },
	blank_page: { pass: "A blank middle page stays blank and the page after it keeps its own text.", fail: "The three-page test PDF with a blank middle page failed, or its pages were not placed right.", skipped: "Not checked, because an earlier check failed." },
	no_secret: { pass: "The API key does not appear in the answer.", fail: "The service echoed the API key.", skipped: "Not checked." },
};

/** Each error kind in the app's own words. */
export const ERROR_KIND_WORDS: Readonly<Record<string, string>> = {
	unreachable: "The service could not be reached, or failed (HTTP 5xx).",
	auth: "The service refused the key.",
	rate_limit: "The service's rate limit was reached.",
	too_large: "The service refused the PDF as too large.",
	too_many_pages: "The PDF has more pages than the service accepts.",
	timeout: "The service did not answer in time.",
	bad_response: "The service answered with something the profile cannot read.",
	conversion_failed: "The service reported that the job failed.",
	no_text: "No text was found.",
	not_configured: "The profile could not be used as written.",
	aborted: "The Test was cancelled.",
	internal: "The Test failed inside the app.",
};

const checkWords = (id: string, status: string) => CHECK_WORDS[id]?.[status as "pass"] ?? "Not checked.";

/**
 * A Test report as the draft file keeps it (pure): the checks in the app's own words, the error's kind and HTTP status
 * in the app's words, no page previews, warnings or version: nothing the service wrote. Reducing it again changes
 * nothing.
 */
export function keptReport(report: ConverterValidationReport): ConverterValidationReport {
	const error = report.error;
	return {
		ok: report.ok === true,
		converterId: String(report.converterId ?? "").slice(0, 100),
		checks: report.checks.filter((c) => typeof c?.id === "string" && c.id in CHECK_WORDS).slice(0, 10).map((c) => {
			const status = c.status === "pass" || c.status === "fail" ? c.status : "skipped";
			return { id: c.id, status, message: checkWords(c.id, status) };
		}),
		pages: [],
		warnings: [],
		...(error && typeof error.kind === "string" && error.kind in ERROR_KIND_WORDS
			? { error: { kind: error.kind, message: ERROR_KIND_WORDS[error.kind]!, retryable: error.retryable === true, ...(Number.isInteger(error.httpStatus) && error.httpStatus! >= 100 && error.httpStatus! <= 599 ? { httpStatus: error.httpStatus } : {}) } }
			: {}),
		durationMs: Number.isFinite(report.durationMs) ? report.durationMs : 0,
	};
}

export interface FixReport {
	/** Which checks passed or failed, by id, in the app's own words. */
	checks: { id: string; status: string; meaning: string }[];
	/** The error's kind (the app's names) and the service's HTTP status, never its message. */
	error?: { kind: string; httpStatus?: number };
	/** The service echoed the key: no answer is sent at all. */
	keyEchoed?: true;
	answers: TestAnswerShape[];
}

/**
 * What the fix call sees of a failed Test (pure): which checks failed, by id, in the app's fixed words; the error kind
 * and HTTP status; and the shape of at most three answers (replyShape). Nothing a service wrote reaches the model as
 * text. When the service echoed the key, no answer at all: only that it did.
 */
export function reportForModel(report: ConverterValidationReport, answers: readonly TestAnswerShape[], options: { allowed?: (text: string) => boolean; statusPointer?: string } = {}): FixReport {
	const kept = keptReport(report);
	const echoed = kept.checks.some((c) => c.id === "no_secret" && c.status === "fail");
	return {
		checks: kept.checks.map((c) => ({ id: c.id, status: c.status, meaning: c.message })),
		...(kept.error ? { error: { kind: kept.error.kind, ...(kept.error.httpStatus !== undefined ? { httpStatus: kept.error.httpStatus } : {}) } } : {}),
		...(echoed ? { keyEchoed: true as const } : {}),
		answers: echoed ? [] : answers.slice(0, FIX_MAX_ANSWERS).map((a) => ({
			pdf: a.pdf === "blank-middle" ? "blank-middle" : "two-page",
			stage: a.stage === "poll" || a.stage === "result" ? a.stage : "submit",
			shape: replyShape(a.shape, { reduced: true, ...(options.allowed ? { allowed: options.allowed } : {}), ...(a.stage === "poll" && options.statusPointer !== undefined ? { statusPointer: options.statusPointer } : {}) }),
		})),
	};
}
