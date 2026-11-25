/**
 * Lesson source material (fork addition, 2026-10-24). PURE, browser-safe.
 *
 * A lesson can carry source material — PDFs, text/Markdown, web pages,
 * images — that defines what the lesson is FOR. Each item is copied into
 * the lesson's data folder (src/store/materials.ts), read once in the
 * background into a PROFILE (scope, targets, definitions, notation, order,
 * exercise style — src/agent/subagents/material-profiler.ts), and the
 * profiles ride every conversation turn's system prompt with the rules
 * below. Two tools look up exact passages on demand.
 *
 * Named "materials" in code: the graph already has "sources" (imported
 * notes' provenance, graph/sources.json) — a different thing.
 */

export type MaterialKind = "pdf" | "text" | "image" | "web";

/** reading: being profiled · ready: profiled · error: profiling failed
 *  (the raw file still serves the lookup tools). */
export type MaterialStatus = "reading" | "ready" | "error";

export interface LessonMaterial {
	/** "mat_…", unique within the lesson. */
	id: string;
	kind: MaterialKind;
	/** Display name: the file name, or the page's title for a link. */
	name: string;
	/** The stored copy's file name inside the material's folder. */
	file: string;
	/** A link's address. */
	url?: string;
	mimeType?: string;
	bytes: number;
	/** PDFs: page count. */
	pages?: number;
	addedAt: string;
	/** Added after the lesson's first turn (the prompt flags it once). */
	addedMidLesson?: boolean;
	status: MaterialStatus;
	error?: string;
	/** The reading profile (Markdown, page-cited for PDFs). */
	profile?: string;
	/** DERIVED on read, never stored: the material's name, profile and text
	 *  arrived by sync but its original file is on the device it was uploaded
	 *  to. The profile still works; reading or searching the original does not. */
	originalElsewhere?: boolean;
}

/** Upload ceiling: textbooks are big, but a lesson's copy is local disk. */
export const MATERIAL_MAX_BYTES = 100 * 1024 * 1024;

/** An upload body the server could not parse — in practice one cut off at
 *  the proxy's body limit (next.config.ts), so it names the ceiling. */
export const UNREADABLE_UPLOAD = `The upload could not be read — it may be larger than ${MATERIAL_MAX_BYTES / 1024 / 1024} MB.`;

const TEXT_EXT = new Set([".txt", ".md", ".markdown", ".text"]);
const IMAGE_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};

/** Which kind a file is, by extension then MIME; null = unsupported. Pure. */
export function materialKindFor(fileName: string, mimeType = ""): Exclude<MaterialKind, "web"> | null {
	const ext = fileName.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
	if (ext === ".pdf" || mimeType === "application/pdf") return "pdf";
	if (TEXT_EXT.has(ext) || mimeType === "text/plain" || mimeType === "text/markdown") return "text";
	if (ext in IMAGE_EXT || mimeType.startsWith("image/")) return "image";
	return null;
}

/** An image's MIME type from its file name (the vision call needs one). */
export function imageMimeType(fileName: string): string {
	const ext = fileName.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
	return IMAGE_EXT[ext] ?? "image/png";
}

/** What the attach control accepts (the file picker's `accept`). */
export const MATERIAL_ACCEPT = ".pdf,.txt,.md,.markdown,.png,.jpg,.jpeg,.webp,.gif";

/** Is this an http(s) address a link material can fetch? Pure. */
export function isMaterialUrl(value: string): boolean {
	try {
		const u = new URL(value.trim());
		return u.protocol === "http:" || u.protocol === "https:";
	} catch {
		return false;
	}
}

/** How the lesson treats its material — the owner's rule (2026-10-24). */
export const MATERIAL_RULES = `The learner attached the source material below. It defines this lesson:
- TARGET AND SCOPE: what the material covers and expects is what the learner must end up able to do. When you clarify the goal or plan the lesson, start from the material's targets, and make sure every one of them is met before the lesson ends.
- DEFINITIONS, NOTATION, TERMINOLOGY: use the material's own — its definitions, symbols, sign and naming conventions, and terms — so the learner can go straight back to it.
- EXPLANATIONS AND ORDER: you may explain things your own way, add intuition, examples and other perspectives that make it easier to learn, and teach in a different order than the material, as long as all its targets are met.
- CITE AND FLAG: cite the material where you rely on it — "(name, p. N)" for PDFs, the section for other material. Say explicitly when you go beyond the material or explain something differently from how it does.
- LOOK IT UP: the profiles below are summaries. Before quoting a definition, a theorem or an exercise, check the exact wording with material_search / material_read. For math-heavy or diagram pages of a PDF, dispatch a pdf job on its stored path to have the pages read visually.`;

/** The rules when the sources are shown as a catalog (owner, 2026-11-19): the first four bullets are unchanged. */
const CATALOG_RULES = MATERIAL_RULES.replace(
	/- LOOK IT UP:[^\n]*$/,
	`- CATALOG: there are many sources, so most are listed below only by scope, targets and contents with page references. Pick the ones that bear on this lesson and read them with material_search / material_read; a source you have read in this conversation is shown in full below, with its definitions and notation. Before you rely on a source's definitions, notation or exercises, read it, and check the exact wording before you quote. For math-heavy or diagram pages of a PDF, dispatch a pdf job on its stored path to have the pages read visually.`,
);

/**
 * The combined size (characters, about 6k tokens) of the ready profiles up to which the prompt carries them all in
 * full; past it the prompt switches to the catalog (owner, 2026-11-19). A lesson with one or two sources never switches.
 */
export const CATALOG_THRESHOLD_CHARS = 24_000;
/** One catalog entry's budget, characters: Scope and targets and Contents each get their own, so a long Scope never crowds out the page references (owner, 2026-11-19, after the Matte 1 check). */
export const CATALOG_SCOPE_CHARS = 500;
export const CATALOG_CONTENTS_CHARS = 700;
/** The entry of a profile without those headings: its start, up to the two budgets together. */
export const CATALOG_ENTRY_CHARS = CATALOG_SCOPE_CHARS + CATALOG_CONTENTS_CHARS;

/** A profile split at its "## " headings; text before the first heading is dropped. Pure. */
function profileSections(profile: string): { heading: string; text: string }[] {
	const out: { heading: string; text: string }[] = [];
	for (const part of profile.split(/^(?=## )/m)) {
		const m = part.match(/^## ([^\n]*)/);
		if (m) out.push({ heading: (m[1] ?? "").trim().toLowerCase(), text: part.trim() });
	}
	return out;
}

/** Cut at a line boundary under `max` characters, marking the cut. Pure. */
function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	const cut = text.slice(0, max);
	const nl = cut.lastIndexOf("\n");
	return `${(nl > max / 2 ? cut.slice(0, nl) : cut).trimEnd()}\n…`;
}

/**
 * A catalog entry: the profile's "Scope and targets" and "Contents" sections (page references), no model call, each cut
 * to its own budget. A profile without those headings gets its start instead (CATALOG_ENTRY_CHARS). Pure.
 */
export function catalogEntry(profile: string): string {
	const keep = profileSections(profile).flatMap((s) =>
		s.heading.startsWith("scope") ? [clip(s.text, CATALOG_SCOPE_CHARS)] : s.heading.startsWith("contents") ? [clip(s.text, CATALOG_CONTENTS_CHARS)] : [],
	);
	return keep.length > 0 ? keep.join("\n\n") : clip(profile.trim(), CATALOG_ENTRY_CHARS);
}

/** The profile's definitions and notation sections only; null when it has neither. Pure. */
export function definitionsAndNotation(profile: string): string | null {
	const keep = profileSections(profile).filter((s) => s.heading.startsWith("definitions") || s.heading.startsWith("notation"));
	return keep.length > 0 ? keep.map((s) => s.text).join("\n\n") : null;
}

/**
 * The materials this conversation has read: ids of those named by a material_read call, or a material_search call
 * with its `material` argument (an id or a name, as the tools take it). A search across everything pins nothing. Derived
 * from the stored assistant messages, so chat compaction does not unpin. Pure.
 */
export function readMaterialIds(messages: readonly unknown[], materials: readonly LessonMaterial[]): Set<string> {
	const out = new Set<string>();
	for (const msg of messages) {
		const m = msg as { role?: string; content?: unknown };
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const block of m.content as { type?: string; name?: string; arguments?: { material?: unknown } }[]) {
			if (block?.type !== "toolCall" || (block.name !== "material_read" && block.name !== "material_search")) continue;
			const ref = block.arguments?.material;
			if (typeof ref !== "string") continue;
			const hit = materials.find((x) => x.id === ref || x.name === ref);
			if (hit) out.add(hit.id);
		}
	}
	return out;
}

/** What a material's block says in the prompt: its profile, or a catalog entry or a definitions-and-notation cut of it. */
type BlockForm = "full" | "catalog" | "defs";

/** Who the section is written for: a lesson (the default), or a course Ask conversation (2026-11-25), whose own
 *  prompt fragments (agent/prompts/ask/) say how to look things up, so its section only lists the sources. */
export type MaterialSectionVariant = "lesson" | "ask";

/** One material's block in the system prompt. Pure. */
export function materialBlock(m: LessonMaterial, path: string, form: BlockForm = "full", variant: MaterialSectionVariant = "lesson"): string {
	const kind = m.kind === "pdf" ? `PDF${m.pages ? `, ${m.pages} pages` : ""}` : m.kind === "web" ? `web page, ${m.url}` : m.kind;
	const added = m.addedMidLesson && variant === "lesson" ? ' added="during the lesson"' : "";
	const head = `<material id="${m.id}" name="${m.name}" kind="${kind}" path="${path}"${added}>`;
	// an Ask conversation may have no lookups at all (a selection clarification), so its block names no tool
	const lookup = variant === "lesson" ? " Use material_search / material_read on it directly." : "";
	const body =
		m.status === "ready" && m.profile
			? form === "catalog"
				? catalogEntry(m.profile)
				: form === "defs"
					? `${catalogEntry(m.profile)}\n\n${definitionsAndNotation(m.profile) ?? ""}`.trim()
					: m.profile.trim()
			: m.status === "reading"
				? `(Still being read — its profile is not ready yet.${lookup})`
				: `(Its profile could not be built${m.error ? `: ${m.error}` : ""}.${lookup})`;
	return `${head}\n${body}\n</material>`;
}

/** The Ask conversation's material rules (2026-11-25): what the list is, nothing about lessons or tools. */
export const ASK_MATERIAL_RULES =
	"The class's sources. Cite a source by its `name`. A profile summarises a source, with page references, to help choose what to read: it is never something to answer, quote or cite from.";
const ASK_CATALOG_RULES = `${ASK_MATERIAL_RULES} There are many sources, so most are listed only by scope and contents; a source read in this conversation is shown with its definitions and notation.`;

/** Which kinds of source an Ask conversation can check (its prompt names them). Pure. */
export interface TurnSources {
	pdf: boolean;
	/** text, web and image material */
	other: boolean;
	notes: boolean;
}

/**
 * The lesson's source-material section for the conversation agents'
 * system prompt; undefined when the lesson has none. `pathOf` gives each
 * material's stored file (the pdf job's input). `newSince` (ms) is the
 * teacher's last message: material added after it gets a one-time "take
 * this into account" note — once answered, the note is gone. Pure.
 */
export function materialsPromptSection(
	materials: readonly LessonMaterial[],
	pathOf: (m: LessonMaterial) => string,
	newSince?: number,
	pinned: ReadonlySet<string> = new Set(),
	variant: MaterialSectionVariant = "lesson",
): string | undefined {
	if (materials.length === 0) return undefined;
	// Small sets ride in full, as ever. Past the threshold (owner, 2026-11-19) the prompt carries a catalog, and the
	// sources this conversation has read keep their full profile (definitions and notation), or just those two sections
	// when the pinned profiles alone pass the threshold too.
	const profiled = materials.filter((m) => m.status === "ready" && m.profile);
	const size = (list: readonly LessonMaterial[]) => list.reduce((n, m) => n + (m.profile?.length ?? 0), 0);
	const catalog = size(profiled) > CATALOG_THRESHOLD_CHARS;
	const pinForm: BlockForm = size(profiled.filter((m) => pinned.has(m.id))) > CATALOG_THRESHOLD_CHARS ? "defs" : "full";
	const formOf = (m: LessonMaterial): BlockForm => (!catalog ? "full" : pinned.has(m.id) ? pinForm : "catalog");
	const added = materials.filter((m) => m.addedMidLesson && newSince !== undefined && Date.parse(m.addedAt) > newSince);
	const note =
		added.length > 0 && variant === "lesson"
			? `\n\nJust added by the learner: ${added.map((m) => `"${m.name}"`).join(", ")}. If this changes the lesson's target or scope, say how you will take it into account and adjust the plan.`
			: "";
	const rules = variant === "ask" ? (catalog ? ASK_CATALOG_RULES : ASK_MATERIAL_RULES) : catalog ? CATALOG_RULES : MATERIAL_RULES;
	return `<source_material>\n${rules}${note}\n\n${materials.map((m) => materialBlock(m, pathOf(m), formOf(m), variant)).join("\n\n")}\n</source_material>`;
}
