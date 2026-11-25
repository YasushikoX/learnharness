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
 * stored, Docling's options, the Test report (Cancel, a switch while it runs), choosing an entry only shows it and
 * "Use for new PDFs" selects it, the import flow, the URL-change warning, invalid profile files and a missing
 * selection. (Typing works in linkedom once `document.oninput` exists, so React uses input events.)
 */

const pdfjs: ConverterEntry = { id: "pdfjs", kind: "builtin", name: "Built-in reader", local: true, ready: true, key: "none", credential: { stored: false } };
const docling = (over: Partial<ConverterEntry> = {}): ConverterEntry => ({
	id: "docling", kind: "docling", name: "Docling (self-hosted)", local: false, ready: false, setup: "Save the Docling service URL first.", key: "optional", credential: { stored: false }, options: { ocr: true, formulaEnrichment: false }, ...over,
});
const mistral = (over: Partial<ConverterEntry> = {}): ConverterEntry => ({
	id: "mistral-ocr", kind: "preset", name: "Mistral OCR", local: false, unverified: true, defaultBaseUrl: "https://api.mistral.ai", origin: "https://api.mistral.ai", ready: false, setup: "Save its API key first.", key: "required", credential: { stored: false }, ...over,
});
const mistralReady = (over: Partial<ConverterEntry> = {}) => mistral({ baseUrl: "https://api.mistral.ai", ready: true, setup: undefined, credential: { stored: true, hint: "…WXYZ" }, ...over });
const acme = (over: Partial<ConverterEntry> = {}): ConverterEntry => ({
	id: "custom:acme", kind: "custom", name: "Acme OCR", local: false, ready: false, setup: "Save the Acme OCR service URL first.", key: "required", credential: { stored: false }, ...over,
});
const view = (selected: string, converters: ConverterEntry[] = [pdfjs, docling(), mistral()], invalidProfiles: ConvertersOverview["invalidProfiles"] = []): ConvertersOverview => ({ selected, converters, invalidProfiles });

interface Call {
	method: string;
	url: string;
	body: unknown;
	signal?: AbortSignal;
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
			const call: Call = { method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined, ...(init?.signal ? { signal: init.signal } : {}) };
			calls.push(call);
			const route = routes[`${call.method} ${url}`];
			assert.ok(route, `unexpected request: ${call.method} ${url}`);
			// like fetch: an aborted request rejects, whenever its answer would have come
			const aborted = new Promise<never>((_, reject) => {
				if (init?.signal?.aborted) reject(new DOMException("aborted", "AbortError"));
				init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
			});
			const r = await Promise.race([Promise.resolve(route(call)), aborted]);
			return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
		},
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	// linkedom's document has no `oninput`: without it React would not use input events for text fields
	(dom.document as unknown as Record<string, unknown>).oninput = null;
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
	const chooseFile = async (file: File) => {
		await act(async () => {
			const input = q<HTMLInputElement>("converter-import-file")!;
			Object.defineProperty(input, "files", { configurable: true, value: [file] });
			input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
		});
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	};
	const cleanup = () => {
		act(() => root.unmount());
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	};
	return { q, text, click, choose, type, chooseFile, calls, cleanup };
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
		const ready = await mount({ "GET /api/converters": () => ({ json: view("mistral-ocr", [pdfjs, docling(), mistralReady()]) }) });
		try {
			assert.equal(ready.text("converter-destination"), "PDFs you upload are sent to https://api.mistral.ai. The built-in reader keeps PDFs on this computer.");
			assert.equal(ready.text("converter-active"), "In use for new PDFs");
		} finally {
			ready.cleanup();
		}
		const ui = await mount({ "GET /api/converters": () => ({ json: view("mistral-ocr") }) });
		try {
			// in use (chosen elsewhere) but not set up: nothing is sent, and the screen says so
			assert.equal(ui.text("converter-destination"), "Not set up yet, so nothing is sent to https://api.mistral.ai: the built-in reader converts PDFs on this computer. Save its API key first.");
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
		const stored = docling({ baseUrl: "http://docling.lan:5001", origin: "http://docling.lan:5001", ready: true, setup: undefined, credential: { stored: true, hint: "…WXYZ" } });
		let removed: unknown;
		const ui = await mount({
			"GET /api/converters": () => ({ json: view("docling", [pdfjs, stored, mistral()]) }),
			"PUT /api/converters": (call) => {
				removed = call.body;
				return { json: view("docling", [pdfjs, docling({ baseUrl: "http://docling.lan:5001", origin: "http://docling.lan:5001", ready: true, setup: undefined }), mistral()]) };
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

	it("choosing another converter only shows it; Use for new PDFs, beside the destination, selects it", async () => {
		const ui = await mount({
			"GET /api/converters": () => ({ json: view("pdfjs", [pdfjs, docling(), mistralReady()]) }),
			"PUT /api/converters": () => ({ json: view("mistral-ocr", [pdfjs, docling(), mistralReady()]) }),
		});
		try {
			assert.equal(ui.text("converter-active"), "In use for new PDFs");
			assert.match(ui.text("converter-select"), /Built-in reader — in use/);
			await ui.choose("mistral-ocr");
			assert.equal(ui.calls.length, 1, "choosing in the list sends nothing");
			assert.ok(ui.q("converter-unverified"));
			assert.equal(ui.text("converter-destination"), "If you use it, PDFs you upload will be sent to https://api.mistral.ai. The built-in reader keeps PDFs on this computer.");
			assert.equal(ui.q("converter-active"), null);
			const use = ui.q<HTMLButtonElement>("converter-use")!;
			assert.equal(use.textContent, "Use for new PDFs");
			assert.equal(use.parentElement, ui.q("converter-destination")!.parentElement, "the action sits beside the destination line");
			await ui.click("converter-use");
			assert.deepEqual(ui.calls.at(-1), { method: "PUT", url: "/api/converters", body: { id: "mistral-ocr", select: true } });
			assert.equal(ui.text("converter-active"), "In use for new PDFs");
			assert.equal(ui.text("converter-destination"), "PDFs you upload are sent to https://api.mistral.ai. The built-in reader keeps PDFs on this computer.");
			assert.match(ui.text("converter-select"), /Mistral OCR \(unverified\) — in use/);
		} finally {
			ui.cleanup();
		}
	});

	it("Use for new PDFs stays off until the converter is set up, and says what is missing", async () => {
		const ui = await mount({ "GET /api/converters": () => ({ json: view("pdfjs") }) });
		try {
			await ui.choose("mistral-ocr");
			assert.equal(ui.q<HTMLButtonElement>("converter-use")!.disabled, true);
			assert.equal(ui.text("converter-setup"), "Not set up yet: Save its API key first.");
			await ui.choose("docling");
			assert.equal(ui.q<HTMLButtonElement>("converter-use")!.disabled, true);
			assert.equal(ui.text("converter-destination"), "Save the service URL first. Nothing is sent until then.");
		} finally {
			ui.cleanup();
		}
	});

	it("import: a chosen file is imported and shown, not used; validation errors are listed", async () => {
		let imported = 0;
		const ui = await mount({
			"GET /api/converters": () => ({ json: view("pdfjs") }),
			"POST /api/converters/profiles": (call) => {
				imported++;
				const text = (call.body as { profile: string }).profile;
				if (text.includes("defaultBaseUrl")) return { status: 400, json: { error: "The profile is not valid", errors: ["/defaultBaseUrl: a profile you import cannot name its service address"] } };
				return { json: { id: "custom:acme", replaced: false, overview: view("pdfjs", [pdfjs, docling(), mistral(), acme()]) } };
			},
		});
		try {
			await ui.chooseFile(new File(['{"id":"acme","defaultBaseUrl":"http://127.0.0.1:3000"}'], "acme.json", { type: "application/json" }));
			assert.match(ui.text("converter-import-errors"), /cannot name its service address/);
			assert.equal(ui.q("converter-import-note"), null);
			await ui.chooseFile(new File(['{"id":"acme"}'], "acme.json", { type: "application/json" }));
			assert.equal(imported, 2);
			assert.equal(ui.q("converter-import-errors"), null);
			assert.match(ui.text("converter-import-note"), /Imported Acme OCR, shown above\. Nothing is sent until you save its service URL and key and choose Use for new PDFs\./);
			assert.equal(ui.q<HTMLSelectElement>("converter-select")!.value, "custom:acme");
			assert.equal(ui.text("converter-destination"), "Save the service URL first. Nothing is sent until then.");
			assert.equal(ui.q<HTMLButtonElement>("converter-use")!.disabled, true);
			assert.equal(ui.calls.filter((c) => c.method === "PUT").length, 0, "importing never selects");
		} finally {
			ui.cleanup();
		}
	});

	it("typing another URL for a converter with a stored key warns that saving removes the key", async () => {
		const stored = docling({ baseUrl: "http://docling.lan:5001", origin: "http://docling.lan:5001", ready: true, setup: undefined, credential: { stored: true } });
		let saved: unknown;
		const ui = await mount({
			"GET /api/converters": () => ({ json: view("docling", [pdfjs, stored, mistral()]) }),
			"PUT /api/converters": (call) => {
				saved = call.body;
				return { json: view("docling", [pdfjs, docling({ baseUrl: "http://other.lan:5001", origin: "http://other.lan:5001", ready: true, setup: undefined }), mistral()]) };
			},
		});
		try {
			assert.equal(ui.q("converter-url-key-note"), null);
			await ui.type("converter-url-input", "http://other.lan:5001");
			assert.match(ui.text("converter-url-key-note"), /Saving another URL removes the stored key/);
			await ui.click("converter-url-save");
			assert.deepEqual(saved, { id: "docling", baseUrl: "http://other.lan:5001" });
			assert.equal(ui.q("converter-url-key-note"), null);
			assert.match(ui.text("converter-key-row"), /Optional; not stored/);
		} finally {
			ui.cleanup();
		}
	});

	it("re-check 2, finding 4: removing a profile while its Test runs cancels the Test, and no late report appears under another converter", async () => {
		const acmeReady = acme({ baseUrl: "https://ocr.example", origin: "https://ocr.example", ready: true, setup: undefined, credential: { stored: true, hint: "…WXYZ" } });
		const late: ConverterValidationReport = { ok: false, converterId: "custom:acme", durationMs: 5, warnings: [], pages: [], checks: [{ id: "converted", status: "fail", message: "Acme OCR failed" }] };
		const pending: { resolve: (r: Reply) => void; signal?: AbortSignal }[] = [];
		const ui = await mount({
			"GET /api/converters": () => ({ json: view("custom:acme", [pdfjs, docling(), acmeReady]) }),
			"POST /api/converters/test": (call) => new Promise<Reply>((resolve) => pending.push({ resolve, ...(call.signal ? { signal: call.signal } : {}) })),
			"DELETE /api/converters/profiles?id=custom%3Aacme": () => ({ json: view("pdfjs", [pdfjs, docling()]) }),
		});
		try {
			await ui.click("converter-test");
			assert.equal(ui.text("converter-test"), "Testing…");
			await ui.click("converter-profile-remove");
			assert.equal(pending[0]!.signal!.aborted, true, "removing the profile aborts its running test");
			assert.equal(ui.text("converter-test"), "Test");
			await act(async () => pending[0]!.resolve({ json: late }));
			assert.equal(ui.q("converter-report"), null, "the removed converter's report is not shown under the built-in reader");
			assert.match(ui.text("converter-destination"), /PDFs stay on this computer/);
		} finally {
			ui.cleanup();
		}
	});

	it("re-check 2, finding 5: a service in use with no saved address says the built-in reader is converting", async () => {
		const ui = await mount({ "GET /api/converters": () => ({ json: view("docling", [pdfjs, docling({ ready: false, setup: "Save the Docling service URL first." })]) }) });
		try {
			assert.match(ui.text("converter-destination"), /Not set up yet, so nothing is sent: the built-in reader converts PDFs on this computer\. Save the service URL first\./);
		} finally {
			ui.cleanup();
		}
	});

	it("Test can be cancelled; a switch to another converter while it runs cancels it and its late report is never shown", async () => {
		const report: ConverterValidationReport = {
			ok: true, converterId: "mistral-ocr", durationMs: 5, warnings: [], pages: [],
			checks: [{ id: "converted", status: "pass", message: "Mistral OCR answered for 2 pages." }],
		};
		const pending: { resolve: (r: Reply) => void; signal?: AbortSignal }[] = [];
		const ui = await mount({
			"GET /api/converters": () => ({ json: view("mistral-ocr", [pdfjs, docling(), mistralReady()]) }),
			"POST /api/converters/test": (call) => new Promise<Reply>((resolve) => pending.push({ resolve, ...(call.signal ? { signal: call.signal } : {}) })),
		});
		try {
			await ui.click("converter-test");
			assert.equal(ui.text("converter-test"), "Testing…");
			assert.ok(pending[0]!.signal, "the request carries an abort signal");
			await ui.click("converter-test-cancel");
			assert.equal(pending[0]!.signal!.aborted, true, "Cancel aborts the request");
			assert.equal(ui.text("converter-test"), "Test");
			await act(async () => pending[0]!.resolve({ json: report }));
			assert.equal(ui.q("converter-report"), null);

			await ui.click("converter-test");
			await ui.choose("pdfjs");
			assert.equal(pending[1]!.signal!.aborted, true, "showing another converter aborts the running test");
			await act(async () => pending[1]!.resolve({ json: report }));
			assert.equal(ui.q("converter-report"), null, "a report started for another converter is not shown");
			assert.equal(ui.q("converter-error"), null);
			assert.equal(ui.text("converter-test"), "Test");
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
