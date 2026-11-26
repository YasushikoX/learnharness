import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	chatVersionFor, CURRENT_COURSE_VERSION, type CourseRecord, type GraphNode,
} from "../../src/core/contracts.ts";
import { CURRENT_SETTINGS_VERSION, type UserSettings } from "../../src/core/settings.ts";
import type { SkillWeightValue } from "../../src/core/exam-plan.ts";
import { ids, themes } from "./scenario.mjs";

const [, , fixtureRoot, themeArg, dateArg] = process.argv;
const day = Date.parse(`${dateArg}T00:00:00Z`);
if (!fixtureRoot || (themeArg !== "dark" && themeArg !== "light") || !Number.isFinite(day)) {
	throw new Error("Expected a temporary fixture directory, theme and YYYY-MM-DD");
}
const root = realpathSync(fixtureRoot);
if (dirname(root) !== realpathSync(tmpdir()) || !basename(root).startsWith("lh-ui-shots-")) {
	throw new Error("Fixtures must be generated inside a runner-owned temporary directory");
}
const profile = join(root, themeArg);
mkdirSync(profile); // must be new
process.env.LH_DATA_DIR = join(profile, "data");
process.env.LH_AUTH_FILE = join(profile, "auth.json");
process.env.LH_IGNORE_ENV_KEYS = "1";

// Store paths are captured at import time. Import after the disposable profile is set.
const { PATHS, AUTH_FILE } = await import("../../config.ts");
const { writeSettings } = await import("../../src/store/settings.ts");
const { authStore } = await import("../../src/store/auth.ts");
const { writeFileAtomicSync } = await import("../../src/store/atomic-write.ts");
const { skillStore } = await import("../../src/store/skills.ts");
const { graphStore } = await import("../../src/store/graph.ts");
const { chatStore } = await import("../../src/store/chats.ts");
const { courseStore } = await import("../../src/store/courses.ts");
const { sourceOrganizationStore } = await import("../../src/store/source-organization.ts");
const { courseGlossary } = await import("../../src/server/material-indexing.ts");
const { owesTutorReply } = await import("../../src/core/native-messages.ts");
const { seedChats, stampClassFacts, uiLectures } = await import("./transcripts.ts");
const { lectureLinkKeyOf } = await import("../../src/server/lectures.ts");
const { biology, calculus, coverageItems, seedCurriculum, skillLines } = await import("./curriculum.ts");

const DAY_MS = 86_400_000;
const iso = (time: number) => new Date(time).toISOString();
const createdAt = iso(day - 7 * DAY_MS);
const updatedAt = iso(day - DAY_MS);
const settings: UserSettings = {
	version: CURRENT_SETTINGS_VERSION,
	appearance: { theme: themes[themeArg] },
	general: { language: "en", pace: "efficient" },
	models: {
		strong: { model: { provider: "anthropic", id: "claude-sonnet-4-5" } },
		cheap: { model: { provider: "anthropic", id: "claude-haiku-4-5" } },
		vision: { model: { provider: "anthropic", id: "claude-sonnet-4-5" } },
	},
};
writeSettings(settings);
writeFileSync(AUTH_FILE, "{}\n", { mode: 0o600, flag: "wx" });
authStore.setAuthVar("ANTHROPIC_API_KEY", "synthetic-ui-screenshot-fixture-key");

const weight = (w: SkillWeightValue) => ({ w, by: "model" as const });
// WP8: Quiz 3 (said in Short question), the old exam date read as "Exam", an undated lab report, one self-report, and a
// pending syllabus proposal, so the Upcoming list, its proposal and the Ask cards all show
const { quiz3, calvinReport, dayIso, classPosition } = stampClassFacts(day);
const courses: CourseRecord[] = [
	{
		id: ids.biology, title: "AP Biology: Cellular Energetics", createdAt, updatedAt, status: "active",
		skills: biology.map(skill => skill.id), language: "en", pace: "efficient",
		examDate: iso(day + 12 * DAY_MS).slice(0, 10),
		skillWeights: {
			sk_atp: weight(2), sk_redox: weight(2), sk_glycolysis: weight(3), sk_citric: weight(2),
			// WP9: light reactions as Short question set them ("on every exam")
			sk_gradient: weight(3), sk_ferment: weight(1), sk_light: { w: 3, by: "learner" }, sk_calvin: weight(1),
		},
		weightsSummary: "Practice tests emphasize tracking energy and electron flow, especially the role of the proton gradient.",
		weightsAt: updatedAt, pastExams: 2,
		coverage: { updatedAt, items: coverageItems, links: [] },
		assessments: [
			quiz3,
			{ id: "as_ui_lab", kind: "assignment", title: "Lab report: yeast fermentation", topics: "CO₂ output at three temperatures", skillIds: ["sk_ferment"], source: "manual", updatedAt },
		],
		selfReports: [calvinReport],
		assessmentProposal: {
			createdAt: updatedAt,
			summary: "Read the course schedule (Unit 3 syllabus).",
			items: [
				{ key: "p1", kind: "quiz", title: "Quiz 4", date: dayIso(10), topics: "Light reactions and the Calvin cycle", skillIds: ["sk_light", "sk_calvin"], cite: "Unit 3 syllabus.pdf p. 2", status: "new" },
				{ key: "p2", kind: "quiz", title: "Quiz 3", date: quiz3.date, topics: "Glycolysis", skillIds: ["sk_glycolysis"], cite: "Unit 3 syllabus.pdf p. 2", status: "kept", match: quiz3.id },
			],
		},
		assessmentsScannedAt: updatedAt,
		// WP9: the lecture timeline and where the class is (as the Ask transcript set them)
		lectures: uiLectures(day),
		classPosition,
	},
	{
		id: ids.calculus, title: "Calculus I", createdAt, updatedAt: createdAt, status: "active",
		skills: calculus.map(skill => skill.id), language: "en", pace: "thorough",
	},
	// UI round 8: one read file, no skill map yet, in a sidebar folder
	{
		id: ids.chemistry, title: "Organic Chemistry", createdAt, updatedAt: createdAt, status: "active",
		skills: [], language: "en", folder: ids.chemistryFolder,
	},
];

// The public create methods mint random IDs and wall-clock dates. Use the
// app's schemas and version helpers for those initial records and read them
// back through the stores before starting the server.
mkdirSync(PATHS.courses, { recursive: true });
for (const course of courses) {
	writeFileAtomicSync(join(PATHS.courses, `${course.id}.json`), JSON.stringify({ ...course, version: CURRENT_COURSE_VERSION }, null, "\t"));
	if (!courseStore.getCourse(course.id)) throw new Error(`Cannot read seeded course ${course.id}`);
}

const chats = seedChats(day);
mkdirSync(PATHS.chats, { recursive: true });
for (const chat of chats) {
	if (owesTutorReply(chat.messages)) throw new Error(`Fixture session ${chat.id} would start a tutor turn on open`);
	const stored = { ...chat, version: chatVersionFor(chat) };
	writeFileAtomicSync(join(PATHS.chats, `${chat.id}.json`), JSON.stringify(stored, null, "\t"));
	if (chat.id !== ids.lesson) continue;
	const beforeQuestion = chat.messages.at(-1);
	if (beforeQuestion?.role !== "assistant") throw new Error("Expected the lesson to end with a question call");
	// UI round 8: the composer's turn carries usage, so the toolbar shows the context figure and its stats popover
	const usage = { input: 9_800, output: 1_240, cacheRead: 7_400, cacheWrite: 0, totalTokens: 18_440, cost: { input: 0.0294, output: 0.0186, cacheRead: 0.0022, cacheWrite: 0, total: 0.0502 } };
	const prose = { ...beforeQuestion, stopReason: "stop", usage, content: beforeQuestion.content.filter(part => part.type === "text") };
	writeFileAtomicSync(join(profile, "lesson-before-question.json"), JSON.stringify({
		...stored, messages: [...chat.messages.slice(0, -1), prose],
	}, null, "\t"));
}
if (chatStore.listChats().length !== chats.length) throw new Error("The chat store could not project every fixture session");

seedCurriculum(createdAt);
if (courseGlossary(ids.biology)?.indexed.length !== 1) throw new Error("The course glossary could not read the seeded PDF digest");

const provenance = [{ chatId: ids.lesson, messageId: `${ids.lesson}_m6` }];
const nodes = [
	["n_atp", "ATP hydrolysis", "The hydrolysis of ATP can be coupled to a reaction that requires free energy."],
	["n_redox", "NADH oxidation", "NADH donates electrons to the mitochondrial respiratory chain."],
	["n_gradient", "Proton gradient", "The respiratory chain builds a proton gradient across the inner mitochondrial membrane."],
	["n_flow", "Proton flow", "Protons move down their electrochemical gradient through ATP synthase."],
	["n_synthesis", "ATP synthesis", "Proton flow through ATP synthase drives ATP production."],
	["n_leak", "Proton leak", "A leak across the inner membrane reduces the proton gradient available for ATP synthesis."],
	["n_decrease", "Reduced ATP output", "A smaller proton gradient provides less energy to drive ATP production."],
] as const;
for (const [id, name, statement] of nodes) {
	graphStore.appendNode({ id, name, statement, createdAt, aliases: [], provenance } satisfies GraphNode);
}
const chains = [
	[["n_redox"], "n_gradient"],
	[["n_gradient"], "n_flow"],
	[["n_gradient", "n_flow"], "n_synthesis"],
	[["n_leak"], "n_decrease"],
] as const;
for (const [premises, conclusion] of chains) {
	graphStore.appendChain({ id: `arg_ui_${conclusion}`, premises: [...premises], conclusion, createdAt, provenance });
}
skillStore.appendSkillLines(skillLines(createdAt));

// UI round 8: a session folder holding two older sessions (its menu, and the graph's folder filter)
sourceOrganizationStore.write({
	version: 1,
	folders: [{ id: ids.sessionFolder, name: "Extra reading", parentId: null, createdAt }],
	placements: Object.fromEntries(ids.foldered.map(id => [id, { folderId: ids.sessionFolder }])),
});

// WP9: the "link skills to lectures" step already ran for these lectures (so the server starts no model call)
{
	const course = courseStore.getCourse(ids.biology)!;
	const key = lectureLinkKeyOf(ids.biology)!;
	writeFileAtomicSync(join(PATHS.courses, `${ids.biology}.json`), JSON.stringify({ ...course, lecturesLinkedKey: key, lecturesLinkedAt: updatedAt }, null, "\t"));
}
