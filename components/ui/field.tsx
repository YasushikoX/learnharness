import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A labelled field for the inline forms (UI round 8, 2026-11-25; SPEC §9): a 12/16 medium muted label 4px above the
 * control, an optional hint on the label's right (the formatted date of a native date input), placeholders as "e.g."
 * hints only. The label wraps the control, so a click on it focuses the field.
 */
export function Field({ label, hint, className, children, testid }: { label: string; hint?: React.ReactNode; className?: string; children: React.ReactNode; testid?: string }) {
	return (
		<label className={cn("flex min-w-0 flex-col gap-1", className)} data-testid={testid}>
			<span className="flex items-baseline justify-between gap-2 text-meta font-medium text-muted-foreground">
				<span>{label}</span>
				{hint && <span className="truncate font-normal tabular-nums">{hint}</span>}
			</span>
			{children}
		</label>
	);
}

/** The same label over a group that is not one control (a checkbox list). */
export function FieldGroup({ label, hint, className, children, testid }: { label: string; hint?: React.ReactNode; className?: string; children: React.ReactNode; testid?: string }) {
	const id = React.useId();
	return (
		<div role="group" aria-labelledby={id} className={cn("flex min-w-0 flex-col gap-1", className)} data-testid={testid}>
			<span id={id} className="flex items-baseline justify-between gap-2 text-meta font-medium text-muted-foreground">
				<span>{label}</span>
				{hint && <span className="font-normal">{hint}</span>}
			</span>
			{children}
		</div>
	);
}

/** A 28px checkbox row for a form's list. */
export function CheckRow({ checked, disabled, onChange, children, testid }: { checked: boolean; disabled?: boolean; onChange: () => void; children: React.ReactNode; testid?: string }) {
	return (
		<label className={cn("flex min-h-7 cursor-pointer items-center gap-2 rounded-sm px-1.5 text-chrome hover:bg-raised", disabled && "cursor-not-allowed text-muted-foreground hover:bg-transparent")}>
			<input type="checkbox" className="lh-checkbox" checked={checked} disabled={disabled} onChange={onChange} data-testid={testid} />
			<span className="min-w-0 truncate">{children}</span>
		</label>
	);
}

/** Does the list overflow its 5 rows (for the bottom fade)? */
export function useOverflow<T extends HTMLElement>(): [React.RefObject<T | null>, boolean] {
	const ref = React.useRef<T>(null);
	const [over, setOver] = React.useState(false);
	React.useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const check = () => setOver(el.scrollHeight - el.clientHeight > 1 && el.scrollTop + el.clientHeight < el.scrollHeight - 1);
		check();
		el.addEventListener("scroll", check);
		return () => el.removeEventListener("scroll", check);
	});
	return [ref, over];
}
