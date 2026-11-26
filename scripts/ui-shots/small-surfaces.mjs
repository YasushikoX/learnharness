import { ids } from "./scenario.mjs";

/**
 * UI round 8 (2026-11-25): the small surfaces and the states between screens — dialogs and confirms, menus and
 * popovers, tooltips, inline notices, loading, empty and error states, panels at 1024 and the inline forms. Shots are
 * numbered 70a… and 80a… so they sort after the main screens. A state the fixture cannot hold (a pass running, a card's
 * status, a request still loading) comes from a per-shot request route; a failed pass is written into the class's
 * record for one visit (withCourse); the first-run states hide the seeded classes and sessions (withEmptyLibrary).
 */
export async function captureSmallSurfaces(kit) {
	const { page, theme, desktop, narrow, testId, visit, visible, click, scroll, settle, capture, route } = kit;
	const { withLessonComposer, withCourse, withEmptyLibrary } = kit;
	const course = id => `/course/${id}`;
	const api = id => `/api/courses/${id}`;
	const at = (path, query) => url => url.pathname === path && (query === undefined || url.search.includes(query));
	const hidden = selector => page.waitForSelector(selector, { hidden: true });
	/** Esc, and when focus left the surface so Esc does not reach it, a click on its trigger. */
	const escape = async (selector, trigger) => {
		await page.keyboard.press("Escape");
		if (!selector) return;
		if (trigger) {
			const closed = await page.waitForSelector(selector, { hidden: true, timeout: 1_000 }).then(() => true, () => false);
			if (!closed) await click(trigger);
		}
		await hidden(selector);
	};
	const rightClick = async selector => (await visible(selector)).click({ button: "right" });
	const hover = async selector => {
		await page.mouse.move(1, 1);
		await (await visible(selector)).hover();
	};
	const tooltip = '[data-slot="tooltip-content"]';
	const hint = async selector => {
		await hover(selector);
		await visible(tooltip);
	};
	/** Mark the first `selector` whose text has `text` and answer a selector for it. */
	const byText = async (selector, text, name) => {
		await page.waitForFunction((s, t) => [...document.querySelectorAll(s)].some(element => element.textContent.includes(t)), {}, selector, text);
		await page.evaluate((s, t, n) => {
			document.querySelector(`[data-shot="${n}"]`)?.removeAttribute("data-shot");
			[...document.querySelectorAll(s)].find(element => element.textContent.includes(t)).setAttribute("data-shot", n);
		}, selector, text, name);
		return `[data-shot="${name}"]`;
	};
	const clickText = async (scope, text) => click(await byText(`${scope} button`, text, "click-target"));
	/** Open any closed <details> around the element, then bring it into view. */
	const reveal = async selector => {
		await page.$eval(selector, element => {
			for (let node = element.parentElement; node; node = node.parentElement) if (node instanceof HTMLDetailsElement) node.open = true;
			element.scrollIntoView({ block: "center", behavior: "instant" });
		});
	};
	const sidebar = testId("sidebar");
	const panel = testId("class-side-panel");

	// ── Sidebar menus and rename ────────────────────────────────────────────────────────────────────────────────
	await visit(course(ids.biology), testId("course-overview"));
	const session = `[data-session-id="${ids.lesson}"]`;
	await hover(session);
	// the "…" button shows on hover only: click it where it is, without the locator's visibility wait
	await (await page.waitForSelector(`:has(> ${session}) > ${testId("session-menu-trigger")}`)).click();
	await visible(testId("session-context-menu"));
	await capture("71a", "session-more-menu", "The session row's “…” button with its menu open, in the sidebar.", { around: [session, testId("session-context-menu")] });
	await click(testId("ctx-rename"));
	await visible(testId("session-rename-input"));
	await capture("70a", "session-rename", "Renaming a session inline in the sidebar (the rename field, focused).", { around: [testId("session-rename-row")], pad: 64 });
	await escape(testId("session-rename-input"));

	const chemistryRow = await byText(testId("course-row"), "Organic Chemistry", "chemistry-row");
	await rightClick(chemistryRow);
	await visible(testId("course-context-menu"));
	await capture("71b", "class-row-menu", "The class row's menu (right-click a class in the sidebar): Rename, Folder, Delete.", { around: [chemistryRow, testId("course-context-menu")] });
	await click(testId("ctx-course-folder"));
	await visible(testId("folder-option-new"));
	await capture("71c", "class-row-menu-folders", "The class row's Folder list: No folder, the folders in use (current one ticked), New folder….", { around: [chemistryRow, testId("course-context-menu")] });
	await escape(testId("course-context-menu"));
	const classFolder = `${testId("course-folder")}[data-folder="${ids.chemistryFolder}"] ${testId("course-folder-header")}`;
	await rightClick(classFolder);
	await visible(testId("folder-context-menu"));
	await capture("71d", "class-folder-menu", "The menu of a class folder header (Spring term): Rename folder, Remove folder.", { around: [classFolder, testId("folder-context-menu")] });
	await escape(testId("folder-context-menu"));
	const sessionFolder = `${testId(`sidebar-folder-row-${ids.sessionFolder}`)} button`;
	await scroll(sessionFolder, "center");
	await rightClick(sessionFolder);
	await visible(testId("folder-context-menu"));
	await capture("71e", "session-folder-menu", "The menu of a session folder (Extra reading) in the sidebar: Rename, New subfolder, Delete.", { around: [testId(`sidebar-folder-row-${ids.sessionFolder}`), testId("folder-context-menu")] });
	await escape(testId("folder-context-menu"));

	await hint('button[aria-label="Close sidebar"]');
	await capture("75a", "tooltip-sidebar", "Tooltip on the sidebar's Close sidebar icon button, with its shortcut.", { around: ['button[aria-label="Close sidebar"]', tooltip], pad: 40 });
	await page.mouse.move(700, 450);
	await hidden(tooltip);

	// ── The class side panel: delete, forms and its menus ──────────────────────────────────────────────────────
	await scroll(testId("course-delete"), "center");
	await click(testId("course-delete"));
	await visible(testId("delete-course-dialog"));
	await capture("70b", "delete-class-dialog", "Delete class confirmation, opened from the side panel (what is lost, what stays).");
	await click(testId("delete-course-cancel"));
	await hidden(testId("delete-course-dialog"));

	await scroll(testId("upcoming"), "start");
	await click(testId("upcoming-add"));
	await visible(testId("upcoming-form-new"));
	await click(testId("upcoming-form-new-date"));
	await capture("85a", "assessment-form-new", "The Upcoming list's add form: kind select, title, date field (focused), topics, skills it covers.", { around: [testId("upcoming")], pad: 0 });
	await clickText(testId("upcoming-form-new"), "Cancel");
	await hidden(testId("upcoming-form-new"));
	await click(testId("upcoming-item-as_ui_quiz3"));
	await visible(testId("upcoming-form-as_ui_quiz3"));
	await capture("85b", "assessment-form-edit", "Editing Quiz 3 in the Upcoming list, with Delete.", { around: [testId("upcoming")], pad: 0 });
	await clickText(testId("upcoming-form-as_ui_quiz3"), "Cancel");
	await hidden(testId("upcoming-form-as_ui_quiz3"));

	await scroll(testId("lectures"), "start");
	await click(testId("lecture-add"));
	await visible(testId("lecture-form-new"));
	await capture("85c", "lecture-form-new", "The lecture timeline's add form in the side panel.", { around: [testId("lectures")], pad: 0 });
	await clickText(testId("lecture-form-new"), "Cancel");
	await hidden(testId("lecture-form-new"));

	await scroll(testId("course-lecture-notes"), "center");
	await click(testId("lecture-note-new"));
	await visible(testId("lecture-note-dialog"));
	await capture("85d", "lecture-note-dialog", "The new lecture note dialog with its date field.");
	await escape(testId("lecture-note-dialog"));

	const panelLanguage = `${testId("course-curriculum")} ${testId("stats-language")}`;
	await scroll(testId("course-curriculum"), "start");
	await click(panelLanguage);
	await visible(testId("language-menu"));
	await capture("73a", "class-language-menu", "The class language menu in the side panel's Skill map section.", { around: [testId("course-curriculum"), testId("language-menu")], pad: 16 });
	await escape(testId("language-menu"), panelLanguage);
	await scroll(testId("course-pace"), "center");
	await click(`${testId("course-pace")} select`);
	await capture("73b", "class-pace-select", "The class pace select (a native select, focused) and the rows around it.", { around: [testId("class-settings")], pad: 8 });
	await page.keyboard.press("Escape");

	// ── Where you stand and the skill rows ─────────────────────────────────────────────────────────────────────
	await scroll(testId("where-you-stand"), "center");
	await click(testId("standing-class-edit"));
	await visible(testId("standing-position-form"));
	await capture("85e", "position-editor", "Correcting where the class is: lecture select, covered, note, Save.", { around: [testId("where-you-stand")], pad: 16 });
	await clickText(testId("standing-position-form"), "Cancel");
	await hidden(testId("standing-position-form"));

	for (const [number, skill, name, ready, description] of [
		["85f", "sk_glycolysis", "skill-weight-editor", testId("weight-editor-sk_glycolysis"), "An open skill row with the exam weight editor (0–3 and Reset)."],
		["85g", "sk_calvin", "self-report-detail", testId("skill-self-report-remove-sk_calvin"), "An open skill row with what you said about it (Don't get yet) and Remove."],
	]) {
		const row = testId(`skill-${skill}`);
		await reveal(row);
		await click(`${row} > button`);
		await visible(ready);
		await reveal(row);
		await capture(number, name, description, { around: [row], pad: 24 });
		await click(`${row} > button`);
		await hidden(ready);
	}

	// ── Upcoming and the lectures: passes running, failed, and the notice ───────────────────────────────────────
	const finding = [
		route.json("POST", at(`${api(ids.biology)}/assessments/find`), { ok: true }),
		route.patch("GET", at(api(ids.biology)), view => ({ ...view, upcoming: { ...view.upcoming, finding: true } })),
	];
	await scroll(testId("upcoming"), "start");
	await click(testId("upcoming-find"));
	await visible(testId("upcoming-finding"));
	await capture("80a", "upcoming-finding", "Find in syllabus running: “Reading the syllabus…” in the Upcoming list.", { around: [testId("upcoming")], pad: 0 });
	for (const remove of finding) remove();

	await visit(course(ids.biology), testId("course-overview"));
	// what the server answers after an approval: the new item in the list, the proposal gone, one item skipped
	const approve = [
		route.json("POST", at(`${api(ids.biology)}/assessments/proposal`), { ok: true, skipped: 1 }),
		route.patch("GET", at(api(ids.biology)), view => {
			const { proposal, ...upcoming } = view.upcoming;
			const added = proposal.items.filter(item => item.status === "new").map(item => ({
				id: `as_ui_${item.key}`, kind: item.kind, title: item.title, date: item.date, topics: item.topics,
				skillIds: item.skillIds, source: "syllabus", updatedAt: proposal.createdAt,
			}));
			const items = [...upcoming.items, ...added].sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));
			return { ...view, upcoming: { ...upcoming, items } };
		}),
	];
	await scroll(testId("upcoming-proposal"), "center");
	await click(testId("proposal-approve"));
	await visible(testId("upcoming-notice"));
	await hidden(testId("upcoming-proposal"));
	await capture("76a", "upcoming-notice", "The Upcoming list's notice after Add it on the syllabus proposal (Quiz 4 added, one item left as you changed it).", { around: [testId("upcoming")], pad: 0 });
	for (const remove of approve) remove();

	const weighing = [
		route.json("POST", at(`${api(ids.biology)}/weigh`), { ok: true }),
		route.patch("GET", at(api(ids.biology)), view => ({ ...view, weighing: true })),
	];
	await visit(course(ids.biology), testId("course-overview"));
	// a weighed class has its Weigh again in the side panel; since round 8 the running state is that button itself
	await scroll(testId("course-exam-settings"), "center");
	await click(`${testId("course-exam-settings")} ${testId("course-weigh-button")}`);
	await visible(testId("course-weighing"));
	await capture("80b", "weighing", "Weigh again running: the button itself shows “Weighing…” with its spinner, in the side panel.", { around: [testId("class-settings")], pad: 8 });
	for (const remove of weighing) remove();

	await withCourse(ids.biology, record => ({
		...record,
		assessmentsError: "the model's reply was cut off before it listed any dates",
		lecturesLinkError: "the model's reply could not be read as a list of lectures",
		weightsError: "429 rate limited: the provider asks to wait 40 s",
	}), async () => {
		await visit(course(ids.biology), testId("course-overview"));
		await scroll(testId("upcoming"), "start");
		await visible(testId("upcoming-error"));
		await capture("82a", "upcoming-error", "A failed syllabus pass: “Finding failed: …” in the Upcoming list.", { around: [testId("upcoming")], pad: 0 });
		await scroll(testId("lectures"), "center");
		await visible(testId("lectures-unplaced"));
		await capture("82b", "lectures-link-error", "A failed linking step: “Placing skills failed: …” with Place skills, under the lectures.", { around: [testId("lectures")], pad: 0 });
		await scroll(testId("course-exam-settings"), "center");
		await visible(testId("course-weights-error"));
		await capture("82c", "weights-error", "A failed weighing pass: the shared notice under Weigh again in the side panel, with Try again.", { around: [testId("class-settings")], pad: 8 });
		const linking = [
			route.json("POST", at(`${api(ids.biology)}/lectures/link`), { ok: true }),
			route.patch("GET", at(api(ids.biology)), view => ({ ...view, standing: { ...view.standing, linking: true, linkError: undefined } })),
		];
		await scroll(testId("lectures"), "center");
		await click(testId("lectures-link-error-retry"));
		await visible(testId("lectures-linking"));
		await capture("80c", "lectures-linking", "The linking step running: the button shows “Placing the skills…” with its spinner.", { around: [testId("lectures")], pad: 0 });
		for (const remove of linking) remove();
	});

	// ── A class with a file and no skill map: ready, drafting, failed ───────────────────────────────────────────
	await visit(course(ids.chemistry), testId("class-setup"));
	await visible(testId("setup-draft"));
	await capture("81a", "class-files-no-map", "Organic Chemistry: one file read, no skill map yet — the setup checklist at step 2, Draft skill map.");
	const drafting = [
		route.json("POST", at(`${api(ids.chemistry)}/draft`), { ok: true }),
		route.patch("GET", at(api(ids.chemistry)), view => ({ ...view, drafting: true })),
	];
	await click(testId("setup-draft"));
	await visible(testId("setup-drafting"));
	await capture("80d", "drafting-skill-map", "Drafting the skill map: the spinner line in the checklist and the side panel.");
	for (const remove of drafting) remove();
	await withCourse(ids.chemistry, record => ({ ...record, error: "the request timed out after 120 s" }), async () => {
		await visit(course(ids.chemistry), testId("setup-error"));
		await capture("82d", "draft-failed", "A failed draft: “Drafting failed: …” with Try again, and the side panel's error line.");
	});

	// ── A class with a map and no files: the disabled Draft with its reason, empty lists ────────────────────────
	await visit(course(ids.calculus), testId("course-overview"));
	await visible(testId("course-draft-reason"));
	await capture("83a", "disabled-draft-reason", "Calculus I side panel: Re-draft disabled with its reason, empty Upcoming and Lectures, Find in syllabus disabled.", panel);

	// ── The composer toolbar's menus, popovers and tooltips ─────────────────────────────────────────────────────
	const composerBox = testId("composer");
	await withLessonComposer(async () => {
		await visit(`/chat/${ids.lesson}`, `${composerBox} [data-file-path-input]`);
		await scroll(testId("dock-spacer"), "end");
		for (const [number, trigger, menu, name, description] of [
			["72a", "stats-model", "model-menu", "model-menu", "The model menu opening upward from the composer toolbar, with the Effort (thinking level) row."],
			["72b", "stats-language", "language-menu", "language-menu", "The lesson language (EN) menu from the composer toolbar."],
			["72c", "stats-pace", "pace-menu", "pace-menu", "The session pace menu from the composer toolbar."],
			["72d", "stats-materials", "materials-menu", "sources-menu", "The Sources popover from the composer toolbar: add files, camera, a link."],
			["72e", "stats-summary", "stats-detail", "stats-popover", "The session stats popover (context and cost) from the composer toolbar."],
		]) {
			await click(testId(trigger));
			await visible(testId(menu));
			await capture(number, name, description, { around: [composerBox, testId(menu)], pad: 24 });
			await escape(testId(menu), testId(trigger));
		}
		await hint(testId("dictation-toggle"));
		await capture("75b", "tooltip-dictation", "Tooltip on the composer's microphone button.", { around: [testId("dictation-toggle"), tooltip], pad: 40 });
		await hint(testId("stats-model"));
		await capture("75c", "tooltip-model", "Tooltip on the composer toolbar's model control, with its shortcut.", { around: [testId("stats-model"), tooltip], pad: 40 });
		await page.mouse.move(700, 200);

		const now = Date.now();
		const usage = route.json("GET", at("/api/claude-code/usage"), {
			usage: { fiveHour: { utilization: 0.58, resetsAt: now + 134 * 60_000 }, sevenDay: { utilization: 0.31, resetsAt: now + 3 * 86_400_000 }, at: now },
		});
		await visit(`/chat/${ids.lesson}`, testId("plan-usage"));
		await scroll(testId("dock-spacer"), "end");
		await hint(testId("plan-usage"));
		await capture("72f", "plan-usage", "The Claude plan usage figure in the composer toolbar with its tooltip (5-hour window and week).", { around: [composerBox, tooltip], pad: 24 });
		usage();
		// No "session loading" shot: the session and class pages are server-rendered with their data, so neither has a
		// loading state to show (holding the settings read changes nothing on screen).
	});
	await settle();

	// ── A change card undone or changed since ───────────────────────────────────────────────────────────────────
	const changed = route.patch("GET", at(`/api/chats/${ids.ask}/class-changes`), statuses => {
		const first = Object.keys(statuses)[0];
		return first ? { ...statuses, [first]: "changed" } : statuses;
	});
	await visit(`/chat/${ids.ask}`, testId("class-change"));
	const changedCard = `${testId("class-change")}:has(${testId("class-change-status")})`;
	await scroll(changedCard, "center");
	await capture("76b", "change-card-changed", "A Short question change card in the “undone or changed since” state (no Undo), beside one that still has Undo.", { around: [changedCard], pad: 120 });
	changed();

	// ── The graph's settings and folder filter ──────────────────────────────────────────────────────────────────
	await visit("/", "main canvas");
	const gear = ".lh-wco-floating button[aria-expanded]:has(> svg.lucide-settings)";
	await click(gear);
	await page.waitForSelector(`${gear}[aria-expanded="true"]`);
	// the panel has no test id: it is the gear's sibling in the control's root
	await capture("74a", "graph-settings", "The graph's display settings panel, open under its gear.", { around: [".lh-wco-floating", ".lh-wco-floating div:has(> button[aria-expanded] > svg.lucide-settings) > div"], pad: 24 });
	await click(gear);
	await click(testId("graph-folder-filter"));
	await visible(testId("graph-folder-filter-panel"));
	await capture("74b", "graph-folder-filter", "The graph's folder filter popover (Show folders).", { around: [testId("graph-folder-filter"), testId("graph-folder-filter-panel")], pad: 32 });
	await escape(testId("graph-folder-filter-panel"), testId("graph-folder-filter"));

	await click(testId("session-search"));
	await page.keyboard.type("zzz no such session");
	await visible(`${sidebar}`);
	await settle();
	await capture("81b", "search-no-results", "The sidebar's session search with no results.", sidebar);

	// ── Settings: unsaved prompt edit, converter error ──────────────────────────────────────────────────────────
	await click(testId("settings-entry"));
	await click(testId("settings-nav-agent"));
	await click(await byText(`${testId("group-prompts")} [data-testid^="prompt-row-"] button`, "Add override", "add-override"));
	await visible(`${testId("prompt-segment-dialog")} textarea`);
	await capture("70c", "prompt-editor", "The prompt editor dialog in edit mode (+ Add override): the shipped text in a field, Save and activate.");
	await page.$eval(`${testId("prompt-segment-dialog")} textarea`, field => { field.focus(); field.setSelectionRange(0, 0); });
	await page.keyboard.type("Keep it short. ");
	await page.keyboard.press("Escape");
	await byText(`${testId("prompt-segment-dialog")} [role="status"]`, "Discard unsaved changes?", "discard-line");
	await capture("70d", "prompt-discard-confirm", "The prompt editor after an edit and Esc: “Discard unsaved changes?” with Keep editing and Discard changes.");
	await clickText(testId("prompt-segment-dialog"), "Discard changes");
	await hidden(testId("prompt-segment-dialog"));
	const converters = route.fail("GET", at("/api/converters"));
	await click(testId("settings-nav-pdf"));
	await visible(testId("converters-load-error"));
	await capture("82e", "converter-load-error", "Settings → PDF conversion when its settings cannot be loaded.");
	converters();
	await escape(testId("settings-dialog"));

	// ── First run: no classes, no sessions, nothing today ───────────────────────────────────────────────────────
	await withEmptyLibrary(async () => {
		await visit("/today", testId("today-empty"));
		await capture("81c", "empty-library", "First run: no classes, no sessions in the sidebar, and the empty Today.");
	});

	// ── A named class's title: a fill and a pencil on hover (owner, round 8) ───────────────────────────────────
	await visit(course(ids.biology), testId("course-overview"));
	await hover(testId("course-title"));
	await capture("86a", "class-title-hover", "The class title on hover: a faint fill and a pencil (click to rename).", { around: [testId("course-title")], pad: 48 });
	await page.mouse.move(700, 600);

	// ── Panels opening and closing ──────────────────────────────────────────────────────────────────────────────
	await visit(course(ids.biology), testId("course-overview"));
	await click('button[aria-label="Close sidebar"]');
	await visible('button[aria-label="Open sidebar"]');
	await capture("84a", "class-sidebar-collapsed", "The class page at 1440 with the left sidebar collapsed.");
	await page.setViewport(narrow);
	await settle();
	await capture("84b", "class-1024-sidebar-collapsed", "The class page at 1024 × 768 with the sidebar collapsed and the side panel closed.");
	await click(testId("class-panel-toggle"));
	await visible(testId("class-files"));
	await capture("84c", "class-1024-panel-open", "At 1024 × 768 with the sidebar collapsed, the side panel opened from the header: a sheet over the page (Esc or a click outside closes it).");
	// the 1024 sheet closes with Esc (its backdrop covers the header's toggle)
	await page.keyboard.press("Escape");
	await hidden(testId("class-panel-backdrop"));
	await click('button[aria-label="Open sidebar"]');
	await visible('button[aria-label="Close sidebar"]');
	await settle();
	await click(testId("settings-entry"));
	await visible(testId("settings-dialog"));
	await capture("84d", "settings-1024-sidebar-open", "Settings at 1024 × 768 with the app sidebar open behind it: the category list and Providers.");
	await escape(testId("settings-dialog"));
	await page.setViewport(desktop);
	await settle();
}
