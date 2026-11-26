/**
 * The class page redesign (UI class page, 2026-11-25; owner feedback): the class side panel (files inline instead of the
 * Sources popover, the skill map, exam / starting point / pace, lecture notes, Delete class…), the empty class's setup
 * checklist in the center, and "Short question" as the Ask mode's name.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { InteractionLayersProvider } from "../components/interaction-layers";
import type { LessonMaterial } from "../src/core";
import type { MaterialsApi } from "../components/use-materials";

const { ClassPanel, skillMapButton } = await import("../components/class-panel.tsx");
const { ClassSetup, filesSummary, mapStepState, setupSteps } = await import("../components/class-setup.tsx");
const { filesCount } = await import("../components/class-files.tsx");
const { materialStatusLine, pagesLabel } = await import("../components/materials-control.tsx");
const { CourseBody, UNDERSTANDING_HELP } = await import("../components/course-page.tsx");
const { SHORT_QUESTION } = await import("../components/course-modes.tsx");
type CoursePayload = import("../components/course-page.tsx").CoursePayload;

const material = (over: Partial<LessonMaterial> = {}): LessonMaterial => ({
	id: "mat_1",
	kind: "pdf",
	name: "Unit 3.pdf",
	file: "source.pdf",
	bytes: 10,
	addedAt: "t",
	status: "ready",
	pages: 1,
	...over,
});

const fakeFiles = (materials: LessonMaterial[] = [], over: Partial<MaterialsApi> = {}): MaterialsApi => ({
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
	camera: { available: false, open: () => {} },
	node: null,
	...over,
});

const panel = (over: Record<string, unknown> = {}) =>
	renderToStaticMarkup(
		<InteractionLayersProvider>
			<ClassPanel
				courseId="course_1"
				courseTitle="Biology"
				pace={undefined}
				files={fakeFiles([material()])}
				hasSkills
				hasDraft={false}
				drafting={false}
				error={null}
				busy={false}
				onDraft={() => {}}
				onPlacement={() => {}}
				onDeleted={() => {}}
				exam={{ examDate: "2026-12-14", hasWeights: true, weighing: false, canWeigh: true }}
				{...over}
			/>
		</InteractionLayersProvider>,
	);

describe("the setup checklist (an empty class)", () => {
	const base = { materialCount: 0, reading: 0, hasSkills: false, hasDraft: false, drafting: false };
	const state = (over: Partial<typeof base & { courseError: string }> = {}) => setupSteps({ ...base, ...over });
	const ids = (steps: ReturnType<typeof setupSteps>, key: "done" | "enabled" | "current") => steps.filter((s) => s[key]).map((s) => s.id);

	it("a new class: step 1 is open, nothing is done, the map and learning cannot start", () => {
		const steps = state();
		assert.deepEqual(steps.map((s) => s.title), ["Add your class files", "Draft the skill map", "Start learning"]);
		assert.deepEqual(ids(steps, "current"), ["files"]);
		assert.deepEqual(ids(steps, "done"), []);
		assert.deepEqual(ids(steps, "enabled"), ["files"]);
	});

	it("a file added: step 1 ticks off; the map waits while every file is still being read, then can start", () => {
		const reading = state({ materialCount: 1, reading: 1 });
		assert.deepEqual(ids(reading, "done"), ["files"]);
		assert.deepEqual(ids(reading, "current"), ["map"]);
		assert.equal(mapStepState({ ...base, materialCount: 1, reading: 1 }), "reading");
		assert.ok(!reading.find((s) => s.id === "map")!.enabled);
		const read = state({ materialCount: 2, reading: 1 });
		assert.ok(read.find((s) => s.id === "map")!.enabled, "one file read is enough");
	});

	it("drafting, a draft to review and a failure each show on the map step", () => {
		assert.equal(mapStepState({ ...base, materialCount: 1, drafting: true }), "drafting");
		assert.equal(mapStepState({ ...base, materialCount: 1, hasDraft: true }), "review");
		assert.equal(mapStepState({ ...base, materialCount: 1, courseError: "no credit" }), "error");
		assert.ok(state({ materialCount: 1, courseError: "no credit" }).find((s) => s.id === "map")!.enabled, "a failure can be retried");
		assert.ok(!state({ materialCount: 1, drafting: true }).find((s) => s.id === "map")!.enabled);
	});

	it("the map exists: steps 1 and 2 are done and Start learning is open and enabled", () => {
		const steps = state({ materialCount: 1, hasSkills: true });
		assert.deepEqual(ids(steps, "done"), ["files", "map"]);
		assert.deepEqual(ids(steps, "current"), ["learn"]);
		assert.ok(steps.find((s) => s.id === "learn")!.enabled);
	});

	it("counts read in words", () => {
		assert.equal(filesSummary(1, 0), "1 file");
		assert.equal(filesSummary(3, 1), "3 files · reading 1");
		assert.equal(filesCount(0, 0), null);
		assert.equal(filesCount(2, 1), "reading 1 of 2");
		assert.equal(pagesLabel(1), "1 page");
		assert.equal(pagesLabel(12), "12 pages");
		assert.equal(materialStatusLine(material({ pages: 1 })), "1 page", "not “1 pages”");
	});

	it("renders the drop zone while there is no file, and the Draft button (the one primary) once one is read", () => {
		const setup = (files: MaterialsApi, over: Record<string, unknown> = {}) =>
			renderToStaticMarkup(<ClassSetup title={<h1>Bio</h1>} files={files} hasSkills={false} hasDraft={false} drafting={false} busy={false} onDraft={() => {}} {...over} />);
		const empty = setup(fakeFiles());
		assert.match(empty, /data-testid="class-drop-zone"/);
		assert.match(empty, /Drop your class files here/);
		assert.doesNotMatch(empty, /setup-draft|setup-learn/, "no disabled buttons for steps that cannot start");
		const ready = setup(fakeFiles([material()]));
		assert.doesNotMatch(ready, /class-drop-zone/);
		assert.match(ready, /data-testid="setup-step-files" data-done="true"/);
		assert.match(ready, /data-testid="setup-files-summary"[^>]*>1 file</);
		assert.match(ready, /data-testid="setup-draft"[^>]*>Draft skill map</);
		assert.match(ready.match(/<button[^>]*data-testid="setup-draft"[^>]*>/)![0], /bg-primary/, "the step's action is the primary button");
		assert.equal((ready.match(/bg-primary text-primary-foreground/g) ?? []).length, 1, "and the only one");
		const failed = setup(fakeFiles([material()]), { courseError: "no credit" });
		assert.match(failed, /Drafting failed: no credit/);
		assert.match(failed, /data-testid="setup-draft"[^>]*>Try again</);
		assert.match(setup(fakeFiles([material()]), { drafting: true }), /data-testid="setup-drafting"/);
	});
});

describe("the class page body", () => {
	const noMap = (over: Partial<CoursePayload> = {}): CoursePayload => ({
		course: { id: "course_a", title: "Untitled course", createdAt: "t", updatedAt: "t", status: "new", skills: [] },
		skills: [],
		review: [],
		reviewBatch: 0,
		notExamined: [],
		plan: { skillsLeft: 0, reviewDue: 0, reviewBatch: 0, lessons: [] },
		nextUp: [],
		learning: [],
		locked: [],
		known: [],
		contextCheck: [],
		sessions: [],
		reused: {},
		drafting: false,
		...over,
	});
	const body = (data: CoursePayload, materialCount = 0) =>
		renderToStaticMarkup(<CourseBody data={data} busy={false} error={null} onDraft={() => {}} onApprove={() => {}} onStart={() => {}} materialCount={materialCount} onAsk={() => {}} />);

	it("an empty class is one setup card: the class name, the three steps, no settings card and no junk lines", () => {
		const html = body(noMap());
		assert.match(html, /data-testid="class-setup"[\s\S]*Untitled course[\s\S]*Add your class files[\s\S]*Draft the skill map[\s\S]*Start learning/);
		assert.doesNotMatch(html, /course-settings|stats-materials|Waits for|Learned: a finished lesson|Delete course/);
		assert.doesNotMatch(html, /course-mode-learn|course-mode-practice/);
	});

	it("the learned / known definitions are the Understanding heading's help, not a paragraph", () => {
		const skill = { id: "a", name: "A", statement: "Do A", requires: [], understanding: 2, learned: true, known: false, missing: [], needsReview: false, stability: null, lastReview: null, reviewAt: null, priority: 1, weight: 1, propositions: [] };
		const html = body(noMap({ skills: [skill as unknown as CoursePayload["skills"][number]], learning: ["a"], course: { ...noMap().course, status: "active", skills: ["a"] } }), 1);
		assert.match(html, /data-testid="understanding-help"/);
		assert.match(UNDERSTANDING_HELP, /^Learned: a finished lesson/);
		assert.doesNotMatch(html, />Learned: a finished lesson/);
	});
});

describe("the class side panel", () => {
	it("holds the files inline, the skill map, exam, starting point, pace, lecture notes and Delete class…", () => {
		const html = panel();
		assert.match(html, /data-testid="class-files"[\s\S]*Files[\s\S]*data-testid="material-mat_1"[\s\S]*Unit 3\.pdf[\s\S]*1 page/);
		assert.match(html, /data-testid="materials-add-files"/);
		assert.match(html, /data-testid="materials-link-input"/);
		assert.match(html, /data-testid="course-curriculum"[\s\S]*Skill map[\s\S]*data-testid="course-draft-button"[^>]*>Re-draft skill map</);
		assert.match(html, /data-testid="course-exam-settings"/);
		assert.match(html, /data-testid="course-placement"[^>]*>\s*Placement test/);
		assert.match(html, /data-testid="course-pace-select"/);
		assert.match(html, /data-testid="course-lecture-notes"/);
		assert.match(html, /data-testid="course-delete"[^>]*>Delete class…</);
		assert.ok(html.indexOf("class-files") < html.indexOf("course-curriculum") && html.indexOf("course-curriculum") < html.indexOf("course-pace"), "files, then the map, then the settings");
		assert.ok(html.indexOf("course-lecture-notes") < html.indexOf("course-delete"), "Delete class… at the bottom");
		assert.doesNotMatch(html, /stats-materials|materials-menu/, "no popover for the class files");
	});

	it("Delete class… is quiet: the destructive button is only the dialog's confirm", () => {
		const button = panel().match(/<button[^>]*data-testid="course-delete"[^>]*>/)![0];
		assert.doesNotMatch(button, /(?<![-:])text-destructive|bg-destructive|data-variant="destructive/);
	});

	it("a material's remove asks first", () => {
		assert.match(panel(), /data-testid="material-remove-mat_1"/);
		assert.doesNotMatch(panel(), /material-remove-confirm/, "the confirm shows only after the first press");
	});

	it("without a skill map: Draft skill map, no exam or starting point; why the button is off", () => {
		const html = panel({ hasSkills: false, exam: undefined, files: fakeFiles() });
		assert.match(html, /data-testid="course-draft-button"[^>]*>Draft skill map</);
		assert.match(html, /<button[^>]*disabled=""[^>]*data-testid="course-draft-button"/);
		assert.match(html, /data-testid="course-draft-reason"[^>]*>Add a class file first\./);
		assert.doesNotMatch(html, /course-exam-settings|course-placement/);
		assert.match(html, /data-testid="class-files-empty"/);
		assert.doesNotMatch(panel({ hasSkills: false, exam: undefined, files: fakeFiles(), setup: true }), /class-files-empty|course-draft-reason/, "the empty class's center holds the drop zone and the steps");
	});

	it("drafting shows the planner's progress and disables re-drafting; a failure shows its reason", () => {
		const html = panel({ drafting: true });
		assert.match(html, /data-testid="course-drafting"/);
		assert.match(html.match(/<button[^>]*data-testid="course-draft-button"[^>]*>/)![0], /disabled=""/);
		assert.match(panel({ courseError: "no credit" }), /Drafting failed: no credit/);
	});

	it("the Draft button's state", () => {
		const b = (over: Partial<Parameters<typeof skillMapButton>[0]> = {}) => skillMapButton({ hasSkills: false, hasDraft: false, drafting: false, materialCount: 1, reading: 0, ...over });
		assert.deepEqual(b(), { label: "Draft skill map", enabled: true, reason: null });
		assert.equal(b({ hasSkills: true }).label, "Re-draft skill map");
		assert.equal(b({ materialCount: 0 }).reason, "Add a class file first.");
		assert.equal(b({ reading: 1 }).reason, "Waiting for the files to be read.");
		assert.equal(b({ drafting: true }).enabled, false);
		assert.equal(b({ busy: true }).enabled, false);
	});
});

describe("“Short question” is the Ask mode's name in the UI", () => {
	it("the mode card and the empty Ask conversation say it; the old name is gone from the UI", () => {
		assert.equal(SHORT_QUESTION, "Short question");
		const chat = fs.readFileSync("components/chat.tsx", "utf8");
		assert.match(chat, /askSession \? "Short question"/);
		for (const file of ["components/chat.tsx", "components/course-modes.tsx", "components/course-page.tsx"]) {
			assert.doesNotMatch(fs.readFileSync(file, "utf8"), /"Ask about this class"/, file);
		}
	});
});
