"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2Icon, PlayIcon } from "lucide-react";
import {
	DEFAULT_READ_ALOUD_RATE,
	GOOGLE_TTS_DEFAULT_MODEL,
	GOOGLE_TTS_PREVIEW_TEXT,
	GOOGLE_TTS_VOICES,
	LESSON_LANGUAGES,
	googleModelFor,
	googleVoiceFor,
	type GeneralSettings,
	type LessonLanguage,
	type ReadAloudEngine,
	type ReadAloudStatus,
} from "@/src/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ErrorNotice } from "@/components/ui/error-notice";
import { notifySettingsSaved } from "@/components/settings-signal";
import { SettingsGroup, SettingsRow, ThinSelect, Toggle } from "@/components/settings/controls";
import { browserSpeechDeps, type SpeechVoiceLike } from "@/components/speech-controller";
import { browserReadAloudClient, type ReadAloudClient } from "@/components/settings/read-aloud-client";

export const READ_ALOUD_RATES: readonly number[] = [0.5, 0.75, 0.9, 1, 1.15, 1.25, 1.5, 1.75, 2];

function formatRateLabel(rate: number): string {
	return rate === 1 ? "1× (Normal)" : `${rate}×`;
}

function voiceLabel(voice: SpeechVoiceLike): string {
	return voice.lang ? `${voice.name} (${voice.lang})` : voice.name;
}

/** The key's state as Settings shows it. */
export type GoogleKeyState = "checking" | "none" | "untested" | "testing" | "working" | "failed";

const KEY_STATE_LABEL: Readonly<Record<GoogleKeyState, string>> = {
	checking: "Checking…",
	none: "Not set",
	untested: "Not tried yet",
	testing: "Testing…",
	working: "Working",
	failed: "Failed",
};

const LANGUAGE_NAMES: Readonly<Record<LessonLanguage, string>> = { en: "English", nb: "Norwegian" };

function keySourceLine(status: ReadAloudStatus | null): string {
	if (!status?.key?.source) return "Google voices need a free Google AI Studio key.";
	if (status.key?.source === "provider") return "Using your Google provider key (from model providers).";
	return `Using the key saved for Google AI Studio${status.key?.hint ? ` (${status.key?.hint})` : ""}, shared with PDF conversion.`;
}

/**
 * Settings → General → Read aloud (WP10, 2026-11-26): automatic reading, the voices (Google's natural voices through a
 * Google AI Studio key, or the system voices), Google's key state with Test, its quality and a voice per lesson
 * language with a ▶ preview, the speech rate (every engine) and the system voice (system engine and the fallback).
 * The key is the Gemini PDF converter's: saved here, it is saved there, and a key saved there (or the Google provider
 * key) is used here.
 */
export function ReadAloudSection({
	general,
	onChange,
	client = browserReadAloudClient,
}: {
	general: GeneralSettings | undefined;
	/** Writes the WHOLE general section (replace-whole). */
	onChange: (next: GeneralSettings) => void;
	/** The server requests (tests inject a fake). */
	client?: ReadAloudClient;
}) {
	const [supported, setSupported] = useState(true);
	const [voices, setVoices] = useState<readonly SpeechVoiceLike[]>([]);
	const [status, setStatus] = useState<ReadAloudStatus | null>(null);
	const [loaded, setLoaded] = useState(false);
	const [testing, setTesting] = useState(false);
	const [testError, setTestError] = useState<string | null>(null);
	/** A refused key: the notice says so, instead of the generic mapping (which points at Settings → Providers). */
	const [testRefused, setTestRefused] = useState(false);
	const [testedOk, setTestedOk] = useState(false);
	const [keyInput, setKeyInput] = useState("");
	const [savingKey, setSavingKey] = useState(false);
	const [keyError, setKeyError] = useState<string | null>(null);
	const [previewing, setPreviewing] = useState<LessonLanguage | null>(null);
	const [previewError, setPreviewError] = useState<{ language: LessonLanguage; error: string } | null>(null);
	const alive = useRef(true);

	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);

	const reloadStatus = useCallback(async () => {
		const next = await client.status();
		if (!alive.current) return;
		setStatus(next);
		setLoaded(true);
	}, [client]);

	useEffect(() => {
		void reloadStatus();
	}, [reloadStatus]);

	useEffect(() => {
		const { synthesis, Utterance } = browserSpeechDeps();
		if (!synthesis || !Utterance) {
			setSupported(false);
			setVoices([]);
			return;
		}
		setSupported(true);
		const read = () => {
			try {
				const list = [...synthesis.getVoices()];
				const seen = new Set<string>();
				const unique = list.filter((v) => {
					const key = v.voiceURI || v.name;
					if (!key || seen.has(key)) return false;
					seen.add(key);
					return true;
				});
				unique.sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
				setVoices(unique);
			} catch {
				setVoices([]);
			}
		};
		read();
		if (typeof synthesis.addEventListener === "function") {
			synthesis.addEventListener("voiceschanged", read);
			return () => synthesis.removeEventListener?.("voiceschanged", read);
		}
		const prev = synthesis.onvoiceschanged;
		synthesis.onvoiceschanged = read;
		return () => {
			if (synthesis.onvoiceschanged === read) synthesis.onvoiceschanged = prev ?? null;
		};
	}, []);

	const runTest = useCallback(async () => {
		setTesting(true);
		setTestError(null);
		const result = await client.test();
		if (!alive.current) return;
		setTesting(false);
		if (result.ok) {
			setTestedOk(true);
			void reloadStatus();
		} else {
			setTestedOk(false);
			setTestRefused(result.kind === "auth");
			setTestError(result.error);
		}
	}, [client, reloadStatus]);

	const saveKey = useCallback(async () => {
		const key = keyInput.trim();
		if (!key) return;
		setSavingKey(true);
		setKeyError(null);
		const { error } = await client.saveKey(key);
		if (!alive.current) return;
		setSavingKey(false);
		if (error) {
			setKeyError(error);
			return;
		}
		setKeyInput("");
		notifySettingsSaved("keys");
		await reloadStatus();
		if (alive.current) void runTest();
	}, [client, keyInput, reloadStatus, runTest]);

	const hasKey = !!status?.key?.source;
	const keyState: GoogleKeyState = !loaded
		? "checking"
		: testing
			? "testing"
			: testError
				? "failed"
				: !hasKey
					? "none"
					: testedOk || status?.verified
						? "working"
						: "untested";

	const engine: ReadAloudEngine = general?.readAloudEngine ?? (hasKey ? "google" : "system");
	const model = googleModelFor(general?.readAloudModel);
	const currentRate = general?.readAloudRate ?? DEFAULT_READ_ALOUD_RATE;
	const rateOptions = useMemo(() => {
		const set = new Set<number>(READ_ALOUD_RATES);
		set.add(currentRate);
		return [...set].sort((a, b) => a - b);
	}, [currentRate]);

	const preview = async (language: LessonLanguage) => {
		setPreviewing(language);
		setPreviewError(null);
		const result = await client.preview(GOOGLE_TTS_PREVIEW_TEXT[language], language, googleVoiceFor(language, general?.readAloudVoices), model);
		if (!alive.current) return;
		if (!result.ok) {
			setPreviewing(null);
			setPreviewError({ language, error: result.error });
			return;
		}
		try {
			await client.play(result.url, currentRate);
		} finally {
			result.release();
			if (alive.current) setPreviewing(null);
		}
	};

	const currentVoice = general?.readAloudVoice ?? "";
	const hasSavedVoice = currentVoice !== "" && voices.some((v) => (v.voiceURI || v.name) === currentVoice);

	const voiceHint = !supported
		? "System speech synthesis is unavailable in this browser"
		: voices.length === 0
			? "No system speech voices detected — using system default"
			: "A chosen voice is used when its language matches the lesson; otherwise a voice matching the lesson language is preferred";

	const engineHint = engine === "google"
		? hasKey
			? "Google reads aloud online. When it can't (offline, an error, the free limit), the system voices take over."
			: "Add a Google AI Studio key below. Until then the system voices read aloud."
		: "Your computer's own voices, offline.";

	return (
		<SettingsGroup label="Read aloud" testid="group-read-aloud">
			<SettingsRow
				label="Read questions aloud automatically"
				hint="Speaks each new pending question once when it appears"
				testid="row-read-aloud-auto"
			>
				<Toggle
					checked={general?.readAloudAuto ?? false}
					label="Read questions aloud automatically"
					onChange={(on) => onChange({ ...general, readAloudAuto: on })}
				/>
			</SettingsRow>
			<SettingsRow label="Voices" hint={engineHint} testid="row-read-aloud-engine">
				<ThinSelect
					value={engine}
					ariaLabel="read aloud voices"
					testid="select-read-aloud-engine"
					onChange={(v) => onChange({ ...general, readAloudEngine: v === "google" ? "google" : "system" })}
				>
					<option value="google">Google (natural, online)</option>
					<option value="system">System voices</option>
				</ThinSelect>
			</SettingsRow>

			{engine === "google" && (
				<>
					<SettingsRow
						label="Google AI Studio key"
						hint={
							<span data-testid="read-aloud-key-hint">
								{keySourceLine(status)}{" "}
								<a href={status?.keyUrl ?? "https://aistudio.google.com/apikey"} target="_blank" rel="noreferrer" data-testid="read-aloud-key-link" className="text-primary underline-offset-2 hover:underline">
									Get a key ↗
								</a>
							</span>
						}
						testid="row-read-aloud-key"
					>
						<span className="flex w-80 max-w-full flex-wrap items-center justify-end gap-2">
							<span data-testid="read-aloud-key-state" data-state={keyState} className={keyState === "failed" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
								{KEY_STATE_LABEL[keyState]}
							</span>
							{hasKey && (
								<Button type="button" variant="outline" disabled={testing || savingKey} onClick={() => void runTest()} data-testid="read-aloud-key-test">
									{testing && <Loader2Icon className="animate-spin" aria-hidden />}
									{testing ? "Testing…" : "Test"}
								</Button>
							)}
						</span>
					</SettingsRow>
					{loaded && !hasKey && (
						<SettingsRow label="Paste a key" hint="Saved on this computer only, where PDF conversion keeps its Google key. One key serves both." testid="row-read-aloud-key-input">
							<span className="flex w-80 max-w-full flex-wrap items-center justify-end gap-2">
								<Input
									type="password"
									value={keyInput}
									onChange={(e) => setKeyInput(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter" && keyInput.trim()) void saveKey();
									}}
									placeholder="e.g. AIza…"
									aria-label="Google AI Studio key"
									data-testid="read-aloud-key-input"
									disabled={savingKey}
									autoComplete="off"
									className="min-w-28 flex-1 font-mono"
								/>
								<Button type="button" variant="outline" disabled={savingKey || !keyInput.trim()} onClick={() => void saveKey()} data-testid="read-aloud-key-save">
									{savingKey && <Loader2Icon className="animate-spin" aria-hidden />}
									{savingKey ? "Saving…" : "Save"}
								</Button>
							</span>
						</SettingsRow>
					)}
					{keyError && <div><ErrorNotice error={keyError} what="Couldn't save the key." testid="read-aloud-key-error" /></div>}
					{testError && (
						<div>
							<ErrorNotice error={testError} what="Google couldn't read the test sentence." sentence={testRefused ? "Google refused the key. Check it, or create a new one with Get a key." : undefined} onRetry={() => void runTest()} retrying={testing} testid="read-aloud-test-error" />
						</div>
					)}
					{hasKey && keyState !== "working" && (
						<p data-testid="read-aloud-unverified" className="text-sm/5 text-muted-foreground">
							Unverified: Google voices were written from Google&apos;s documentation and have not been tried on this computer yet. Run Test once.
						</p>
					)}
					<p data-testid="read-aloud-privacy" className="text-sm/5 text-muted-foreground">
						{status?.privacyNote ?? "With Google voices on, the text read aloud is sent to Google. On the free tier Google may use it to improve its products."}{" "}
						The free tier has daily limits; when one is reached, the system voices read until it resets.
					</p>
					<SettingsRow label="Quality" hint="Natural sounds best; Faster starts sooner" testid="row-read-aloud-model">
						<ThinSelect
							value={model}
							ariaLabel="google voice quality"
							testid="select-read-aloud-model"
							onChange={(v) => onChange({ ...general, readAloudModel: v || GOOGLE_TTS_DEFAULT_MODEL })}
						>
							{(status?.models ?? [{ id: GOOGLE_TTS_DEFAULT_MODEL, label: "Natural" }]).map((m) => (
								<option key={m.id} value={m.id}>
									{m.label}
								</option>
							))}
						</ThinSelect>
					</SettingsRow>
					{LESSON_LANGUAGES.map(({ id }) => {
						const voice = googleVoiceFor(id, general?.readAloudVoices);
						const busy = previewing === id;
						return (
							<Fragment key={id}>
								<SettingsRow
									label={`${LANGUAGE_NAMES[id]} voice`}
									hint={hasKey ? `Used for lessons in ${LANGUAGE_NAMES[id]}` : "Preview needs a key"}
									testid={`row-read-aloud-google-voice-${id}`}
								>
									<span className="flex items-center gap-2">
										<ThinSelect
											value={voice}
											ariaLabel={`${LANGUAGE_NAMES[id]} Google voice`}
											testid={`select-read-aloud-google-voice-${id}`}
											onChange={(v) => onChange({ ...general, readAloudVoices: { ...general?.readAloudVoices, [id]: v } })}
										>
											{GOOGLE_TTS_VOICES.map((v) => (
												<option key={v.name} value={v.name}>
													{`${v.name} — ${v.description}`}
												</option>
											))}
										</ThinSelect>
										<Button
											type="button"
											variant="outline"
											size="icon"
											disabled={!hasKey || previewing !== null}
											onClick={() => void preview(id)}
											aria-label={`Play a sample of the ${LANGUAGE_NAMES[id]} voice`}
											title={`Play a sample of ${voice}`}
											data-testid={`read-aloud-preview-${id}`}
										>
											{busy ? <Loader2Icon className="animate-spin" aria-hidden /> : <PlayIcon aria-hidden />}
										</Button>
									</span>
								</SettingsRow>
								{previewError?.language === id && (
									<div>
										<ErrorNotice error={previewError.error} what="Couldn't play the sample." onRetry={() => void preview(id)} testid={`read-aloud-preview-error-${id}`} />
									</div>
								)}
							</Fragment>
						);
					})}
				</>
			)}

			<SettingsRow
				label="Speech rate"
				hint="Playback speed for read-aloud, for every voice"
				testid="row-read-aloud-rate"
			>
				<ThinSelect
					value={String(currentRate)}
					ariaLabel="speech rate"
					testid="select-read-aloud-rate"
					onChange={(v) => {
						const n = Number(v);
						if (Number.isFinite(n)) onChange({ ...general, readAloudRate: n });
					}}
				>
					{rateOptions.map((r) => (
						<option key={r} value={String(r)}>
							{formatRateLabel(r)}
						</option>
					))}
				</ThinSelect>
			</SettingsRow>
			<SettingsRow
				label={engine === "google" ? "System voice (fallback)" : "System voice"}
				hint={voiceHint}
				testid="row-read-aloud-voice"
			>
				<ThinSelect
					value={currentVoice}
					ariaLabel="read aloud voice"
					testid="select-read-aloud-voice"
					disabled={!supported}
					onChange={(v) => onChange({ ...general, readAloudVoice: v === "" ? null : v })}
				>
					<option value="">System default</option>
					{currentVoice !== "" && !hasSavedVoice && (
						<option value={currentVoice}>{currentVoice} (unavailable)</option>
					)}
					{voices.map((v) => {
						const id = v.voiceURI || v.name;
						return (
							<option key={id} value={id}>
								{voiceLabel(v)}
							</option>
						);
					})}
				</ThinSelect>
			</SettingsRow>
		</SettingsGroup>
	);
}
