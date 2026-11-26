import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createSendScroll, nextDockReserve, SEND_SCROLL_ARM_MS, sendScrollBehavior } from "../components/send-scroll.ts";

// A model of the transcript scroller (no layout engine here): the scroll
// range is the transcript plus the dock's reserve (the spacer), and the
// browser clamps scrollTop into it. `commit` is one React commit as chat.tsx
// runs it: the new rows and the dock's re-measure land together (DockOverlay's
// layout effect, its offer writing the spacer), then the Chat's layout effect
// runs the send scroll, then the frame paints. A painted log of scrollTop is
// what the learner sees.
class Scroller {
	painted: number[] = [];
	scrolls: string[] = [];
	private top = 0;
	constructor(public content: number, public reserve: number, public clientHeight: number) {}
	get scrollHeight() { return this.content + this.reserve; }
	get scrollTop() { return this.top; }
	set scrollTop(value: number) { this.top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); }
	/** The browser re-clamps after a layout change. */
	clamp() { this.scrollTop = this.top; }
	paint() { this.painted.push(this.top); }
	/** Where use-stick-to-bottom parks the view: 1px above the end. */
	toLibraryBottom() { this.scrollTop = this.scrollHeight - this.clientHeight - 1; }
}

function offer(s: Scroller, target: number, hold = false) {
	s.reserve = nextDockReserve({ target, current: s.reserve, hold, scroller: s });
	s.clamp();
}

function commit(s: Scroller, send: ReturnType<typeof createSendScroll>, marker: object, change: { grow?: number; dockTarget?: number; hold?: boolean }) {
	s.content += change.grow ?? 0;
	s.clamp();
	if (change.dockTarget !== undefined) offer(s, change.dockTarget, change.hold);
	send.commit(marker, s, (behavior) => {
		s.scrolls.push(behavior);
		// The library's smooth scroll starts next frame; its instant one only
		// re-locks (the controller already moved the view before paint).
		if (behavior === "instant") s.scrollTop = s.scrollHeight - s.clientHeight;
	});
	s.paint();
}

/** Play the library's smooth scroll: monotonic steps to the bottom. */
function smoothToBottom(s: Scroller) {
	for (let guard = 0; guard < 100 && s.scrollTop < s.scrollHeight - s.clientHeight - 1; guard++) {
		s.scrollTop += Math.max(1, (s.scrollHeight - s.clientHeight - s.scrollTop) * 0.2);
		s.paint();
	}
}

function assertNeverBackward(painted: number[]) {
	for (let i = 1; i < painted.length; i++) {
		assert.ok(painted[i]! >= painted[i - 1]! - 0.001, `scrollTop moved back from ${painted[i - 1]} to ${painted[i]} (frame ${i}): ${painted.join(", ")}`);
	}
}

test("a long way is a jump, a short way is smooth, no way is nothing", () => {
	assert.equal(sendScrollBehavior(0, 850), "none");
	assert.equal(sendScrollBehavior(1, 850), "none");
	assert.equal(sendScrollBehavior(180, 850), "smooth");
	assert.equal(sendScrollBehavior(850, 850), "smooth");
	assert.equal(sendScrollBehavior(851, 850), "instant");
	assert.equal(sendScrollBehavior(1300, 850), "instant");
});

test("send at the bottom: the row and the reserve land in one commit, then ONE smooth scroll, never backward", () => {
	// The lesson at 1440 (measured): content 1864, composer two lines (reserve 155), viewport 852.
	const s = new Scroller(1864, 155, 852);
	s.toLibraryBottom();
	s.paint();
	const send = createSendScroll();
	const before = {}, after = {};
	send.arm(before);
	// The optimistic row (+179) commits; the composer still holds the text until the server accepts.
	commit(s, send, after, { grow: 179, dockTarget: 155 });
	assert.deepEqual(s.scrolls, ["smooth"]);
	// The commit's paint already holds the new row below and the unchanged view.
	assert.equal(s.scrollHeight, 1864 + 179 + 155);
	smoothToBottom(s);
	// Acceptance clears the composer later (-19px): at the bottom the reserve is held, the view does not move down.
	const atBottom = s.scrollTop;
	commit(s, send, {}, { dockTarget: 136 });
	assert.equal(s.scrollTop, atBottom);
	assert.equal(s.reserve, 155);
	// The reply streams in: the held space is given back as it fills, still without moving the view back.
	s.content += 40; offer(s, 136); s.paint();
	assert.equal(s.reserve, 136);
	assertNeverBackward(s.painted);
	assert.deepEqual(s.scrolls, ["smooth"], "exactly one scroll for one send");
});

test("send while scrolled up: one jump, straight to the new row, in the same commit", () => {
	const s = new Scroller(2064, 155, 852);
	s.scrollTop = 148; // the learner was reading ~1200px up
	s.paint();
	const send = createSendScroll();
	const before = {};
	send.arm(before);
	commit(s, send, {}, { grow: 179, dockTarget: 155 });
	assert.deepEqual(s.scrolls, ["instant"]);
	// The first painted frame with the row already shows it at the bottom.
	assert.equal(s.painted.at(-1), s.scrollHeight - s.clientHeight);
	assertNeverBackward(s.painted);
});

test("a question answered at the bottom of a short session: the reserve holds, the card drops in, nothing moves back", () => {
	// Measured: the quiz session at 1440 (content 384, the question dock's reserve 580, viewport 852).
	const s = new Scroller(384, 580, 852);
	s.toLibraryBottom();
	s.paint();
	const send = createSendScroll();
	send.arm({});
	// The answer commits: its card (+404) mounts and the dock becomes the composer (target 136) in the same commit.
	commit(s, send, {}, { grow: 404, dockTarget: 136 });
	assert.ok(s.reserve > 136, "the reserve may not shrink out from under the reader");
	// Re-measures while the dock's morph runs do not creep (the library parks 1px above the end).
	for (let i = 0; i < 5; i++) { offer(s, 136); s.toLibraryBottom(); s.paint(); }
	assertNeverBackward(s.painted);
	// The reply fills the held space; the reserve reaches its target without moving the view.
	s.content += 300; offer(s, 136); s.paint();
	assert.equal(s.reserve, 136);
	assertNeverBackward(s.painted);
	assert.ok(s.scrolls.length <= 1);
});

test("the old rule (reserve = target at once) is what moved the transcript back", () => {
	const s = new Scroller(384, 580, 852);
	s.toLibraryBottom();
	const was = s.scrollTop;
	s.content += 404; s.reserve = 136; s.clamp();
	assert.ok(s.scrollTop < was, "a naive shrink clamps the view down");
});

test("the reserve: grows at once, holds while a question owns the dock, shrinks freely when the reader is up the page", () => {
	const far = { scrollTop: 100, clientHeight: 800, scrollHeight: 3000 };
	assert.equal(nextDockReserve({ target: 300, current: 136, hold: false, scroller: far }), 300);
	assert.equal(nextDockReserve({ target: 136, current: 580, hold: true, scroller: far }), 580);
	assert.equal(nextDockReserve({ target: 136, current: 580, hold: false, scroller: far }), 136);
	assert.equal(nextDockReserve({ target: 136, current: 580, hold: false, scroller: null }), 136);
	// Near the bottom it shrinks only by the distance that is left below the view.
	const near = { scrollTop: 2000 - 800 - 50, clientHeight: 800, scrollHeight: 2000 };
	assert.equal(nextDockReserve({ target: 100, current: 200, hold: false, scroller: near }), 200 - 50 + 2);
});

test("the send scroll is consumed once, by the first commit that changes the transcript", () => {
	let clock = 0;
	const send = createSendScroll(() => clock);
	const s = new Scroller(2000, 136, 800);
	s.scrollTop = 0;
	const calls: string[] = [];
	const marker = {};
	send.arm(marker);
	// A commit that did not change the transcript (the composer re-rendering) leaves it armed.
	assert.equal(send.commit(marker, s, (b) => calls.push(b)), null);
	assert.equal(send.armed(), true);
	assert.equal(send.commit({}, s, (b) => calls.push(b)), "instant");
	assert.equal(send.armed(), false);
	assert.equal(send.commit({}, s, (b) => calls.push(b)), null);
	assert.deepEqual(calls, ["instant"]);
	// A send refused before its row landed expires: a much later transcript change is not a send.
	send.arm(marker);
	clock += SEND_SCROLL_ARM_MS + 1;
	assert.equal(send.commit({}, s, (b) => calls.push(b)), null);
	assert.deepEqual(calls, ["instant"]);
});

test("every transcript row remembers its real height, so becoming an older row does not resize it", () => {
	const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
	const rule = (selector: string) => css.match(new RegExp(`${selector.replace(/[[\]-]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
	assert.match(rule("[data-transcript-row]"), /contain-intrinsic-block-size:\s*auto 800px/);
	assert.match(rule("[data-older-transcript-row]"), /content-visibility:\s*auto/);
	assert.doesNotMatch(rule("[data-older-transcript-row]"), /contain-intrinsic/);
	const chat = readFileSync(new URL("../components/chat.tsx", import.meta.url), "utf8");
	for (const row of chat.matchAll(/data-older-transcript-row=/g)) {
		const around = chat.slice(Math.max(0, row.index - 200), row.index);
		assert.match(around, /data-transcript-row=""/, "an older row must also carry data-transcript-row");
	}
});
