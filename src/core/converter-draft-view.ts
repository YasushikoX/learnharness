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
 * One value a drafted profile decides that goes on the wire, exactly as it is sent (fix round 2: the list is built by
 * walking the profile's schema, so a field the format gains later is listed by default; every drafted profile needs
 * the acknowledgement of the whole list; the red rules only decide which come first, with a reason).
 */
export interface FixedValue {
	/** The method, a path, a query parameter, a fixed header, the key header (name and fixed text), the file field or
	 *  file pointer, a fixed form field or JSON leaf, or any other field the format sends ("other"). */
	kind: "method" | "path" | "query" | "header" | "auth" | "file" | "field" | "other";
	/** The request that sends it ("every request" for headers and the key header). */
	request: "submit" | "poll" | "result" | "every request";
	/** The header name, the field's name or JSON Pointer, the parameter's decoded name, or what it is. */
	label: string;
	/** The value as sent (a query parameter decoded; placeholders as <job id>, <separator>; the key as the mask; an
	 *  invisible or control character as a visible escape such as \u{200B}). */
	value: string;
	/** As written in the profile, when that differs from what is shown (a percent-encoded query parameter: name=value). */
	raw?: string;
	/** Why it is shown in red (an address, a key or an account, an opaque identifier, invisible characters), or absent. */
	warning?: string;
}

export interface ProfilePreflight {
	/** "POST https://ocr.example.com/v1/convert"; with no saved URL, "<your service URL>/v1/convert". */
	submit: string;
	/** How the PDF is sent. */
	body: string;
	/** The one header that carries the key, its value with the key masked; absent for a keyless service. */
	auth?: { header: string; value: string };
	/** Everything the profile decides that is sent, exactly as written: red ones first, then the rest in schema order.
	 *  Approve always needs "I have read these values" for this version. */
	fixed: FixedValue[];
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

/** The heading of the fixed values on the Review step, and the switch Approve always needs. */
export const FIXED_VALUES_HEADING = "Sent with every PDF, exactly as written";
export const ACKNOWLEDGE_LABEL = "I have read these values";
/** The preface of everything the AI wrote in words (its note, its "cannot be expressed" reason). */
export const AI_TEXT_PREFACE = "From the AI, which read documentation that can be wrong or written to mislead it";

export const NO_BASE_URL = "<your service URL>";

// ── The wire types of the wizard (app/api/converters/drafts) ─────────────────

export type ConverterDraftStatus = "ready" | "invalid" | "cannot_express";

export interface ConverterDraftTest {
	report: ConverterValidationReport;
	/** The report is for exactly the profile, URL and key there are now, and passed. */
	current: boolean;
	/** The report no longer applies: it is for an earlier profile or URL, or its pass is void (another key, a restart). */
	stale: boolean;
	/** False when the service's own messages and the page previews are gone: they live only in memory, so after a
	 *  restart the report is the checks in the app's own words (the draft file keeps no service text). */
	previews?: false;
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
	/** A digest (SHA-256, hex) of the profile and URL shown; approval must name it, so it approves what was on screen,
	 *  and the acknowledgement of the fixed values is this digest (any change of the profile or URL voids it). */
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
