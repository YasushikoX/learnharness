import type { GoogleTtsFailure, LessonLanguage, ReadAloudStatus } from "../../src/core/index.ts";

/**
 * Settings → Read aloud's requests (WP10, 2026-11-26), apart from the component so tests inject a fake. None throws.
 * The AI Studio key is only ever sent (to the PDF converter's key store, PUT /api/converters), never received.
 */

export type PreviewResult = { ok: true; url: string; release(): void } | { ok: false; error: string };

export interface ReadAloudClient {
	status(): Promise<ReadAloudStatus | null>;
	/** Save the AI Studio key where the Gemini PDF converter keeps it (one key for both). */
	saveKey(apiKey: string): Promise<{ error: string | null }>;
	/** One real call (not answered from the cache). */
	test(): Promise<{ ok: true } | { ok: false; kind?: GoogleTtsFailure; error: string }>;
	preview(text: string, language: LessonLanguage, voice: string, model: string): Promise<PreviewResult>;
	/** Play an audio URL; resolves when it ends (or fails). */
	play(url: string, rate: number): Promise<void>;
}

const JSON_HEADERS = { "content-type": "application/json" };

export const browserReadAloudClient: ReadAloudClient = {
	async status() {
		try {
			const res = await fetch("/api/tts", { cache: "no-store" });
			if (!res.ok) return null;
			const body = (await res.json().catch(() => null)) as Partial<ReadAloudStatus> | null;
			// anything without a key state is not an answer from this app's /api/tts
			return body && typeof body.key === "object" && body.key !== null ? (body as ReadAloudStatus) : null;
		} catch {
			return null;
		}
	},
	async saveKey(apiKey) {
		try {
			const res = await fetch("/api/converters", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ id: "gemini", apiKey }) });
			if (res.ok) return { error: null };
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			return { error: body.error ?? `Could not save the key (${res.status})` };
		} catch {
			return { error: "Could not reach the app's server" };
		}
	},
	async test() {
		try {
			const res = await fetch("/api/tts/test", { method: "POST" });
			const body = (await res.json().catch(() => ({}))) as { ok?: boolean; kind?: GoogleTtsFailure; error?: string };
			if (body.ok) return { ok: true };
			return { ok: false, ...(body.kind ? { kind: body.kind } : {}), error: body.error ?? `The test could not run (${res.status})` };
		} catch {
			return { ok: false, kind: "offline", error: "Could not reach the app's server" };
		}
	},
	async preview(text, language, voice, model) {
		try {
			const res = await fetch("/api/tts/speak", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ text, language, voice, model }) });
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				return { ok: false, error: body.error ?? `Google could not read it (${res.status})` };
			}
			const url = URL.createObjectURL(await res.blob());
			return { ok: true, url, release: () => URL.revokeObjectURL(url) };
		} catch {
			return { ok: false, error: "Could not reach the app's server" };
		}
	},
	play(url, rate) {
		return new Promise((resolve) => {
			const audio = new Audio(url);
			audio.playbackRate = rate;
			audio.onended = () => resolve();
			audio.onerror = () => resolve();
			void Promise.resolve(audio.play()).catch(() => resolve());
		});
	},
};
