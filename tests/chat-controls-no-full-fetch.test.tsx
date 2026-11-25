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
