import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-docling-auth-"));
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
process.env.LH_DATA_DIR = path.join(TMP, "data");
delete process.env.DOCLING_API_KEY;
const auth = await import("../src/server/converters/auth.ts");
const store = await import("../src/store/auth.ts");
const { readSettings } = await import("../src/store/settings.ts");
const { DOCLING_API_KEY, DOCLING_AUTH_BINDING } = await import("../src/core/pdf-converter.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const SECRET = "docling-secret-7f3a9c";

describe("Docling credentials", () => {
	it("binds the key to the canonical URL and never reuses it at another URL", () => {
		auth.writeDoclingCredential("http://localhost:5001/", "secret");
		assert.equal(auth.readDoclingCredential("http://localhost:5001"), "secret");
		assert.equal(auth.readDoclingCredential("http://localhost:5001/"), "secret");
		assert.equal(auth.readDoclingCredential("http://other.example:5001"), undefined);
		const raw = JSON.parse(fs.readFileSync(process.env.LH_AUTH_FILE!, "utf8"));
		assert.equal(raw[DOCLING_API_KEY], "secret");
		assert.equal(raw[DOCLING_AUTH_BINDING], "http://localhost:5001");
		assert.throws(() => store.authStore.setAuthVar(DOCLING_API_KEY, "unbound"), /Docling credential writer/);
		auth.writeDoclingCredential("http://localhost:5001", undefined);
		assert.equal(auth.readDoclingCredential("http://localhost:5001"), undefined);
	});

	it("configureDocling stores the key in auth.json only and the URL in the settings", () => {
		assert.equal(auth.configureDocling({ baseUrl: "http://docling.lan:5001/", apiKey: ` ${SECRET} ` }), "http://docling.lan:5001");
		assert.equal(auth.readDoclingCredential("http://docling.lan:5001"), SECRET);
		assert.deepEqual(readSettings()?.pdfConversion, { converter: "docling", docling: { baseUrl: "http://docling.lan:5001" } });
		const settingsText = fs.readFileSync(path.join(process.env.LH_DATA_DIR!, "settings.json"), "utf8");
		assert.equal(settingsText.includes(SECRET), false);
		assert.equal((fs.statSync(process.env.LH_AUTH_FILE!).mode & 0o777).toString(8), "600");
	});

	it("F3: the key and its binding never reach process.env, the key list or a child process", async () => {
		auth.configureDocling({ baseUrl: "http://docling.lan:5001", apiKey: SECRET });
		store.authStore.setAuthVar("TAVILY_API_KEY", "tvly-ordinary-key-1234567890");
		const keys = await import("../src/server/keys.ts"); // its import runs initAuthEnv
		keys.initAuthEnv(); // and again, as after a hot reload
		assert.equal(process.env[DOCLING_API_KEY], undefined);
		assert.equal(process.env[DOCLING_AUTH_BINDING], undefined);
		assert.equal(process.env.TAVILY_API_KEY, "tvly-ordinary-key-1234567890", "ordinary keys are still reflected");
		const ids = keys.keyStatuses().map((row) => row.id);
		assert.equal(ids.includes(DOCLING_API_KEY), false);
		assert.equal(ids.includes(DOCLING_AUTH_BINDING), false);
		assert.ok(ids.includes("TAVILY_API_KEY"));
		assert.equal(JSON.stringify(keys.keyStatuses()).includes(SECRET.slice(-4)), false);
		assert.equal(keys.keyValue(DOCLING_API_KEY), undefined);
		assert.equal(keys.saveKey(DOCLING_API_KEY, "x").ok, false);
		assert.throws(() => keys.deleteKey(DOCLING_AUTH_BINDING), /Docling/);
		const child = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], { env: { ...process.env }, encoding: "utf8" });
		assert.equal(child.status, 0);
		const childEnv = JSON.parse(child.stdout) as Record<string, string>;
		assert.equal(DOCLING_API_KEY in childEnv, false);
		assert.equal(DOCLING_AUTH_BINDING in childEnv, false);
		assert.equal(child.stdout.includes(SECRET), false);
		assert.equal(auth.readDoclingCredential("http://docling.lan:5001"), SECRET, "the converter still reads it from the store");
	});

	it("the setup script stores the URL and key from the environment without printing the key", () => {
		const script = path.join(import.meta.dirname, "..", "scripts", "docling-credential.ts");
		const env = { ...process.env, DOCLING_BASE_URL: "http://script.lan:5001/", DOCLING_API_KEY: "script-secret-55aa" };
		const run = spawnSync(process.execPath, ["--import", "tsx", script], { cwd: path.join(import.meta.dirname, ".."), env, encoding: "utf8" });
		assert.equal(run.status, 0, run.stderr);
		assert.match(run.stdout, /Docling URL: http:\/\/script\.lan:5001/);
		assert.match(run.stdout, /Docling key: stored/);
		assert.equal(`${run.stdout}${run.stderr}`.includes("script-secret-55aa"), false);
		assert.equal(auth.readDoclingCredential("http://script.lan:5001"), "script-secret-55aa");
		assert.equal(readSettings()?.pdfConversion?.docling?.baseUrl, "http://script.lan:5001");
	});
});
