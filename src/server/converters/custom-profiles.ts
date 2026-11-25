import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../../config.ts";
import {
	CONVERTER_PROFILE_ID_PATTERN,
	HTTP_CONVERTER_PROFILE_MAX_BYTES,
	parseHttpConverterProfile,
	validateHttpConverterProfile,
	type HttpConverterProfile,
	type ProfileValidation,
} from "../../core/http-converter-spec.ts";
import { writeFileAtomicSync } from "../../store/atomic-write.ts";
import type { CustomProfileLoader } from "./registry.ts";

/**
 * A user's own converter profiles (fork addition, 2026-11-25): JSON files in `<dataDir>/converters/<id>.json`, the
 * file name equal to the profile's id. Every read validates the file again (core/http-converter-spec.ts); an invalid
 * file is reported with its reasons and never used; reading or validating a file never throws out of this module.
 * A custom profile may not name its service address (`defaultBaseUrl` is for bundled presets only). Profiles are data:
 * nothing in them is executed.
 */

export function convertersDir(): string {
	return path.join(PATHS.data, "converters");
}

function profileFile(id: string): string {
	return path.join(convertersDir(), `${id}.json`);
}

function readProfileFile(file: string, id: string): ProfileValidation {
	let text: string;
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile()) return { ok: false, errors: ["not a file"] };
		if (stat.size > HTTP_CONVERTER_PROFILE_MAX_BYTES) return { ok: false, errors: [`larger than ${HTTP_CONVERTER_PROFILE_MAX_BYTES / 1024} KB`] };
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		return { ok: false, errors: [(error as NodeJS.ErrnoException).code === "ENOENT" ? "the file does not exist" : "the file cannot be read"] };
	}
	let parsed: ProfileValidation;
	try {
		parsed = parseHttpConverterProfile(text);
	} catch {
		return { ok: false, errors: ["the file could not be validated"] };
	}
	if (parsed.ok && parsed.profile.id !== id) return { ok: false, errors: [`its id "${parsed.profile.id}" differs from its file name "${id}.json"`] };
	return parsed;
}

/** The loader conversions pass to the registry: the file, read and validated now. */
export const loadCustomProfile: CustomProfileLoader = (id) => {
	if (!CONVERTER_PROFILE_ID_PATTERN.test(id)) return { ok: false, error: "not a valid profile id" };
	const read = readProfileFile(profileFile(id), id);
	return read.ok ? read : { ok: false, error: `${id}.json: ${read.errors.join("; ")}` };
};

export interface CustomProfileListing {
	profiles: HttpConverterProfile[];
	invalid: { file: string; errors: string[] }[];
}

/** Every `.json` file in the folder, each validated; the invalid ones with their reasons. */
export function listCustomProfiles(): CustomProfileListing {
	let names: string[];
	try {
		names = fs.readdirSync(convertersDir()).filter((n) => n.endsWith(".json")).sort();
	} catch {
		return { profiles: [], invalid: [] };
	}
	const out: CustomProfileListing = { profiles: [], invalid: [] };
	for (const name of names) {
		const id = name.slice(0, -".json".length);
		if (!CONVERTER_PROFILE_ID_PATTERN.test(id)) {
			out.invalid.push({ file: name, errors: ["the file name must be the profile id: lowercase letters, digits and hyphens"] });
			continue;
		}
		let read: ProfileValidation;
		try {
			read = readProfileFile(path.join(convertersDir(), name), id);
		} catch {
			read = { ok: false, errors: ["the file could not be read"] };
		}
		if (read.ok) out.profiles.push(read.profile);
		else out.invalid.push({ file: name, errors: read.errors });
	}
	return out;
}

/**
 * The file text for a valid profile: tab-indented when that fits the cap, else compact (the canonical form the cap is
 * measured on). undefined when even that is too large (validation already refuses such a profile; this is the last
 * check, on the very bytes about to be written).
 */
export function profileFileText(profile: HttpConverterProfile): string | undefined {
	const fits = (text: string) => Buffer.byteLength(text, "utf8") <= HTTP_CONVERTER_PROFILE_MAX_BYTES;
	const pretty = `${JSON.stringify(profile, null, "\t")}\n`;
	if (fits(pretty)) return pretty;
	const compact = `${JSON.stringify(profile)}\n`;
	return fits(compact) ? compact : undefined;
}

/** Validate and store an imported profile (text or parsed JSON) as `<id>.json`, replacing one with the same id. */
export function saveCustomProfile(input: unknown): ProfileValidation & { replaced?: boolean } {
	const checked = typeof input === "string" ? parseHttpConverterProfile(input) : validateHttpConverterProfile(input);
	if (!checked.ok) return checked;
	const text = profileFileText(checked.profile);
	if (text === undefined) return { ok: false, errors: [`A profile is at most ${HTTP_CONVERTER_PROFILE_MAX_BYTES / 1024} KB`] };
	const file = profileFile(checked.profile.id);
	const replaced = fs.existsSync(file);
	fs.mkdirSync(convertersDir(), { recursive: true });
	writeFileAtomicSync(file, text);
	return { ...checked, replaced };
}

export function removeCustomProfile(id: string): boolean {
	if (!CONVERTER_PROFILE_ID_PATTERN.test(id)) return false;
	const file = profileFile(id);
	if (!fs.existsSync(file)) return false;
	fs.rmSync(file);
	return true;
}
