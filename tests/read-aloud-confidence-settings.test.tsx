import React, { act } from "react";
(globalThis as { React?: typeof React }).React = React;
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import {
	resolveSettings,
	resolveTheme,
	sanitizeUserSettings,
	type AppearanceSettings,
	type GeneralSettings,
} from "../src/core/index.ts";
import { parseAppearanceSettingsBody, parseGeneralSettingsBody } from "../src/server/settings-body.ts";
import { AppearanceProvider } from "../components/settings/appearance.tsx";
import { AppearanceSection } from "../components/settings/appearance-section.tsx";
import { ReadAloudSection } from "../components/settings/read-aloud-section.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	Event: dom.window.Event,
	IS_REACT_ACT_ENVIRONMENT: true,
});

describe("read-aloud and confidenceControl settings sanitization, resolution, and API validation", () => {
	it("sanitizes and resolves general read-aloud and appearance confidenceControl defaults and overrides", () => {
		const defaults = resolveSettings(null);
		assert.equal(defaults.general.readAloudAuto, false);
		assert.equal(defaults.general.readAloudRate, 1);
		assert.equal(defaults.general.readAloudVoice, null);
		assert.equal(defaults.appearance.confidenceControl, "slider");

		const sanitized = sanitizeUserSettings({
			version: 1,
			general: {
				readAloudAuto: true,
				readAloudRate: 1.5,
				readAloudVoice: "  com.apple.voice.compact.nb-NO.Nora  ",
			},
			appearance: {
				confidenceControl: "buttons",
			},
		});
		const resolved = resolveSettings(sanitized);
		assert.equal(resolved.general.readAloudAuto, true);
		assert.equal(resolved.general.readAloudRate, 1.5);
		assert.equal(resolved.general.readAloudVoice, "com.apple.voice.compact.nb-NO.Nora");
		assert.equal(resolved.appearance.confidenceControl, "buttons");

		// Clamping & invalid values fall back cleanly
		const clamped = sanitizeUserSettings({
			version: 1,
			general: {
				readAloudAuto: "yes",
				readAloudRate: 9,
				readAloudVoice: "   ",
			},
			appearance: {
				confidenceControl: "dial",
			},
		});
		const effClamped = resolveSettings(clamped);
		assert.equal(effClamped.general.readAloudAuto, false);
		assert.equal(effClamped.general.readAloudRate, 2);
		assert.equal(effClamped.general.readAloudVoice, null);
		assert.equal(effClamped.appearance.confidenceControl, "slider");
	});

	it("strictly validates read-aloud and confidenceControl API request bodies", () => {
		const okGeneral = parseGeneralSettingsBody({
			readAloudAuto: true,
			readAloudRate: 1.25,
			readAloudVoice: "Nora",
		});
		assert.equal(okGeneral.ok, true);
		if (okGeneral.ok) {
			assert.equal(okGeneral.settings.readAloudAuto, true);
			assert.equal(okGeneral.settings.readAloudRate, 1.25);
			assert.equal(okGeneral.settings.readAloudVoice, "Nora");
		}

		assert.equal(parseGeneralSettingsBody({ readAloudAuto: "true" }).ok, false);
		assert.equal(parseGeneralSettingsBody({ readAloudRate: 0.1 }).ok, false);
		assert.equal(parseGeneralSettingsBody({ readAloudRate: 3 }).ok, false);
		assert.equal(parseGeneralSettingsBody({ readAloudVoice: 42 }).ok, false);
		assert.equal(parseGeneralSettingsBody({ readAloudVoice: null }).ok, true);

		const okApp = parseAppearanceSettingsBody({ confidenceControl: "buttons" });
		assert.equal(okApp.ok, true);
		if (okApp.ok) assert.equal(okApp.settings.confidenceControl, "buttons");
		assert.equal(parseAppearanceSettingsBody({ confidenceControl: "slider" }).ok, true);
		assert.equal(parseAppearanceSettingsBody({ confidenceControl: "stars" }).ok, false);
	});
});

function changeSelect(select: HTMLSelectElement, value: string) {
	Object.defineProperty(select, "value", { configurable: true, writable: true, value });
	select.dispatchEvent(new window.Event("change", { bubbles: true }));
}

describe("Settings UI for read-aloud and confidenceControl", () => {
	let host: HTMLElement;
	let root: Root;
	let prevSynth: PropertyDescriptor | undefined;
	let prevUtr: PropertyDescriptor | undefined;

	beforeEach(() => {
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		prevSynth = Object.getOwnPropertyDescriptor(window, "speechSynthesis");
		prevUtr = Object.getOwnPropertyDescriptor(window, "SpeechSynthesisUtterance");
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		host.remove();
		if (prevSynth) Object.defineProperty(window, "speechSynthesis", prevSynth);
		else Reflect.deleteProperty(window, "speechSynthesis");
		if (prevUtr) Object.defineProperty(window, "SpeechSynthesisUtterance", prevUtr);
		else Reflect.deleteProperty(window, "SpeechSynthesisUtterance");
	});

	it("ReadAloudSection lists System default plus installed voices and updates general settings", async () => {
		const voices = [
			{ voiceURI: "v-en", name: "Samantha", lang: "en-US", default: true, localService: true },
			{ voiceURI: "v-nb", name: "Nora", lang: "nb-NO", default: false, localService: true },
		];
		Object.defineProperty(window, "speechSynthesis", {
			configurable: true,
			value: { getVoices: () => voices, speak: () => {}, cancel: () => {} },
		});
		Object.defineProperty(window, "SpeechSynthesisUtterance", {
			configurable: true,
			value: class { constructor(public text: string) {} },
		});

		const updates: GeneralSettings[] = [];
		await act(async () =>
			root.render(<ReadAloudSection general={{}} onChange={(next) => updates.push(next)} />),
		);

		const toggle = host.querySelector<HTMLButtonElement>('[data-testid="row-read-aloud-auto"] button[role="switch"]')!;
		const rateSelect = host.querySelector<HTMLSelectElement>('[data-testid="select-read-aloud-rate"]')!;
		const voiceSelect = host.querySelector<HTMLSelectElement>('[data-testid="select-read-aloud-voice"]')!;

		assert.equal(toggle.getAttribute("aria-checked"), "false");
		assert.equal(rateSelect.value, "1");
		assert.equal(voiceSelect.disabled, false);
		const voiceLabels = [...voiceSelect.querySelectorAll("option")].map((o) => o.textContent);
		assert.ok(voiceLabels.includes("System default"));
		assert.ok(voiceLabels.some((l) => l?.includes("Samantha")));
		assert.ok(voiceLabels.some((l) => l?.includes("Nora")));

		await act(async () => toggle.click());
		assert.equal(updates[0]!.readAloudAuto, true);

		await act(async () => changeSelect(rateSelect, "1.25"));
		assert.equal(updates[1]!.readAloudRate, 1.25);

		await act(async () => changeSelect(voiceSelect, "v-nb"));
		assert.equal(updates[2]!.readAloudVoice, "v-nb");
	});

	it("AppearanceSection renders Confidence input defaulting to slider and switches to buttons", async () => {
		const html = renderToStaticMarkup(
			<InteractionLayersProvider>
				<AppearanceProvider initialAppearance={undefined} initialTheme={resolveTheme(undefined)}>
					<AppearanceSection appearance={undefined} onSectionChange={() => true} />
				</AppearanceProvider>
			</InteractionLayersProvider>,
		);
		assert.ok(html.includes('data-testid="row-confidence-control"'));
		assert.ok(html.includes('data-testid="select-confidence-control"'));

		const saved: AppearanceSettings[] = [];
		await act(async () =>
			root.render(
				<InteractionLayersProvider>
					<AppearanceProvider initialAppearance={undefined} initialTheme={resolveTheme(undefined)}>
						<AppearanceSection appearance={undefined} onSectionChange={(next) => { saved.push(next); return true; }} />
					</AppearanceProvider>
				</InteractionLayersProvider>,
			),
		);
		const select = host.querySelector<HTMLSelectElement>('[data-testid="select-confidence-control"]')!;
		assert.equal(select.value, "slider");
		await act(async () => changeSelect(select, "buttons"));
		assert.equal(saved[0]!.confidenceControl, "buttons");
	});
});
