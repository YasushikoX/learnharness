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
import * as chatSettingsClient from "../components/chat-settings-client.tsx";
import { fetchChatSettings, updateChatSettings } from "../components/chat-settings-client.tsx";
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
	imageModels: [],
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
	it("hydrates from server seed with zero full-record fetches, confirms via one coalesced ?view=settings and one ?view=coverage on mount, and coalesces refreshes", async () => {
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
		assert.equal(settingsViewReqs.length, 1, `seeded chat controls must confirm via 1 coalesced ?view=settings fetch, got: ${JSON.stringify(requests)}`);
		assert.equal(coverageViewReqs.length, 1, `seeded CoverageRing must confirm via 1 ?view=coverage fetch, got: ${JSON.stringify(requests)}`);

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
		assert.equal(requests.filter((u) => u === `/api/chats/${chatId}?view=settings`).length, 1, "seeded practice controls must confirm via 1 coalesced ?view=settings fetch");
		assert.equal(requests.filter((u) => u === `/api/chats/${chatId}?view=coverage`).length, 0, "practice sessions have no CoverageRing");
		assert.match(host!.querySelector('[data-testid="stats-difficulty"]')?.getAttribute("aria-label") ?? "", /Medium/i);
		assert.equal(host!.querySelector('[data-testid="stats-pace"]'), null, "PaceControl hides in practice sessions");
		assert.equal(host!.querySelector('[data-testid="coverage-ring"]'), null, "CoverageRing hides in practice sessions");
	});

	it("defect 1 regression: browser Back reusing a stale server seed refreshes controls on mount and preserves newer settings on the next save", async () => {
		const chatId = "chat_back_nav_repro";
		let serverSettings: Record<string, unknown> = {
			language: "en",
			pace: "efficient",
			model: { provider: "anthropic", id: "claude-sonnet-4-5" },
			thinkingLevel: "medium",
		};
		let serverCoverage = {
			totalMessages: 4,
			coveredCount: 2,
			uncoveredCount: 2,
			coveredTokens: 500,
			uncoveredTokens: 1024,
			running: false,
			lastFoldedAt: null as string | null,
		};
		const putPayloads: Array<Record<string, unknown>> = [];
		const requests: string[] = [];

		globalThis.fetch = (async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const method = (init?.method ?? "GET").toUpperCase();
			requests.push(`${method} ${url}`);
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
				return Response.json({ settings: { ...serverSettings }, kind: "teach" });
			}
			if (url === `/api/chats/${chatId}?view=coverage`) {
				return Response.json({ coverage: { ...serverCoverage } });
			}
			if (url === `/api/chats/${chatId}/settings` && method === "PUT") {
				const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
				putPayloads.push(body);
				serverSettings = { ...body };
				return Response.json({ settings: { ...serverSettings } });
			}
			if (url === `/api/chats/${chatId}/materials`) return Response.json({ materials: [] });
			if (url === `/api/chats/${chatId}/clarify`) return Response.json({ threads: [] });
			if (url === `/api/chats/${chatId}/side-chats`) return Response.json({ sideChats: [] });
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

		const clickTestId = async (testId: string) => {
			const el = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
			assert.ok(el, `expected element [data-testid="${testId}"]`);
			await act(async () => {
				el.click();
				await new Promise((r) => setTimeout(r, 20));
			});
		};

		// Initial server-rendered seed when chat A was first visited
		const firstRenderSeed = {
			kind: "teach" as const,
			settings: {
				language: "en" as const,
				pace: "efficient" as const,
				model: { provider: "anthropic", id: "claude-sonnet-4-5" },
				thinkingLevel: "medium" as const,
			},
		};
		const firstRenderCoverage = { ...serverCoverage };

		// 1. First visit to chat A: change pace from "efficient" to "crash"
		await mountChat(
			chatId,
			<Chat
				chatId={chatId}
				title="Chat A"
				kind="teach"
				initialMessages={[]}
				initialSession={firstRenderSeed}
				initialModels={{ strong: { model: { provider: "anthropic", id: "claude-sonnet-4-5" }, thinkingLevel: "medium" } }}
				initialGraph={{ enabled: true, chunkTokens: 4096 }}
				initialCoverage={firstRenderCoverage}
				initialConfigured={true}
			/>,
		);
		assert.match(host!.querySelector('[data-testid="stats-pace"]')?.getAttribute("aria-label") ?? "", /Efficient/i);
		await clickTestId("stats-pace");
		await clickTestId("pace-option-crash");
		assert.match(host!.querySelector('[data-testid="stats-pace"]')?.getAttribute("aria-label") ?? "", /Crash/i);
		assert.equal(serverSettings.pace, "crash");

		// 2. Navigate away to chat B (unmount chat A) and update coverage on server
		await act(async () => {
			root!.unmount();
		});
		host!.remove();
		root = undefined;
		host = undefined;
		serverCoverage = { ...serverCoverage, uncoveredTokens: 0, coveredCount: 4, uncoveredCount: 0 };

		// 3. Browser Back to chat A: Next.js reuses the cached firstRenderSeed (pace: "efficient")
		const beforeBackIdx = requests.length;
		await mountChat(
			chatId,
			<Chat
				chatId={chatId}
				title="Chat A"
				kind="teach"
				initialMessages={[]}
				initialSession={firstRenderSeed}
				initialModels={{ strong: { model: { provider: "anthropic", id: "claude-sonnet-4-5" }, thinkingLevel: "medium" } }}
				initialGraph={{ enabled: true, chunkTokens: 4096 }}
				initialCoverage={firstRenderCoverage}
				initialConfigured={true}
			/>,
		);
		const backReqs = requests.slice(beforeBackIdx);
		assert.equal(backReqs.filter((r) => r === `GET /api/chats/${chatId}`).length, 0, "Back navigation must not fetch full chat record");
		assert.equal(backReqs.filter((r) => r === `GET /api/chats/${chatId}?view=settings`).length, 1, "Back navigation must confirm via 1 coalesced ?view=settings read");
		assert.equal(backReqs.filter((r) => r === `GET /api/chats/${chatId}?view=coverage`).length, 1, "Back navigation must confirm via 1 ?view=coverage read");
		assert.match(
			host!.querySelector('[data-testid="stats-pace"]')?.getAttribute("aria-label") ?? "",
			/Crash/i,
			"Pace pill after Back must show server truth (Crash), not stale cached seed (Efficient)",
		);

		// 4. Change language to Norsk on chat A: pace must stay "crash" in PUT payload and on the server
		const putsBeforeLang = putPayloads.length;
		await clickTestId("stats-language");
		await clickTestId("language-option-nb");
		assert.equal(putPayloads.length, putsBeforeLang + 1);
		assert.equal(putPayloads.at(-1)?.language, "nb");
		assert.equal(putPayloads.at(-1)?.pace, "crash", "changing language after Back must not overwrite pace back to efficient");
		assert.equal(serverSettings.language, "nb");
		assert.equal(serverSettings.pace, "crash");
	});

	it("defect 1b regression: saving from stale local control state re-reads fresh settings before PUT and never clobbers out-of-band server changes", async () => {
		const chatId = "chat_stale_local_write";
		let serverSettings: Record<string, unknown> = {
			language: "en",
			pace: "efficient",
			model: { provider: "anthropic", id: "claude-sonnet-4-5" },
			thinkingLevel: "medium",
		};
		const putPayloads: Array<Record<string, unknown>> = [];
		const requests: string[] = [];

		globalThis.fetch = (async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const method = (init?.method ?? "GET").toUpperCase();
			requests.push(`${method} ${url}`);
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
				return Response.json({ settings: { ...serverSettings }, kind: "teach" });
			}
			if (url === `/api/chats/${chatId}?view=coverage`) {
				return Response.json({
					coverage: { totalMessages: 4, coveredCount: 2, uncoveredCount: 2, coveredTokens: 500, uncoveredTokens: 1024, running: false, lastFoldedAt: null },
				});
			}
			if (url === `/api/chats/${chatId}/settings` && method === "PUT") {
				const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
				putPayloads.push(body);
				serverSettings = { ...body };
				return Response.json({ settings: { ...serverSettings } });
			}
			if (url === `/api/chats/${chatId}/materials`) return Response.json({ materials: [] });
			if (url === `/api/chats/${chatId}/clarify`) return Response.json({ threads: [] });
			if (url === `/api/chats/${chatId}/side-chats`) return Response.json({ sideChats: [] });
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

		await mountChat(
			chatId,
			<Chat
				chatId={chatId}
				title="Stale Local Save"
				kind="teach"
				initialMessages={[]}
				initialSession={{
					kind: "teach",
					settings: { language: "en", pace: "efficient", model: { provider: "anthropic", id: "claude-sonnet-4-5" }, thinkingLevel: "medium" },
				}}
				initialModels={{ strong: { model: { provider: "anthropic", id: "claude-sonnet-4-5" }, thinkingLevel: "medium" } }}
				initialGraph={{ enabled: true, chunkTokens: 4096 }}
				initialCoverage={{ totalMessages: 4, coveredCount: 2, uncoveredCount: 2, coveredTokens: 500, uncoveredTokens: 1024, running: false, lastFoldedAt: null }}
				initialConfigured={true}
			/>,
		);

		// Another tab/device updates pace and thinkingLevel on the server without notifying this tab
		serverSettings = { ...serverSettings, pace: "crash", thinkingLevel: "high" };

		const beforeIdx = requests.length;
		const langBtn = document.querySelector('[data-testid="stats-language"]') as HTMLElement | null;
		assert.ok(langBtn);
		await act(async () => {
			langBtn.click();
			await new Promise((r) => setTimeout(r, 20));
		});
		const nbOpt = document.querySelector('[data-testid="language-option-nb"]') as HTMLElement | null;
		assert.ok(nbOpt);
		await act(async () => {
			nbOpt.click();
			await new Promise((r) => setTimeout(r, 20));
		});

		const saveSeq = requests.slice(beforeIdx);
		const getIdx = saveSeq.indexOf(`GET /api/chats/${chatId}?view=settings`);
		const putIdx = saveSeq.indexOf(`PUT /api/chats/${chatId}/settings`);
		assert.ok(getIdx !== -1 && putIdx !== -1 && getIdx < putIdx, `save must re-read ?view=settings before PUT, got: ${JSON.stringify(saveSeq)}`);
		assert.equal(putPayloads.length, 1);
		assert.equal(putPayloads[0]?.language, "nb");
		assert.equal(putPayloads[0]?.pace, "crash", "stale local pace must not overwrite newer server pace");
		assert.equal(putPayloads[0]?.thinkingLevel, "high", "stale local thinkingLevel must not overwrite newer server thinkingLevel");
	});

	it("defect 2 regression: a settings read requested after a save never joins a read started before the save", async () => {
		const chatId = "chat_gen_coalesce";
		let serverSettings: Record<string, unknown> = { pace: "thorough" };
		let getCount = 0;
		const deferredGets: Array<{ resolve: (res: Response) => void }> = [];

		globalThis.fetch = ((input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const method = (init?.method ?? "GET").toUpperCase();
			if (url === `/api/chats/${chatId}?view=settings` && method === "GET") {
				getCount++;
				// Call 1 (pre-save) and Call 3 (post-save) stay deferred so we can test coalescing boundaries.
				// Call 2 is the fresh pre-write read inside updateChatSettings -> resolve immediately.
				if (init?.cache === "no-store") {
					return Promise.resolve(Response.json({ settings: { ...serverSettings } }));
				}
				return new Promise<Response>((resolve) => {
					deferredGets.push({ resolve });
				});
			}
			if (url === `/api/chats/${chatId}/settings` && method === "PUT") {
				const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
				serverSettings = { ...body };
				return Promise.resolve(Response.json({ settings: { ...serverSettings } }));
			}
			return Promise.resolve(Response.json({}));
		}) as typeof fetch;

		// Read 1 starts BEFORE the save (server still has pace: "thorough")
		const read1 = fetchChatSettings(chatId);
		const read1Coalesced = fetchChatSettings(chatId);
		assert.equal(read1Coalesced, read1, "concurrent reads in the same generation must still coalesce");
		assert.equal(deferredGets.length, 1);

		// A pace save lands while read 1 is still in flight
		const saved = await updateChatSettings(chatId, (cur) => ({ ...cur, pace: "crash" }));
		assert.equal(saved.ok, true);
		assert.equal(serverSettings.pace, "crash");

		// Read 2 & Read 3 start AFTER the save while read 1 is still pending
		const read2 = fetchChatSettings(chatId);
		const read3 = fetchChatSettings(chatId);
		assert.notEqual(read2, read1, "post-save read must NOT join a pre-save in-flight read");
		assert.equal(read3, read2, "concurrent post-save reads in the same generation must coalesce with each other");
		assert.equal(deferredGets.length, 2, "post-save read must issue a new GET");

		// Resolve post-save GET with new value and pre-save GET with old value
		deferredGets[1]!.resolve(Response.json({ settings: { pace: "crash" } }));
		deferredGets[0]!.resolve(Response.json({ settings: { pace: "thorough" } }));

		const [r1, r2, r3] = await Promise.all([read1, read2, read3]);
		assert.equal(r1.settings?.pace, "thorough");
		assert.equal(r2.settings?.pace, "crash", "post-save read must return post-save state");
		assert.equal(r3.settings?.pace, "crash");
		assert.equal(getCount, 3, "expected 1 pre-save GET + 1 fresh pre-write GET + 1 post-save GET");

		// Also verify notifySettingsSaved("lesson") alone advances the generation for subsequent reads
		const read4 = fetchChatSettings(chatId);
		assert.equal(deferredGets.length, 3);
		notifySettingsSaved("lesson");
		const read5 = fetchChatSettings(chatId);
		assert.notEqual(read5, read4, "read after notifySettingsSaved must not join pre-notification read");
		assert.equal(deferredGets.length, 4);
		deferredGets[3]!.resolve(Response.json({ settings: { pace: "crash", language: "nb" } }));
		deferredGets[2]!.resolve(Response.json({ settings: { pace: "crash", language: "en" } }));
		const [r4, r5] = await Promise.all([read4, read5]);
		assert.equal(r4.settings?.language, "en");
		assert.equal(r5.settings?.language, "nb");
	});
});

/**
 * A fake chat-settings server whose `?view=settings` reads can be held and released in
 * order. Each held read answers with the server state at the moment it was *issued*
 * (as a real server would), so overlapping read-then-write saves reproduce lost updates.
 * Pre-write reads are the ones sent with `cache: "no-store"`; mount/confirm/trailing
 * reads are sent without it.
 */
function installSettingsServer(chatId: string, initial: Record<string, unknown>) {
	let server: Record<string, unknown> = { ...initial };
	const held: Array<{ kind: "prewrite" | "confirm"; resolve: () => void }> = [];
	const log: string[] = [];
	const puts: Array<Record<string, unknown>> = [];
	const ctl = {
		holdPrewrite: false,
		holdConfirm: false,
		failNextPrewrite: 0 as number,
		get server() { return server; },
		set server(v: Record<string, unknown>) { server = v; },
		log,
		puts,
		heldCount: (kind?: "prewrite" | "confirm") => held.filter((h) => !kind || h.kind === kind).length,
		/** Release held reads one at a time (oldest first), flushing React between each. */
		async releaseAll() {
			for (let guard = 0; held.length > 0 && guard < 100; guard++) {
				held.shift()!.resolve();
				await act(async () => {
					await new Promise((r) => setTimeout(r, 10));
				});
			}
		},
	};
	globalThis.fetch = ((input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const method = (init?.method ?? "GET").toUpperCase();
		if (url === `/api/chats/${chatId}?view=settings` && method === "GET") {
			const kind = init?.cache === "no-store" ? "prewrite" : "confirm";
			log.push(`GET ${kind}`);
			if (kind === "prewrite" && ctl.failNextPrewrite > 0) {
				ctl.failNextPrewrite--;
				return Promise.resolve(Response.json({ error: "boom" }, { status: 500 }));
			}
			const snapshot = { settings: { ...server }, kind: "teach" };
			if ((kind === "prewrite" && ctl.holdPrewrite) || (kind === "confirm" && ctl.holdConfirm)) {
				return new Promise<Response>((resolve) => held.push({ kind, resolve: () => resolve(Response.json(snapshot)) }));
			}
			return Promise.resolve(Response.json(snapshot));
		}
		if (url === `/api/chats/${chatId}/settings` && method === "PUT") {
			const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			log.push("PUT");
			puts.push(body);
			server = { ...body };
			return Promise.resolve(Response.json({ settings: { ...server } }));
		}
		if (url === "/api/models") return Promise.resolve(Response.json(catalog));
		if (url === "/api/settings") {
			return Promise.resolve(Response.json({
				settings: {
					graph: { enabled: true, extractionChunkTokens: 4096 },
					general: { language: "en", pace: "thorough", difficulty: "short" },
					models: { strong: { model: { provider: "anthropic", id: "claude-sonnet-4-5" }, thinkingLevel: "medium" } },
				},
			}));
		}
		if (url === `/api/chats/${chatId}?view=stats`) return Promise.resolve(Response.json({ turns: [], pricing: { cost: 0, unpriced: 0, turnCosts: {} } }));
		if (url === `/api/chats/${chatId}?view=coverage`) {
			return Promise.resolve(Response.json({
				coverage: { totalMessages: 4, coveredCount: 2, uncoveredCount: 2, coveredTokens: 500, uncoveredTokens: 1024, running: false, lastFoldedAt: null },
			}));
		}
		if (url.startsWith("/api/jobs")) return Promise.resolve(Response.json({ jobs: [] }));
		if (url === "/api/activity") return Promise.resolve(Response.json({ extractions: [], audits: [], imports: [], turns: [], courses: [] }));
		if (url === "/api/plugins") return Promise.resolve(Response.json({ plugins: [] }));
		if (url === "/api/chats") return Promise.resolve(Response.json({ chats: [] }));
		if (url === "/api/courses" || url === "/api/today") return Promise.resolve(Response.json({ courses: [] }));
		if (url === "/api/claude-code/usage") return Promise.resolve(Response.json({ available: false }));
		if (url === "/api/stt/local") return Promise.resolve(Response.json({ statuses: [] }));
		if (url.endsWith("/materials")) return Promise.resolve(Response.json({ materials: [] }));
		return Promise.resolve(Response.json({ threads: [], sideChats: [] }));
	}) as typeof fetch;
	return ctl;
}

const BASE_SETTINGS = { model: { provider: "anthropic", id: "claude-sonnet-4-5" }, thinkingLevel: "medium" };

function seededChat(chatId: string, seedSettings: Record<string, unknown>) {
	return (
		<Chat
			chatId={chatId}
			title="Queue"
			kind="teach"
			initialMessages={[]}
			initialSession={{ kind: "teach", settings: seedSettings }}
			initialModels={{ strong: { model: { provider: "anthropic", id: "claude-sonnet-4-5" }, thinkingLevel: "medium" } }}
			initialGraph={{ enabled: true, chunkTokens: 4096 }}
			initialCoverage={{ totalMessages: 4, coveredCount: 2, uncoveredCount: 2, coveredTokens: 500, uncoveredTokens: 1024, running: false, lastFoldedAt: null }}
			initialConfigured={true}
		/>
	);
}

async function clickTestId(testId: string) {
	const el = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
	assert.ok(el, `expected element [data-testid="${testId}"]`);
	await act(async () => {
		el.click();
		await new Promise((r) => setTimeout(r, 10));
	});
}

const ariaOf = (testId: string) => document.querySelector(`[data-testid="${testId}"]`)?.getAttribute("aria-label") ?? "";
const textOf = (testId: string) => document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";
const pendingQueues = () =>
	(chatSettingsClient as unknown as { pendingChatSettingsSaveQueues?: () => number }).pendingChatSettingsSaveQueues?.();

describe("chat settings save queue and trailing re-read", () => {
	it("re-check defect 1: two controls saving inside one pre-write read both land (Crash, then Norsk while the first read is held)", async () => {
		const chatId = "chat_queue_two_controls";
		const srv = installSettingsServer(chatId, { ...BASE_SETTINGS, pace: "efficient", language: "en" });
		await mountChat(chatId, seededChat(chatId, { ...BASE_SETTINGS, pace: "efficient", language: "en" }));
		assert.match(ariaOf("stats-pace"), /Efficient/);

		srv.holdPrewrite = true;
		await clickTestId("stats-pace");
		await clickTestId("pace-option-crash");
		await clickTestId("stats-language");
		await clickTestId("language-option-nb");
		// Fixed: only the first save's read is in flight; the language save waits its turn.
		const overlapping = srv.heldCount("prewrite");
		const logAtOverlap = JSON.stringify(srv.log);
		srv.holdPrewrite = false;
		await srv.releaseAll();

		assert.equal(srv.puts.length, 2);
		assert.equal(srv.server.pace, "crash", `pace lost: ${JSON.stringify(srv.puts)}`);
		assert.equal(srv.server.language, "nb", `language lost: ${JSON.stringify(srv.puts)}`);
		assert.match(ariaOf("stats-pace"), /Crash/);
		assert.match(ariaOf("stats-language"), /Norsk/);
		assert.equal(overlapping, 1, `second save must not read before the first save's write: ${logAtOverlap}`);
		assert.equal(pendingQueues(), 0, "the per-chat queue must be dropped once it drains");
	});

	it("re-check defect 1: a burst of effort saves (held shortcut) ends on the last level, every write consistent, and a failed save does not block the rest", async () => {
		const chatId = "chat_queue_burst";
		const srv = installSettingsServer(chatId, { ...BASE_SETTINGS, pace: "efficient", language: "en" });
		srv.holdPrewrite = true;
		srv.failNextPrewrite = 1;
		const levels = ["high", "low", "off", "medium", "high"] as const;
		const runs = [
			updateChatSettings(chatId, (cur) => ({ ...cur, pace: "crash" })), // fails: pre-write read 500
			...levels.slice(0, 2).map((level) => updateChatSettings(chatId, (cur) => ({ ...cur, thinkingLevel: level }))),
			updateChatSettings(chatId, (cur) => ({ ...cur, language: "nb" })),
			...levels.slice(2).map((level) => updateChatSettings(chatId, (cur) => ({ ...cur, thinkingLevel: level }))),
		];
		// Strictly one at a time: nothing beyond the first (failed) read can be in flight yet.
		await new Promise((r) => setTimeout(r, 10));
		assert.ok(srv.heldCount("prewrite") <= 1, `saves must not overlap: ${JSON.stringify(srv.log)}`);
		srv.holdPrewrite = false;
		await srv.releaseAll();
		const results = await Promise.all(runs);

		const failed = results[0]!;
		assert.equal(failed.ok, false);
		assert.ok(!failed.ok && failed.networkError !== true, "a server error on the pre-write read is not a network failure");
		assert.ok(!failed.ok && failed.status === 500 && /server error 500/.test(failed.error ?? ""), `got ${JSON.stringify(failed)}`);
		assert.ok(results.slice(1).every((r) => r.ok), "saves queued behind a failed save must still run");

		// Read-then-write strictly alternates.
		const seq = srv.log.join(",");
		assert.equal(seq, ["GET prewrite", ...Array(6).fill("GET prewrite,PUT")].join(","));
		// Every intermediate write carries all earlier fields; the last one wins.
		assert.equal(srv.puts.length, 6);
		srv.puts.forEach((put, i) => {
			assert.equal(put.pace, "efficient", `write ${i} changed pace`);
			assert.equal(put.language, i >= 2 ? "nb" : "en", `write ${i} lost or invented language: ${JSON.stringify(put)}`);
		});
		assert.equal(srv.server.thinkingLevel, "high");
		assert.equal(srv.server.language, "nb");
		assert.equal(pendingQueues(), 0);
	});

	it("re-check defect 2: a model save during the Back confirm read leaves no stale pace pill, with one trailing read per burst", async () => {
		const chatId = "chat_trailing_reread";
		// Back reused a stale seed (efficient); the server already holds crash.
		const srv = installSettingsServer(chatId, { ...BASE_SETTINGS, pace: "crash" });
		srv.holdConfirm = true;
		await mountChat(chatId, seededChat(chatId, { ...BASE_SETTINGS, pace: "efficient" }));
		assert.match(ariaOf("stats-pace"), /Efficient/, "seed paints first");
		assert.equal(srv.heldCount("confirm"), 1, "one coalesced confirm read is in flight");

		// Model effort save lands while the confirm read is still in flight.
		await clickTestId("stats-model");
		await clickTestId("thinking-option-high");
		assert.equal(srv.server.thinkingLevel, "high");
		assert.equal(srv.server.pace, "crash");
		// Release the (now outdated) confirm read and anything that follows it.
		await srv.releaseAll();
		assert.match(ariaOf("stats-pace"), /Crash/, `pace pill must end on the server value: ${JSON.stringify(srv.log)}`);
		assert.match(textOf("stats-model"), /high/);

		// A burst of three model saves: exactly one trailing confirm read after the last write.
		srv.holdPrewrite = true;
		const before = srv.log.length;
		await clickTestId("stats-model");
		await clickTestId("thinking-option-low");
		await clickTestId("thinking-option-off");
		await clickTestId("thinking-option-high");
		srv.holdPrewrite = false;
		await srv.releaseAll();
		const burst = srv.log.slice(before);
		assert.equal(burst.filter((e) => e === "PUT").length, 3, JSON.stringify(burst));
		const lastPut = burst.lastIndexOf("PUT");
		assert.equal(burst.filter((e) => e === "GET confirm").length, 1, `one trailing read per burst, got ${JSON.stringify(burst)}`);
		assert.ok(burst.indexOf("GET confirm") > lastPut, `the trailing read must follow the last write: ${JSON.stringify(burst)}`);
		assert.equal(srv.server.thinkingLevel, "high");
		assert.match(ariaOf("stats-pace"), /Crash/);
	});
});
