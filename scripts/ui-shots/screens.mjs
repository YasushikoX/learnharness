import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ids } from "./scenario.mjs";
import { captureSmallSurfaces } from "./small-surfaces.mjs";

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

export async function captureScreens({ page, origin, theme, stage, signal, withLessonComposer, withCourse, withEmptyLibrary }) {
	const entries = [];
	const errors = [];
	const requests = new Set();
	const allowedPost = new Set([`${origin}/api/courses`, `${origin}/api/courses/deletion-impact`]);
	let lastNetworkActivity = performance.now();
	// UI round 8: per-shot request routes, to reach a state the fixture cannot hold (a pass running, a card's status, a
	// request still loading). `match` gets the URL; the newest route wins. Each returns its own remover.
	const routes = [];
	const track = request => { requests.add(request); lastNetworkActivity = performance.now(); };
	const untrack = request => { if (requests.delete(request)) lastNetworkActivity = performance.now(); };
	const addRoute = (method, match, handle) => {
		const entry = { method, match, handle };
		routes.push(entry);
		return () => {
			const index = routes.indexOf(entry);
			if (index >= 0) routes.splice(index, 1);
			entry.release?.();
		};
	};
	const respondJson = async (request, status, body) => {
		track(request);
		try { await request.respond({ status, contentType: "application/json", body: JSON.stringify(body) }); }
		finally { untrack(request); }
	};
	const route = {
		/** Answer with this JSON (a faked POST: the server starts nothing). */
		json: (method, match, body, status = 200) => addRoute(method, match, request => respondJson(request, status, body)),
		/** The server's real JSON, changed by `patch`. */
		patch: (method, match, patch) => addRoute(method, match, async request => {
			track(request);
			try {
				const response = await fetch(request.url(), { headers: request.headers(), signal: AbortSignal.timeout(10_000) });
				await respondJson(request, response.status, patch(await response.json()));
			} finally { untrack(request); }
		}),
		/** A network failure. */
		fail: (method, match) => addRoute(method, match, request => request.abort("failed")),
		/** Never answered while the route stands (a loading state); the remover lets it through. */
		hold: (method, match) => {
			const held = [];
			const remove = addRoute(method, match, request => { held.push(request); });
			routes.at(-1).release = () => { for (const request of held.splice(0)) void request.continue().catch(() => {}); };
			return remove;
		},
	};
	page.setDefaultTimeout(15_000);
	await page.setViewport(desktop);
	await page.emulateTimezone("UTC");
	await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
	await page.setCacheEnabled(false);
	await page.setRequestInterception(true);
	page.on("request", request => {
		const url = request.url();
		const local = url.startsWith(`${origin}/`) || url.startsWith("data:") || url.startsWith("blob:");
		const routed = url.startsWith(`${origin}/`) && routes.findLast(entry => entry.method === request.method() && entry.match(new URL(url)));
		if (routed) {
			void Promise.resolve(routed.handle(request)).catch(error => errors.push(`Route for ${url}: ${error.message}`));
			return;
		}
		const readsDrawingSettings = url === `${origin}/api/plugins/drawing-pad/call` &&
			request.postData() === '{"operation":"get-settings"}';
		// The blank class, delete impact check and plugin settings read use POST.
		// Catch accidental sends and automatic tutor continuations here.
		if (local && request.method() === "POST" && !allowedPost.has(url) && !readsDrawingSettings) {
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
		if (typeof target === "string") await (await visible(target)).screenshot(options);
		else if (target?.around) {
			// UI round 8: a small surface with some of the page around it, so its anchor and placement show
			for (const selector of target.around) await visible(selector);
			const clip = await page.evaluate((selectors, pad) => {
				const boxes = selectors.flatMap(selector => [...document.querySelectorAll(selector)])
					.map(element => element.getBoundingClientRect()).filter(box => box.width && box.height);
				const left = Math.max(0, Math.min(...boxes.map(box => box.left)) - pad);
				const top = Math.max(0, Math.min(...boxes.map(box => box.top)) - pad);
				const right = Math.min(innerWidth, Math.max(...boxes.map(box => box.right)) + pad);
				const bottom = Math.min(innerHeight, Math.max(...boxes.map(box => box.bottom)) + pad);
				return { x: left, y: top, width: right - left, height: bottom - top };
			}, target.around, target.pad ?? 48);
			await page.screenshot({ ...options, clip });
		} else await page.screenshot(options);
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
	// UI round 8: the small surfaces and in-between states (small-surfaces.mjs), after the main screens.
	// LH_UI_SHOTS_SMALL_ONLY=1 runs only these, for working on the kit.
	const small = () => captureSmallSurfaces({
		page, theme, desktop, narrow, testId, visit, visible, click, scroll, settle, capture, route,
		withLessonComposer, withCourse, withEmptyLibrary,
	});

	try {
		if (process.env.LH_UI_SHOTS_SMALL_ONLY === "1") {
			await small();
			return entries;
		}
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

		await visible(testId("course-pace"));
		await capture(5, "class-panel", "Class side panel: files, skill map, exam, starting point, pace, lecture notes.", testId("class-side-panel"));
		// WP9: "Where you stand" at the top of Next up, and the lecture timeline in the side panel
		await capture(61, "class-where-you-stand", "Next up with Where you stand: the class's lecture, what you have learned, the next quiz's readiness, the gap's Start.", testId("course-next-up"));
		await scroll(testId("lectures"), "center");
		await capture(62, "class-lectures", "The lecture timeline in the side panel: the class's position marked, skills per lecture.", testId("lectures"));
		await click(testId(`material-remove-${ids.material}`));
		await visible(testId(`material-remove-confirm-${ids.material}`));
		await capture(6, "class-files", "Class files in the side panel with the remove confirm open.", testId("class-files"));
		await click(testId(`material-remove-cancel-${ids.material}`));
		await page.waitForSelector(testId(`material-remove-confirm-${ids.material}`), { hidden: true });

		await click(testId("coverage-toggle"));
		await scroll(testId("course-coverage"), "center");
		await visible(testId("coverage-detail"));
		await capture(7, "class-coverage", "Vocabulary coverage showing a newly indexed term awaiting assignment.");
		await scroll(testId("course-sessions"));
		if (await page.$(testId("course-sessions-all"))) await click(testId("course-sessions-all"));
		await capture(8, "class-sessions", "Recent sessions of the class under Next up, all shown.");

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
		// WP9: the change cards for a lecture moved, the class's position and an exam weight, each with Undo
		const cards = await page.$$(testId("class-change"));
		if (cards.length > 0) await cards.at(-1).evaluate(node => node.scrollIntoView({ block: "center" }));
		await capture(63, "ask-class-cards", "Short question's change cards: a lecture moved, the class position, an exam weight, each with Undo.");

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
		await click(testId("converter-wizard-open"));
		await scroll(testId("wizard-name-row"), "center");
		await capture(50, "settings-converter-wizard", "Converter wizard with its documentation source and service fields.");

		await click(testId("settings-nav-agent"));
		await click(`${testId("group-prompts")} [data-testid^="prompt-row-"] button:first-of-type`);
		await capture(51, "settings-prompt-dialog", "Nested prompt segment dialog showing the shipped prompt.");
		await page.keyboard.press("Escape");

		await click(testId("settings-nav-sync"));
		await visible(testId("sync-token-row"));
		await capture(52, "settings-sync", "Repository and token controls in the Sync settings.");

		await click(testId("settings-nav-core-plugins"));
		const drawingPad = testId("plugin-drawing-pad");
		const drawingSwitch = `${drawingPad} [role="switch"]`;
		const drawingSettings = `${drawingPad} button[aria-label="Settings for Drawing Pad"]`;
		await click(drawingSwitch);
		await visible(drawingSettings);
		await capture(53, "settings-core-plugins", "Core plugin rows with settings actions and enabled switches.");
		await click(drawingSettings);
		await visible(`${testId("section-plugin-drawing-pad")} [data-plugin-setting]`);
		await capture(54, "settings-plugin-page", "Drawing Pad’s declarative settings.");
		await click(testId("settings-nav-core-plugins"));
		await click(drawingSwitch);
		await visible(`${drawingSwitch}[aria-checked="false"]`);

		await click(testId("settings-nav-appearance"));
		await scroll(testId("group-colors"));
		await capture(55, "settings-appearance-overrides", "Theme color overrides and their shared fields.");

		await click(testId("settings-nav-keys"));
		await click(testId("key-anthropic_api_key-row"));
		await visible(testId("key-anthropic_api_key-input"));
		await capture(56, "settings-key-editor", "Inline provider key editor before any change is entered.");
		await page.keyboard.press("Escape");
		await page.keyboard.press("Escape");

		await page.setViewport(narrow);
		await click('button[aria-label="Close sidebar"]');
		const modifier = await page.evaluate(() => navigator.platform.includes("Mac") ? "Meta" : "Control");
		await page.keyboard.down(modifier);
		await page.keyboard.press(",");
		await page.keyboard.up(modifier);
		await visible(testId("settings-dialog"));
		await capture(57, "settings-providers-1024", "Providers at 1024 × 768 with the app sidebar collapsed.");
		await click(testId("settings-nav-agent"));
		await visible(testId("group-models"));
		await capture(58, "settings-models-1024", "Model and role controls at 1024 × 768 with the app sidebar collapsed.");
		await page.keyboard.press("Escape");

		await page.setViewport({ ...narrow, width: 360 });
		await page.keyboard.down(modifier);
		await page.keyboard.press(",");
		await page.keyboard.up(modifier);
		await visible(testId("settings-list"));
		await capture(59, "settings-categories-360", "Full-screen Settings category list at 360 px.");
		await page.setViewport({ ...narrow, width: 412 });
		await click(testId("settings-list-keys"));
		await click(testId("key-anthropic_api_key-row"));
		await visible(testId("key-anthropic_api_key-input"));
		await capture(60, "settings-key-editor-412", "Full-screen provider key editor at 412 px.");
		await page.keyboard.press("Escape");
		await page.keyboard.press("Escape");
		await page.setViewport(narrow);
		await click('button[aria-label="Open sidebar"]');
		await page.setViewport(desktop);
		// Opening the sidebar refetches its lists; a navigation that cancels those reads leaves them pending forever.
		await settle();

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
			await click(testId("class-panel-toggle"));
			await visible(testId("class-files"));
			await capture(31, "class-1024-panel", "Class overview at 1024 × 768 with the side panel opened from the header.");
			await page.setViewport(desktop);
		}

		await click(testId("new-course"));
		// a new class (owner, UI round 8): no side panel; a labelled "Class name" field at the top of the setup card, empty
		// and focused; "New class" muted in the top bar
		await page.waitForFunction(() => {
			const field = document.querySelector('[data-testid="setup-name-input"]');
			return location.pathname.startsWith("/course/") && field?.value === "" && document.activeElement === field;
		});
		await visible(testId("class-setup"));
		await capture(27, "new-class", "A new class: the Class name field at the top of the setup card (focused), the checklist, Delete class… in its footer, no side panel.");
		if (theme === "dark") {
			await page.setViewport(narrow);
			await settle();
			await capture(32, "new-class-1024", "A new class at 1024 × 768: no side panel and no panel toggle (the checklist holds the files).");
			await page.setViewport(desktop);
			await settle();
			await page.focus('[data-testid="setup-name-input"]');
		}
		await page.keyboard.type("Linear Algebra");
		await page.keyboard.press("Enter");
		await visible(testId("setup-name-saved"));
		await capture(64, "new-class-named", "The new class after typing its name and Enter: the quiet Saved tick, and the name in the top bar.");

		await small();
		return entries;
	} catch (error) {
		await checkPage();
		throw new Error(`Capture failed in ${theme} after ${entries.at(-1)?.file ?? "opening the first screen"} (${page.url()}): ${error.message}`, { cause: error });
	}
}
