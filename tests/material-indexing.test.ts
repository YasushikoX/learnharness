/**
 * Indexing a converted PDF at upload (fork addition, 2026-11-25; server/material-indexing.ts and its hook in
 * server/materials.ts): the digest's profile replaces the skim profiler, digest.json is written atomically and
 * reused while its key matches, fallbacks to the old profiler with a visible note, the retry and rewrite functions,
 * abort and deletion, a restart mid-indexing, and the class glossary. The model is pi-ai's faux provider registered
 * on the vision slot and answering by request: no real model or service is called.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const { MATERIAL_INDEXER_VERSION, failedBatchesOf } = await import("../src/agent/subagents/material-digest.ts");
const { findTerm, findTermCandidates } = await import("../src/core/glossary.ts");
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
	/** The reduce call's reply (default DIGEST_PROFILE). */
	reduceReply?: string;
	/** Extraction calls get an empty reply. */
	emptyExtraction?: boolean;
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
	const terms = script.terms(name).map((term) => ({ term, aliases: [], symbols: [], page, tier: "core", definition: `${term} as ${name} defines it.`, definitionPage: page }));
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
				if (isReduce(call)) return fauxAssistantMessage(script.reduceReply ?? DIGEST_PROFILE);
				return fauxAssistantMessage(script.emptyExtraction ? "" : extractionReply(call.user));
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

	// The reviewer of the wiring package: progress was parsed out of the indexer's activity text.
	it("progress reaches the upload hook as structured values, not parsed text", async () => {
		const owner = lesson("Progress");
		const m = await upload(owner, "progress.pdf", longPdf(18));
		const seen: unknown[] = [];
		const outcome = await indexing.indexMaterialContent(owner, m, {
			signal: new AbortController().signal,
			store: materialStore,
			model: { engine: engine(), chatId: owner },
			force: true,
			onProgress: (p) => seen.push(p),
		});
		const n = outcome.digest!.batches.length;
		assert.ok(n >= 2);
		assert.deepEqual(seen, [...Array.from({ length: n }, (_, i) => ({ stage: "part", part: i + 1, parts: n })), { stage: "profile" }, undefined]);
	});

	it("an empty extraction reply is recorded in the indexer's own words", async () => {
		const owner = lesson("Empty reply");
		script = { ...DEFAULT_SCRIPT, emptyExtraction: true };
		const m = await upload(owner, "empty.pdf", SINGLE);
		const failed = failedBatchesOf(storedDigest(owner, m));
		assert.equal(failed.length, 1);
		assert.match(failed[0]!.error, /the model returned an empty reply instead of the part's notes/);
		assert.doesNotMatch(failed[0]!.error, /no profile/);
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

		// the stored-digest skip rule goes through the validated loader: an older digest version, a truncated file and a
		// hand-edited one are indexed again
		const current = fs.readFileSync(digestPath, "utf8");
		for (const [what, text] of [
			["version 3", JSON.stringify({ ...storedDigest(owner, m), version: 3 })],
			["truncated", current.slice(0, current.length - 30)],
			["hand-edited", JSON.stringify({ ...storedDigest(owner, m), batches: storedDigest(owner, m).batches.map((b) => ({ ...b, charStart: b.charStart + 0.5 })) })],
		] as const) {
			fs.writeFileSync(digestPath, text);
			assert.equal(indexing.readDigest(digestPath), undefined, what);
			const again = await counted(() => direct(owner, m));
			assert.equal(again.value.status, "indexed", what);
			assert.equal(again.index, 1, what);
		}

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
		assert.deepEqual(failedBatchesOf(digest).map((b) => b.index), [1]);
		assert.ok(!("failedBatches" in digest), "derived on read, never stored");
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
		assert.equal(failedBatchesOf(storedDigest(owner, m)).length, 0);
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

	// Review 3, concern: a failed rewrite of a valid profile returned profile: null, so a caller persisting it lost the profile.
	it("a failed rewrite keeps the previous profile, in digest.json and on the material, and says so", async () => {
		const owner = lesson("Rewrite fails");
		const m = await upload(owner, "keep.pdf", longPdf(18));
		assert.equal(m.profile, DIGEST_PROFILE);
		const before = fs.readFileSync(aux(owner, m, indexing.MATERIAL_DIGEST_FILE), "utf8");
		script = { ...DEFAULT_SCRIPT, reduceReply: "no headings at all" };
		const { value: after, index } = await counted(async () => {
			assert.ok(service.rewriteMaterialProfile(owner, m.id).ok);
			await idle();
			return find(owner, m.id);
		});
		assert.equal(index, 2, "the reduce call and its one retry");
		assert.equal(after.profile, DIGEST_PROFILE);
		assert.equal(after.indexingError, undefined);
		assert.match(after.indexingWarnings?.join(" ") ?? "", /Writing the profile again failed .*the previous profile is kept/);
		assert.equal(storedDigest(owner, m).profile, DIGEST_PROFILE);
		assert.deepEqual(JSON.parse(fs.readFileSync(aux(owner, m, indexing.MATERIAL_DIGEST_FILE), "utf8")), JSON.parse(before));
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
	it("merges a course's digests by exact id, suggests duplicates, resolves citations to materials and lists what is missing", async () => {
		const course = courseStore.createCourse("Linear algebra");
		script = { ...DEFAULT_SCRIPT, terms: (name) => (name === "a.pdf" ? ["Eigenvalue", "Matrix"] : name === "b.pdf" ? ["Eigenvalue", "matrix", "Vector"] : ["Eigenvalue"]) };
		const a = await upload(course.id, "a.pdf", pdfOf(["Eigenvalues of a matrix"], ["Diagonal matrices"]));
		const b = await upload(course.id, "b.pdf", pdfOf(["Eigenvalues and vectors"], ["Vector spaces"]));
		const notes = await upload(course.id, "notes.md", new TextEncoder().encode("# Notes"));

		const glossary = indexing.courseGlossary(course.id)!;
		assert.deepEqual(Object.keys(glossary.terms), ["t_Eigenvalue", "t_Matrix", "t_Vector", "t_matrix"]);
		const eigen = findTerm(glossary, "eigenvalue")!;
		assert.equal(eigen.id, "t_Eigenvalue");
		assert.equal(eigen.citations.length, 2);
		assert.equal(eigen.occurrenceCount, 2);
		assert.deepEqual(eigen.citations.flatMap((c) => c.materials.map((x) => x.id)).sort(), [a.id, b.id].sort());
		// Matrix (a.pdf) and matrix (b.pdf) stay two entries, side by side for the planner; lookup does not pick one
		assert.equal(findTerm(glossary, "matrix"), undefined);
		assert.deepEqual(findTermCandidates(glossary, "matrix").map((c) => c.entry.citations.map((x) => x.materials)), [[[{ id: a.id, name: "a.pdf" }]], [[{ id: b.id, name: "b.pdf" }]]]);
		assert.deepEqual(glossary.suggestedDuplicates, [{ ids: ["t_Matrix", "t_matrix"], reasons: ["similar_name"] }]);
		assert.deepEqual(glossary.conflicts, []);
		assert.deepEqual(glossary.indexed.map((x) => x.id).sort(), [a.id, b.id].sort());
		assert.deepEqual(glossary.incomplete, [{ id: notes.id, name: "notes.md", kind: "text", reason: "no_digest" }]);

		// a part that failed is merged and listed with its pages; an outdated digest and an invalid file are left out
		script = { ...DEFAULT_SCRIPT, terms: () => ["Eigenvalue"], failBatch: (i) => i === 1 };
		const c = await upload(course.id, "c.pdf", longPdf(18));
		const failed = failedBatchesOf(storedDigest(course.id, c));
		assert.equal(failed.length, 1);
		fs.writeFileSync(aux(course.id, b, indexing.MATERIAL_DIGEST_FILE), JSON.stringify({ ...storedDigest(course.id, b), indexerVersion: 0 }));
		fs.writeFileSync(aux(course.id, a, indexing.MATERIAL_DIGEST_FILE), fs.readFileSync(aux(course.id, a, indexing.MATERIAL_DIGEST_FILE), "utf8").slice(0, 200));
		const partial = indexing.courseGlossary(course.id)!;
		assert.equal(findTerm(partial, "vector"), undefined);
		assert.deepEqual(findTerm(partial, "eigenvalue")!.citations.map((x) => x.materials), [[{ id: c.id, name: "c.pdf" }]]);
		assert.deepEqual(
			partial.incomplete.map((g) => [g.id, g.reason]).sort(),
			[
				[a.id, "invalid"],
				[b.id, "outdated"],
				[c.id, "failed_batches"],
				[notes.id, "no_digest"],
			].sort(),
		);
		assert.match(partial.incomplete.find((g) => g.id === a.id)!.detail!, /not JSON/);
		assert.deepEqual(partial.incomplete.find((g) => g.id === c.id)!.failedPages, [{ pageStart: failed[0]!.pageStart, pageEnd: failed[0]!.pageEnd, pages: failed[0]!.pages }]);
		assert.equal(indexing.courseGlossary("course_unknown"), null);
	});
});

// ── Review 4 ──────────────────────────────────────────────────────────────

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const exists = (ownerId: string, m: LessonMaterial, file: string) => fs.existsSync(aux(ownerId, m, file));
/** Replace a material's stored original (what the next conversion reads). */
const replacePdf = (ownerId: string, m: LessonMaterial, bytes: Uint8Array) => fs.writeFileSync(materialStore.filePath(ownerId, m), bytes);
const SCANNED = tinyPdf([{ image: true }]);
const OTHER = pdfOf(["Eigenvectors span the eigenspace"], ["Diagonalisation"], ["The spectral theorem"]);

/**
 * THE INDEX INVARIANT, on disk and on the record: digest.json, a profile that came from a digest, and the indexing
 * fields describe the content.md on disk now, or are absent.
 */
function assertIndexInvariant(ownerId: string, id: string, what: string): void {
	const m = find(ownerId, id);
	const hasContent = exists(ownerId, m, PDF_CONTENT_FILE);
	const digestFile = exists(ownerId, m, indexing.MATERIAL_DIGEST_FILE);
	if (!hasContent) assert.equal(digestFile, false, `${what}: no content.md, so no digest.json`);
	if (digestFile) {
		const digest = indexing.readDigest(aux(ownerId, m, indexing.MATERIAL_DIGEST_FILE));
		assert.ok(digest, `${what}: digest.json is a valid digest`);
		const sidecar = JSON.parse(fs.readFileSync(aux(ownerId, m, PDF_CONVERSION_SIDECAR), "utf8"));
		assert.equal(digest.sourceHash, sha256(fs.readFileSync(aux(ownerId, m, PDF_CONTENT_FILE), "utf8")), `${what}: the digest is of the content.md on disk`);
		assert.equal(digest.converter, sidecar.converterId, what);
		assert.equal(digest.converterVersion, sidecar.converterVersion, what);
	}
	if (m.profileFromDigest) assert.equal(indexing.readDigest(aux(ownerId, m, indexing.MATERIAL_DIGEST_FILE))?.profile, m.profile, `${what}: a profile from a digest is the current digest's`);
	if (m.indexingCalls !== undefined || m.indexingWarnings !== undefined) assert.ok(digestFile, `${what}: indexing calls and warnings belong to the digest on disk`);
	if (m.indexingError) assert.ok(hasContent, `${what}: no indexing note without content.md`);
	assert.equal(exists(ownerId, m, indexing.MATERIAL_INDEXING_STARTED), false, `${what}: no indexing marker left`);
}

async function retryConversion(ownerId: string, id: string): Promise<LessonMaterial> {
	const started = service.retryMaterialConversion(ownerId, id);
	assert.ok(started.ok, JSON.stringify(started));
	await idle();
	return find(ownerId, id);
}

describe("review 4, finding 1: a conversion run leaves no stale index, whichever way it ends", () => {
	// Reviewer's sequence 1: 0 indexing calls, the old profile, indexingCalls 1, digest.json kept, the glossary "outdated".
	it("converted, with a vision model: the new content.md is indexed in the same run, with progress, and the profile is the new digest's", async () => {
		const course = courseStore.createCourse("Retry converted");
		const m = await upload(course.id, "changed.pdf", SINGLE);
		assert.equal(m.profileFromDigest, true);
		const before = storedDigest(course.id, m);
		replacePdf(course.id, m, OTHER);
		script = { ...DEFAULT_SCRIPT, terms: () => ["Eigenvector"], onIndexCall: () => lines.push(materialStatusLine(find(course.id, m.id))) };
		const lines: string[] = [];
		const { value: after, index, profiler } = await counted(() => retryConversion(course.id, m.id));
		assert.equal(index, 1, "the new content.md is indexed (one part, one call)");
		assert.equal(profiler, 0);
		assert.deepEqual(lines, ["reading… · indexing: part 1 of 1"], "progress shows, and the material is being read again");
		const digest = storedDigest(course.id, after);
		assert.notEqual(digest.sourceHash, before.sourceHash);
		assert.deepEqual(digest.terms.map((t) => t.term), ["Eigenvector"]);
		assert.equal(after.status, "ready");
		assert.equal(after.profile, DIGEST_PROFILE);
		assert.equal(after.profileFromDigest, true);
		assert.equal(after.pages, 3);
		assert.equal(after.indexingCalls, 1);
		assert.equal(after.indexingError, undefined);
		assertIndexInvariant(course.id, m.id, "converted, model");
		const glossary = indexing.courseGlossary(course.id)!;
		assert.deepEqual(glossary.incomplete, []);
		assert.ok(findTerm(glossary, "Eigenvector"));
		// identical content again: the digest still describes it, so nothing is re-read
		const again = await counted(() => retryConversion(course.id, m.id));
		assert.equal(again.index, 0);
		assert.equal(again.value.indexingCalls, 1);
		assertIndexInvariant(course.id, m.id, "converted again, unchanged");
	});

	it("review 5, finding 1: a copy without the original PDF refuses a conversion retry and keeps its profile", async () => {
		const course = courseStore.createCourse("Retry on a synced copy");
		const m = await upload(course.id, "synced.pdf", SINGLE);
		assert.equal(m.profileFromDigest, true);
		// what a second device holds: the record and content.md, not the original
		fs.rmSync(materialStore.filePath(course.id, m));
		const refused = service.retryMaterialConversion(course.id, m.id);
		assert.equal(refused.ok, false);
		assert.equal(!refused.ok && refused.status, 409);
		assert.match(!refused.ok ? refused.error : "", /not on this device/);
		await idle();
		const after = find(course.id, m.id);
		assert.equal(after.status, "ready");
		assert.equal(after.profile, m.profile);
		assert.equal(after.profileFromDigest, true);
		assert.equal(after.indexingCalls, m.indexingCalls);
	});

	it("review 5, finding 3: a converter version with stray whitespace, or none, is stored in a form the digest reader accepts", () => {
		assert.equal(indexing.storedConverterVersion("docling 2.61.1\n"), "docling 2.61.1");
		assert.equal(indexing.storedConverterVersion("docling "), "docling");
		assert.equal(indexing.storedConverterVersion(""), "unknown");
		assert.equal(indexing.storedConverterVersion("   "), "unknown");
		assert.equal(indexing.storedConverterVersion(undefined), "unknown");
	});

	it("converted, without a vision model: no stale digest or profile from one is left, and indexing is shown as pending", async () => {
		const course = courseStore.createCourse("Retry no model");
		const m = await upload(course.id, "nomodel.pdf", SINGLE);
		replacePdf(course.id, m, OTHER);
		writeSettings({ version: 1 });
		const { value: after, index, profiler } = await counted(() => retryConversion(course.id, m.id));
		assert.equal(index + profiler, 0);
		assert.ok(exists(course.id, after, PDF_CONTENT_FILE), "converted");
		assert.equal(exists(course.id, after, indexing.MATERIAL_DIGEST_FILE), false, "the old digest is gone");
		assert.equal(after.profile, undefined, "the profile came from the old digest");
		assert.equal(after.profileFromDigest, undefined);
		assert.equal(after.indexingCalls, undefined);
		assert.equal(after.indexingWarnings, undefined);
		assert.equal(after.indexingError?.kind, "pending");
		assert.match(materialStatusLine(after), /Indexing this PDF is pending: no vision model is configured/);
		assert.equal(after.status, "error", "no profile and no model, as at upload");
		assertIndexInvariant(course.id, m.id, "converted, no model");
		assert.deepEqual(indexing.courseGlossary(course.id)!.incomplete.map((g) => g.reason), ["no_digest"]);
		// once a model is configured, retrying the indexing gives the profile back
		writeSettings(VISION);
		assert.ok(service.retryMaterialIndexing(course.id, m.id).ok);
		await idle();
		assert.equal(find(course.id, m.id).profile, DIGEST_PROFILE);
		assert.equal(find(course.id, m.id).indexingError, undefined);
		assertIndexInvariant(course.id, m.id, "indexed after the model came back");
	});

	// Reviewer's sequence 2: content.md deleted, digest.json left as a stray file, indexingCalls still 1.
	it("conversion failed: no digest or indexing field is left, and the material stays usable through the old path", async () => {
		const owner = lesson("Retry fails");
		script = { ...DEFAULT_SCRIPT, failBatch: (i) => i === 0, singleProfile: true };
		const m = await upload(owner, "fails.pdf", longPdf(18));
		assert.ok(m.indexingWarnings && m.indexingCalls);
		script = DEFAULT_SCRIPT;
		replacePdf(owner, m, SCANNED);
		const { value: after, index, profiler } = await counted(() => retryConversion(owner, m.id));
		assert.equal(after.conversionError?.kind, "no_text");
		assert.equal(exists(owner, after, PDF_CONTENT_FILE), false);
		assert.equal(exists(owner, after, indexing.MATERIAL_DIGEST_FILE), false, "no stray digest.json");
		assert.equal(after.indexingCalls, undefined);
		assert.equal(after.indexingWarnings, undefined);
		assert.equal(after.indexingError, undefined);
		assert.equal(index, 0);
		assert.ok(profiler >= 1, "the profile came from the removed digest, so the old profiler reads the original");
		assert.equal(after.status, "ready");
		assert.equal(after.profile, OLD_PROFILE);
		assert.equal(after.profileFromDigest, undefined);
		assertIndexInvariant(owner, m.id, "conversion failed");
	});

	// Reviewer's sequence 3: content.md written, the conversion error cleared, but no indexing and the glossary "no_digest".
	it("a scanned PDF read the old way, then converted on retry: the new content.md is indexed and joins the glossary", async () => {
		const course = courseStore.createCourse("Retry OCR");
		const m = await upload(course.id, "scan.pdf", SCANNED);
		assert.equal(m.conversionError?.kind, "no_text");
		assert.equal(m.profile, OLD_PROFILE);
		assert.deepEqual(indexing.courseGlossary(course.id)!.incomplete.map((g) => g.reason), ["no_digest"]);
		replacePdf(course.id, m, SINGLE); // what a converter with OCR would now read
		const { value: after, index } = await counted(() => retryConversion(course.id, m.id));
		assert.equal(after.conversionError, undefined);
		assert.equal(index, 1);
		assert.equal(after.profile, DIGEST_PROFILE, "the digest's profile replaces the old profiler's");
		assert.equal(after.profileFromDigest, true);
		assert.equal(after.indexingCalls, 1);
		assertIndexInvariant(course.id, m.id, "converted on retry");
		const glossary = indexing.courseGlossary(course.id)!;
		assert.deepEqual(glossary.incomplete, []);
		assert.deepEqual(glossary.indexed.map((x) => x.id), [m.id]);
	});

	it("review 5, finding 2: a re-index after a conversion retry that keeps the old profile leaves a note if the app quits during it", async () => {
		const course = courseStore.createCourse("Retry OCR, quit while indexing");
		const m = await upload(course.id, "scan-quit.pdf", SCANNED);
		assert.equal(m.profile, OLD_PROFILE);
		replacePdf(course.id, m, SINGLE);
		let release!: () => void;
		let during: LessonMaterial | undefined;
		script = { ...DEFAULT_SCRIPT, gate: new Promise<void>((r) => (release = r)), onIndexCall: () => (during ??= find(course.id, m.id)) };
		assert.ok(service.retryMaterialConversion(course.id, m.id).ok);
		await until(() => during !== undefined);
		// What the record on disk says if the app quits now: still ready with the old profile, and a note with the Retry wording.
		assert.equal(during!.status, "ready");
		assert.equal(during!.profile, OLD_PROFILE);
		assert.equal(during!.indexingError?.kind, "pending");
		assert.match(during!.indexingError?.message ?? "", /has not finished \(if the app stopped while it ran, it was interrupted\), so the material keeps the profile it had\. Retry the indexing to try again\./);
		assert.ok(exists(course.id, m, indexing.MATERIAL_INDEXING_STARTED));
		assert.match(materialStatusLine({ ...during!, indexingProgress: undefined }), /has not finished/, "after a restart (no run, no progress) the row shows the note");
		release();
		await idle();
		const after = find(course.id, m.id);
		assert.equal(after.indexingError, undefined, "the completed index replaces the note");
		assert.equal(after.profile, DIGEST_PROFILE);
		assertIndexInvariant(course.id, m.id, "re-indexed after a conversion retry");
	});

	// The other writer of content.md: the conversion inside a read that restarts (status reading after an app restart).
	it("a restarted read that re-converts changed content drops the stale digest too, also without a vision model", async () => {
		const owner = lesson("Restart converts");
		const m = await upload(owner, "restart-convert.pdf", SINGLE);
		replacePdf(owner, m, OTHER);
		writeSettings({ version: 1 });
		materialStore.update(owner, m.id, { status: "reading" });
		service.listMaterials(owner);
		await idle();
		const after = find(owner, m.id);
		assert.equal(exists(owner, after, indexing.MATERIAL_DIGEST_FILE), false);
		assert.equal(after.profile, undefined);
		assert.equal(after.indexingError?.kind, "pending");
		assertIndexInvariant(owner, m.id, "restart, no model");
		writeSettings(VISION);
		materialStore.update(owner, m.id, { status: "reading" });
		const resumed = await counted(async () => {
			service.listMaterials(owner);
			await idle();
			return find(owner, m.id);
		});
		assert.equal(resumed.index, 1);
		assert.equal(resumed.value.profile, DIGEST_PROFILE);
		assertIndexInvariant(owner, m.id, "restart, model");
	});
});

describe("review 4, findings 3, 4 and 7, and the retry messages", () => {
	// Finding 3: with "profile": "" in a valid digest, digestNotes saw a profile and recorded no error while the upload
	// hook treated it as missing and silently ran the old profiler.
	it("finding 3: a stored digest with an empty profile is no current digest; it is indexed again and the notes agree", async () => {
		const owner = lesson("Empty profile");
		const m = await upload(owner, "empty-profile.pdf", SINGLE);
		const digestPath = aux(owner, m, indexing.MATERIAL_DIGEST_FILE);
		const { profileError: _e, ...rest } = storedDigest(owner, m);
		fs.writeFileSync(digestPath, JSON.stringify({ ...rest, profile: "" }));
		assert.match(indexing.rewriteRefusal(owner, m, materialStore) ?? "", /stored index is not valid \("profile" is not a valid profile/, "the reason is shown");
		const restarted = await counted(async () => {
			materialStore.update(owner, m.id, { status: "reading", profile: undefined });
			service.listMaterials(owner);
			await idle();
			return find(owner, m.id);
		});
		assert.equal(restarted.index, 1, "re-indexed, as the skip rule says for an invalid digest");
		assert.equal(restarted.profiler, 0, "not silently the old profiler");
		assert.equal(restarted.value.profile, DIGEST_PROFILE);
		assert.equal(restarted.value.indexingError, undefined);
		assert.equal(storedDigest(owner, m).profile, DIGEST_PROFILE);
		// an invalid profile in a digest object is no profile for the notes either (the same helper)
		assert.equal(indexing.digestNotes({ ...storedDigest(owner, m), profile: " " } as MaterialDigest).error?.kind, "no_profile");
	});

	// Finding 4: a one-part PDF whose extraction failed twice: rewrite returned ok with 0 calls and the note said
	// "Rewrite the profile to try again".
	it("finding 4: a digest with no indexed part cannot have its profile rewritten, and the note says to retry the indexing", async () => {
		const owner = lesson("Nothing indexed");
		script = { ...DEFAULT_SCRIPT, failBatch: () => true };
		const m = await upload(owner, "nothing.pdf", SINGLE);
		assert.equal(failedBatchesOf(storedDigest(owner, m)).length, 1);
		assert.equal(m.indexingError?.kind, "no_profile");
		assert.match(m.indexingError!.message, /Retry the indexing to try again\.$/);
		assert.doesNotMatch(m.indexingError!.message, /Rewrite the profile/);
		assert.equal(indexing.canRewriteProfile(owner, m, materialStore), false);
		const before = fs.readFileSync(aux(owner, m, indexing.MATERIAL_DIGEST_FILE), "utf8");
		assert.deepEqual(service.rewriteMaterialProfile(owner, m.id), { ok: false, status: 409, error: "No part of this PDF could be indexed, so there is nothing to write a profile from: retry the indexing first" });
		assert.equal(fs.readFileSync(aux(owner, m, indexing.MATERIAL_DIGEST_FILE), "utf8"), before, "digest.json untouched");
		// with a part indexed and no profile, the note names the rewrite
		script = { ...DEFAULT_SCRIPT, singleProfile: false };
		const p = await upload(owner, "partial.pdf", SINGLE);
		assert.match(p.indexingError!.message, /Rewrite the profile to try again\.$/);
	});

	// Finding 7: during an upload, rewriteMaterialProfile said "no current index" instead of "still being read".
	it("finding 7: a rewrite or retry during an upload says the material is still being read", async () => {
		const owner = lesson("During upload");
		let release!: () => void;
		let started = false;
		script = { ...DEFAULT_SCRIPT, gate: new Promise<void>((r) => (release = r)), onIndexCall: () => (started = true) };
		const added = service.addUploadedMaterial(owner, { name: "busy.pdf", type: "application/pdf", bytes: SINGLE });
		assert.ok(added.ok);
		if (!added.ok) return;
		await until(() => started);
		assert.deepEqual(service.rewriteMaterialProfile(owner, added.value.id), { ok: false, status: 409, error: "busy.pdf is still being read" });
		assert.deepEqual(service.retryMaterialIndexing(owner, added.value.id), { ok: false, status: 409, error: "busy.pdf is still being read" });
		release();
		await idle();
	});

	// Concern: after a failed retryMaterialIndexing the note said the old profiler ran (it does not), and the failed
	// parts' warning of the digest still on disk was cleared.
	it("a failed indexing retry keeps the profile and the warnings that still apply, and says what happened", async () => {
		const owner = lesson("Retry throws");
		script = { ...DEFAULT_SCRIPT, failBatch: (i) => i === 1 };
		const m = await upload(owner, "retry-throws.pdf", longPdf(18));
		const warnings = m.indexingWarnings;
		assert.equal(warnings?.length, 1);
		script = DEFAULT_SCRIPT;
		const restore = onRename((_from, to) => {
			if (to.endsWith(indexing.MATERIAL_DIGEST_FILE)) throw new Error("disk full");
		});
		let after: { value: LessonMaterial; index: number; profiler: number };
		try {
			after = await counted(async () => {
				assert.ok(service.retryMaterialIndexing(owner, m.id).ok);
				await idle();
				return find(owner, m.id);
			});
		} finally {
			restore();
		}
		assert.equal(after.profiler, 0, "no old profiler on a retry");
		assert.equal(after.value.indexingError?.kind, "failed");
		assert.doesNotMatch(after.value.indexingError!.message, /read the old way/);
		assert.match(after.value.indexingError!.message, /disk full\), so the material keeps the profile it had\. Retry the indexing/);
		assert.equal(after.value.profile, DIGEST_PROFILE);
		assert.deepEqual(after.value.indexingWarnings, warnings, "the stored digest's failed parts still apply");
		assert.equal(after.value.indexingCalls, m.indexingCalls, "the calls that produced the digest on disk");
		assertIndexInvariant(owner, m.id, "failed retry");
	});
});

describe("review 4, concern: the class glossary cache", () => {
	/** Count reads of content.md and digest.json during `run`. */
	function reads<T>(run: () => T): { value: T; count: number } {
		const original = fs.readFileSync;
		let count = 0;
		fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
			if (typeof file === "string" && (file.endsWith(PDF_CONTENT_FILE) || file.endsWith(indexing.MATERIAL_DIGEST_FILE))) count++;
			return (original as (...a: unknown[]) => unknown)(file, ...rest);
		}) as typeof fs.readFileSync;
		try {
			return { value: run(), count };
		} finally {
			fs.readFileSync = original;
		}
	}
	const uncached = (courseId: string, store = materialStore) => indexing.courseGlossary(courseId, store, { cache: false });

	it("repeated calls read nothing again; a re-index, a re-conversion, a deletion and a move are noticed; results equal the uncached path", async () => {
		indexing.clearCourseGlossaryCache();
		const course = courseStore.createCourse("Cache");
		script = { ...DEFAULT_SCRIPT, terms: (name) => [name === "a.pdf" ? "Alpha" : "Beta"] };
		const a = await upload(course.id, "a.pdf", SINGLE);
		const b = await upload(course.id, "b.pdf", OTHER);
		const first = reads(() => indexing.courseGlossary(course.id)!);
		assert.equal(first.count, 4, "two content.md and two digest.json");
		assert.deepEqual(first.value, uncached(course.id));
		const second = reads(() => indexing.courseGlossary(course.id)!);
		assert.equal(second.count, 0, "nothing read again");
		assert.deepEqual(second.value, first.value);

		// a re-index (a new digest.json)
		script = { ...DEFAULT_SCRIPT, terms: (name) => [name === "a.pdf" ? "Alpha prime" : "Beta"] };
		assert.ok(service.retryMaterialIndexing(course.id, a.id).ok);
		await idle();
		const reindexed = reads(() => indexing.courseGlossary(course.id)!);
		assert.equal(reindexed.count, 2, "only a.pdf is read again");
		assert.ok(findTerm(reindexed.value, "Alpha prime"));
		assert.deepEqual(reindexed.value, uncached(course.id));

		// a re-conversion that changes content.md (without a model, so the digest is dropped and nothing re-indexes)
		replacePdf(course.id, b, pdfOf(["Something else entirely"]));
		writeSettings({ version: 1 });
		await retryConversion(course.id, b.id);
		writeSettings(VISION);
		const reconverted = indexing.courseGlossary(course.id)!;
		assert.deepEqual(reconverted.incomplete.map((g) => [g.id, g.reason]), [[b.id, "no_digest"]]);
		assert.equal(findTerm(reconverted, "Beta"), undefined);
		assert.deepEqual(reconverted, uncached(course.id));

		// a content.md edited behind the indexer's back (same digest): outdated
		fs.appendFileSync(aux(course.id, a, PDF_CONTENT_FILE), "\nedited\n");
		const edited = indexing.courseGlossary(course.id)!;
		assert.deepEqual(edited.incomplete.map((g) => [g.id, g.reason]).sort(), [[a.id, "outdated"], [b.id, "no_digest"]].sort());
		assert.deepEqual(edited, uncached(course.id));

		// a deletion
		service.removeMaterial(course.id, a.id);
		const deleted = indexing.courseGlossary(course.id)!;
		assert.ok(!deleted.indexed.some((x) => x.id === a.id) && !deleted.incomplete.some((x) => x.id === a.id));
		assert.deepEqual(deleted, uncached(course.id));
	});

	it("a material moved to another course is read under its new owner, and the cache is bounded", async () => {
		indexing.clearCourseGlossaryCache();
		const from = courseStore.createCourse("From");
		const to = courseStore.createCourse("To");
		script = { ...DEFAULT_SCRIPT, terms: () => ["Moved term"] };
		const m = await upload(from.id, "moved.pdf", SINGLE);
		assert.equal(indexing.courseGlossary(from.id)!.indexed.length, 1);
		assert.equal(indexing.courseGlossary(to.id)!.indexed.length, 0);
		// move its folder and record (a store that lists it under the new course)
		const fromDir = path.dirname(materialStore.filePath(from.id, m));
		const toDir = path.join(path.dirname(path.dirname(fromDir)), to.id, path.basename(fromDir));
		fs.mkdirSync(path.dirname(toDir), { recursive: true });
		fs.renameSync(fromDir, toDir);
		const moved = {
			...materialStore,
			list: (owner: string) => (owner === to.id ? [m] : owner === from.id ? [] : materialStore.list(owner)),
			auxPath: (owner: string, id: string, name: string) => (owner === to.id && id === m.id ? path.join(toDir, name) : materialStore.auxPath(owner, id, name)),
			filePath: (owner: string, mat: LessonMaterial) => (owner === to.id && mat.id === m.id ? path.join(toDir, mat.file) : materialStore.filePath(owner, mat)),
		};
		const there = indexing.courseGlossary(to.id, moved)!;
		assert.deepEqual(there.indexed.map((x) => x.id), [m.id]);
		assert.ok(findTerm(there, "Moved term"));
		assert.deepEqual(there, uncached(to.id, moved));
		assert.deepEqual(indexing.courseGlossary(from.id, moved)!.indexed, []);
		fs.renameSync(toDir, fromDir);

		// bounded: a course listing more PDF materials than the cache holds
		const many = Array.from({ length: indexing.GLOSSARY_CACHE_MAX + 50 }, (_, i) => ({ ...m, id: `mat_bound${i}`, name: `b${i}.pdf` }));
		const big = { ...materialStore, list: (owner: string) => (owner === to.id ? many : materialStore.list(owner)) };
		const glossary = indexing.courseGlossary(to.id, big)!;
		assert.equal(glossary.incomplete.length, many.length);
		assert.ok(indexing.courseGlossaryCacheSize() <= indexing.GLOSSARY_CACHE_MAX, `${indexing.courseGlossaryCacheSize()} entries`);
		assert.deepEqual(glossary, uncached(to.id, big));
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
