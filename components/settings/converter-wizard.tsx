"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ACKNOWLEDGE_LABEL, FIXED_VALUES_HEADING, sendLine, type ConverterDraftView, type ConverterDraftsOverview, type ConvertersOverview, type FixedValue } from "@/src/core";
import { Button } from "@/components/ui/button";
import { SettingsRow, SettingsSegmentedControl, Toggle } from "./controls";
import { DRAFT_TEST_CLIENT_TIMEOUT_MS, approveDraft, createDraft, discardDraft, fixDraft, loadDrafts, testDraft, updateDraft } from "./converter-wizard-client.ts";

/**
 * "Draft with AI" (fork addition, 2026-11-25), opened from Settings → PDF conversion: get a converter profile for a
 * PDF service the app has no preset for. Four steps, in the settings screen's own style:
 *
 *   1 Describe   the service's name, its documentation's address (fetched once by the app) or pasted text, an
 *                optional sample, and a line that says exactly what is sent where before anything is;
 *   2 Review     the drafted profile in plain words (the method, the user's own URL joined with each path, how the
 *                PDF is sent, the key header with the key masked, every fixed header and field, how pages are
 *                found), its JSON behind a disclosure, the model's note shown as coming from untrusted documentation,
 *                and where the user enters the service URL and key;
 *   3 Test       the converter test on the bundled PDFs (its checks, the blank-page one included, and page previews),
 *                with Cancel; on failure its diagnostics, "Ask AI to fix" (one model call) and "Edit JSON";
 *   4 Approve    enabled only after a passing Test of exactly the profile, URL and key on screen; it makes the draft
 *                an ordinary profile of your own. "Use for new PDFs" stays a separate step on the main screen.
 *
 * The server does the work and enforces every rule (src/server/converters/drafts.ts); this screen only shows it.
 */

const FIELD =
	"h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50";
const AREA = "min-h-24 rounded-sm border border-border bg-background p-1.5 font-mono text-xs text-foreground outline-none focus:border-muted-foreground/50";
const LINK = "shrink-0 text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline";
const QUIET_LINK = "shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-error hover:underline";
const NOTE = "text-xs leading-relaxed text-muted-foreground";
const BOX = "flex flex-col gap-1 rounded-sm border border-border p-2";
const MARK = { pass: "✓", fail: "✗", skipped: "–" } as const;
const STEPS = ["Describe", "Review", "Test", "Approve"] as const;

type Source = "url" | "paste";

function keyHint(draft: ConverterDraftView): string {
	if (draft.credential.stored) return `A key is stored${draft.credential.hint ? ` (${draft.credential.hint})` : ""}`;
	if (draft.credential.boundElsewhere) return "A key was saved for another URL; enter it again for this one";
	return "Needed; not stored yet";
}

const KIND: Record<FixedValue["kind"], string> = { header: "header", field: "field", query: "query parameter", auth: "key header", path: "path" };

/**
 * Every fixed value the draft sends exactly as written: the red ones (an address, a key, an account) first, each with
 * its reason, then the rest. A bare path is shown but needs no acknowledgement.
 */
function FixedValues({ values }: { values: FixedValue[] }) {
	if (values.length === 0) return null;
	return (
		<div data-testid="wizard-fixed" className="flex flex-col gap-0.5">
			<p className="text-xs font-medium text-foreground">{FIXED_VALUES_HEADING}:</p>
			{values.map((v, i) => (
				<div key={`${v.kind}-${v.request}-${v.label}-${i}`} data-testid={v.warning ? "wizard-fixed-red" : "wizard-fixed-value"} data-kind={v.kind} className={`flex flex-col ${v.warning ? "text-error" : "text-foreground"}`}>
					<span className="font-mono text-[11px]">
						{v.kind === "path" ? `${v.label}: ` : `${v.request === "every request" ? "" : `${v.request} `}${KIND[v.kind]} ${v.label} = `}{v.value}
						{v.raw !== undefined && <span className="text-muted-foreground"> (written as {v.raw})</span>}
					</span>
					{v.warning && <span role="alert" data-testid="wizard-warning" className="text-xs">{v.warning}.</span>}
				</div>
			))}
		</div>
	);
}

function stepOf(draft: ConverterDraftView | null): number {
	if (!draft) return 0;
	if (draft.status !== "ready" || !draft.baseUrl || (draft.keyNeeded && !draft.credential.stored)) return 1;
	return draft.approvable ? 3 : 2;
}

export function ConverterWizard({ onClose, onApproved }: { onClose: () => void; onApproved: (overview: ConvertersOverview, id: string) => void }) {
	const [overview, setOverview] = useState<ConverterDraftsOverview | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [draft, setDraft] = useState<ConverterDraftView | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [errors, setErrors] = useState<string[]>([]);
	const [busy, setBusy] = useState<null | "draft" | "fix" | "save" | "test">(null);
	const run = useRef<AbortController | null>(null);

	const [name, setName] = useState("");
	const [source, setSource] = useState<Source>("url");
	const [docsUrl, setDocsUrl] = useState("");
	const [docsText, setDocsText] = useState("");
	const [sample, setSample] = useState("");

	const [url, setUrl] = useState("");
	const [key, setKey] = useState("");
	const [editing, setEditing] = useState<string | null>(null);
	/** The digest of the version whose fixed values the user said they read: any other version on screen voids it. */
	const [acknowledged, setAcknowledged] = useState<string | null>(null);

	useEffect(() => {
		void loadDrafts().then(({ value, error: failed }) => {
			if (value) setOverview(value);
			else setLoadError(failed);
		});
		return () => run.current?.abort();
	}, []);

	/** Show a draft from the server (after any change), keeping the URL field in step with what is saved. */
	const adopt = useCallback((next: ConverterDraftView) => {
		setDraft(next);
		setUrl(next.baseUrl ?? "");
		setOverview((o) => (o ? { ...o, drafts: [...o.drafts.filter((d) => d.id !== next.id), next] } : o));
	}, []);

	const cancel = useCallback(() => {
		run.current?.abort();
		run.current = null;
		setBusy(null);
	}, []);

	async function start(kind: "draft" | "fix" | "test", request: (signal: AbortSignal) => Promise<{ value: ConverterDraftView | null; error: string | null; aborted?: boolean }>, timeoutMs?: number): Promise<void> {
		cancel();
		const controller = new AbortController();
		run.current = controller;
		let timedOut = false;
		const timer = timeoutMs ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs) : undefined;
		setBusy(kind);
		setError(null);
		setErrors([]);
		const { value, error: failed, aborted } = await request(controller.signal);
		if (timer) clearTimeout(timer);
		if (run.current !== controller) return; // cancelled or replaced: shows nothing
		run.current = null;
		setBusy(null);
		if (timedOut) return setError("The test did not finish within two minutes.");
		if (value) adopt(value);
		else if (!aborted) setError(failed);
	}

	async function save(change: { baseUrl?: string; apiKey?: string; removeKey?: boolean; profile?: string }, after?: () => void): Promise<void> {
		if (!draft) return;
		cancel();
		setBusy("save");
		setError(null);
		setErrors([]);
		const { value, error: failed, errors: list } = await updateDraft({ id: draft.id, ...change });
		setBusy(null);
		if (!value) {
			setError(failed);
			setErrors(list);
			return;
		}
		adopt(value);
		after?.();
	}

	async function approve(): Promise<void> {
		if (!draft?.shown) return;
		setBusy("save");
		setError(null);
		const { value, error: failed } = await approveDraft(draft.id, draft.shown, acknowledged === draft.shown ? acknowledged : undefined);
		setBusy(null);
		if (!value) return setError(failed);
		onApproved(value.overview, value.id);
	}

	async function discard(id: string): Promise<void> {
		cancel();
		setBusy("save");
		const { value, error: failed } = await discardDraft(id);
		setBusy(null);
		if (!value) return setError(failed);
		setOverview(value);
		if (draft?.id === id) open(null);
	}

	function open(next: ConverterDraftView | null): void {
		cancel();
		setDraft(next);
		setUrl(next?.baseUrl ?? "");
		setKey("");
		setEditing(null);
		setAcknowledged(null);
		setError(null);
		setErrors([]);
	}

	const header = (
		<div className="flex flex-wrap items-center justify-between gap-2">
			<p className="text-xs font-medium text-foreground">Draft a connector with AI</p>
			<button type="button" onClick={() => { cancel(); onClose(); }} className={LINK} data-testid="wizard-close">
				Close
			</button>
		</div>
	);

	if (loadError) return <div className={BOX} data-testid="converter-wizard">{header}<p role="alert" className="text-xs text-error">{loadError}</p></div>;
	if (!overview) return <div className={BOX} data-testid="converter-wizard">{header}<p className={NOTE}>Loading…</p></div>;

	const step = stepOf(draft);
	const steps = (
		<ol className="flex flex-wrap gap-3" data-testid="wizard-steps">
			{STEPS.map((s, i) => (
				<li key={s} data-testid={`wizard-step-${s.toLowerCase()}`} data-current={i === step ? "true" : undefined} className={`text-xs ${i === step ? "font-medium text-foreground" : "text-muted-foreground/70"}`}>
					{i + 1} {s}
				</li>
			))}
		</ol>
	);
	const problem = (error || errors.length > 0) && (
		<div role="alert" data-testid="wizard-error" className="flex flex-col gap-0.5">
			{error && <p className="text-xs text-error">{error}</p>}
			{errors.map((e) => <p key={e} className="font-mono text-[11px] text-error">{e}</p>)}
		</div>
	);

	// ── 1 Describe ──
	if (!draft) {
		if (!overview.model) {
			return (
				<div className={BOX} data-testid="converter-wizard">
					{header}
					<p data-testid="wizard-no-model" className={NOTE}>
						No model is configured for drafting (Settings → Agent: the strong slot, or a Course planner override). You can still import a profile below.
					</p>
				</div>
			);
		}
		const docs = source === "url" ? docsUrl.trim() : docsText.trim();
		const canDraft = !!name.trim() && !!docs && busy === null;
		const draft1 = () => void start("draft", (signal) => createDraft({ serviceName: name, ...(source === "url" ? { docsUrl } : { docsText }), ...(sample.trim() ? { sample } : {}) }, signal));
		return (
			<div className={BOX} data-testid="converter-wizard">
				{header}
				{steps}
				<p className={NOTE}>
					For a PDF-to-text service the app has no preset for: an AI reads the service&apos;s documentation and drafts a profile (data, not code). You check what it would send,
					test it on two small PDFs and approve it. Nothing is sent to the service before you have saved its URL and pressed Test.
				</p>
				{overview.drafts.length > 0 && (
					<div className="flex flex-col gap-0.5" data-testid="wizard-drafts">
						{overview.drafts.map((d) => (
							<span key={d.id} className="flex items-center gap-3">
								<button type="button" className={LINK} onClick={() => open(d)} data-testid={`wizard-open-${d.id}`}>
									Continue {d.serviceName}
								</button>
								<span className={NOTE}>{d.status === "ready" ? (d.approvable ? "tested, ready to approve" : "drafted") : d.status === "invalid" ? "not valid yet" : "cannot be described"}</span>
								<button type="button" className={QUIET_LINK} onClick={() => void discard(d.id)} disabled={busy !== null}>
									Discard
								</button>
							</span>
						))}
					</div>
				)}
				<SettingsRow label="Service name" testid="wizard-name-row">
					<input type="text" value={name} onChange={(e) => setName(e.target.value)} aria-label="Service name" data-testid="wizard-name" maxLength={80} placeholder="Acme OCR" className={FIELD} disabled={busy !== null} />
				</SettingsRow>
				<SettingsSegmentedControl<Source> label="Documentation" value={source} onChange={setSource} disabled={busy !== null} testidPrefix="wizard-source" options={[{ value: "url", label: "Documentation page" }, { value: "paste", label: "Paste the text" }]} />
				{source === "url" ? (
					<SettingsRow label="Documentation page" hint="A public page; the app fetches it once" testid="wizard-docs-url-row">
						<input type="text" value={docsUrl} onChange={(e) => setDocsUrl(e.target.value)} aria-label="Documentation address" data-testid="wizard-docs-url" placeholder="https://docs.example.com/api/ocr" spellCheck={false} autoCapitalize="off" className={FIELD} disabled={busy !== null} />
					</SettingsRow>
				) : (
					<textarea value={docsText} onChange={(e) => setDocsText(e.target.value)} aria-label="Documentation text" data-testid="wizard-docs-text" rows={6} placeholder="Paste the API reference of the upload and the answer…" className={AREA} disabled={busy !== null} />
				)}
				<details data-testid="wizard-sample">
					<summary className="cursor-pointer text-xs text-foreground">Add a sample request or answer (optional)</summary>
					<textarea value={sample} onChange={(e) => setSample(e.target.value)} aria-label="Sample request or answer" data-testid="wizard-sample-text" rows={4} className={`${AREA} mt-1 w-full`} disabled={busy !== null} />
				</details>
				<p data-testid="wizard-send-line" className="text-xs leading-relaxed text-foreground">
					{sendLine({ ...(source === "url" ? { docsUrl } : {}), sample: !!sample.trim(), model: overview.model })}
				</p>
				{problem}
				<div className="flex flex-wrap items-center gap-3">
					<Button type="button" size="xs" variant="outline" className="lh-hit cursor-pointer disabled:cursor-not-allowed" disabled={!canDraft} onClick={draft1} data-testid="wizard-draft">
						{busy === "draft" ? "Drafting…" : source === "url" ? "Fetch the page and draft" : "Draft from the text"}
					</Button>
					{busy === "draft" && <button type="button" onClick={cancel} className={LINK} data-testid="wizard-draft-cancel">Cancel</button>}
				</div>
			</div>
		);
	}

	// ── 2 Review, 3 Test, 4 Approve ──
	const pre = draft.preflight;
	const report = draft.test?.report;
	const urlChanged = url.trim() !== (draft.baseUrl ?? "");
	const failed = !!report && !report.ok && !draft.test?.stale;
	const canFix = busy === null && (draft.status === "invalid" || failed);
	const ackNeeded = !!pre?.acknowledgeNeeded;
	const read = !!draft.shown && acknowledged === draft.shown;
	const editor = editing !== null && (
		<div className="flex flex-col gap-1" data-testid="wizard-editor">
			<p className={NOTE}>The app sets the id, name, version, description and docs link itself; the profile may not name the service&apos;s address.</p>
			<textarea value={editing} onChange={(e) => setEditing(e.target.value)} aria-label="Profile JSON" data-testid="wizard-editor-text" rows={12} spellCheck={false} className={AREA} />
			<span className="flex gap-3">
				<button type="button" className={LINK} disabled={busy !== null} onClick={() => void save({ profile: editing }, () => setEditing(null))} data-testid="wizard-editor-save">Save JSON</button>
				<button type="button" className={QUIET_LINK} onClick={() => setEditing(null)}>Cancel</button>
			</span>
		</div>
	);
	const editButton = draft.profileText !== undefined && editing === null && (
		<button type="button" className={LINK} disabled={busy !== null} onClick={() => setEditing(draft.profileText ?? "")} data-testid="wizard-edit-json">Edit JSON</button>
	);
	const fixButton = (
		<button type="button" className={LINK} disabled={!canFix} onClick={() => void start("fix", (signal) => fixDraft(draft.id, signal))} data-testid="wizard-fix">
			{busy === "fix" ? "Asking AI…" : "Ask AI to fix"}
		</button>
	);

	return (
		<div className={BOX} data-testid="converter-wizard">
			{header}
			{steps}
			<p className="text-xs font-medium text-foreground" data-testid="wizard-draft-name">{draft.serviceName}</p>
			{draft.docsNotice && <p className={NOTE} data-testid="wizard-docs-notice">{draft.docsNotice}</p>}
			{draft.note && (
				<p className={NOTE} data-testid="wizard-note">
					Note from the AI (it read the documentation, which can be wrong or written to mislead it): {draft.note}
				</p>
			)}

			{draft.status === "cannot_express" && (
				<p data-testid="wizard-cannot" className="text-xs leading-relaxed text-foreground">
					The AI found that this service cannot be described by a profile: {draft.reason}
				</p>
			)}
			{draft.status === "invalid" && (
				<div data-testid="wizard-invalid" className="flex flex-col gap-0.5">
					<p className="text-xs text-error">The draft is not a valid profile, so nothing can be sent with it:</p>
					{draft.errors.map((e) => <p key={e} className="font-mono text-[11px] text-error">{e}</p>)}
				</div>
			)}
			{draft.fixErrors && (
				<div data-testid="wizard-fix-errors" className="flex flex-col gap-0.5">
					<p className="text-xs text-error">The AI&apos;s fix was not a valid profile, so the previous draft is kept:</p>
					{draft.fixErrors.map((e) => <p key={e} className="font-mono text-[11px] text-error">{e}</p>)}
				</div>
			)}

			{pre && (
				<div data-testid="wizard-preflight" className="flex flex-col gap-1">
					<p className="text-xs font-medium text-foreground">What it would send, and only when you press Test or use it:</p>
					<p data-testid="wizard-submit" className="font-mono text-[11px] text-foreground">{pre.submit}</p>
					<p className={NOTE}>{pre.body}</p>
					{pre.auth ? (
						<p data-testid="wizard-auth" className="text-xs text-foreground">
							Key header: <span className="font-mono text-[11px]">{pre.auth.header}: {pre.auth.value}</span> (your key, never shown)
						</p>
					) : (
						<p data-testid="wizard-auth" className={NOTE}>No key is sent.</p>
					)}
					<FixedValues values={pre.fixed} />
					{pre.poll && <p data-testid="wizard-poll" className="font-mono text-[11px] text-foreground">{pre.poll}</p>}
					{pre.result && <p data-testid="wizard-result" className="font-mono text-[11px] text-foreground">{pre.result}</p>}
					<p data-testid="wizard-pages" className={NOTE}>{pre.pages}</p>
				</div>
			)}
			{draft.profileText !== undefined && (
				<details data-testid="wizard-json">
					<summary className="cursor-pointer text-xs text-foreground">The profile&apos;s JSON</summary>
					<pre className="mt-1 max-h-64 overflow-auto font-mono text-[11px] text-muted-foreground">{draft.profileText}</pre>
				</details>
			)}
			{editor}

			{pre && (
				<>
					<SettingsRow label="Service URL" hint="Where the service answers; only you enter it" testid="wizard-url-row">
						<span className="flex min-w-0 flex-1 items-center justify-end gap-2">
							<input type="text" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Service URL" data-testid="wizard-url" placeholder="https://ocr.example.com" disabled={busy !== null} spellCheck={false} autoCapitalize="off" className={FIELD} />
							<button type="button" onClick={() => void save({ baseUrl: url })} disabled={busy !== null || !urlChanged} data-testid="wizard-url-save" className={LINK}>Save</button>
						</span>
					</SettingsRow>
					{urlChanged && draft.credential.stored && <p className={NOTE}>Saving another URL removes the stored key, so it is never sent to the new address.</p>}
					{draft.keyNeeded && (
						<SettingsRow label="API key" hint={keyHint(draft)} testid="wizard-key-row">
							<span className="flex min-w-0 flex-1 items-center justify-end gap-2">
								<input type="password" value={key} onChange={(e) => setKey(e.target.value)} aria-label="API key" data-testid="wizard-key" autoComplete="off" placeholder={draft.credential.stored ? "Paste a new key to replace it…" : "Paste key…"} disabled={busy !== null} className={FIELD} />
								<button type="button" onClick={() => void save({ apiKey: key }, () => setKey(""))} disabled={busy !== null || !key.trim()} data-testid="wizard-key-save" className={LINK}>Save</button>
							</span>
						</SettingsRow>
					)}
				</>
			)}

			{problem}

			{pre && (
				<div className="flex flex-wrap items-center gap-3">
					<Button type="button" size="xs" variant="outline" className="lh-hit cursor-pointer disabled:cursor-not-allowed" disabled={busy !== null || !draft.baseUrl || (draft.keyNeeded && !draft.credential.stored)} onClick={() => void start("test", (signal) => testDraft(draft.id, signal), DRAFT_TEST_CLIENT_TIMEOUT_MS)} data-testid="wizard-test">
						{busy === "test" ? "Testing…" : "Test"}
					</Button>
					{busy === "test" && <button type="button" onClick={cancel} className={LINK} data-testid="wizard-test-cancel">Cancel</button>}
					<span className={NOTE}>
						{draft.origin ? `Sends two small test PDFs (two pages, and three pages with a blank one) to ${draft.origin} and checks each page.` : "Save the service URL first; nothing is sent until then."}
					</span>
				</div>
			)}
			{busy === "fix" && <button type="button" onClick={cancel} className={LINK} data-testid="wizard-fix-cancel">Cancel</button>}
			{report && (
				<div data-testid="wizard-report" className={BOX}>
					<p data-testid="wizard-report-verdict" className={`text-xs font-medium ${report.ok ? "text-foreground" : "text-error"}`}>
						{draft.test?.stale ? "This report is for an earlier version of the draft. " : ""}
						{report.ok ? "Passed: every page came back with its own text, and the blank page stayed blank." : "Failed: this profile cannot be trusted with page citations yet."}
					</p>
					<ul className="flex flex-col gap-0.5">
						{report.checks.map((c) => (
							<li key={c.id} data-testid={`wizard-check-${c.id}`} data-status={c.status} className={`text-xs leading-relaxed ${c.status === "fail" ? "text-error" : "text-muted-foreground"}`}>
								{MARK[c.status]} {c.message}
							</li>
						))}
					</ul>
					{report.pages.map((p) => (
						<p key={p.page} data-testid="wizard-page-preview" className="truncate font-mono text-[11px] text-muted-foreground/80">Page {p.page}: {p.text || "(empty)"}</p>
					))}
				</div>
			)}
			{(draft.status === "invalid" || failed || draft.status === "cannot_express") && (
				<div className="flex flex-wrap items-center gap-3" data-testid="wizard-repair">
					{draft.status !== "cannot_express" && fixButton}
					{editButton}
					{draft.status !== "cannot_express" && <span className={NOTE}>Ask AI to fix sends the draft and what the Test found (without your key, your service&apos;s address or the PDFs&apos; text) to {overview.model ?? "the model"}, once.</span>}
				</div>
			)}

			{pre && (
				<div className="flex flex-col gap-1" data-testid="wizard-approve-step">
					{ackNeeded && (
						<SettingsRow label={ACKNOWLEDGE_LABEL} hint={`Every value under "${FIXED_VALUES_HEADING}" above, for this version of the draft`} testid="wizard-ack-row">
							<Toggle label={ACKNOWLEDGE_LABEL} checked={read} disabled={busy !== null} onChange={(on) => setAcknowledged(on && draft.shown ? draft.shown : null)} />
						</SettingsRow>
					)}
					<div className="flex flex-wrap items-center gap-3">
						<Button type="button" size="xs" variant="outline" className="lh-hit cursor-pointer disabled:cursor-not-allowed" disabled={busy !== null || !draft.approvable || (ackNeeded && !read)} onClick={() => void approve()} data-testid="wizard-approve">
							Approve
						</Button>
						<span className={NOTE} data-testid="wizard-approve-note">
							{draft.approvable ? "Makes it one of your own profiles. Then choose Use for new PDFs on the main screen to use it." : draft.approveBlocked}
						</span>
						{!failed && draft.status === "ready" && editButton}
					</div>
				</div>
			)}

			<div className="flex flex-wrap items-center gap-3">
				<button type="button" className={LINK} onClick={() => open(null)} disabled={busy !== null} data-testid="wizard-back">Back to Describe</button>
				<button type="button" className={QUIET_LINK} onClick={() => void discard(draft.id)} disabled={busy !== null} data-testid="wizard-discard">Discard this draft</button>
			</div>
		</div>
	);
}
