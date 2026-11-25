import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { closedBaseUrl, withServer } from "./helpers/docling-server.ts";
import { KEY, json, pageArrayProfile, pagesAnswer, routes } from "./helpers/converter-services.ts";

/**
 * Review 1 of the declarative HTTP converters (council/reviews/wp3a2-review-1.md), the app side: a custom profile can
 * neither name nor reach an address the user never saved (finding 2), the app is never its own PDF service, a bad
 * profile file never breaks the screen and the import route bounds its body (findings 3, 5), keys are refused when
 * they are too short or carry characters a header cannot (findings 1, 7), URLs compare canonically (finding 8), the
 * generic settings route cannot change a service URL, the Test reads a profile once and stops with its request, and
 * every /api/converters route is behind the app's request guard. Loopback servers only.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-http-converters-hardening-"));
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
process.env.LH_DATA_DIR = path.join(TMP, "data");
const savedPort = process.env.PORT;
after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
	if (savedPort === undefined) delete process.env.PORT;
	else process.env.PORT = savedPort;
});

const credentials = await import("../src/server/converters/credentials.ts");
const { readSettings, writeSettings } = await import("../src/store/settings.ts");
const custom = await import("../src/server/converters/custom-profiles.ts");
const { resolvePdfConverter } = await import("../src/server/converters/registry.ts");
const { selfOriginProblem } = await import("../src/server/converters/self-origin.ts");
const settingsService = await import("../src/server/converters/settings-service.ts");
const authModule = await import("../src/server/converters/auth.ts");
const convertersRoute = await import("../app/api/converters/route.ts");
const testRoute = await import("../app/api/converters/test/route.ts");
const profilesRoute = await import("../app/api/converters/profiles/route.ts");
const settingsRoute = await import("../app/api/settings/[section]/route.ts");
const { chatStore } = await import("../src/store/chats.ts");
const materials = await import("../src/server/materials.ts");
const { validationPdf } = await import("../src/server/converters/validation-fixture.ts");
const { proxy } = await import("../proxy.ts");
type ConvertersOverview = import("../src/core/converter-settings.ts").ConvertersOverview;
type ConverterValidationReport = import("../src/core/converter-settings.ts").ConverterValidationReport;

const profileDir = () => custom.convertersDir();
const authText = () => (fs.existsSync(process.env.LH_AUTH_FILE!) ? fs.readFileSync(process.env.LH_AUTH_FILE!, "utf8") : "");

beforeEach(() => {
	fs.rmSync(process.env.LH_AUTH_FILE!, { force: true });
	fs.rmSync(profileDir(), { recursive: true, force: true });
	writeSettings({ version: 1 });
	delete process.env.PORT;
});

function writeProfileFile(name: string, content: unknown): void {
	fs.mkdirSync(profileDir(), { recursive: true });
	fs.writeFileSync(path.join(profileDir(), name), typeof content === "string" ? content : JSON.stringify(content));
}

const put = (body: unknown) => convertersRoute.PUT(new Request("http://localhost/api/converters", { method: "PUT", body: JSON.stringify(body) }));
const putJson = async (body: unknown) => {
	const res = await put(body);
	return { status: res.status, body: (await res.json()) as ConvertersOverview & { error?: string } };
};
const importProfile = (profile: unknown) => profilesRoute.POST(new Request("http://localhost/api/converters/profiles", { method: "POST", body: JSON.stringify({ profile }) }));
const entry = (view: ConvertersOverview, id: string) => view.converters.find((c) => c.id === id)!;

async function upload(name: string) {
	const chat = chatStore.createChat(name);
	const added = materials.addUploadedMaterial(chat.id, { name, type: "application/pdf", bytes: validationPdf() });
	assert.ok(added.ok);
	if (!added.ok) throw new Error("upload refused");
	await materials.waitForMaterials(chat.id, 30_000);
	return materials.listMaterials(chat.id).find((m) => m.id === added.value.id)!;
}

describe("finding 2: nothing is sent to an address the user never saved", () => {
	it("a custom profile that names its own address is refused at import, with the reason", async () => {
		const res = await importProfile(JSON.stringify({ ...pageArrayProfile(), auth: undefined, defaultBaseUrl: "http://127.0.0.1:3000" }));
		assert.equal(res.status, 400);
		const body = (await res.json()) as { errors: string[] };
		assert.match(body.errors.join("\n"), /cannot name its service address.*enter the address in Settings → PDF conversion/);
		assert.equal(fs.existsSync(path.join(profileDir(), "pages-svc.json")), false);
	});

	it("such a file placed on disk is listed as invalid and never used: the upload falls back without any request", async () => {
		await withServer(routes({ "POST /convert": (_q, r) => json(r, pagesAnswer(["a", "b"])) }), async (baseUrl, log) => {
			const keyless = pageArrayProfile();
			delete keyless.auth;
			writeProfileFile("pages-svc.json", { ...keyless, defaultBaseUrl: baseUrl });
			const listing = custom.listCustomProfiles();
			assert.deepEqual(listing.profiles, []);
			assert.match(listing.invalid[0]!.errors.join("\n"), /cannot name its service address/);
			writeSettings({ version: 1, pdfConversion: { converter: "custom:pages-svc" } });
			const material = await upload("planted.pdf");
			assert.match(material.conversionWarnings?.[0] ?? "", /could not be used .*cannot name its service address/);
			assert.equal(log.length, 0);
		});
	});

	it("a custom profile chosen without a saved URL sends nothing (no default address is ever used)", async () => {
		const keyless = pageArrayProfile();
		delete keyless.auth;
		writeProfileFile("pages-svc.json", keyless);
		writeSettings({ version: 1, pdfConversion: { converter: "custom:pages-svc" } });
		const resolved = resolvePdfConverter({ converter: "custom:pages-svc" }, credentials.readConverterCredential, custom.loadCustomProfile);
		assert.equal(resolved.converter.id, "pdfjs");
		assert.match(resolved.warnings[0]!, /Pages Service is not set up: no service URL is saved for it/);
		const view = (await (await convertersRoute.GET()).json()) as ConvertersOverview;
		assert.equal(entry(view, "custom:pages-svc").ready, false);
		assert.equal(entry(view, "custom:pages-svc").origin, undefined);
	});

	it("the Mistral preset with no key never uploads: the PDF is read by the built-in reader with a warning", async () => {
		await withServer(routes({ "POST /v1/ocr": (_q, r) => json(r, { message: "Unauthorized" }, 401) }), async (baseUrl, log) => {
			writeSettings({ version: 1, pdfConversion: { converter: "mistral-ocr", services: { "mistral-ocr": { baseUrl } } } });
			const material = await upload("nokey.pdf");
			assert.equal(material.conversionError, undefined);
			assert.match(material.conversionWarnings?.[0] ?? "", /Mistral OCR needs an API key for .*; the built-in reader \(pdfjs\) was used instead\./);
			assert.equal(log.length, 0, "nothing was sent to a service that would only answer 401");
		});
	});

	it("'Use for new PDFs' (select) is refused until the converter is set up; a preset's own address is saved when it is chosen", async () => {
		writeProfileFile("pages-svc.json", pageArrayProfile());
		let res = await putJson({ id: "custom:pages-svc", select: true });
		assert.equal(res.status, 409);
		assert.match(res.body.error!, /Pages Service cannot be used yet: Save the Pages Service service URL first\./);
		await put({ id: "custom:pages-svc", baseUrl: "http://127.0.0.1:9" });
		res = await putJson({ id: "custom:pages-svc", select: true });
		assert.equal(res.status, 409);
		assert.match(res.body.error!, /Save its API key first/);
		res = await putJson({ id: "custom:pages-svc", apiKey: KEY, select: true });
		assert.equal(res.status, 200);
		assert.equal(res.body.selected, "custom:pages-svc");
		assert.equal(entry(res.body, "custom:pages-svc").ready, true);

		assert.equal((await putJson({ id: "mistral-ocr", select: true })).status, 409);
		assert.equal(readSettings()?.pdfConversion?.services?.["mistral-ocr"], undefined, "a refused select saves nothing");
		res = await putJson({ id: "mistral-ocr", apiKey: KEY, select: true });
		assert.equal(res.status, 200);
		assert.deepEqual(readSettings()?.pdfConversion?.services?.["mistral-ocr"], { baseUrl: "https://api.mistral.ai" });
		assert.equal(entry(res.body, "mistral-ocr").ready, true);
	});

	it("the app's own address is refused as a service URL when saved and again before any request", async () => {
		await withServer(routes({ "POST /convert": (_q, r) => json(r, pagesAnswer(["a", "b"])) }), async (baseUrl, log) => {
			const port = new URL(baseUrl).port;
			process.env.PORT = port;
			writeProfileFile("pages-svc.json", pageArrayProfile());
			for (const url of [baseUrl, `http://localhost:${port}`, `http://[::1]:${port}/api`]) {
				const res = await putJson({ id: "custom:pages-svc", baseUrl: url });
				assert.equal(res.status, 400, url);
				assert.match(res.body.error!, /is this app's own address/);
			}
			assert.equal((await putJson({ id: "docling", baseUrl })).status, 400);
			assert.equal(selfOriginProblem(`http://127.0.0.1:${Number(port) + 1}`), undefined, "another port is another server");
			// a URL that got into the settings another way is refused before any request
			credentials.writeProfileCredential("custom:pages-svc", baseUrl, KEY);
			const settings = { converter: "custom:pages-svc", services: { "custom:pages-svc": { baseUrl } } };
			const resolved = resolvePdfConverter(settings, credentials.readConverterCredential, custom.loadCustomProfile);
			assert.equal(resolved.converter.id, "pdfjs");
			assert.match(resolved.warnings[0]!, /is this app's own address/);
			assert.equal(resolvePdfConverter({ converter: "docling", docling: { baseUrl } }, credentials.readConverterCredential).converter.id, "pdfjs");
			assert.equal(log.length, 0);
		});
	});

	it("the address the settings were opened at counts as the app's own, whatever PORT says", async () => {
		await convertersRoute.GET(new Request("http://mybox.example:4567/api/converters"));
		writeProfileFile("pages-svc.json", pageArrayProfile());
		const res = await putJson({ id: "custom:pages-svc", baseUrl: "http://MYBOX.example:4567/" });
		assert.equal(res.status, 400);
		assert.match(res.body.error!, /this app's own address/);
	});
});

describe("findings 3 and 5: profile files and the import route", () => {
	function deep(depth: number): unknown {
		let node: Record<string, unknown> = {};
		const root = node;
		for (let i = 0; i < depth; i++) node = (node.a = {}) as Record<string, unknown>;
		return root;
	}

	it("a deeply nested profile is refused at import (400, not a crash) and, placed on disk, is listed as invalid while the screen still loads", async () => {
		const profile = { ...pageArrayProfile(), submit: { method: "POST", path: "/x", body: { type: "json-base64", filePointer: "/f", encoding: "base64", json: deep(8_000) } } };
		const text = JSON.stringify(profile);
		const res = await importProfile(text);
		assert.equal(res.status, 400);
		assert.match(((await res.json()) as { errors: string[] }).errors[0]!, /nested at most 32 levels/);
		writeProfileFile("deep.json", text);
		writeProfileFile("pages-svc.json", pageArrayProfile());
		const listing = custom.listCustomProfiles();
		assert.deepEqual(listing.profiles.map((p) => p.id), ["pages-svc"]);
		assert.deepEqual(listing.invalid.map((i) => i.file), ["deep.json"]);
		const get = await convertersRoute.GET();
		assert.equal(get.status, 200);
		assert.ok(((await get.json()) as ConvertersOverview).converters.some((c) => c.id === "custom:pages-svc"));
	});

	it("a 120 KB profile sent as an object is refused, not saved", async () => {
		const profile = { ...pageArrayProfile(), description: "x" };
		(profile.submit.body as { fields?: Record<string, string[]> }).fields = { pad: Array.from({ length: 50 }, () => "p".repeat(1_900)) };
		const big = { ...profile, submit: { ...profile.submit, headers: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`X-Pad-${i}`, "h".repeat(1_000)])) } };
		assert.ok(JSON.stringify(big).length > 120_000);
		const res = await importProfile(big);
		assert.equal(res.status, 400);
		assert.match(((await res.json()) as { errors: string[] }).errors[0]!, /at most 64 KB/);
		assert.equal(fs.existsSync(path.join(profileDir(), "pages-svc.json")), false);
	});

	it("a profile under the cap whose indented form would exceed it is saved in a form that loads again", async () => {
		const profile = pageArrayProfile();
		profile.submit.body = { type: "multipart", fileField: "f", fields: Object.fromEntries(Array.from({ length: 36 }, (_, i) => [`f${i}`, Array.from({ length: 50 }, () => "q".repeat(30))])) };
		const compact = JSON.stringify(profile);
		assert.ok(compact.length < 64 * 1024 && JSON.stringify(profile, null, "\t").length > 64 * 1024, "the indented form is over the cap");
		const res = await importProfile(compact);
		assert.equal(res.status, 200);
		const file = path.join(profileDir(), "pages-svc.json");
		assert.ok(fs.statSync(file).size <= 64 * 1024);
		assert.equal(custom.loadCustomProfile("pages-svc").ok, true, "it loads again after saving");
		assert.equal(custom.listCustomProfiles().invalid.length, 0);
	});

	it("the import route refuses an oversized body before buffering it, and bounds a body without Content-Length", async () => {
		let pulled = 0;
		const endless = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled++;
				controller.enqueue(new Uint8Array(64 * 1024).fill(0x20));
			},
		});
		const declared = await profilesRoute.POST(new Request("http://localhost/api/converters/profiles", { method: "POST", body: endless, headers: { "content-length": String(10 * 1024 * 1024) }, duplex: "half" } as RequestInit));
		assert.equal(declared.status, 413);
		assert.ok(pulled <= 1, `the body was read (${pulled} chunks) before the size was refused`);
		pulled = 0;
		const streamed = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled++;
				controller.enqueue(new Uint8Array(64 * 1024).fill(0x20));
			},
		});
		const unbounded = await profilesRoute.POST(new Request("http://localhost/api/converters/profiles", { method: "POST", body: streamed, duplex: "half" } as RequestInit));
		assert.equal(unbounded.status, 413);
		assert.ok(pulled <= 6, `read ${pulled} chunks of 64 KB for a 256 KB limit`);
	});
});

describe("findings 1, 7 and 8: keys and URLs", () => {
	it("a key shorter than 8 characters is refused when saved, with a plain message", async () => {
		writeProfileFile("pages-svc.json", pageArrayProfile());
		const res = await putJson({ id: "custom:pages-svc", baseUrl: "http://127.0.0.1:9", apiKey: "abc1234" });
		assert.equal(res.status, 400);
		assert.equal(res.body.error, "An API key must be at least 8 characters long. Nothing was saved.");
		assert.equal(authText().includes("abc1234"), false);
		assert.equal((await putJson({ id: "docling", baseUrl: "http://127.0.0.1:9", apiKey: "short" })).status, 400);
		assert.throws(() => authModule.configureDocling({ baseUrl: "http://127.0.0.1:9", apiKey: "short" }), /at least 8 characters/);
	});

	it("a key with a control or non-Latin-1 character is refused when saved", async () => {
		writeProfileFile("pages-svc.json", pageArrayProfile());
		for (const key of ["sk-live-12\u0001345678", "sk-live-12\u007f345678", "sk-live-ключ-12345"]) {
			const res = await putJson({ id: "custom:pages-svc", baseUrl: "http://127.0.0.1:9", apiKey: key });
			assert.equal(res.status, 400, JSON.stringify(key));
			assert.match(res.body.error!, /control character|cannot be sent in an HTTP header/);
		}
	});

	it("a stored key that cannot be sent is the material's error, never a quiet fallback", async () => {
		writeProfileFile("pages-svc.json", pageArrayProfile());
		await withServer(routes({ "POST /convert": (_q, r) => json(r, pagesAnswer(["a", "b"])) }), async (baseUrl, log) => {
			await put({ id: "custom:pages-svc", baseUrl, apiKey: KEY, select: true });
			credentials.writeProfileCredential("custom:pages-svc", baseUrl, "sk-live-12\u0001345678");
			const material = await upload("badkey.pdf");
			assert.equal(material.conversionError?.kind, "auth");
			assert.match(material.conversionError?.message ?? "", /enter the key again/);
			assert.equal(material.conversionWarnings?.some((w) => /built-in reader/.test(w)) ?? false, false);
			assert.equal(log.length, 0);
		});
	});

	it("saving the same URL written differently keeps the key (URLs compare canonically)", async () => {
		writeProfileFile("pages-svc.json", pageArrayProfile());
		await put({ id: "custom:pages-svc", baseUrl: "https://api.example.com", apiKey: KEY });
		const res = await putJson({ id: "custom:pages-svc", baseUrl: "HTTPS://API.EXAMPLE.COM/" });
		assert.equal(res.status, 200);
		assert.equal(entry(res.body, "custom:pages-svc").credential.stored, true);
		assert.equal(credentials.readProfileCredential("custom:pages-svc", "https://api.example.com"), KEY);
	});
});

describe("the generic settings route cannot change a service URL", () => {
	const putSection = (body: unknown) =>
		settingsRoute.PUT(new Request("http://localhost/api/settings/pdfConversion", { method: "PUT", body: JSON.stringify(body) }), { params: Promise.resolve({ section: "pdfConversion" }) });

	it("refuses a changed Docling or profile URL (the key bound to the old one stays out of reach), allows everything else", async () => {
		await put({ id: "docling", baseUrl: "http://docling.lan:5001", apiKey: "docling-key-1234" });
		writeProfileFile("pages-svc.json", pageArrayProfile());
		await put({ id: "custom:pages-svc", baseUrl: "https://api.example.com", apiKey: KEY });
		const current = readSettings()!.pdfConversion!;
		const moved = await putSection({ ...current, docling: { ...current.docling, baseUrl: "http://evil.example:5001" } });
		assert.equal(moved.status, 400);
		assert.match(((await moved.json()) as { error: string }).error, /Service URLs are changed in Settings → PDF conversion/);
		assert.equal((await putSection({ ...current, services: { "custom:pages-svc": { baseUrl: "https://evil.example" } } })).status, 400);
		assert.equal((await putSection({ ...current, services: {} })).status, 400, "removing a URL is a change too");
		assert.deepEqual(readSettings()!.pdfConversion, current);
		const same = await putSection({ ...current, docling: { ...current.docling, baseUrl: "HTTP://DOCLING.LAN:5001/", ocr: false } });
		assert.equal(same.status, 200, "the same URL written differently and other fields are fine");
		assert.equal(readSettings()!.pdfConversion!.docling!.ocr, false);
	});
});

describe("the Test route", () => {
	const post = (id: string, init: { signal?: AbortSignal } = {}) =>
		testRoute.POST(new Request("http://localhost/api/converters/test", { method: "POST", body: JSON.stringify({ id }), ...init }));

	it("reads a custom profile file once", async () => {
		writeProfileFile("pages-svc.json", pageArrayProfile());
		await withServer(routes({ "POST /convert": (_q, r) => json(r, pagesAnswer(["a", "b"])) }), async (baseUrl) => {
			await put({ id: "custom:pages-svc", baseUrl, apiKey: KEY });
			const original = fs.readFileSync;
			let reads = 0;
			fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
				if (String(file).endsWith("pages-svc.json")) reads++;
				return (original as (...args: unknown[]) => unknown)(file, ...rest);
			}) as typeof fs.readFileSync;
			try {
				const res = await post("custom:pages-svc");
				assert.equal(res.status, 200);
			} finally {
				fs.readFileSync = original;
			}
			assert.equal(reads, 1);
		});
	});

	it("is stopped on the server when its request is aborted", { timeout: 20_000 }, async () => {
		writeProfileFile("pages-svc.json", pageArrayProfile());
		let closed: () => void = () => {};
		const socketClosed = new Promise<void>((resolve) => { closed = resolve; });
		await withServer((req) => { req.socket.on("close", () => closed()); }, async (baseUrl, log) => {
			await put({ id: "custom:pages-svc", baseUrl, apiKey: KEY });
			const controller = new AbortController();
			const pending = post("custom:pages-svc", { signal: controller.signal });
			while (log.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
			const started = Date.now();
			controller.abort();
			const res = await pending;
			assert.equal(res.status, 499);
			await socketClosed;
			assert.ok(Date.now() - started < 5_000);
			assert.equal(log.length, 1);
		});
	});

	it("has its own two-minute deadline (shortened here) and reports a timeout", { timeout: 20_000 }, async () => {
		writeProfileFile("pages-svc.json", pageArrayProfile());
		await withServer(() => {}, async (baseUrl) => {
			await put({ id: "custom:pages-svc", baseUrl, apiKey: KEY });
			const result = await settingsService.testConverter("custom:pages-svc", new AbortController().signal, 300);
			assert.ok(result.ok);
			const report = (result as { value: ConverterValidationReport }).value;
			assert.equal(report.error?.kind, "timeout");
			assert.match(report.checks[0]!.message, /did not finish within/);
		});
	});

	it("an unreachable service is reported, never tested as the built-in reader", async () => {
		writeProfileFile("pages-svc.json", pageArrayProfile());
		await put({ id: "custom:pages-svc", baseUrl: await closedBaseUrl(), apiKey: KEY });
		const report = (await (await post("custom:pages-svc")).json()) as ConverterValidationReport;
		assert.equal(report.converterId, "custom:pages-svc");
		assert.equal(report.error?.kind, "unreachable");
	});
});

describe("every /api/converters route is behind the app's request guard", () => {
	const ENV = ["LH_DESKTOP_SERVER", "LH_DESKTOP_API_SECRET", "LH_ACCESS_TOKEN", "LH_ALLOWED_HOSTS"] as const;
	function withEnv(values: Partial<Record<(typeof ENV)[number], string>>, run: () => void): void {
		const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
		for (const k of ENV) {
			if (values[k] === undefined) delete process.env[k];
			else process.env[k] = values[k];
		}
		try {
			run();
		} finally {
			for (const k of ENV) {
				if (saved[k] === undefined) delete process.env[k];
				else process.env[k] = saved[k];
			}
		}
	}
	const writes: [string, string][] = [["PUT", "/api/converters"], ["POST", "/api/converters/test"], ["POST", "/api/converters/profiles"], ["DELETE", "/api/converters/profiles?id=custom:x"]];

	it("browser-only mode: a cross-site write is refused; a same-origin one passes", () => {
		withEnv({}, () => {
			for (const [method, route] of writes) {
				const cross = proxy(new NextRequest(`http://localhost:3000${route}`, { method, headers: { host: "localhost:3000", origin: "https://evil.example", "sec-fetch-site": "cross-site" } }));
				assert.equal(cross.status, 403, `${method} ${route}`);
				const same = proxy(new NextRequest(`http://localhost:3000${route}`, { method, headers: { host: "localhost:3000", origin: "http://localhost:3000", "sec-fetch-site": "same-origin" } }));
				assert.equal(same.headers.get("x-middleware-next"), "1", `${method} ${route}`);
			}
			const rebind = proxy(new NextRequest("http://rebind.attacker.example:3000/api/converters", { headers: { host: "rebind.attacker.example:3000" } }));
			assert.equal(rebind.status, 403, "a DNS-rebinding host cannot even read the overview");
		});
	});

	it("desktop mode: every converter route needs the window's capability", () => {
		withEnv({ LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: "s".repeat(64) }, () => {
			for (const [method, route] of [["GET", "/api/converters"], ...writes] as [string, string][]) {
				const res = proxy(new NextRequest(`http://127.0.0.1:3000${route}`, { method, headers: { host: "127.0.0.1:3000" } }));
				assert.equal(res.status, 403, `${method} ${route}`);
			}
		});
	});
});
