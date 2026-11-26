/**
 * UI round 8 (2026-11-25; council/ui/SPEC.md §9 "Small surfaces and states"): the shared rules as code. The one
 * on-screen date (core/dates.ts), the error notice's plain sentence and Try again (components/ui/error-notice.tsx), the
 * unsaved-edit guard of the inline forms (components/use-unsaved-guard.ts), the inline confirm before a delete
 * (components/ui/inline-confirm.tsx) wired into the Upcoming and lecture forms, and the new class's setup card (its name
 * field, no side panel). Pure where it can be; the forms in a real client mount (linkedom + react-dom).
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { dayLabel, dayMonthLabel, relativeDays, weekdayLabel, type Assessment, type UpcomingView } from "../src/core/index.ts";
import { ErrorNotice, plainError } from "../components/ui/error-notice.tsx";
import { formDirty, requestSwitch } from "../components/use-unsaved-guard.ts";
import { InlineConfirm } from "../components/ui/inline-confirm.tsx";
import { kindSubtitle, suggestTitle, UpcomingList, whenLabel } from "../components/upcoming-list.tsx";
import { LectureList, nextLectureNumber } from "../components/lecture-list.tsx";
import { ClassNameField, ClassSetup } from "../components/class-setup.tsx";
import { examDaysLine } from "../components/today-page.tsx";
import { todayHead } from "../components/today-section.tsx";
import { priceLabel } from "../components/settings/model-menu.tsx";

const IN_2026 = new Date(2026, 10, 25, 12).getTime();

describe("the one on-screen date (SPEC §9)", () => {
	it("is 'Fri 27 Nov' this year and adds the year only in another", () => {
		assert.equal(dayLabel("2026-11-27", IN_2026), "Fri 27 Nov");
		assert.equal(dayLabel("2027-01-05", IN_2026), "Tue 5 Jan 2027");
		assert.equal(dayLabel("2025-12-31", IN_2026), "Wed 31 Dec 2025");
	});
	it("reads an ISO timestamp by its calendar day and leaves a non-date alone", () => {
		assert.equal(dayLabel("2026-11-25T23:30:00.000Z", IN_2026), "Wed 25 Nov");
		assert.equal(dayLabel("soon", IN_2026), "soon");
		assert.equal(dayMonthLabel("2027-01-05"), "Tue 5 Jan", "the prefix form never has a year");
		assert.equal(weekdayLabel("2026-11-27"), "Fri");
		assert.equal(dayLabel("2026-09-20", IN_2026), "Sun 20 Sep", "fixed month names: never the ICU's \"Sept\"");
	});
	it("spells relative days out", () => {
		assert.deepEqual([0, 1, -1, 10, -3].map(relativeDays), ["today", "tomorrow", "yesterday", "in 10 days", "3 days ago"]);
	});
	it("Today and the sidebar name the assessment, not 'the exam' (shooter #20)", () => {
		assert.equal(examDaysLine(1, "Quiz 3"), "1 day to Quiz 3");
		assert.equal(examDaysLine(0, "Quiz 3"), "Quiz 3 today");
		assert.equal(examDaysLine(15), "15 days to the exam", "the old single exam date keeps its name");
		assert.equal(examDaysLine(-2), "exam passed");
		assert.equal(examDaysLine(undefined), null);
		assert.equal(todayHead({ title: "Biology", daysLeft: 0, examTitle: "Quiz 3" }), "Biology · Quiz 3 today");
		assert.equal(todayHead({ title: "A", daysLeft: 0 }), "A · exam today");
	});
	it("prices have two decimals and spaces around the slash (shooter #11)", () => {
		assert.equal(priceLabel({ input: 0.1, output: 0.5, cacheRead: 0, cacheWrite: 0 } as never), "$0.10\u2009/\u2009$0.50", "thin spaces around the slash");
		assert.equal(priceLabel({ input: 1, output: 5, cacheRead: 0, cacheWrite: 0 } as never), "$1.00\u2009/\u2009$5.00");
		assert.equal(priceLabel(undefined as never), "Unpriced");
	});
});

describe("the error notice (SPEC §9)", () => {
	it("maps raw provider text to one plain sentence and keeps the raw text as its detail", () => {
		assert.deepEqual(plainError("429 rate limited: the provider asks to wait 40 s", "Couldn't weigh the exams."), {
			sentence: "Couldn't weigh the exams. The provider is busy; try again in 40 seconds.",
			detail: "429 rate limited: the provider asks to wait 40 s",
		});
		assert.equal(plainError("the request timed out after 120 s").sentence, "The model took too long to answer.");
		assert.equal(plainError("the model's reply was cut off before it listed any dates").sentence, "The model's reply was cut off.");
		assert.equal(plainError("Failed to fetch").sentence, "The app could not reach the server.");
		assert.equal(plainError("401 invalid api key").sentence, "The provider refused the request; check the key in Settings → Providers.");
	});
	it("an unknown failure: the job's sentence with the raw text below, or the raw text as a sentence", () => {
		assert.deepEqual(plainError("no model", "Couldn't find quizzes and exams."), { sentence: "Couldn't find quizzes and exams.", detail: "no model" });
		assert.deepEqual(plainError("no model"), { sentence: "No model.", detail: null });
	});
	it("renders an alert with the icon, the sentence, the detail and Try again only when retrying makes sense", () => {
		const html = renderToStaticMarkup(<ErrorNotice error="429 rate limited" what="Couldn't draft the skill map." onRetry={() => {}} testid="n" />);
		assert.match(html, /role="alert"[^>]*data-testid="n"[\s\S]*lucide-circle-alert[\s\S]*Couldn&#x27;t draft the skill map\. The provider is busy right now; try again in a moment\.[\s\S]*data-testid="n-detail"[^>]*>429 rate limited<[\s\S]*data-testid="n-retry"[^>]*>Try again</);
		assert.doesNotMatch(renderToStaticMarkup(<ErrorNotice error="x" testid="n" />), /n-retry/, "no retry offered: no button");
		assert.match(renderToStaticMarkup(<ErrorNotice error="x" onRetry={() => {}} retrying testid="n" />), /<button[^>]*disabled=""[^>]*data-testid="n-retry"/, "a running retry is disabled");
	});
});

describe("the unsaved-edit guard (SPEC §9)", () => {
	it("a form is dirty when a field differs (whitespace aside) or a list changed", () => {
		const a = { title: "Quiz 3", date: "", skillIds: ["x"], allSkills: false };
		assert.equal(formDirty(a, { ...a }), false);
		assert.equal(formDirty(a, { ...a, title: " Quiz 3 " }), false);
		assert.equal(formDirty(a, { ...a, title: "Quiz 4" }), true);
		assert.equal(formDirty(a, { ...a, skillIds: ["x", "y"] }), true);
		assert.equal(formDirty(a, { ...a, allSkills: true }), true);
	});
	it("switching from a clean form is immediate; from a dirty one it waits for the answer", () => {
		assert.deepEqual(requestSwitch({ open: null, pending: undefined }, "a", false), { open: "a", pending: undefined });
		assert.deepEqual(requestSwitch({ open: "a", pending: undefined }, "b", false), { open: "b", pending: undefined });
		assert.deepEqual(requestSwitch({ open: "a", pending: undefined }, "b", true), { open: "a", pending: "b" });
		assert.deepEqual(requestSwitch({ open: "a", pending: undefined }, null, true), { open: "a", pending: null }, "closing asks too");
		assert.deepEqual(requestSwitch({ open: "a", pending: "b" }, "a", true), { open: "a", pending: undefined }, "the same row: nothing to ask");
	});
});

describe("the inline confirm (SPEC §9)", () => {
	it("one question, the safe answer first, the danger fill on the final action only", () => {
		const html = renderToStaticMarkup(<InlineConfirm question="Delete Quiz 3?" confirmLabel="Delete quiz" onConfirm={() => {}} onCancel={() => {}} testid="c" />);
		assert.match(html, /role="group"[^>]*aria-label="Delete Quiz 3\?"[\s\S]*Delete Quiz 3\?[\s\S]*data-testid="c-cancel"[^>]*>Cancel<[\s\S]*bg-\[#dc2626\][^"]*"[^>]*data-testid="c-confirm"[^>]*>Delete quiz</);
	});
});

describe("the inline forms (SPEC §9)", () => {
	it("label each field, hint with 'e.g.' and the next number, and drop a repeated kind", () => {
		const items = [{ kind: "quiz", title: "Quiz 3" }, { kind: "quiz", title: "Quiz 1" }] as Assessment[];
		assert.equal(suggestTitle("quiz", items), "e.g. Quiz 4");
		assert.equal(suggestTitle("midterm", items), "e.g. Midterm 1");
		assert.equal(suggestTitle("final", items), "e.g. Final exam");
		assert.equal(kindSubtitle({ kind: "exam", title: "Exam" }), null, "'Exam / Exam' says it once");
		assert.equal(kindSubtitle({ kind: "quiz", title: "Quiz 3" }), "Quiz");
		assert.equal(whenLabel("2026-12-04", IN_2026), "Fri 4 Dec · in 9 days");
		assert.equal(whenLabel(undefined, IN_2026), "no date");
		assert.equal(nextLectureNumber([{ n: 3 }, { n: undefined }, { n: 6 }]), 7);
	});
});

// ─── the forms in a client mount ─────────────────────────────────────────────

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	self: globalThis,
});
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
	root = undefined;
	globalThis.fetch = originalFetch;
});
const mount = async (node: React.ReactNode) => {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(node));
};
const el = (id: string) => host!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const click = async (id: string) => {
	const node = el(id);
	assert.ok(node, `no ${id}`);
	await act(async () => node!.click());
};
// linkedom does not carry an input's event into React's onChange: call the change handler as React would (as dock-steer does)
const type = async (id: string, value: string) => {
	const node = el(id)!;
	const propsKey = Object.keys(node).find((k) => k.startsWith("__reactProps$"))!;
	await act(async () => (node as unknown as Record<string, { onChange: (e: unknown) => void }>)[propsKey]!.onChange({ target: { value } }));
};

const quiz = (over: Partial<Assessment> = {}): Assessment => ({ id: "as_1", kind: "quiz", title: "Quiz 3", date: "2026-12-04", topics: "", skillIds: [], source: "chat", updatedAt: "2026-11-25T10:00:00.000Z", ...over });
const upcoming = (items: Assessment[]): UpcomingView => ({ items, finding: false });

describe("the Upcoming form in a mount", () => {
	it("Delete asks first and sends nothing until the second click", async () => {
		const calls: string[] = [];
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			calls.push(`${init?.method ?? "GET"} ${url}`);
			return new Response("{}", { status: 200 });
		}) as typeof fetch;
		await mount(<UpcomingList courseId="c1" upcoming={upcoming([quiz()])} skills={[]} canFind onChanged={() => {}} now={IN_2026} />);
		await click("upcoming-item-as_1");
		assert.ok(el("upcoming-form-as_1"), "the edit form opened");
		assert.match(el("upcoming-form-as_1")!.textContent ?? "", /Kind[\s\S]*Title[\s\S]*Date[\s\S]*What it covers/, "a label above every field");
		await click("upcoming-form-as_1-delete");
		assert.equal(calls.length, 0, "the first click only asks");
		assert.match(el("upcoming-form-as_1-delete-confirm")!.textContent ?? "", /Delete Quiz 3\?/);
		await click("upcoming-form-as_1-delete-confirm-cancel");
		assert.equal(el("upcoming-form-as_1-delete-confirm"), null, "Cancel keeps the form");
		await click("upcoming-form-as_1-delete");
		await click("upcoming-form-as_1-delete-confirm-confirm");
		assert.deepEqual(calls, ["DELETE /api/courses/c1/assessments/as_1"]);
	});

	it("an edited form asks before the list opens another row; Keep editing keeps the draft, Discard moves on", async () => {
		await mount(<UpcomingList courseId="c1" upcoming={upcoming([quiz(), quiz({ id: "as_2", title: "Quiz 4", date: "2026-12-11" })])} skills={[]} canFind onChanged={() => {}} now={IN_2026} />);
		await click("upcoming-item-as_1");
		// a clean form switches straight away
		await click("upcoming-item-as_2");
		assert.ok(el("upcoming-form-as_2") && !el("upcoming-form-as_1"), "clean: switched");
		await type("upcoming-form-as_2-title", "Quiz 4 (retake)");
		await click("upcoming-item-as_1");
		assert.ok(el("upcoming-form-as_2"), "dirty: still open");
		assert.ok(el("upcoming-form-as_2-discard"), "Discard changes? is asked");
		await click("upcoming-form-as_2-discard-cancel");
		assert.equal(el("upcoming-form-as_2-title")!.getAttribute("value") ?? (el("upcoming-form-as_2-title") as HTMLInputElement).value, "Quiz 4 (retake)", "Keep editing keeps the draft");
		assert.equal(el("upcoming-form-as_2-discard"), null);
		await click("upcoming-add");
		await click("upcoming-form-as_2-discard-confirm");
		assert.ok(el("upcoming-form-new") && !el("upcoming-form-as_2"), "Discard goes where the learner asked");
	});
});

describe("the lecture form in a mount", () => {
	it("Remove asks first", async () => {
		const calls: string[] = [];
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			calls.push(`${init?.method ?? "GET"} ${url}`);
			return new Response("{}", { status: 200 });
		}) as typeof fetch;
		const standing = { lectures: [{ id: "l1", n: 1, title: "Lecture 1", date: "2026-11-03", topics: "", skillIds: [], source: "manual" }], covered: [], position: null, learnedThrough: null, next: null, behind: [], verdict: null, unplaced: 0 };
		await mount(<LectureList courseId="c1" standing={standing as never} skills={[]} onChanged={() => {}} />);
		await click("lecture-item-l1");
		assert.match(el("lecture-form-l1")!.textContent ?? "", /Number[\s\S]*Title[\s\S]*Date[\s\S]*What it covers/);
		await click("lecture-form-l1-delete");
		assert.equal(calls.length, 0);
		await click("lecture-form-l1-delete-confirm-confirm");
		assert.deepEqual(calls, ["DELETE /api/courses/c1/lectures/l1"]);
	});
});

describe("the new class (owner, 2026-11-25)", () => {
	it("the setup card holds a labelled name field above step 1 and the footer's Delete class…", () => {
		const html = renderToStaticMarkup(
			<ClassSetup
				hasSkills={false}
				hasDraft={false}
				drafting={false}
				busy={false}
				onDraft={() => {}}
				nameField={<ClassNameField value="" onChange={() => {}} onCommit={() => {}} onReset={() => {}} saved={false} autoFocus />}
				footer={<button type="button" data-testid="course-delete">Delete class…</button>}
			/>,
		);
		assert.match(html, /data-testid="setup-name"[\s\S]*Class name[\s\S]*<input[^>]*placeholder="e\.g\. Linear Algebra"[^>]*data-testid="setup-name-input"[^>]*class="[^"]*h-9[\s\S]*data-testid="class-setup-steps"[\s\S]*data-testid="course-delete"/);
		assert.match(renderToStaticMarkup(<ClassNameField value="Biology" onChange={() => {}} onCommit={() => {}} onReset={() => {}} saved />), /data-testid="setup-name-saved"[^>]*>[\s\S]*Saved/);
	});
	it("a failed draft shows one notice with Try again, and the running draft is its own disabled button", () => {
		const failed = renderToStaticMarkup(<ClassSetup materialCount={1} hasSkills={false} hasDraft={false} drafting={false} courseError="the request timed out after 120 s" busy={false} onDraft={() => {}} />);
		assert.match(failed, /data-testid="setup-error"[\s\S]*Couldn&#x27;t draft the skill map\. The model took too long to answer\.[\s\S]*data-testid="setup-error-retry"[^>]*>Try again</);
		assert.doesNotMatch(failed, /Drafting failed/);
		const running = renderToStaticMarkup(<ClassSetup materialCount={1} hasSkills={false} hasDraft={false} drafting busy={false} onDraft={() => {}} />);
		assert.match(running, /<button[^>]*disabled=""[^>]*aria-busy="true"[^>]*data-testid="setup-drafting"[^>]*>[\s\S]*Drafting the skill map…/);
	});
});
