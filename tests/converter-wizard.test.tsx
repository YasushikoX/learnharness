import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { ConverterEntry, ConvertersOverview, ConverterValidationReport } from "../src/core/converter-settings.ts";
import type { ConverterDraftView, ConverterDraftsOverview } from "../src/core/converter-draft-view.ts";
import { describeProfile, KEY_MASK, sendLine } from "../src/core/converter-draft.ts";
import type { HttpConverterProfile } from "../src/core/http-converter-spec.ts";
import { ConvertersSection } from "../components/settings/converters-section.tsx";

/**
 * The connector wizard (components/settings/converter-wizard.tsx), opened from Settings → PDF conversion and rendered
 * against a fetch stub: its steps and wording, the "what is sent where" line, the plain-words pre-flight with the key
 * masked, Test with its checks (blank page included) and previews, "Ask AI to fix" and "Edit JSON" after a failure,
 * Approve only after a passing Test, the address acknowledgement, "cannot be expressed", and no model configured.
 */

const pdfjs: ConverterEntry = { id: "pdfjs", kind: "builtin", name: "Built-in reader", local: true, ready: true, key: "none", credential: { stored: false } };
const MODEL = "Fixture Strong (fixture)";
const BASE = "https://ocr.acme.example";

const profile = (over: Partial<HttpConverterProfile> = {}): HttpConverterProfile => ({
	format: "learnharness.http-converter/1",
	id: "acme-ocr",
	name: "Acme OCR",
	version: "1",
	auth: { header: "X-Api-Key", value: "{{API_KEY}}" },
	submit: { method: "POST", path: "/convert", body: { type: "multipart", fileField: "document", fields: { format: "markdown" } } },
	extract: { type: "pages", pagesPointer: "/result/pages", numberPointer: "/n", numberBase: 1, markdownPointer: "/text" },
	...over,
});

function report(ok: boolean): ConverterValidationReport {
	return {
		ok,
		converterId: "draft:d0123456789ab",
		checks: [
			{ id: "converted", status: "pass", message: "Acme OCR answered for 2 pages." },
			{ id: "markers", status: "pass", message: "Both pages are present, in order, as valid page-marked Markdown." },
			{ id: "page_1", status: "pass", message: "Page 1 has its own sentence." },
			{ id: "page_2", status: "pass", message: "Page 2 has its own sentence." },
			{ id: "own_pages", status: "pass", message: "Neither page has the other page's sentence." },
			ok ? { id: "blank_page", status: "pass", message: "A blank middle page stays blank and the page after it keeps its own text." } : { id: "blank_page", status: "fail", message: "With a blank middle page, it reported 2 pages instead of 3. This converter cannot place a blank page." },
			{ id: "no_secret", status: "pass", message: "The API key does not appear in the answer." },
		],
		pages: [{ page: 1, text: "The heron counted seven lanterns on the north bridge." }, { page: 2, text: "A violet kettle hummed beside the copper map." }],
		warnings: [],
		durationMs: 12,
	};
}

function draft(over: Partial<ConverterDraftView> & { profile?: HttpConverterProfile } = {}): ConverterDraftView {
	const p = over.profile ?? profile();
	const baseUrl = "baseUrl" in over ? over.baseUrl : undefined;
	const credential = over.credential ?? { stored: false };
	const { profile: _p, ...rest } = over;
	return {
		id: "d0123456789ab",
		converterId: "draft:d0123456789ab",
		serviceName: "Acme OCR",
		source: "url",
		docsUrl: "https://docs.acme.example/api",
		docsNotice: "Fetched from docs.acme.example and reduced to 1,234 characters of text.",
		status: "ready",
		profileText: JSON.stringify(p, null, 2),
		errors: [],
		note: "Pages are numbered from 1 in the examples.",
		preflight: describeProfile(p, baseUrl, credential),
		keyNeeded: !!p.auth,
		credential,
		shown: "a".repeat(64),
		approvable: false,
		approveBlocked: "Enter the service URL first.",
		modelCalls: 1,
		createdAt: "2026-11-25T10:00:00.000Z",
		updatedAt: "2026-11-25T10:00:00.000Z",
		...(baseUrl ? { baseUrl, origin: new URL(baseUrl).origin } : {}),
		...rest,
	};
}

const configured = (over: Partial<ConverterDraftView> & { profile?: HttpConverterProfile } = {}) =>
	draft({ baseUrl: BASE, credential: { stored: true, hint: "…WXYZ" }, approveBlocked: "Run Test first.", ...over });

interface Call {
	method: string;
	url: string;
	body: unknown;
}
type Reply = { status?: number; json: unknown };

async function mount(routes: Record<string, (call: Call) => Reply | Promise<Reply>>) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const globals = globalThis as Record<string, unknown>;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	const calls: Call[] = [];
	for (const [key, value] of Object.entries({
		window: dom.window,
		document: dom.document,
		navigator: globals.navigator ?? { userAgent: "", platform: "" },
		HTMLElement: dom.window.HTMLElement,
		Event: dom.window.Event,
		CustomEvent: dom.window.CustomEvent,
		IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string, init?: RequestInit) => {
			const call: Call = { method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined };
			calls.push(call);
			const route = routes[`${call.method} ${url.split("?")[0]}`];
			assert.ok(route, `unexpected request: ${call.method} ${url}`);
			const r = await route(call);
			return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
		},
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	(dom.document as unknown as Record<string, unknown>).oninput = null;
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	await act(async () => {
		root.render(<ConvertersSection />);
	});
	const q = <T extends HTMLElement>(id: string) => document.querySelector<T>(`[data-testid="${id}"]`);
	const all = (id: string) => [...document.querySelectorAll(`[data-testid="${id}"]`)].map((e) => e.textContent ?? "");
	const text = (id: string) => q(id)?.textContent ?? "";
	const click = async (id: string) => {
		await act(async () => {
			q<HTMLButtonElement>(id)!.click();
		});
	};
	const type = async (id: string, value: string) => {
		await act(async () => {
			const input = q<HTMLInputElement>(id)!;
			let proto: object | null = Object.getPrototypeOf(input);
			let setter: ((v: string) => void) | undefined;
			while (proto && !setter) {
				setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
				proto = Object.getPrototypeOf(proto);
			}
			setter!.call(input, value);
			input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
		});
	};
	const disabled = (id: string) => q<HTMLButtonElement>(id)!.hasAttribute("disabled");
	const html = () => document.body.innerHTML;
	const cleanup = () => {
		act(() => root.unmount());
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	};
	return { q, all, text, click, type, disabled, html, calls, cleanup };
}

const section = (converters: ConverterEntry[] = [pdfjs]): ConvertersOverview => ({ selected: "pdfjs", converters, invalidProfiles: [] });
const drafts = (list: ConverterDraftView[] = [], model: string | null = MODEL): ConverterDraftsOverview => ({ model, drafts: list });

describe("Draft with AI: the wizard", () => {
	it("Describe: the steps, and the line that says what is sent where before anything is", async () => {
		const ui = await mount({ "GET /api/converters": () => ({ json: section() }), "GET /api/converters/drafts": () => ({ json: drafts() }) });
		try {
			assert.match(ui.text("converter-wizard-open"), /Draft a connector with AI/);
			await ui.click("converter-wizard-open");
			assert.deepEqual(ui.all("wizard-steps").length, 1);
			assert.equal(ui.text("wizard-steps"), "1 Describe2 Review3 Test4 Approve");
			assert.equal(ui.q("wizard-step-describe")!.getAttribute("data-current"), "true");
			assert.equal(ui.disabled("wizard-draft"), true);
			await ui.type("wizard-name", "Acme OCR");
			await ui.type("wizard-docs-url", "https://docs.acme.example/api/ocr");
			assert.equal(ui.text("wizard-send-line"), "The documentation page is fetched once from docs.acme.example. Its text and the name above are sent to Fixture Strong (fixture). No PDF and no key is sent.");
			assert.equal(ui.text("wizard-send-line"), sendLine({ docsUrl: "https://docs.acme.example/api/ocr", model: MODEL }));
			assert.equal(ui.text("wizard-draft"), "Fetch the page and draft");
			assert.equal(ui.disabled("wizard-draft"), false);
			await ui.click("wizard-source-paste");
			assert.equal(ui.text("wizard-send-line"), "The pasted text and the name above are sent to Fixture Strong (fixture). No PDF and no key is sent.");
			await ui.type("wizard-docs-text", "POST /convert");
			await ui.type("wizard-sample-text", '{"result": {"pages": []}}');
			assert.equal(ui.text("wizard-send-line"), "The pasted text, the sample and the name above are sent to Fixture Strong (fixture). No PDF and no key is sent.");
			assert.equal(ui.text("wizard-draft"), "Draft from the text");
		} finally {
			ui.cleanup();
		}
	});

	it("with no model configured the wizard says so and offers only import", async () => {
		const ui = await mount({ "GET /api/converters": () => ({ json: section() }), "GET /api/converters/drafts": () => ({ json: drafts([], null) }) });
		try {
			await ui.click("converter-wizard-open");
			assert.match(ui.text("wizard-no-model"), /^No model is configured for drafting .* You can still import a profile below\.$/);
			assert.equal(ui.q("wizard-draft"), null);
			assert.ok(ui.q("converter-import"), "the import is still there");
		} finally {
			ui.cleanup();
		}
	});

	it("Review: the profile in plain words with the user's origin, the key masked, the JSON behind a disclosure; Test after URL and key", async () => {
		let current = draft();
		const ui = await mount({
			"GET /api/converters": () => ({ json: section() }),
			"GET /api/converters/drafts": () => ({ json: drafts() }),
			"POST /api/converters/drafts": () => ({ json: current }),
			"PUT /api/converters/drafts": (call) => {
				const body = call.body as { baseUrl?: string; apiKey?: string };
				current = body.apiKey ? configured() : draft({ baseUrl: body.baseUrl, approveBlocked: "Save its API key first." });
				return { json: current };
			},
		});
		try {
			await ui.click("converter-wizard-open");
			await ui.type("wizard-name", "Acme OCR");
			await ui.type("wizard-docs-url", "https://docs.acme.example/api");
			await ui.click("wizard-draft");
			assert.deepEqual(ui.calls.find((c) => c.method === "POST")!.body, { serviceName: "Acme OCR", docsUrl: "https://docs.acme.example/api" });
			assert.equal(ui.q("wizard-step-review")!.getAttribute("data-current"), "true");
			assert.equal(ui.text("wizard-submit"), "POST <your service URL>/convert");
			assert.equal(ui.text("wizard-auth"), `Key header: X-Api-Key: ${KEY_MASK} (your key, never shown)`);
			assert.equal(ui.text("wizard-fixed").startsWith("Sent with every PDF, exactly as written:"), true);
			assert.deepEqual(ui.all("wizard-fixed-value"), [`key header X-Api-Key = ${KEY_MASK}`, "submit method: POST", "submit path: /convert", "submit file field: document", "submit field format = markdown"]);
			assert.equal(ui.all("wizard-fixed-red").length, 0);
			assert.match(ui.text("wizard-pages"), /one entry per PDF page; each entry's page number is at \/n \(counted from 1\)/);
			assert.match(ui.text("wizard-note"), /^From the AI, which read documentation that can be wrong or written to mislead it: Pages are numbered/);
			assert.match(ui.text("wizard-json"), /"pagesPointer": "\/result\/pages"/);
			assert.equal(ui.disabled("wizard-test"), true);
			assert.equal(ui.disabled("wizard-approve"), true);
			assert.equal(ui.text("wizard-approve-note"), "Enter the service URL first.");

			await ui.type("wizard-url", BASE);
			await ui.click("wizard-url-save");
			assert.deepEqual(ui.calls.at(-1)!.body, { id: "d0123456789ab", baseUrl: BASE });
			assert.equal(ui.text("wizard-submit"), `POST ${BASE}/convert`);
			await ui.type("wizard-key", "sk-test-0123456789abcdefWXYZ");
			await ui.click("wizard-key-save");
			assert.equal(ui.text("wizard-auth"), `Key header: X-Api-Key: ${KEY_MASK}WXYZ (your key, never shown)`);
			assert.ok(!ui.html().includes("sk-test-0123456789abcdef"), "the key is never on screen");
			assert.equal(ui.q<HTMLInputElement>("wizard-key")!.value, "");
			assert.equal(ui.disabled("wizard-test"), false);
			assert.match(ui.text("converter-wizard"), /Sends two small test PDFs \(two pages, and three pages with a blank one\) to https:\/\/ocr\.acme\.example and checks each page\./);
		} finally {
			ui.cleanup();
		}
	});

	it("Test: a failure lists every check, the blank page one included, and offers Ask AI to fix and Edit JSON; Approve stays off", async () => {
		const failed = configured({ test: { report: report(false), current: false, stale: false, at: "2026-11-25T10:01:00.000Z" }, approveBlocked: "The Test failed: fix the profile and run Test again." });
		const ui = await mount({
			"GET /api/converters": () => ({ json: section() }),
			"GET /api/converters/drafts": () => ({ json: drafts([configured()]) }),
			"POST /api/converters/drafts/test": () => ({ json: failed }),
			"POST /api/converters/drafts/fix": () => ({ json: configured({ note: "Read the page list at /data/pages." }) }),
		});
		try {
			await ui.click("converter-wizard-open");
			await ui.click("wizard-open-d0123456789ab");
			await ui.click("wizard-test");
			assert.equal(ui.calls.at(-1)!.url, "/api/converters/drafts/test");
			assert.match(ui.text("wizard-report-verdict"), /^Failed/);
			assert.equal(ui.q("wizard-check-blank_page")!.getAttribute("data-status"), "fail");
			assert.match(ui.text("wizard-check-blank_page"), /cannot place a blank page/);
			assert.equal(ui.all("wizard-page-preview").length, 2);
			assert.match(ui.all("wizard-page-preview")[0]!, /^Page 1: The heron counted/);
			assert.equal(ui.disabled("wizard-approve"), true);
			assert.ok(ui.q("wizard-edit-json"));
			assert.match(ui.text("wizard-repair"), /never your key, your service's address, the service's own text or the PDFs' text\) to Fixture Strong \(fixture\), once\./);
			await ui.click("wizard-fix");
			assert.deepEqual(ui.calls.at(-1), { method: "POST", url: "/api/converters/drafts/fix", body: { id: "d0123456789ab" } });
			assert.match(ui.text("wizard-note"), /Read the page list/);
			assert.equal(ui.q("wizard-report"), null);
			await ui.click("wizard-edit-json");
			assert.ok(ui.q("wizard-editor"));
		} finally {
			ui.cleanup();
		}
	});

	it("Approve: only after a passing Test; it makes a profile of your own, shown on the main screen, not in use", async () => {
		const passed = configured({ test: { report: report(true), current: true, stale: false, at: "2026-11-25T10:01:00.000Z" }, approvable: true, approveBlocked: undefined });
		const acme: ConverterEntry = { id: "custom:acme-ocr", kind: "custom", name: "Acme OCR", local: false, baseUrl: BASE, origin: BASE, ready: true, key: "required", credential: { stored: true, hint: "…WXYZ" } };
		const ui = await mount({
			"GET /api/converters": () => ({ json: section() }),
			"GET /api/converters/drafts": () => ({ json: drafts([configured()]) }),
			"POST /api/converters/drafts/test": () => ({ json: passed }),
			"POST /api/converters/drafts/approve": () => ({ json: { id: "custom:acme-ocr", overview: section([pdfjs, acme]) } }),
		});
		try {
			await ui.click("converter-wizard-open");
			await ui.click("wizard-open-d0123456789ab");
			assert.equal(ui.disabled("wizard-approve"), true);
			assert.equal(ui.text("wizard-approve-note"), "Run Test first.");
			await ui.click("wizard-test");
			assert.match(ui.text("wizard-report-verdict"), /^Passed/);
			assert.equal(ui.q("wizard-check-blank_page")!.getAttribute("data-status"), "pass");
			assert.equal(ui.q("wizard-step-approve")!.getAttribute("data-current"), "true");
			assert.match(ui.text("wizard-approve-note"), /Then choose Use for new PDFs on the main screen/);
			// format=markdown is sent with every PDF: Approve needs "I have read these values"
			assert.equal(ui.disabled("wizard-approve"), true);
			assert.match(ui.text("wizard-ack-row"), /I have read these values/);
			await ui.click("toggle-i-have-read-these-values");
			assert.equal(ui.disabled("wizard-approve"), false);
			await ui.click("wizard-approve");
			assert.deepEqual(ui.calls.at(-1)!.body, { id: "d0123456789ab", shown: "a".repeat(64), acknowledged: "a".repeat(64) });
			assert.equal(ui.q("converter-wizard"), null, "the wizard closes");
			assert.match(ui.text("converter-import-note"), /^Approved Acme OCR, shown above\. Choose Use for new PDFs to use it\.$/);
			assert.match(ui.text("converter-destination"), /^If you use it, PDFs you upload will be sent to https:\/\/ocr\.acme\.example\./);
			assert.ok(ui.q("converter-use"), "Use for new PDFs is a separate step");
		} finally {
			ui.cleanup();
		}
	});

	it("a fixed value that names an address is red, first, with its reason; Approve needs the acknowledgement", async () => {
		const p = profile({ submit: { method: "POST", path: "/convert", body: { type: "multipart", fileField: "document", fields: { format: "markdown", webhook_url: "https://evil.example/hook" } } } });
		const passed = configured({ profile: p, preflight: describeProfile(p, BASE, { stored: true, hint: "…WXYZ" }), test: { report: report(true), current: true, stale: false, at: "x" }, approvable: true, approveBlocked: undefined });
		const ui = await mount({ "GET /api/converters": () => ({ json: section() }), "GET /api/converters/drafts": () => ({ json: drafts([passed]) }), "POST /api/converters/drafts/approve": () => ({ status: 409, json: { error: "stop here" } }) });
		try {
			await ui.click("converter-wizard-open");
			await ui.click("wizard-open-d0123456789ab");
			assert.deepEqual(ui.all("wizard-fixed-red").map((t) => t.split(":")[0]), ["submit field webhook_url = https"]);
			assert.match(ui.text("wizard-warning"), /^its value looks like an address \(it is a URL\): a service told to send results or notifications there would send your documents' text to it\.$/);
			assert.ok(ui.q("wizard-fixed-red")!.className.includes("text-error"));
			assert.ok(ui.html().indexOf("webhook_url") < ui.html().indexOf("format = markdown"), "red values come first");
			assert.equal(ui.disabled("wizard-approve"), true);
			await ui.click("toggle-i-have-read-these-values");
			assert.equal(ui.disabled("wizard-approve"), false);
			await ui.click("wizard-approve");
			assert.equal((ui.calls.at(-1)!.body as { acknowledged: string }).acknowledged, "a".repeat(64));
		} finally {
			ui.cleanup();
		}
	});

	it("the acknowledgement is voided by Ask AI to fix and by Edit JSON (a new version on screen)", async () => {
		const p1 = profile({ submit: { method: "POST", path: "/convert", body: { type: "multipart", fileField: "document", fields: { callback: "https://a.example/one" } } } });
		const p2 = profile({ submit: { method: "POST", path: "/convert", body: { type: "multipart", fileField: "document", fields: { callback: "https://b.example/two" } } } });
		const p3 = profile({ submit: { method: "POST", path: "/convert", body: { type: "multipart", fileField: "document", fields: { callback: "https://c.example/three" } } } });
		const failedTest = { report: report(false), current: false, stale: false, at: "x" };
		const passedTest = { report: report(true), current: true, stale: false, at: "x" };
		const v1 = configured({ profile: p1, preflight: describeProfile(p1, BASE, { stored: true }), shown: "1".repeat(64), test: failedTest, approveBlocked: "The Test failed: fix the profile and run Test again." });
		const v2 = configured({ profile: p2, preflight: describeProfile(p2, BASE, { stored: true }), shown: "2".repeat(64), test: passedTest, approvable: true, approveBlocked: undefined });
		const v3 = configured({ profile: p3, preflight: describeProfile(p3, BASE, { stored: true }), shown: "3".repeat(64), test: passedTest, approvable: true, approveBlocked: undefined });
		const ui = await mount({
			"GET /api/converters": () => ({ json: section() }),
			"GET /api/converters/drafts": () => ({ json: drafts([v1]) }),
			"POST /api/converters/drafts/fix": () => ({ json: v2 }),
			"PUT /api/converters/drafts": () => ({ json: v3 }),
			"POST /api/converters/drafts/approve": () => ({ status: 409, json: { error: "stop here" } }),
		});
		try {
			await ui.click("converter-wizard-open");
			await ui.click("wizard-open-d0123456789ab");
			await ui.click("toggle-i-have-read-these-values");
			assert.equal(ui.q("toggle-i-have-read-these-values")!.getAttribute("aria-checked"), "true");
			await ui.click("wizard-fix");
			assert.match(ui.text("wizard-fixed"), /b\.example\/two/);
			assert.equal(ui.q("toggle-i-have-read-these-values")!.getAttribute("aria-checked"), "false", "a fixed draft is a new version: read again");
			assert.equal(ui.disabled("wizard-approve"), true);
			await ui.click("toggle-i-have-read-these-values");
			assert.equal(ui.disabled("wizard-approve"), false);
			await ui.click("wizard-edit-json");
			await ui.click("wizard-editor-save");
			assert.match(ui.text("wizard-fixed"), /c\.example\/three/);
			assert.equal(ui.q("toggle-i-have-read-these-values")!.getAttribute("aria-checked"), "false", "an edited draft is a new version");
			assert.equal(ui.disabled("wizard-approve"), true);
			await ui.click("toggle-i-have-read-these-values");
			await ui.click("wizard-approve");
			assert.equal((ui.calls.at(-1)!.body as { acknowledged: string }).acknowledged, "3".repeat(64), "the acknowledgement names the version read");
		} finally {
			ui.cleanup();
		}
	});

	it("the reviewer's worst profile on Review: every value listed under the heading, the addresses and accounts red, the switch", async () => {
		const worst = profile({
			auth: { header: "Authorization", value: "Bearer {{API_KEY}}" },
			submit: { method: "POST", path: "/convert?webhook=https://attacker.example/steal&callback_url=https://attacker.example/cb&email=leak@attacker.example", body: { type: "json-base64", filePointer: "/file", encoding: "base64", json: { ocr: false, max_pages: 3, tier: "enterprise-max", sink: "exfil.ru/collect", url: ["exfil.ru/hook"], target: { host: "exfil.ru" }, workspace_id: "ws_attacker_shared" } } },
		});
		const passed = configured({ profile: worst, preflight: describeProfile(worst, BASE, { stored: true }), test: { report: report(true), current: true, stale: false, at: "x" }, approvable: true, approveBlocked: undefined });
		const ui = await mount({ "GET /api/converters": () => ({ json: section() }), "GET /api/converters/drafts": () => ({ json: drafts([passed]) }) });
		try {
			await ui.click("converter-wizard-open");
			await ui.click("wizard-open-d0123456789ab");
			const red = ui.all("wizard-fixed-red").map((t) => t.replace(/(its (value|name)|this may send).*$/, "").trim());
			// red first, then in the schema's order: the path's parameters before the body
			assert.deepEqual(red, [
				"submit query parameter webhook = https://attacker.example/steal",
				"submit query parameter callback_url = https://attacker.example/cb",
				"submit query parameter email = leak@attacker.example",
				'submit field /sink = "exfil.ru/collect"',
				'submit field /url/0 = "exfil.ru/hook"',
				'submit field /target/host = "exfil.ru"',
				'submit field /workspace_id = "ws_attacker_shared"',
			]);
			assert.deepEqual(ui.all("wizard-fixed-value"), [`key header Authorization = Bearer ${KEY_MASK}`, "submit method: POST", "submit path: /convert", "submit file pointer: /file", "submit PDF encoding: base64", "submit field /ocr = false", "submit field /max_pages = 3", 'submit field /tier = "enterprise-max"']);
			assert.equal(ui.disabled("wizard-approve"), true);
			assert.match(ui.text("wizard-ack-row"), /^I have read these values/);
		} finally {
			ui.cleanup();
		}
	});

	it("even the plainest profile asks for the acknowledgement (fix round 2); a void pass is never a plain Passed", async () => {
		const bare = profile({ submit: { method: "POST", path: "/convert", body: { type: "multipart", fileField: "document" } } });
		const passed = configured({ profile: bare, preflight: describeProfile(bare, BASE, { stored: true }), test: { report: report(true), current: true, stale: false, at: "x" }, approvable: true, approveBlocked: undefined });
		const voided = configured({ id: "d0123456789ac", test: { report: report(true), current: false, stale: true, at: "x" }, approveBlocked: "The profile, URL or key changed since the Test passed: run Test again." });
		const ui = await mount({ "GET /api/converters": () => ({ json: section() }), "GET /api/converters/drafts": () => ({ json: drafts([passed, voided]) }) });
		try {
			await ui.click("converter-wizard-open");
			await ui.click("wizard-open-d0123456789ab");
			assert.match(ui.text("wizard-ack-row"), /^I have read these values/);
			assert.equal(ui.disabled("wizard-approve"), true, "there is no 'nothing to acknowledge' case");
			await ui.click("toggle-i-have-read-these-values");
			assert.equal(ui.disabled("wizard-approve"), false);
			await ui.click("wizard-back");
			await ui.click("wizard-open-d0123456789ac");
			assert.match(ui.text("wizard-report-verdict"), /^This report is for an earlier version of the draft\. Passed/);
		} finally {
			ui.cleanup();
		}
	});

	it("after a restart the Test shows the checks in the app's words, says the previews are gone and offers Test again (fix round 2)", async () => {
		const kept = { ...report(false), pages: [] };
		const restarted = configured({ test: { report: kept, current: false, stale: false, at: "x", previews: false }, approveBlocked: "The Test failed: fix the profile and run Test again." });
		const ui = await mount({ "GET /api/converters": () => ({ json: section() }), "GET /api/converters/drafts": () => ({ json: drafts([restarted]) }) });
		try {
			await ui.click("converter-wizard-open");
			await ui.click("wizard-open-d0123456789ab");
			assert.equal(ui.all("wizard-page-preview").length, 0);
			assert.equal(ui.text("wizard-no-previews"), "The service's own messages and the page previews are kept only while the app runs. Run Test again to see them.");
			assert.equal(ui.disabled("wizard-test"), false, "Test is offered again");
		} finally {
			ui.cleanup();
		}
	});

	it('"cannot be expressed" and an invalid draft say so, with no Test and no Approve', async () => {
		const cannot = draft({ status: "cannot_express", reason: "Uploads go to a presigned URL first.", profileText: undefined, preflight: undefined, approveBlocked: "The service cannot be described by a profile." });
		const invalid = draft({ id: "d0123456789ac", status: "invalid", errors: ["/submit/path: must start with / (it is relative to the base URL)"], preflight: undefined });
		const ui = await mount({ "GET /api/converters": () => ({ json: section() }), "GET /api/converters/drafts": () => ({ json: drafts([cannot, invalid]) }) });
		try {
			await ui.click("converter-wizard-open");
			await ui.click("wizard-open-d0123456789ab");
			assert.equal(ui.text("wizard-cannot-reason"), "From the AI, which read documentation that can be wrong or written to mislead it: Uploads go to a presigned URL first.");
			assert.match(ui.text("wizard-cannot"), /^The AI found that this service cannot be described by a profile\./);
			assert.equal(ui.q("wizard-test"), null);
			assert.equal(ui.q("wizard-approve"), null);
			await ui.click("wizard-back");
			await ui.click("wizard-open-d0123456789ac");
			assert.match(ui.text("wizard-invalid"), /not a valid profile, so nothing can be sent with it.*must start with \//);
			assert.equal(ui.q("wizard-test"), null);
			assert.equal(ui.disabled("wizard-fix"), false);
			assert.ok(ui.q("wizard-edit-json"));
		} finally {
			ui.cleanup();
		}
	});
});
