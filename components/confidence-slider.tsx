"use client";

import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
	CONFIDENCE_LEVELS,
	CONFIDENCE_STOPS,
	type ConfidenceControl,
	type QuestionFormDraft,
} from "@/src/core";
import { confidenceColor, confidenceRailStyle } from "@/components/confidence-rail";

export const CONFIDENCE_SLIDER_MIN = 5;
export const CONFIDENCE_SLIDER_MAX = 100;
export const CONFIDENCE_STEP = 5;
export const CONFIDENCE_DEFAULT_START = 50;

/** Clamp any numeric value to the 5–100 slider scale in steps of 5 (0 stays reserved for "I don't know"). */
export function clampConfidenceStep(value: number): number {
	if (!Number.isFinite(value)) return CONFIDENCE_DEFAULT_START;
	const clamped = Math.min(CONFIDENCE_SLIDER_MAX, Math.max(CONFIDENCE_SLIDER_MIN, value));
	return Math.min(CONFIDENCE_SLIDER_MAX, Math.max(CONFIDENCE_SLIDER_MIN, Math.round(clamped / CONFIDENCE_STEP) * CONFIDENCE_STEP));
}

/** Recover initial numeric confidence (5–100, or null) from a saved QuestionFormDraft. */
export function initialConfidenceFromDraft(draft: QuestionFormDraft | undefined): number | null {
	if (!draft) return null;
	if (typeof draft.confidence === "number" && Number.isFinite(draft.confidence)) {
		return clampConfidenceStep(draft.confidence);
	}
	if (draft.confidenceIndex !== null && draft.confidenceIndex !== undefined) {
		const stop = CONFIDENCE_STOPS[draft.confidenceIndex];
		return stop !== undefined && stop > 0 ? stop : null;
	}
	return null;
}

/** Exact index into CONFIDENCE_STOPS for a numeric value, or null for non-stop slider values. */
export function confidenceIndexFor(value: number | null): number | null {
	if (value === null) return null;
	const idx = CONFIDENCE_STOPS.indexOf(value);
	return idx === -1 ? null : idx;
}

/**
 * Pure keyboard step helper shared by ConfidenceSlider and QuestionDock.
 * Returns the next confidence value for arrow/Home/End keys, or null if unhandled.
 */
export function stepConfidenceKey(
	mode: ConfidenceControl,
	current: number | null,
	key: string,
): number | null {
	if (mode === "buttons") {
		if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
		const first = CONFIDENCE_LEVELS[0]!.index;
		const last = CONFIDENCE_LEVELS[CONFIDENCE_LEVELS.length - 1]!.index;
		if (current === null) return 50;
		const exactIdx = CONFIDENCE_STOPS.indexOf(current);
		const baseIdx = exactIdx !== -1
			? exactIdx
			: CONFIDENCE_LEVELS.reduce((best, lvl) =>
				Math.abs(lvl.stop - current) < Math.abs(CONFIDENCE_STOPS[best]! - current) ? lvl.index : best, first);
		const nextIdx = Math.min(last, Math.max(first, baseIdx + (key === "ArrowRight" ? 1 : -1)));
		return CONFIDENCE_STOPS[nextIdx] ?? 50;
	}

	if (key === "Home") return CONFIDENCE_SLIDER_MIN;
	if (key === "End") return CONFIDENCE_SLIDER_MAX;
	const delta = key === "ArrowRight" || key === "ArrowUp"
		? CONFIDENCE_STEP
		: key === "ArrowLeft" || key === "ArrowDown"
			? -CONFIDENCE_STEP
			: 0;
	if (delta === 0) return null;
	const base = current ?? CONFIDENCE_DEFAULT_START;
	return clampConfidenceStep(base + delta);
}

export interface ConfidenceSliderProps {
	/** Current confidence (5–100), or null while unset. */
	value: number | null;
	onChange: (value: number) => void;
	disabled?: boolean;
	/** Optional leading slot (e.g. custom control). */
	leading?: ReactNode;
	/** Optional "I don't know" button handler rendered in the leading slot. */
	onDontKnow?: () => void;
	/** Disables the built-in "I don't know" button when `onDontKnow` is supplied. */
	dontKnowDisabled?: boolean;
	/** Show a quiet hint while unset. */
	showUnsetHint?: boolean;
	testid?: string;
	className?: string;
}

/**
 * Dynamic 5–100 confidence slider (steps of 5) sharing ConfidenceRail's paint
 * and geometry law. 0% stays reserved for "I don't know". Starts unset (null)
 * until the learner drags, clicks, or steps it with the keyboard.
 */
export function ConfidenceSlider({
	value,
	onChange,
	disabled = false,
	leading,
	onDontKnow,
	dontKnowDisabled = false,
	showUnsetHint = false,
	testid = "confidence-slider",
	className,
}: ConfidenceSliderProps) {
	const visualPct = value ?? CONFIDENCE_DEFAULT_START;
	const activeColor = value === null ? undefined : confidenceColor(value);

	const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (disabled) return;
		const next = stepConfidenceKey("slider", value, e.key);
		if (next === null) return;
		e.preventDefault();
		e.stopPropagation();
		e.nativeEvent.stopPropagation();
		onChange(next);
	};

	const leadingSlot = leading ?? (onDontKnow ? (
		<button
			type="button"
			disabled={dontKnowDisabled}
			onClick={onDontKnow}
			data-testid="dont-know-button"
			className="lh-touch h-9 shrink-0 rounded-[6px] border border-dashed border-border/70 bg-transparent px-3 text-[11px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
		>
			I don&apos;t know
		</button>
	) : null);

	return (
		<div
			data-testid="confidence-slider-row"
			className={cn("flex w-full flex-wrap items-center gap-x-3 gap-y-1.5", className)}
		>
			{leadingSlot}
			<div className="flex min-w-[12rem] flex-1 items-center gap-2.5">
				<span className="shrink-0 text-[11px] font-medium text-muted-foreground">
					Confidence
				</span>
				<div className="relative flex h-9 min-w-0 flex-1 items-center">
					{/* Rail inset half a 16px disc per side so ends align with the rail. */}
					<div
						aria-hidden
						data-testid="confidence-slider-rail"
						className="mx-2 h-1.5 w-full rounded-full border border-border"
						style={confidenceRailStyle(value)}
					/>
					<input
						type="range"
						min={CONFIDENCE_SLIDER_MIN}
						max={CONFIDENCE_SLIDER_MAX}
						step={CONFIDENCE_STEP}
						value={visualPct}
						disabled={disabled}
						aria-label="Confidence"
						aria-valuemin={CONFIDENCE_SLIDER_MIN}
						aria-valuemax={CONFIDENCE_SLIDER_MAX}
						aria-valuenow={value ?? undefined}
						aria-valuetext={value === null ? "Not set" : `${value}%`}
						data-testid={testid}
						data-unset={value === null ? "true" : undefined}
						onChange={(e) => {
							if (!disabled) onChange(clampConfidenceStep(Number(e.target.value)));
						}}
						onClick={(e) => {
							if (!disabled && value === null) onChange(clampConfidenceStep(Number(e.currentTarget.value)));
						}}
						onKeyDown={handleKeyDown}
						className="peer lh-touch absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
					/>
					<span
						aria-hidden
						style={{
							left: `calc(8px + (100% - 16px) * ${visualPct / 100})`,
							borderColor: activeColor,
							backgroundColor: activeColor ?? "var(--background)",
						}}
						className={cn(
							"pointer-events-none absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 shadow-xs transition-[transform,box-shadow]",
							value === null && "border-dashed border-muted-foreground/70",
							"peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background",
							disabled && "opacity-50",
						)}
					/>
				</div>
				<span
					data-testid="confidence-readout"
					style={activeColor ? { color: activeColor } : undefined}
					className={cn(
						"w-[4ch] shrink-0 text-center font-mono text-sm font-medium tabular-nums",
						value === null && "text-muted-foreground",
					)}
				>
					{value === null ? "—" : `${value}%`}
				</span>
				{showUnsetHint && value === null && (
					<span className="hidden text-[11px] text-muted-foreground/70 sm:inline">
						set before submitting
					</span>
				)}
			</div>
		</div>
	);
}
