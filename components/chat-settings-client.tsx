"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { ChatCourseLink, ChatSettings, ModelsSettings } from "@/src/core";
import { lessonSettingsGeneration, notifySettingsSaved } from "@/components/settings-signal";

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

/**
 * Per-chat save generation: advances once per successful `updateChatSettings` write.
 *
 * Readers capture it before a read and drop the result if it changed meanwhile (a save
 * to this chat landed while the read was in flight, so the result may predate it).
 * Dropping is always safe because of the invariant upheld by `updateChatSettings`:
 * every burst of saves ends with exactly one `notifySettingsSaved("lesson")` after its
 * last write, and every settings reader re-reads on "lesson". So a dropped read is
 * always followed by one trailing read, and a stream of saves cannot cause a re-read loop.
 */
export function chatSettingsGeneration(chatId: string): number {
	return chatSaveGenerations.get(chatId) ?? 0;
}

/** Advance `chatId`'s generation so reads requested after a save never join pre-save in-flight reads. */
export function bumpChatSettingsGeneration(chatId: string): void {
	chatSaveGenerations.set(chatId, (chatSaveGenerations.get(chatId) ?? 0) + 1);
}

/** A `?view=settings` read that reached the server but got a non-2xx answer. */
export class ChatSettingsReadError extends Error {
	constructor(readonly status: number) {
		super(`session read failed: ${status}`);
		this.name = "ChatSettingsReadError";
	}
}

async function parseSettingsResponse(r: Response): Promise<ChatSettingsSnapshot> {
	if (!r.ok) throw new ChatSettingsReadError(r.status);
	return (await r.json()) as ChatSettingsSnapshot;
}

/**
 * Fetch lightweight session settings (`GET /api/chats/:id?view=settings`),
 * coalescing concurrent callers for the same chat within the same generation
 * (this chat's saves plus lesson/models settings signals).
 * Pass `{ fresh: true }` to bypass coalescing and force a new network read.
 */
export function fetchChatSettings(
	chatId: string,
	options?: { cache?: RequestCache; fresh?: boolean },
): Promise<ChatSettingsSnapshot> {
	const url = `/api/chats/${encodeURIComponent(chatId)}?view=settings`;
	const init = options?.cache ? { cache: options.cache } : undefined;
	if (options?.fresh) return fetch(url, init).then(parseSettingsResponse);
	const key = `${chatId}:${lessonSettingsGeneration()}:${chatSettingsGeneration(chatId)}:${options?.cache ?? ""}`;
	const existing = inflightSettings.get(key);
	if (existing) return existing;
	const promise = fetch(url, init)
		.then(parseSettingsResponse)
		.finally(() => {
			if (inflightSettings.get(key) === promise) inflightSettings.delete(key);
		});
	inflightSettings.set(key, promise);
	return promise;
}

export type ChatSettingsUpdateResult =
	| { ok: true; settings: ChatSettings }
	| { ok: false; status?: number; error?: string; networkError?: boolean };

/** One fresh read, patch, and replace-whole write. Never rejects. */
async function writeChatSettings(
	chatId: string,
	patch: (current: ChatSettings) => ChatSettings,
): Promise<ChatSettingsUpdateResult> {
	let latest: ChatSettingsSnapshot;
	try {
		latest = await fetchChatSettings(chatId, { cache: "no-store", fresh: true });
	} catch (err) {
		if (err instanceof ChatSettingsReadError) {
			return {
				ok: false,
				status: err.status,
				error: `Could not load this lesson's current settings (server error ${err.status}) — nothing was saved.`,
			};
		}
		return { ok: false, networkError: true };
	}
	try {
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

interface SaveQueue {
	/** Settles when the last queued save has finished (never rejects). */
	tail: Promise<unknown>;
	/** Saves queued or running; the entry is removed when this reaches 0. */
	pending: number;
	/** Whether any save in the current burst succeeded. */
	wrote: boolean;
}
const saveQueues = new Map<string, SaveQueue>();

/**
 * Safely write one control's change to the replace-whole `PUT /api/chats/:id/settings`
 * route: performs a fresh lightweight read (`?view=settings`, `cache: "no-store"`)
 * immediately before applying `patch`, so stale client state can never overwrite fields
 * updated elsewhere.
 *
 * Saves for the same chat run strictly one after another: a save's pre-write read starts
 * only after the previous save's write has finished, so two controls saving at nearly the
 * same time both land. A failed save just resolves `{ ok: false }` and the next one still
 * runs. The queue entry is dropped as soon as it drains, so nothing accumulates per chat.
 * When the queue drains after at least one successful write, it broadcasts
 * `notifySettingsSaved("lesson")` once, so every other control re-reads (see
 * `chatSettingsGeneration`). Callers must not notify "lesson" themselves.
 *
 * Out of scope: races between two windows/tabs. Each window has its own queue, and the
 * server route is replace-whole, so near-simultaneous saves from two windows can still
 * overwrite each other (that would need a server-side merge route).
 */
export function updateChatSettings(
	chatId: string,
	patch: (current: ChatSettings) => ChatSettings,
): Promise<ChatSettingsUpdateResult> {
	let queue = saveQueues.get(chatId);
	if (!queue) {
		queue = { tail: Promise.resolve(), pending: 0, wrote: false };
		saveQueues.set(chatId, queue);
	}
	const q = queue;
	q.pending++;
	const run = q.tail
		.then(() => writeChatSettings(chatId, patch))
		.then((res) => {
			if (res.ok) q.wrote = true;
			q.pending--;
			if (q.pending === 0) {
				if (saveQueues.get(chatId) === q) saveQueues.delete(chatId);
				if (q.wrote) notifySettingsSaved("lesson");
			}
			return res;
		});
	q.tail = run.catch(() => undefined);
	return run;
}

/** Test/diagnostic seam: number of chats with saves queued or running. */
export function pendingChatSettingsSaveQueues(): number {
	return saveQueues.size;
}
