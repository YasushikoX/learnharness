"use client";

import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
	CONFIDENCE_LEVELS,
	CONFIDENCE_STOPS,
	type ConfidenceControl,
	type QuestionFormDraft,
} from "@/src/core";
import { ConfidenceButtons } from "@/components/confidence-buttons";
import { confidenceColor, confidenceRailStyle } from "@/components/confidence-rail";

export const CONFIDENCE_STEP = 5;
export const CONFIDENCE_DEFAULT_START = 50;

/** Clamp any numeric input onto the 0–100 confidence scale in steps of 5. */
export function clampConfidenceStep(value: number): number {
	if (!Number.isFinite(value)) return CONFIDENCE_DEFAULT_START;
	const stepped = Math.round(value / CONFIDENCE_STEP) * CONFIDENCE_STEP;
	return Math.max(0, Math.min(100, stepped));
}

/** Restore a draft's confidence value (supports both continuous 0–100 and legacy stop index). */
export function initialConfidenceFromDraft(draft?: QuestionFormDraft): number | null {
	if (typeof draft?.confidence === "number" && Number.isFinite(draft.confidence)) {
		return Math.max(0, Math.min(100, Math.round(draft.confidence)));
	}
	if (typeof draft?.confidenceIndex === "number") {
		return CONFIDENCE_STOPS[draft.confidenceIndex] ?? null;
	}
	return null;
}

/** Matching stop index for a confidence value, or null when unset or between stops. */
export function confidenceIndexFor(value: number | null): number | null {
	if (value === null) return null;
	const idx = CONFIDENCE_STOPS.indexOf(value);
	return idx === -1 ? null : idx;
}

/**
 * Pure keyboard step helper shared by ConfidenceSlider and QuestionDock.
 * Returns the next confidence value (0–100) for arrow/Home/End keys, or null if unhandled.
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

	if (key === "Home") return 0;
	if (key === "End") return 100;
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
	/** Current confidence (0–100), or null while unset. */
	value: number | null;
	onChange: (value: number) => void;
	disabled?: boolean;
	/** Optional leading slot (e.g. "I don't know" button in QuestionDock). */
	leading?: ReactNode;
	/** Show a quiet hint while unset. */
	showUnsetHint?: boolean;
	testid?: string;
	className?: string;
}

/**
 * Dynamic 0–100 confidence slider (steps of 5) sharing ConfidenceRail's paint
 * and geometry law. Starts unset (null) until the learner drags, clicks, or
 * steps it with the keyboard.
 */
export function ConfidenceSlider({
	value,
	onChange,
	disabled = false,
	leading,
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

	return (
		<div
			data-testid="confidence-slider-row"
			className={cn("flex w-full flex-wrap items-center gap-x-3 gap-y-1.5", className)}
		>
			{leading}
			<div className="flex min-w-[12rem] flex-1 items-center gap-2.5">
				<span className="shrink-0 text-[11px] font-medium text-muted-foreground">
					Confidence
				</span>
				<div className="relative flex h-9 min-w-0 flex-1 items-center">
					{/* Rail inset half a 16px disc per side so 0% and 100% align with the rail ends. */}
					<div
						aria-hidden
						data-testid="confidence-slider-rail"
						className="mx-2 h-1.5 w-full rounded-full border border-border"
						style={confidenceRailStyle(value)}
					/>
					<input
						type="range"
						min={0}
						max={100}
						step={CONFIDENCE_STEP}
						value={visualPct}
						disabled={disabled}
						aria-label="Confidence"
						aria-valuemin={0}
						aria-valuemax={100}
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

/**
 * Unified dock confidence row: renders either the 0–100 ConfidenceSlider or
 * the five ConfidenceButtons, keeping the shared "I don't know" control.
 */
export function QuestionConfidenceRow({
	mode,
	value,
	onSliderChange,
	onButtonPick,
	onDontKnow,
	buttonsDisabled,
	sliderDisabled,
	dontKnowDisabled,
}: {
	mode: ConfidenceControl;
	value: number | null;
	onSliderChange: (value: number) => void;
	onButtonPick: (stopIndex: number) => void;
	onDontKnow: () => void;
	buttonsDisabled?: boolean;
	sliderDisabled?: boolean;
	dontKnowDisabled?: boolean;
}) {
	if (mode === "buttons") {
		return (
			<ConfidenceButtons
				onPick={onButtonPick}
				disabled={buttonsDisabled}
				highlight={confidenceIndexFor(value)}
				leading={
					<button
						type="button"
						disabled={dontKnowDisabled}
						onClick={onDontKnow}
						data-testid="dont-know-button"
						className="lh-touch h-10 min-w-0 flex-[1.8] truncate rounded-[6px] border border-dashed border-border/70 bg-transparent px-0 text-[11px] tracking-tighter text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
					>
						I don't know
					</button>
				}
			/>
		);
	}

	return (
		<ConfidenceSlider
			value={value}
			onChange={onSliderChange}
			disabled={sliderDisabled}
			showUnsetHint
			leading={
				<button
					type="button"
					disabled={dontKnowDisabled}
					onClick={onDontKnow}
					data-testid="dont-know-button"
					className="lh-touch h-9 shrink-0 rounded-[6px] border border-dashed border-border/70 bg-transparent px-3 text-[11px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
				>
					I don't know
				</button>
			}
		/>
	);
}
