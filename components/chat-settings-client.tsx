"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { ChatCourseLink, ChatSettings, ModelsSettings } from "@/src/core";
import { lessonSettingsGeneration } from "@/components/settings-signal";

/**
 * Lightweight per-session settings snapshot (no transcript messages).
 *
 * Server-rendered chat pages pass this down through `ChatSettingsSeedProvider`
 * so controls (language, pace, difficulty, model, dictation, plan-continue)
 * paint immediately without waiting on the network. Each control still confirms
 * against `GET /api/chats/:id?view=settings` on mount (so browser Back/Forward
 * never leaves stale cached RSC settings on screen), and concurrent callers in
 * the same save generation coalesce into a single lightweight request.
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
const chatSaveGenerations = new Map<string, number>();

/** Monotonic generation token for a chat's settings reads; advances on every save. */
export function chatSettingsGeneration(chatId: string): string {
	return `${lessonSettingsGeneration()}:${chatSaveGenerations.get(chatId) ?? 0}`;
}

/** Advance `chatId`'s generation so reads requested after a save never join pre-save in-flight reads. */
export function bumpChatSettingsGeneration(chatId: string): void {
	chatSaveGenerations.set(chatId, (chatSaveGenerations.get(chatId) ?? 0) + 1);
}

/**
 * Fetch lightweight session settings (`GET /api/chats/:id?view=settings`),
 * coalescing concurrent callers for the same chat within the same save generation.
 * Pass `{ fresh: true }` to bypass coalescing and force a new network read.
 */
export function fetchChatSettings(
	chatId: string,
	options?: { cache?: RequestCache; fresh?: boolean },
): Promise<ChatSettingsSnapshot> {
	const url = `/api/chats/${encodeURIComponent(chatId)}?view=settings`;
	const init = options?.cache ? { cache: options.cache } : undefined;
	if (options?.fresh) {
		return fetch(url, init).then(async (r) => {
			if (!r.ok) throw new Error(`session read failed: ${r.status}`);
			return (await r.json()) as ChatSettingsSnapshot;
		});
	}
	const gen = chatSettingsGeneration(chatId);
	const key = `${chatId}:${gen}:${options?.cache ?? ""}`;
	const existing = inflightSettings.get(key);
	if (existing) return existing;
	const promise = fetch(url, init)
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

export type ChatSettingsUpdateResult =
	| { ok: true; settings: ChatSettings }
	| { ok: false; status?: number; error?: string; networkError?: boolean };

/**
 * Safely write one control's change to the replace-whole `PUT /api/chats/:id/settings`
 * route: always performs a fresh lightweight read (`?view=settings`, `cache: "no-store"`)
 * immediately before applying `patch` so stale client state can never overwrite fields
 * updated elsewhere. Advances the chat's read generation on success.
 */
export async function updateChatSettings(
	chatId: string,
	patch: (current: ChatSettings) => ChatSettings,
): Promise<ChatSettingsUpdateResult> {
	try {
		const latest = await fetchChatSettings(chatId, { cache: "no-store", fresh: true });
		const next = patch(latest.settings ?? {});
		const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/settings`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(next),
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			return { ok: false, status: res.status, error: body.error };
		}
		const body = (await res.json().catch(() => null)) as { settings?: ChatSettings } | null;
		bumpChatSettingsGeneration(chatId);
		return { ok: true, settings: body?.settings ?? next };
	} catch {
		return { ok: false, networkError: true };
	}
}
