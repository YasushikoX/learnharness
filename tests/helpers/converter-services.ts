/**
 * Loopback stand-ins for PDF services described by declarative profiles (tests only; never a real service):
 * a page-array service, a delimiter service, a polling service with a separate result request, and building blocks
 * for each failure mode. Uses the Docling helper's server (every request logged when its headers arrive).
 */
import type http from "node:http";
import { HTTP_CONVERTER_PROFILE_FORMAT, type HttpConverterProfile } from "../../src/core/http-converter-spec.ts";
import { formFields, json, type Handler, type LoggedRequest } from "./docling-server.ts";

export type Route = (req: http.IncomingMessage, res: http.ServerResponse, body: string, log: LoggedRequest[]) => void | Promise<void>;

/** A handler from "METHOD /path" routes (the path without its query); anything else is a 404. */
export function routes(table: Record<string, Route>): Handler {
	return (req, res, body, log) => {
		const route = table[`${req.method} ${(req.url ?? "").split("?")[0]}`];
		if (!route) return json(res, { message: "no such route" }, 404);
		return route(req, res, body, log);
	};
}

export const KEY = "sk-test-0123456789abcdefWXYZ";

/** A multipart page-array service, numbering from `base`, synchronous. */
export function pageArrayProfile(base: 0 | 1 = 1, over: Partial<HttpConverterProfile> = {}): HttpConverterProfile {
	return {
		format: HTTP_CONVERTER_PROFILE_FORMAT,
		id: "pages-svc",
		name: "Pages Service",
		version: "1",
		auth: { header: "X-Api-Key", value: "{{API_KEY}}" },
		submit: { method: "POST", path: "/convert", body: { type: "multipart", fileField: "document", fields: { format: "markdown", flags: ["a", "b"] } } },
		extract: { type: "pages", pagesPointer: "/result/pages", numberPointer: "/n", numberBase: base, markdownPointer: "/text" },
		...over,
	};
}

/** A JSON delimiter service that inserts the per-job random delimiter it is sent. */
export function delimitedProfile(over: Partial<HttpConverterProfile> = {}): HttpConverterProfile {
	return {
		format: HTTP_CONVERTER_PROFILE_FORMAT,
		id: "delim-svc",
		name: "Delimiter Service",
		version: "1",
		auth: { header: "Authorization", value: "Bearer {{API_KEY}}" },
		submit: { method: "POST", path: "/api/convert", body: { type: "json-base64", filePointer: "/file/data", encoding: "base64", json: { page_separator: "{{DELIMITER}}" } } },
		extract: { type: "delimited", markdownPointer: "/markdown", delimiter: { random: true } },
		...over,
	};
}

/** A polling service with a separate result request. */
export function pollingProfile(over: Partial<HttpConverterProfile> = {}): HttpConverterProfile {
	return {
		format: HTTP_CONVERTER_PROFILE_FORMAT,
		id: "poll-svc",
		name: "Polling Service",
		version: "1",
		auth: { header: "X-Api-Key", value: "{{API_KEY}}" },
		submit: { method: "POST", path: "/jobs", body: { type: "multipart", fileField: "file" } },
		poll: { jobIdPointer: "/id", path: "/jobs/{{JOB_ID}}", statusPointer: "/status", done: ["done"], running: ["queued", "running"], failed: ["failed"], errorPointer: "/error", intervalMs: 500 },
		result: { path: "/jobs/{{JOB_ID}}/result" },
		extract: { type: "pages", pagesPointer: "/pages", numberPointer: "/page", numberBase: 1, markdownPointer: "/markdown" },
		...over,
	};
}

/** Answers a page-array service gives for `texts` (one per page), numbered from `base`. */
export const pagesAnswer = (texts: string[], base: 0 | 1 = 1) => ({ result: { pages: texts.map((text, i) => ({ n: i + base, text })) } });

/** The JSON body of a logged request. */
export const bodyJson = (entry: LoggedRequest) => JSON.parse(entry.body ?? "{}") as Record<string, unknown>;

export { formFields, json };
