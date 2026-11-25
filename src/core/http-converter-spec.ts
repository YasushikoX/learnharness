import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { MATERIAL_MAX_BYTES } from "./materials.ts";
import { PDF_MAX_PAGES } from "./pdf-converter.ts";
import { normalizeBaseUrl } from "./settings.ts";

/**
 * Declarative HTTP converter profiles (fork addition, 2026-11-25). Pure, browser-safe.
 *
 * A PDF service that is not built in is described by a PROFILE: data, not code. The host's interpreter
 * (src/server/converters/http-declarative.ts) reads it and makes the requests itself; nothing in a profile is ever
 * executed. Hosted services ship as bundled profiles (src/server/converters/presets.ts); a user's own profile is a
 * JSON file in `<dataDir>/converters/<id>.json` (src/server/converters/custom-profiles.ts), validated on every load.
 *
 * The only ways a profile refers to data:
 *   - JSON Pointer (RFC 6901) into a JSON answer or into the JSON request body. No expression language.
 *   - three named placeholders, each allowed in fixed places only:
 *       {{API_KEY}}    the credential, only in `auth.value` (the one header that carries it);
 *       {{JOB_ID}}     the job id read from the submit answer, only in `poll.path` and `result.path`;
 *       {{DELIMITER}}  a random per-job page delimiter, only in submit body fields, and only when
 *                      `extract.delimiter` is `{ "random": true }`.
 *   Any other `{{` anywhere is refused.
 *
 * Every path is relative to the configured base URL and must stay under it (same origin, below the base path; no
 * scheme, `//`, `\`, dot segments or fragment), so a profile cannot send a PDF or a key anywhere else. The
 * interpreter checks each built URL again before its request.
 *
 * A profile is untrusted input (an import, a file on disk, later a draft an AI wrote from a web page), so:
 *   - only a BUNDLED preset may name its service address (`defaultBaseUrl`); every other profile is refused when it
 *     has one, because its destination must be the address the user types in Settings;
 *   - its size (64 KB, measured on its canonical JSON), nesting depth and node count are checked iteratively before
 *     anything walks it recursively;
 *   - header names and values are checked for what fetch would refuse, and credential headers (Authorization,
 *     Cookie, Proxy-Authorization) can never be fixed headers.
 *
 * validateHttpConverterProfile is the one gate (presets, files on disk, an import, the later AI wizard).
 */

export const HTTP_CONVERTER_PROFILE_FORMAT = "learnharness.http-converter/1";
/** A profile's own id (a custom profile's file name without `.json`). */
export const CONVERTER_PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
/** The settings id of a user's own profile: `custom:<id>` (presets and built-ins use their bare id). */
export const CUSTOM_CONVERTER_PREFIX = "custom:";
/** The largest profile accepted (a file on disk or an import). */
export const HTTP_CONVERTER_PROFILE_MAX_BYTES = 64 * 1024;
/** The deepest nesting a profile may have (objects and arrays), checked before any recursive walk. */
export const HTTP_CONVERTER_PROFILE_MAX_DEPTH = 32;
/** The most values (objects, arrays, strings, numbers, …) a profile may hold, checked before any recursive walk. */
export const HTTP_CONVERTER_PROFILE_MAX_NODES = 2_000;
export const POLL_MIN_INTERVAL_MS = 500;
export const POLL_MAX_INTERVAL_MS = 60_000;
export const POLL_DEFAULT_INTERVAL_MS = 2_000;
export const POLL_MAX_COUNT = 2_000;

export const PLACEHOLDERS = ["API_KEY", "JOB_ID", "DELIMITER"] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

export function customConverterId(profileId: string): string {
	return `${CUSTOM_CONVERTER_PREFIX}${profileId}`;
}

/** The profile id inside a `custom:<id>` converter id, or undefined. */
export function customProfileIdOf(converterId: string): string | undefined {
	if (!converterId.startsWith(CUSTOM_CONVERTER_PREFIX)) return undefined;
	const id = converterId.slice(CUSTOM_CONVERTER_PREFIX.length);
	return CONVERTER_PROFILE_ID_PATTERN.test(id) ? id : undefined;
}

const nonBlank = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const pointer = Type.String({ maxLength: 500 });
const scalar = Type.Union([Type.String({ maxLength: 200 }), Type.Number(), Type.Boolean()]);
const SUBMIT_METHOD = Type.Union([Type.Literal("POST"), Type.Literal("PUT")]);
const FETCH_METHOD = Type.Union([Type.Literal("GET"), Type.Literal("POST")]);
const strict = { additionalProperties: false } as const;

const MULTIPART_BODY = Type.Object(
	{
		type: Type.Literal("multipart"),
		/** The form field that carries the PDF (sent as a file, application/pdf, with its file name). */
		fileField: nonBlank(100),
		/** Fixed form fields; an array sends the field once per value. */
		fields: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String({ maxLength: 2000 }), Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 50 })]))),
	},
	strict,
);

const JSON_BASE64_BODY = Type.Object(
	{
		type: Type.Literal("json-base64"),
		/** Where in the JSON body the PDF goes. */
		filePointer: pointer,
		/** "base64": the bare base64 text; "data-url": `data:application/pdf;base64,<base64>`. */
		encoding: Type.Union([Type.Literal("base64"), Type.Literal("data-url")]),
		/** The fixed rest of the JSON body. */
		json: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	},
	strict,
);

const SUBMIT = Type.Object(
	{
		method: SUBMIT_METHOD,
		path: nonBlank(500),
		/** Fixed headers, sent with every request of the job (submit, poll, result). */
		headers: Type.Optional(Type.Record(Type.String(), Type.String({ maxLength: 1024 }))),
		body: Type.Union([MULTIPART_BODY, JSON_BASE64_BODY]),
	},
	strict,
);

const POLL = Type.Object(
	{
		/** The job id in the submit answer. */
		jobIdPointer: pointer,
		method: Type.Optional(FETCH_METHOD),
		/** Must contain {{JOB_ID}}. */
		path: nonBlank(500),
		/** The job's state in a poll answer, compared with the three lists below. */
		statusPointer: pointer,
		done: Type.Array(scalar, { minItems: 1, maxItems: 20 }),
		running: Type.Array(scalar, { minItems: 1, maxItems: 20 }),
		failed: Type.Optional(Type.Array(scalar, { maxItems: 20 })),
		/** The service's own failure message in a poll answer (a string). */
		errorPointer: Type.Optional(pointer),
		intervalMs: Type.Optional(Type.Integer({ minimum: POLL_MIN_INTERVAL_MS, maximum: POLL_MAX_INTERVAL_MS })),
		maxPolls: Type.Optional(Type.Integer({ minimum: 1, maximum: POLL_MAX_COUNT })),
	},
	strict,
);

const RESULT = Type.Object(
	{
		method: Type.Optional(FETCH_METHOD),
		/** May contain {{JOB_ID}}. */
		path: nonBlank(500),
	},
	strict,
);

const EXTRACT_PAGES = Type.Object(
	{
		type: Type.Literal("pages"),
		/** The array of pages in the final answer. */
		pagesPointer: pointer,
		/** Inside one page: its number or index (an integer, or a string of digits). */
		numberPointer: pointer,
		/** 0 when the service counts pages from 0, 1 when from 1. */
		numberBase: Type.Union([Type.Literal(0), Type.Literal(1)]),
		/** Inside one page: its Markdown text. */
		markdownPointer: pointer,
	},
	strict,
);

const EXTRACT_DELIMITED = Type.Object(
	{
		type: Type.Literal("delimited"),
		/** The one Markdown string in the final answer. */
		markdownPointer: pointer,
		/** A fixed separator the service writes, or a random one the host makes per job and sends as {{DELIMITER}}. */
		delimiter: Type.Union([Type.Object({ literal: nonBlank(200) }, strict), Type.Object({ random: Type.Literal(true) }, strict)]),
		/** Where the service writes it: between pages (default), after every page, or before every page. */
		placement: Type.Optional(Type.Union([Type.Literal("between"), Type.Literal("after"), Type.Literal("before")])),
	},
	strict,
);

export const HTTP_CONVERTER_PROFILE_SCHEMA = Type.Object(
	{
		format: Type.Literal(HTTP_CONVERTER_PROFILE_FORMAT),
		id: Type.String({ pattern: CONVERTER_PROFILE_ID_PATTERN.source }),
		name: nonBlank(80),
		version: Type.String({ pattern: "^[A-Za-z0-9._+-]{1,40}$" }),
		description: Type.Optional(Type.String({ maxLength: 500 })),
		/** Shown in Settings; never fetched by the interpreter. */
		docsUrl: Type.Optional(Type.String({ maxLength: 500 })),
		/**
		 * BUNDLED PRESETS ONLY: the hosted service's address, offered in Settings and saved as the service URL once the
		 * user chooses the preset. Any other profile that has it is refused (its address is entered in Settings).
		 */
		defaultBaseUrl: Type.Optional(Type.String({ maxLength: 500 })),
		/** Written from documentation without a real call; Settings says so. */
		unverified: Type.Optional(Type.Boolean()),
		/** The one header that carries the credential. Absent: the service takes no key. */
		auth: Type.Optional(Type.Object({ header: nonBlank(100), value: nonBlank(300) }, strict)),
		/** The service's own limits, when known (the app's own are lower bounds on neither). */
		limits: Type.Optional(
			Type.Object(
				{
					maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: MATERIAL_MAX_BYTES })),
					maxPages: Type.Optional(Type.Integer({ minimum: 1, maximum: PDF_MAX_PAGES })),
				},
				strict,
			),
		),
		submit: SUBMIT,
		poll: Type.Optional(POLL),
		result: Type.Optional(RESULT),
		extract: Type.Union([EXTRACT_PAGES, EXTRACT_DELIMITED]),
	},
	strict,
);

export type HttpConverterProfile = Static<typeof HTTP_CONVERTER_PROFILE_SCHEMA>;

export type ProfileValidation = { ok: true; profile: HttpConverterProfile } | { ok: false; errors: string[] };

export interface ProfileValidationOptions {
	/** A profile bundled with the app (presets.ts): the only kind that may carry `defaultBaseUrl`. Default false. */
	bundled?: boolean;
}

const MAX_ERRORS = 12;

// ── JSON Pointer (RFC 6901) ────────────────────────────────────────────────

const POINTER_PATTERN = /^(?:\/(?:[^~/]|~[01])*)*$/;

export function isJsonPointer(value: string): boolean {
	return POINTER_PATTERN.test(value);
}

function pointerTokens(ptr: string): string[] {
	if (!isJsonPointer(ptr)) throw new Error(`Not a JSON Pointer: ${ptr}`);
	return ptr === "" ? [] : ptr.slice(1).split("/").map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
}

const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/;

/** The value at `ptr` in `doc`, or undefined when there is none. */
export function jsonPointerGet(doc: unknown, ptr: string): unknown {
	let node: unknown = doc;
	for (const token of pointerTokens(ptr)) {
		if (Array.isArray(node)) {
			if (!ARRAY_INDEX.test(token)) return undefined;
			node = node[Number(token)];
		} else if (node !== null && typeof node === "object") {
			node = Object.hasOwn(node, token) ? (node as Record<string, unknown>)[token] : undefined;
		} else {
			return undefined;
		}
		if (node === undefined) return undefined;
	}
	return node;
}

/**
 * Set `value` at `ptr` inside the object `doc` (mutated), creating objects on the way. Refuses to replace an
 * existing value, to step through a non-object, or to write into an array: a profile's fixed JSON and the PDF's
 * place cannot overlap.
 */
export function jsonPointerSet(doc: Record<string, unknown>, ptr: string, value: unknown): void {
	const tokens = pointerTokens(ptr);
	if (tokens.length === 0) throw new Error("The PDF cannot replace the whole JSON body");
	let node: Record<string, unknown> = doc;
	for (const [i, token] of tokens.entries()) {
		const last = i === tokens.length - 1;
		if (token === "__proto__" || token === "constructor" || token === "prototype") throw new Error(`JSON Pointer ${ptr} uses a reserved name`);
		const existing = Object.hasOwn(node, token) ? node[token] : undefined;
		if (last) {
			if (existing !== undefined) throw new Error(`JSON Pointer ${ptr} names a fixed field of the body`);
			Object.defineProperty(node, token, { value, enumerable: true, configurable: true, writable: true });
			return;
		}
		if (existing === undefined) {
			const child: Record<string, unknown> = {};
			Object.defineProperty(node, token, { value: child, enumerable: true, configurable: true, writable: true });
			node = child;
		} else if (existing !== null && typeof existing === "object" && !Array.isArray(existing)) {
			node = existing as Record<string, unknown>;
		} else {
			throw new Error(`JSON Pointer ${ptr} goes through a field that is not an object`);
		}
	}
}

// ── Placeholders ───────────────────────────────────────────────────────────

const PLACEHOLDER_ANY = /\{\{([^{}]*)\}\}/g;

/** The placeholder names a string uses; a stray `{{` or `}}` comes back as "{{". */
export function placeholdersIn(text: string): string[] {
	const names = [...text.matchAll(PLACEHOLDER_ANY)].map((m) => m[1]!);
	const rest = text.replace(PLACEHOLDER_ANY, "");
	if (rest.includes("{{") || rest.includes("}}")) names.push("{{");
	return names;
}

export function fillPlaceholders(text: string, values: Partial<Record<Placeholder, string>>): string {
	return text.replace(PLACEHOLDER_ANY, (whole, name: string) => {
		const value = values[name as Placeholder];
		if (value === undefined) throw new Error(`No value for placeholder ${whole}`);
		return value;
	});
}

// ── Paths under the base URL ───────────────────────────────────────────────

const PATH_CHARS = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/%?{}]*$/;

/** Why a path template cannot be used, or undefined when it can (pure). */
export function pathProblem(template: string, allowed: readonly Placeholder[]): string | undefined {
	if (!template.startsWith("/")) return "must start with / (it is relative to the base URL)";
	if (template.startsWith("//") || template.includes("\\")) return "must not name another host";
	if (!PATH_CHARS.test(template)) return "contains characters that are not allowed in a URL path";
	const names = placeholdersIn(template);
	const bad = names.find((name) => !(allowed as readonly string[]).includes(name));
	if (bad) return bad === "{{" ? "has an unmatched {{ or }}" : `uses {{${bad}}}, which is not allowed here`;
	const pathPart = template.split("?")[0]!.replace(PLACEHOLDER_ANY, "x");
	if (pathPart.includes("//")) return "must not contain //";
	for (const segment of pathPart.split("/")) {
		const decoded = segment.replace(/%2e/gi, ".");
		if (decoded === "." || decoded === "..") return "must not contain . or .. segments";
		if (/%2f|%5c/i.test(segment)) return "must not contain an encoded / or \\";
	}
	return undefined;
}

/**
 * The absolute URL of `template` under `baseUrl` (a normalised base URL), with {{JOB_ID}} filled in (URL-encoded).
 * Throws when the result leaves the base URL's origin or path; the interpreter calls this before every request.
 */
export function profileUrl(baseUrl: string, template: string, jobId?: string): string {
	const problem = pathProblem(template, ["JOB_ID"]);
	if (problem) throw new Error(`The path ${template} ${problem}`);
	if (jobId !== undefined && (jobId === "" || jobId === "." || jobId === ".." || jobId.length > 512)) throw new Error("The service returned a job id that cannot be used in a URL");
	const filled = template.includes("{{") ? fillPlaceholders(template, jobId === undefined ? {} : { JOB_ID: encodeURIComponent(jobId) }) : template;
	const base = new URL(baseUrl);
	const url = new URL(`${baseUrl.replace(/\/+$/, "")}${filled}`);
	const basePath = base.pathname.replace(/\/+$/, "");
	if (url.origin !== base.origin || !(url.pathname === basePath || url.pathname.startsWith(`${basePath}/`)) || url.username || url.password || url.hash) {
		throw new Error(`The path ${template} leaves ${base.origin}${basePath}`);
	}
	return url.toString();
}

// ── Headers ────────────────────────────────────────────────────────────────

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
/** Set by the host itself, never sent to a service, or names that mean something to a JavaScript object. */
const RESERVED_HEADERS = new Set([
	"host", "content-length", "content-type", "transfer-encoding", "connection", "cookie", "keep-alive", "upgrade", "te", "trailer", "proxy-authorization", "origin", "referer",
	"__proto__", "constructor", "prototype",
]);
/** Credentials: never a fixed header of a profile (Authorization only through `auth`). */
const CREDENTIAL_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);

/**
 * Why a value cannot be sent as an HTTP header value, or undefined (pure). Control characters (line breaks, tab, DEL,
 * …) and characters outside Latin-1 are refused: fetch would throw on them, and that must never read as an
 * unreachable service.
 */
export function headerValueProblem(value: string): string | undefined {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 0x20 || code === 0x7f) return "contains a control character (a line break, tab or similar)";
		if (code > 0xff) return "contains a character that cannot be sent in an HTTP header (only Latin-1 letters, digits and symbols)";
	}
	return undefined;
}

function headerProblem(name: string, value: string): string | undefined {
	if (!HEADER_NAME.test(name)) return `header name ${JSON.stringify(name)} is not a valid HTTP header name`;
	if (RESERVED_HEADERS.has(name.toLowerCase())) return `header ${name} is set by the app and cannot be set by a profile`;
	const problem = headerValueProblem(value);
	if (problem) return `header ${name}'s value ${problem}`;
	return undefined;
}

// ── Size and shape, before any recursive walk ──────────────────────────────

/** Why a parsed value is too deep or too large to walk, or undefined. Iterative: never recurses (pure). */
export function profileShapeProblem(value: unknown): string | undefined {
	const stack: [unknown, number][] = [[value, 1]];
	let nodes = 1;
	while (stack.length) {
		const [node, depth] = stack.pop()!;
		if (node === null || typeof node !== "object") continue;
		if (depth > HTTP_CONVERTER_PROFILE_MAX_DEPTH) return `A profile is nested at most ${HTTP_CONVERTER_PROFILE_MAX_DEPTH} levels deep`;
		for (const child of Array.isArray(node) ? node : Object.values(node)) {
			if (++nodes > HTTP_CONVERTER_PROFILE_MAX_NODES) return `A profile holds at most ${HTTP_CONVERTER_PROFILE_MAX_NODES} values`;
			stack.push([child, depth + 1]);
		}
	}
	return undefined;
}

/** The size of a profile's canonical serialisation (compact JSON, UTF-8), as stored and counted against the cap. */
export function canonicalProfileBytes(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value) ?? "").byteLength;
}

// ── The validator ──────────────────────────────────────────────────────────

function walkStrings(value: unknown, at: string, visit: (text: string, at: string) => void): void {
	if (typeof value === "string") visit(value, at);
	else if (Array.isArray(value)) value.forEach((item, i) => walkStrings(item, `${at}/${i}`, visit));
	else if (value !== null && typeof value === "object") for (const [key, item] of Object.entries(value)) {
		walkStrings(key, `${at}/${key}(name)`, visit);
		walkStrings(item, `${at}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`, visit);
	}
}

/** Where each placeholder may appear, by the location of the string (a JSON Pointer into the profile). */
function allowedPlaceholders(at: string, randomDelimiter: boolean): readonly Placeholder[] {
	if (at === "/auth/value") return ["API_KEY"];
	if (at === "/poll/path" || at === "/result/path") return ["JOB_ID"];
	if (randomDelimiter && !at.endsWith("(name)") && (/^\/submit\/body\/fields\/[^/]+(?:\/\d+)?$/.test(at) || at.startsWith("/submit/body/json/"))) return ["DELIMITER"];
	return [];
}

function semanticProblems(p: HttpConverterProfile, bundled: boolean): string[] {
	const errors: string[] = [];
	const randomDelimiter = p.extract.type === "delimited" && "random" in p.extract.delimiter;
	const seen = new Map<Placeholder, string[]>();
	walkStrings(p, "", (text, at) => {
		for (const name of placeholdersIn(text)) {
			if (name === "{{") errors.push(`${at}: has an unmatched {{ or }}`);
			else if (!(PLACEHOLDERS as readonly string[]).includes(name)) errors.push(`${at}: {{${name}}} is not a known placeholder (only {{API_KEY}}, {{JOB_ID}} and {{DELIMITER}})`);
			else if (!allowedPlaceholders(at, randomDelimiter).includes(name as Placeholder)) errors.push(`${at}: {{${name}}} is not allowed here`);
			else seen.set(name as Placeholder, [...(seen.get(name as Placeholder) ?? []), at]);
		}
	});

	if (p.defaultBaseUrl !== undefined) {
		if (!bundled) errors.push("/defaultBaseUrl: a profile you import cannot name its service address; remove defaultBaseUrl and enter the address in Settings → PDF conversion after importing");
		else if (normalizeBaseUrl(p.defaultBaseUrl) !== p.defaultBaseUrl) errors.push("/defaultBaseUrl: must be a canonical absolute HTTP(S) URL without credentials, query, fragment or trailing slash");
	}
	if (p.docsUrl !== undefined && !/^https?:\/\/[^\s]+$/.test(p.docsUrl)) errors.push("/docsUrl: must be an http(s) URL");

	if (p.auth) {
		const problem = headerProblem(p.auth.header, p.auth.value);
		if (problem) errors.push(`/auth/header: ${problem}`);
		else if (p.auth.header.toLowerCase() === "cookie" || p.auth.header.toLowerCase() === "proxy-authorization") errors.push(`/auth/header: ${p.auth.header} cannot carry the key`);
		if (!seen.get("API_KEY")?.includes("/auth/value")) errors.push("/auth/value: must contain {{API_KEY}}");
	}

	const paths: [string, string, readonly Placeholder[]][] = [["/submit/path", p.submit.path, []]];
	if (p.poll) paths.push(["/poll/path", p.poll.path, ["JOB_ID"]]);
	if (p.result) paths.push(["/result/path", p.result.path, ["JOB_ID"]]);
	for (const [at, template, allowed] of paths) {
		const problem = pathProblem(template, allowed);
		if (problem) errors.push(`${at}: ${problem}`);
		else {
			try {
				profileUrl("https://base.invalid/root", template, "job");
			} catch (error) {
				errors.push(`${at}: ${(error as Error).message}`);
			}
		}
	}
	if (p.poll && !seen.get("JOB_ID")?.includes("/poll/path")) errors.push("/poll/path: must contain {{JOB_ID}}");
	if (p.result && !p.poll) errors.push("/result: a separate result request needs a poll section (it uses the job id)");

	for (const [name, value] of Object.entries(p.submit.headers ?? {})) {
		const problem = headerProblem(name, value);
		if (problem) errors.push(`/submit/headers: ${problem}`);
		if (p.auth && name.toLowerCase() === p.auth.header.toLowerCase()) errors.push(`/submit/headers: ${name} is the credential header; it is set from auth only`);
		else if (CREDENTIAL_HEADERS.has(name.toLowerCase())) errors.push(`/submit/headers: ${name} carries credentials and can never be a fixed header (a key goes in auth)`);
	}

	const pointers: [string, string][] = [];
	const body = p.submit.body;
	if (body.type === "multipart") {
		const formName = /^[^"\r\n\0]{1,100}$/;
		if (!formName.test(body.fileField)) errors.push("/submit/body/fileField: not a valid form field name");
		for (const name of Object.keys(body.fields ?? {})) {
			if (!formName.test(name)) errors.push(`/submit/body/fields: ${JSON.stringify(name)} is not a valid form field name`);
			if (name === body.fileField) errors.push(`/submit/body/fields: ${name} is the file field`);
		}
	} else {
		pointers.push(["/submit/body/filePointer", body.filePointer]);
		if (isJsonPointer(body.filePointer)) {
			try {
				jsonPointerSet(structuredClone(body.json ?? {}), body.filePointer, "");
			} catch (error) {
				errors.push(`/submit/body/filePointer: ${(error as Error).message}`);
			}
		}
	}
	if (p.poll) {
		pointers.push(["/poll/jobIdPointer", p.poll.jobIdPointer], ["/poll/statusPointer", p.poll.statusPointer]);
		if (p.poll.errorPointer !== undefined) pointers.push(["/poll/errorPointer", p.poll.errorPointer]);
		const lists = [p.poll.done, p.poll.running, p.poll.failed ?? []];
		const all = lists.flat().map((v) => JSON.stringify(v));
		if (new Set(all).size !== all.length) errors.push("/poll: a status value is listed twice (done, running and failed must not overlap)");
	}
	if (p.extract.type === "pages") {
		pointers.push(["/extract/pagesPointer", p.extract.pagesPointer], ["/extract/numberPointer", p.extract.numberPointer], ["/extract/markdownPointer", p.extract.markdownPointer]);
	} else {
		pointers.push(["/extract/markdownPointer", p.extract.markdownPointer]);
		if (randomDelimiter && !seen.get("DELIMITER")?.length) errors.push("/extract/delimiter: a random delimiter must be sent to the service as {{DELIMITER}} in a submit body field");
		if ("literal" in p.extract.delimiter && !p.extract.delimiter.literal.trim() && p.extract.delimiter.literal !== "\f") errors.push("/extract/delimiter/literal: a delimiter of only spaces or line breaks would split ordinary text");
	}
	for (const [at, ptr] of pointers) if (!isJsonPointer(ptr)) errors.push(`${at}: ${JSON.stringify(ptr)} is not a JSON Pointer (use "" or "/name/0/other", with ~0 for ~ and ~1 for /)`);
	return errors;
}

/**
 * Validate a parsed profile: depth, node count and size first (iteratively), then shape (unknown fields refused),
 * then every rule above. Pure; never throws for any JSON value.
 */
export function validateHttpConverterProfile(value: unknown, options: ProfileValidationOptions = {}): ProfileValidation {
	const shape = profileShapeProblem(value);
	if (shape) return { ok: false, errors: [shape] };
	if (canonicalProfileBytes(value) > HTTP_CONVERTER_PROFILE_MAX_BYTES) return { ok: false, errors: [`A profile is at most ${HTTP_CONVERTER_PROFILE_MAX_BYTES / 1024} KB`] };
	if (!Value.Check(HTTP_CONVERTER_PROFILE_SCHEMA, value)) {
		const errors = [...Value.Errors(HTTP_CONVERTER_PROFILE_SCHEMA, value)]
			.map((e) => {
				const extra = (e.params as { additionalProperties?: string[] } | undefined)?.additionalProperties;
				return `${e.instancePath || "/"}: ${e.message}${extra?.length ? ` (${extra.join(", ")})` : ""}`;
			});
		return { ok: false, errors: [...new Set(errors)].slice(0, MAX_ERRORS) };
	}
	const profile = structuredClone(value);
	const errors = semanticProblems(profile, options.bundled === true);
	return errors.length ? { ok: false, errors: errors.slice(0, MAX_ERRORS) } : { ok: true, profile };
}

/** Parse and validate profile text (a file or a paste). Pure. */
export function parseHttpConverterProfile(text: string, options: ProfileValidationOptions = {}): ProfileValidation {
	if (new TextEncoder().encode(text).byteLength > HTTP_CONVERTER_PROFILE_MAX_BYTES) return { ok: false, errors: [`A profile is at most ${HTTP_CONVERTER_PROFILE_MAX_BYTES / 1024} KB`] };
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return { ok: false, errors: [`Not valid JSON: ${(error as Error).message}`] };
	}
	return validateHttpConverterProfile(value, options);
}

/** The origin of a saved service URL; undefined when there is none. */
export function serviceOrigin(baseUrl: string | undefined): string | undefined {
	const canonical = normalizeBaseUrl(baseUrl ?? "");
	return canonical ? new URL(canonical).origin : undefined;
}

/** Whether two service URLs are the same once canonicalised (an absent or invalid URL equals only another one). */
export function sameServiceUrl(a: string | undefined, b: string | undefined): boolean {
	return normalizeBaseUrl(a ?? "") === normalizeBaseUrl(b ?? "");
}
