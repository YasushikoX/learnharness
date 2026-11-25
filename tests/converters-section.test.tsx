import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { ConverterEntry, ConvertersOverview, ConverterValidationReport } from "../src/core/converter-settings.ts";
import { ConvertersSection } from "../components/settings/converters-section.tsx";
import { importProfile, saveConverter } from "../components/settings/converters-client.ts";

/**
 * Settings → PDF conversion (components/settings/converters-section.tsx), rendered against a fetch stub. Pinned:
 * where PDFs go for each kind of converter, the unverified note, the key row that shows only whether a key is
 * stored, Docling's options, the Test report, a selection change, invalid profile files and a missing selection.
 * (Typing cannot be simulated in linkedom: the requests behind the text fields are tested on the client below.)
 */

const pdfjs: ConverterEntry = { id: "pdfjs", kind: "builtin", name: "Built-in reader", local: true, key: "none", credential: { stored: false } };
const docling = (over: Partial<ConverterEntry> = {}): ConverterEntry => ({
	id: "docling", kind: "docling", name: "Docling (self-hosted)", local: false, key: "optional", credential: { stored: false }, options: { ocr: true, formulaEnrichment: false }, ...over,
});
const mistral = (over: Partial<ConverterEntry> = {}): ConverterEntry => ({
	id: "mistral-ocr", kind: "preset", name: "Mistral OCR", local: false, unverified: true, defaultBaseUrl: "https://api.mistral.ai", origin: "https://api.mistral.ai", key: "required", credential: { stored: false }, ...over,
});
const view = (selected: string, converters: ConverterEntry[] = [pdfjs, docling(), mistral()], invalidProfiles: ConvertersOverview["invalidProfiles"] = []): ConvertersOverview => ({ selected, converters, invalidProfiles });

interface Call {
	method: string;
	url: string;
	body: unknown;
}

async function mount(routes: Record<string, (call: Call) => { status?: number; json: unknown }>) {
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
			const route = routes[`${call.method} ${url}`];
			assert.ok(route, `unexpected request: ${call.method} ${url}`);
			const r = route(call);
			return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
		},
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	await act(async () => {
		root.render(<ConvertersSection />);
	});
	const q = <T extends HTMLElement>(id: string) => document.querySelector<T>(`[data-testid="${id}"]`);
	const text = (id: string) => q(id)?.textContent ?? "";
	const click = async (id: string) => {
		await act(async () => {
			q<HTMLButtonElement>(id)!.click();
		});
	};
	const choose = async (value: string) => {
		await act(async () => {
			const select = q<HTMLSelectElement>("converter-select")!;
			// linkedom's select.value has no setter: mark the option instead (value reads the selected option)
			for (const option of select.querySelectorAll("option")) {
				if (option.getAttribute("value") === value) option.setAttribute("selected", "");
				else option.removeAttribute("selected");
			}
			assert.equal(select.value, value);
			select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
		});
	};
	const cleanup = () => {
		act(() => root.unmount());
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	};
	return { q, text, click, choose, calls, cleanup };
}

describe("Settings → PDF conversion", () => {
	it("the built-in reader: PDFs stay on this computer, no URL or key", async () => {
		const ui = await mount({ "GET /api/converters": () => ({ json: view("pdfjs") }) });
		try {
			assert.match(ui.text("converter-destination"), /^PDFs stay on this computer/);
			assert.equal(ui.q("converter-url-row"), null);
			assert.equal(ui.q("converter-key-row"), null);
			assert.equal(ui.q("converter-unverified"), null);
			assert.ok(ui.q("converter-test"));
			assert.match(ui.text("converter-select"), /Mistral OCR \(unverified\)/);
		} finally {
			ui.cleanup();
		}
	});

	it("a preset: where PDFs are sent, the unverified note, a key that is needed and not stored", async () => {
		const ui = await mount({ "GET /api/converters": () => ({ json: view("mistral-ocr") }) });
		try {
			assert.equal(ui.text("converter-destination"), "PDFs you upload are sent to https://api.mistral.ai. The built-in reader keeps PDFs on this computer.");
			assert.match(ui.text("converter-unverified"), /has not been tried against the real service/);
			assert.match(ui.text("converter-key-row"), /Needed; not stored yet/);
			assert.equal(ui.q("converter-key-remove"), null);
			assert.equal(ui.q<HTMLInputElement>("converter-key-input")!.getAttribute("type"), "password");
			assert.match(ui.text("converter-url-row"), /Default: https:\/\/api\.mistral\.ai/);
		} finally {
			ui.cleanup();
		}
	});

	it("Docling with a stored key: only its status and last characters, Remove, and the OCR options", async () => {
		const stored = docling({ baseUrl: "http://docling.lan:5001", origin: "http://docling.lan:5001", credential: { stored: true, hint: "…WXYZ" } });
		let removed: unknown;
		const ui = await mount({
			"GET /api/converters": () => ({ json: view("docling", [pdfjs, stored, mistral()]) }),
			"PUT /api/converters": (call) => {
				removed = call.body;
				return { json: view("docling", [pdfjs, docling({ baseUrl: "http://docling.lan:5001", origin: "http://docling.lan:5001" }), mistral()]) };
			},
		});
		try {
			assert.match(ui.text("converter-destination"), /^PDFs you upload are sent to http:\/\/docling\.lan:5001\./);
			assert.match(ui.text("converter-key-row"), /A key is stored \(…WXYZ\)/);
			assert.equal(ui.q<HTMLInputElement>("converter-key-input")!.value, "");
			assert.equal(ui.q<HTMLInputElement>("converter-url-input")!.value, "http://docling.lan:5001");
			assert.ok(ui.q("converter-ocr-row"));
			assert.ok(ui.q("converter-formula-row"));
			await ui.click("converter-key-remove");
			assert.deepEqual(removed, { id: "docling", removeKey: true });
			assert.match(ui.text("converter-key-row"), /Optional; not stored/);
		} finally {
			ui.cleanup();
		}
	});

	it("Test shows each check and the verdict", async () => {
		const report: ConverterValidationReport = {
			ok: false,
			converterId: "mistral-ocr",
			durationMs: 5,
			warnings: [],
			pages: [{ page: 1, text: "The heron counted" }, { page: 2, text: "" }],
			checks: [
				{ id: "converted", status: "pass", message: "Mistral OCR answered for 2 pages." },
				{ id: "markers", status: "pass", message: "Both pages are present." },
				{ id: "page_1", status: "pass", message: "Page 1 has its own sentence." },
				{ id: "page_2", status: "fail", message: "Page 2 does not have its sentence." },
				{ id: "own_pages", status: "pass", message: "Neither page has the other page's sentence." },
				{ id: "no_secret", status: "pass", message: "The API key does not appear in the answer." },
			],
		};
		const ui = await mount({
			"GET /api/converters": () => ({ json: view("mistral-ocr") }),
			"POST /api/converters/test": () => ({ json: report }),
		});
		try {
			await ui.click("converter-test");
			assert.deepEqual(ui.calls.at(-1)?.body, { id: "mistral-ocr" });
			assert.match(ui.text("converter-report-verdict"), /^Failed/);
			assert.equal(ui.q("converter-check-page_2")!.getAttribute("data-status"), "fail");
			assert.match(ui.text("converter-check-page_2"), /^✗ Page 2/);
			assert.match(ui.text("converter-check-converted"), /^✓/);
			assert.match(ui.text("converter-report"), /Page 2: \(empty\)/);
		} finally {
			ui.cleanup();
		}
	});

	it("choosing another converter selects it and shows its settings", async () => {
		const ui = await mount({
			"GET /api/converters": () => ({ json: view("pdfjs") }),
			"PUT /api/converters": () => ({ json: view("mistral-ocr") }),
		});
		try {
			await ui.choose("mistral-ocr");
			assert.deepEqual(ui.calls.at(-1), { method: "PUT", url: "/api/converters", body: { id: "mistral-ocr", select: true } });
			assert.ok(ui.q("converter-unverified"));
		} finally {
			ui.cleanup();
		}
	});

	it("invalid profile files are listed; a selection that is gone says the built-in reader is used", async () => {
		const ui = await mount({ "GET /api/converters": () => ({ json: view("custom:gone", [pdfjs, docling(), mistral()], [{ file: "bad.json", errors: ["Not valid JSON: x"] }]) }) });
		try {
			assert.match(ui.text("converter-invalid-profiles"), /bad\.json: Not valid JSON: x/);
			assert.match(ui.text("converter-missing"), /"custom:gone" is not available/);
			assert.match(ui.text("converter-destination"), /^PDFs stay on this computer/);
		} finally {
			ui.cleanup();
		}
	});

	it("a load failure reads as a line of text", async () => {
		const ui = await mount({ "GET /api/converters": () => ({ status: 500, json: { error: "Settings unavailable" } }) });
		try {
			assert.equal(ui.text("converters-load-error"), "Settings unavailable");
		} finally {
			ui.cleanup();
		}
	});
});

describe("Settings → PDF conversion requests", () => {
	it("sends a key once and reports an import's validation errors", async () => {
		const original = globalThis.fetch;
		const sent: { url: string; body: unknown }[] = [];
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			sent.push({ url, body: JSON.parse(String(init?.body)) });
			if (url === "/api/converters/profiles") return new Response(JSON.stringify({ error: "The profile is not valid", errors: ["/extra: unknown"] }), { status: 400 });
			return new Response(JSON.stringify(view("mistral-ocr")), { status: 200 });
		}) as typeof fetch;
		try {
			const saved = await saveConverter({ id: "mistral-ocr", apiKey: "sk-1" });
			assert.equal(saved.value?.selected, "mistral-ocr");
			assert.deepEqual(sent[0], { url: "/api/converters", body: { id: "mistral-ocr", apiKey: "sk-1" } });
			const imported = await importProfile("{\"extra\":1}");
			assert.equal(imported.value, null);
			assert.deepEqual(imported.errors, ["/extra: unknown"]);
			assert.deepEqual(sent[1]!.body, { profile: "{\"extra\":1}" });
		} finally {
			globalThis.fetch = original;
		}
	});
});
