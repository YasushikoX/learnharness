import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { tinyPdf } from "./helpers/tiny-pdf.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-pdf-material-"));
process.env.LH_DATA_DIR = TMP;
const { chatStore } = await import("../src/store/chats.ts");
const { materialStore } = await import("../src/store/materials.ts");
const service = await import("../src/server/materials.ts");
const { ensureMaterialContent, PDF_CONVERSION_SIDECAR } = await import("../src/server/material-conversion.ts");
const { materialTools } = await import("../src/agent/tools/materials.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const bytes = tinyPdf([{ runs: [{ text: "Original pdfjs text", x: 72, y: 700 }] }, { image: true }]);

async function call(tool: { execute: (...args: never[]) => Promise<unknown> }, args: unknown): Promise<string> {
	const result = await (tool.execute as (id: string, args: unknown) => Promise<{ content: { text: string }[] }>)("call", args);
	return result.content.map((part) => part.text).join("");
}

describe("material PDF conversion and lookup", () => {
	it("the upload hook writes content and one sidecar, then skips an unchanged source", async () => {
		const chat = chatStore.createChat("Converted PDF");
		const added = service.addUploadedMaterial(chat.id, { name: "tiny.pdf", type: "application/pdf", bytes });
		assert.ok(added.ok);
		if (!added.ok) return;
		await service.waitForMaterials(chat.id, 5000);
		const contentPath = materialStore.auxPath(chat.id, added.value.id, "content.md");
		const sidecarPath = materialStore.auxPath(chat.id, added.value.id, PDF_CONVERSION_SIDECAR);
		assert.match(fs.readFileSync(contentPath, "utf8"), /Original pdfjs text/);
		const firstSidecar = fs.readFileSync(sidecarPath, "utf8");
		const sidecar = JSON.parse(firstSidecar);
		assert.equal(sidecar.converterId, "pdfjs");
		assert.equal(sidecar.converterVersion, "1");
		assert.match(sidecar.sourceHash, /^[a-f0-9]{64}$/);
		assert.deepEqual(sidecar.failedPages, [{
			page: 2,
			status: "empty",
			reason: "No extractable text; this page looks like a scan and needs an OCR converter.",
		}]);
		let conversions = 0;
		await ensureMaterialContent(chat.id, added.value, new AbortController().signal, async () => {
			conversions++;
			throw new Error("unchanged input was converted again");
		});
		assert.equal(conversions, 0);
		assert.equal(fs.readFileSync(sidecarPath, "utf8"), firstSidecar);
	});

	it("lookup tools prefer content.md, while an older material falls back to pdfjs", async () => {
		const chat = chatStore.createChat("Stored content");
		const converted = materialStore.add(chat.id, { kind: "pdf", name: "converted.pdf", ext: ".pdf", bytes });
		fs.writeFileSync(materialStore.auxPath(chat.id, converted.id, "content.md"), "--- Page 1 ---\nUNIQUE-STORED-TEXT\n\\--- Page 9 ---", "utf8");
		const older = materialStore.add(chat.id, { kind: "pdf", name: "older.pdf", ext: ".pdf", bytes });
		const tools = materialTools({ chatId: chat.id, store: materialStore });
		assert.match(await call(tools.material_read!, { material: converted.id, pages: "1" }), /UNIQUE-STORED-TEXT\n--- Page 9 ---/);
		assert.match(await call(tools.material_search!, { query: "UNIQUE-STORED", literal: true }), /\[converted.pdf, p. 1\]/);
		assert.match(await call(tools.material_read!, { material: older.id, pages: "1" }), /Original pdfjs text/);
	});

	it("a conversion failure is visible with its error kind", async () => {
		const chat = chatStore.createChat("Broken PDF");
		const added = service.addUploadedMaterial(chat.id, { name: "broken.pdf", type: "application/pdf", bytes: new TextEncoder().encode("not a pdf") });
		assert.ok(added.ok);
		await service.waitForMaterials(chat.id, 5000);
		const material = service.listMaterials(chat.id)[0];
		assert.equal(material?.status, "error");
		assert.equal(material?.conversionError, "bad_response");
		assert.match(material?.error ?? "", /\[bad_response\]/);
	});
});
