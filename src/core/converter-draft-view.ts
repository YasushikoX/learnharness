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

/**
 * One fixed value a profile sends exactly as written, with every PDF (fix round 1: every one is listed and must be
 * acknowledged; the address and key heuristic only decides which are shown first, in red).
 */
export interface FixedValue {
	/** A fixed header, a fixed body or form field, a query parameter of a path, a key header's fixed text, or a path. */
	kind: "header" | "field" | "query" | "auth" | "path";
	/** The request that sends it ("every request" for headers). */
	request: "submit" | "poll" | "result" | "every request";
	/** The header name, the field's name or JSON Pointer, the parameter's decoded name, or which path. */
	label: string;
	/** The value as sent (a query parameter decoded; placeholders as <job id>, <separator>). */
	value: string;
	/** As written in the profile, when that differs from what is shown (a percent-encoded query parameter: name=value). */
	raw?: string;
	/** Why it is shown in red (it looks like an address, a webhook, a key or an account), or absent. */
	warning?: string;
	/** Counts toward the acknowledgement (everything but a bare path and a parameter that is only {{JOB_ID}}). */
	acknowledge: boolean;
}

export interface ProfilePreflight {
	/** "POST https://ocr.example.com/v1/convert"; with no saved URL, "<your service URL>/v1/convert". */
	submit: string;
	/** How the PDF is sent. */
	body: string;
	/** The one header that carries the key, its value with the key masked; absent for a keyless service. */
	auth?: { header: string; value: string };
	/** Every fixed value the profile sends exactly as written: red ones first, then the rest in profile order. */
	fixed: FixedValue[];
	/** A fixed value other than a bare path is sent, or one is red: Approve needs "I have read these values". */
	acknowledgeNeeded: boolean;
	/** Status checks, when the service works with a job id. */
	poll?: string;
	/** The separate result request. */
	result?: string;
	/** How the pages are found in the answer. */
	pages: string;
	/** The red values' one-line reasons ("<label>: <why>"), in the order of `fixed`. */
	warnings: string[];
	/** Every origin a request goes to (only ever the user's). */
	origins: string[];
}

/** The heading of the fixed values on the Review step, and the switch Approve needs when there are any. */
export const FIXED_VALUES_HEADING = "Sent with every PDF, exactly as written";
export const ACKNOWLEDGE_LABEL = "I have read these values";

export const NO_BASE_URL = "<your service URL>";

// ── The wire types of the wizard (app/api/converters/drafts) ─────────────────

export type ConverterDraftStatus = "ready" | "invalid" | "cannot_express";

export interface ConverterDraftTest {
	report: ConverterValidationReport;
	/** The report is for exactly the profile, URL and key there are now, and passed. */
	current: boolean;
	/** The report no longer applies: it is for an earlier profile or URL, or its pass is void (another key, a restart). */
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
	/** A digest of the profile and URL shown; approval must name it, so it approves what was on screen, and the
	 *  acknowledgement of the fixed values is this digest (any change of the profile or URL voids it). */
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
