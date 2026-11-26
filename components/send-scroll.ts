/**
 * The transcript's motion on a send (owner: "When you send a message it jumps
 * up and then rapidly scrolls down", UI round 12).
 *
 * The rules:
 * - On a send the view moves ONCE, straight to the new message, and never the
 *   other way first.
 * - A long way (more than one screen) is a jump; only a short way is smooth.
 * - A learner who had scrolled up to read is still brought to their message.
 * - The dock's reserve (the spacer under the transcript) changes in the same
 *   frame as the content, and never shrinks out from under the reader: a
 *   shrink that would pull the bottom of the scroll range above the current
 *   view waits, and is given back as new content fills the space.
 *
 * Pure: the DOM wiring lives in chat.tsx (DockOverlay's offer and the Chat's
 * layout effect); tests/send-scroll.test.ts drives these with a model of the
 * scroller.
 */

export interface ScrollGeometry {
	scrollTop: number;
	clientHeight: number;
	scrollHeight: number;
}

export type SendScrollBehavior = "none" | "instant" | "smooth";

/** How the view reaches a new message `distance` px below it. */
export function sendScrollBehavior(distance: number, viewport: number): SendScrollBehavior {
	if (distance <= 1) return "none";
	return distance > viewport ? "instant" : "smooth";
}

/**
 * The dock's reserve after the dock measured `target` (its block plus the
 * gradient band). Grows at once. While a question or practice problem owns the
 * dock (`hold`) it never shrinks (the fold machine's rule). Otherwise it
 * shrinks only as far as the current view stays inside the scroll range:
 * shrinking further would make the browser clamp scrollTop and move the
 * transcript down under the reader (a question answered at the bottom of a
 * short session moved it 40px; a cleared composer, ~20px).
 */
export function nextDockReserve({ target, current, hold, scroller }: {
	target: number;
	current: number;
	hold: boolean;
	scroller: ScrollGeometry | null;
}): number {
	if (target >= current - 0.5) return target;
	if (hold) return current;
	if (!scroller) return target;
	const content = scroller.scrollHeight - current;
	const floor = Math.ceil(scroller.scrollTop + scroller.clientHeight - content) + BOTTOM_SLACK;
	return Math.max(target, Math.min(current, floor));
}

/** use-stick-to-bottom parks "at the bottom" 1px above the true end of the
 *  range; without this slack every re-measure shrank a held reserve by 1px,
 *  and the library followed it down (a slow 1px-a-step creep). */
const BOTTOM_SLACK = 2;

/** How long an armed send waits for its commit (the optimistic append is
 *  synchronous; this only bounds a send that was refused before it). */
export const SEND_SCROLL_ARM_MS = 1500;

/**
 * Armed right before a learner's input is sent; consumed by the first commit
 * whose transcript differs from the one at arm time (the optimistic append),
 * in a layout effect, after the dock's reserve for that commit is in place.
 * One scroll per send.
 */
export function createSendScroll(now: () => number = Date.now) {
	let armed: { marker: unknown; at: number } | null = null;
	return {
		arm(marker: unknown) {
			armed = { marker, at: now() };
		},
		armed: () => armed !== null,
		/** Run in the commit's layout effect (before paint). Returns what it did. */
		commit(marker: unknown, scroller: ScrollGeometry | null, scrollToBottom: (behavior: "instant" | "smooth") => void): SendScrollBehavior | null {
			if (!armed) return null;
			if (now() - armed.at > SEND_SCROLL_ARM_MS) {
				armed = null;
				return null;
			}
			if (marker === armed.marker || !scroller) return null;
			armed = null;
			const distance = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
			const behavior = sendScrollBehavior(distance, scroller.clientHeight);
			if (behavior === "instant") {
				// Before paint: the frame that shows the new message already shows
				// it in place. The library call re-locks the view to the bottom.
				scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
				scrollToBottom("instant");
			} else if (behavior === "smooth") scrollToBottom("smooth");
			return behavior;
		},
	};
}

export type SendScroll = ReturnType<typeof createSendScroll>;
