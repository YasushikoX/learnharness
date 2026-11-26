import type { AssistantMessage, ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { buildSubagentSteer, type ChatCourseLink, type ChatRecord, type PlanTree } from "../../src/core/contracts.ts";
import { newAnswerResult, type LhMessage } from "../../src/core/native-messages.ts";
import { buildAnswer } from "../../src/core/question-core.ts";
import { ids } from "./scenario.mjs";

const text = (value: string) => ({ type: "text" as const, text: value });
const call = (id: string, name: string, args: ToolCall["arguments"]): ToolCall => ({ type: "toolCall", id, name, arguments: args });

export function transcript(chatId: string, start: number) {
	const messages: LhMessage[] = [];
	const when = () => start + messages.length * 90_000;
	const add = (message: LhMessage | UserMessage | AssistantMessage | ToolResultMessage) =>
		messages.push({ ...message, timestamp: when(), id: `${chatId}_m${messages.length + 1}` });
	return {
		messages,
		add,
		user: (content: string) => add({ role: "user", content, timestamp: when() }),
		assistant: (...parts: (string | ToolCall)[]) => add({
			role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4-5",
			content: parts.map(part => typeof part === "string" ? text(part) : part),
			stopReason: parts.some(part => typeof part !== "string") ? "toolUse" : "stop",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			timestamp: when(),
		} satisfies AssistantMessage),
		result: (tool: ToolCall, body: string, details: ToolResultMessage["details"]) => add({
			role: "toolResult", toolCallId: tool.id, toolName: tool.name, content: [text(body)], details, isError: false, timestamp: when(),
		}),
		when,
	};
}

const plan: PlanTree = {
	version: 1,
	nodes: [
		{ id: "gradient", title: "Build a proton gradient" },
		{ id: "turbine", title: "Use the gradient to make ATP" },
		{ id: "uncoupler", title: "Predict what a proton leak does" },
	],
	edges: [{ from: "gradient", to: "turbine" }, { from: "turbine", to: "uncoupler" }],
};

function enterTeaching(log: ReturnType<typeof transcript>, tree: PlanTree = plan) {
	const probe = call("call_probe", "probe_done", { assessment: { strands: [{ strand: "Cellular energetics", assessment: "Connects ATP to work, but confuses the pump with ATP synthase." }] } });
	log.assistant(probe);
	log.result(probe, "Ready to teach.", { ok: true });
	const init = call("call_plan", "plan_init", { mermaid: `graph LR\n  ${tree.nodes.map(n => `${n.id}[${n.title}]`).join("\n  ")}\n  ${tree.edges.map(e => `${e.from} --> ${e.to}`).join("\n  ")}` });
	log.assistant(init);
	log.result(init, "Plan created.", { ok: true, tree: { ...tree, nodes: tree.nodes.map(node => ({ ...node })), edges: tree.edges.map(edge => ({ ...edge })) } });
}

const mitochondrion = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 620 230" role="img" aria-label="Protons move through ATP synthase from the intermembrane space into the matrix">
  <rect x="1" y="1" width="618" height="228" rx="18" fill="#f4eee2" stroke="#c0af98"/>
  <g font-family="system-ui, sans-serif" font-size="17" fill="#223339">
    <text x="26" y="32" font-weight="600">Intermembrane space</text><text x="26" y="202" font-weight="600">Matrix</text>
    <path d="M26 103H594M26 131H594" fill="none" stroke="#7b9f98" stroke-width="6" stroke-linecap="round"/>
    <text x="415" y="89" fill="#3f625e">Inner membrane</text>
    <g fill="#ba4f61" font-weight="700"><text x="147" y="69">H⁺</text><text x="217" y="65">H⁺</text><text x="296" y="59">H⁺</text><text x="372" y="65">H⁺</text><text x="451" y="65">H⁺</text><text x="300" y="183">H⁺</text></g>
    <rect x="276" y="88" width="72" height="64" rx="21" fill="#c5ded3" stroke="#3f625e" stroke-width="2"/>
    <path d="M310 78V157m-8-10 8 10 8-10" fill="none" stroke="#a6495a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="367" y="157">ATP synthase</text><text x="367" y="190" fill="#3f625e" font-weight="700">ADP + Pᵢ → ATP</text>
  </g>
</svg>`;

function lesson(start: number) {
	const log = transcript(ids.lesson, start);
	log.user("I can follow glycolysis, but I keep mixing up what pumps the protons and what actually makes ATP.");
	enterTeaching(log);
	log.assistant([
		"### How a proton gradient makes ATP",
		"Think about water held behind a dam. The **electron transport chain** spends energy moving protons uphill. **ATP synthase** lets them flow back and uses that downhill movement to make ATP.",
		"1. **NADH** delivers electrons to the respiratory chain.\n2. Energy from electron transfer moves $\\mathrm{H^+}$ from the matrix into the intermembrane space.\n3. Protons flow back through **ATP synthase**, driving the reaction below.",
		"$$\n\\mathrm{ADP} + \\mathrm{P_i} \\longrightarrow \\mathrm{ATP} + \\mathrm{H_2O}\n$$",
	].join("\n\n"));
	const visual = call("call_visual", "visual", { brief: "Diagram the proton gradient and ATP synthase across the inner mitochondrial membrane." });
	log.assistant(visual);
	log.result(visual, "Figure ready.", { jobId: "job_ui_gradient", onShow: true });
	log.add(buildSubagentSteer({ id: "job_ui_gradient", kind: "visual", toolCallId: visual.id }, { svg: mitochondrion, notes: "Proton flow is shown in rose." }));
	const show = call("call_show", "show_figure", {
		figure: "job_ui_gradient", caption: "Chemiosmosis. Follow the arrows from the intermembrane space back into the matrix.",
		lookAt: ["The higher concentration of protons above the membrane", "The channel through ATP synthase"],
	});
	log.assistant(show);
	log.result(show, "Figure shown.", { jobId: "job_ui_gradient", kind: "visual" });
	log.user("So do the electrons ever go through ATP synthase?");
	log.assistant([
		"**Electrons** move through the respiratory chain. **Protons** move through ATP synthase. Here’s the energy transfer in order.",
		"```mermaid\nflowchart LR\n  A[NADH donates electrons] --> B[Respiratory chain pumps protons]\n  B --> C[Proton gradient]\n  C --> D[ATP synthase makes ATP]\n```",
	].join("\n\n"));

	const keyPoints = [
		"Protons move from the intermembrane space into the matrix.",
		"Protons flow down their electrochemical gradient.",
		"ATP synthase couples that flow to ATP production.",
	];
	const first = {
		type: "check", nodeId: "turbine", level: "apply", conceptIds: ["proton gradient", "ATP synthase"],
		lead: "Let’s put both halves together.",
		question: "Which way do protons travel through ATP synthase, and how does their movement lead to ATP production?",
		correctAnswer: "Protons flow from the intermembrane space into the matrix down their electrochemical gradient. ATP synthase couples this downhill flow to making ATP from ADP and phosphate.",
		keyPoints,
	};
	const explained = call("call_explained", "explain", first);
	log.assistant(explained);
	const response = buildAnswer({
		id: explained.id, kind: "explain", question: first.question, mode: "text", options: [],
		committedAnswer: first.correctAnswer, keyPoints, createdAt: new Date(log.when()).toISOString(),
	}, { text: "They flow from the intermembrane space back into the matrix down their gradient. The flow turns ATP synthase so it can make ATP." }, "explain");
	response.answeredAt = new Date(log.when()).toISOString();
	log.add(newAnswerResult(explained.id, explained.name, response, undefined, keyPoints));
	log.assistant("### When the membrane leaks\n\nA proton leak gives protons another way back into the matrix. That makes the gradient shallower. Notice what this does to the flow through ATP synthase, even while the respiratory chain is still working.", call("call_open", "explain", {
		type: "check", nodeId: "uncoupler", level: "transfer", conceptIds: ["proton gradient", "ATP synthase"],
		previous: "right", previousKeyPoints: [1, 2, 3],
		lead: "Exactly. You connected the direction of proton flow to the work ATP synthase does. Now use that same idea to explain a change in the membrane.",
		question: "A small molecule lets protons cross the inner mitochondrial membrane without passing through ATP synthase. Predict what happens to ATP production and explain why.",
		correctAnswer: "ATP production falls because the leak dissipates the proton gradient, reducing the energy available to ATP synthase.",
		keyPoints: ["The leak reduces the proton gradient.", "Less energy is available to drive ATP synthase.", "ATP production falls."],
	}));
	return log.messages;
}

function quiz(start: number) {
	const log = transcript(ids.quiz, start);
	log.user("Can I try a prediction question on photosynthesis?");
	enterTeaching(log, { version: 1, nodes: [{ id: "light", title: "Predict ATP and NADPH output" }], edges: [] });
	log.assistant("### A prediction about photosynthesis\n\nIn an intact chloroplast, **light reactions** make ATP and NADPH. Photosystem II begins the linear path by replacing lost electrons with electrons from water.", call("call_quiz", "quiz", {
		type: "predict", nodeId: "light", level: "apply", conceptIds: ["ATP synthase"],
		lead: "Focus on what happens immediately after the change.",
		question: "If photosystem II stops replacing electrons from water, what happens first to the output of linear electron flow?",
		options: [
			{ value: "a", label: "Oxygen and NADPH production both decrease." },
			{ value: "b", label: "Oxygen production rises and NADPH remains steady." },
			{ value: "c", label: "Oxygen remains steady and NADPH production rises." },
			{ value: "d", label: "Oxygen and NADPH production both increase." },
		],
		correctAnswer: "a", explanation: "Water splitting releases oxygen and supplies the electrons that ultimately reduce NADP⁺.",
	}));
	return log.messages;
}

function practice(start: number) {
	const log = transcript(ids.practice, start);
	log.user("Give me AP-style practice. I need to be faster with the steps of respiration.");
	const first = call("call_problem_first", "problem", {
		mode: "recall", skills: ["sk_glycolysis"],
		statement: "One glucose molecule enters glycolysis. Give the **net ATP yield** and the number of molecules of NADH formed.",
		modelSolution: "Two ATP are invested, four are produced, and two NADH are formed. The net yield is two ATP and two NADH.",
	});
	log.assistant("We’ll start with a short accounting question, then move to a prediction.", first);
	log.result(first, "Problem posed.", null);
	log.user("Net 2 ATP and 2 NADH.");
	const conclude = call("call_conclude", "conclude", { outcome: "solved", comment: "Correct on both counts." });
	log.assistant("Right. Your ATP count leaves out the two ATP that were spent at the start.", conclude);
	log.result(conclude, "Problem concluded.", { grades: [{ skill: "sk_glycolysis", grade: "good" }] });
	const pending = call("call_problem_open", "problem", {
		mode: "composition", skills: ["sk_glycolysis", "sk_ferment"],
		statement: "A student claims muscle cells stop generating ATP entirely when oxygen supply falls. Use **glycolysis** and **lactate fermentation** to assess the claim. Name the electron carrier that must be regenerated.",
		modelSolution: "Glycolysis still yields a small amount of ATP. Lactate fermentation reoxidizes NADH to NAD⁺, allowing glycolysis to continue.",
	});
	log.assistant(pending);
	log.result(pending, "Problem posed.", null);
	return log.messages;
}

function ask(start: number) {
	const log = transcript(ids.ask, start);
	log.user("Why do plants need mitochondria if they already have chloroplasts?");
	log.assistant("### One cell, two energy jobs\n\n**Chloroplasts** use light energy to help build sugars. **Mitochondria** release usable energy from those sugars through respiration, including when the lights are off.\n\nA root cell illustrates the difference. It rarely sees light and may have no chloroplasts, but it still needs ATP to move ions across its membrane and build new tissue. Sugars made in the leaves can travel to the root and fuel respiration there.");
	log.user("So a leaf respires while it's photosynthesizing, too?");
	log.assistant("Yes. A leaf cell can **photosynthesize and respire at the same time**. In bright light, the leaf often consumes more CO₂ through photosynthesis than it releases through respiration. What you measure outside the leaf is the **net** exchange.\n\nThink of the two gas flows as entries in the same ledger. A net inflow of CO₂ tells you which flow is larger.");
	// WP8: a fact about the class and one about the learner, written at once and shown as cards with Undo
	log.user("Quiz 3 is next Friday and covers glycolysis and fermentation. And I still don't get the Calvin cycle.");
	const save = call("call_quiz3", "assessment_save", { kind: "quiz", title: "Quiz 3", date: "next Friday", topics: "glycolysis and fermentation", skillIds: ["sk_glycolysis", "sk_ferment"] });
	const report = call("call_calvin", "record_self_report", { skillIds: ["sk_calvin"], stance: "dont_know", note: "I still don't get the Calvin cycle" });
	log.assistant(save, report);
	log.result(save, "Added: Quiz 3 (quiz).", { change: { kind: "assessment", courseId: ids.biology, action: "added", before: null, after: quiz3, id: quiz3.id, stamp: quiz3.updatedAt, skillNames: ["Glycolysis", "Fermentation"] } });
	log.result(report, "Recorded.", { change: { kind: "self-report", courseId: ids.biology, report: calvinReport, skillNames: ["Calvin cycle"] } });
	log.assistant("Saved Quiz 3 for Friday, and noted that the Calvin cycle is unclear: it comes first among your next lessons.");
	// WP9: the rest of the class page from the chat: a lecture moved, where the class is, an exam weight; then "am I ready?"
	log.user("Lecture 5 got moved to Thursday, and we covered the proton gradient today. Light reactions are on every exam, by the way.");
	const moved = call("call_lec5", "lecture_save", { n: 5, date: "Thursday" });
	const position = call("call_pos", "class_position_set", { lectureNumber: 4, coveredThrough: "the proton gradient" });
	const weights = call("call_w", "skill_weights_set", { weights: [{ skillId: "sk_light", weight: 3 }] });
	log.assistant(moved, position, weights);
	log.result(moved, "Updated lecture: Lecture 5.", { change: { kind: "lecture", courseId: ids.biology, action: "updated", before: lecture5Before, after: lecture5, id: lecture5.id, stamp: lecture5.updatedAt, skillNames: ["Light reactions"] } });
	log.result(position, "Set.", { change: { kind: "position", courseId: ids.biology, before: null, after: classPosition, label: "Lecture 4: The proton gradient", beforeLabel: null } });
	log.result(weights, "Set exam weights.", { change: { kind: "weights", courseId: ids.biology, before: { sk_light: { w: 2, by: "model" } }, after: { sk_light: { w: 3, by: "learner" } }, names: { sk_light: "Light reactions" } } });
	log.assistant("Moved Lecture 5 to Thursday, set the class at Lecture 4, and marked light reactions as on every exam.");
	log.user("Am I ready for Friday?");
	const overview = call("call_overview", "class_overview", {});
	log.assistant(overview);
	log.result(overview, "Quiz 3 needs Glycolysis and Fermentation.", null);
	log.assistant("Nearly: Quiz 3 needs **glycolysis** and **fermentation**. Glycolysis is learned; fermentation (Lecture 3) is not yet, so start there.");
	return log.messages;
}

/** WP9: the class's lectures (fixture.ts), with Lecture 5 as the Ask conversation moved it. */
export let lecture5Before = { id: "lc_ui_5", n: 5, title: "Lecture 5: Light reactions", date: "", topics: "Photosystems, the electron transport chain in the thylakoid", materialIds: [] as string[], skillIds: ["sk_light"], skillsBy: "model" as const, source: "syllabus" as const, updatedAt: "", cite: "Unit 3 syllabus.pdf p. 3" };
export let lecture5 = { ...lecture5Before };
export let classPosition = { lectureId: "lc_ui_4", coveredThrough: "the proton gradient", updatedAt: "" };

/** The lecture timeline for the screenshot day: four past, Lecture 5 moved, one ahead. */
export function uiLectures(day: number) {
	const dayIso = (n: number) => new Date(day + n * 86_400_000).toISOString().slice(0, 10);
	const at = new Date(day - 10 * 86_400_000).toISOString();
	const l = (n: number, title: string, offset: number, topics: string, skillIds: string[]) => ({ id: `lc_ui_${n}`, n, title, date: dayIso(offset), topics, materialIds: [] as string[], skillIds, skillsBy: "model" as const, source: "syllabus" as const, updatedAt: at, cite: "Unit 3 syllabus.pdf p. 3" });
	return [
		l(1, "Lecture 1: ATP and energy coupling", -21, "Free energy, coupled reactions, electron carriers", ["sk_atp", "sk_redox"]),
		l(2, "Lecture 2: Glycolysis", -14, "Glucose to pyruvate", ["sk_glycolysis"]),
		l(3, "Lecture 3: Fermentation and the citric acid cycle", -7, "Regenerating NAD⁺; acetyl-CoA", ["sk_ferment", "sk_citric"]),
		l(4, "Lecture 4: The proton gradient", -1, "The respiratory chain and ATP synthase", ["sk_gradient"]),
		lecture5,
		l(6, "Lecture 6: The Calvin cycle", 13, "Carbon fixation", ["sk_calvin"]),
	];
}

/** The fixture's assessments and self-report (WP8), shared with fixture.ts so the cards' Undo state matches the class. */
export let quiz3 = { id: "as_ui_quiz3", kind: "quiz" as const, title: "Quiz 3", date: "", topics: "glycolysis and fermentation", skillIds: ["sk_glycolysis", "sk_ferment"], source: "chat" as const, updatedAt: "" };
export let calvinReport = { id: "sr_ui_calvin", chatId: ids.ask, at: "", skillIds: ["sk_calvin"], stance: "dont_know" as const, note: "I still don't get the Calvin cycle", updatedAt: "" };

/** Stamp the fixture's assessment and report for the screenshot day (call before seedChats). */
export function stampClassFacts(day: number) {
	const dayIso = (n: number) => new Date(day + n * 86_400_000).toISOString().slice(0, 10);
	const at = new Date(day - 3 * 3_600_000 + 5 * 90_000).toISOString();
	// "next Friday", as the learner says in the transcript: the first Friday after the screenshot day
	const friday = (5 - new Date(day).getUTCDay() + 7) % 7 || 7;
	quiz3 = { ...quiz3, date: dayIso(friday), updatedAt: at };
	calvinReport = { ...calvinReport, at, updatedAt: at };
	// WP9: Lecture 5 was set for day + 6; the chat moved it to "Thursday" (the first Thursday after the screenshot day)
	const thursday = (4 - new Date(day).getUTCDay() + 7) % 7 || 7;
	const at2 = new Date(day - 3 * 3_600_000 + 9 * 90_000).toISOString();
	lecture5Before = { ...lecture5Before, date: dayIso(6), updatedAt: new Date(day - 10 * 86_400_000).toISOString() };
	lecture5 = { ...lecture5Before, date: dayIso(thursday), skillsBy: "model", updatedAt: at2 };
	classPosition = { ...classPosition, updatedAt: at2 };
	return { quiz3, calvinReport, dayIso, classPosition };
}

const history = [
	["Why ATP hydrolysis releases energy", "Why can ATP drive another reaction?", "The overall coupled reaction can release free energy. Transferring a phosphate can change a reactant so the next step becomes favorable.", "sk_atp", "easy"],
	["Electron carriers and redox", "What is NADH carrying?", "**NADH** transfers high-energy electrons to a later reaction. When it gives those electrons up, it is oxidized back to NAD⁺.", "sk_redox", "good"],
	["Glycolysis as a carbon ledger", "Where do all six carbons go?", "The six carbons of glucose end up in two three-carbon pyruvate molecules. **Glycolysis** itself releases no CO₂.", "sk_glycolysis", "hard"],
	["Citric acid cycle carbon tracing", "Where does the carbon dioxide come from?", "Follow the carbons into the cycle with acetyl-CoA, then mark the decarboxylation steps where CO₂ leaves.", "sk_citric"],
	["One-sided limits from graphs", "Why don't the two sides agree at the jump?", "The left and right branches approach different heights. The two-sided limit exists only when both approach the same value.", "sk_limits", "good"],
	["Enzymes and activation energy", "Can an enzyme make any reaction favorable?", "An enzyme lowers the activation barrier and accelerates equilibration. The free-energy difference between reactants and products stays the same."],
	["Why NAD⁺ has to be recycled", "What would happen if all of the NAD⁺ were used up?", "Glycolysis would stall at the oxidation step. Fermentation regenerates **NAD⁺** by moving electrons from NADH to an organic molecule.", "sk_ferment"],
	["Continuity at a removable hole", "How do I fill in the point at x = 2?", "Find the common limit from both sides, then define the function value at that height.", "sk_continuity"],
	["ATP yield and its tradeoffs", "How much ATP does one glucose make?", "A useful estimate is about 30–32 ATP in many eukaryotic cells. The exact yield depends on how electrons enter the respiratory chain.", "sk_gradient"],
	["Reading a photosynthesis graph", "Why does the rate level out in high light?", "Once light is plentiful, another input can limit the rate, such as CO₂ availability or enzyme activity.", "sk_light"],
] as const;

export function seedChats(day: number): ChatRecord[] {
	const hour = 3_600_000;
	const iso = (time: number) => new Date(time).toISOString();
	const related = (mode: ChatCourseLink["mode"], skillIds: string[], courseId: string = ids.biology) => ({ courseId, mode, skillIds });
	const record = (id: string, title: string, messages: LhMessage[], course?: ChatCourseLink): ChatRecord => ({
		id, title, messages, course, createdAt: iso(messages[0]!.timestamp), updatedAt: iso(messages.at(-1)!.timestamp),
		...(course?.mode === "practice" ? { kind: "practice" as const } : {}),
	});
	return [
		{ ...record(ids.lesson, "How proton gradients make ATP", lesson(day - hour), related("learn", ["sk_gradient"])), tree: plan, settings: { pace: "efficient" } },
		record(ids.practice, "AP practice: respiration and fermentation", practice(day - 2 * hour), related("practice", ["sk_glycolysis", "sk_ferment"])),
		record(ids.ask, "Why plants still need mitochondria", ask(day - 3 * hour), related("ask", [])),
		{ ...record(ids.quiz, "Predicting what light reactions produce", quiz(day - 6 * hour), related("learn", ["sk_light"])), tree: { version: 1, nodes: [{ id: "light", title: "Predict ATP and NADPH output" }], edges: [] } },
		...history.map(([title, prompt, reply, skill, grade], index) => {
			const id = `chat_ui_history_${index + 1}`;
			const log = transcript(id, day - (16 + index * 17) * hour);
			log.user(prompt);
			log.assistant(reply);
			if (skill && grade) {
				const finish = call("call_finish", "finish_lesson", { summary: reply });
				log.assistant(finish);
				log.result(finish, "Lesson finished.", { grades: [{ skill, grade }] });
				log.assistant("I’ve saved that summary with the skill so you can revisit it during review.");
			}
			return record(id, title, log.messages, skill
				? related("learn", [skill], skill === "sk_limits" || skill === "sk_continuity" ? ids.calculus : ids.biology)
				: undefined);
		}),
	];
}
