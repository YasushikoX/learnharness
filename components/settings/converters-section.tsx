"use client";
import { useCallback, useEffect, useState } from "react";
import { destinationLine, type ConverterEntry, type ConvertersOverview, type ConverterValidationReport } from "@/src/core";
import { Button } from "@/components/ui/button";
import { SettingsRow, ThinSelect, Toggle } from "./controls";
import { importProfile, loadConverters, removeProfile, runConverterTest, saveConverter, type ConverterChange } from "./converters-client.ts";

/**
 * Settings → PDF conversion (fork addition, 2026-11-25): which converter turns uploaded PDFs into page-marked text.
 * The built-in reader (on this computer), a self-hosted Docling, a bundled preset (Mistral OCR) or your own profile.
 * For a service: its URL, its key (sent once, never shown again: only whether one is stored), where PDFs go, and a
 * Test that runs the bundled two-page PDF through it. Your own profile is imported as JSON (pasted or chosen);
 * the server validates it and nothing in it runs. The server does the work (src/server/converters/settings-service.ts).
 */

const FIELD =
	"h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50";
const LINK = "shrink-0 text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline";
const QUIET_LINK = "shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-error hover:underline";
const NOTE = "text-xs leading-relaxed text-muted-foreground";

const MARK = { pass: "✓", fail: "✗", skipped: "–" } as const;

function keyHint(entry: ConverterEntry): string {
	if (entry.credential.stored) return `A key is stored${entry.credential.hint ? ` (${entry.credential.hint})` : ""}`;
	if (entry.credential.boundElsewhere) return "A key was saved for another URL; enter it again for this one";
	return entry.key === "required" ? "Needed; not stored yet" : "Optional; not stored";
}

export function ConvertersSection() {
	const [overview, setOverview] = useState<ConvertersOverview | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [url, setUrl] = useState("");
	const [key, setKey] = useState("");
	const [testing, setTesting] = useState(false);
	const [report, setReport] = useState<ConverterValidationReport | null>(null);
	const [profileText, setProfileText] = useState("");
	const [importErrors, setImportErrors] = useState<string[]>([]);
	const [importNote, setImportNote] = useState<string | null>(null);

	/** A selected converter that is gone (a removed or invalid profile) shows as the built-in reader, which is what runs. */
	const selected = overview ? (overview.converters.find((c) => c.id === overview.selected) ?? overview.converters[0]) : undefined;
	const missing = overview && selected && selected.id !== overview.selected ? overview.selected : null;

	const adopt = useCallback((next: ConvertersOverview) => {
		setOverview(next);
		const entry = next.converters.find((c) => c.id === next.selected) ?? next.converters[0];
		setUrl(entry?.baseUrl ?? "");
	}, []);

	useEffect(() => {
		void loadConverters().then(({ value, error: failed }) => {
			if (value) adopt(value);
			else setLoadError(failed);
		});
	}, [adopt]);

	async function change(input: ConverterChange, after?: () => void): Promise<void> {
		setBusy(true);
		setError(null);
		const { value, error: failed } = await saveConverter(input);
		setBusy(false);
		if (!value) return setError(failed);
		adopt(value);
		after?.();
	}

	const select = (id: string) => {
		setReport(null);
		setKey("");
		void change({ id, select: true });
	};

	async function test(): Promise<void> {
		if (!selected) return;
		setTesting(true);
		setError(null);
		setReport(null);
		const { value, error: failed } = await runConverterTest(selected.id);
		setTesting(false);
		if (value) setReport(value);
		else setError(failed);
	}

	async function doImport(text: string): Promise<void> {
		setImportErrors([]);
		setImportNote(null);
		if (!text.trim()) return;
		setBusy(true);
		const { value, error: failed, errors } = await importProfile(text);
		setBusy(false);
		if (!value) {
			setImportErrors(errors.length ? errors : [failed ?? "Could not import the profile"]);
			return;
		}
		setOverview(value.overview);
		setProfileText("");
		setImportNote(`${value.replaced ? "Replaced" : "Imported"} ${value.overview.converters.find((c) => c.id === value.id)?.name ?? value.id}. Choose it above to use it.`);
	}

	async function chooseFile(file: File | undefined): Promise<void> {
		if (!file) return;
		await doImport(await file.text());
	}

	async function remove(): Promise<void> {
		if (!selected || selected.kind !== "custom") return;
		setBusy(true);
		setError(null);
		const { value, error: failed } = await removeProfile(selected.id);
		setBusy(false);
		if (value) {
			setReport(null);
			adopt(value);
		} else setError(failed);
	}

	if (loadError) return <p role="alert" data-testid="converters-load-error" className="text-xs text-error">{loadError}</p>;
	if (!overview || !selected) return <p data-testid="converters-loading" className={NOTE}>Loading…</p>;

	const urlChanged = url.trim() !== (selected.baseUrl ?? "");

	return (
		<div className="flex flex-col gap-3" data-testid="converters-section">
			<p className={NOTE}>
				How uploaded PDFs become page-marked text for the tutor. The built-in reader needs no setup but cannot read scanned pages; a service with OCR can.
				Every PDF is converted once, when you add it.
			</p>

			<SettingsRow label="Converter" testid="converter-row">
				<ThinSelect value={selected.id} onChange={select} ariaLabel="PDF converter" testid="converter-select" disabled={busy}>
					{overview.converters.map((c) => (
						<option key={c.id} value={c.id}>
							{c.name}
							{c.unverified ? " (unverified)" : ""}
							{c.kind === "custom" ? " (your profile)" : ""}
						</option>
					))}
				</ThinSelect>
			</SettingsRow>

			{missing && (
				<p data-testid="converter-missing" className="text-xs text-error">
					The selected converter &quot;{missing}&quot; is not available (its profile is missing or not valid), so the built-in reader is used.
				</p>
			)}
			{selected.description && <p className={NOTE}>{selected.description}</p>}
			<p data-testid="converter-destination" className="text-xs leading-relaxed text-foreground">
				{destinationLine(selected)}
				{!selected.local && " The built-in reader keeps PDFs on this computer."}
			</p>
			{selected.unverified && (
				<p data-testid="converter-unverified" className="rounded-sm border border-border p-2 text-xs leading-relaxed text-muted-foreground">
					Unverified: this preset was written from the service&apos;s documentation and has not been tried against the real service. Run Test before relying on it.
				</p>
			)}

			{!selected.local && (
				<SettingsRow label="Service URL" hint={selected.defaultBaseUrl ? `Default: ${selected.defaultBaseUrl}` : "Where the service answers"} testid="converter-url-row">
					<span className="flex min-w-0 flex-1 items-center justify-end gap-2">
						<input
							type="text"
							value={url}
							onChange={(e) => setUrl(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && urlChanged) void change({ id: selected.id, baseUrl: url });
							}}
							placeholder={selected.defaultBaseUrl ?? "http://host:5001"}
							aria-label="Service URL"
							data-testid="converter-url-input"
							disabled={busy}
							spellCheck={false}
							autoCapitalize="off"
							className={FIELD}
						/>
						<button type="button" onClick={() => void change({ id: selected.id, baseUrl: url })} disabled={busy || !urlChanged} data-testid="converter-url-save" className={LINK}>
							Save
						</button>
					</span>
				</SettingsRow>
			)}
			{!selected.local && urlChanged && selected.credential.stored && (
				<p data-testid="converter-url-key-note" className={NOTE}>Saving another URL removes the stored key, so it is never sent to the new address. Enter the key again afterwards.</p>
			)}

			{selected.key !== "none" && (
				<SettingsRow label="API key" hint={keyHint(selected)} testid="converter-key-row">
					<span className="flex min-w-0 flex-1 items-center justify-end gap-2">
						<input
							type="password"
							value={key}
							onChange={(e) => setKey(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && key.trim()) void change({ id: selected.id, apiKey: key }, () => setKey(""));
							}}
							placeholder={selected.credential.stored ? "Paste a new key to replace it…" : "Paste key…"}
							aria-label="API key"
							data-testid="converter-key-input"
							disabled={busy}
							autoComplete="off"
							className={FIELD}
						/>
						<button type="button" onClick={() => void change({ id: selected.id, apiKey: key }, () => setKey(""))} disabled={busy || !key.trim()} data-testid="converter-key-save" className={LINK}>
							Save
						</button>
						{selected.credential.stored && (
							<button type="button" onClick={() => void change({ id: selected.id, removeKey: true })} disabled={busy} data-testid="converter-key-remove" className={QUIET_LINK}>
								Remove
							</button>
						)}
					</span>
				</SettingsRow>
			)}

			{selected.options && (
				<>
					<SettingsRow label="OCR" hint="Read text in scanned pages and pictures" testid="converter-ocr-row">
						<Toggle label="OCR" checked={selected.options.ocr} disabled={busy} onChange={(on) => void change({ id: selected.id, ocr: on })} />
					</SettingsRow>
					<SettingsRow label="Formulas" hint="Recognise formulas as LaTeX (slower)" testid="converter-formula-row">
						<Toggle label="Formulas" checked={selected.options.formulaEnrichment} disabled={busy} onChange={(on) => void change({ id: selected.id, formulaEnrichment: on })} />
					</SettingsRow>
				</>
			)}

			{error && <p role="alert" data-testid="converter-error" className="text-xs text-error">{error}</p>}

			<div className="flex flex-wrap items-center gap-3">
				<Button type="button" size="xs" variant="outline" className="lh-hit cursor-pointer disabled:cursor-not-allowed" disabled={busy || testing} onClick={() => void test()} data-testid="converter-test">
					{testing ? "Testing…" : "Test"}
				</Button>
				<span className={NOTE}>
					{selected.local ? "Converts a small two-page test PDF on this computer." : `Sends a small two-page test PDF to ${selected.origin ?? "the service"} and checks each page.`}
				</span>
				{selected.kind === "custom" && (
					<button type="button" onClick={() => void remove()} disabled={busy} data-testid="converter-profile-remove" className={QUIET_LINK}>
						Remove this profile
					</button>
				)}
			</div>
			{report && (
				<div data-testid="converter-report" className="flex flex-col gap-1 rounded-sm border border-border p-2">
					<p data-testid="converter-report-verdict" className={`text-xs font-medium ${report.ok ? "text-foreground" : "text-error"}`}>
						{report.ok ? "Passed: both pages came back with their own text." : "Failed: this converter cannot be trusted with page citations yet."}
					</p>
					<ul className="flex flex-col gap-0.5">
						{report.checks.map((c) => (
							<li key={c.id} data-testid={`converter-check-${c.id}`} data-status={c.status} className={`text-xs leading-relaxed ${c.status === "fail" ? "text-error" : "text-muted-foreground"}`}>
								{MARK[c.status]} {c.message}
							</li>
						))}
					</ul>
					{report.pages.map((p) => (
						<p key={p.page} className="truncate font-mono text-[11px] text-muted-foreground/80">
							Page {p.page}: {p.text || "(empty)"}
						</p>
					))}
				</div>
			)}

			<details className="flex flex-col gap-2" data-testid="converter-import">
				<summary className="cursor-pointer text-xs text-foreground">Use your own service (import a profile)</summary>
				<p className={NOTE}>
					A profile is a JSON file that describes a PDF or OCR service: where to send the PDF, how, and where the text is in its answer. It is data
					only; the app reads it and makes the requests itself. See docs/pdf-converters.md for the format.
				</p>
				<textarea
					value={profileText}
					onChange={(e) => setProfileText(e.target.value)}
					placeholder='{ "format": "learnharness.http-converter/1", … }'
					aria-label="Converter profile JSON"
					data-testid="converter-import-text"
					rows={6}
					spellCheck={false}
					className="min-h-24 rounded-sm border border-border bg-background p-1.5 font-mono text-xs text-foreground outline-none focus:border-muted-foreground/50"
				/>
				<div className="flex flex-wrap items-center gap-3">
					<button type="button" onClick={() => void doImport(profileText)} disabled={busy || !profileText.trim()} data-testid="converter-import-run" className={LINK}>
						Import
					</button>
					<label className="text-xs text-foreground underline-offset-2 hover:underline">
						Choose a file…
						<input type="file" accept="application/json,.json" className="sr-only" data-testid="converter-import-file" onChange={(e) => void chooseFile(e.target.files?.[0])} />
					</label>
				</div>
				{importNote && <p data-testid="converter-import-note" className={NOTE}>{importNote}</p>}
				{importErrors.length > 0 && (
					<ul role="alert" data-testid="converter-import-errors" className="flex flex-col gap-0.5">
						{importErrors.map((e) => (
							<li key={e} className="font-mono text-[11px] text-error">{e}</li>
						))}
					</ul>
				)}
			</details>

			{overview.invalidProfiles.length > 0 && (
				<div data-testid="converter-invalid-profiles" className="flex flex-col gap-0.5">
					<p className="text-xs text-error">These profile files are not valid and are not used:</p>
					{overview.invalidProfiles.map((p) => (
						<p key={p.file} className="font-mono text-[11px] text-muted-foreground">
							{p.file}: {p.errors.join("; ")}
						</p>
					))}
				</div>
			)}
		</div>
	);
}
