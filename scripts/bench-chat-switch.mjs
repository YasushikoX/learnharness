/**
 * Benchmark conversation switching and course/chat route latency.
 *
 * Builds a throwaway LH_DATA_DIR with one active course of 15 skills and 50
 * course chats (several with hundreds of messages containing math and code,
 * plus concluded practice problems, finished lessons, and placement answers),
 * starts the server against it, and reports:
 *   1. Direct HTTP route timings, response bytes, and Server-Timing headers.
 *   2. Headless Chrome switch timings (click-to-readable and network-idle),
 *      full-record GET /api/chats/:id count, total API bytes transferred, and
 *      per-route breakdown during switching between two long chats.
 *
 * Usage:
 *   node scripts/bench-chat-switch.mjs [--mode=dev|prod] [--switches=3] [--no-browser]
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const mode = (args.find((a) => a.startsWith("--mode="))?.split("=")[1] ?? "dev").toLowerCase();
const switchesCount = Number(args.find((a) => a.startsWith("--switches="))?.split("=")[1] ?? "3");
const skipBrowser = args.includes("--no-browser");
const chromePath = process.env.LH_TEST_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

if (mode !== "dev" && mode !== "prod") {
	console.error(`Unknown --mode=${mode} (use dev or prod)`);
	process.exit(1);
}

function median(values) {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function p90(values) {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
}

function fmtMs(ms) {
	return `${ms.toFixed(1)} ms`;
}

function fmtKB(bytes) {
	return `${(bytes / 1024).toFixed(1)} KB`;
}

async function freePort() {
	const listener = net.createServer();
	listener.listen(0, "127.0.0.1");
	await once(listener, "listening");
	const { port } = listener.address();
	await new Promise((resolve) => listener.close(resolve));
	return port;
}

function makeUsage() {
	return {
		input: 1200,
		output: 420,
		cacheRead: 800,
		cacheWrite: 0,
		totalTokens: 2420,
		cost: { input: 0.001, output: 0.002, cacheRead: 0.0002, cacheWrite: 0, total: 0.0032 },
	};
}

function makeRichAssistantText(topic, turnIdx) {
	return [
		`### Step ${turnIdx + 1}: ${topic}`,
		"",
		`Consider the integral and Taylor expansion for step ${turnIdx + 1}:`,
		"",
		`$$I_${turnIdx + 1}(a) = \\int_0^{\\infty} e^{-a x^2} \\cos(2\\pi x)\\,dx = \\frac{1}{2}\\sqrt{\\frac{\\pi}{a}} e^{-\\pi^2 / a}$$`,
		"",
		`When $a > 0$, differentiating under the integral sign gives $\\frac{dI}{da} = -\\int_0^\\infty x^2 e^{-ax^2} \\cos(2\\pi x)\\,dx$.`,
		"",
		"```python",
		`def step_${turnIdx + 1}(a: float, n: int = 100) -> float:`,
		"    total = 0.0",
		"    for k in range(1, n + 1):",
		"        total += ((-1) ** k) / (k * k + a)",
		"    return total",
		"```",
		"",
		`Notice how the convergence rate scales as $O(1/n)$ and how the leading term dominates for large $a$.`,
	].join("\n");
}

function makeLongTranscript(prefix, messagePairs, markerText, extraMessages = []) {
	const baseTs = Date.now() - 10 * 86_400_000;
	const msgs = [];
	let ts = baseTs;
	for (let i = 0; i < messagePairs; i++) {
		msgs.push({
			id: `${prefix}_u_${i}`,
			role: "user",
			content: `In step ${i + 1}, why does the substitution $u = x^2$ preserve the bounds when we evaluate $\\int_0^\\infty e^{-u}\\,du$?`,
			timestamp: ts,
		});
		ts += 15_000;
		msgs.push({
			id: `${prefix}_a_${i}`,
			role: "assistant",
			content: [{ type: "text", text: makeRichAssistantText(prefix, i) }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: makeUsage(),
			timestamp: ts,
		});
		ts += 30_000;
	}
	msgs.push(...extraMessages);
	msgs.push({
		id: `${prefix}_a_final`,
		role: "assistant",
		content: [{ type: "text", text: `Final summary for this conversation: ${markerText}` }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: makeUsage(),
		timestamp: ts + 60_000,
	});
	return msgs;
}

function makeConcludedProblemMessages(prefix, skillId, outcome, grade, tsStart, idx) {
	const poseId = `${prefix}_pose_${idx}`;
	const concId = `${prefix}_conc_${idx}`;
	return [
		{
			id: `${prefix}_pa_${idx}`,
			role: "assistant",
			content: [{ type: "toolCall", id: poseId, name: "problem", arguments: { statement: `Compute the derivative of $f(x) = e^{x^2} \\sin(${idx + 1}x)$ using the chain and product rules.`, solution: `$f'(x) = e^{x^2}(2x\\sin(${idx + 1}x) + ${idx + 1}\\cos(${idx + 1}x))$`, skills: [skillId] } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: makeUsage(),
			timestamp: tsStart,
		},
		{
			id: `${prefix}_pr_${idx}`,
			role: "toolResult",
			toolCallId: poseId,
			toolName: "problem",
			content: [{ type: "text", text: "Problem posed." }],
			isError: false,
			timestamp: tsStart + 1000,
		},
		{
			id: `${prefix}_pu_${idx}`,
			role: "user",
			content: `My answer: $f'(x) = e^{x^2}(2x\\sin(${idx + 1}x) + ${idx + 1}\\cos(${idx + 1}x))$.`,
			timestamp: tsStart + 20_000,
		},
		{
			id: `${prefix}_ca_${idx}`,
			role: "assistant",
			content: [
				{ type: "text", text: "Good work applying both rules cleanly." },
				{ type: "toolCall", id: concId, name: "conclude", arguments: { outcome } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: makeUsage(),
			timestamp: tsStart + 30_000,
		},
		{
			id: `${prefix}_cr_${idx}`,
			role: "toolResult",
			toolCallId: concId,
			toolName: "conclude",
			content: [{ type: "text", text: "Problem concluded." }],
			details: { grades: [{ skill: skillId, grade }] },
			isError: false,
			timestamp: tsStart + 31_000,
		},
	];
}

function makeFinishLessonMessages(prefix, skillId, grade, tsStart) {
	const callId = `${prefix}_fin`;
	return [
		{
			id: `${prefix}_fa`,
			role: "assistant",
			content: [
				{ type: "text", text: "You demonstrated solid mastery of this skill." },
				{ type: "toolCall", id: callId, name: "finish_lesson", arguments: { summary: `Demonstrated ${skillId} cleanly on multi-step problems.` } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: makeUsage(),
			timestamp: tsStart,
		},
		{
			id: `${prefix}_fr`,
			role: "toolResult",
			toolCallId: callId,
			toolName: "finish_lesson",
			content: [{ type: "text", text: "Lesson finished." }],
			details: { grades: [{ skill: skillId, grade }] },
			isError: false,
			timestamp: tsStart + 1000,
		},
	];
}

function buildScratchData(dataDir) {
	fs.mkdirSync(path.join(dataDir, "chats"), { recursive: true });
	fs.mkdirSync(path.join(dataDir, "courses"), { recursive: true });
	fs.mkdirSync(path.join(dataDir, "graph"), { recursive: true });

	const now = Date.now();
	const createdIso = new Date(now - 30 * 86_400_000).toISOString();
	const examDate = new Date(now + 28 * 86_400_000).toISOString().slice(0, 10);

	// 15 skills in a prerequisite DAG
	const skillIds = Array.from({ length: 15 }, (_, i) => `sk_bench_${String(i + 1).padStart(2, "0")}`);
	const skillLines = skillIds.map((id, i) => ({
		id,
		name: `Skill ${i + 1}: Calculus Technique ${i + 1}`,
		statement: `Apply calculus technique ${i + 1} accurately to symbolic and applied problems.`,
		requires: i === 0 ? [] : [skillIds[Math.floor((i - 1) / 2)]],
		restsOn: [],
		createdAt: createdIso,
	}));
	fs.writeFileSync(
		path.join(dataDir, "graph", "skills.jsonl"),
		skillLines.map((l) => JSON.stringify(l)).join("\n") + "\n",
		"utf-8",
	);
	fs.writeFileSync(path.join(dataDir, "graph", "format.json"), JSON.stringify({ version: 1 }, null, "\t"), "utf-8");

	const courseId = "course_bench_calculus";
	const skillWeights = Object.fromEntries(skillIds.map((id, i) => [id, { w: (i % 3) + 1, by: "model", reason: "Examined regularly" }]));
	const courseRecord = {
		id: courseId,
		title: "Calculus Benchmark Course",
		createdAt: createdIso,
		updatedAt: new Date(now - 3600_000).toISOString(),
		version: 1,
		status: "active",
		skills: skillIds,
		language: "en",
		examDate,
		skillWeights,
		pastExams: 4,
	};
	fs.writeFileSync(path.join(dataDir, "courses", `${courseId}.json`), JSON.stringify(courseRecord, null, "\t"), "utf-8");

	fs.writeFileSync(
		path.join(dataDir, "settings.json"),
		JSON.stringify({
			version: 1,
			graph: { enabled: true, extractionChunkTokens: 4096 },
			general: { language: "en", pace: "steady", difficulty: "short" },
			models: {
				strong: { model: { provider: "anthropic", id: "claude-sonnet-4-5" }, thinkingLevel: "medium" },
				cheap: { model: { provider: "anthropic", id: "claude-sonnet-4-5" }, thinkingLevel: "off" },
				vision: { model: { provider: "anthropic", id: "claude-sonnet-4-5" }, thinkingLevel: "off" },
			},
		}, null, "\t"),
		"utf-8",
	);

	const writeChat = (record) => {
		fs.writeFileSync(path.join(dataDir, "chats", `${record.id}.json`), JSON.stringify(record, null, "\t"), "utf-8");
	};

	const baseSettings = {
		model: { provider: "anthropic", id: "claude-sonnet-4-5" },
		thinkingLevel: "medium",
		language: "en",
		pace: "steady",
	};

	// Target chat A: long OPEN learn session (~400 messages, ~260+ KB)
	const chatLongA = "chat_bench_long_a";
	const markerA = "BENCH_MARKER_ALPHA_991";
	writeChat({
		id: chatLongA,
		title: "Long Lesson Alpha — Integration",
		createdAt: new Date(now - 2 * 86_400_000).toISOString(),
		updatedAt: new Date(now - 10_000).toISOString(),
		version: 2,
		course: { courseId, mode: "learn", skillIds: [skillIds[4]] },
		settings: baseSettings,
		messages: makeLongTranscript("alpha", 200, markerA),
		turns: [{ id: "t_a1", at: new Date(now - 20_000).toISOString(), model: "anthropic:claude-sonnet-4-5", steps: [{ input: 5000, output: 1200, cacheRead: 2000, cacheWrite: 0 }] }],
	});

	// Target chat B: long OPEN practice session with concluded problems (~400+ messages)
	const chatLongB = "chat_bench_long_b";
	const markerB = "BENCH_MARKER_BETA_772";
	const practiceProblems = [
		...makeConcludedProblemMessages("beta", skillIds[0], "solved", "good", now - 5 * 86_400_000, 0),
		...makeConcludedProblemMessages("beta", skillIds[1], "solvedWithHints", "hard", now - 4 * 86_400_000, 1),
		...makeConcludedProblemMessages("beta", skillIds[2], "solved", "easy", now - 3 * 86_400_000, 2),
	];
	writeChat({
		id: chatLongB,
		title: "Long Practice Beta — Derivatives",
		kind: "practice",
		createdAt: new Date(now - 5 * 86_400_000).toISOString(),
		updatedAt: new Date(now - 20_000).toISOString(),
		version: 2,
		course: { courseId, mode: "practice", skillIds: [skillIds[0], skillIds[1], skillIds[2]] },
		settings: { ...baseSettings, difficulty: "medium" },
		messages: makeLongTranscript("beta", 195, markerB, practiceProblems),
		turns: [{ id: "t_b1", at: new Date(now - 30_000).toISOString(), model: "anthropic:claude-sonnet-4-5", steps: [{ input: 6000, output: 1500, cacheRead: 3000, cacheWrite: 0 }] }],
	});

	// Target chat C: long FINISHED learn session (for lesson-result route timing)
	const chatLongFinished = "chat_bench_long_fin";
	writeChat({
		id: chatLongFinished,
		title: "Long Finished Lesson Gamma",
		createdAt: new Date(now - 6 * 86_400_000).toISOString(),
		updatedAt: new Date(now - 40_000).toISOString(),
		version: 2,
		course: { courseId, mode: "learn", skillIds: [skillIds[0]] },
		settings: baseSettings,
		messages: makeLongTranscript("gamma", 180, "BENCH_MARKER_GAMMA", makeFinishLessonMessages("gamma", skillIds[0], "good", now - 6 * 86_400_000 + 500_000)),
		turns: [],
	});

	// 1 placement chat with answered probes
	const placementId = "chat_bench_placement";
	const pTs = now - 25 * 86_400_000;
	writeChat({
		id: placementId,
		title: "Placement: Calculus Benchmark Course",
		createdAt: new Date(pTs).toISOString(),
		updatedAt: new Date(pTs + 60_000).toISOString(),
		version: 2,
		course: { courseId, mode: "placement", skillIds },
		settings: baseSettings,
		messages: [
			{
				id: "pl_a1",
				role: "assistant",
				content: [{ type: "toolCall", id: "pl_q1", name: "probe", arguments: { skill: skillIds[0], question: "Limit check" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "toolUse",
				usage: makeUsage(),
				timestamp: pTs + 10_000,
			},
			{
				id: "pl_r1",
				role: "toolResult",
				toolCallId: "pl_q1",
				toolName: "probe",
				content: [{ type: "text", text: JSON.stringify({ kind: "quiz", correct: true, confidence: 85 }) }],
				details: { kind: "quiz", correct: true, confidence: 85, placementGrade: { skill: skillIds[0], grade: "easy" } },
				isError: false,
				timestamp: pTs + 20_000,
			},
		],
		turns: [],
	});

	// Remaining 46 course chats (total = 50 chats): 4 more very long (~150 pairs = 300 msgs each) + 42 medium/short (20-50 pairs)
	for (let i = 0; i < 46; i++) {
		const id = `chat_bench_${String(i + 1).padStart(2, "0")}`;
		const skillId = skillIds[i % skillIds.length];
		const isVeryLong = i < 6;
		const pairs = isVeryLong ? 180 : 30 + (i % 35);
		const isPractice = i % 3 === 1;
		const isReview = i % 3 === 2;
		const modeKind = isPractice ? "practice" : isReview ? "review" : "learn";
		const ageMs = (i + 3) * 12 * 3600_000;
		const extra = isPractice || isReview
			? [
				...makeConcludedProblemMessages(id, skillId, i % 4 === 0 ? "solvedWithHints" : "solved", i % 4 === 0 ? "hard" : "good", now - ageMs, 0),
				...makeConcludedProblemMessages(id, skillIds[(i + 1) % skillIds.length], "solved", "good", now - ageMs + 60_000, 1),
			]
			: i % 2 === 0
				? makeFinishLessonMessages(id, skillId, "good", now - ageMs)
				: [];

		writeChat({
			id,
			title: `${modeKind === "learn" ? "Learn" : modeKind === "review" ? "Review" : "Practice"} #${i + 1}: ${skillId}`,
			...(modeKind === "practice" || modeKind === "review" ? { kind: "practice" } : {}),
			createdAt: new Date(now - ageMs - 3600_000).toISOString(),
			updatedAt: new Date(now - ageMs).toISOString(),
			version: 2,
			course: { courseId, mode: modeKind, skillIds: [skillId] },
			settings: baseSettings,
			messages: makeLongTranscript(id, pairs, `MARKER_${i}`, extra),
			turns: [],
		});
	}

	const chatFiles = fs.readdirSync(path.join(dataDir, "chats")).filter((f) => f.endsWith(".json"));
	const totalBytes = chatFiles.reduce((sum, f) => sum + fs.statSync(path.join(dataDir, "chats", f)).size, 0);
	return {
		courseId,
		chatLongA,
		markerA,
		chatLongB,
		markerB,
		chatLongFinished,
		chatCount: chatFiles.length,
		totalChatBytes: totalBytes,
		longABytes: fs.statSync(path.join(dataDir, "chats", `${chatLongA}.json`)).size,
		longBBytes: fs.statSync(path.join(dataDir, "chats", `${chatLongB}.json`)).size,
	};
}

async function main() {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-bench-switch-"));
	const dataDir = path.join(home, "data");
	const authFile = path.join(home, "auth.json");
	fs.writeFileSync(authFile, "{}\n", "utf-8");

	const fixture = buildScratchData(dataDir);

	// Mock Google Fonts so Next never tries outbound network requests.
	const require = createRequire(import.meta.url);
	const { getFontAxes } = require("next/dist/compiled/@next/font/dist/google/get-font-axes.js");
	const { getGoogleFontsUrl } = require("next/dist/compiled/@next/font/dist/google/get-google-fonts-url.js");
	const fonts = Object.fromEntries(
		["JetBrains Mono", "Source Sans 3"].map((family) => [
			getGoogleFontsUrl(family, getFontAxes(family, ["variable"], ["normal"]), "swap"),
			`@font-face { font-family: '${family}'; src: local('Arial'); font-weight: 100 900; }`,
		]),
	);
	fs.writeFileSync(path.join(home, "fonts.cjs"), `module.exports = ${JSON.stringify(fonts)};\n`);

	const port = await freePort();
	const origin = `http://127.0.0.1:${port}`;
	const env = {
		PATH: process.env.PATH,
		HOME: home,
		TMPDIR: home,
		NODE_ENV: mode === "prod" ? "production" : "development",
		LH_DATA_DIR: dataDir,
		LH_AUTH_FILE: authFile,
		LH_IGNORE_ENV_KEYS: "1",
		LH_UPSTREAM_CHECK: "0",
		NEXT_TELEMETRY_DISABLED: "1",
		NEXT_FONT_GOOGLE_MOCKED_RESPONSES: path.join(home, "fonts.cjs"),
	};

	const nextCmd = mode === "prod"
		? ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)]
		: ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)];

	const server = spawn(process.execPath, nextCmd, {
		cwd: ROOT,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let logs = "";
	const keep = (chunk) => { logs = (logs + chunk).slice(-24_000); };
	server.stdout.on("data", keep);
	server.stderr.on("data", keep);
	let exited = false;
	server.on("exit", () => { exited = true; });

	let browser;
	try {
		// Wait for server ready via /api/health
		const deadline = Date.now() + 90_000;
		let ready = false;
		while (Date.now() < deadline) {
			if (exited) throw new Error(`Server exited early:\n${logs}`);
			try {
				const res = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2000) });
				if (res.ok) { ready = true; break; }
			} catch {
				// not up yet
			}
			await new Promise((r) => setTimeout(r, 300));
		}
		if (!ready) throw new Error(`Server did not become ready:\n${logs}`);

		console.log(`=== LearnHarness Chat-Switch Benchmark (${mode} mode) ===`);
		console.log(
			`Fixture: ${fixture.chatCount} course chats (${fmtKB(fixture.totalChatBytes)} total); ` +
			`long A = ${fmtKB(fixture.longABytes)}, long B = ${fmtKB(fixture.longBBytes)}`,
		);
		console.log("");

		// 1. Direct API route timings (1 warmup + 5 measured)
		const routes = [
			{ name: "GET /api/chats", method: "GET", url: "/api/chats" },
			{ name: "GET /api/courses", method: "GET", url: "/api/courses" },
			{ name: "GET /api/today", method: "GET", url: "/api/today" },
			{ name: "GET /api/courses/:id", method: "GET", url: `/api/courses/${fixture.courseId}` },
			{ name: "GET /api/chats/:id (full)", method: "GET", url: `/api/chats/${fixture.chatLongA}` },
			{ name: "GET /api/chats/:id?view=stats", method: "GET", url: `/api/chats/${fixture.chatLongA}?view=stats` },
			{ name: "GET /api/chats/:id?view=settings", method: "GET", url: `/api/chats/${fixture.chatLongA}?view=settings` },
			{ name: "GET /api/chats/:id/rating-changes", method: "GET", url: `/api/chats/${fixture.chatLongB}/rating-changes` },
			{ name: "GET /api/chats/:id/lesson-result", method: "GET", url: `/api/chats/${fixture.chatLongFinished}/lesson-result` },
			{ name: "GET /api/chats/:id/course", method: "GET", url: `/api/chats/${fixture.chatLongB}/course` },
			{
				name: "POST /api/courses/deletion-impact",
				method: "POST",
				url: "/api/courses/deletion-impact",
				body: JSON.stringify({ chatIds: [fixture.chatLongA, fixture.chatLongB, fixture.chatLongFinished] }),
			},
		];

		console.log("1) Direct API route timings (warm, 5 runs after 1 warmup):");
		const routeResults = [];
		for (const route of routes) {
			const hit = async () => {
				const t0 = performance.now();
				const res = await fetch(`${origin}${route.url}`, {
					method: route.method,
					headers: route.body ? { "Content-Type": "application/json" } : undefined,
					body: route.body,
				});
				const buf = await res.arrayBuffer();
				const ms = performance.now() - t0;
				return { status: res.status, bytes: buf.byteLength, ms, timing: res.headers.get("server-timing") };
			};
			// Warmup
			const warm = await hit();
			const samples = [];
			for (let i = 0; i < 5; i++) samples.push(await hit());
			const med = median(samples.map((s) => s.ms));
			const p90ms = p90(samples.map((s) => s.ms));
			const bytes = samples[samples.length - 1].bytes;
			const timing = samples[samples.length - 1].timing;
			routeResults.push({ name: route.name, status: warm.status, med, p90ms, bytes, timing });
			console.log(
				`  ${route.name.padEnd(36)}  status=${warm.status}  med=${fmtMs(med).padStart(9)}  p90=${fmtMs(p90ms).padStart(9)}  bytes=${fmtKB(bytes).padStart(9)}` +
				(timing ? `  Server-Timing: ${timing}` : ""),
			);
		}
		console.log("");

		// 2. Headless Chrome switch benchmark
		if (!skipBrowser && fs.existsSync(chromePath)) {
			browser = await puppeteer.launch({
				executablePath: chromePath,
				headless: true,
				userDataDir: path.join(home, "chrome-profile"),
				env,
				args: ["--disable-background-networking", "--disable-sync", "--no-first-run", "--disable-default-apps", "--window-size=1440,900"],
			});
			const page = await browser.newPage();
			await page.setViewport({ width: 1440, height: 900 });
			page.setDefaultTimeout(60_000);

			// Intercept /api/models so no external catalog wait/error occurs, keep /api/events quiet 204
			const model = {
				id: "claude-sonnet-4-5",
				name: "Claude Sonnet 4.5",
				provider: "anthropic",
				input: ["text"],
				reasoning: true,
				supportedLevels: ["off", "low", "medium", "high"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 200000,
				maxTokens: 8192,
			};
			const slot = { model: { provider: model.provider, id: model.id }, thinkingLevel: "medium" };
			const catalog = {
				models: [model],
				providers: [{ id: "anthropic", label: "Anthropic", keyPresent: true }],
				defaults: null,
				slots: { strong: slot, cheap: slot, vision: slot },
				rolePins: {},
			};

			// Track responses during each navigation window
			let recording = false;
			let activeLog = [];
			const inflight = new Map();

			await page.setRequestInterception(true);
			page.on("request", (req) => {
				const u = new URL(req.url());
				if (u.origin !== origin) return req.abort();
				if (u.pathname === "/api/models") {
					return req.respond({ status: 200, contentType: "application/json", body: JSON.stringify(catalog) });
				}
				if (u.pathname === "/api/events") {
					return req.continue();
				}
				if (recording) {
					inflight.set(req, { url: u.pathname + u.search, method: req.method(), t0: performance.now() });
				}
				return req.continue();
			});
			page.on("response", async (res) => {
				const meta = inflight.get(res.request());
				if (!meta) return;
				inflight.delete(res.request());
				let bytes = 0;
				try {
					const buf = await res.buffer();
					bytes = buf.byteLength;
				} catch {
					// redirected or empty
				}
				const ms = performance.now() - meta.t0;
				const timing = res.headers()["server-timing"] ?? null;
				activeLog.push({ ...meta, status: res.status(), bytes, ms, timing });
			});
			page.on("requestfinished", (req) => {
				inflight.delete(req);
			});
			page.on("requestfailed", (req) => {
				inflight.delete(req);
			});

			// Initial load on chatLongA so Next.js compiles the route & sidebar hydrates
			await page.goto(`${origin}/chat/${fixture.chatLongA}`, { waitUntil: "domcontentloaded" });
			await page.waitForFunction(
				(marker) => document.body.innerText.includes(marker),
				{ timeout: 60_000 },
				fixture.markerA,
			);
			// Ensure sidebar rows are visible
			await page.waitForSelector(`button[data-session-id="${fixture.chatLongB}"]`, { timeout: 30_000 });
			// Let initial background requests settle
			await new Promise((r) => setTimeout(r, 800));

			const measureSwitch = async (targetId, targetMarker) => {
				activeLog = [];
				inflight.clear();
				recording = true;
				const t0 = performance.now();
				await page.click(`button[data-session-id="${targetId}"]`);
				await page.waitForFunction(
					(id, marker) => window.location.pathname === `/chat/${id}` && document.body.innerText.includes(marker),
					{ timeout: 60_000 },
					targetId,
					targetMarker,
				);
				const clickToReadableMs = performance.now() - t0;
				// Wait for API network activity to go quiet (300ms idle)
				let idleSince = performance.now();
				const idleDeadline = Date.now() + 15_000;
				while (Date.now() < idleDeadline) {
					if (inflight.size > 0) {
						idleSince = performance.now();
					} else if (performance.now() - idleSince >= 400) {
						break;
					}
					await new Promise((r) => setTimeout(r, 50));
				}
				const networkIdleMs = Math.max(clickToReadableMs, idleSince - t0);
				recording = false;
				return { targetId, clickToReadableMs, networkIdleMs, requests: [...activeLog] };
			};

			// 1 warmup switch A -> B -> A so route transitions are warm
			await measureSwitch(fixture.chatLongB, fixture.markerB);
			await measureSwitch(fixture.chatLongA, fixture.markerA);

			const runs = [];
			for (let i = 0; i < switchesCount; i++) {
				runs.push(await measureSwitch(fixture.chatLongB, fixture.markerB));
				runs.push(await measureSwitch(fixture.chatLongA, fixture.markerA));
			}

			const fullChatPattern = /^\/api\/chats\/[^/?]+$/;
			const perSwitchStats = runs.map((run) => {
				const apiReqs = run.requests.filter((r) => r.url.startsWith("/api/"));
				const fullRecordReqs = apiReqs.filter((r) => r.method === "GET" && fullChatPattern.test(r.url));
				const apiBytes = apiReqs.reduce((s, r) => s + r.bytes, 0);
				const totalBytes = run.requests.reduce((s, r) => s + r.bytes, 0);
				return {
					targetId: run.targetId,
					clickToReadableMs: run.clickToReadableMs,
					networkIdleMs: run.networkIdleMs,
					apiCount: apiReqs.length,
					fullRecordCount: fullRecordReqs.length,
					apiBytes,
					totalBytes,
					apiReqs,
				};
			});

			console.log(`2) Headless Chrome chat switches (${runs.length} warm switches between Long A & Long B):`);
			console.log(`  Click-to-readable median:  ${fmtMs(median(perSwitchStats.map((s) => s.clickToReadableMs)))}  (p90 ${fmtMs(p90(perSwitchStats.map((s) => s.clickToReadableMs)))})`);
			console.log(`  Network-idle median:       ${fmtMs(median(perSwitchStats.map((s) => s.networkIdleMs)))}  (p90 ${fmtMs(p90(perSwitchStats.map((s) => s.networkIdleMs)))})`);
			console.log(`  Full-record chat GETs/nav: ${median(perSwitchStats.map((s) => s.fullRecordCount))}  (per switch: ${perSwitchStats.map((s) => s.fullRecordCount).join(", ")})`);
			console.log(`  API bytes/switch median:   ${fmtKB(median(perSwitchStats.map((s) => s.apiBytes)))}  (total incl. RSC/page: ${fmtKB(median(perSwitchStats.map((s) => s.totalBytes)))})`);
			console.log("");

			// Breakdown of API calls on the last A->B (practice) and B->A (learn) switches
			for (const sample of runs.slice(-2)) {
				const label = sample.targetId === fixture.chatLongB ? "Long B (practice)" : "Long A (learn)";
				console.log(`  API requests on switch -> ${label}:`);
				const grouped = new Map();
				for (const r of sample.requests.filter((x) => x.url.startsWith("/api/"))) {
					const norm = r.url.replace(/chat_bench_[a-z0-9_]+/g, ":id").replace(/course_bench_[a-z0-9_]+/g, ":courseId");
					const key = `${r.method} ${norm}`;
					const g = grouped.get(key) ?? { count: 0, bytes: 0, times: [], timing: null };
					g.count++;
					g.bytes += r.bytes;
					g.times.push(r.ms);
					if (r.timing) g.timing = r.timing;
					grouped.set(key, g);
				}
				for (const [key, g] of [...grouped.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
					console.log(
						`    ${key.padEnd(42)} x${String(g.count).padEnd(3)} bytes=${fmtKB(g.bytes).padStart(9)}  med=${fmtMs(median(g.times)).padStart(8)}` +
						(g.timing ? `  Server-Timing: ${g.timing}` : ""),
					);
				}
			}
		} else {
			console.log("2) Headless Chrome skipped (not requested or Chrome binary missing).");
		}
	} finally {
		if (browser) await browser.close().catch(() => {});
		if (!exited) {
			server.kill("SIGTERM");
			await new Promise((resolve) => {
				const t = setTimeout(() => {
					if (!exited) { try { server.kill("SIGKILL"); } catch {} }
					resolve();
				}, 3000);
				server.once("exit", () => { clearTimeout(t); resolve(); });
			});
		}
		fs.rmSync(home, { recursive: true, force: true });
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
