"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { ChatCourseLink, ChatSettings, ModelsSettings } from "@/src/core";

/**
 * Lightweight per-session settings snapshot (no transcript messages).
 *
 * Server-rendered chat pages pass this down through `ChatSettingsSeedProvider`
 * so controls (language, pace, difficulty, model, dictation, plan-continue)
 * hydrate immediately without fetching the full chat record. Subsequent
 * refreshes share one in-flight `GET /api/chats/:id?view=settings` request.
 */
export interface ChatSettingsSnapshot {
	settings?: ChatSettings;
	kind?: "teach" | "practice";
	course?: ChatCourseLink;
}

export interface ChatSettingsSeed extends ChatSettingsSnapshot {
	chatId: string;
	/** Global models section (for ModelControl's fallback on legacy unstamped sessions). */
	models?: ModelsSettings;
}

const ChatSettingsSeedContext = createContext<ChatSettingsSeed | null>(null);

export function ChatSettingsSeedProvider({
	value,
	children,
}: {
	value: ChatSettingsSeed | null;
	children: ReactNode;
}) {
	return <ChatSettingsSeedContext.Provider value={value}>{children}</ChatSettingsSeedContext.Provider>;
}

/** Returns the server-rendered settings seed when it matches `chatId`, otherwise undefined. */
export function useChatSettingsSeed(chatId: string | undefined): ChatSettingsSeed | undefined {
	const seed = useContext(ChatSettingsSeedContext);
	if (!seed || !chatId || seed.chatId !== chatId) return undefined;
	return seed;
}

const inflightSettings = new Map<string, Promise<ChatSettingsSnapshot>>();

/**
 * Fetch lightweight session settings (`GET /api/chats/:id?view=settings`),
 * coalescing concurrent callers for the same chat into a single request.
 */
export function fetchChatSettings(chatId: string, options?: { cache?: RequestCache }): Promise<ChatSettingsSnapshot> {
	const key = `${chatId}:${options?.cache ?? ""}`;
	const existing = inflightSettings.get(key);
	if (existing) return existing;
	const url = `/api/chats/${encodeURIComponent(chatId)}?view=settings`;
	const promise = fetch(url, options?.cache ? { cache: options.cache } : undefined)
		.then(async (r) => {
			if (!r.ok) throw new Error(`session read failed: ${r.status}`);
			return (await r.json()) as ChatSettingsSnapshot;
		})
		.finally(() => {
			if (inflightSettings.get(key) === promise) inflightSettings.delete(key);
		});
	inflightSettings.set(key, promise);
	return promise;
}
