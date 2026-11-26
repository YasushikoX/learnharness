"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";
import { FIELD_CLASS } from "@/components/ui/input";
import { useOverflow } from "@/components/ui/field";
import { cn } from "@/lib/utils";

/**
 * A long list in the class side panel, kept short (UI long lists, 2026-11-26; owner: "once you have a lot of files
 * displayed they just overtake that side"; "show a few and then a dropdown to show more, and the same goes for
 * lectures"). The class's Files, its Upcoming quizzes and exams, and its Lectures all use it:
 *
 *   collapsed  the caller's few rows (`preview`: the files that failed or are still being read, then the newest; the next
 *              quizzes by date; the class's current lecture and the next two), then one quiet disclosure row
 *              "Show all 37" with a chevron.
 *   expanded   every row, in a bounded area of its own (320 px or 40 % of the panel's height, whichever is smaller,
 *              cut at a whole row, SPEC §9), a "Filter files" field above it once there are more than 10, and the same
 *              row, now "Show fewer", at the end.
 *
 * Nothing is hidden when the toggle would hide fewer than two rows (the row would take the space it saves). The panel
 * scrolls as a whole; only the expanded list scrolls on its own, and not while one of its rows is an open form
 * (`unbounded`), so a form never sits in a second scroll area. Expanded or collapsed is remembered for the session, per
 * class and list (`storageKey`).
 */

/** About this many rows show before "Show all". */
export const SHORT_LIST_ROWS = 5;
/** The filter field appears once the list has more rows than this. */
export const SHORT_LIST_FILTER_AT = 10;
/** The expanded list's bound: this many px, or this share of the panel's height, whichever is smaller. */
export const SHORT_LIST_MAX_PX = 320;
export const SHORT_LIST_MAX_SHARE = 0.4;

export interface ShortListView<T> {
	/** The rows to render, in order. */
	rows: T[];
	/** Does the list have a "Show all" / "Show fewer" row at all? */
	toggles: boolean;
	/** Rows hidden while collapsed. */
	hidden: number;
	/** Is the filter field shown? */
	filterable: boolean;
}

/** Which rows show. `items` in the expanded order, `preview` the collapsed rows (a subset), `text` what the filter
 *  searches. Pure. */
export function shortListView<T>(
	items: readonly T[],
	preview: readonly T[],
	{ expanded, query = "", text }: { expanded: boolean; query?: string; text?: (item: T) => string },
): ShortListView<T> {
	const hidden = items.length - preview.length;
	if (hidden < 2) return { rows: [...items], toggles: false, hidden: 0, filterable: false };
	if (!expanded) return { rows: [...preview], toggles: true, hidden, filterable: false };
	const filterable = items.length > SHORT_LIST_FILTER_AT && !!text;
	const q = query.trim().toLowerCase();
	const rows = filterable && q ? items.filter((it) => text!(it).toLowerCase().includes(q)) : [...items];
	return { rows, toggles: true, hidden, filterable };
}

/** A window of `count` rows from `start` (moved back when it would run past the end), plus the row `keep` (one being
 *  edited) wherever it is, in the list's order: the collapsed rows of the Upcoming and Lectures lists. Pure. */
export function shortRows<T extends { id: string }>(items: readonly T[], keep?: string, start = 0, count = SHORT_LIST_ROWS): { items: T[]; preview: T[] } {
	const from = Math.max(0, Math.min(start, items.length - count));
	const preview = items.filter((it, i) => (i >= from && i < from + count) || it.id === keep);
	return { items: [...items], preview };
}

/** The expanded area's height: the bottom of the last row that fits in `bound` (rows as [top, bottom] in the list), at
 *  least the first row. Pure. */
export function wholeRowsHeight(rows: ReadonlyArray<readonly [number, number]>, bound: number): number {
	let height = rows[0]?.[1] ?? 0;
	for (const [, bottom] of rows) if (bottom <= bound) height = Math.max(height, bottom);
	return height;
}

/** The bound for a panel of this height. Pure. */
export function shortListBound(panelHeight: number): number {
	return Math.min(SHORT_LIST_MAX_PX, Math.round(panelHeight * SHORT_LIST_MAX_SHARE));
}

// Expanded or collapsed, per class and list, for this session: in memory, and in sessionStorage so a reload keeps it.
const remembered = new Map<string, boolean>();
const STORE_KEY = (key: string) => `lh:short-list:${key}`;

export function rememberedExpanded(key: string | undefined): boolean {
	if (!key) return false;
	const known = remembered.get(key);
	if (known !== undefined) return known;
	try {
		return typeof window !== "undefined" && window.sessionStorage?.getItem(STORE_KEY(key)) === "1";
	} catch {
		return false;
	}
}

export function rememberExpanded(key: string | undefined, expanded: boolean): void {
	if (!key) return;
	remembered.set(key, expanded);
	try {
		if (expanded) window.sessionStorage?.setItem(STORE_KEY(key), "1");
		else window.sessionStorage?.removeItem(STORE_KEY(key));
	} catch {
		/* private mode: the in-memory copy still holds for this page */
	}
}

/** For tests: forget every remembered state. */
export function forgetShortLists(): void {
	remembered.clear();
}

export function ShortList<T>({
	items,
	preview,
	keyOf,
	render,
	text,
	noun,
	storageKey,
	anchor,
	unbounded = false,
	testid,
	className,
	rowsClassName,
}: {
	/** Every row, in the expanded order. */
	items: readonly T[];
	/** The collapsed rows (a subset of `items`, in their own order). */
	preview: readonly T[];
	keyOf: (item: T) => string;
	render: (item: T) => ReactNode;
	/** What the filter searches in a row (without it, no filter). */
	text?: (item: T) => string;
	/** "files", "lectures": the filter's placeholder and its "No files match" line. */
	noun: string;
	/** Remembers expanded / collapsed for the session (class id and list). */
	storageKey?: string;
	/** Expanded, the area scrolls to this row first (the class's current lecture). */
	anchor?: string;
	/** A row is an open form: no bounded area while it is. */
	unbounded?: boolean;
	testid: string;
	className?: string;
	/** The rows' own wrapper (their spacing). */
	rowsClassName?: string;
}) {
	// The first render reads only the in-memory copy (the server's is always empty, so hydration matches); the effect then
	// reads sessionStorage, and follows another class when the list is reused for it.
	const [expanded, setExpandedState] = useState(() => (storageKey ? (remembered.get(storageKey) ?? false) : false));
	useEffect(() => setExpandedState(rememberedExpanded(storageKey)), [storageKey]);
	const [query, setQuery] = useState("");
	const [areaRef, overflow] = useOverflow<HTMLDivElement>();
	const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);
	const anchored = useRef(false);
	const view = shortListView(items, preview, { expanded, query, text });
	const bounded = expanded && view.toggles && !unbounded;
	const setExpanded = (next: boolean) => {
		rememberExpanded(storageKey, next);
		setExpandedState(next);
		setQuery("");
		anchored.current = false;
	};

	// Whole rows only: cut the area at the last row that fits the bound (re-measured when the rows or the window change).
	const rowKeys = view.rows.map(keyOf).join("\n");
	useLayoutEffect(() => {
		const el = areaRef.current;
		if (!bounded || !el) {
			setMaxHeight(undefined);
			return;
		}
		const measure = () => {
			const panel = el.closest("aside") as HTMLElement | null;
			const bound = shortListBound(panel?.clientHeight || window.innerHeight || 800);
			const rows = Array.from(el.children as HTMLCollectionOf<HTMLElement>).map((c) => [c.offsetTop, c.offsetTop + c.offsetHeight] as const);
			setMaxHeight(rows.length > 0 ? wholeRowsHeight(rows, bound) : undefined);
			if (anchor && !anchored.current) {
				anchored.current = true;
				const at = Array.from(el.children as HTMLCollectionOf<HTMLElement>).find((c) => c.dataset.shortListKey === anchor);
				if (at) el.scrollTop = at.offsetTop;
			}
		};
		measure();
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, [bounded, rowKeys, anchor, areaRef]);

	const filterId = `${testid}-filter`;
	return (
		<div className={className} data-testid={testid} data-expanded={view.toggles ? String(expanded) : undefined}>
			{view.filterable && (
				<input
					type="search"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Escape" && query) {
							e.stopPropagation();
							setQuery("");
						}
					}}
					placeholder={`Filter ${noun}`}
					aria-label={`Filter ${noun}`}
					data-testid={filterId}
					className={cn(FIELD_CLASS, "mb-1.5 h-8 w-full min-w-0 px-2.5 text-chrome")}
				/>
			)}
			<div
				ref={areaRef}
				className={cn("relative", rowsClassName, bounded && "lh-short-list-area")}
				style={bounded && maxHeight ? { maxHeight } : undefined}
				data-overflow={bounded && overflow ? "true" : "false"}
				data-testid={`${testid}-rows`}
			>
				{view.rows.map((item) => (
					<div key={keyOf(item)} data-short-list-key={keyOf(item)}>
						{render(item)}
					</div>
				))}
			</div>
			{view.filterable && query.trim() && view.rows.length === 0 && (
				<p className="px-1 py-1 text-meta text-muted-foreground" data-testid={`${testid}-no-match`}>
					No {noun} match “{query.trim()}”.
				</p>
			)}
			{view.toggles && (
				<button
					type="button"
					aria-expanded={expanded}
					onClick={() => setExpanded(!expanded)}
					data-testid={`${testid}-toggle`}
					className="-mx-1 mt-0.5 flex h-7 w-[calc(100%+0.5rem)] items-center gap-1.5 rounded-sm px-1 text-left text-meta text-muted-foreground outline-none transition-colors duration-(--lh-duration-hover) hover:bg-raised hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus"
				>
					<ChevronDownIcon
						aria-hidden
						className={cn("size-3.5 shrink-0 transition-transform duration-(--lh-duration-hover) ease-(--lh-ease)", expanded && "rotate-180")}
						strokeWidth={1.75}
					/>
					{expanded ? "Show fewer" : `Show all ${items.length}`}
				</button>
			)}
		</div>
	);
}
