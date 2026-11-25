/**
 * The AuthStore adapter (auth-keys wave, 2026-09-19): the flat {VAR: value}
 * auth.json map at config.AUTH_FILE — the SAME file the Electron app has
 * always hand-edited (owner decision: option A — same file, env-located,
 * zero migration). 0600, atomic writes, hand-edits keep working (the file
 * is re-read from disk on every access).
 *
 * The server (src/server/keys.ts) is the only intended writer: it applies
 * shape validation before setAuthVar and env precedence on top of
 * authVars(). Ordinary reads never throw (absent/corrupt file = {} =
 * "no keys yet"); URL-bound credential reads/writes below are deliberately
 * strict so an unreadable private record is never overwritten as {}.
 * Ordinary writes preserve unknown string vars verbatim
 * (forward-compat: future entries — e.g. a plans-login token — ride along
 * untouched until a catalog entry adopts them).
 */

import fs from "node:fs";
import path from "node:path";
import { AUTH_FILE } from "../../config.ts";
import type { AuthStore } from "../core/ports.ts";
import { CUSTOM_PROVIDER } from "../core/auth-keys.ts";
import { CUSTOM_AUTH_BINDING, parseCustomAuthBinding, type CustomAuthBinding } from "../core/custom-provider-auth.ts";
import { CONVERTER_CREDENTIALS, DOCLING_API_KEY, DOCLING_AUTH_BINDING } from "../core/pdf-converter.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

/** The flat string→string map, or {} for absent/corrupt/non-object. */
function readMap(): Record<string, string> {
	try {
		const raw = JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		return Object.fromEntries(
			Object.entries(raw).filter(([, v]) => typeof v === "string") as [string, string][],
		);
	} catch {
		return {}; // absent or corrupt — the documented state is "no keys yet"
	}
}

/** Write the map atomically at mode 0600: a partial write must never
 *  leave a 0644 file (secrets) or a truncated JSON (looks like "no keys").
 *  atomic-write.ts sets the mode on the temp file before the rename, so
 *  the mode never exists relaxed on the final path. */
function writeMap(map: Record<string, unknown>): void {
	fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
	writeFileAtomicSync(AUTH_FILE, `${JSON.stringify(map, null, "\t")}\n`, { mode: 0o600 });
}

export const authStore: AuthStore = {
	authVars() {
		return readMap();
	},
	setAuthVar(name, value) {
		assertOrdinaryVar(name);
		const map = readMap();
		map[name] = value;
		writeMap(map);
	},
	deleteAuthVar(name) {
		assertOrdinaryVar(name);
		const map = readMap();
		if (!(name in map)) return; // absent = silent success, idempotent
		delete map[name];
		writeMap(map);
	},
};

/** URL-bound writes must never turn an unreadable/corrupt private file into {}.
 * Other providers retain their existing adapter semantics. Unknown JSON values
 * survive these updates, not just the ordinary string projection. */
function readCustomMap(): Record<string, unknown> {
	let text: string;
	try { text = fs.readFileSync(AUTH_FILE, "utf8"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw new Error("Custom authorization storage unavailable"); }
	let raw: unknown;
	try { raw = JSON.parse(text); } catch { throw new Error("Custom authorization storage unavailable"); }
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Custom authorization storage unavailable");
	const map = raw as Record<string, unknown>;
	if (Object.hasOwn(map, CUSTOM_AUTH_BINDING) && !parseCustomAuthBinding(map[CUSTOM_AUTH_BINDING])) throw new Error("Invalid custom authorization record");
	if (Object.hasOwn(map, CUSTOM_PROVIDER.envVar) && typeof map[CUSTOM_PROVIDER.envVar] !== "string") throw new Error("Invalid custom credential record");
	return map;
}
function assertOrdinaryVar(name: string): void {
	if (name === CUSTOM_AUTH_BINDING || name === CUSTOM_PROVIDER.envVar) throw new Error("Use the custom endpoint editor");
	if (name === DOCLING_AUTH_BINDING || name === DOCLING_API_KEY) throw new Error("Use the Docling credential writer");
	if (name === CONVERTER_CREDENTIALS) throw new Error("Use the PDF converter credential writer");
}
/** One immutable file snapshot. Keyless callers never invoke fileKey(). */
export function readCustomAuth() {
	const map = readCustomMap();
	return { binding: parseCustomAuthBinding(map[CUSTOM_AUTH_BINDING]), fileKey: () => map[CUSTOM_PROVIDER.envVar] as string | undefined };
}
/** Replace just the custom pair in ONE existing atomic record write. */
export function writeCustomAuth(binding: CustomAuthBinding | undefined, fileKey: string | undefined): void {
	const map = readCustomMap();
	if (binding && !parseCustomAuthBinding(JSON.stringify(binding))) throw new Error("Invalid custom authorization record");
	if (fileKey === undefined) delete map[CUSTOM_PROVIDER.envVar];
	else Object.defineProperty(map, CUSTOM_PROVIDER.envVar, { value: fileKey, enumerable: true, configurable: true, writable: true });
	if (binding === undefined) delete map[CUSTOM_AUTH_BINDING];
	else Object.defineProperty(map, CUSTOM_AUTH_BINDING, { value: JSON.stringify(binding), enumerable: true, configurable: true, writable: true });
	writeMap(map);
}

export function readDoclingAuth(): { baseUrl?: string; apiKey?: string } {
	const map = readCustomMap();
	return {
		...(typeof map[DOCLING_AUTH_BINDING] === "string" ? { baseUrl: map[DOCLING_AUTH_BINDING] as string } : {}),
		...(typeof map[DOCLING_API_KEY] === "string" ? { apiKey: map[DOCLING_API_KEY] as string } : {}),
	};
}

export function writeDoclingAuth(baseUrl: string, apiKey: string | undefined): void {
	const map = readCustomMap();
	if (apiKey === undefined) {
		delete map[DOCLING_AUTH_BINDING];
		delete map[DOCLING_API_KEY];
	} else {
		map[DOCLING_AUTH_BINDING] = baseUrl;
		map[DOCLING_API_KEY] = apiKey;
	}
	writeMap(map);
}

/** Profile converter keys (fork addition, 2026-11-25): one JSON string entry, `{ [converterId]: { baseUrl, apiKey } }`. Strict: a damaged record is never overwritten. */
export type ConverterCredentials = Record<string, { baseUrl: string; apiKey: string }>;

export function readConverterCredentials(): ConverterCredentials {
	const raw = readCustomMap()[CONVERTER_CREDENTIALS];
	if (raw === undefined) return {};
	let parsed: unknown;
	try { parsed = typeof raw === "string" ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid PDF converter credential record");
	const out: ConverterCredentials = Object.create(null) as ConverterCredentials;
	for (const [id, entry] of Object.entries(parsed)) {
		const e = entry as { baseUrl?: unknown; apiKey?: unknown } | null;
		if (!e || typeof e.baseUrl !== "string" || typeof e.apiKey !== "string") throw new Error("Invalid PDF converter credential record");
		out[id] = { baseUrl: e.baseUrl, apiKey: e.apiKey };
	}
	return out;
}

export function writeConverterCredentials(credentials: ConverterCredentials): void {
	const map = readCustomMap();
	if (Object.keys(credentials).length === 0) delete map[CONVERTER_CREDENTIALS];
	else map[CONVERTER_CREDENTIALS] = JSON.stringify(credentials);
	writeMap(map);
}
