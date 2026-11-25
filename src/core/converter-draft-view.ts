import type { ConverterValidationReport, CredentialStatus } from "./converter-settings.ts";

/**
 * What the connector wizard ("Draft with AI", fork addition, 2026-11-25) exchanges with app/api/converters/drafts/.
 * Pure and browser-safe, and free of the profile format's validator (core/converter-draft.ts, server side, builds
 * these). No type here carries a key.
 */

/** What masks the key wherever the wizard shows the key header's value. */
export const KEY_MASK = "••••••••";

export interface ProfileLine {
	label: string;
	value: string;
}

export interface ProfilePreflight {
	/** "POST https://ocr.example.com/v1/convert"; with no saved URL, "<your service URL>/v1/convert". */
	submit: string;
	/** How the PDF is sent. */
	body: string;
	/** The one header that carries the key, its value with the key masked; absent for a keyless service. */
	auth?: { header: string; value: string };
	/** Every fixed header (sent with every request of the job). */
	headers: ProfileLine[];
	/** Every fixed form field or JSON value of the upload. */
	fields: ProfileLine[];
	/** Status checks, when the service works with a job id. */
	poll?: string;
	/** The separate result request. */
	result?: string;
	/** How the pages are found in the answer. */
	pages: string;
	/** Fixed values that name an address: the service could send data there. Each must be acknowledged. */
	warnings: string[];
	/** Every origin a request goes to (only ever the user's). */
	origins: string[];
}

export const NO_BASE_URL = "<your service URL>";

// ── The wire types of the wizard (app/api/converters/drafts) ─────────────────

export type ConverterDraftStatus = "ready" | "invalid" | "cannot_express";

export interface ConverterDraftTest {
	report: ConverterValidationReport;
	/** The report is for exactly the profile, URL and key there are now, and passed. */
	current: boolean;
	/** The report is for an earlier profile or URL than the one shown. */
	stale: boolean;
	at: string;
}

export interface ConverterDraftView {
	id: string;
	/** The id its key is stored under (never a converter the settings can select). */
	converterId: string;
	serviceName: string;
	source: "url" | "paste";
	docsUrl?: string;
	/** What happened to the documentation: fetched from, reduced, cut. */
	docsNotice?: string;
	status: ConverterDraftStatus;
	/** The profile as JSON text (also when it is not valid, so it can be edited). */
	profileText?: string;
	/** Why the profile is not valid (the validator's errors). */
	errors: string[];
	/** Why the last "Ask AI to fix" reply was not used (the draft kept its previous profile). */
	fixErrors?: string[];
	/** "cannot be expressed": the model's reason. */
	reason?: string;
	/** The model's note (it read untrusted documentation: shown as such). */
	note?: string;
	preflight?: ProfilePreflight;
	/** The service URL the user typed for this draft. */
	baseUrl?: string;
	origin?: string;
	keyNeeded: boolean;
	credential: CredentialStatus;
	/** A digest of the profile and URL shown; approval must name it, so it approves what was on screen. */
	shown?: string;
	test?: ConverterDraftTest;
	/** Approve is possible now (a passing Test of exactly this profile, URL and key). */
	approvable: boolean;
	/** Why not, as an instruction. */
	approveBlocked?: string;
	modelCalls: number;
	createdAt: string;
	updatedAt: string;
}

export interface ConverterDraftsOverview {
	/** The model that drafts ("<name> (<provider>)"), or null when none is configured: the wizard offers import only. */
	model: string | null;
	drafts: ConverterDraftView[];
}

/** The plain line on the Describe step that says what will be sent where. */
export function sendLine(input: { docsUrl?: string; sample?: boolean; model: string }): string {
	const sample = input.sample ? ", the sample" : "";
	let host = "";
	try {
		host = input.docsUrl ? new URL(input.docsUrl.trim()).host : "";
	} catch {
		host = "";
	}
	const docs = input.docsUrl !== undefined
		? `The documentation page is fetched once from ${host || "the address you enter"}. Its text${sample} and the name above are sent to ${input.model}.`
		: `The pasted text${sample} and the name above are sent to ${input.model}.`;
	return `${docs} No PDF and no key is sent.`;
}
