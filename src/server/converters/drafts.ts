import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { CallUsage } from "../../core/contracts/chat.ts";
import type { ConverterValidationReport, ConvertersOverview, CredentialStatus } from "../../core/converter-settings.ts";
import {
	CONVERTER_DRAFT_ID_PATTERN,
	DRAFT_DOCS_MAX_CHARS,
	DRAFT_NOTE_MAX_CHARS,
	DRAFT_SAMPLE_MAX_CHARS,
	DRAFT_SERVICE_NAME_MAX,
	boundText,
	cleanText,
	describeProfile,
	draftConverterId,
	plainLine,
	replyShape,
	reportForModel,
	validateDraftProfile,
	withAppFields,
	type AppOwnedFields,
	type ConverterDraftStatus,
	type ConverterDraftView,
	type ConverterDraftsOverview,
	type TestAnswerShape,
} from "../../core/converter-draft.ts";
import { HTTP_CONVERTER_PROFILE_MAX_BYTES, customConverterId, profileShapeProblem, type HttpConverterProfile } from "../../core/http-converter-spec.ts";
import { resolveRoleSpec } from "../../core/settings-resolution.ts";
import { CURRENT_SETTINGS_VERSION, normalizeBaseUrl } from "../../core/settings.ts";
import { piEngineForSpec, type PiEngine } from "../../agent/models.ts";
import { callUsage } from "../../agent/subagents/extraction.ts";
import { draftConverterProfile, fixConverterProfile, type AuthorCall, type AuthorOutcome } from "../../agent/subagents/converter-author.ts";
import { writeFileAtomicSync } from "../../store/atomic-write.ts";
import { readSettings, writeSettings } from "../../store/settings.ts";
import { credentialStatus, readConverterCredential, writeProfileCredential } from "./credentials.ts";
import { convertersDir, listCustomProfiles, saveCustomProfile } from "./custom-profiles.ts";
import { DocsFetchError, fetchDocsPage, type FetchedDocs } from "./docs-fetch.ts";
import { apiKeyProblem, redactSecrets } from "./http-common.ts";
import { createProfileConverter } from "./registry.ts";
import { selfOriginProblem } from "./self-origin.ts";
import { convertersOverview } from "./settings-service.ts";
import { CONVERTER_TEST_DEADLINE_MS, validateConverter } from "./validator.ts";

/**
 * "Draft with AI" (fork addition, 2026-11-25), server side, behind app/api/converters/drafts/. A DRAFT is a converter
 * profile a model wrote from a service's documentation, kept apart from usable profiles until the user approves it:
 *
 *   - stored as `<dataDir>/converters/drafts/<draftId>.json`, a folder the profile list never reads, so a draft is
 *     never listed as a converter, never in settings.json, and cannot be chosen for uploads (`draft:<id>` is not a
 *     converter id the settings accept; an id put there by hand falls back to the built-in reader);
 *   - re-read and re-validated on every use (a file edited on disk is checked again, and its Test pass no longer
 *     matches);
 *   - its service URL is the one the user typed (in the draft file; a profile cannot hold an address), and its key is
 *     in the credential store under `draft:<id>`, bound to that URL, with the same rules as every converter key
 *     (apiKeyProblem; changing the URL removes it; never returned);
 *   - its Test is the converter test (validator.ts) on the bundled PDFs, sent only to that URL's origin;
 *   - APPROVE is possible only after a passing Test of exactly the profile, URL and key there are now (an HMAC of the
 *     three with a per-process secret, held in memory: a restart, any edit, another URL or key needs a new Test) and
 *     for the profile the user was shown (`shown`, a digest of profile and URL the approval names); fixed values that
 *     name an address must be acknowledged. Approval makes it an ordinary custom profile (custom-profiles.ts) with the
 *     URL and key moved to it, and never selects it: "Use for new PDFs" stays a separate step.
 *
 * The model is called only when the user presses Draft or "Ask AI to fix": one drafting call plus at most one repair
 * call, or one fix call (agent/subagents/converter-author.ts). Each call's usage is recorded on the draft and appended
 * to `drafts/usage.jsonl` (kept after approval or discard; counts only). Nothing runs in the background. The documentation page is fetched once, by the app, when the user presses Draft (docs-fetch.ts).
 */

export const DRAFT_RECORD_FORMAT = "learnharness.converter-draft/1";
/** The most drafts kept at once. */
export const MAX_DRAFTS = 20;
const DRAFT_FILE_MAX_BYTES = 512 * 1024;
const MAX_USAGE_ENTRIES = 40;

type ServiceResult<T> = { ok: true; value: T } | { ok: false; error: string; status?: number; errors?: string[] };

interface DraftUsage extends CallUsage {
	at: string;
	call: AuthorCall;
	model: string;
}

interface DraftTestRecord {
	at: string;
	shown: string;
	report: ConverterValidationReport;
	answers: TestAnswerShape[];
}

interface DraftRecord {
	format: typeof DRAFT_RECORD_FORMAT;
	id: string;
	createdAt: string;
	updatedAt: string;
	serviceName: string;
	source: "url" | "paste";
	docsUrl?: string;
	docsNotice?: string;
	/** The documentation text the model saw (kept for "Ask AI to fix"; never fetched again). */
	documentation: string;
	documentationCut: boolean;
	sample?: string;
	status: ConverterDraftStatus;
	profile?: unknown;
	errors: string[];
	fixErrors?: string[];
	reason?: string;
	note?: string;
	baseUrl?: string;
	lastTest?: DraftTestRecord;
	usage: DraftUsage[];
}

// ── Process state: passes and runs (globalThis, so every route module shares them) ──

interface DraftState {
	secret: Buffer;
	/** Draft id → the fingerprint of the profile, URL and key of its last PASSING Test. */
	passes: Map<string, string>;
	/** Draft ids with a model call or a Test running. */
	busy: Set<string>;
	/** A new draft is being written. */
	drafting: boolean;
}

const STATE_KEY = Symbol.for("learnharness.converterDrafts");

function state(): DraftState {
	const g = globalThis as Record<symbol, DraftState | undefined>;
	g[STATE_KEY] ??= { secret: randomBytes(32), passes: new Map(), busy: new Set(), drafting: false };
	return g[STATE_KEY];
}

// ── Files ────────────────────────────────────────────────────────────────

export function draftsDir(): string {
	return path.join(convertersDir(), "drafts");
}

function draftFile(id: string): string {
	return path.join(draftsDir(), `${id}.json`);
}

const str = (value: unknown, max: number): string | undefined => (typeof value === "string" ? value.slice(0, max) : undefined);
const strings = (value: unknown, max: number): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").slice(0, 20).map((v) => v.slice(0, max)) : []);

/** A draft file read back: shape checked, every field bounded, the profile validated again. undefined when unusable. */
function recordOf(value: unknown, id: string): DraftRecord | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	if (raw.format !== DRAFT_RECORD_FORMAT || raw.id !== id) return undefined;
	const serviceName = plainLine(str(raw.serviceName, 200) ?? "", DRAFT_SERVICE_NAME_MAX);
	if (!serviceName) return undefined;
	const status = raw.status === "cannot_express" ? "cannot_express" : raw.status === "invalid" ? "invalid" : "ready";
	const baseUrl = typeof raw.baseUrl === "string" ? normalizeBaseUrl(raw.baseUrl) || undefined : undefined;
	const record: DraftRecord = {
		format: DRAFT_RECORD_FORMAT,
		id,
		createdAt: str(raw.createdAt, 40) ?? new Date(0).toISOString(),
		updatedAt: str(raw.updatedAt, 40) ?? new Date(0).toISOString(),
		serviceName,
		source: raw.source === "url" ? "url" : "paste",
		...(str(raw.docsUrl, 2000) ? { docsUrl: str(raw.docsUrl, 2000) } : {}),
		...(str(raw.docsNotice, 400) ? { docsNotice: str(raw.docsNotice, 400) } : {}),
		documentation: cleanText(str(raw.documentation, DRAFT_DOCS_MAX_CHARS) ?? ""),
		documentationCut: raw.documentationCut === true,
		...(str(raw.sample, DRAFT_SAMPLE_MAX_CHARS) ? { sample: cleanText(str(raw.sample, DRAFT_SAMPLE_MAX_CHARS)!) } : {}),
		status,
		...(raw.profile !== undefined ? { profile: raw.profile } : {}),
		errors: strings(raw.errors, 500),
		...(Array.isArray(raw.fixErrors) ? { fixErrors: strings(raw.fixErrors, 500) } : {}),
		...(str(raw.reason, DRAFT_NOTE_MAX_CHARS) ? { reason: plainLine(str(raw.reason, DRAFT_NOTE_MAX_CHARS)!, DRAFT_NOTE_MAX_CHARS) } : {}),
		...(str(raw.note, DRAFT_NOTE_MAX_CHARS) ? { note: plainLine(str(raw.note, DRAFT_NOTE_MAX_CHARS)!, DRAFT_NOTE_MAX_CHARS) } : {}),
		...(baseUrl ? { baseUrl } : {}),
		usage: Array.isArray(raw.usage) ? (raw.usage as DraftUsage[]).slice(-MAX_USAGE_ENTRIES) : [],
	};
	// a profile too deep or too large to walk is dropped before anything (validation, JSON text for the screen) walks it
	if (record.profile !== undefined && profileShapeProblem(record.profile)) {
		delete record.profile;
		record.status = record.status === "cannot_express" ? "cannot_express" : "invalid";
	}
	const test = raw.lastTest as Partial<DraftTestRecord> | undefined;
	const report = test?.report as Partial<ConverterValidationReport> | undefined;
	if (test && typeof test === "object" && typeof test.shown === "string" && report && typeof report.ok === "boolean" && Array.isArray(report.checks) && Array.isArray(report.pages) && Array.isArray(report.warnings) && !profileShapeProblem(test)) {
		record.lastTest = { at: str(test.at, 40) ?? "", shown: test.shown, report: test.report as ConverterValidationReport, answers: Array.isArray(test.answers) ? test.answers.slice(0, 6) : [] };
	}
	// the profile is checked again on every read: an edit on disk cannot make an invalid draft usable
	if (record.status !== "cannot_express") {
		const checked = validateDraftProfile(record.profile);
		if (checked.ok) {
			record.status = "ready";
			record.profile = checked.profile;
			record.errors = [];
		} else {
			record.status = "invalid";
			record.errors = checked.errors;
		}
	}
	return record;
}

function readDraft(id: string): DraftRecord | undefined {
	if (!CONVERTER_DRAFT_ID_PATTERN.test(id)) return undefined;
	try {
		const file = draftFile(id);
		const stat = fs.statSync(file);
		if (!stat.isFile() || stat.size > DRAFT_FILE_MAX_BYTES) return undefined;
		return recordOf(JSON.parse(fs.readFileSync(file, "utf8")), id);
	} catch {
		return undefined;
	}
}

function writeDraft(record: DraftRecord): void {
	fs.mkdirSync(draftsDir(), { recursive: true });
	writeFileAtomicSync(draftFile(record.id), `${JSON.stringify({ ...record, updatedAt: new Date().toISOString() }, null, "\t")}\n`);
}

function draftIds(): string[] {
	try {
		return fs.readdirSync(draftsDir()).filter((n) => /^d[0-9a-f]{12}\.json$/.test(n)).map((n) => n.slice(0, -".json".length)).sort();
	} catch {
		return [];
	}
}

// ── Fingerprints ─────────────────────────────────────────────────────────

function profileText(record: DraftRecord): string {
	return JSON.stringify(record.profile ?? null);
}

/** A public digest of the profile and URL on screen: approval names it, so it approves what the user saw. */
function shownDigest(record: DraftRecord): string {
	return createHash("sha256").update(JSON.stringify([profileText(record), record.baseUrl ?? ""])).digest("hex").slice(0, 24);
}

/** The profile, URL and key, under a per-process secret (never stored, never sent). */
function fingerprint(record: DraftRecord): string {
	const key = record.baseUrl ? (readConverterCredential(draftConverterId(record.id), record.baseUrl) ?? "") : "";
	return createHmac("sha256", state().secret).update(JSON.stringify([profileText(record), record.baseUrl ?? "", key])).digest("hex");
}

// ── Views ────────────────────────────────────────────────────────────────

function viewOf(record: DraftRecord): ConverterDraftView {
	const cid = draftConverterId(record.id);
	const valid = record.status === "ready" ? (record.profile as HttpConverterProfile) : undefined;
	const keyNeeded = !!valid?.auth || (record.status !== "ready" && !!(record.profile as { auth?: unknown } | undefined)?.auth);
	const credential: CredentialStatus = keyNeeded ? credentialStatus(cid, record.baseUrl) : { stored: false };
	const shown = shownDigest(record);
	const pass = state().passes.get(record.id);
	const current = !!record.lastTest && record.lastTest.report.ok && record.lastTest.shown === shown && pass !== undefined && pass === fingerprint(record);
	let approveBlocked: string | undefined;
	if (record.status === "cannot_express") approveBlocked = "The service cannot be described by a profile.";
	else if (!valid) approveBlocked = "The draft is not a valid profile yet: edit the JSON or ask AI to fix it.";
	else if (!record.baseUrl) approveBlocked = "Enter the service URL first.";
	else if (keyNeeded && !credential.stored) approveBlocked = "Save its API key first.";
	else if (!record.lastTest) approveBlocked = "Run Test first.";
	else if (!current) approveBlocked = record.lastTest.report.ok ? "The profile, URL or key changed since the Test passed: run Test again." : "The Test failed: fix the profile and run Test again.";
	return {
		id: record.id,
		converterId: cid,
		serviceName: record.serviceName,
		source: record.source,
		...(record.docsUrl ? { docsUrl: record.docsUrl } : {}),
		...(record.docsNotice ? { docsNotice: record.docsNotice } : {}),
		status: record.status,
		...(record.profile !== undefined ? { profileText: JSON.stringify(record.profile, null, 2) } : {}),
		errors: record.errors,
		...(record.fixErrors?.length ? { fixErrors: record.fixErrors } : {}),
		...(record.reason ? { reason: record.reason } : {}),
		...(record.note ? { note: record.note } : {}),
		...(valid ? { preflight: describeProfile(valid, record.baseUrl, credential) } : {}),
		...(record.baseUrl ? { baseUrl: record.baseUrl, origin: new URL(record.baseUrl).origin } : {}),
		keyNeeded,
		credential,
		shown,
		...(record.lastTest ? { test: { report: record.lastTest.report, current, at: record.lastTest.at, stale: record.lastTest.shown !== shown } } : {}),
		approvable: approveBlocked === undefined,
		...(approveBlocked ? { approveBlocked } : {}),
		modelCalls: record.usage.length,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
}

/** The model that drafts: the course planner's (the strong slot, or a Course planner override). */
function authorModel(): { engine: PiEngine; label: string; id: string } | undefined {
	const spec = resolveRoleSpec("coursePlanner", readSettings());
	if (!spec) return undefined;
	try {
		const engine = piEngineForSpec(spec);
		return { engine, label: `${engine.model.name || spec.id} (${spec.provider})`, id: `${spec.provider}/${spec.id}` };
	} catch {
		return undefined;
	}
}

export const NO_AUTHOR_MODEL = "No model is configured for drafting (Settings → Agent: the strong slot, or a Course planner override). You can still import a profile.";

export function draftsOverview(): ConverterDraftsOverview {
	const drafts = draftIds().map(readDraft).filter((d): d is DraftRecord => d !== undefined).map(viewOf);
	return { model: authorModel()?.label ?? null, drafts };
}

export function draftView(id: string): ServiceResult<ConverterDraftView> {
	const record = readDraft(id);
	return record ? { ok: true, value: viewOf(record) } : { ok: false, error: "No such draft", status: 404 };
}

// ── Creating a draft ─────────────────────────────────────────────────────

export interface CreateDraftInput {
	serviceName: string;
	docsUrl?: string;
	docsText?: string;
	sample?: string;
}

/** An untrusted request body as CreateDraftInput (shape and bounds only). */
export function parseCreateDraftBody(body: unknown): ServiceResult<CreateDraftInput> {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Invalid JSON body" };
	const raw = body as Record<string, unknown>;
	const unknown = Object.keys(raw).find((k) => !["serviceName", "docsUrl", "docsText", "sample"].includes(k));
	if (unknown) return { ok: false, error: `unknown field ${unknown}` };
	if (typeof raw.serviceName !== "string" || !plainLine(raw.serviceName, DRAFT_SERVICE_NAME_MAX)) return { ok: false, error: "Enter the service's name" };
	if (raw.serviceName.length > 200) return { ok: false, error: `The name is at most ${DRAFT_SERVICE_NAME_MAX} characters` };
	const docsUrl = typeof raw.docsUrl === "string" && raw.docsUrl.trim() ? raw.docsUrl.trim() : undefined;
	const docsText = typeof raw.docsText === "string" && raw.docsText.trim() ? raw.docsText : undefined;
	if ((raw.docsUrl !== undefined && typeof raw.docsUrl !== "string") || (raw.docsText !== undefined && typeof raw.docsText !== "string")) return { ok: false, error: "docsUrl and docsText must be text" };
	if (!docsUrl === !docsText) return { ok: false, error: "Give either the documentation's address or its pasted text" };
	if (docsUrl && docsUrl.length > 2000) return { ok: false, error: "The documentation address is too long" };
	if (raw.sample !== undefined && typeof raw.sample !== "string") return { ok: false, error: "sample must be text" };
	const sample = typeof raw.sample === "string" && raw.sample.trim() ? raw.sample : undefined;
	if (sample && sample.length > DRAFT_SAMPLE_MAX_CHARS) return { ok: false, error: `The sample is at most ${DRAFT_SAMPLE_MAX_CHARS} characters` };
	return { ok: true, value: { serviceName: raw.serviceName, ...(docsUrl ? { docsUrl } : {}), ...(docsText ? { docsText } : {}), ...(sample ? { sample } : {}) } };
}

/** A profile id for a new draft: from the name, unused by any profile file or other draft. */
function freshProfileId(serviceName: string): string {
	const base = serviceName.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "connector";
	const listing = listCustomProfiles();
	const taken = new Set([
		...listing.profiles.map((p) => p.id),
		...listing.invalid.map((f) => f.file.replace(/\.json$/, "")),
		...draftIds().map((id) => (readDraft(id)?.profile as { id?: unknown } | undefined)?.id).filter((v): v is string => typeof v === "string"),
	]);
	if (!taken.has(base)) return base;
	for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

function ownFields(record: Pick<DraftRecord, "serviceName" | "docsUrl" | "source">, profileId: string, date = new Date()): AppOwnedFields {
	let host = "";
	try {
		host = record.docsUrl ? new URL(record.docsUrl).host : "";
	} catch {
		host = "";
	}
	const docsUrl = record.docsUrl && record.docsUrl.length <= 500 && /^https?:\/\/[^\s]+$/.test(record.docsUrl) ? record.docsUrl : undefined;
	return {
		id: profileId,
		name: record.serviceName,
		...(docsUrl ? { docsUrl } : {}),
		description: `Drafted with AI on ${date.toISOString().slice(0, 10)} from ${host ? `the documentation at ${host}` : "pasted documentation"}; check it before relying on it.`,
	};
}

/** Every model call of the wizard, one JSON line each, kept after a draft is approved or discarded (no text, no key). */
export function draftsUsageLog(): string {
	return path.join(draftsDir(), "usage.jsonl");
}

function usageEntry(usage: Usage, call: AuthorCall, model: string, record: Pick<DraftRecord, "id" | "serviceName">): DraftUsage {
	const entry: DraftUsage = { at: new Date().toISOString(), call, model, ...callUsage(usage) };
	try {
		fs.mkdirSync(draftsDir(), { recursive: true });
		fs.appendFileSync(draftsUsageLog(), `${JSON.stringify({ ...entry, draftId: record.id, serviceName: record.serviceName })}\n`, { mode: 0o600 });
	} catch {
		// accounting must not fail the draft; the entry is still on the draft record
	}
	return entry;
}

export interface DraftDeps {
	/** Tests: the documentation fetch (default docs-fetch.ts, public addresses only). */
	fetchDocs?: (url: string, signal: AbortSignal) => Promise<FetchedDocs>;
}

function applyOutcome(record: DraftRecord, outcome: AuthorOutcome): void {
	record.note = outcome.note || undefined;
	if (outcome.kind === "profile") {
		record.status = "ready";
		record.profile = outcome.profile;
		record.errors = [];
		delete record.reason;
	} else if (outcome.kind === "cannot_express") {
		record.status = "cannot_express";
		record.reason = outcome.reason;
		record.errors = [];
	} else {
		record.status = "invalid";
		if (outcome.profile !== undefined) record.profile = outcome.profile;
		record.errors = outcome.errors;
	}
}

/**
 * Draft a connector: fetch the documentation once (or take the paste), then one model call and at most one repair.
 * The draft is stored whatever the outcome (a profile, "cannot be expressed", or still invalid with the errors).
 */
export async function createConverterDraft(input: CreateDraftInput, signal: AbortSignal, deps: DraftDeps = {}): Promise<ServiceResult<ConverterDraftView>> {
	const model = authorModel();
	if (!model) return { ok: false, error: NO_AUTHOR_MODEL, status: 409 };
	if (draftIds().length >= MAX_DRAFTS) return { ok: false, error: `There are ${MAX_DRAFTS} drafts already: discard one first.`, status: 409 };
	const s = state();
	if (s.drafting) return { ok: false, error: "A connector is being drafted already", status: 409 };
	s.drafting = true;
	try {
		const serviceName = plainLine(input.serviceName, DRAFT_SERVICE_NAME_MAX);
		let documentation: string;
		let cut: boolean;
		let notice: string | undefined;
		let docsUrl: string | undefined;
		if (input.docsUrl) {
			let fetched: FetchedDocs;
			try {
				fetched = await (deps.fetchDocs ?? ((url, sig) => fetchDocsPage(url, { signal: sig })))(input.docsUrl, signal);
			} catch (error) {
				if (error instanceof DocsFetchError) return { ok: false, error: error.message, status: 422 };
				throw error;
			}
			documentation = fetched.text;
			cut = fetched.cut;
			docsUrl = fetched.url;
			notice = `Fetched from ${fetched.host} and reduced to ${fetched.text.length.toLocaleString("en")} characters of text${cut ? `; the page's text was ${fetched.totalChars.toLocaleString("en")} characters, so only the first ${fetched.text.length.toLocaleString("en")} were sent to the model` : ""}.`;
		} else {
			const bounded = boundText(cleanText(input.docsText ?? ""), DRAFT_DOCS_MAX_CHARS);
			documentation = bounded.text;
			cut = bounded.cut;
			if (cut) notice = `The pasted text was ${bounded.totalChars.toLocaleString("en")} characters; only the first ${bounded.text.length.toLocaleString("en")} were sent to the model.`;
		}
		const sample = input.sample ? cleanText(input.sample) : undefined;
		const id = `d${randomBytes(6).toString("hex")}`;
		const now = new Date().toISOString();
		const record: DraftRecord = {
			format: DRAFT_RECORD_FORMAT,
			id,
			createdAt: now,
			updatedAt: now,
			serviceName,
			source: input.docsUrl ? "url" : "paste",
			...(docsUrl ? { docsUrl } : {}),
			...(notice ? { docsNotice: notice } : {}),
			documentation,
			documentationCut: cut,
			...(sample ? { sample } : {}),
			status: "invalid",
			errors: [],
			usage: [],
		};
		const own = ownFields(record, freshProfileId(serviceName));
		const outcome = await draftConverterProfile(
			{ serviceName, documentation, documentationCut: cut, ...(sample ? { sample } : {}) },
			{ engine: model.engine, signal, own, onUsage: (usage, call) => record.usage.push(usageEntry(usage, call, model.id, record)) },
		);
		applyOutcome(record, outcome);
		writeDraft(record);
		return { ok: true, value: viewOf(readDraft(id) ?? record) };
	} finally {
		s.drafting = false;
	}
}

// ── Configuring, editing, testing ────────────────────────────────────────

export interface ConfigureDraftInput {
	id: string;
	/** "" clears it. */
	baseUrl?: string;
	apiKey?: string;
	removeKey?: boolean;
	/** "Edit JSON": the profile text (the app sets its own fields again; validated). */
	profile?: string;
}

export function parseConfigureDraftBody(body: unknown): ServiceResult<ConfigureDraftInput> {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Invalid JSON body" };
	const raw = body as Record<string, unknown>;
	const unknown = Object.keys(raw).find((k) => !["id", "baseUrl", "apiKey", "removeKey", "profile"].includes(k));
	if (unknown) return { ok: false, error: `unknown field ${unknown}` };
	if (typeof raw.id !== "string" || !CONVERTER_DRAFT_ID_PATTERN.test(raw.id)) return { ok: false, error: "id must be a draft id" };
	if (raw.baseUrl !== undefined && typeof raw.baseUrl !== "string") return { ok: false, error: "baseUrl must be a URL" };
	if (raw.apiKey !== undefined && (typeof raw.apiKey !== "string" || raw.apiKey.length > 4096 || /[\r\n\0]/.test(raw.apiKey))) return { ok: false, error: "apiKey must be one line of text" };
	if (raw.removeKey !== undefined && typeof raw.removeKey !== "boolean") return { ok: false, error: "removeKey must be true or false" };
	if (raw.profile !== undefined && typeof raw.profile !== "string") return { ok: false, error: "profile must be the JSON text" };
	return { ok: true, value: raw as unknown as ConfigureDraftInput };
}

function busy<T>(id: string, run: () => Promise<ServiceResult<T>>): Promise<ServiceResult<T>> {
	const s = state();
	if (s.busy.has(id)) return Promise.resolve({ ok: false, error: "This draft is being tested or fixed already", status: 409 });
	s.busy.add(id);
	return run().finally(() => s.busy.delete(id));
}

/** Save the draft's service URL, key or edited JSON; with the same rules as every converter's (settings-service.ts). */
export function configureConverterDraft(input: ConfigureDraftInput): ServiceResult<ConverterDraftView> {
	const record = readDraft(input.id);
	if (!record) return { ok: false, error: "No such draft", status: 404 };
	if (state().busy.has(record.id)) return { ok: false, error: "This draft is being tested or fixed; wait for it or cancel it first", status: 409 };
	const cid = draftConverterId(record.id);

	if (input.profile !== undefined) {
		if (Buffer.byteLength(input.profile, "utf8") > HTTP_CONVERTER_PROFILE_MAX_BYTES) return { ok: false, error: `A profile is at most ${HTTP_CONVERTER_PROFILE_MAX_BYTES / 1024} KB`, status: 400 };
		let parsed: unknown;
		try {
			parsed = JSON.parse(input.profile);
		} catch (error) {
			return { ok: false, error: "The profile is not valid JSON", errors: [(error as Error).message], status: 400 };
		}
		const shape = profileShapeProblem(parsed);
		if (shape) return { ok: false, error: "The profile is not valid", errors: [shape], status: 400 };
		const id = (record.profile as { id?: unknown } | undefined)?.id;
		const own = ownFields(record, typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,47}$/.test(id) ? id : freshProfileId(record.serviceName), new Date(record.createdAt));
		const profile = withAppFields(parsed, own);
		const checked = validateDraftProfile(profile);
		record.profile = checked.ok ? checked.profile : profile;
		record.status = checked.ok ? "ready" : "invalid";
		record.errors = checked.ok ? [] : checked.errors;
		delete record.fixErrors;
		delete record.reason;
	}

	const profile = record.profile as { auth?: unknown; name?: string } | undefined;
	const apiKey = input.apiKey?.trim() || undefined;
	if (apiKey && !profile?.auth) return { ok: false, error: `${record.serviceName} takes no key (its profile has no auth header)` };
	if (apiKey) {
		const problem = apiKeyProblem(apiKey);
		if (problem) return { ok: false, error: `${problem}. Nothing was saved.` };
	}
	const before = record.baseUrl;
	let after = before;
	if (input.baseUrl !== undefined) {
		if (input.baseUrl.trim()) {
			const canonical = normalizeBaseUrl(input.baseUrl);
			if (!canonical) return { ok: false, error: "The URL must be an absolute HTTP(S) address without credentials, query or fragment" };
			const self = selfOriginProblem(canonical);
			if (self) return { ok: false, error: `${self}. Nothing was saved.` };
			after = canonical;
		} else after = undefined;
	}
	if (apiKey && !after) return { ok: false, error: "Enter the service URL before its key: the key is bound to it" };
	if (after) record.baseUrl = after;
	else delete record.baseUrl;
	// any change of profile, URL or key ends the pass, even one that is later undone: approval needs a new Test
	if (input.profile !== undefined || apiKey || input.removeKey || before !== after) state().passes.delete(record.id);
	// the key first, bound to the URL it is for; a URL change without a key removes the old one
	if (apiKey) writeProfileCredential(cid, after!, apiKey);
	else if (input.removeKey || before !== after || !(record.profile as { auth?: unknown } | undefined)?.auth) writeProfileCredential(cid, after ?? "", undefined);
	writeDraft(record);
	return { ok: true, value: viewOf(readDraft(record.id) ?? record) };
}

/** The user's service address and its host, removed from text a model will read. */
function addressRedactor(baseUrl: string | undefined, secret: string | undefined): (text: string) => string {
	const forms: string[] = [];
	if (baseUrl) {
		const url = new URL(baseUrl);
		forms.push(baseUrl, url.origin, url.host, url.hostname);
	}
	const sorted = [...new Set(forms)].filter(Boolean).sort((a, b) => b.length - a.length);
	return (text: string) => {
		let out = redactSecrets(text, [secret]);
		for (const form of sorted) out = out.split(form).join("<service>");
		return out;
	};
}

/** Run the converter test on the draft: the bundled PDFs, sent only to the draft's saved URL. */
export function testConverterDraft(id: string, signal: AbortSignal, deadlineMs = CONVERTER_TEST_DEADLINE_MS): Promise<ServiceResult<ConverterDraftView>> {
	return busy(id, async () => {
		const record = readDraft(id);
		if (!record) return { ok: false, error: "No such draft", status: 404 };
		if (record.status !== "ready") return { ok: false, error: "The draft is not a valid profile yet: edit the JSON or ask AI to fix it.", status: 409 };
		const profile = record.profile as HttpConverterProfile;
		const cid = draftConverterId(record.id);
		if (!record.baseUrl) return { ok: false, error: "Enter the service URL first. Nothing was sent.", status: 409 };
		const secret = readConverterCredential(cid, record.baseUrl);
		if (profile.auth && !secret) return { ok: false, error: "Save its API key first. Nothing was sent.", status: 409 };
		const redact = addressRedactor(record.baseUrl, secret);
		const answers: TestAnswerShape[] = [];
		let pdfIndex = -1;
		let converter;
		try {
			converter = createProfileConverter(cid, profile, { services: { [cid]: { baseUrl: record.baseUrl } } }, readConverterCredential, false, {
				onAnswer: (stage, answer) => {
					if (stage === "submit") pdfIndex++;
					if (answers.length < 6) answers.push({ pdf: pdfIndex <= 0 ? "two-page" : "blank-middle", stage, shape: replyShape(answer, redact) });
				},
			});
		} catch (error) {
			return { ok: false, error: `${redactSecrets((error as Error).message, [secret])}.`, status: 409 };
		}
		const shown = shownDigest(record);
		const print = fingerprint(record);
		const report = await validateConverter(converter, { signal, secrets: secret ? [secret] : [], deadlineMs });
		// the draft may have been discarded or edited while the Test ran: the pass is only for what was tested
		const now = readDraft(id);
		if (!now) return { ok: false, error: "The draft was discarded during the Test", status: 409 };
		now.lastTest = { at: new Date().toISOString(), shown, report, answers };
		const s = state();
		if (report.ok && shownDigest(now) === shown && fingerprint(now) === print) s.passes.set(id, print);
		else s.passes.delete(id);
		writeDraft(now);
		return { ok: true, value: viewOf(readDraft(id) ?? now) };
	});
}

/** "Ask AI to fix": one model call with the previous draft and the redacted Test report (or the validator's errors). */
export function fixConverterDraft(id: string, signal: AbortSignal): Promise<ServiceResult<ConverterDraftView>> {
	return busy(id, async () => {
		const model = authorModel();
		if (!model) return { ok: false, error: NO_AUTHOR_MODEL, status: 409 };
		const record = readDraft(id);
		if (!record) return { ok: false, error: "No such draft", status: 404 };
		const shown = shownDigest(record);
		const failedTest = record.status === "ready" && record.lastTest && !record.lastTest.report.ok && record.lastTest.shown === shown ? record.lastTest : undefined;
		if (record.status === "cannot_express") return { ok: false, error: "The service cannot be described by a profile; discard the draft or edit its JSON.", status: 409 };
		if (record.status === "ready" && !failedTest) return { ok: false, error: "Ask AI to fix after a failed Test of this profile.", status: 409 };
		const secret = record.baseUrl ? readConverterCredential(draftConverterId(record.id), record.baseUrl) : undefined;
		const redact = addressRedactor(record.baseUrl, secret);
		const profileId = (record.profile as { id?: unknown } | undefined)?.id;
		const own = ownFields(record, typeof profileId === "string" && /^[a-z0-9][a-z0-9-]{0,47}$/.test(profileId) ? profileId : freshProfileId(record.serviceName), new Date(record.createdAt));
		const outcome = await fixConverterProfile(
			{
				serviceName: record.serviceName,
				documentation: record.documentation,
				documentationCut: record.documentationCut,
				...(record.sample ? { sample: record.sample } : {}),
				previous: record.profile,
				...(failedTest ? { report: reportForModel(failedTest.report, failedTest.answers, redact) } : { errors: record.errors.map(redact) }),
			},
			{ engine: model.engine, signal, own, onUsage: (usage, call) => record.usage.push(usageEntry(usage, call, model.id, record)) },
		);
		record.usage = record.usage.slice(-MAX_USAGE_ENTRIES);
		if (outcome.kind === "invalid") {
			record.fixErrors = outcome.errors;
		} else {
			applyOutcome(record, outcome);
			delete record.fixErrors;
			delete record.lastTest;
			state().passes.delete(id);
		}
		writeDraft(record);
		return { ok: true, value: viewOf(readDraft(id) ?? record) };
	});
}

// ── Approve, discard ─────────────────────────────────────────────────────

export interface ApproveDraftInput {
	id: string;
	/** The `shown` digest of the draft the user approved on screen. */
	shown: string;
	/** The user acknowledged the fixed values flagged as addresses. */
	acknowledged?: boolean;
}

export function parseApproveDraftBody(body: unknown): ServiceResult<ApproveDraftInput> {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Invalid JSON body" };
	const raw = body as Record<string, unknown>;
	const unknown = Object.keys(raw).find((k) => !["id", "shown", "acknowledged"].includes(k));
	if (unknown) return { ok: false, error: `unknown field ${unknown}` };
	if (typeof raw.id !== "string" || !CONVERTER_DRAFT_ID_PATTERN.test(raw.id)) return { ok: false, error: "id must be a draft id" };
	if (typeof raw.shown !== "string" || !/^[0-9a-f]{24}$/.test(raw.shown)) return { ok: false, error: "shown must name the draft on screen" };
	if (raw.acknowledged !== undefined && typeof raw.acknowledged !== "boolean") return { ok: false, error: "acknowledged must be true or false" };
	return { ok: true, value: raw as unknown as ApproveDraftInput };
}

/**
 * Approve: the draft becomes an ordinary custom profile, its URL and key move with it, and the draft is removed. Only
 * for the profile shown, after a passing Test of exactly this profile, URL and key. Never selects it.
 */
export function approveConverterDraft(input: ApproveDraftInput): ServiceResult<{ id: string; overview: ConvertersOverview }> {
	const record = readDraft(input.id);
	if (!record) return { ok: false, error: "No such draft", status: 404 };
	if (state().busy.has(record.id)) return { ok: false, error: "This draft is being tested or fixed", status: 409 };
	const view = viewOf(record);
	if (input.shown !== view.shown) return { ok: false, error: "The draft changed since it was shown: review it again.", status: 409 };
	if (!view.approvable) return { ok: false, error: view.approveBlocked ?? "The draft cannot be approved yet", status: 409 };
	if (view.preflight?.warnings.length && input.acknowledged !== true) return { ok: false, error: "Confirm the values marked as addresses first.", status: 409 };
	const profile = record.profile as HttpConverterProfile;
	const listing = listCustomProfiles();
	if (listing.profiles.some((p) => p.id === profile.id) || listing.invalid.some((f) => f.file === `${profile.id}.json`)) {
		return { ok: false, error: `A profile with the id ${profile.id} exists already. Remove it, or edit this draft's JSON.`, status: 409 };
	}
	const cid = draftConverterId(record.id);
	const baseUrl = record.baseUrl!;
	const key = readConverterCredential(cid, baseUrl);
	const saved = saveCustomProfile(profile);
	if (!saved.ok) return { ok: false, error: "The profile is not valid", errors: saved.errors, status: 400 };
	const customId = customConverterId(profile.id);
	// the key first, bound to the URL it is for; then the URL; then the draft goes
	if (profile.auth && key) writeProfileCredential(customId, baseUrl, key);
	else writeProfileCredential(customId, "", undefined);
	const settings = readSettings() ?? { version: CURRENT_SETTINGS_VERSION };
	const section = structuredClone(settings.pdfConversion ?? {});
	const services = { ...section.services };
	Object.defineProperty(services, customId, { value: { baseUrl }, enumerable: true, configurable: true, writable: true });
	writeSettings({ ...settings, pdfConversion: { ...section, services } });
	removeDraftFiles(record.id);
	return { ok: true, value: { id: customId, overview: convertersOverview() } };
}

function removeDraftFiles(id: string): void {
	writeProfileCredential(draftConverterId(id), "", undefined);
	fs.rmSync(draftFile(id), { force: true });
	state().passes.delete(id);
}

/** Discard a draft: its file, its key and its Test pass. */
export function discardConverterDraft(id: string): ServiceResult<ConverterDraftsOverview> {
	if (!CONVERTER_DRAFT_ID_PATTERN.test(id)) return { ok: false, error: "id must be a draft id", status: 400 };
	if (state().busy.has(id)) return { ok: false, error: "This draft is being tested or fixed; cancel that first", status: 409 };
	const exists = fs.existsSync(draftFile(id));
	removeDraftFiles(id);
	return exists ? { ok: true, value: draftsOverview() } : { ok: false, error: "No such draft", status: 404 };
}
