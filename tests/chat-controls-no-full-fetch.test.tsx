import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import { Chat } from "../components/chat.tsx";
import { ActivityProvider } from "../components/activity-dock.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { PluginsProvider } from "../components/plugins.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import { AppearanceProvider } from "../components/settings/appearance.tsx";
import { SettingsDialogProvider } from "../components/settings/settings-dialog.tsx";
import { SidebarProvider } from "../components/sidebar.tsx";
import { DEFAULT_THEME } from "../src/core/themes.ts";
import type { ModelCatalogResponse } from "../src/core/index.ts";

const dom = parseHTML("<!doctype html><html><body></body></html>");
const noopObserver = class {
	observe() {}
	unobserve() {}
	disconnect() {}
};
const noopEventSource = class {
	addEventListener() {}
	removeEventListener() {}
	close() {}
};
function memoryStorage() {
	const map = new Map<string, string>();
	return {
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => { map.set(k, String(v)); },
		removeItem: (k: string) => { map.delete(k); },
		clear: () => { map.clear(); },
		key: (i: number) => [...map.keys()][i] ?? null,
		get length() { return map.size; },
	};
}
const localStorageStub = memoryStorage();
const sessionStorageStub = memoryStorage();
const getComputedStyleStub = () => ({
	overflowY: "auto",
	overflowX: "hidden",
	getPropertyValue: () => "",
});
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	Node: dom.window.Node,
	CustomEvent: dom.window.CustomEvent,
	Event: dom.window.Event,
	EventSource: noopEventSource,
	localStorage: localStorageStub,
	sessionStorage: sessionStorageStub,
	getComputedStyle: getComputedStyleStub,
	MutationObserver: noopObserver,
	ResizeObserver: noopObserver,
	IntersectionObserver: noopObserver,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
	cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
	IS_REACT_ACT_ENVIRONMENT: true,
});
const locationStub = { hash: "", pathname: "/", search: "", href: "http://localhost/" };
const historyStub = { replaceState() {}, pushState() {} };
Object.assign(globalThis, {
	location: locationStub,
	history: historyStub,
});
Object.assign(dom.window, {
	matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
	localStorage: localStorageStub,
	sessionStorage: sessionStorageStub,
	getComputedStyle: getComputedStyleStub,
	getSelection: () => null,
	location: locationStub,
	history: historyStub,
	ResizeObserver: noopObserver,
	IntersectionObserver: noopObserver,
	scrollTo() {},
});
Object.assign(dom.document, {
	getSelection: () => null,
});
Object.assign(dom.window.Element.prototype, {
	getAnimations: () => [],
	scrollIntoView() {},
	scrollTo() {},
});
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node-test", platform: "MacIntel" }, configurable: true });

const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	host?.remove();
	root = undefined;
	host = undefined;
	globalThis.fetch = originalFetch;
});

const catalog: ModelCatalogResponse = {
	models: [
		{
			id: "claude-sonnet-4-5",
			provider: "anthropic",
			name: "Claude Sonnet 4.5",
			input: ["text"],
			reasoning: true,
			supportedLevels: ["off", "low", "medium", "high"],
			maxTokens: 8192,
			contextWindow: 200_000,
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		},
	],
	providers: [{ id: "anthropic", envVar: "ANTHROPIC_API_KEY", keyPresent: true }],
	defaults: null,
	slots: { strong: { model: { provider: "anthropic", id: "claude-sonnet-4-5" }, thinkingLevel: "medium" }, cheap: null, vision: null },
	rolePins: {
		researcher: null,
		demoBuilder: null,
		visualMaker: null,
		extractor: null,
		auditor: null,
		planner: null,
		pdfReader: null,
		coursePlanner: null,
		checker: null,
		grader: null,
		sideQuestion: null,
	},
};

const router = {
	bfcacheId: "fixture",
	back() {},
	forward() {},
	refresh() {},
	hmrRefresh() {},
	push() {},
	replace() {},
	async prefetch() {},
};

function installMockFetch(chatId: string, opts: { settings: Record<string, unknown>; kind?: "teach" | "practice" }) {
	const requests: string[] = [];
	globalThis.fetch = (async (input) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		requests.push(url);
		if (url === "/api/models") return Response.json(catalog);
		if (url === "/api/settings") {
			return Response.json({
				settings: {
					graph: { enabled: true, extractionChunkTokens: 4096 },
					general: { language: "en", pace: "thorough", difficulty: "short" },
					models: { strong: { model: { provider: "anthropic", id: "claude-sonnet-4-5" }, thinkingLevel: "medium" } },
				},
			});
		}
		if (url === `/api/chats/${chatId}?view=stats`) return Response.json({ turns: [], pricing: { cost: 0, unpriced: 0, turnCosts: {} } });
		if (url === `/api/chats/${chatId}?view=settings`) {
			return Response.json({ settings: opts.settings, kind: opts.kind });
		}
		if (url === `/api/chats/${chatId}?view=coverage`) {
			return Response.json({
				coverage: { totalMessages: 4, coveredCount: 2, uncoveredCount: 2, coveredTokens: 500, uncoveredTokens: 1024, running: false, lastFoldedAt: null },
			});
		}
		if (url === `/api/chats/${chatId}/materials`) return Response.json({ materials: [] });
		if (url === `/api/chats/${chatId}/clarify`) return Response.json({ threads: [] });
		if (url === `/api/chats/${chatId}/side-chats`) return Response.json({ threads: [] });
		if (url.startsWith("/api/jobs")) return Response.json({ jobs: [] });
		if (url === "/api/activity") return Response.json({ extractions: [], audits: [], imports: [], turns: [], courses: [] });
		if (url === "/api/plugins") return Response.json({ plugins: [] });
		if (url === "/api/chats") return Response.json({ chats: [] });
		if (url === "/api/courses") return Response.json({ courses: [] });
		if (url === "/api/today") return Response.json({ courses: [] });
		if (url === "/api/claude-code/usage") return Response.json({ available: false });
		if (url === "/api/stt/local") return Response.json({ statuses: [] });
		return Response.json({});
	}) as typeof fetch;
	return requests;
}

async function mountChat(chatId: string, element: React.ReactElement) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<AppRouterContext.Provider value={router}>
				<PathnameContext.Provider value={`/chat/${chatId}`}>
					<ServerEventsProvider>
						<PluginsProvider>
							<AppearanceProvider initialAppearance={undefined} initialTheme={DEFAULT_THEME}>
								<SidebarProvider>
									<ActivityProvider>
										<InteractionLayersProvider>
											<SettingsDialogProvider>{element}</SettingsDialogProvider>
										</InteractionLayersProvider>
									</ActivityProvider>
								</SidebarProvider>
							</AppearanceProvider>
						</PluginsProvider>
					</ServerEventsProvider>
				</PathnameContext.Provider>
			</AppRouterContext.Provider>,
		);
	});
	// Flush microtasks for any mount effects
	await act(async () => {
		await new Promise((r) => setTimeout(r, 20));
	});
}

describe("chat mount fetches", () => {
	it("issues zero full-record, settings, or coverage fetches on mount when server-seeded, and coalesces refreshes onto ?view=settings", async () => {
		const chatId = "chat_seeded_teach";
		const requests = installMockFetch(chatId, {
			settings: { language: "nb", pace: "crash", model: { provider: "anthropic", id: "claude-sonnet-4-5" }, thinkingLevel: "high" },
			kind: "teach",
		});

		await mountChat(
			chatId,
			<Chat
				chatId={chatId}
				title="Seeded Lesson"
				kind="teach"
				initialMessages={[]}
				initialSession={{
					kind: "teach",
					settings: { language: "nb", pace: "crash", model: { provider: "anthropic", id: "claude-sonnet-4-5" }, thinkingLevel: "high" },
				}}
				initialModels={{ strong: { model: { provider: "anthropic", id: "claude-sonnet-4-5" }, thinkingLevel: "medium" } }}
				initialGraph={{ enabled: true, chunkTokens: 4096 }}
				initialCoverage={{ totalMessages: 4, coveredCount: 2, uncoveredCount: 2, coveredTokens: 500, uncoveredTokens: 1024, running: false, lastFoldedAt: null }}
				initialConfigured={true}
			/>,
		);

		const fullRecordReqs = requests.filter((u) => u === `/api/chats/${chatId}`);
		const settingsViewReqs = requests.filter((u) => u === `/api/chats/${chatId}?view=settings`);
		const coverageViewReqs = requests.filter((u) => u === `/api/chats/${chatId}?view=coverage`);

		assert.equal(fullRecordReqs.length, 0, `expected 0 full-record fetches on mount, got: ${JSON.stringify(requests)}`);
		assert.equal(settingsViewReqs.length, 0, "seeded chat should not fetch ?view=settings on mount");
		assert.equal(coverageViewReqs.length, 0, "seeded chat should not fetch ?view=coverage on mount");

		// Verify controls hydrated immediately from server seed
		assert.match(host!.querySelector('[data-testid="stats-language"]')?.getAttribute("aria-label") ?? "", /Norwegian|Norsk/i);
		assert.match(host!.querySelector('[data-testid="stats-pace"]')?.getAttribute("aria-label") ?? "", /Crash/i);
		assert.ok(host!.querySelector('[data-testid="coverage-ring"]'), "CoverageRing must render from seeded coverage");

		// Now broadcast a lesson settings change: all controls must share ONE coalesced ?view=settings fetch and ZERO full-record fetches.
		const beforeCount = requests.length;
		await act(async () => {
			notifySettingsSaved("lesson");
			await new Promise((r) => setTimeout(r, 20));
		});
		const afterReqs = requests.slice(beforeCount);
		assert.equal(afterReqs.filter((u) => u === `/api/chats/${chatId}`).length, 0, "settings refresh must never fetch full record");
		assert.equal(afterReqs.filter((u) => u === `/api/chats/${chatId}?view=settings`).length, 1, `controls must coalesce into 1 ?view=settings fetch, got: ${JSON.stringify(afterReqs)}`);
	});

	it("never issues a full-record fetch even when unseeded; coalesces control reads onto ?view=settings and ?view=coverage", async () => {
		const chatId = "chat_unseeded_teach";
		const requests = installMockFetch(chatId, {
			settings: { language: "en", pace: "steady", model: { provider: "anthropic", id: "claude-sonnet-4-5" }, thinkingLevel: "medium" },
			kind: "teach",
		});

		await mountChat(
			chatId,
			<Chat chatId={chatId} title="Unseeded Lesson" kind="teach" initialMessages={[]} initialConfigured={true} />,
		);

		assert.equal(
			requests.filter((u) => u === `/api/chats/${chatId}`).length,
			0,
			`unseeded chat controls must never fetch full record, got: ${JSON.stringify(requests)}`,
		);
		assert.equal(
			requests.filter((u) => u === `/api/chats/${chatId}?view=settings`).length,
			1,
			`unseeded controls must coalesce into 1 ?view=settings fetch, got: ${JSON.stringify(requests)}`,
		);
		assert.equal(
			requests.filter((u) => u === `/api/chats/${chatId}?view=coverage`).length,
			1,
			"unseeded CoverageRing must fetch ?view=coverage",
		);
	});

	it("hydrates practice chat DifficultyControl from seed with zero full-record fetches", async () => {
		const chatId = "chat_seeded_practice";
		const requests = installMockFetch(chatId, {
			settings: { language: "en", difficulty: "medium", model: { provider: "anthropic", id: "claude-sonnet-4-5" }, thinkingLevel: "medium" },
			kind: "practice",
		});

		await mountChat(
			chatId,
			<Chat
				chatId={chatId}
				title="Seeded Practice"
				kind="practice"
				initialMessages={[]}
				initialSession={{
					kind: "practice",
					settings: { language: "en", difficulty: "medium", model: { provider: "anthropic", id: "claude-sonnet-4-5" }, thinkingLevel: "medium" },
				}}
				initialModels={{ strong: { model: { provider: "anthropic", id: "claude-sonnet-4-5" }, thinkingLevel: "medium" } }}
				initialCoverage={null}
				initialConfigured={true}
			/>,
		);

		assert.equal(requests.filter((u) => u === `/api/chats/${chatId}`).length, 0);
		assert.equal(requests.filter((u) => u === `/api/chats/${chatId}?view=settings`).length, 0);
		assert.match(host!.querySelector('[data-testid="stats-difficulty"]')?.getAttribute("aria-label") ?? "", /Medium/i);
		assert.equal(host!.querySelector('[data-testid="stats-pace"]'), null, "PaceControl hides in practice sessions");
		assert.equal(host!.querySelector('[data-testid="coverage-ring"]'), null, "CoverageRing hides in practice sessions");
	});
});
