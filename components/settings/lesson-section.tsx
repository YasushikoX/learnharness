"use client";

import type { GeneralSettings } from "@/src/core";
import { SettingsGroup, SettingsRow, Toggle } from "@/components/settings/controls";

/**
 * Settings → General: course lesson behaviour (WP5, 2026-11-25). One switch: the vocabulary finish refusal
 * (general.refuseFinishWithUnintroducedTerms, core/coverage-ledger.ts), off by default while it is experimental. The
 * class term lists, the lesson-result line and the course page's counts work without it. A change applies from the
 * lesson's next turn.
 */
export function LessonSection({
	general,
	onChange,
}: {
	general: GeneralSettings | undefined;
	/** Writes the WHOLE general section (replace-whole). */
	onChange: (next: GeneralSettings) => void;
}) {
	return (
		<SettingsGroup label="Lessons" testid="group-lessons">
			<SettingsRow
				label="Refuse finishing a lesson while listed class terms were not introduced"
				hint="Experimental. Term tracking and the term lists work without it"
				testid="row-refuse-finish-terms"
			>
				<Toggle
					checked={general?.refuseFinishWithUnintroducedTerms ?? false}
					label="Refuse finishing a lesson while listed class terms were not introduced"
					onChange={(on) => onChange({ ...general, refuseFinishWithUnintroducedTerms: on })}
				/>
			</SettingsRow>
		</SettingsGroup>
	);
}
