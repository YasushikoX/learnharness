/**
 * The app's ONE mermaid renderer (the chrome-melt wave, 2026-09-19): both the
 * in-chat block (components/md-blocks.tsx) and the session-scoped focus
 * overlay (components/session-overlay.tsx) render charts through this module
 * — one config per rendered mode, one plugin instance, unique render ids. This
 * REPLACES streamdown's internal mermaid path entirely: its fullscreen portal
 * was hard-wired `fixed inset-0` (covering the window-drag bar, X landing in
 * drag territory) with no styling hook, which is what drove the custom
 * component in the first place.
 */

import { createMermaidPlugin } from "@streamdown/mermaid";
import type { MermaidConfig } from "mermaid";
import { mixHex, type RenderedMode, type ThemeColors } from "@/src/core";

/** The chart's base font size (px) — mermaid sizes ALL text relative to
 *  this, so it's the number the display-width cap (md-blocks) divides by:
 *  a chart shown at its natural width renders text at exactly this size.
 *  Pinned explicitly so a mermaid default change can't silently shift the
 *  cap (owner rule, chrome-melt tweaks wave, 2026-09-19: chart text must
 *  never render larger than the session's own text). */
export const MERMAID_FONT_SIZE = 16;

/** The chrome sans as a literal stack: mermaid measures labels itself, so no var(). */
const MERMAID_FONT = '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif';

/** Mermaid's base theme painted with the active theme's colors (UI round 1, 2026-11-25, SPEC §4: no default lavender
 *  #ececff): nodes on a raised surface with a hairline border one step stronger than the page's, lines and edge
 *  labels in the muted ink, clusters on the page tint, notes tinted with the warning ink. Mermaid derives its other
 *  colors from these, so they must be concrete hex values (the theme's twelve are). Pure — exported for tests. */
export function mermaidThemeVariables(c: ThemeColors, mode: RenderedMode): Record<string, string | boolean> {
	const node = mixHex(c.surface, c.text, mode === "dark" ? 0.06 : 0.03);
	const nodeBorder = mixHex(c.border, c.text, 0.25);
	return {
		darkMode: mode === "dark",
		background: c.background,
		fontFamily: MERMAID_FONT,
		primaryColor: node,
		primaryTextColor: c.text,
		primaryBorderColor: nodeBorder,
		secondaryColor: mixHex(c.surface, c.accent, 0.18),
		secondaryTextColor: c.text,
		secondaryBorderColor: mixHex(c.border, c.accent, 0.4),
		tertiaryColor: mixHex(c.background, c.text, 0.04),
		tertiaryTextColor: c.text,
		tertiaryBorderColor: c.border,
		mainBkg: node,
		nodeBorder,
		textColor: c.text,
		titleColor: c.text,
		lineColor: c.textMuted,
		edgeLabelBackground: c.background,
		clusterBkg: mixHex(c.background, c.text, 0.03),
		clusterBorder: c.border,
		noteBkgColor: mixHex(c.surface, c.warning, 0.14),
		noteTextColor: c.text,
		noteBorderColor: mixHex(c.border, c.warning, 0.45),
		actorBkg: node,
		actorBorder: nodeBorder,
		actorTextColor: c.text,
		signalColor: c.textMuted,
		signalTextColor: c.text,
		labelBoxBkgColor: node,
		labelBoxBorderColor: nodeBorder,
		labelTextColor: c.text,
		errorBkgColor: mixHex(c.surface, c.error, 0.2),
		errorTextColor: c.text,
	};
}

// Diagrams follow the rendered mode (light-mode wave, 2026-10-29) and, given the
// active theme's colors (UI round 1), take them: mermaid's base theme with
// themeVariables. Without colors: mermaid's dark theme in dark, its default theme
// in light. Callers pass the provider's resolvedMode + colors and re-render when
// they change. (Moved from ai-elements/message.tsx when the renderer became
// app-owned; the old `mermaid` prop wiring is retired.)
export function mermaidConfig(mode: RenderedMode, colors?: ThemeColors): MermaidConfig {
	const base: MermaidConfig = {
		fontFamily: MERMAID_FONT,
		fontSize: MERMAID_FONT_SIZE,
		securityLevel: "strict",
	};
	if (!colors) return { ...base, theme: mode === "dark" ? "dark" : "default" };
	return { ...base, theme: "base", themeVariables: mermaidThemeVariables(colors, mode) };
}

const plugin = createMermaidPlugin();

/** Render one chart source to an svg string. The id is unique per call —
 *  mermaid caches rendered ids, and a repeated id across charts/renders
 *  returns the stale svg (the bug streamdown's own id minting avoids). */
export async function renderMermaid(chart: string, mode: RenderedMode, colors?: ThemeColors): Promise<string> {
	const id = `lh-mermaid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
	const { svg } = await plugin.getMermaid(mermaidConfig(mode, colors)).render(id, chart);
	return svg;
}
