import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { tinyPdf } from "./helpers/tiny-pdf.ts";
import { closedBaseUrl, fakeDocling, json, recordedPdf, recordedResponse, withServer, type LoggedRequest } from "./helpers/docling-server.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-pdf-material-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
const { chatStore } = await import("../src/store/chats.ts");
const { materialStore } = await import("../src/store/materials.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const service = await import("../src/server/materials.ts");
const { convertMaterialPdf, PDF_CONTENT_FILE, PDF_CONVERSION_SIDECAR, PDF_CONVERSION_SUBMITTED } = await import("../src/server/material-conversion.ts");
const { materialTools } = await import("../src/agent/tools/materials.ts");
const { pdfExtract, pdfSearch } = await import("../src/agent/subagents/pdf-ops.ts");
const { materialStatusLine } = await import("../components/materials-control.tsx");
type LessonMaterial = import("../src/core/materials.ts").LessonMaterial;
type PdfConversionSettings = import("../src/core/settings.ts").PdfConversionSettings;

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const textAndScan = tinyPdf([{ runs: [{ text: "Original pdfjs text", x: 72, y: 700 }] }, { image: true }]);
const scanned = tinyPdf([{ image: true }, { image: "inline" }]);
const NO_VISION = /no vision model is configured/;

function settings(pdfConversion: PdfConversionSettings | undefined): void {
	writeSettings({ version: 1, ...(pdfConversion ? { pdfConversion } : {}) });
}
beforeEach(() => settings(undefined));

async function call(tool: { execute: (...args: never[]) => Promise<unknown> }, args: unknown): Promise<string> {
	const result = await (tool.execute as (id: string, args: unknown) => Promise<{ content: { text: string }[] }>)("call", args);
	return result.content.map((part) => part.text).join("");
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("condition not reached");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** Upload one PDF into a new lesson and wait for its read to finish. */
async function upload(name: string, bytes: Uint8Array): Promise<{ chatId: string; material: LessonMaterial }> {
	const chat = chatStore.createChat(name);
	const added = service.addUploadedMaterial(chat.id, { name, type: "application/pdf", bytes });
	assert.ok(added.ok);
	if (!added.ok) throw new Error("upload refused");
	await service.waitForMaterials(chat.id, 30_000);
	return { chatId: chat.id, material: service.listMaterials(chat.id).find((m) => m.id === added.value.id)! };
}

const aux = (chatId: string, m: LessonMaterial, file: string) => materialStore.auxPath(chatId, m.id, file);
const sidecarOf = (chatId: string, m: LessonMaterial) => JSON.parse(fs.readFileSync(aux(chatId, m, PDF_CONVERSION_SIDECAR), "utf8"));
const uploads = (log: LoggedRequest[]) => log.filter((r) => r.url === "/v1/convert/file/async").length;
const store = materialStore;

describe("the upload hook with pdfjs", () => {
	it("writes content.md and the sidecar, reports scanned-looking pages, and skips an unchanged source", async () => {
		const { chatId, material } = await upload("tiny.pdf", textAndScan);
		const content = fs.readFileSync(aux(chatId, material, PDF_CONTENT_FILE), "utf8");
		assert.match(content, /^--- Page 1 ---\n[\s\S]*Original pdfjs text[\s\S]*\n--- Page 2 ---\n$/);
		const sidecar = sidecarOf(chatId, material);
		assert.deepEqual(sidecar.requested, { converterId: "pdfjs", converterVersion: "1", options: {} });
		assert.equal(sidecar.converterId, "pdfjs");
		assert.match(sidecar.sourceHash, /^[a-f0-9]{64}$/);
		assert.deepEqual(sidecar.failedPages.map((p: { page: number }) => p.page), [2]);
		assert.equal(material.conversionError, undefined);
		assert.match(material.conversionWarnings?.[0] ?? "", /^Page 2 has no extractable text and may be scanned/);
		assert.match(material.error ?? "", NO_VISION, "the profiler ran after the conversion");
		const before = fs.readFileSync(aux(chatId, material, PDF_CONVERSION_SIDECAR), "utf8");
		const again = await convertMaterialPdf(chatId, material, { signal: new AbortController().signal, store, settings: undefined });
		assert.equal(again.status, "unchanged");
		assert.equal(fs.readFileSync(aux(chatId, material, PDF_CONVERSION_SIDECAR), "utf8"), before);
	});

	it("F1: a scanned PDF ends in a working material with a clear note, and the profiler still runs", async () => {
		const { chatId, material } = await upload("scan.pdf", scanned);
		assert.equal(material.conversionError?.kind, "no_text");
		assert.match(material.conversionError?.message ?? "", /looks scanned\. A converter with OCR \(such as Docling\) would read it/);
		assert.match(material.error ?? "", NO_VISION, "the profiler was reached, not skipped by the conversion failure");
		assert.doesNotMatch(material.error ?? "", /conversion/i);
		assert.match(materialStatusLine(material), /looks scanned/);
		assert.equal(fs.existsSync(aux(chatId, material, PDF_CONTENT_FILE)), false);
		const tools = materialTools({ chatId, store });
		assert.match(await call(tools.material_read!, { material: material.id, pages: "1-2" }), /^--- Page 1 ---\n\n--- Page 2 ---/, "pdfjs reads the original");
		assert.match(await call(tools.material_search!, { query: "anything", literal: true }), /No matches/);
		const again = await convertMaterialPdf(chatId, material, { signal: new AbortController().signal, store, settings: undefined });
		assert.equal(again.status, "unchanged", "a recorded failure is not retried automatically");
		assert.equal(again.error?.kind, "no_text");
	});

	it("an unopenable PDF records the conversion error and still reaches the profiler", async () => {
		const { material } = await upload("broken.pdf", new TextEncoder().encode("not a pdf"));
		assert.equal(material.conversionError?.kind, "bad_response");
		assert.equal(material.status, "error");
		assert.match(material.error ?? "", NO_VISION);
	});
});

describe("C1: the profiler's input does not change", () => {
	it("pdfExtract and pdfSearch read the original even with a content.md beside it", async () => {
		const chat = chatStore.createChat("Profiler input");
		const m = materialStore.add(chat.id, { kind: "pdf", name: "p.pdf", ext: ".pdf", bytes: textAndScan });
		fs.writeFileSync(aux(chat.id, m, PDF_CONTENT_FILE), "--- Page 1 ---\nCONVERTED-ONLY\n--- Page 2 ---\n", "utf8");
		const source = materialStore.filePath(chat.id, m);
		assert.match(await pdfExtract(source, "1"), /Original pdfjs text/);
		assert.doesNotMatch(await pdfExtract(source, "1"), /CONVERTED-ONLY/);
		assert.equal((await pdfSearch(source, "CONVERTED-ONLY", { literal: true })).hits.length, 0);
	});

	it("the lookup tools read content.md, and fall back to pdfjs when it is missing, empty or has no markers", async () => {
		const chat = chatStore.createChat("Lookup");
		const add = (name: string) => materialStore.add(chat.id, { kind: "pdf", name, ext: ".pdf", bytes: textAndScan });
		const converted = add("converted.pdf");
		fs.writeFileSync(aux(chat.id, converted, PDF_CONTENT_FILE), "--- Page 1 ---\nUNIQUE-STORED-TEXT\n\\--- Page 9 ---\n--- Page 2 ---\n", "utf8");
		const missing = add("missing.pdf");
		const empty = add("empty.pdf");
		fs.writeFileSync(aux(chat.id, empty, PDF_CONTENT_FILE), " \n", "utf8");
		const unmarked = add("unmarked.pdf");
		fs.writeFileSync(aux(chat.id, unmarked, PDF_CONTENT_FILE), "garbage without markers", "utf8");
		const tools = materialTools({ chatId: chat.id, store });
		assert.match(await call(tools.material_read!, { material: converted.id, pages: "1" }), /UNIQUE-STORED-TEXT\n\\--- Page 9 ---/);
		assert.match(await call(tools.material_search!, { query: "UNIQUE-STORED", literal: true, material: converted.id }), /\[converted.pdf, p. 1\]/);
		for (const m of [missing, empty, unmarked]) {
			assert.match(await call(tools.material_read!, { material: m.id, pages: "1" }), /Original pdfjs text/, m.name);
			assert.match(await call(tools.material_search!, { query: "Original pdfjs", literal: true, material: m.id }), /p\. 1/, m.name);
		}
	});
});

describe("the upload hook with Docling (loopback)", () => {
	it("F5: a blank middle page is empty and the third page's text stays on page 3; an unchanged re-run only asks /version", async () => {
		let version = "1.38.2";
		const docling = fakeDocling(recordedResponse("blank-middle"), { version: (_q, r) => json(r, { "docling-serve": version }) });
		await withServer(docling.handler, async (baseUrl, log) => {
			settings({ converter: "docling", docling: { baseUrl } });
			const { chatId, material } = await upload("blank-middle.pdf", recordedPdf("blank-middle"));
			const content = fs.readFileSync(aux(chatId, material, PDF_CONTENT_FILE), "utf8");
			assert.equal(content, "--- Page 1 ---\nPage one sentinel ALPHA about eigenvalues.\n--- Page 2 ---\n\n--- Page 3 ---\nPage three sentinel CHARLIE about voltage.");
			assert.deepEqual(sidecarOf(chatId, material).requested, { converterId: "docling", converterVersion: "docling-serve 1.38.2", options: { ocr: true, formulaEnrichment: false } });
			assert.equal(material.conversionError, undefined);
			assert.equal(uploads(log), 1);
			const signal = new AbortController().signal;
			const pdfConversion = { converter: "docling", docling: { baseUrl } };
			assert.equal((await convertMaterialPdf(chatId, material, { signal, store, settings: pdfConversion })).status, "unchanged");
			assert.equal(uploads(log), 1);
			assert.equal(log.at(-1)?.url, "/version");
			// C3: the options and the server's real version are part of the key.
			assert.equal((await convertMaterialPdf(chatId, material, { signal, store, settings: { ...pdfConversion, docling: { baseUrl, ocr: false } } })).status, "converted");
			assert.equal(uploads(log), 2);
			version = "1.39.0";
			assert.equal((await convertMaterialPdf(chatId, material, { signal, store, settings: { ...pdfConversion, docling: { baseUrl, ocr: false } } })).status, "converted");
			assert.equal(uploads(log), 3);
		});
	});

	it("F1: a Docling auth failure is recorded, nothing falls back, the tools use pdfjs and the profiler still runs", async () => {
		await withServer((_req, res) => json(res, { detail: "Invalid API key" }, 401), async (baseUrl, log) => {
			settings({ converter: "docling", docling: { baseUrl } });
			const { chatId, material } = await upload("auth.pdf", textAndScan);
			assert.equal(material.conversionError?.kind, "auth");
			assert.match(material.conversionError?.message ?? "", /Invalid API key/);
			assert.match(material.error ?? "", NO_VISION);
			assert.equal(uploads(log), 0);
			assert.match(await call(materialTools({ chatId, store }).material_read!, { material: material.id, pages: "1" }), /Original pdfjs text/);
		});
	});

	it("a failed task surfaces the server's message on the material", async () => {
		const docling = fakeDocling(recordedResponse("three-full"), {
			poll: (_q, r) => json(r, { task_id: "task 1", task_type: "convert", task_status: "failure", failure: { category: "resource", message: "Worker ran out of memory", retryable: true, phase: "convert" } }),
		});
		await withServer(docling.handler, async (baseUrl) => {
			settings({ converter: "docling", docling: { baseUrl } });
			const { material } = await upload("fails.pdf", recordedPdf("three-full"));
			assert.deepEqual(material.conversionError, { kind: "conversion_failed", message: "Docling could not convert the PDF: Worker ran out of memory", retryable: true });
		});
	});

	it("Docling selected without a URL converts with pdfjs and says so", async () => {
		settings({ converter: "docling" });
		const { material } = await upload("no-url.pdf", recordedPdf("three-full"));
		assert.equal(material.conversionError, undefined);
		assert.match(material.conversionWarnings?.[0] ?? "", /no Docling URL is configured; the built-in reader \(pdfjs\) was used instead/);
	});

	it("records the requested converter id so switching from unconfigured Docling to pdfjs clears the stale warning", async () => {
		settings({ converter: "docling" });
		const { chatId, material } = await upload("unconfigured-switch.pdf", recordedPdf("three-full"));
		assert.equal(sidecarOf(chatId, material).requested.converterId, "docling");
		assert.equal(sidecarOf(chatId, material).converterId, "pdfjs");
		assert.match(material.conversionWarnings?.[0] ?? "", /no Docling URL is configured/);
		const stillSame = await convertMaterialPdf(chatId, material, { signal: new AbortController().signal, store, settings: { converter: "docling" } });
		assert.equal(stillSame.status, "unchanged");
		const switched = await convertMaterialPdf(chatId, material, { signal: new AbortController().signal, store, settings: { converter: "pdfjs" } });
		assert.equal(switched.status, "converted");
		assert.deepEqual(switched.warnings, []);
		assert.equal(sidecarOf(chatId, material).requested.converterId, "pdfjs");
	});

	it("a scanned PDF after an unreachable Docling fallback is retryable, explains both causes, and shows warnings alongside errors", async () => {
		settings({ converter: "docling", docling: { baseUrl: await closedBaseUrl() } });
		const { material } = await upload("scanned-fallback.pdf", scanned);
		assert.equal(material.conversionError?.kind, "no_text");
		assert.equal(material.conversionError?.retryable, true);
		assert.match(material.conversionError?.message ?? "", /Docling could not be reached \(Could not reach Docling/);
		assert.match(material.conversionError?.message ?? "", /looks scanned/);
		assert.match(material.conversionError?.message ?? "", /Retry/i);
		assert.match(material.conversionWarnings?.[0] ?? "", /^Docling failed \(Could not reach Docling/);
		const line = materialStatusLine({ ...material, status: "ready", pages: 2 });
		assert.ok(line.includes(material.conversionError!.message), line);
		assert.ok(line.includes(material.conversionWarnings![0]!), line);
	});

	it("C2: after a fallback to pdfjs an unchanged re-run uploads nothing; a retry on purpose does", async () => {
		settings({ converter: "docling", docling: { baseUrl: await closedBaseUrl() } });
		const { chatId, material } = await upload("fallback.pdf", recordedPdf("three-full"));
		assert.equal(material.conversionError, undefined);
		assert.match(material.conversionWarnings?.[0] ?? "", /^Docling failed \(Could not reach Docling/);
		assert.equal(sidecarOf(chatId, material).converterId, "pdfjs");
		const docling = fakeDocling(recordedResponse("three-full"));
		await withServer(docling.handler, async (baseUrl, log) => {
			const now = { converter: "docling", docling: { baseUrl } };
			settings(now);
			assert.equal((await convertMaterialPdf(chatId, material, { signal: new AbortController().signal, store, settings: now })).status, "unchanged");
			assert.equal(log.length, 0, "not even /version");
			const retry = service.retryMaterialConversion(chatId, material.id);
			assert.ok(retry.ok);
			await until(() => service.materialRunCount() === 0);
			assert.equal(uploads(log), 1);
			const after = service.listMaterials(chatId).find((m) => m.id === material.id)!;
			assert.equal(after.conversionWarnings, undefined);
			assert.equal(sidecarOf(chatId, material).converterId, "docling");
		});
	});

	it("C2: a conversion interrupted by a restart is not re-uploaded; it is marked and can be retried", async () => {
		const docling = fakeDocling(recordedResponse("three-full"));
		await withServer(docling.handler, async (baseUrl, log) => {
			settings({ converter: "docling", docling: { baseUrl } });
			const chat = chatStore.createChat("Interrupted");
			// What a process that stopped mid-upload leaves: the material still "reading", the submitted marker, no run.
			const m = materialStore.add(chat.id, { kind: "pdf", name: "big.pdf", ext: ".pdf", bytes: recordedPdf("three-full") });
			fs.writeFileSync(aux(chat.id, m, PDF_CONVERSION_SUBMITTED), "{}\n");
			service.listMaterials(chat.id); // restarts the read
			await service.waitForMaterials(chat.id, 30_000);
			const read = service.listMaterials(chat.id)[0]!;
			assert.equal(read.conversionError?.kind, "interrupted");
			assert.equal(read.conversionError?.retryable, true);
			assert.match(read.error ?? "", NO_VISION, "the profiler still ran");
			assert.equal(log.length, 0, "nothing was uploaded again");
			assert.ok(service.retryMaterialConversion(chat.id, m.id).ok);
			await until(() => service.materialRunCount() === 0);
			assert.equal(uploads(log), 1);
			assert.equal(service.listMaterials(chat.id)[0]!.conversionError, undefined);
			assert.equal(fs.existsSync(aux(chat.id, m, PDF_CONVERSION_SUBMITTED)), false);
		});
	});

	it("shows progress while converting; deleting the material aborts the conversion and uploads nothing more", { timeout: 30_000 }, async () => {
		const docling = fakeDocling(recordedResponse("three-full"), { poll: () => {} });
		await withServer(docling.handler, async (baseUrl, log) => {
			settings({ converter: "docling", docling: { baseUrl } });
			const chat = chatStore.createChat("Deleted mid-conversion");
			const added = service.addUploadedMaterial(chat.id, { name: "slow.pdf", type: "application/pdf", bytes: recordedPdf("three-full") });
			assert.ok(added.ok);
			if (!added.ok) return;
			await until(() => log.some((r) => r.url.startsWith("/v1/status/poll/")));
			const live = service.listMaterials(chat.id)[0]!;
			assert.equal(live.conversionProgress?.stage, "queued");
			assert.match(materialStatusLine(live), /^reading… · converting: queued/);
			assert.equal(service.retryMaterialConversion(chat.id, added.value.id).ok, false, "a running read cannot be retried");
			const started = Date.now();
			assert.equal(service.removeMaterial(chat.id, added.value.id), true);
			await until(() => service.materialRunCount() === 0, 10_000);
			assert.ok(Date.now() - started < 10_000);
			assert.deepEqual(service.listMaterials(chat.id), []);
			const requests = log.length;
			await new Promise((resolve) => setTimeout(resolve, 200));
			assert.equal(log.length, requests);
			assert.equal(uploads(log), 1);
		});
	});

	it("retrying a finished material shows conversion progress instead of the stale error", { timeout: 30_000 }, async () => {
		const docling = fakeDocling(recordedResponse("three-full"), { poll: () => {} });
		await withServer(docling.handler, async (baseUrl, log) => {
			const chat = chatStore.createChat("Retry progress");
			const m = materialStore.add(chat.id, { kind: "pdf", name: "retry.pdf", ext: ".pdf", bytes: recordedPdf("three-full") });
			materialStore.update(chat.id, m.id, {
				status: "ready",
				pages: 3,
				conversionError: { kind: "interrupted", message: "stale error", retryable: true },
			});
			settings({ converter: "docling", docling: { baseUrl } });
			assert.ok(service.retryMaterialConversion(chat.id, m.id).ok);
			await until(() => log.some((r) => r.url.startsWith("/v1/status/poll/")));
			const live = service.listMaterials(chat.id)[0]!;
			assert.equal(live.status, "ready");
			assert.equal(live.conversionProgress?.stage, "queued");
			const line = materialStatusLine(live);
			assert.match(line, /^converting: queued/);
			assert.equal(line.includes("stale error"), false, line);
			assert.equal(
				materialStatusLine({ ...live, conversionProgress: { stage: "extracting", donePages: 2, totalPages: 3 } }),
				"converting: extracting 2/3",
			);
			assert.equal(service.removeMaterial(chat.id, m.id), true);
			await until(() => service.materialRunCount() === 0, 10_000);
		});
	});
});
