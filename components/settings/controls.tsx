"use client";
/**
 * Thin settings primitives (settings-app wave): the control kit the
 * settings dialog needs. Sections → groups → rows; everything SSRs clean
 * (render tests pin the sections' markup).
 *
 * The dependency graying (owner, 2026-09-20) follows the graph viewer's
 * render-panel convention: the WHOLE row dims (opacity-40, label and
 * control together) and the control itself locks — the row owns the dim.
 */

import { useLayoutEffect, useRef, useState, type ComponentPropsWithRef, type CSSProperties, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { FIELD_CLASS, Input } from "@/components/ui/input";

/** The one select look (UI round 1, SPEC §3): a 32px field, radius 8, a 1px input border, the surface fill, a 14px
 *  lucide chevron 10px from the right edge (the text never runs under it). Shared by SettingsMenuTrigger (the custom
 *  menus' trigger) and ThinSelect (native, appearance:none). */
export const SELECT_CLASS =
	cn(FIELD_CLASS, "relative flex h-8 min-w-0 max-w-full items-center pl-2.5 pr-8 text-left");
const SELECT_CHEVRON = "pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground";

/** A section block: the pane's one heading (sentence case in the title font, owner 2026-11-16) + content. */
export function SettingsSection({
	title,
	hint,
	children,
	testid,
}: {
	title: string;
	/** One quiet line under the header — only where it earns its place. */
	hint?: string;
	children: React.ReactNode;
	testid?: string;
}) {
	return (
		<section data-testid={testid} className="mx-auto w-full max-w-[768px] px-6 py-6 max-sm:px-4">
			<h2 className="lh-page-title text-foreground max-lg:hidden">{title}</h2>
			{hint && <p className="mt-1 text-sm/5 text-muted-foreground">{hint}</p>}
			<div className="flex flex-col gap-6 lg:mt-5">{children}</div>
		</section>
	);
}

/** A labeled sub-group inside a section (owner, 2026-09-20: clear
 *  separation — Models / Tools / Prompts read as three blocks). */
export function SettingsGroup({
	label,
	children,
	testid,
	hideLabelOnPhone,
	inset = true,
}: {
	label: string;
	children: React.ReactNode;
	testid?: string;
	/** Below 1024px the category's page title already says it (the dialog header), so the group's own label would repeat it. */
	hideLabelOnPhone?: boolean;
	inset?: boolean;
}) {
	return (
		<div data-testid={testid}>
			<h3 className={cn("mb-2 lh-section-title text-foreground", hideLabelOnPhone && "max-lg:hidden")}>{label}</h3>
			{inset ? <SettingsList>{children}</SettingsList> : <div className="flex flex-col gap-3">{children}</div>}
		</div>
	);
}

export function SettingsList({ className, children }: { className?: string; children: ReactNode }) {
	return <div className={cn("lh-settings-list rounded-lg border border-border bg-card", className)}>{children}</div>;
}

/** One label + one control. Label left (with optional muted hint), control
 *  right — the settings row shape. */
export function SettingsRow({
	label,
	hint,
	children,
	testid,
	dimmed,
	className,
}: {
	label: string;
	hint?: ReactNode;
	children?: React.ReactNode;
	testid?: string;
	className?: string;
	/** Dependency graying, graph-view style: the whole row dims when the
	 *  control is inert (parent off, no file yet, …). */
	dimmed?: boolean;
}) {
	return (
		<div data-testid={testid} className={cn("lh-settings-row flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2", dimmed && "opacity-40", className)}>
			<span className="min-w-0 flex-[1_1_12rem]">
				<span className="block text-base font-medium">{label}</span>
				{hint && <span className="block text-sm/5 text-muted-foreground wrap-anywhere">{hint}</span>}
			</span>
			{children && <div className="ml-auto flex min-w-0 max-w-full items-center justify-end">{children}</div>}
		</div>
	);
}

/** The existing Agent/Appearance collapsed-menu look, shared with dictation.
 * `unavailable` preserves callers that gate clicks without native disabling;
 * `disabled` retains native button semantics where the caller requires them. */
export function SettingsMenuTrigger({
	value, unavailable, disabled, className, ...props
}: Omit<ComponentPropsWithRef<"button">, "value" | "children"> & {
	value: string;
	unavailable?: boolean;
}) {
	return <button
		type="button"
		{...props}
		disabled={disabled}
		className={cn(
			SELECT_CLASS,
			disabled || unavailable ? "cursor-not-allowed opacity-45" : "hover:bg-raised",
			className,
		)}
	>
		<span className="min-w-0 flex-1 truncate">{value}</span>
		<ChevronDown aria-hidden strokeWidth={1.75} className={SELECT_CHEVRON} />
	</button>;
}

export function SettingsSegmentedControl<T extends string>({ label, options, value, disabled, testidPrefix, onChange }: {
	label: string;
	options: readonly { value: T; label: string }[];
	value: T;
	disabled?: boolean;
	testidPrefix?: string;
	onChange: (value: T) => void;
}) {
	// The selected segment always lifts off its raised track: the surface (white) in light, one step lighter than the
	// track in dark (UI round 2: the dark surface is darker than the track, so it read as pressed in).
	return <div role="radiogroup" aria-label={label} className="flex h-7 rounded-md bg-raised p-0.5">
		{options.map(option => <button key={option.value} type="button" role="radio" aria-checked={option.value === value}
			data-testid={testidPrefix ? `${testidPrefix}-${option.value}` : undefined}
			disabled={disabled} onClick={() => onChange(option.value)}
			className={cn("h-6 rounded-sm px-2.5 text-sm font-medium transition-colors duration-(--lh-duration-hover) ease-(--lh-ease)",
				option.value === value ? "bg-card text-foreground shadow-[0_0_0_1px_var(--border),0_1px_2px_rgb(0_0_0/0.08)] dark:bg-raised-strong" : "text-muted-foreground hover:text-foreground")}>
			{option.label}
		</button>)}
	</div>;
}

/** The on/off switch — a plain button in the switch role. */
export function Toggle({
	checked,
	disabled,
	onChange,
	label,
	discIcon,
	title,
}: {
	checked: boolean;
	disabled?: boolean;
	onChange: (next: boolean) => void;
	/** Accessible name for the switch role. */
	label: string;
	/** Optional icon disc (owner round, 2026-10-07): the figure cards' invert
	 *  toggle renders the half-filled contrast circle AS the disc — the icon
	 *  carries the meaning; plain toggles keep the plain disc. */
	discIcon?: ReactNode;
	/** Optional native tooltip on the switch. */
	title?: string;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			{...(title ? { title } : {})}
			disabled={disabled}
			data-testid={`toggle-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
			onClick={() => onChange(!checked)}
			className={cn(
				// the hit area grows on touch screens (a 12px halo) without changing the switch's look
					"relative h-5 w-[34px] shrink-0 rounded-full transition-colors duration-(--lh-duration-hover) ease-(--lh-ease) touch:before:absolute touch:before:-inset-3 touch:before:content-[''] disabled:opacity-45",
				// UI round 1 (SPEC §3): a 20×34 track, the theme accent when on, the
				// strong raised fill when off; a white 16px disc 2px from the edges.
				checked ? "bg-(--lh-accent)" : "bg-raised-strong",
				disabled && "cursor-not-allowed",
			)}
		>
			{discIcon ? (
				// The icon IS the disc: same size, same slide, same state colors —
				// only the knob's face changes (the invert affordance).
				<span
					className={cn(
						"absolute left-0 top-0.5 flex size-4 items-center justify-center rounded-full bg-white text-zinc-900 shadow-[0_1px_2px_rgb(0_0_0/0.25)] transition-transform duration-(--lh-duration-hover) ease-(--lh-ease)",
						checked ? "translate-x-4" : "translate-x-0.5",
					)}
				>
					{discIcon}
				</span>
			) : (
				<span
					className={cn(
						"absolute left-0 top-0.5 size-4 rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.25)] transition-transform duration-(--lh-duration-hover) ease-(--lh-ease)",
						// 2px inset from each inner edge, both states (owner round: the on
						// disc used to touch the pill's right edge).
						checked ? "translate-x-4" : "translate-x-0.5",
					)}
				/>
			)}
		</button>
	);
}

/** A thin select — native element, options as given. */
export function ThinSelect({
	value,
	onChange,
	children,
	ariaLabel,
	testid,
	disabled,
	id,
	className,
}: {
	value: string;
	onChange: (next: string) => void;
	children: React.ReactNode;
	ariaLabel?: string;
	testid?: string;
	disabled?: boolean;
	id?: string;
	className?: string;
}) {
	return (
		<span className={cn("relative inline-flex min-w-0 max-w-full", className)}>
			<select
				id={id}
				value={value}
				aria-label={ariaLabel}
				data-testid={testid}
				disabled={disabled}
				onChange={(e) => onChange(e.target.value)}
				className={cn(
					SELECT_CLASS,
					"w-full appearance-none",
					disabled ? "cursor-not-allowed opacity-45" : "hover:bg-raised",
				)}
			>
				{children}
			</select>
			<ChevronDown aria-hidden strokeWidth={1.75} className={SELECT_CHEVRON} />
		</span>
	);
}

/** Shared graph/settings range control; the label and value stay paired. */
export function SettingsSlider({ label, min, max, step, value, display, onChange, disabled, showLabel = true, className = "w-40" }: {
	label: string;
	/** The width (UI round 8: the graph panel's sliders run the panel's full width). */
	className?: string;
	min?: number;
	max?: number;
	step?: number;
	value: number;
	display?: string;
	/** SettingsRow supplies the visible label when false. */
	showLabel?: boolean;
	onChange: (value: number) => void;
	disabled?: boolean;
}) {
	// the app's range (UI round 8, SPEC §9): a themed track and thumb (globals.css .lh-range), not the OS's light track
	return <label className={cn("flex min-h-8 max-w-full flex-col justify-center gap-1", className, disabled && "opacity-45")}>
		<span className="flex items-center justify-between text-xs text-muted-foreground">
			{showLabel && label}<span className="tabular-nums text-foreground">{display ?? value}</span>
		</span>
		<input type="range" aria-label={label} min={min} max={max} step={step} value={value} disabled={disabled}
			onChange={(e) => onChange(Number(e.target.value))} className="lh-range w-full"
			style={{ "--lh-range-fill": `${max !== undefined && min !== undefined && max > min ? ((value - min) / (max - min)) * 100 : 50}%` } as CSSProperties} />
	</label>;
}

/** Internal acknowledgement: false retains a rejected/unsaved draft. */
export type SettingsCommitResult = boolean | Promise<boolean>;

/** A thin hex/text input committing on blur + Enter (settings pace, not
 *  typing pace — every commit is a section PUT). */
export function CommitInput({
	value,
	placeholder,
	onCommit,
	ariaLabel,
	testid,
	type = "text",
	disabled,
	min,
	max,
	step,
	className,
}: {
	/** "" = unset (the factory default). Mirrors the STORED record —
	 *  after a clamped/normalized commit this flows back and the field
	 *  snaps to the stored truth (owner repro: a negative size kept
	 *  displaying "-5" while 12 was stored). */
	value: string;
	placeholder?: string;
	onCommit: (next: string) => SettingsCommitResult;
	ariaLabel: string;
	testid?: string;
	type?: "text" | "number";
	disabled?: boolean;
	min?: number;
	max?: number;
	step?: number;
	className?: string;
}) {
	// Keep the native editing buffer: number inputs can display an incomplete
	// token while exposing value="" and badInput=true. Writing a controlled
	// value back on blur/render would erase text we cannot reconstruct.
	const [initialValue] = useState(value);
	const [, renderAcknowledgement] = useState(0);
	const input = useRef<HTMLInputElement>(null);
	const dirty = useRef(false);
	const revision = useRef(0);
	const latestCommit = useRef(0);
	const pending = useRef(new Set<number>());
	useLayoutEffect(() => {
		if (!dirty.current && input.current && input.current.value !== value) {
			input.current.value = value;
		}
	});

	const commit = async (element: HTMLInputElement) => {
		if (disabled || !dirty.current || element.validity?.badInput) return;
		const version = revision.current;
		if (pending.current.has(version)) return;
		const next = element.value.trim();
		if (next === value && pending.current.size === 0) {
			dirty.current = false;
			renderAcknowledgement((n) => n + 1);
			return;
		}
		const ticket = ++latestCommit.current;
		pending.current.add(version);
		try {
			const accepted = await onCommit(next);
			if (accepted && input.current === element && revision.current === version && latestCommit.current === ticket) {
				dirty.current = false;
				// Reconcile even when normalization accepted the old canonical value.
				renderAcknowledgement((n) => n + 1);
			}
		} catch {
			// Domain adapters own error presentation; a rejected save keeps text.
		} finally {
			pending.current.delete(version);
		}
	};
	return (
		<Input
			ref={input}
			type={type}
			defaultValue={initialValue}
			placeholder={placeholder}
			aria-label={ariaLabel}
			data-testid={testid}
			disabled={disabled}
			min={min}
			max={max}
			step={step}
			onInput={() => {
				dirty.current = true;
				revision.current++;
			}}
			onBlur={(e) => { void commit(e.currentTarget); }}
			onKeyDown={(e) => {
				if (e.key === "Enter") e.currentTarget.blur();
				if (e.key === "Escape") {
					e.preventDefault();
					e.stopPropagation();
					e.currentTarget.blur();
				}
			}}
			className={cn(
				"w-40 max-w-full tabular-nums",
				// hex colour fields read in mono (SPEC §1)
				placeholder?.startsWith("#") && "font-mono",
				className,
			)}
		/>
	);
}
