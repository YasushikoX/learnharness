import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ids } from "./scenario.mjs";

const desktop = { width: 1440, height: 900, deviceScaleFactor: 2 };
const narrow = { width: 1024, height: 768, deviceScaleFactor: 2 };
const testId = id => `[data-testid="${id}"]`;
const course = `/course/${ids.biology}`;
const lesson = `/chat/${ids.lesson}`;
const matchesCourse = testId("course-overview");
const firstMessage = '[data-session-find-root] [data-testid="user-message"]';
const composer = `${testId("composer")} [data-file-path-input]`;
const answerField = testId("answer-field");
const reveal = `${testId("teach-check-reveal")}, ${testId("question-dock-bar")}`;

export async function captureScreens({ page, origin, theme, stage, signal, withLessonComposer }) {
	const entries = [];
	const errors = [];
	const requests = new Set();
	const allowedPost = new Set([`${origin}/api/courses`, `${origin}/api/courses/deletion-impact`]);
	let lastNetworkActivity = performance.now();
	page.setDefaultTimeout(15_000);
	await page.setViewport(desktop);
	await page.emulateTimezone("UTC");
	await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
	await page.setCacheEnabled(false);
	await page.setRequestInterception(true);
	page.on("request", request => {
		const url = request.url();
		const local = url.startsWith(`${origin}/`) || url.startsWith("data:") || url.startsWith("blob:");
		// The blank class and the delete dialog's impact check use POST.
		// Catch accidental sends and automatic tutor continuations here.
		if (local && request.method() === "POST" && !allowedPost.has(url)) {
			errors.push(`Unexpected POST during capture: ${url}`);
			void request.abort().catch(() => {});
			return;
		}
		if (url.startsWith(`${origin}/`) && request.resourceType() !== "eventsource") {
			requests.add(request);
			lastNetworkActivity = performance.now();
		}
		void (local ? request.continue() : request.abort()).catch(() => {});
	});
	const finished = request => {
		if (requests.delete(request)) lastNetworkActivity = performance.now();
	};
	page.on("requestfinished", finished);
	page.on("requestfailed", finished);
	page.on("requestservedfromcache", finished);
	page.on("response", response => {
		const url = response.url();
		if (!url.startsWith(`${origin}/`)) return;
		if (response.status() >= 500 || (response.status() === 404 && response.request().isNavigationRequest())) {
			errors.push(`HTTP ${response.status()} from ${url}`);
		}
	});
	page.on("pageerror", error => errors.push(error.message));

	const visible = async selector => {
		try { return await page.waitForSelector(selector, { visible: true }); }
		catch (error) { throw new Error(`Waiting for visible ${selector}: ${error.message}`, { cause: error }); }
	};
	const click = selector => page.locator(selector).click();
	const scroll = async (selector, block = "start") => {
		await visible(selector);
		await page.$eval(selector, (element, align) => element.scrollIntoView({ block: align, behavior: "instant" }), block);
	};
	const checkPage = async () => {
		signal.throwIfAborted();
		if (errors.length) throw new Error(errors.join("\n"));
		const problem = await page.evaluate(() => {
			for (const portal of document.querySelectorAll("nextjs-portal")) {
				const overlay = portal.shadowRoot?.querySelector('[data-nextjs-dialog], [data-nextjs-error-overlay], [data-nextjs-toast]');
				if (overlay?.getBoundingClientRect().height) return overlay.textContent;
			}
			const text = document.body?.innerText ?? "";
			return text.match(/This page could not be found|Application error: a (?:server|client)-side exception|Internal Server Error|Something went wrong: the model provider/i)?.[0];
		});
		if (problem) throw new Error(problem.trim());
	};
	const settle = async () => {
		// Persistent EventSource connections are excluded above. Every other
		// local request must finish before the quiet period starts.
		const start = performance.now();
		while (requests.size || performance.now() - Math.max(start, lastNetworkActivity) < 400) {
			if (performance.now() - start > 15_000) {
				throw new Error(`Waiting for network idle: ${[...requests].map(request => request.url()).join(", ")}`);
			}
			await delay(50, undefined, { signal });
		}
		await page.evaluate(async () => {
			await document.fonts.ready;
			await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		});
		await checkPage();
	};
	const visit = async (path, ready) => {
		signal.throwIfAborted();
		const response = await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });
		if (!response?.ok()) throw new Error(`HTTP ${response?.status() ?? "unknown"} while opening ${path}`);
		await checkPage();
		await visible(ready);
		await page.waitForFunction(mode => document.documentElement.classList.contains(mode), {}, theme);
		await settle();
	};
	const capture = async (number, name, description, target) => {
		const file = `${String(number).padStart(2, "0")}-${name}-${theme}.png`;
		await settle();
		const options = { path: join(stage, file) };
		if (target) await (await visible(target)).screenshot(options);
		else await page.screenshot(options);
		await checkPage();
		entries.push({ file, description });
		console.log(file);
	};
	const openQuestion = async control => {
		const state = await visible(`${control}, ${reveal}`);
		if (await state.evaluate(element => element.matches("[data-testid='teach-check-reveal'], [data-testid='question-dock-bar']"))) {
			await state.click();
		}
		await visible(control);
	};

	try {
		await visit("/today", testId(`today-course-${ids.biology}`));
		await visible(testId("course-row"));
		await visible(`[data-session-id="${ids.lesson}"]`);
		await capture(1, "today", "Today’s study plan with classes and recent sessions in the sidebar.");

		await visit("/", "main canvas");
		await capture(2, "graph", "Home knowledge graph with propositions, course clustering, and the new-session composer.");

		await visit(course, matchesCourse);
		await capture(3, "class-overview", "AP Biology class overview with study modes, exam plan, and progress.");
		await click(testId("map-toggle"));
		await scroll(testId("course-map"), "center");
		await capture(4, "class-skill-map", "Expanded prerequisite map for eight approved AP Biology skills.");
		await click(testId("map-toggle"));

		await click(testId("course-settings-toggle"));
		await visible(testId("course-pace"));
		await capture(5, "class-settings", "Course settings with pace, curriculum, exam, and placement controls.");
		await click(testId("stats-materials"));
		await visible(testId(`material-${ids.material}`));
		await capture(6, "class-materials", "Course curriculum popover with an indexed cellular energetics PDF.");
		await click(testId("stats-materials"));
		await page.waitForSelector(testId(`material-${ids.material}`), { hidden: true });
		await click(testId("course-settings-toggle"));

		await click(testId("coverage-toggle"));
		await scroll(testId("course-coverage"), "center");
		await visible(testId("coverage-detail"));
		await capture(7, "class-coverage", "Vocabulary coverage showing a newly indexed term awaiting assignment.");
		await click(testId("course-sessions-finished-toggle"));
		await scroll(testId("course-sessions"));
		await visible(testId("course-sessions-finished"));
		await capture(8, "class-sessions", "Course session history with active and finished sessions.");

		await visit(lesson, firstMessage);
		await scroll(firstMessage, "center");
		await visible(".katex-display");
		await capture(9, "lesson-top", "Lesson opening with a numbered explanation and inline and display math.");
		await scroll(testId("visual-card"));
		await page.waitForFunction(selector => document.querySelector(selector)?.naturalWidth > 0, {}, `${testId("visual-svg")} img`);
		await capture(10, "lesson-figure", "Stored figure of proton flow through ATP synthase, with caption and reading cues.");
		const mermaid = `${testId("md-mermaid")} svg`;
		await scroll(mermaid, "center");
		await capture(11, "lesson-mermaid", "Mermaid flowchart tracing energy from NADH to ATP production.");
		await openQuestion(answerField);
		await capture(12, "lesson-mid", "Written-answer question open after the tutor’s explanation.");
		const answered = testId("answered-card");
		await scroll(answered);
		await capture(13, "answered-card", "Close-up of a graded written answer with its key points.", answered);

		await withLessonComposer(async () => {
			await visit(lesson, composer);
			await scroll(testId("dock-spacer"), "end");
			await capture(14, "lesson-bottom", "Bottom of the lesson before the next check, with the standard composer.");
			await click(composer);
			await page.keyboard.type("Would the same thing happen if the membrane were damaged?");
			await capture(15, "composer-focused", "Focused lesson composer with a draft follow-up question.");
		});

		await visit(`/chat/${ids.quiz}`, firstMessage);
		const options = '[data-question-options] [data-kbdrow]';
		await openQuestion(options);
		await click(`${options}:first-child`);
		await visible(testId("confidence-row"));
		await capture(16, "multiple-choice", "Multiple-choice prediction with an option selected and the confidence control visible.");

		await visit(`/chat/${ids.practice}`, testId("practice-dock"));
		await visible(testId("conclude-card"));
		await capture(17, "practice", "AP practice with a graded problem and the next problem ready for an answer.");
		await visit(`/chat/${ids.ask}`, composer);
		await visible(firstMessage);
		await capture(18, "ask", "Course Ask conversation about why plants need both chloroplasts and mitochondria.");

		const session = `[data-session-id="${ids.lesson}"]`;
		await (await visible(session)).click({ button: "right" });
		await visible(testId("session-context-menu"));
		await capture(19, "session-menu", "Open session context menu in the populated sidebar.");
		await click(testId("ctx-delete"));
		await visible(testId("delete-session-dialog"));
		await capture(20, "delete-dialog", "Session deletion confirmation.");
		await click(testId("delete-cancel"));

		await click(testId("settings-entry"));
		for (const [number, tab, name, description, ready] of [
			[21, "general", "general", "General preferences and updates."],
			[22, "appearance", "appearance", "Appearance preferences and shipped theme presets."],
			[23, "agent", "models", "Agent settings with the Strong, Cheap, and Vision model slots."],
			[24, "keys", "providers", "Provider and connection settings."],
			[25, "pdf", "pdf-conversion", "PDF conversion settings with the built-in reader selected.", "converters-section"],
		]) {
			await click(testId(`settings-nav-${tab}`));
			await visible(testId(ready ?? `section-${tab}`));
			await capture(number, `settings-${name}`, description);
		}
		await page.keyboard.press("Escape");

		await visit("/chat/new", composer);
		await capture(26, "empty-session", "Empty new-session screen.");
		if (theme === "dark") {
			await page.setViewport(narrow);
			await visit("/", "main canvas");
			await capture(28, "home-1024", "Graph home and sidebar at 1024 × 768.");
			await visit(lesson, firstMessage);
			await scroll(firstMessage, "center");
			await capture(29, "lesson-1024", "Lesson opening at 1024 × 768.");
			await visit(course, matchesCourse);
			await capture(30, "class-1024", "Class overview at 1024 × 768.");
			await page.setViewport(desktop);
		}

		await click(testId("new-course"));
		await page.waitForFunction(() => document.querySelector('[data-testid="course-title"]')?.value === "Untitled course");
		await visible(testId("course-curriculum"));
		await capture(27, "new-class", "First step of a new class, with title and curriculum setup.");
		return entries;
	} catch (error) {
		await checkPage();
		throw new Error(`Capture failed in ${theme} after ${entries.at(-1)?.file ?? "opening the first screen"} (${page.url()}): ${error.message}`, { cause: error });
	}
}
