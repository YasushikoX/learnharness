/**
 * The course page's vocabulary pieces in a test DOM (WP5 — components/course-coverage.tsx): a skill's terms line opens
 * its list with each term's state, definition and page; the class-wide line opens the unassigned and flagged terms with
 * their actions; the approval screen's "Same thing" and "Leave N terms unassigned" call their actions; Norwegian labels.
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { CoverageContext, CoverageSummary, DraftCoverageReview, SkillTerms, type CoverageActions } from "../components/course-coverage.tsx";
import type { CourseCoverageView, CoverageEdit } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	host?.remove();
});

const entry = (key: string, name: string, over: Record<string, unknown> = {}) => ({ key, name, tier: "core" as const, definition: `def of ${name}`, page: 3, material: "Lecture 3.pdf", ...over });

function view(over: Partial<CourseCoverageView> = {}): CourseCoverageView {
	return {
		status: "mapped",
		mapping: false,
		language: "en",
		skills: {
			sk_rings: {
				total: 3,
				introduced: 2,
				checked: 1,
				terms: [
					{ ...entry("t_ring", "ring"), state: "checked", level: "apply", right: true },
					{ ...entry("t_ideal", "ideal"), state: "introduced" },
					{ ...entry("t_unit", "unit", { definition: null, page: 7 }), state: "new" },
				],
			},
		},
		unassigned: [entry("t_module", "module", { page: 11 })],
		flagged: [{ key: "t_group", name: "group", skills: ["sk_rings"] }],
		excluded: [],
		incomplete: [],
		...over,
	};
}

async function mount(node: React.ReactElement, value: CourseCoverageView, calls: Array<[string, unknown]>) {
	const actions: CoverageActions = {
		edit: (target, edit: CoverageEdit) => calls.push([target, edit]),
		map: () => calls.push(["map", null]),
		approveLeaving: () => calls.push(["leave", null]),
	};
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<CoverageContext.Provider value={{ view: value, skillNames: new Map([["sk_rings", "Rings"]]), draftNames: new Map([["s1", "Rings"]]), busy: false, actions }}>{node}</CoverageContext.Provider>,
		);
	});
}
const click = async (selector: string) => {
	const el = host!.querySelector(selector);
	assert.ok(el, `no ${selector}`);
	await act(async () => el!.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
};
const text = (selector: string) => host!.querySelector(selector)?.textContent ?? "";

describe("a skill's terms", () => {
	it("shows the counts, and opens the list with state, definition and page", async () => {
		await mount(<SkillTerms skillId="sk_rings" />, view(), []);
		assert.equal(text('[data-testid="skill-terms-toggle-sk_rings"]'), "Terms: 2 of 3 introduced, 1 checked");
		assert.equal(host!.querySelector('[data-testid="skill-terms-list-sk_rings"]'), null);
		await click('[data-testid="skill-terms-toggle-sk_rings"]');
		assert.equal(text('[data-testid="term-state-t_ring"]'), "checked · apply");
		assert.equal(text('[data-testid="term-state-t_ideal"]'), "introduced");
		assert.equal(text('[data-testid="term-state-t_unit"]'), "new");
		assert.match(text('[data-testid="term-t_ring"]'), /def of ring \(Lecture 3\.pdf, p\. 3\)/);
		assert.match(text('[data-testid="term-t_unit"]'), /no definition in the material \(Lecture 3\.pdf, p\. 7\)/);
	});
	it("an asked term reads 'asked about, never named', with how many lessons left it for later; Norwegian too", async () => {
		const v = view();
		v.skills.sk_rings!.terms.push({ ...entry("t_kernel", "kernel"), state: "asked", deferredCount: 2 });
		await mount(<SkillTerms skillId="sk_rings" />, v, []);
		await click('[data-testid="skill-terms-toggle-sk_rings"]');
		assert.equal(text('[data-testid="term-state-t_kernel"]'), "asked about, never named · left for later 2×");
		await act(async () => root?.unmount());
		host?.remove();
		await mount(<SkillTerms skillId="sk_rings" />, { ...v, language: "nb" }, []);
		await click('[data-testid="skill-terms-toggle-sk_rings"]');
		assert.equal(text('[data-testid="term-state-t_kernel"]'), "spurt om, aldri nevnt · utsatt 2×");
	});
	it("suggestions are accepted or dismissed one by one; the displaced list is acknowledged", async () => {
		const calls: Array<[string, unknown]> = [];
		await mount(<CoverageSummary />, view({ suggested: { excluded: [{ key: "t_ideal", name: "ideal", reason: "not examined" }], links: [{ keys: ["t_Field", "t_field"], names: ["Field", "field"] }] }, displaced: [{ key: "t_unit", name: "unit", reason: "its skill left the class map; assign it again" }] }), calls);
		await click('[data-testid="suggested-exclude-accept-t_ideal"]');
		await click('[data-testid="suggested-link-accept-t_Field~t_field"]');
		await click('[data-testid="coverage-displaced-ok"]');
		assert.deepEqual(calls, [
			["approved", { action: "exclude", key: "t_ideal", reason: "not examined" }],
			["approved", { action: "link", keys: ["t_Field", "t_field"] }],
			["approved", { action: "clear-displaced" }],
		]);
		assert.match(text('[data-testid="displaced-t_unit"]'), /unit — its skill left the class map/);
	});
	it("a skill with no terms shows nothing", async () => {
		await mount(<SkillTerms skillId="sk_other" />, view(), []);
		assert.equal(host!.innerHTML, "");
	});
});

describe("the class-wide line", () => {
	it("says how many terms are unassigned and flagged, and its actions edit the approved mapping", async () => {
		const calls: Array<[string, unknown]> = [];
		await mount(<CoverageSummary />, view(), calls);
		assert.equal(text('[data-testid="coverage-toggle"]'), "1 new term is not assigned to a skill · 1 term is no longer in the material");
		await click('[data-testid="coverage-toggle"]');
		assert.ok(host!.querySelector('[data-testid="assign-t_module"]'));
		await click('[data-testid="flagged-remove-t_group"]');
		await click('[data-testid="exclude-t_module"]');
		await click('[data-testid="exclude-ok-t_module"]');
		assert.deepEqual(calls, [
			["approved", { action: "remove", key: "t_group" }],
			["approved", { action: "exclude", key: "t_module", reason: "" }],
		]);
	});
	it("an unmapped class offers the mapping pass; a fully mapped class shows nothing; Norwegian labels", async () => {
		const calls: Array<[string, unknown]> = [];
		await mount(<CoverageSummary />, view({ status: "unmapped", skills: {}, flagged: [] }), calls);
		await click('[data-testid="coverage-map"]');
		assert.deepEqual(calls, [["map", null]]);
		await act(async () => root!.unmount());
		await mount(<CoverageSummary />, view({ unassigned: [], flagged: [] }), []);
		assert.equal(host!.innerHTML, "");
		await act(async () => root!.unmount());
		await mount(<CoverageSummary />, view({ language: "nb" }), []);
		assert.equal(text('[data-testid="coverage-toggle"]'), "1 nytt begrep er ikke knyttet til en ferdighet · 1 begrep er ikke lenger i materialet");
	});
});

describe("the approval screen", () => {
	it("links a suggested pair with 'Same thing' and approves leaving terms unassigned only when asked", async () => {
		const calls: Array<[string, unknown]> = [];
		const draft: NonNullable<CourseCoverageView["draft"]> = {
			skills: { s1: [entry("t_ring", "ring")] },
			unassigned: [entry("t_unit", "unit"), entry("t_Field", "Field")],
			excluded: [],
			duplicates: [{ a: entry("t_Field", "Field", { definition: null }), b: entry("t_field", "field"), reasons: ["similar_name"], linked: false }],
			dropped: [],
			incomplete: [],
			shown: { full: 4, names: 0, omitted: 0 },
		};
		await mount(<DraftCoverageReview />, view({ draft }), calls);
		assert.match(text('[data-testid="draft-unassigned"]'), /2 new terms are not assigned to a skill/);
		assert.match(text('[data-testid="duplicate-t_Field~t_field"]'), /Field.*no definition in the material.*field.*def of field/);
		await click('[data-testid="same-t_Field~t_field"]');
		await click('[data-testid="draft-leave-unassigned"]');
		assert.deepEqual(calls, [
			["draft", { action: "link", keys: ["t_Field", "t_field"] }],
			["leave", null],
		]);
		assert.equal(text('[data-testid="draft-leave-unassigned"]'), "Leave 2 terms unassigned");
	});
});
