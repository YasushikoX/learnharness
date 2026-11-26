"use client";

import { useCallback, useRef, useState } from "react";

/**
 * THE UNSAVED-EDIT GUARD (UI round 8, 2026-11-25; SPEC §9): a list with one inline form open at a time (Upcoming, the
 * lecture timeline) switches straight to another row while the open form is clean; when it has edits, the switch waits
 * and the form asks "Discard changes?" (Keep editing focused). The open form reports its dirtiness; the list asks before
 * it moves.
 */

/** Two form values differ (shallow over their fields; arrays by their items in order). Pure. */
export function formDirty<T extends object>(initial: T, current: T): boolean {
	const a = initial as Record<string, unknown>;
	const b = current as Record<string, unknown>;
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	for (const k of keys) {
		const x = a[k];
		const y = b[k];
		if (Array.isArray(x) && Array.isArray(y)) {
			if (x.length !== y.length || x.some((v, i) => v !== y[i])) return true;
		} else if (typeof x === "string" && typeof y === "string") {
			if (x.trim() !== y.trim()) return true;
		} else if (x !== y) return true;
	}
	return false;
}

export type GuardStep<K> = { open: K | null; pending: K | null | undefined };

/** What a request to open `next` does: switch now (the open form is clean, or it is the same row), or hold it as pending
 *  until the learner answers the discard question. `undefined` = nothing pending. Pure. */
export function requestSwitch<K>(state: GuardStep<K>, next: K | null, dirty: boolean): GuardStep<K> {
	if (next === state.open) return { open: state.open, pending: undefined };
	if (state.open === null || !dirty) return { open: next, pending: undefined };
	return { open: state.open, pending: next };
}

/** The list's side: which form is open, the pending switch, and the form's dirty report. */
export function useUnsavedGuard<K extends string>() {
	const [state, setState] = useState<GuardStep<K>>({ open: null, pending: undefined });
	const dirty = useRef(false);
	const setDirty = useCallback((d: boolean) => {
		dirty.current = d;
	}, []);
	/** Ask to open `next` (null = close). */
	const request = useCallback((next: K | null) => {
		setState((s) => {
			const out = requestSwitch(s, next, dirty.current);
			if (out.open !== s.open) dirty.current = false;
			return out;
		});
	}, []);
	/** Close without asking (after a save, a delete or a confirmed discard). */
	const close = useCallback(() => {
		dirty.current = false;
		setState({ open: null, pending: undefined });
	}, []);
	/** The learner chose Discard: go where they asked to go. */
	const discard = useCallback(() => {
		dirty.current = false;
		setState((s) => ({ open: s.pending === undefined ? null : s.pending, pending: undefined }));
	}, []);
	/** The learner chose Keep editing. */
	const keep = useCallback(() => setState((s) => ({ ...s, pending: undefined })), []);
	return { open: state.open, asking: state.pending !== undefined, request, close, discard, keep, setDirty };
}
