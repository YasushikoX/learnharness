/**
 * Vocabulary coverage, the items (WP5 — core/coverage-items.ts): the glossary's duplicate pairs, the planner's bounded
 * input, its output checked against the real glossary, the approval check and its "leave unassigned" path,
 * reconciliation after a re-index, and the student's edits. Pure: no disk, no model.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyCoverageEdit,
	approveCoverage,
	draftCoverageFrom,
	itemKey,
	normalizeLinks,
	parseCoverageEdit,
	parseItemKey,
	plannerGlossaryBlock,
	PLANNER_GLOSSARY_BUDGET,
	resolveCoverage,
} from "../src/core/coverage-items.ts";
import { glossaryOf, term } from "./coverage-fixtures.ts";

const LEC = { id: "mat_lec", name: "Lecture 3.pdf" };
const BOOK = { id: "mat_book", name: "Book.pdf" };

const base = (incomplete: Array<{ name: string; reason?: string }> = []) =>
	glossaryOf([
		{
			material: LEC,
			terms: [
				term("entropy", { page: 4, def: "the expected information of a source" }),
				term("Entropy", { page: 2, def: null }),
				term("OLS", { page: 6, aliases: ["ordinary least squares"] }),
				term("ordinary least squares", { page: 6 }),
				term("kernel", { page: 3, def: "the null space of a map", more: [{ page: 9, def: "a weight function in a smoother" }] }),
				term("bit", { page: 1, tier: "supporting", def: null }),
			],
		},
	], incomplete);

describe("the glossary keeps each duplicate group's pairs and their reasons", () => {
	it("a chained group lists its pairs, so two names never suggested together are told apart", () => {
		const g = glossaryOf([{ material: LEC, terms: [term("resistor"), term("resistors"), term("Resistors")] }]);
		assert.deepEqual(g.suggestedDuplicates, [
			{
				ids: ["t_Resistors", "t_resistor", "t_resistors"],
				reasons: ["plural", "similar_name"],
				pairs: [
					{ ids: ["t_Resistors", "t_resistor"], reasons: ["plural"] },
					{ ids: ["t_Resistors", "t_resistors"], reasons: ["similar_name"] },
					{ ids: ["t_resistor", "t_resistors"], reasons: ["plural"] },
				],
			},
		]);
	});
	it("an alias pair carries the alias reason", () => {
		const pairs = base().suggestedDuplicates.flatMap((d) => d.pairs);
		assert.ok(pairs.some((p) => p.ids.join() === "t_OLS,t_ordinary_least_squares" && p.reasons.includes("alias")), JSON.stringify(pairs));
		assert.ok(pairs.some((p) => p.ids.join() === "t_Entropy,t_entropy" && p.reasons.includes("similar_name")));
	});
});

describe("item keys", () => {
	it("a sense key round-trips; an entry id is its own key", () => {
		assert.equal(itemKey({ entryId: "t_kernel" }), "t_kernel");
		const k = itemKey({ entryId: "t_kernel", sense: { materialId: "mat_lec", page: 9 } });
		assert.equal(k, "t_kernel#mat_lec:9");
		assert.deepEqual(parseItemKey(k), { entryId: "t_kernel", sense: { materialId: "mat_lec", page: 9 } });
		assert.equal(parseItemKey("t_kernel#nonsense"), null);
	});
});

describe("the planner's glossary input", () => {
	it("lists core entries with id, definition or 'no definition', pages, the pairs with reasons, and incomplete materials", () => {
		const g = base([{ name: "Week 4.pdf", reason: "outdated" }]);
		const block = plannerGlossaryBlock(g)!;
		assert.match(block.text, /- t_entropy :: entropy — "the expected information of a source" \(p\. 4\)/);
		assert.match(block.text, /- t_Entropy :: Entropy — no definition in the material/);
		assert.match(block.text, /p\. 4 in Lecture 3\.pdf \[mat_lec\]/);
		assert.match(block.text, /- t_Entropy \(Entropy\) ~ t_entropy \(entropy\): similar name/);
		assert.match(block.text, /t_OLS \(OLS\) ~ t_ordinary_least_squares \(ordinary least squares\): alias/);
		assert.match(block.text, /index is incomplete[^\n]*Week 4\.pdf \(outdated\)/);
		assert.doesNotMatch(block.text, /t_bit/, "supporting entries are not listed");
		assert.deepEqual(block.shown, { full: 5, names: 0, omitted: 0 });
	});

	it("800 core entries: definitions until the first budget, then names only, then counted and not listed — bounded", () => {
		const many = Array.from({ length: 800 }, (_, i) => term(`concept number ${i}`, { page: 1 + (i % 300), def: `a fairly long definition of concept ${i} that runs on for a while to look like a real one from a slide deck` }));
		const g = glossaryOf([{ material: BOOK, terms: many }]);
		const block = plannerGlossaryBlock(g)!;
		assert.ok(block.text.length <= PLANNER_GLOSSARY_BUDGET + 2_000, `${block.text.length} characters`);
		assert.equal(block.shown.full + block.shown.names + block.shown.omitted, 800);
		assert.ok(block.shown.full > 50 && block.shown.full < 300, JSON.stringify(block.shown));
		assert.ok(block.shown.names > 300, JSON.stringify(block.shown));
		// a tighter budget leaves some out, and says so
		const tight = plannerGlossaryBlock(g, 20_000, 8_000)!;
		assert.ok(tight.shown.omitted > 0);
		assert.match(tight.text, new RegExp(`\\(${tight.shown.omitted} more core entries not listed\\)`));
		assert.match(tight.text, /they will show as unassigned at approval/);
	});

	it("no core entry: no block (no coverage behaviour)", () => {
		assert.equal(plannerGlossaryBlock(glossaryOf([{ material: LEC, terms: [term("bit", { tier: "supporting" })] }])), null);
		assert.equal(plannerGlossaryBlock(null), null);
	});
});

describe("the planner's output, checked against the real glossary", () => {
	const shown = { full: 5, names: 0, omitted: 0 };
	it("drops and reports unknown ids, allows an entry under two skills, keeps exclusions and links, leaves the rest unassigned", () => {
		const g = base();
		const d = draftCoverageFrom(
			{
				skills: [
					{ key: "s1", terms: ["t_entropy", "t_kernel#mat_lec:3", "t_invented", " t_OLS "] },
					{ key: "s2", terms: ["t_entropy", "t_kernel#mat_lec:9", "t_kernel#mat_lec:77"] },
				],
				excludeTerms: [{ id: "t_Entropy", reason: "the heading form" }, { id: "t_ghost", reason: "x" }, { id: "t_entropy", reason: "ignored: assigned wins" }],
				linkTerms: [["t_OLS", "t_ordinary_least_squares"], ["t_nothing", "t_entropy"]],
			},
			g,
			shown,
		);
		assert.deepEqual(d.dropped, ["t_ghost", "t_invented", "t_kernel#mat_lec:77", "t_nothing"]);
		const by = new Map(d.items.map((i) => [itemKey(i), i]));
		assert.deepEqual(by.get("t_entropy")!.skills, ["s1", "s2"]);
		assert.equal(by.get("t_entropy")!.excluded, undefined, "assigned wins over excluded");
		assert.equal(by.get("t_Entropy")!.excluded, "the heading form");
		assert.deepEqual(by.get("t_kernel#mat_lec:3")!.skills, ["s1"]);
		assert.deepEqual(by.get("t_kernel#mat_lec:9")!.skills, ["s2"]);
		assert.deepEqual(d.links, [["t_OLS", "t_ordinary_least_squares"]]);
		// the linked name the planner did not map takes its group's mapping
		assert.deepEqual(by.get("t_ordinary_least_squares")!.skills, ["s1"]);
		// "kernel" as a whole entry has sense items only: it counts as covered
		const resolved = resolveCoverage(d, g, null);
		assert.deepEqual(resolved.unassigned.map((e) => e.id), []);
	});

	it("a core entry in neither list is unassigned", () => {
		const d = draftCoverageFrom({ skills: [{ key: "s1", terms: ["t_entropy"] }] }, base(), shown);
		assert.deepEqual(resolveCoverage(d, base(), null).unassigned.map((e) => e.id).sort(), ["t_Entropy", "t_OLS", "t_kernel", "t_ordinary_least_squares"]);
	});
});

describe("approval", () => {
	const draft = { items: [{ entryId: "t_entropy", name: "entropy", skills: ["s1"] }], links: [] };
	const idOf = (k: string) => ({ s1: "sk_1" })[k];
	it("refuses with the unassigned core entries listed", () => {
		const out = approveCoverage(draft, idOf, base(), null, "2026-11-25T00:00:00Z");
		assert.equal(out.ok, false);
		assert.deepEqual(!out.ok && out.unassigned.map((e) => e.term).sort(), ["Entropy", "OLS", "kernel", "ordinary least squares"]);
	});
	it("leaving them unassigned excludes each with the reason, and resolves draft keys to skill ids", () => {
		const out = approveCoverage(draft, idOf, base(), "left out at approval", "2026-11-25T00:00:00Z");
		assert.ok(out.ok);
		const items = out.ok ? out.coverage.items : [];
		assert.deepEqual(items.find((i) => i.entryId === "t_entropy"), { entryId: "t_entropy", name: "entropy", skills: ["sk_1"] });
		const left = items.filter((i) => i.leftAtApproval);
		assert.equal(left.length, 4);
		assert.ok(left.every((i) => i.excluded === "left out at approval"));
		assert.deepEqual(resolveCoverage(out.ok ? out.coverage : draft, base(), new Set(["sk_1"])).unassigned, []);
	});
});

describe("reconciliation after a re-index (read-time, nothing written)", () => {
	it("a removed entry is flagged, a renamed one is flagged plus a new unassigned one, an added core entry is unassigned", () => {
		const coverage = {
			items: [
				{ entryId: "t_entropy", name: "entropy", skills: ["sk_1"] },
				{ entryId: "t_OLS", name: "OLS", skills: ["sk_1"] },
				{ entryId: "t_kernel", name: "kernel", sense: { materialId: "mat_lec", page: 9 }, skills: ["sk_2"] },
			],
			links: [["t_OLS", "t_entropy"]],
		};
		// the re-index: "OLS" is gone, "entropy" is now spelled "Shannon entropy", "kernel" lost its second sense, "variance" is new
		const after = glossaryOf([{ material: LEC, terms: [term("Shannon entropy"), term("kernel", { page: 3 }), term("variance")] }]);
		const r = resolveCoverage(coverage, after, new Set(["sk_1", "sk_2"]));
		assert.deepEqual(r.items.filter((i) => i.status === "flagged").map((i) => i.key), ["t_entropy", "t_OLS", "t_kernel#mat_lec:9"]);
		assert.deepEqual(r.unassigned.map((e) => e.term).sort(), ["Shannon entropy", "kernel", "variance"]);
		assert.deepEqual(r.group("t_OLS"), ["t_OLS"], "a flagged member counts toward nothing");
		// the student remaps the renamed one and removes the dropped one
		const remapped = applyCoverageEdit(coverage, { action: "remap", key: "t_entropy", to: "t_Shannon_entropy" }, { glossary: after, skills: new Set(["sk_1", "sk_2"]) });
		assert.ok(remapped.ok);
		const removed = remapped.ok ? applyCoverageEdit(remapped.value, { action: "remove", key: "t_OLS" }, { glossary: after, skills: new Set(["sk_1", "sk_2"]) }) : remapped;
		assert.ok(removed.ok);
		const r2 = resolveCoverage(removed.ok ? removed.value : coverage, after, new Set(["sk_1", "sk_2"]));
		assert.deepEqual(r2.byKey.get("t_Shannon_entropy")?.status, "assigned");
		assert.equal(r2.byKey.has("t_OLS"), false);
		assert.deepEqual(removed.ok ? removed.value.links : null, [], "the link went with the removed item");
	});

	it("an item whose skills all left the map is unassigned; no glossary at all flags everything", () => {
		const coverage = { items: [{ entryId: "t_entropy", name: "entropy", skills: ["sk_gone"] }], links: [] };
		assert.equal(resolveCoverage(coverage, base(), new Set(["sk_1"])).byKey.get("t_entropy")!.status, "unassigned");
		assert.equal(resolveCoverage(coverage, null, new Set(["sk_gone"])).byKey.get("t_entropy")!.status, "flagged");
	});
});

describe("the student's edits", () => {
	const ctx = { glossary: base(), skills: new Set(["sk_1", "sk_2"]) };
	const empty = { items: [], links: [] };
	it("assign creates an item, exclude replaces the assignment, unknown keys and skills are refused", () => {
		const a = applyCoverageEdit(empty, { action: "assign", key: "t_Entropy", skill: "sk_1" }, ctx);
		assert.ok(a.ok);
		assert.deepEqual(a.ok && a.value.items, [{ entryId: "t_Entropy", name: "Entropy", skills: ["sk_1"] }]);
		const x = a.ok ? applyCoverageEdit(a.value, { action: "exclude", key: "t_Entropy", reason: "heading" }, ctx) : a;
		assert.deepEqual(x.ok && x.value.items, [{ entryId: "t_Entropy", name: "Entropy", excluded: "heading" }]);
		assert.equal(applyCoverageEdit(empty, { action: "assign", key: "t_nope", skill: "sk_1" }, ctx).ok, false);
		assert.equal(applyCoverageEdit(empty, { action: "assign", key: "t_entropy", skill: "sk_9" }, ctx).ok, false);
	});
	it("'same thing' links two names and gives the unmapped one the other's mapping; unlink undoes the link only", () => {
		const start = { items: [{ entryId: "t_entropy", name: "entropy", skills: ["sk_2"] }], links: [] };
		const l = applyCoverageEdit(start, { action: "link", keys: ["t_entropy", "t_Entropy"] }, ctx);
		assert.ok(l.ok);
		assert.deepEqual(l.ok && l.value.links, [["t_Entropy", "t_entropy"]]);
		assert.deepEqual(l.ok && l.value.items.find((i) => i.entryId === "t_Entropy")?.skills, ["sk_2"]);
		const u = l.ok ? applyCoverageEdit(l.value, { action: "unlink", key: "t_Entropy" }, ctx) : l;
		assert.deepEqual(u.ok && u.value.links, []);
	});
	it("parses request bodies", () => {
		assert.deepEqual(parseCoverageEdit({ action: "assign", key: "t_a", skill: "sk_1" }), { action: "assign", key: "t_a", skill: "sk_1" });
		assert.equal(typeof parseCoverageEdit({ action: "link", keys: ["t_a"] }), "string");
		assert.equal(typeof parseCoverageEdit({ action: "explode" }), "string");
		assert.deepEqual(normalizeLinks([["a", "b"], ["b", "c"], ["d"]]), [["a", "b", "c"]]);
	});
});
