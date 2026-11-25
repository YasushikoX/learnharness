/**
 * Indexing a converted PDF at upload (fork addition, 2026-11-25; server/material-indexing.ts and its hook in
 * server/materials.ts): the digest's profile replaces the skim profiler, digest.json is written atomically and
 * reused while its key matches, fallbacks to the old profiler with a visible note, the retry and rewrite functions,
 * abort and deletion, a restart mid-indexing, and the class glossary. The model is pi-ai's faux provider registered
 * on the vision slot and answering by request: no real model or service is called.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { createFauxCore, createProvider, fauxAssistantMessage, type Context, type StreamFunction } from "@earendil-works/pi-ai";
import { tinyPdf, type Run } from "./helpers/tiny-pdf.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-material-indexing-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
const { chatStore } = await import("../src/store/chats.ts");
const { courseStore } = await import("../src/store/courses.ts");
const { materialStore } = await import("../src/store/materials.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { piModels, piEngineForSpec } = await import("../src/agent/models.ts");
const service = await import("../src/server/materials.ts");
const indexing = await import("../src/server/material-indexing.ts");
const { PDF_CONTENT_FILE, PDF_CONVERSION_SIDECAR } = await import("../src/server/material-conversion.ts");
const { MATERIAL_INDEXER_VERSION } = await import("../src/agent/subagents/material-digest.ts");
const { findTerm } = await import("../src/core/glossary.ts");
const { PROFILE_HEADINGS } = await import("../src/agent/subagents/material-digest.ts");
const { PROFILE_FORMAT_SECTIONS } = await import("../src/agent/subagents/material-profiler.ts");
const { materialStatusLine } = await import("../components/materials-control.tsx");
type LessonMaterial = import("../src/core/materials.ts").LessonMaterial;
type MaterialDigest = import("../src/core/contracts/material-digest.ts").MaterialDigest;

const PROVIDER = "indexing-fixture";
const faux = createFauxCore({});
const entry = { ...faux.getModel(), provider: PROVIDER, id: "vision-model" };

// ── The scripted model ───────────────────────────────────────────────────

interface Call {
	system: string;
	user: string;
}
const calls: Call[] = [];
const isExtraction = (c: Call) => c.system.includes("You are an indexing specialist");
const isReduce = (c: Call) => c.system.includes("Write the document's profile from them");
const indexCalls = () => calls.filter((c) => isExtraction(c) || isReduce(c));
const profilerCalls = () => calls.filter((c) => !isExtraction(c) && !isReduce(c));

const DIGEST_PROFILE = "## Scope and targets\nFROM THE DIGEST: find eigenvalues (p. 1).\n\n## Contents\nEigenvalues (p. 1-2).";
const OLD_PROFILE = "## Scope and targets\nFROM THE OLD PROFILER (p. 1).";

interface Script {
	/** The terms each extraction reply lists, by material name. */
	terms: (name: string) => string[];
	/** Single-batch replies carry a valid "profile" field. */
	singleProfile: boolean;
	/** Extraction replies for this 0-based batch index are invalid (the batch fails). */
	failBatch: (index: number) => boolean;
	/** Each indexing call waits for this first. */
	gate?: Promise<void>;
	/** Called as each indexing call starts. */
	onIndexCall?: () => void;
}
const DEFAULT_SCRIPT: Script = { terms: () => ["Eigenvalue"], singleProfile: true, failBatch: () => false };
let script: Script = DEFAULT_SCRIPT;

/** The request's system prompt (a leading system message once normalised) and its last message's text. */
function textOf(context: Context): Call {
	type Loose = { role: string; content: string | { type: string; text?: string }[] };
	const text = (m: Loose) => (typeof m.content === "string" ? m.content : m.content.map((p) => p.text ?? "").join(""));
	const messages = context.messages as unknown as Loose[];
	const system = [context.systemPrompt ?? "", ...messages.filter((m) => m.role === "system").map(text)].join("\n");
	return { system, user: text(messages.at(-1)!) };
}

/** The page numbers a batch request lists ("This part's pages: 1-4, 7."). */
function requestPages(user: string): number[] {
	const list = /This part's pages: ([^\n]*)\./.exec(user)![1]!;
	return list.split(", ").flatMap((r) => {
		const [a, b] = r.split("-").map(Number);
		return Array.from({ length: (b ?? a!) - a! + 1 }, (_, i) => a! + i);
	});
}

function extractionReply(user: string): string {
	const index = /, part (\d+) of \d+/.exec(user);
	if (script.failBatch(index ? Number(index[1]) - 1 : 0)) return "not json at all";
	const page = requestPages(user)[0]!;
	const name = /The material: "([^"]+)"/.exec(user)?.[1] ?? "";
	const terms = script.terms(name).map((term) => ({ term, aliases: [], page, tier: "core", definition: `${term} as ${name} defines it.`, definitionPage: page }));
	const single = user.includes('also add a "profile" field');
	return JSON.stringify({ summaryBullets: [`page ${page} of ${name}`], terms, concepts: [], figures: [], ...(single && script.singleProfile ? { profile: DIGEST_PROFILE } : {}) });
}

const stream: StreamFunction = (model, context, options) => {
	const call = textOf(context);
	calls.push(call);
	faux.setResponses([
		async () => {
			if (isExtraction(call) || isReduce(call)) {
				script.onIndexCall?.();
				await script.gate;
				return fauxAssistantMessage(isReduce(call) ? DIGEST_PROFILE : extractionReply(call.user));
			}
			return fauxAssistantMessage(OLD_PROFILE);
		},
	]);
	return faux.streamSimple(model, context, options);
};
piModels().setProvider(createProvider({ id: PROVIDER, models: [entry], auth: { apiKey: { name: "fixture", resolve: async () => ({ auth: {} }) } }, api: { stream, streamSimple: stream } }));

const VISION = { version: 1 as const, models: { vision: { model: { provider: PROVIDER, id: entry.id } } } };
beforeEach(() => {
	writeSettings(VISION);
	script = DEFAULT_SCRIPT;
});
after(() => {
	piModels().deleteProvider(PROVIDER);
	fs.rmSync(TMP, { recursive: true, force: true });
});

// ── Helpers ──────────────────────────────────────────────────────────────

async function until(check: () => boolean, ms = 30_000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("condition not reached");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
const idle = () => until(() => service.materialRunCount() === 0);

/** A small PDF whose pages carry the given lines. */
const pdfOf = (...pages: string[][]) => tinyPdf(pages.map((lines) => ({ runs: lines.map((text, i): Run => ({ text, x: 72, y: 740 - i * 14 })) })));
/** A PDF long enough for several batches (unique lines, so nothing reads as a running header). */
const longPdf = (pages: number) =>
	pdfOf(...Array.from({ length: pages }, (_, p) => Array.from({ length: 50 }, (_, l) => `Page ${p + 1} line ${l + 1}: eigenvalues of a square matrix and their eigenvectors, ${p * 50 + l}.`)));

async function upload(ownerId: string, name: string, bytes: Uint8Array): Promise<LessonMaterial> {
	const added = service.addUploadedMaterial(ownerId, { name, type: name.endsWith(".pdf") ? "application/pdf" : "text/markdown", bytes });
	if (!added.ok) throw new Error(added.error);
	await idle(); // not waitForMaterials: its timeout timer is never cleared and would hold the test process open

	return find(ownerId, added.value.id);
}
const find = (ownerId: string, id: string) => service.listMaterials(ownerId).find((m) => m.id === id)!;
const aux = (ownerId: string, m: LessonMaterial, file: string) => materialStore.auxPath(ownerId, m.id, file);
const storedDigest = (ownerId: string, m: LessonMaterial) => JSON.parse(fs.readFileSync(aux(ownerId, m, indexing.MATERIAL_DIGEST_FILE), "utf8")) as MaterialDigest;
const lesson = (title: string) => chatStore.createChat(title).id;
const engine = () => piEngineForSpec({ provider: PROVIDER, id: entry.id });
const direct = (ownerId: string, m: LessonMaterial, force = false) =>
	indexing.indexMaterialContent(ownerId, m, { signal: new AbortController().signal, store: materialStore, model: { engine: engine(), chatId: ownerId }, force });

/** Count the model calls `run` makes. */
async function counted<T>(run: () => Promise<T>): Promise<{ value: T; index: number; profiler: number }> {
	const i = indexCalls().length;
	const p = profilerCalls().length;
	const value = await run();
	return { value, index: indexCalls().length - i, profiler: profilerCalls().length - p };
}

/** Patch the rename atomic-write lands with (fs default object, as atomic-write.ts expects). */
function onRename(hook: (from: string, to: string) => void): () => void {
	const original = fs.renameSync;
	fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
		hook(String(from), String(to));
		return original(from, to);
	}) as typeof fs.renameSync;
	return () => {
		fs.renameSync = original;
	};
}

const SINGLE = pdfOf(["Eigenvalues and eigenvectors"], ["The characteristic polynomial"]);

// ── Tests ────────────────────────────────────────────────────────────────

describe("indexing at upload", () => {
	it("a converted one-batch PDF is indexed with exactly one model call, and its profile comes from the digest", async () => {
		const owner = lesson("Single");
		const { value: m, index, profiler } = await counted(() => upload(owner, "single.pdf", SINGLE));
		assert.equal(index, 1, "one call: notes and profile together");
		assert.equal(profiler, 0, "the skim profiler did not run");
		assert.equal(m.status, "ready");
		assert.equal(m.profile, DIGEST_PROFILE);
		assert.equal(m.pages, 2);
		assert.equal(m.indexingCalls, 1);
		assert.equal(m.indexingError, undefined);
		const digest = storedDigest(owner, m);
		assert.equal(digest.batches.length, 1);
		assert.equal(digest.profile, DIGEST_PROFILE);
		assert.equal(digest.sourcePageCount, 2);
		assert.equal(digest.indexerVersion, MATERIAL_INDEXER_VERSION);
		const sidecar = JSON.parse(fs.readFileSync(aux(owner, m, PDF_CONVERSION_SIDECAR), "utf8"));
		assert.equal(digest.converter, sidecar.converterId);
		assert.equal(digest.converterVersion, sidecar.converterVersion);
		assert.deepEqual(digest.terms.map((t) => t.term), ["Eigenvalue"]);
		assert.equal(fs.existsSync(aux(owner, m, indexing.MATERIAL_INDEXING_STARTED)), false);
	});

	it("a multi-batch PDF costs batches + 1 calls, and its progress shows on the material", async () => {
		const owner = lesson("Long");
		const lines: string[] = [];
		script = { ...DEFAULT_SCRIPT, onIndexCall: () => {
			const m = service.listMaterials(owner)[0];
			if (m) lines.push(materialStatusLine(m));
		} };
		const { value: m, index } = await counted(() => upload(owner, "long.pdf", longPdf(18)));
		const digest = storedDigest(owner, m);
		assert.ok(digest.batches.length >= 2, `${digest.batches.length} batches`);
		assert.equal(index, digest.batches.length + 1);
		assert.equal(m.indexingCalls, digest.batches.length + 1);
		assert.equal(m.profile, DIGEST_PROFILE);
		assert.equal(m.pages, 18);
		const n = digest.batches.length;
		assert.deepEqual(lines, [...Array.from({ length: n }, (_, i) => `reading… · indexing: part ${i + 1} of ${n}`), "reading… · indexing: writing the profile"]);
		assert.equal(find(owner, m.id).indexingProgress, undefined, "no progress once the run ended");
	});

	it("digest.json is written atomically and is exactly the returned digest", async () => {
		const owner = lesson("Atomic");
		const m = await upload(owner, "atomic.pdf", SINGLE);
		const renames: [string, string][] = [];
		const restore = onRename((from, to) => {
			if (to.endsWith(indexing.MATERIAL_DIGEST_FILE)) renames.push([from, to]);
		});
		let outcome;
		try {
			outcome = await direct(owner, m, true);
		} finally {
			restore();
		}
		assert.equal(outcome.status, "indexed");
		assert.equal(renames.length, 1);
		assert.match(path.basename(renames[0]![0]), /^digest\.json\.tmp-/, "a temp file renamed over digest.json");
		assert.deepEqual(storedDigest(owner, m), outcome.digest);
		assert.deepEqual(fs.readdirSync(path.dirname(aux(owner, m, "x"))).filter((f) => f.includes(".tmp-")), [], "no temp left");
	});

	it("an unchanged re-run makes no model call, through the hook and directly", async () => {
		const owner = lesson("Unchanged");
		const m = await upload(owner, "same.pdf", SINGLE);
		const before = fs.readFileSync(aux(owner, m, indexing.MATERIAL_DIGEST_FILE), "utf8");
		const viaHook = await counted(async () => {
			materialStore.update(owner, m.id, { status: "reading" });
			service.listMaterials(owner); // restarts the read, as after an app restart
			await idle();
			return find(owner, m.id);
		});
		assert.equal(viaHook.index + viaHook.profiler, 0);
		assert.equal(viaHook.value.status, "ready");
		assert.equal(viaHook.value.profile, DIGEST_PROFILE);
		assert.equal(viaHook.value.indexingCalls, 1, "the count of the run that produced the digest");
		const viaCall = await counted(() => direct(owner, m));
		assert.equal(viaCall.value.status, "unchanged");
		assert.equal(viaCall.value.calls, 0);
		assert.equal(viaCall.index, 0);
		assert.equal(fs.readFileSync(aux(owner, m, indexing.MATERIAL_DIGEST_FILE), "utf8"), before);
	});

	it("a changed converter version or indexer version re-indexes", async () => {
		const owner = lesson("Versions");
		const m = await upload(owner, "versions.pdf", SINGLE);
		const sidecarPath = aux(owner, m, PDF_CONVERSION_SIDECAR);
		const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
		fs.writeFileSync(sidecarPath, JSON.stringify({ ...sidecar, converterVersion: "2-test" }));
		const converter = await counted(() => direct(owner, m));
		assert.equal(converter.value.status, "indexed");
		assert.equal(converter.index, 1);
		assert.equal(storedDigest(owner, m).converterVersion, "2-test");

		const digestPath = aux(owner, m, indexing.MATERIAL_DIGEST_FILE);
		fs.writeFileSync(digestPath, JSON.stringify({ ...storedDigest(owner, m), indexerVersion: MATERIAL_INDEXER_VERSION - 1 }));
		const indexer = await counted(() => direct(owner, m));
		assert.equal(indexer.value.status, "indexed");
		assert.equal(indexer.index, 1);
		assert.equal(storedDigest(owner, m).indexerVersion, MATERIAL_INDEXER_VERSION);

		fs.writeFileSync(aux(owner, m, PDF_CONTENT_FILE), `${fs.readFileSync(aux(owner, m, PDF_CONTENT_FILE), "utf8")}\nchanged text\n`);
		const content = await counted(() => direct(owner, m));
		assert.equal(content.value.status, "indexed", "a changed content.md (new source hash) re-indexes too");
		assert.equal(content.index, 1);
	});
});

describe("fallbacks", () => {
	it("a digest without a profile falls back to the old profiler, and the note is shown", async () => {
		const owner = lesson("No profile");
		script = { ...DEFAULT_SCRIPT, singleProfile: false };
		const { value: m, index, profiler } = await counted(() => upload(owner, "noprofile.pdf", SINGLE));
		assert.equal(index, 2, "the one call and its one retry for the missing profile");
		assert.ok(profiler >= 1, "the old profiler ran");
		assert.equal(m.status, "ready");
		assert.equal(m.profile, OLD_PROFILE);
		assert.equal(m.indexingError?.kind, "no_profile");
		assert.match(m.indexingError?.message ?? "", /has no profile .*read the old way/);
		assert.match(materialStatusLine(m), /whole-document index has no profile/);
		const digest = storedDigest(owner, m);
		assert.equal(digest.profile, null);
		assert.deepEqual(digest.terms.map((t) => t.term), ["Eigenvalue"], "the extraction is kept");
	});

	it("indexing that throws falls back, and the material ends usable with no digest and no marker", async () => {
		const owner = lesson("Throws");
		const restore = onRename((_from, to) => {
			if (to.endsWith(indexing.MATERIAL_DIGEST_FILE)) throw new Error("disk full");
		});
		let m: LessonMaterial;
		try {
			m = await upload(owner, "throws.pdf", SINGLE);
		} finally {
			restore();
		}
		assert.equal(m.status, "ready");
		assert.equal(m.profile, OLD_PROFILE);
		assert.equal(m.indexingError?.kind, "failed");
		assert.match(m.indexingError?.message ?? "", /disk full/);
		assert.match(materialStatusLine(m), /Indexing this PDF failed/);
		assert.equal(fs.existsSync(aux(owner, m, indexing.MATERIAL_DIGEST_FILE)), false);
		assert.equal(fs.existsSync(aux(owner, m, indexing.MATERIAL_INDEXING_STARTED)), false);
	});

	it("failed batches are kept and shown, and not retried automatically", async () => {
		const owner = lesson("Failed batch");
		script = { ...DEFAULT_SCRIPT, failBatch: (i) => i === 1 };
		const { value: m, index } = await counted(() => upload(owner, "failing.pdf", longPdf(18)));
		const digest = storedDigest(owner, m);
		const n = digest.batches.length;
		assert.equal(index, n + 2, "every batch, the failing one's retry, and the profile");
		assert.deepEqual(digest.failedBatches.map((b) => b.index), [1]);
		assert.equal(m.profile, DIGEST_PROFILE, "the profile is written from the parts that were indexed");
		assert.equal(m.indexingWarnings?.length, 1);
		assert.match(m.indexingWarnings![0]!, new RegExp(`^1 of ${n} parts of this PDF could not be indexed \\(pages \\d+-\\d+\\)`));
		assert.match(materialStatusLine(m), /could not be indexed/);
		script = DEFAULT_SCRIPT;
		const again = await counted(async () => {
			materialStore.update(owner, m.id, { status: "reading" });
			service.listMaterials(owner);
			await idle();
			return direct(owner, m);
		});
		assert.equal(again.index, 0, "a stored digest with failed batches is not re-run on its own");
		assert.equal(again.value.status, "unchanged");
	});

	it("a material without content.md keeps the old path: no indexing call, no digest", async () => {
		const owner = lesson("Old path");
		const text = await counted(() => upload(owner, "notes.md", new TextEncoder().encode("# Notes\n\nEigenvalues.")));
		assert.equal(text.index, 0);
		assert.equal(text.profiler, 1);
		assert.equal(text.value.profile, OLD_PROFILE);
		assert.equal(fs.existsSync(aux(owner, text.value, indexing.MATERIAL_DIGEST_FILE)), false);
		const scan = await counted(() => upload(owner, "scan.pdf", tinyPdf([{ image: true }])));
		assert.equal(scan.value.conversionError?.kind, "no_text", "the conversion failed: no content.md");
		assert.equal(scan.index, 0);
		assert.ok(scan.profiler >= 1);
		assert.equal(scan.value.profile, OLD_PROFILE);
		assert.equal(scan.value.indexingError, undefined);
		assert.equal(fs.existsSync(aux(owner, scan.value, indexing.MATERIAL_DIGEST_FILE)), false);
	});
});

describe("retry and rewrite", () => {
	it("retryMaterialIndexing re-reads the whole document and clears the failed parts", async () => {
		const owner = lesson("Retry");
		script = { ...DEFAULT_SCRIPT, failBatch: (i) => i === 0 };
		const m = await upload(owner, "retry.pdf", longPdf(18));
		const n = storedDigest(owner, m).batches.length;
		assert.equal(m.indexingWarnings?.length, 1);
		script = DEFAULT_SCRIPT;
		const { value: after, index } = await counted(async () => {
			const started = service.retryMaterialIndexing(owner, m.id);
			assert.ok(started.ok);
			assert.deepEqual(service.retryMaterialIndexing(owner, m.id), { ok: false, status: 409, error: "retry.pdf is still being read" });
			await idle();
			return find(owner, m.id);
		});
		assert.equal(index, n + 1);
		assert.equal(storedDigest(owner, m).failedBatches.length, 0);
		assert.equal(after.indexingWarnings, undefined);
		assert.equal(after.indexingCalls, n + 1);
		assert.equal(after.profile, DIGEST_PROFILE);
	});

	it("rewriteMaterialProfile runs only the profile step and replaces the fallback profile", async () => {
		const owner = lesson("Rewrite");
		script = { ...DEFAULT_SCRIPT, singleProfile: false };
		const m = await upload(owner, "rewrite.pdf", SINGLE);
		assert.equal(m.profile, OLD_PROFILE);
		assert.equal(m.indexingCalls, 2);
		const termsBefore = storedDigest(owner, m).terms;
		const { value: after, index } = await counted(async () => {
			assert.ok(service.rewriteMaterialProfile(owner, m.id).ok);
			await idle();
			return find(owner, m.id);
		});
		assert.equal(index, 1);
		assert.ok(indexCalls().at(-1) && isReduce(indexCalls().at(-1)!), "the reduce call, no batch re-read");
		assert.equal(after.profile, DIGEST_PROFILE);
		assert.equal(after.indexingError, undefined);
		assert.equal(after.indexingCalls, 3);
		assert.equal(storedDigest(owner, m).profile, DIGEST_PROFILE);
		assert.deepEqual(storedDigest(owner, m).terms, termsBefore);
	});

	it("the retry and rewrite functions refuse what they cannot do", async () => {
		const owner = lesson("Refusals");
		const text = await upload(owner, "notes.md", new TextEncoder().encode("plain"));
		assert.deepEqual(service.retryMaterialIndexing(owner, "mat_nope"), { ok: false, status: 404, error: "Unknown material" });
		assert.equal((service.retryMaterialIndexing(owner, text.id) as { status: number }).status, 409);
		assert.equal((service.rewriteMaterialProfile(owner, text.id) as { status: number }).status, 409);
		const pdf = await upload(owner, "nodigest.pdf", SINGLE);
		fs.rmSync(aux(owner, pdf, indexing.MATERIAL_DIGEST_FILE));
		assert.equal((service.rewriteMaterialProfile(owner, pdf.id) as { status: number }).status, 409, "no digest to rewrite from");
		writeSettings({ version: 1 });
		assert.match((service.retryMaterialIndexing(owner, pdf.id) as { error: string }).error, /no vision model/);
		assert.equal(service.materialRunCount(), 0);
	});
});

describe("abort, deletion and restart", () => {
	it("deleting a material while it is being indexed leaves no file and no run", async () => {
		const owner = lesson("Delete");
		let release!: () => void;
		let started = false;
		script = { ...DEFAULT_SCRIPT, gate: new Promise<void>((r) => (release = r)), onIndexCall: () => (started = true) };
		const added = service.addUploadedMaterial(owner, { name: "deleted.pdf", type: "application/pdf", bytes: SINGLE });
		assert.ok(added.ok);
		if (!added.ok) return;
		await until(() => started);
		const dir = path.dirname(materialStore.filePath(owner, added.value));
		assert.ok(fs.existsSync(path.join(dir, indexing.MATERIAL_INDEXING_STARTED)), "the marker exists while indexing runs");
		assert.ok(service.removeMaterial(owner, added.value.id));
		release();
		await idle();
		assert.equal(fs.existsSync(dir), false, "the material's folder is gone and nothing was written back into it");
		assert.deepEqual(service.listMaterials(owner), []);
	});

	it("deleting a material during a retry stops it the same way", async () => {
		const owner = lesson("Delete retry");
		const m = await upload(owner, "retry-deleted.pdf", SINGLE);
		let release!: () => void;
		let started = false;
		script = { ...DEFAULT_SCRIPT, gate: new Promise<void>((r) => (release = r)), onIndexCall: () => (started = true) };
		assert.ok(service.retryMaterialIndexing(owner, m.id).ok);
		await until(() => started);
		assert.equal(materialStatusLine(find(owner, m.id)), "indexing: part 1 of 1");
		service.removeMaterial(owner, m.id);
		release();
		await idle();
		assert.equal(fs.existsSync(path.dirname(materialStore.filePath(owner, m))), false);
		assert.deepEqual(service.listMaterials(owner), []);
	});

	it("a restart mid-indexing resumes once from the start; a second interruption falls back instead of looping", async () => {
		const owner = lesson("Restart");
		const m = await upload(owner, "restart.pdf", SINGLE);
		const marker = aux(owner, m, indexing.MATERIAL_INDEXING_STARTED);
		const digestPath = aux(owner, m, indexing.MATERIAL_DIGEST_FILE);
		const sourceHash = storedDigest(owner, m).sourceHash;
		/** What a process that died mid-indexing leaves: status reading, the marker, no digest, no run. */
		const died = (attempt: number) => {
			fs.rmSync(digestPath);
			fs.writeFileSync(marker, JSON.stringify({ sourceHash, attempt, startedAt: new Date().toISOString() }));
			materialStore.update(owner, m.id, { status: "reading", profile: undefined });
		};

		died(1);
		const resumed = await counted(async () => {
			service.listMaterials(owner); // any read restarts a read with no live run
			await idle();
			return find(owner, m.id);
		});
		assert.equal(resumed.index, 1, "indexed again from the start");
		assert.equal(resumed.profiler, 0);
		assert.equal(resumed.value.status, "ready");
		assert.equal(resumed.value.profile, DIGEST_PROFILE);
		assert.equal(fs.existsSync(marker), false);
		assert.ok(fs.existsSync(digestPath));

		died(2);
		const fellBack = await counted(async () => {
			service.listMaterials(owner);
			await idle();
			return find(owner, m.id);
		});
		assert.equal(fellBack.index, 0, "not started a third time");
		assert.ok(fellBack.profiler >= 1);
		assert.equal(fellBack.value.status, "ready", "not stuck in reading");
		assert.equal(fellBack.value.profile, OLD_PROFILE);
		assert.equal(fellBack.value.indexingError?.kind, "interrupted");

		const retried = await counted(async () => {
			assert.ok(service.retryMaterialIndexing(owner, m.id).ok);
			await idle();
			return find(owner, m.id);
		});
		assert.equal(retried.index, 1, "a retry ignores the marker");
		assert.equal(retried.value.indexingError, undefined);
		assert.equal(retried.value.profile, DIGEST_PROFILE);
		assert.equal(fs.existsSync(marker), false);
	});
});

describe("the class glossary", () => {
	it("merges a course's digests, resolves citations to materials and lists what is missing", async () => {
		const course = courseStore.createCourse("Linear algebra");
		script = { ...DEFAULT_SCRIPT, terms: (name) => (name === "a.pdf" ? ["Eigenvalue", "Matrix"] : ["Eigenvalue", "Vector"]) };
		const a = await upload(course.id, "a.pdf", pdfOf(["Eigenvalues of a matrix"], ["Diagonal matrices"]));
		const b = await upload(course.id, "b.pdf", pdfOf(["Eigenvalues and vectors"], ["Vector spaces"]));
		const notes = await upload(course.id, "notes.md", new TextEncoder().encode("# Notes"));

		const glossary = indexing.courseGlossary(course.id)!;
		const eigen = findTerm(glossary, "eigenvalue")!;
		assert.ok(eigen);
		assert.equal(eigen.citations.length, 2);
		const cited = glossary.terms[eigen.id]!.citations.flatMap((c) => c.materials.map((x) => x.id)).sort();
		assert.deepEqual(cited, [a.id, b.id].sort());
		assert.deepEqual(glossary.terms[findTerm(glossary, "matrix")!.id]!.citations.map((c) => c.materials), [[{ id: a.id, name: "a.pdf" }]]);
		assert.deepEqual(glossary.terms[findTerm(glossary, "vector")!.id]!.citations.map((c) => c.materials), [[{ id: b.id, name: "b.pdf" }]]);
		assert.deepEqual(glossary.indexed.map((x) => x.id).sort(), [a.id, b.id].sort());
		assert.deepEqual(glossary.incomplete, [{ id: notes.id, name: "notes.md", kind: "text", reason: "no_digest" }]);

		// an outdated digest is left out and listed; failed parts are merged and listed
		fs.writeFileSync(aux(course.id, b, indexing.MATERIAL_DIGEST_FILE), JSON.stringify({ ...storedDigest(course.id, b), indexerVersion: 0 }));
		const digestA = storedDigest(course.id, a);
		const failed = { ...digestA.batches[0]!, status: "failed" as const, error: "test" };
		fs.writeFileSync(aux(course.id, a, indexing.MATERIAL_DIGEST_FILE), JSON.stringify({ ...digestA, failedBatches: [failed] }));
		const partial = indexing.courseGlossary(course.id)!;
		assert.equal(findTerm(partial, "vector"), undefined);
		assert.equal(findTerm(partial, "eigenvalue")!.citations.length, 1);
		assert.deepEqual(
			partial.incomplete.map((g) => [g.id, g.reason]),
			[
				[a.id, "failed_batches"],
				[b.id, "outdated"],
				[notes.id, "no_digest"],
			],
		);
		assert.deepEqual(partial.incomplete[0]!.failedPages, [{ pageStart: failed.pageStart, pageEnd: failed.pageEnd }]);
		assert.equal(indexing.courseGlossary("course_unknown"), null);
	});
});

describe("one profile format", () => {
	it("the indexer's prompts carry the profiler's format, and every heading the indexer validates is in it", () => {
		for (const heading of PROFILE_HEADINGS) assert.ok(PROFILE_FORMAT_SECTIONS.includes(`\n## ${heading}\n`), heading);
		const reduce = calls.find(isReduce);
		assert.ok(reduce, "a reduce call was made above");
		assert.ok(reduce.system.includes(PROFILE_FORMAT_SECTIONS));
		const single = calls.find((c) => isExtraction(c) && c.user.includes('also add a "profile" field'));
		assert.ok(single?.user.includes(PROFILE_FORMAT_SECTIONS));
	});
});
