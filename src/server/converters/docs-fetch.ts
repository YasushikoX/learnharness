import { isIP } from "node:net";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import type { Agent } from "undici";
import { boundText, cleanText, DRAFT_DOCS_MAX_CHARS } from "../../core/converter-draft.ts";
import { createAddressCheckedAgent, isPublicAddress, safeFetch } from "../../agent/tools/safe-fetch.ts";

/**
 * The connector wizard's ONE outbound request of its own (fork addition, 2026-11-25): the documentation page the user
 * typed, fetched once by the app after they press the button that says so. Never on the model's say-so (the model
 * gets no tool and no URL it writes is fetched).
 *
 *   - public addresses only, checked on the address each connection actually reaches (the researcher's guarded fetch,
 *     agent/tools/safe-fetch.ts: after DNS, before any request byte, so DNS rebinding is covered), and before any
 *     connection for an address literal or a name that is local by convention (localhost, *.local, a name without a
 *     dot): documentation is public; for a private page the user pastes the text instead;
 *   - redirects followed by the app itself, at most DOCS_MAX_REDIRECTS, and only on the same site: the same host (or
 *     the same host with or without "www."), the same port, and the same scheme or http → https; each hop through the
 *     same address check;
 *   - DOCS_MAX_BYTES at most (declared and actual), DOCS_FETCH_TIMEOUT_MS for the whole fetch, text and HTML only;
 *   - no cookies, no credentials, no Referer: a plain GET with an Accept header.
 *
 * The page is reduced to text before the model sees it (`reduceHtml`): scripts, styles, hidden elements, comments,
 * forms, images and link targets are dropped; then the text is bounded (DRAFT_DOCS_MAX_CHARS), and the caller tells
 * the user when it was cut.
 */

export const DOCS_FETCH_TIMEOUT_MS = 15_000;
export const DOCS_MAX_BYTES = 2 * 1024 * 1024;
export const DOCS_MAX_REDIRECTS = 3;
const TEXT_TYPES = new Set(["text/html", "application/xhtml+xml", "text/plain", "text/markdown", "text/x-markdown"]);
const PASTE = "Paste the documentation's text into the box instead.";

export type DocsFetchErrorKind = "address" | "redirect" | "too_large" | "content_type" | "http" | "timeout" | "network" | "empty";

export class DocsFetchError extends Error {
	constructor(
		public readonly kind: DocsFetchErrorKind,
		message: string,
	) {
		super(message);
	}
}

export interface FetchedDocs {
	/** The address the text came from (after same-site redirects). */
	url: string;
	host: string;
	text: string;
	/** The page's text before it was bounded. */
	totalChars: number;
	cut: boolean;
	contentType: string;
}

export interface DocsFetchOptions {
	signal?: AbortSignal;
	/** Tests: an agent with its own address rule and DNS (production: public addresses only). */
	dispatcher?: Agent;
	timeoutMs?: number;
	maxBytes?: number;
}

const LOCAL_NAME = /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|corp|home\.arpa)$/i;

/** Why a documentation URL is refused before any connection, or undefined (exported for tests). */
export function docsUrlProblem(raw: string): string | undefined {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return "That is not a web address (it must start with https:// or http://).";
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return "The documentation address must start with https:// or http://.";
	if (url.username || url.password) return "The documentation address must not contain a user name or password.";
	const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "");
	if (isIP(host)) {
		if (!isPublicAddress(host)) return `${url.hostname} is a private, loopback or link-local address: the app fetches only public documentation. ${PASTE}`;
		return undefined;
	}
	if (!host.includes(".") || LOCAL_NAME.test(host)) return `${url.hostname} is a local name: the app fetches only public documentation. ${PASTE}`;
	return undefined;
}

/** Whether a redirect from `from` to `to` stays on the same site (pure; exported for tests). */
export function sameSite(from: URL, to: URL): boolean {
	const bare = (h: string) => h.toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");
	if (bare(from.hostname) !== bare(to.hostname)) return false;
	if (from.protocol === "https:" && to.protocol !== "https:") return false;
	if (to.protocol !== "https:" && to.protocol !== "http:") return false;
	return from.protocol === to.protocol ? from.port === to.port : from.port === "" && to.port === "";
}

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
turndown.remove(["script", "style", "noscript", "template", "iframe", "object", "embed", "canvas", "img", "picture", "video", "audio", "form", "button", "input", "select", "textarea"]);
// a link is its text: the address it points at is never fetched, and the model does not need it
turndown.addRule("linkText", { filter: "a", replacement: (content) => content });

const DROP = "script, style, noscript, template, iframe, object, embed, svg, canvas, head, link, meta, nav, form, button, input, select, textarea, img, picture, video, audio";
const HIDDEN_STYLE = /(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?![.\d])|opacity\s*:\s*0(?![.\d]))/i;

/** HTML reduced to the text a reader sees, as Markdown (headings, lists, code blocks kept; links as their text). */
export function reduceHtml(html: string): string {
	const { document } = parseHTML(html);
	for (const el of [...document.querySelectorAll(DROP)]) el.remove();
	for (const el of [...document.querySelectorAll("[hidden], [aria-hidden='true'], [style]")]) {
		if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true" || HIDDEN_STYLE.test(el.getAttribute("style") ?? "")) el.remove();
	}
	const body = document.querySelector("body") ?? document.documentElement;
	const markdown = body ? turndown.turndown((body as unknown as { innerHTML: string }).innerHTML ?? "") : "";
	return tidy(markdown);
}

function tidy(text: string): string {
	return cleanText(text).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

let publicOnly: Agent | undefined;

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
	const declared = Number(response.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > maxBytes) {
		await response.body?.cancel().catch(() => {});
		throw new DocsFetchError("too_large", `The page is larger than ${Math.round(maxBytes / 1024 / 1024)} MB. ${PASTE}`);
	}
	const reader = response.body?.getReader();
	if (!reader) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => {});
			throw new DocsFetchError("too_large", `The page is larger than ${Math.round(maxBytes / 1024 / 1024)} MB. ${PASTE}`);
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.byteLength;
	}
	return out;
}

function decode(bytes: Uint8Array, contentType: string): string {
	const charset = /charset\s*=\s*"?([\w-]+)/i.exec(contentType)?.[1];
	try {
		return new TextDecoder(charset ?? "utf-8").decode(bytes);
	} catch {
		return new TextDecoder("utf-8").decode(bytes);
	}
}

/** Fetch the documentation page once and reduce it to bounded text. Throws DocsFetchError with a sentence for the user. */
export async function fetchDocsPage(raw: string, options: DocsFetchOptions = {}): Promise<FetchedDocs> {
	const problem = docsUrlProblem(raw);
	if (problem) throw new DocsFetchError("address", problem);
	const dispatcher = options.dispatcher ?? (publicOnly ??= createAddressCheckedAgent());
	const maxBytes = options.maxBytes ?? DOCS_MAX_BYTES;
	const timeoutMs = options.timeoutMs ?? DOCS_FETCH_TIMEOUT_MS;
	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	let url = new URL(raw.trim());
	const first = url;
	try {
		for (let hop = 0; ; hop++) {
			let response: Response;
			try {
				response = await safeFetch(url.toString(), {
					method: "GET",
					redirect: "manual",
					credentials: "omit",
					referrerPolicy: "no-referrer",
					headers: { Accept: "text/html, text/plain, text/markdown;q=0.9", "User-Agent": "LearnHarness (documentation for a PDF converter)" },
					signal,
				}, dispatcher);
			} catch (error) {
				if (options.signal?.aborted) throw error;
				if (timeout.aborted) throw new DocsFetchError("timeout", `The page did not answer within ${Math.round(timeoutMs / 1000)} seconds. ${PASTE}`);
				const message = (error as Error).message ?? "";
				if (/refusing to connect/.test(message)) throw new DocsFetchError("address", `${url.hostname} leads to a private or local address: the app fetches only public documentation. ${PASTE}`);
				throw new DocsFetchError("network", `The page could not be reached (${url.host}). ${PASTE}`);
			}
			if (response.status >= 300 && response.status < 400) {
				await response.body?.cancel().catch(() => {});
				const location = response.headers.get("location");
				let next: URL | undefined;
				try {
					next = location ? new URL(location, url) : undefined;
				} catch {
					next = undefined;
				}
				if (!next) throw new DocsFetchError("redirect", `The page redirects without a usable address. ${PASTE}`);
				if (!sameSite(first, next)) throw new DocsFetchError("redirect", `The page redirects to another site (${next.host}); the app follows redirects only on ${first.host}. Enter the final address yourself if you trust it, or paste the text.`);
				if (hop >= DOCS_MAX_REDIRECTS) throw new DocsFetchError("redirect", `The page redirects more than ${DOCS_MAX_REDIRECTS} times. ${PASTE}`);
				const nextProblem = docsUrlProblem(next.toString());
				if (nextProblem) throw new DocsFetchError("address", nextProblem);
				url = next;
				continue;
			}
			if (!response.ok) {
				await response.body?.cancel().catch(() => {});
				throw new DocsFetchError("http", `The page answered HTTP ${response.status}. ${PASTE}`);
			}
			const contentType = response.headers.get("content-type") ?? "";
			const mime = contentType.split(";")[0]!.trim().toLowerCase();
			if (!TEXT_TYPES.has(mime)) {
				await response.body?.cancel().catch(() => {});
				throw new DocsFetchError("content_type", `The page is ${mime || "of an unknown type"}, not HTML or text. ${PASTE}`);
			}
			const body = decode(await readCapped(response, maxBytes), contentType);
			const text = mime === "text/html" || mime === "application/xhtml+xml" ? reduceHtml(body) : tidy(body);
			if (!text) throw new DocsFetchError("empty", `The page has no readable text (it may be built by JavaScript). ${PASTE}`);
			const bounded = boundText(text, DRAFT_DOCS_MAX_CHARS);
			return { url: url.toString(), host: url.host, text: bounded.text, totalChars: bounded.totalChars, cut: bounded.cut, contentType: mime };
		}
	} catch (error) {
		if (error instanceof DocsFetchError) throw error;
		if (options.signal?.aborted) throw error;
		if (timeout.aborted) throw new DocsFetchError("timeout", `The page did not answer within ${Math.round(timeoutMs / 1000)} seconds. ${PASTE}`);
		throw new DocsFetchError("network", `The page could not be read (${url.host}). ${PASTE}`);
	}
}
