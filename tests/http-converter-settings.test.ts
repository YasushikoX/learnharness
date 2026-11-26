import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { closedBaseUrl, withServer, type LoggedRequest } from "./helpers/docling-server.ts";
import { KEY, json, pageArrayProfile, pagesAnswer, routes } from "./helpers/converter-services.ts";

/**
 * Profile converters in the app: credentials bound to a URL and kept out of the environment, presets and custom
 * profile files in the registry, the Settings API (app/api/converters/), and the upload path end to end with the
 * fallback rules unchanged.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-http-converters-"));
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
process.env.LH_DATA_DIR = path.join(TMP, "data");
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const { CONVERTER_CREDENTIALS, DOCLING_API_KEY } = await import("../src/core/pdf-converter.ts");
const credentials = await import("../src/server/converters/credentials.ts");
const store = await import("../src/store/auth.ts");
const { readSettings, writeSettings } = await import("../src/store/settings.ts");
const { resolvePdfConverter } = await import("../src/server/converters/registry.ts");
const custom = await import("../src/server/converters/custom-profiles.ts");
const { parsePdfConversionSettingsBody } = await import("../src/server/settings-body.ts");
const { sanitizeUserSettings } = await import("../src/core/settings.ts");
const convertersRoute = await import("../app/api/converters/route.ts");
const testRoute = await import("../app/api/converters/test/route.ts");
const profilesRoute = await import("../app/api/converters/profiles/route.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { materialStore } = await import("../src/store/materials.ts");
const service = await import("../src/server/materials.ts");
const { convertMaterialPdf, PDF_CONTENT_FILE, PDF_CONVERSION_SIDECAR } = await import("../src/server/material-conversion.ts");
const { validationPdf } = await import("../src/server/converters/validation-fixture.ts");
type ConvertersOverview = import("../src/core/converter-settings.ts").ConvertersOverview;
type ConverterValidationReport = import("../src/core/converter-settings.ts").ConverterValidationReport;

const settingsFile = () => path.join(process.env.LH_DATA_DIR!, "settings.json");
const readText = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
const profileDir = () => custom.convertersDir();

function reset(): void {
	fs.rmSync(process.env.LH_AUTH_FILE!, { force: true });
	fs.rmSync(profileDir(), { recursive: true, force: true });
	writeSettings({ version: 1 });
}
beforeEach(reset);

function writeProfileFile(name: string, content: unknown): void {
	fs.mkdirSync(profileDir(), { recursive: true });
	fs.writeFileSync(path.join(profileDir(), name), typeof content === "string" ? content : JSON.stringify(content));
}

const put = (body: unknown) => convertersRoute.PUT(new Request("http://localhost/api/converters", { method: "PUT", body: JSON.stringify(body) }));
const overview = async () => (await (await convertersRoute.GET()).json()) as ConvertersOverview;

describe("profile converter credentials", () => {
	it("are bound to the canonical URL, never reused at another, and only written through their own writer", () => {
		credentials.writeProfileCredential("mistral-ocr", "https://api.mistral.ai/", KEY);
		assert.equal(credentials.readProfileCredential("mistral-ocr", "https://api.mistral.ai"), KEY);
		assert.equal(credentials.readProfileCredential("mistral-ocr", "https://proxy.example"), undefined);
		assert.equal(credentials.readProfileCredential("custom:other", "https://api.mistral.ai"), undefined);
		const raw = JSON.parse(readText(process.env.LH_AUTH_FILE!)) as Record<string, string>;
		assert.deepEqual(JSON.parse(raw[CONVERTER_CREDENTIALS]!), { "mistral-ocr": { baseUrl: "https://api.mistral.ai", apiKey: KEY } });
		assert.equal((fs.statSync(process.env.LH_AUTH_FILE!).mode & 0o777).toString(8), "600");
		assert.throws(() => store.authStore.setAuthVar(CONVERTER_CREDENTIALS, "{}"), /PDF converter credential writer/);
		credentials.writeProfileCredential("mistral-ocr", "", undefined);
		assert.equal(credentials.readProfileCredential("mistral-ocr", "https://api.mistral.ai"), undefined);
	});

	it("never reach process.env, the key list, keyValue or a child process; the generic key API refuses them", async () => {
		credentials.writeProfileCredential("mistral-ocr", "https://api.mistral.ai", KEY);
		store.authStore.setAuthVar("TAVILY_API_KEY", "tvly-ordinary-key-1234567890");
		const keys = await import("../src/server/keys.ts");
		keys.initAuthEnv();
		assert.equal(process.env[CONVERTER_CREDENTIALS], undefined);
		assert.equal(Object.values(process.env).some((v) => v?.includes(KEY)), false);
		assert.equal(process.env.TAVILY_API_KEY, "tvly-ordinary-key-1234567890");
		assert.equal(keys.keyStatuses().some((row) => row.id === CONVERTER_CREDENTIALS), false);
		assert.equal(JSON.stringify(keys.keyStatuses()).includes(KEY.slice(-4)), false);
		assert.equal(keys.keyValue(CONVERTER_CREDENTIALS), undefined);
		assert.equal(keys.saveKey(CONVERTER_CREDENTIALS, "x").ok, false);
		assert.throws(() => keys.deleteKey(CONVERTER_CREDENTIALS));
		const child = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], { env: { ...process.env }, encoding: "utf8" });
		assert.equal(child.status, 0);
		assert.equal(child.stdout.includes(KEY), false);
		assert.equal(CONVERTER_CREDENTIALS in (JSON.parse(child.stdout) as object), false);
	});

	it("a damaged credential record is refused, not overwritten", () => {
		fs.writeFileSync(process.env.LH_AUTH_FILE!, JSON.stringify({ [CONVERTER_CREDENTIALS]: "{not json" }));
		assert.throws(() => credentials.writeProfileCredential("mistral-ocr", "https://api.mistral.ai", KEY), /Invalid PDF converter credential record/);
		assert.match(readText(process.env.LH_AUTH_FILE!), /\{not json/);
	});
});

describe("presets and custom profiles in the registry", () => {
	it("a preset without a saved URL or without a key falls back to pdfjs with a warning; with both it resolves", () => {
		credentials.writeProfileCredential("mistral-ocr", "https://api.mistral.ai", KEY);
		const unsaved = resolvePdfConverter({ converter: "mistral-ocr" }, credentials.readConverterCredential);
		assert.equal(unsaved.converter.id, "pdfjs", "the preset's own address counts only once it is saved");
		assert.match(unsaved.warnings[0]!, /Mistral OCR is not set up: no service URL is saved for it .*; the built-in reader \(pdfjs\) was used instead\./);
		credentials.writeProfileCredential("mistral-ocr", "", undefined);
		const saved = { converter: "mistral-ocr", services: { "mistral-ocr": { baseUrl: "https://api.mistral.ai" } } };
		const without = resolvePdfConverter(saved, credentials.readConverterCredential);
		assert.equal(without.converter.id, "pdfjs");
		assert.match(without.warnings[0]!, /Mistral OCR needs an API key for https:\/\/api\.mistral\.ai; the built-in reader \(pdfjs\) was used instead\./);
		credentials.writeProfileCredential("mistral-ocr", "https://api.mistral.ai", KEY);
		const withKey = resolvePdfConverter(saved, credentials.readConverterCredential);
		assert.equal(withKey.converter.id, "mistral-ocr");
		assert.equal(withKey.converter.label, "Mistral OCR");
		const moved = resolvePdfConverter({ converter: "mistral-ocr", services: { "mistral-ocr": { baseUrl: "https://proxy.example" } } }, credentials.readConverterCredential);
		assert.equal(moved.converter.id, "pdfjs", "a key bound to another URL is not sent to the new one");
	});

	it("a custom profile file is loaded and validated on every resolve: valid, then changed, then invalid, then gone", () => {
		writeProfileFile("pages-svc.json", pageArrayProfile(1, { auth: undefined }));
		const keyless = pageArrayProfile(1);
		delete keyless.auth;
		writeProfileFile("pages-svc.json", keyless);
		const settings = { converter: "custom:pages-svc", services: { "custom:pages-svc": { baseUrl: "http://127.0.0.1:9" } } };
		const first = resolvePdfConverter(settings, credentials.readConverterCredential, custom.loadCustomProfile);
		assert.equal(first.converter.id, "custom:pages-svc");
		writeProfileFile("pages-svc.json", { ...keyless, version: "2" });
		const changed = resolvePdfConverter(settings, credentials.readConverterCredential, custom.loadCustomProfile);
		assert.notEqual(changed.converter.version, first.converter.version, "a changed file is a new converter version");
		writeProfileFile("pages-svc.json", { ...keyless, submit: { ...keyless.submit, path: "https://evil.example/steal" } });
		const invalid = resolvePdfConverter(settings, credentials.readConverterCredential, custom.loadCustomProfile);
		assert.equal(invalid.converter.id, "pdfjs");
		assert.match(invalid.warnings[0]!, /Your PDF converter profile "pages-svc" could not be used \(pages-svc\.json: \/submit\/path: must start with \/.*\); the built-in reader \(pdfjs\) was used instead\./);
		fs.rmSync(path.join(profileDir(), "pages-svc.json"));
		assert.match(resolvePdfConverter(settings, credentials.readConverterCredential, custom.loadCustomProfile).warnings[0]!, /does not exist/);
	});

	it("lists invalid files with their reasons and never uses them", () => {
		writeProfileFile("broken.json", "{ nope");
		writeProfileFile("other-name.json", { ...pageArrayProfile(), id: "pages-svc" });
		writeProfileFile("Bad Name.json", pageArrayProfile());
		const listing = custom.listCustomProfiles();
		assert.deepEqual(listing.profiles, []);
		assert.deepEqual(listing.invalid.map((i) => i.file), ["Bad Name.json", "broken.json", "other-name.json"]);
		assert.match(listing.invalid[1]!.errors[0]!, /Not valid JSON/);
		assert.match(listing.invalid[2]!.errors[0]!, /differs from its file name/);
	});

	it("the settings section accepts custom ids and service URLs and never carries a key", () => {
		const parsed = parsePdfConversionSettingsBody({ converter: "custom:pages-svc", services: { "mistral-ocr": { baseUrl: "https://proxy.example/" }, "custom:pages-svc": {} } });
		assert.deepEqual(parsed, { ok: true, settings: { converter: "custom:pages-svc", services: { "mistral-ocr": { baseUrl: "https://proxy.example" }, "custom:pages-svc": {} } } });
		assert.equal(parsePdfConversionSettingsBody({ converter: "custom:../x" }).ok, false);
		assert.equal(parsePdfConversionSettingsBody({ services: { "mistral-ocr": { baseUrl: "ftp://x" } } }).ok, false);
		const sanitized = sanitizeUserSettings({ version: 1, pdfConversion: { services: { "mistral-ocr": { baseUrl: "https://a.example/", apiKey: KEY }, "../x": {} } } });
		assert.deepEqual(sanitized?.pdfConversion, { services: { "mistral-ocr": { baseUrl: "https://a.example" } } });
	});
});

describe("Settings API: /api/converters", () => {
	it("lists every converter with where PDFs go, the unverified preset, and the key status only", async () => {
		const view = await overview();
		assert.equal(view.selected, "pdfjs");
		assert.deepEqual(view.converters.map((c) => c.id), ["pdfjs", "docling", "gemini", "mistral-ocr"]);
		const mistral = view.converters.find((c) => c.id === "mistral-ocr")!;
		assert.equal(mistral.unverified, true);
		assert.equal(mistral.origin, "https://api.mistral.ai");
		assert.deepEqual(mistral.credential, { stored: false });
		assert.equal(view.converters[0]!.local, true);
	});

	it("stores a key bound to the URL, never returns it (only the last four of a long key), and keeps it out of settings.json", async () => {
		const res = await put({ id: "mistral-ocr", apiKey: KEY, select: true });
		assert.equal(res.status, 200);
		const text = await res.text();
		assert.equal(text.includes(KEY), false);
		const view = JSON.parse(text) as ConvertersOverview;
		assert.equal(view.selected, "mistral-ocr");
		assert.deepEqual(view.converters.find((c) => c.id === "mistral-ocr")!.credential, { stored: true, hint: "…WXYZ" });
		assert.equal(readText(settingsFile()).includes(KEY), false);
		assert.equal(JSON.stringify(await overview()).includes(KEY), false);
		assert.equal(credentials.readProfileCredential("mistral-ocr", "https://api.mistral.ai"), KEY);
	});

	it("changing a service URL without a key removes the stored key (re-approval)", async () => {
		await put({ id: "mistral-ocr", apiKey: KEY });
		const view = (await (await put({ id: "mistral-ocr", baseUrl: "https://proxy.example/" })).json()) as ConvertersOverview;
		const entry = view.converters.find((c) => c.id === "mistral-ocr")!;
		assert.equal(entry.origin, "https://proxy.example");
		assert.deepEqual(entry.credential, { stored: false });
		assert.equal(readText(process.env.LH_AUTH_FILE!).includes(KEY), false);
		assert.deepEqual(readSettings()?.pdfConversion?.services, { "mistral-ocr": { baseUrl: "https://proxy.example" } });
	});

	it("Docling: URL, options and an optional key; an unchanged URL keeps the key; a short key shows no characters", async () => {
		await put({ id: "docling", baseUrl: "http://docling.lan:5001/", apiKey: "short-key-1", ocr: false });
		await put({ id: "docling", formulaEnrichment: true });
		const docling = (await overview()).converters.find((c) => c.id === "docling")!;
		assert.deepEqual(docling.options, { ocr: false, formulaEnrichment: true });
		assert.deepEqual(docling.credential, { stored: true });
		assert.equal(JSON.parse(readText(process.env.LH_AUTH_FILE!))[DOCLING_API_KEY], "short-key-1");
		await put({ id: "docling", removeKey: true });
		assert.deepEqual((await overview()).converters.find((c) => c.id === "docling")!.credential, { stored: false });
	});

	it("refuses unknown fields, unknown converters, keys for the built-in reader and bad URLs", async () => {
		assert.equal((await put({ id: "mistral-ocr", token: "x" })).status, 400);
		assert.equal((await put({ id: "nope" })).status, 400);
		assert.equal((await put({ id: "custom:missing" })).status, 409);
		assert.equal((await put({ id: "pdfjs", apiKey: "x" })).status, 400);
		assert.equal((await put({ id: "mistral-ocr", baseUrl: "https://u:p@x.example" })).status, 400);
		assert.equal((await put({ id: "mistral-ocr", apiKey: "a\nb" })).status, 400);
	});

	it("imports a profile (validation errors shown), lists it, and removes it with its key and selection", async () => {
		const bad = await profilesRoute.POST(new Request("http://localhost/api/converters/profiles", { method: "POST", body: JSON.stringify({ profile: JSON.stringify({ ...pageArrayProfile(), extra: 1 }) }) }));
		assert.equal(bad.status, 400);
		assert.ok(((await bad.json()) as { errors: string[] }).errors.length > 0);
		const good = await profilesRoute.POST(new Request("http://localhost/api/converters/profiles", { method: "POST", body: JSON.stringify({ profile: JSON.stringify(pageArrayProfile(), null, 2) }) }));
		assert.equal(good.status, 200);
		assert.equal(((await good.json()) as { id: string }).id, "custom:pages-svc");
		assert.ok(fs.existsSync(path.join(profileDir(), "pages-svc.json")));
		await put({ id: "custom:pages-svc", baseUrl: "http://127.0.0.1:9", apiKey: KEY, select: true });
		const removed = await profilesRoute.DELETE(new Request("http://localhost/api/converters/profiles?id=custom:pages-svc", { method: "DELETE" }));
		assert.equal(removed.status, 200);
		const view = (await removed.json()) as ConvertersOverview;
		assert.equal(view.selected, "pdfjs");
		assert.equal(readText(process.env.LH_AUTH_FILE!).includes(KEY), false);
		assert.equal(readSettings()?.pdfConversion?.services?.["custom:pages-svc"], undefined);
	});

	it("Test runs the validator on the saved configuration and never falls back to pdfjs", async () => {
		const post = (id: string) => testRoute.POST(new Request("http://localhost/api/converters/test", { method: "POST", body: JSON.stringify({ id }) }));
		const pdfjs = (await (await post("pdfjs")).json()) as ConverterValidationReport;
		assert.equal(pdfjs.ok, true);
		const unconfigured = await post("mistral-ocr");
		assert.equal(unconfigured.status, 400);
		assert.match(((await unconfigured.json()) as { error: string }).error, /Mistral OCR is not set up/);
		writeProfileFile("pages-svc.json", pageArrayProfile());
		await withServer(routes({ "POST /convert": (_q, r) => json(r, pagesAnswer([`${KEY} oops`, "nothing"])) }), async (baseUrl) => {
			await put({ id: "custom:pages-svc", baseUrl, apiKey: KEY });
			const res = await post("custom:pages-svc");
			const text = await res.text();
			assert.equal(text.includes(KEY), false);
			const report = JSON.parse(text) as ConverterValidationReport;
			assert.equal(report.ok, false);
			assert.equal(report.checks.find((c) => c.id === "no_secret")!.status, "fail");
		});
		const closed = await closedBaseUrl();
		await put({ id: "custom:pages-svc", baseUrl: closed, apiKey: KEY });
		const unreachable = (await (await post("custom:pages-svc")).json()) as ConverterValidationReport;
		assert.equal(unreachable.checks[0]!.status, "fail");
		assert.equal(unreachable.error?.kind, "unreachable");
	});
});

describe("the upload path with a custom profile", () => {
	async function upload(name: string): Promise<{ chatId: string; material: import("../src/core/materials.ts").LessonMaterial }> {
		const chat = chatStore.createChat(name);
		const added = service.addUploadedMaterial(chat.id, { name, type: "application/pdf", bytes: validationPdf() });
		assert.ok(added.ok);
		if (!added.ok) throw new Error("upload refused");
		await service.waitForMaterials(chat.id, 30_000);
		return { chatId: chat.id, material: service.listMaterials(chat.id).find((m) => m.id === added.value.id)! };
	}
	const aux = (chatId: string, id: string, file: string) => materialStore.auxPath(chatId, id, file);
	const uploads = (log: LoggedRequest[]) => log.filter((r) => r.url === "/convert").length;

	it("converts through the profile, records it in the sidecar without the key, and does not upload an unchanged PDF again", async () => {
		writeProfileFile("pages-svc.json", pageArrayProfile());
		await withServer(routes({ "POST /convert": (_q, r) => json(r, pagesAnswer(["Profile page one", "Profile page two"])) }), async (baseUrl, log) => {
			await put({ id: "custom:pages-svc", baseUrl, apiKey: KEY, select: true });
			const { chatId, material } = await upload("profile.pdf");
			const content = readText(aux(chatId, material.id, PDF_CONTENT_FILE));
			assert.equal(content, "--- Page 1 ---\nProfile page one\n--- Page 2 ---\nProfile page two");
			const sidecarText = readText(aux(chatId, material.id, PDF_CONVERSION_SIDECAR));
			const sidecar = JSON.parse(sidecarText) as { requested: { converterId: string }; converterId: string };
			assert.equal(sidecar.requested.converterId, "custom:pages-svc");
			assert.equal(sidecar.converterId, "custom:pages-svc");
			assert.equal(sidecarText.includes(KEY), false);
			assert.equal(material.conversionError, undefined);
			const again = await convertMaterialPdf(chatId, material, { signal: new AbortController().signal, store: materialStore, settings: readSettings()?.pdfConversion });
			assert.equal(again.status, "unchanged");
			assert.equal(uploads(log), 1);
		});
	});

	it("an unreachable profile service falls back to pdfjs with a warning naming it", async () => {
		writeProfileFile("pages-svc.json", pageArrayProfile());
		await put({ id: "custom:pages-svc", baseUrl: await closedBaseUrl(), apiKey: KEY, select: true });
		const { chatId, material } = await upload("down.pdf");
		assert.equal(material.conversionError, undefined);
		assert.match(material.conversionWarnings?.[0] ?? "", /^Pages Service failed \(Could not reach Pages Service/);
		assert.match(readText(aux(chatId, material.id, PDF_CONTENT_FILE)), /heron/);
	});

	it("a refused key is the material's conversion error, with no fallback and no second upload", async () => {
		writeProfileFile("pages-svc.json", pageArrayProfile());
		await withServer((_q, r) => json(r, { message: "bad key" }, 401), async (baseUrl, log) => {
			await put({ id: "custom:pages-svc", baseUrl, apiKey: KEY, select: true });
			const { chatId, material } = await upload("auth.pdf");
			assert.equal(material.conversionError?.kind, "auth");
			assert.match(material.conversionError?.message ?? "", /Pages Service refused the key \(HTTP 401\): bad key/);
			assert.equal(fs.existsSync(aux(chatId, material.id, PDF_CONTENT_FILE)), false);
			assert.equal(uploads(log), 1);
		});
	});

	it("a selected profile whose file became invalid falls back to pdfjs with a warning", async () => {
		writeProfileFile("pages-svc.json", pageArrayProfile());
		await put({ id: "custom:pages-svc", baseUrl: "http://127.0.0.1:9", apiKey: KEY, select: true });
		writeProfileFile("pages-svc.json", { ...pageArrayProfile(), unexpected: true });
		const { material } = await upload("invalid.pdf");
		assert.equal(material.conversionError, undefined);
		assert.match(material.conversionWarnings?.[0] ?? "", /Your PDF converter profile "pages-svc" could not be used/);
	});
});
