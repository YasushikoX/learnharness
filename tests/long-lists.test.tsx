/**
 * Long lists in the class side panel (UI long lists, 2026-11-26; owner: "once you have a lot of files displayed they just
 * overtake that side"; "show a few and then a dropdown to show more, and the same goes for lectures"). One shared
 * ShortList (components/ui/short-list.tsx) keeps the Files, Upcoming and Lectures lists short: a few rows, then a
 * "Show all N" disclosure row; expanded, a bounded scroll with a filter once the list is long, and "Show fewer".
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { Assessment, LessonMaterial } from "../src/core/index.ts";
import type { MaterialsApi } from "../components/use-materials.tsx";
import { forgetShortLists, shortListBound, shortListView, shortRows, wholeRowsHeight, SHORT_LIST_ROWS } from "../components/ui/short-list.tsx";
import { ClassFiles, fileRows, filesCount } from "../components/class-files.tsx";
import { UpcomingList } from "../components/upcoming-list.tsx";
import { LectureList, lectureRows } from "../components/lecture-list.tsx";
import { ClassSetup, filesSummary } from "../components/class-setup.tsx";

const IN_2026 = new Date(2026, 10, 25, 12).getTime();

const material = (i: number, over: Partial<LessonMaterial> = {}): LessonMaterial => ({
	id: `mat_${i}`,
	kind: "pdf",
	name: `Lecture ${i}.pdf`,
	file: "source.pdf",
	bytes: 10,
	addedAt: new Date(Date.UTC(2026, 10, 1) + i * 3_600_000).toISOString(),
	status: "ready",
	pages: 12,
	...over,
});

/** 37 files: number 3 failed, 10, 20 and 30 still being read, the rest read. */
const semester = (): LessonMaterial[] =>
	Array.from({ length: 37 }, (_, k) => {
		const i = k + 1;
		return material(i, i === 3 ? { status: "error", error: "unreadable" } : [10, 20, 30].includes(i) ? { status: "reading" } : {});
	});

const fakeFiles = (materials: LessonMaterial[]): MaterialsApi => ({
	materials,
	draft: [],
	reading: materials.filter((m) => m.status === "reading").length,
	busy: false,
	error: null,
	clearError: () => {},
	addFiles: async () => {},
	addUrl: async () => true,
	remove: async () => {},
	pickFiles: () => {},
	camera: { available: true, open: () => {} },
	node: null,
});

const quiz = (i: number, date: string | undefined): Assessment => ({ id: `as_${i}`, kind: "quiz", title: `Quiz ${i}`, date, topics: "", skillIds: [], source: "chat", updatedAt: "2026-11-25T10:00:00.000Z" });
const lecture = (n: number) => ({ id: `l${n}`, n, title: `Lecture ${n}`, date: `2026-${n < 9 ? "10" : "11"}-${String(1 + n).padStart(2, "0")}`, topics: n === 11 ? "ATP synthase" : "", skillIds: [], source: "manual" });
const standing = (n: number, at: string | null) => ({
	lectures: Array.from({ length: n }, (_, k) => lecture(k + 1)),
	covered: at ? Array.from({ length: Number(at.slice(1)) }, (_, k) => `l${k + 1}`) : [],
	position: at ? { lectureId: at, how: "dated" } : null,
	learnedThrough: null,
	next: null,
	behind: [],
	verdict: "unknown",
	unplaced: 0,
});

const rowIds = (html: string, prefix: string) => [...html.matchAll(new RegExp(`data-testid="${prefix}([^"]+)"`, "g"))].map((m) => m[1]);

describe("which rows show (pure)", () => {
	it("collapsed: the failed file, then the files being read, then the newest; 5 rows", () => {
		const { items, preview } = fileRows(semester());
		assert.equal(items.length, 37);
		assert.equal(preview.length, SHORT_LIST_ROWS);
		assert.deepEqual(preview.slice(0, 4).map((m) => m.id), ["mat_3", "mat_30", "mat_20", "mat_10"], "failed first, then reading (newest first)");
		assert.equal(preview[4]!.status, "ready");
		assert.equal(preview[4]!.id, "mat_37", "then the most recently added");
	});

	it("every failed file stays visible, even when more than 5 failed", () => {
		const many = Array.from({ length: 20 }, (_, k) => material(k + 1, k < 7 ? { status: "error" } : {}));
		const { preview } = fileRows(many);
		assert.equal(preview.length, 7);
		assert.ok(preview.every((m) => m.status === "error"));
	});

	it("the header: count and status", () => {
		assert.equal(filesCount(0, 0), null);
		assert.equal(filesCount(37, 0), "37");
		assert.equal(filesCount(37, 3), "37 · 3 reading");
		assert.equal(filesCount(37, 3, 1), "37 · 3 reading · 1 failed");
		assert.equal(filesCount(37, 0, 1), "37 · 1 failed");
	});

	it("no toggle when it would hide fewer than two rows; the filter only past 10 rows and only expanded", () => {
		const six = Array.from({ length: 6 }, (_, i) => ({ id: String(i) }));
		const v6 = shortListView(six, six.slice(0, 5), { expanded: false, text: (x) => x.id });
		assert.equal(v6.toggles, false);
		assert.equal(v6.rows.length, 6, "6 rows: all show, no 'Show all 6' for one row");
		const eight = Array.from({ length: 8 }, (_, i) => ({ id: String(i) }));
		assert.equal(shortListView(eight, eight.slice(0, 5), { expanded: true, text: (x) => x.id }).filterable, false, "8 rows: no filter");
		const twelve = Array.from({ length: 12 }, (_, i) => ({ id: `row ${i}` }));
		assert.equal(shortListView(twelve, twelve.slice(0, 5), { expanded: false, text: (x) => x.id }).filterable, false, "collapsed: no filter");
		const filtered = shortListView(twelve, twelve.slice(0, 5), { expanded: true, query: "ROW 1", text: (x) => x.id });
		assert.ok(filtered.filterable);
		assert.deepEqual(filtered.rows.map((x) => x.id), ["row 1", "row 10", "row 11"], "case-insensitive contains");
	});

	it("the bounded area: 320 px or 40 % of the panel, cut at the last whole row", () => {
		assert.equal(shortListBound(1000), 320);
		assert.equal(shortListBound(600), 240);
		const rows = Array.from({ length: 10 }, (_, i) => [i * 44, i * 44 + 44] as const);
		assert.equal(wholeRowsHeight(rows, 320), 308, "7 rows of 44 px, not 7.27");
		assert.equal(wholeRowsHeight([[0, 400]], 320), 400, "at least the first row");
	});

	it("a window of rows, moved back at the end, keeping a row being edited", () => {
		const items = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}` }));
		assert.deepEqual(shortRows(items).preview.map((x) => x.id), ["r0", "r1", "r2", "r3", "r4"]);
		assert.deepEqual(shortRows(items, "r8").preview.map((x) => x.id), ["r0", "r1", "r2", "r3", "r4", "r8"]);
		assert.deepEqual(shortRows(items, undefined, 8, 3).preview.map((x) => x.id), ["r7", "r8", "r9"]);
	});

	it("lectures: the class's current lecture first, then the next two; with no position, the first not covered", () => {
		const s = standing(14, "l8");
		assert.deepEqual(lectureRows(s.lectures, "l8", new Set(s.covered)).preview.map((l) => l.id), ["l8", "l9", "l10"]);
		assert.equal(lectureRows(s.lectures, "l8", new Set(s.covered)).anchor, "l8", "expanded, the list scrolls to it");
		assert.deepEqual(lectureRows(s.lectures, "l14", new Set()).preview.map((l) => l.id), ["l12", "l13", "l14"], "the last lecture: still in view");
		assert.deepEqual(lectureRows(s.lectures, undefined, new Set(["l1", "l2"])).preview.map((l) => l.id), ["l3", "l4", "l5"]);
	});
});

describe("the panel's lists, rendered", () => {
	beforeEach(() => forgetShortLists());

	it("Files collapsed: 5 rows with the failed and reading first, Show all 37, the header's status, Add files above the list", () => {
		const html = renderToStaticMarkup(<ClassFiles files={fakeFiles(semester())} courseId="c1" />);
		assert.deepEqual(rowIds(html, "material-status-"), ["mat_3", "mat_30", "mat_20", "mat_10", "mat_37"]);
		assert.match(html, /data-testid="class-files-count"[^>]*>37 · 3 reading · 1 failed</);
		assert.match(html, /aria-expanded="false"[^>]*data-testid="class-files-list-toggle"[\s\S]*lucide-chevron-down[\s\S]*Show all 37/);
		assert.doesNotMatch(html, /class-files-list-filter/, "no filter collapsed");
		const add = html.indexOf("materials-add-files");
		assert.ok(add > 0 && add < html.indexOf("class-files-list") && html.indexOf("materials-camera") < html.indexOf("class-files-list") && html.indexOf("materials-link-input") < html.indexOf("class-files-list"), "Add files, Camera and Paste a link come before the list");
	});

	it("a short list has no toggle", () => {
		const html = renderToStaticMarkup(<ClassFiles files={fakeFiles([material(1), material(2), material(3)])} courseId="c1" />);
		assert.equal(rowIds(html, "material-status-").length, 3);
		assert.doesNotMatch(html, /class-files-list-toggle/);
	});

	it("Upcoming: the next 5 by date, then Show all; past ones stay behind their own toggle", () => {
		const items = [quiz(1, "2026-11-10"), ...[2, 3, 4, 5, 6, 7, 8].map((i) => quiz(i, `2026-12-${String(i).padStart(2, "0")}`)), quiz(9, undefined)];
		const html = renderToStaticMarkup(<UpcomingList courseId="c1" upcoming={{ items, finding: false }} skills={[]} canFind onChanged={() => {}} now={IN_2026} />);
		assert.deepEqual(rowIds(html, "upcoming-item-"), ["as_2", "as_3", "as_4", "as_5", "as_6"]);
		assert.match(html, /data-testid="upcoming-list-toggle"[\s\S]*Show all 8/, "8 still to come (7 dated, 1 undated)");
		assert.match(html, /data-testid="upcoming-past-toggle"[^>]*>Past · 1</);
	});

	it("Lectures: the current lecture and the two after it, then Show all 14", () => {
		const html = renderToStaticMarkup(<LectureList courseId="c1" standing={standing(14, "l8") as never} skills={[]} onChanged={() => {}} />);
		assert.deepEqual(rowIds(html, "lecture-item-"), ["l8", "l9", "l10"]);
		assert.match(html, /data-testid="lecture-here-l8"/, "the class's position is in view");
		assert.match(html, /data-testid="lecture-list-toggle"[\s\S]*Show all 14/);
	});

	it("the three lists share one component", () => {
		for (const file of ["components/class-files.tsx", "components/upcoming-list.tsx", "components/lecture-list.tsx"]) {
			const src = fs.readFileSync(file, "utf8");
			assert.match(src, /from "@\/components\/ui\/short-list"/, `${file} imports ShortList`);
			assert.match(src, /<ShortList\b/, `${file} renders ShortList`);
		}
	});

	it("the new-class checklist's step 1 shows a count, not the files", () => {
		assert.equal(filesSummary(37, 3), "37 files · reading 3");
		const html = renderToStaticMarkup(<ClassSetup files={fakeFiles(semester())} hasSkills={false} hasDraft={false} drafting={false} busy={false} onDraft={() => {}} />);
		assert.match(html, /37 files · reading 3/);
		assert.doesNotMatch(html, /data-testid="material-/);
	});
});

// ─── in a client mount ───────────────────────────────────────────────────────

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
let root: Root | undefined;
let host: HTMLDivElement | undefined;
const unmount = () => {
	act(() => root?.unmount());
	host?.remove();
	root = undefined;
};
afterEach(unmount);
const mount = async (node: React.ReactNode) => {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(node));
};
const el = (id: string) => host!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const all = (prefix: string) => Array.from(host!.querySelectorAll(`[data-testid^="${prefix}"]`));
const click = async (id: string) => {
	const node = el(id);
	assert.ok(node, `no ${id}`);
	await act(async () => node!.click());
};
const type = async (id: string, value: string) => {
	const node = el(id)!;
	const propsKey = Object.keys(node).find((k) => k.startsWith("__reactProps$"))!;
	await act(async () => (node as unknown as Record<string, { onChange: (e: unknown) => void }>)[propsKey]!.onChange({ target: { value } }));
};

describe("Show all, the filter and Show fewer, in a mount", () => {
	beforeEach(() => forgetShortLists());

	it("Show all expands in place; the filter narrows it; Show fewer collapses it again", async () => {
		await mount(<ClassFiles files={fakeFiles(semester())} courseId="c1" />);
		assert.equal(all("material-status-").length, 5);
		await click("class-files-list-toggle");
		assert.equal(all("material-status-").length, 37, "every file");
		assert.equal(el("class-files-list-toggle")!.getAttribute("aria-expanded"), "true");
		assert.match(el("class-files-list-toggle")!.textContent ?? "", /Show fewer/);
		assert.match(el("class-files-list-toggle")!.innerHTML, /rotate-180/, "the chevron turns");
		assert.ok(el("class-files-list-rows")!.className.includes("lh-short-list-area"), "the expanded list scrolls in its own bounded area");
		const filter = el("class-files-list-filter")!;
		assert.equal(filter.getAttribute("placeholder"), "Filter files");
		await type("class-files-list-filter", "lecture 1");
		assert.deepEqual(
			all("material-status-").map((n) => n.getAttribute("data-testid")!.slice("material-status-".length)),
			["mat_10", "mat_19", "mat_18", "mat_17", "mat_16", "mat_15", "mat_14", "mat_13", "mat_12", "mat_11", "mat_1"],
			"Lecture 1, 10–19 (reading first, then newest)",
		);
		await type("class-files-list-filter", "nothing like it");
		assert.match(el("class-files-list-no-match")!.textContent ?? "", /No files match/);
		await click("class-files-list-toggle");
		assert.equal(all("material-status-").length, 5);
		assert.equal(el("class-files-list-filter"), null);
		assert.match(el("class-files-list-toggle")!.textContent ?? "", /Show all 37/);
	});

	it("expanded or collapsed is remembered per class for the session", async () => {
		await mount(<ClassFiles files={fakeFiles(semester())} courseId="c1" />);
		await click("class-files-list-toggle");
		unmount();
		await mount(<ClassFiles files={fakeFiles(semester())} courseId="c1" />);
		assert.equal(all("material-status-").length, 37, "the same class: still expanded");
		unmount();
		await mount(<ClassFiles files={fakeFiles(semester())} courseId="c2" />);
		assert.equal(all("material-status-").length, 5, "another class: collapsed");
	});

	it("the lectures list expands to the whole timeline", async () => {
		await mount(<LectureList courseId="c1" standing={standing(14, "l8") as never} skills={[]} onChanged={() => {}} />);
		assert.equal(all("lecture-item-").length, 3);
		await click("lecture-list-toggle");
		assert.equal(all("lecture-item-").length, 14);
		await type("lecture-list-filter", "atp");
		assert.deepEqual(all("lecture-item-").map((n) => n.getAttribute("data-testid")), ["lecture-item-l11"], "the filter reads the topics too");
	});
});
