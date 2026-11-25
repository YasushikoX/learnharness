import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-docling-auth-"));
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
const auth = await import("../src/server/converters/auth.ts");
const store = await import("../src/store/auth.ts");
const { DOCLING_API_KEY, DOCLING_AUTH_BINDING } = await import("../src/core/pdf-converter.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

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
});
