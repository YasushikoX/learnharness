"use client";

import { useEffect, useMemo, useState } from "react";
import { DEFAULT_READ_ALOUD_RATE, type GeneralSettings } from "@/src/core";
import { SettingsGroup, SettingsRow, ThinSelect, Toggle } from "@/components/settings/controls";
import { browserSpeechDeps, type SpeechVoiceLike } from "@/components/speech-controller";

export const READ_ALOUD_RATES: readonly number[] = [0.5, 0.75, 0.9, 1, 1.15, 1.25, 1.5, 1.75, 2];

function formatRateLabel(rate: number): string {
	return rate === 1 ? "1× (Normal)" : `${rate}×`;
}

function voiceLabel(voice: SpeechVoiceLike): string {
	return voice.lang ? `${voice.name} (${voice.lang})` : voice.name;
}

/**
 * Settings → General → Read aloud: automatic question reading, speech rate,
 * and system voice selection (offline Web Speech API voices).
 */
export function ReadAloudSection({
	general,
	onChange,
}: {
	general: GeneralSettings | undefined;
	/** Writes the WHOLE general section (replace-whole). */
	onChange: (next: GeneralSettings) => void;
}) {
	const [supported, setSupported] = useState(true);
	const [voices, setVoices] = useState<readonly SpeechVoiceLike[]>([]);

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

	const currentRate = general?.readAloudRate ?? DEFAULT_READ_ALOUD_RATE;
	const rateOptions = useMemo(() => {
		const set = new Set<number>(READ_ALOUD_RATES);
		set.add(currentRate);
		return [...set].sort((a, b) => a - b);
	}, [currentRate]);

	const currentVoice = general?.readAloudVoice ?? "";
	const hasSavedVoice = currentVoice !== "" && voices.some((v) => (v.voiceURI || v.name) === currentVoice);

	const voiceHint = !supported
		? "System speech synthesis is unavailable in this browser"
		: voices.length === 0
			? "No system speech voices detected — using system default"
			: "A chosen voice is used when its language matches the lesson; otherwise a voice matching the lesson language is preferred";

	return (
		<SettingsGroup label="Read aloud" testid="group-read-aloud">
			<SettingsRow
				label="Read questions aloud automatically"
				hint="Speaks each new pending question once when it appears, using your system's voices"
				testid="row-read-aloud-auto"
			>
				<Toggle
					checked={general?.readAloudAuto ?? false}
					label="Read questions aloud automatically"
					onChange={(on) => onChange({ ...general, readAloudAuto: on })}
				/>
			</SettingsRow>
			<SettingsRow
				label="Speech rate"
				hint="Playback speed for read-aloud"
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
				label="Voice"
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
