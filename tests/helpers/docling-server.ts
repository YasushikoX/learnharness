/**
 * A loopback stand-in for Docling Serve (tests only; never a real service).
 * Each request is logged when its headers arrive, before its body, so a
 * client that gives up early still shows as one request.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { Socket } from "node:net";
import path from "node:path";

export interface LoggedRequest {
	method: string;
	url: string;
	headers: http.IncomingHttpHeaders;
	/** The request body as latin1 text, once it has arrived. */
	body?: string;
}

export type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string, log: LoggedRequest[]) => void | Promise<void>;

/** Run `run` against a loopback server; the server and every socket are closed afterwards. */
export async function withServer(handler: Handler, run: (baseUrl: string, log: LoggedRequest[]) => Promise<void>): Promise<void> {
	const log: LoggedRequest[] = [];
	const sockets = new Set<Socket>();
	const server = http.createServer((req, res) => {
		const entry: LoggedRequest = { method: req.method ?? "", url: req.url ?? "", headers: req.headers };
		log.push(entry);
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			entry.body = Buffer.concat(chunks).toString("latin1");
			void Promise.resolve(handler(req, res, entry.body, log)).catch((error: unknown) => {
				res.statusCode = 599;
				res.end(String(error));
			});
		});
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	try {
		await run(`http://127.0.0.1:${address.port}`, log);
	} finally {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

/** A base URL nothing listens on (a server opened and closed again). */
export async function closedBaseUrl(): Promise<string> {
	const server = http.createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return `http://127.0.0.1:${address.port}`;
}

/** Every value of one multipart form field. */
export function formFields(body: string, name: string): string[] {
	return body
		.split(`name="${name}"\r\n\r\n`)
		.slice(1)
		.map((part) => part.split("\r\n")[0] ?? "");
}

export const FIXTURES = path.join(import.meta.dirname, "..", "fixtures", "docling");
/** The placeholder the real responses were recorded with. */
export const RECORDED_PLACEHOLDER = "[[LH-PAGE-BREAK]]";

/** A recorded Docling Serve 1.38.2 response (POST /v1/convert/file, md + json): three-full, blank-middle, blank-first-last. */
export function recordedResponse(name: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.response.json`), "utf8")) as Record<string, unknown>;
}

export function recordedPdf(name: string): Uint8Array {
	return new Uint8Array(fs.readFileSync(path.join(FIXTURES, `${name}.pdf`)));
}

export function json(res: http.ServerResponse, body: unknown, status = 200): void {
	res.statusCode = status;
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify(body));
}

export interface FakeDocling {
	handler: Handler;
	/** The page-break placeholder the client sent with its upload. */
	delimiter(): string;
}

/**
 * A Docling Serve that answers every endpoint like the real one: /version, an async upload (pending), one poll
 * (success), then `result` (a recorded response by default) with the recorded placeholder replaced by the client's.
 * `overrides` replace single endpoints.
 */
export function fakeDocling(
	result: Record<string, unknown> | ((delimiter: string) => unknown),
	overrides: Partial<Record<"version" | "upload" | "poll" | "result", Handler>> = {},
): FakeDocling {
	let delimiter = "";
	const handler: Handler = (req, res, body, log) => {
		const url = req.url ?? "";
		if (url === "/version") return (overrides.version ?? ((_q, r) => json(r, { "docling-serve": "1.38.2", docling: "2.61.1", python: "cpython-312" })))(req, res, body, log);
		if (url === "/v1/convert/file/async") {
			delimiter = formFields(body, "md_page_break_placeholder")[0] ?? "";
			return (overrides.upload ?? ((_q, r) => json(r, { task_id: "task 1", task_type: "convert", task_status: "pending" })))(req, res, body, log);
		}
		if (url.startsWith("/v1/status/poll/")) return (overrides.poll ?? ((_q, r) => json(r, { task_id: "task 1", task_type: "convert", task_status: "success" })))(req, res, body, log);
		if (url.startsWith("/v1/result/")) {
			if (overrides.result) return overrides.result(req, res, body, log);
			const value = typeof result === "function" ? result(delimiter) : JSON.parse(JSON.stringify(result).split(RECORDED_PLACEHOLDER).join(delimiter.replace(/"/g, '\\"')));
			return json(res, value);
		}
		json(res, { detail: "Not Found" }, 404);
	};
	return { handler, delimiter: () => delimiter };
}
