import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { CONFIDENCE_STOPS } from "@/src/core";

/**
 * The confidence RAIL — the slider's paint, shared by two surfaces so they
 * can never drift apart (owner, 2026-10-01):
 *
 *   - the dock's live slider (question-dock) — a transparent range input
 *     rides on top of this paint, disc and all;
 *   - the ANSWERED card (owner round 6) — the same rail with NO disc,
 *     which itself communicates "this is a record, not a control".
 *
 * Geometry law: the rail spans the thumb-CENTER range (inset half a 16px
 * disc per side) so the dock's 0/100 stops sit flush at the very ends.
 * The static card has no thumb, but keeps the identical shape.
 *
 * Stack law: the page background as the base, SOLID stop ticks
 * as background layers UNDER the fill, and the fill itself TRANSPARENT
 * past the value — so ticks show only on the empty side, never over the
 * color. Ticks skip 0 and 100 (the rail's ends already say those).
 */

/** The six-step ramp (owner ruling): 0 red → 100 emerald, indexed by stop. */
export const CONFIDENCE_COLORS: readonly string[] = [
	"#ef4444", // 0
	"#f97316", // 30
	"#eab308", // 50
	"#84cc16", // 70
	"#22c55e", // 90
	"#10b981", // 100
];

/** The stop ticks: the foreground ink at 35% (the old fixed
 *  rgba(230,230,230,.35) was the dark foreground's value). */
const RAIL_TICK = "color-mix(in oklab, var(--foreground) 35%, transparent)";

function parseHex(hex: string): [number, number, number] {
	const n = Number.parseInt(hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(r: number, g: number, b: number): string {
	const part = (c: number) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0");
	return `#${part(r)}${part(g)}${part(b)}`;
}

/** Ramp color for any confidence value (0–100): exact at CONFIDENCE_STOPS, linearly interpolated between them. */
export function confidenceColor(value: number): string {
	const v = Math.max(0, Math.min(100, value));
	const exactIdx = CONFIDENCE_STOPS.indexOf(v);
	if (exactIdx !== -1) return CONFIDENCE_COLORS[exactIdx] ?? CONFIDENCE_COLORS[2]!;
	for (let i = 0; i < CONFIDENCE_STOPS.length - 1; i++) {
		const lo = CONFIDENCE_STOPS[i]!;
		const hi = CONFIDENCE_STOPS[i + 1]!;
		if (v > lo && v < hi) {
			const t = (v - lo) / (hi - lo);
			const [r1, g1, b1] = parseHex(CONFIDENCE_COLORS[i]!);
			const [r2, g2, b2] = parseHex(CONFIDENCE_COLORS[i + 1]!);
			return toHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
		}
	}
	return CONFIDENCE_COLORS[CONFIDENCE_COLORS.length - 1]!;
}

/** The rail's paint for a confidence value (0–100), or null while unset (empty track with stop ticks). */
export function confidenceRailStyle(value: number | null): CSSProperties {
	const clamped = value === null ? null : Math.max(0, Math.min(100, value));
	const fill = clamped === null
		? "linear-gradient(90deg, transparent 0%, transparent 100%)"
		: (() => {
			const color = confidenceColor(clamped);
			return `linear-gradient(90deg, ${color} 0%, ${color} ${clamped}%, transparent ${clamped}%, transparent 100%)`;
		})();
	return {
		backgroundColor: "var(--background)",
		backgroundImage: [
			fill,
			...[30, 50, 70, 90].map(() => `linear-gradient(90deg, ${RAIL_TICK}, ${RAIL_TICK})`),
		].join(", "),
		backgroundSize: ["100% 100%", "1px 100%", "1px 100%", "1px 100%", "1px 100%"].join(", "),
		backgroundPosition: ["0 0", ...[30, 50, 70, 90].map((p) => `${p}% 0`)].join(", "),
		backgroundRepeat: "no-repeat",
	};
}

/** The static rail — the slider's look, disc removed. */
export function ConfidenceRail({ value, className }: { value: number; className?: string }) {
	return (
		<div
			aria-hidden
			data-testid="confidence-rail"
			className={cn("h-1.5 w-full rounded-full border border-border", className)}
			style={confidenceRailStyle(value)}
		/>
	);
}
