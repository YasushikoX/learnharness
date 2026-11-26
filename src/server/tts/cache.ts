import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The read-aloud audio cache (WP10, 2026-11-26): one WAV file per (model, voice, style, text) under the app data dir,
 * `<data>/tts-cache/<sha256>.wav`. Replaying a question, or a preview, costs no call. Capped by total size: when a
 * write takes it over the cap, the files used longest ago are removed first (a hit refreshes a file's time). Never
 * synced (sync only takes known paths). Best effort throughout: a cache that cannot be read or written only costs calls.
 */

export const TTS_CACHE_MAX_BYTES = 200 * 1024 * 1024;

export interface TtsCacheKey {
	model: string;
	voice: string;
	style: string;
	text: string;
}

export function ttsCacheId(key: TtsCacheKey): string {
	return createHash("sha256").update(JSON.stringify([key.model, key.voice, key.style, key.text])).digest("hex");
}

export interface TtsCache {
	get(key: TtsCacheKey): Uint8Array | undefined;
	put(key: TtsCacheKey, wav: Uint8Array): void;
	/** Total bytes stored (tests). */
	size(): number;
}

export function createTtsCache(dir: string, maxBytes = TTS_CACHE_MAX_BYTES): TtsCache {
	const fileOf = (key: TtsCacheKey) => path.join(/* turbopackIgnore: true */ dir, `${ttsCacheId(key)}.wav`);

	const entries = (): { file: string; bytes: number; used: number }[] => {
		let names: string[];
		try {
			names = fs.readdirSync(/* turbopackIgnore: true */ dir);
		} catch {
			return [];
		}
		const out: { file: string; bytes: number; used: number }[] = [];
		for (const name of names) {
			if (!name.endsWith(".wav")) continue;
			const file = path.join(/* turbopackIgnore: true */ dir, name);
			try {
				const stat = fs.statSync(/* turbopackIgnore: true */ file);
				out.push({ file, bytes: stat.size, used: stat.mtimeMs });
			} catch {
				// removed meanwhile
			}
		}
		return out;
	};

	const prune = (keep: string) => {
		const all = entries();
		let total = all.reduce((sum, e) => sum + e.bytes, 0);
		if (total <= maxBytes) return;
		all.sort((a, b) => a.used - b.used);
		for (const entry of all) {
			if (total <= maxBytes) break;
			if (entry.file === keep) continue;
			try {
				fs.rmSync(/* turbopackIgnore: true */ entry.file, { force: true });
				total -= entry.bytes;
			} catch {
				// best effort
			}
		}
	};

	return {
		get(key) {
			const file = fileOf(key);
			try {
				const bytes = fs.readFileSync(/* turbopackIgnore: true */ file);
				const now = new Date();
				try {
					fs.utimesSync(/* turbopackIgnore: true */ file, now, now);
				} catch {
					// the time only orders removal
				}
				return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			} catch {
				return undefined;
			}
		},
		put(key, wav) {
			if (wav.byteLength > maxBytes) return;
			const file = fileOf(key);
			try {
				fs.mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true });
				// written beside the target and renamed over it, so a reader never sees half a file
				const tmp = `${file}.tmp-${randomUUID()}`;
				fs.writeFileSync(/* turbopackIgnore: true */ tmp, wav);
				fs.renameSync(/* turbopackIgnore: true */ tmp, file);
				prune(file);
			} catch {
				// a full disk or a read-only folder: the audio is still played
			}
		},
		size: () => entries().reduce((sum, e) => sum + e.bytes, 0),
	};
}
