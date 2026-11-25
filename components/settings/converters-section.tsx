"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { destinationLine, type ConverterEntry, type ConvertersOverview, type ConverterValidationReport } from "@/src/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ChevronDown } from "lucide-react";
import { SettingsList, SettingsRow, ThinSelect, Toggle } from "./controls";
import { importProfile, loadConverters, removeProfile, runConverterTest, saveConverter, type ConverterChange } from "./converters-client.ts";
import { ConverterWizard } from "./converter-wizard.tsx";

/**
 * Settings → PDF conversion (fork addition, 2026-11-25): which converter turns uploaded PDFs into page-marked text.
 * The built-in reader (on this computer), a self-hosted Docling, a bundled preset (Mistral OCR) or your own profile.
 * For a service: its URL, its key (sent once, never shown again: only whether one is stored), where PDFs go, and a
 * Test that runs the bundled test PDFs through it. Your own profile is imported as JSON (pasted or chosen);
 * the server validates it and nothing in it runs. The server does the work (src/server/converters/settings-service.ts).
 *
 * Choosing an entry in the list only SHOWS it. "Use for new PDFs", beside the line that says where PDFs will be sent,
 * makes it the converter uploads use; the server refuses it until the converter is set up. The converter in use is
 * marked in the list and next to that line. Test can be cancelled, gives up after two minutes, and its report is
 * shown only while the converter it was started for is still on screen.
 */

/** The client's own limit for a Test: the server's two-minute deadline plus time for its answer to arrive. */
export const CONVERTER_TEST_CLIENT_TIMEOUT_MS = 2 * 60_000 + 15_000;

const NOTE = "text-sm/5 text-muted-foreground";

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
	/** The converter on screen (the list only shows; "Use for new PDFs" selects). */
	const [shownId, setShownId] = useState<string | null>(null);
	const testRun = useRef<{ id: string; controller: AbortController } | null>(null);
	const [profileText, setProfileText] = useState("");
	const [importErrors, setImportErrors] = useState<string[]>([]);
	const [importNote, setImportNote] = useState<string | null>(null);
	const [wizardOpen, setWizardOpen] = useState(false);

	/** The converter in use; one that is gone (a removed or invalid profile) is the built-in reader, which is what runs. */
	const active = overview ? (overview.converters.find((c) => c.id === overview.selected) ?? overview.converters[0]) : undefined;
	const missing = overview && active && active.id !== overview.selected ? overview.selected : null;
	/** The converter on screen: the one chosen in the list, else the one in use. */
	const selected = overview ? (overview.converters.find((c) => c.id === shownId) ?? active) : undefined;
	/** On screen and in use (with a selection that is gone, the built-in reader is what runs, so it is in use). */
	const isActive = !!selected && !!active && selected.id === active.id;

	/** Stop a running Test; its report is discarded. */
	const cancelTest = useCallback(() => {
		testRun.current?.controller.abort();
		testRun.current = null;
		setTesting(false);
	}, []);

	/** Take the server's overview; keep showing the converter on screen (or `show`), and its saved URL in the field. */
	const adopt = useCallback((next: ConvertersOverview, show?: string | null) => {
		setOverview(next);
		setShownId((current) => {
			const id = show === undefined ? current : show;
			const entry = next.converters.find((c) => c.id === id) ?? next.converters.find((c) => c.id === next.selected) ?? next.converters[0];
			setUrl(entry?.baseUrl ?? "");
			return entry?.id ?? null;
		});
	}, []);

	useEffect(() => () => testRun.current?.controller.abort(), []);

	useEffect(() => {
		void loadConverters().then(({ value, error: failed }) => {
			if (value) adopt(value);
			else setLoadError(failed);
		});
	}, [adopt]);

	async function change(input: ConverterChange, after?: () => void): Promise<void> {
		cancelTest(); // a Test of the settings being replaced must not report under the new ones
		setBusy(true);
		setError(null);
		const { value, error: failed } = await saveConverter(input);
		setBusy(false);
		if (!value) return setError(failed);
		adopt(value);
		after?.();
	}

	/** Show another converter (nothing is saved; a running Test is cancelled). */
	const show = (id: string) => {
		cancelTest();
		setReport(null);
		setError(null);
		setKey("");
		setShownId(id);
		setUrl(overview?.converters.find((c) => c.id === id)?.baseUrl ?? "");
	};

	async function test(): Promise<void> {
		if (!selected) return;
		cancelTest();
		const run = { id: selected.id, controller: new AbortController() };
		testRun.current = run;
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			run.controller.abort();
		}, CONVERTER_TEST_CLIENT_TIMEOUT_MS);
		setTesting(true);
		setError(null);
		setReport(null);
		const { value, error: failed } = await runConverterTest(run.id, run.controller.signal);
		clearTimeout(timer);
		// a Test that was cancelled, replaced, or started for a converter no longer on screen shows nothing
		if (testRun.current !== run) return;
		testRun.current = null;
		setTesting(false);
		if (timedOut) return setError("The test did not finish within two minutes.");
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
		setProfileText("");
		const entry = value.overview.converters.find((c) => c.id === value.id);
		cancelTest();
		setReport(null);
		setError(null);
		setKey("");
		adopt(value.overview, value.id);
		const name = entry?.name ?? value.id;
		const configured = value.replaced && !!entry?.baseUrl;
		setImportNote(
			value.deselected ? `Replaced ${name}, shown above. Its requests changed, so it is no longer in use: the built-in reader converts PDFs until you test it and choose Use for new PDFs again.`
			: configured ? `Replaced ${name}, shown above. Its saved service URL${entry?.credential?.stored ? " and key" : ""} are kept; test it before you rely on it.`
			: `${value.replaced ? "Replaced" : "Imported"} ${name}, shown above. Nothing is sent until you save its service URL${entry?.key === "required" ? " and key" : ""} and choose Use for new PDFs.`,
		);
	}

	async function chooseFile(file: File | undefined): Promise<void> {
		if (!file) return;
		await doImport(await file.text());
	}

	async function remove(): Promise<void> {
		if (!selected || selected.kind !== "custom") return;
		cancelTest();
		setBusy(true);
		setError(null);
		const { value, error: failed } = await removeProfile(selected.id);
		setBusy(false);
		if (value) {
			setReport(null);
			adopt(value, null);
		} else setError(failed);
	}

	if (loadError) return <p role="alert" data-testid="converters-load-error" className="text-xs text-error">{loadError}</p>;
	if (!overview || !selected) return <p data-testid="converters-loading" className={NOTE}>Loading…</p>;

	const urlChanged = url.trim() !== (selected.baseUrl ?? "");

	return (
		<div className="flex flex-col gap-6" data-testid="converters-section">
			<p className={NOTE}>
				How uploaded PDFs become page-marked text for the tutor. The built-in reader needs no setup but cannot read scanned pages; a service with OCR can.
				Every PDF is converted once, when you add it.
			</p>

			<SettingsList>
				<SettingsRow label="Converter" hint={selected.description} testid="converter-row">
					<ThinSelect value={selected.id} onChange={show} ariaLabel="PDF converter" testid="converter-select" disabled={busy}>
						{overview.converters.map((c) => (
							<option key={c.id} value={c.id}>
								{c.name}
								{c.unverified ? " (unverified)" : ""}
								{c.kind === "custom" ? " (your profile)" : ""}
								{c.id === active?.id ? " — in use" : ""}
							</option>
						))}
					</ThinSelect>
				</SettingsRow>

				{missing && (
					<p data-testid="converter-missing" className="text-xs text-error">
						The selected converter &quot;{missing}&quot; is not available (its profile is missing or not valid), so the built-in reader is used.
					</p>
				)}
				<SettingsRow label="PDF destination" testid="converter-destination-row" hint={
					<span data-testid="converter-destination">
						{destinationLine(selected, isActive)}
						{!selected.local && selected.origin && (selected.ready || !isActive) && " The built-in reader keeps PDFs on this computer."}
					</span>
				}>
					{isActive ? (
						<span data-testid="converter-active" className="text-sm font-medium">
							In use for new PDFs
						</span>
					) : (
						<Button
							type="button"
							variant="outline"
							className="lh-hit shrink-0 cursor-pointer disabled:cursor-not-allowed"
							disabled={busy || !selected.ready}
							onClick={() => void change({ id: selected.id, select: true })}
							data-testid="converter-use"
						>
							Use for new PDFs
						</Button>
					)}
				</SettingsRow>
				{!selected.ready && selected.setup && !isActive && (
					<p data-testid="converter-setup" className={NOTE}>
						Not set up yet: {selected.setup}
					</p>
				)}
				{selected.unverified && (
					<p data-testid="converter-unverified" className="rounded-sm border border-border p-2 text-xs leading-relaxed text-muted-foreground">
						Unverified: this preset was written from the service&apos;s documentation and has not been tried against the real service. Run Test before relying on it.
					</p>
				)}

				{!selected.local && (
					<SettingsRow label="Service URL" hint={selected.defaultBaseUrl ? `Default: ${selected.defaultBaseUrl}` : "Where the service answers"} testid="converter-url-row">
						<span className="flex w-80 max-w-full flex-wrap items-center justify-end gap-2">
							<Input
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
								className="min-w-28 flex-1"
							/>
							<Button type="button" variant="outline" onClick={() => void change({ id: selected.id, baseUrl: url })} disabled={busy || !urlChanged} data-testid="converter-url-save">
								Save
							</Button>
						</span>
					</SettingsRow>
				)}
				{!selected.local && urlChanged && selected.credential.stored && (
					<p data-testid="converter-url-key-note" className={NOTE}>Saving another URL removes the stored key, so it is never sent to the new address. Enter the key again afterwards.</p>
				)}

				{selected.key !== "none" && (
					<SettingsRow label="API key" hint={keyHint(selected)} testid="converter-key-row">
						<span className="flex w-80 max-w-full flex-wrap items-center justify-end gap-2">
							<Input
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
								className="min-w-28 flex-1 font-mono"
							/>
							<Button type="button" variant="outline" onClick={() => void change({ id: selected.id, apiKey: key }, () => setKey(""))} disabled={busy || !key.trim()} data-testid="converter-key-save">
								Save
							</Button>
							{selected.credential.stored && (
								<Button type="button" variant="destructive" onClick={() => void change({ id: selected.id, removeKey: true })} disabled={busy} data-testid="converter-key-remove">
									Remove
								</Button>
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

				<SettingsRow label="Test conversion" hint={selected.local
							? "Converts two small test PDFs on this computer (two pages, and three pages with a blank one)."
							: `Sends two small test PDFs (two pages, and three pages with a blank one) to ${selected.origin ?? "the service"} and checks each page.`}>
					<div className="flex gap-2">
						<Button type="button" variant="outline" disabled={busy || testing} onClick={() => void test()} data-testid="converter-test">
							{testing ? "Testing…" : "Test"}
						</Button>
						{testing && <Button type="button" variant="ghost" onClick={cancelTest} data-testid="converter-test-cancel">Cancel</Button>}
					</div>
				</SettingsRow>
				{selected.kind === "custom" && <SettingsRow label="Profile">
						<Button type="button" variant="destructive" onClick={() => void remove()} disabled={busy} data-testid="converter-profile-remove">
							Remove this profile
						</Button>
				</SettingsRow>}
				{report && report.converterId === selected.id && (
					<div data-testid="converter-report" className="flex flex-col gap-1">
						<p data-testid="converter-report-verdict" className={`text-xs font-medium ${report.ok ? "text-foreground" : "text-error"}`}>
							{report.ok ? "Passed: every page came back with its own text, and the blank page stayed blank." : "Failed: this converter cannot be trusted with page citations yet."}
						</p>
						<ul className="flex flex-col gap-0.5">
							{report.checks.map((c) => (
								<li key={c.id} data-testid={`converter-check-${c.id}`} data-status={c.status} className={`text-xs leading-relaxed ${c.status === "fail" ? "text-error" : "text-muted-foreground"}`}>
									{MARK[c.status]} {c.message}
								</li>
							))}
						</ul>
						{report.pages.map((p) => (
							<p key={p.page} className="truncate font-mono text-xs text-muted-foreground">
								Page {p.page}: {p.text || "(empty)"}
							</p>
						))}
					</div>
				)}
			</SettingsList>

			<SettingsList>
				<details className="lh-settings-row-group group" data-testid="converter-import">
					<summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-4 py-2 text-base font-medium hover:bg-raised [&::-webkit-details-marker]:hidden">
						Use your own service (import a profile)
						<ChevronDown aria-hidden strokeWidth={1.75} className="size-4 shrink-0 text-muted-foreground group-open:rotate-180" />
					</summary>
					<div className="flex flex-col gap-3 border-t border-border p-4">
					<p className={NOTE}>
						A profile is a JSON file that describes a PDF or OCR service: how to send the PDF and where the text is in its answer. It is data
						only; the app reads it and makes the requests itself. The service&apos;s address is not part of it: you enter it here after importing.
						See docs/pdf-converters.md for the format.
					</p>
					<Textarea
						value={profileText}
						onChange={(e) => setProfileText(e.target.value)}
						placeholder='{ "format": "learnharness.http-converter/1", … }'
						aria-label="Converter profile JSON"
						data-testid="converter-import-text"
						rows={6}
						spellCheck={false}
						className="min-h-24 font-mono"
					/>
					<div className="flex flex-wrap items-center gap-3">
						<Button type="button" variant="outline" onClick={() => void doImport(profileText)} disabled={busy || !profileText.trim()} data-testid="converter-import-run">
							Import
						</Button>
						<Button asChild variant="outline" className="cursor-pointer focus-within:ring-2 focus-within:ring-focus">
						<label>
							Choose a file…
							<input type="file" accept="application/json,.json" className="sr-only" data-testid="converter-import-file" onChange={(e) => void chooseFile(e.target.files?.[0])} />
						</label>
						</Button>
					</div>
					{importNote && <p data-testid="converter-import-note" className={NOTE}>{importNote}</p>}
					{importErrors.length > 0 && (
						<ul role="alert" data-testid="converter-import-errors" className="flex flex-col gap-0.5">
							{importErrors.map((e) => (
								<li key={e} className="font-mono text-xs text-error">{e}</li>
							))}
						</ul>
					)}
					</div>
				</details>
			</SettingsList>

			{wizardOpen ? (
				<ConverterWizard
					onClose={() => setWizardOpen(false)}
					onApproved={(next, id) => {
						setWizardOpen(false);
						cancelTest();
						setReport(null);
						setError(null);
						setKey("");
						adopt(next, id);
						setImportNote(`Approved ${next.converters.find((c) => c.id === id)?.name ?? id}, shown above. Choose Use for new PDFs to use it.`);
					}}
				/>
			) : (
				<Button type="button" variant="outline" onClick={() => setWizardOpen(true)} disabled={busy} data-testid="converter-wizard-open" className="h-auto min-h-8 self-start py-1 text-left whitespace-normal">
					No preset fits? Draft a connector with AI…
				</Button>
			)}

			{overview.invalidProfiles.length > 0 && (
				<div data-testid="converter-invalid-profiles" className="flex flex-col gap-0.5">
					<p className="text-xs text-error">These profile files are not valid and are not used:</p>
					{overview.invalidProfiles.map((p) => (
						<p key={p.file} className="font-mono text-xs text-muted-foreground">
							{p.file}: {p.errors.join("; ")}
						</p>
					))}
				</div>
			)}
		</div>
	);
}
