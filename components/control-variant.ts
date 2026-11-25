/**
 * The session controls' two looks (owner, 2026-10-25 — the bottom-bar
 * declutter): `pill` is the standalone chrome (the course page, the model
 * control); `edge` is the quiet ghost button on the composer shell's bottom
 * edge, where Sources and the language live now.
 *
 * UI round 1 (2026-11-25, SPEC §3): both are 28px controls on the 6/8 radius
 * scale — `pill` an outline button (hairline input border, the surface fill,
 * no shadow), `edge` a ghost button (no fill until hover).
 */

export type ControlVariant = "pill" | "edge";

export const CONTROL_CLASS: Record<ControlVariant, string> = {
	pill: "lh-touch flex h-7 items-center gap-1.5 rounded-md border border-input bg-card px-2.5 text-xs text-foreground transition-colors duration-(--lh-duration-hover) ease-(--lh-ease) hover:bg-raised",
	edge: "lh-touch flex h-7 items-center gap-1.5 rounded-sm px-2 text-xs text-muted-foreground transition-colors duration-(--lh-duration-hover) ease-(--lh-ease) hover:bg-raised hover:text-foreground",
};
