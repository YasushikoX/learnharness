import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	MATERIAL_DIGEST_VERSION, type DigestTerm, type MaterialDigest,
} from "../../src/core/contracts/material-digest.ts";
import type { SkillLine } from "../../src/core/contracts.ts";
import { termId } from "../../src/core/glossary.ts";
import type { LessonMaterial } from "../../src/core/materials.ts";
import { formatPageMarker, splitMaterial } from "../../src/core/material-split.ts";
import { MATERIAL_INDEXER_VERSION, parseStoredDigest } from "../../src/agent/subagents/material-digest.ts";
import { PDF_CONTENT_FILE, PDF_CONVERSION_SIDECAR, type PdfConversionSidecar } from "../../src/server/material-conversion.ts";
import { MATERIAL_DIGEST_FILE } from "../../src/server/material-indexing.ts";
import { PDFJS_CONVERTER_VERSION } from "../../src/server/converters/pdfjs.ts";
import { materialStore } from "../../src/store/materials.ts";
import { writeFileAtomicSync } from "../../src/store/atomic-write.ts";
import { ids } from "./scenario.mjs";

export const biology = [
	{ id: "sk_atp", name: "ATP and energy coupling", statement: "Explain how ATP hydrolysis drives an otherwise unfavorable reaction.", requires: [] },
	{ id: "sk_redox", name: "Redox and electron carriers", statement: "Track electrons and energy as NAD⁺ is reduced to NADH.", requires: [] },
	{ id: "sk_glycolysis", name: "Glycolysis", statement: "Account for the carbon, net ATP, and NADH produced in glycolysis.", requires: ["sk_atp", "sk_redox"] },
	{ id: "sk_citric", name: "Citric acid cycle", statement: "Trace carbon and reduced electron carriers through pyruvate oxidation and the citric acid cycle.", requires: ["sk_glycolysis"] },
	{ id: "sk_gradient", name: "Proton gradients and ATP synthase", statement: "Predict the effect of changing the proton gradient on ATP production.", requires: ["sk_atp", "sk_redox"] },
	{ id: "sk_ferment", name: "Fermentation", statement: "Explain how fermentation regenerates NAD⁺ and sustains glycolysis.", requires: ["sk_glycolysis"] },
	{ id: "sk_light", name: "Light reactions", statement: "Trace energy and electrons from light absorption to ATP and NADPH.", requires: ["sk_gradient"] },
	{ id: "sk_calvin", name: "Calvin cycle", statement: "Explain how ATP and NADPH support carbon fixation and regeneration of RuBP.", requires: ["sk_light"] },
] as const;

export const calculus = [
	{ id: "sk_limits", name: "Limits from graphs", statement: "Read one-sided limits and distinguish a limit from a function value.", requires: [] },
	{ id: "sk_continuity", name: "Continuity", statement: "Determine whether a function is continuous at a point and classify any discontinuity.", requires: ["sk_limits"] },
	{ id: "sk_chain", name: "Chain rule", statement: "Differentiate a composition and track the derivative of its inner function.", requires: ["sk_continuity"] },
] as const;

const vocabulary = [
	["ATP", "ATP is a nucleotide whose hydrolysis can be coupled to reactions that require energy.", "sk_atp"],
	["NADH", "NADH is a reduced electron carrier that delivers electrons to the respiratory chain.", "sk_redox"],
	["glycolysis", "Glycolysis splits glucose into two molecules of pyruvate.", "sk_glycolysis"],
	["citric acid cycle", "The citric acid cycle oxidizes acetyl groups and transfers electrons to carriers.", "sk_citric"],
	["proton gradient", "A proton gradient is a difference in proton concentration across a membrane.", "sk_gradient"],
	["ATP synthase", "ATP synthase uses proton flow to make ATP from ADP and phosphate.", "sk_gradient"],
	["fermentation", "Fermentation regenerates NAD+ so glycolysis can continue when respiration is limited.", "sk_ferment"],
	["carbon fixation", "Carbon fixation incorporates inorganic carbon into an organic molecule.", "sk_calvin"],
	["chemiosmosis", "Chemiosmosis is movement of ions down an electrochemical gradient across a membrane."],
] as const;

export const coverageItems = vocabulary.flatMap(([name, , skill]) => skill ? [{ entryId: termId(name), name, skills: [skill] }] : []);

export function skillLines(createdAt: string): SkillLine[] {
	return [...biology, ...calculus].map(skill => ({
		...skill,
		requires: [...skill.requires],
		restsOn: ["sk_atp", "sk_redox", "sk_gradient"].includes(skill.id) ? [`n_${skill.id.slice(3)}`] : [],
		createdAt,
	}));
}

// A real one-page, searchable PDF. Its object offsets are measured in bytes.
function handoutPdf(lines: string[]): Buffer {
	const escape = (line: string) => line.replace(/[\\()]/g, "\\\\$&");
	const stream = `BT /F1 13 Tf 48 740 Td 24 TL (${escape(lines[0]!)}) Tj\n`
		+ lines.slice(1).map(line => `T* (${escape(line)}) Tj`).join("\n") + "\nET\n";
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
	];
	let pdf = "%PDF-1.4\n";
	const offsets = objects.map((object, index) => {
		const offset = Buffer.byteLength(pdf);
		pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
		return `${String(offset).padStart(10, "0")} 00000 n `;
	});
	const xref = Buffer.byteLength(pdf);
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.join("\n")}\n`
		+ `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(pdf);
}

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

export function seedCurriculum(addedAt: string) {
	seedMaterial({
		owner: ids.biology, id: ids.material, addedAt, name: "Unit 3 — Cellular energetics.pdf", title: "Unit 3: Cellular Energetics",
		vocabulary: vocabulary.map(([term, definition]) => [term, definition] as const),
		profile: "## Scope and targets\n\nEnergy coupling, cellular respiration and photosynthesis (p. 1).\n\n"
			+ "## Approach and order\n\nExplain the movement of carbon and electrons separately from ATP production (p. 1).",
		summaryBullets: ["Follow electrons into the respiratory chain.", "Explain how a proton gradient powers ATP synthesis."],
	});
	// UI round 8: a class with one read file and no skill map yet (no indexed core term, so it has no coverage either)
	seedMaterial({
		owner: ids.chemistry, id: ids.chemistryMaterial, addedAt, name: "Week 1 — Functional groups.pdf", title: "Week 1: Functional groups",
		vocabulary: [],
		lines: ["Alcohols, aldehydes, ketones and carboxylic acids.", "Naming a molecule from its longest carbon chain."],
		profile: "## Scope and targets\n\nFunctional groups and IUPAC naming (p. 1).",
		summaryBullets: ["Recognize the common functional groups.", "Name a molecule from its longest chain."],
	});
}

function seedMaterial({ owner, id, addedAt, name, title, vocabulary, lines: extra = [], profile, summaryBullets }: {
	owner: string; id: string; addedAt: string; name: string; title: string;
	vocabulary: ReadonlyArray<readonly [string, string]>; lines?: string[]; profile: string; summaryBullets: string[];
}) {
	const lines = [...vocabulary.map(([, definition]) => definition), ...extra];
	const bytes = handoutPdf([title, ...lines]);
	const contentMd = [formatPageMarker(1), `# ${title}`, ...lines, ""].join("\n\n");
	const material: LessonMaterial = {
		id, name, file: "source.pdf", kind: "pdf", mimeType: "application/pdf",
		bytes: bytes.length, pages: 1, addedAt, status: "ready", profileFromDigest: true, profile,
	};
	const aux = (filename: string) => materialStore.auxPath(owner, material.id, filename);
	const pdfPath = materialStore.filePath(owner, material);
	mkdirSync(dirname(pdfPath), { recursive: true });
	writeFileSync(pdfPath, bytes);
	// add() always assigns a random ID and date. Seed its typed index with fixed identities.
	writeFileAtomicSync(join(dirname(dirname(pdfPath)), "index.json"), JSON.stringify([material], null, "\t"));
	writeFileAtomicSync(aux(PDF_CONTENT_FILE), contentMd);
	const converted: PdfConversionSidecar = {
		version: 2, sourceHash: sha256(bytes), converterId: "pdfjs", converterVersion: PDFJS_CONVERTER_VERSION,
		requested: { converterId: "pdfjs", converterVersion: PDFJS_CONVERTER_VERSION, options: {} },
		failedPages: [], warnings: [], convertedAt: addedAt,
	};
	writeFileAtomicSync(aux(PDF_CONVERSION_SIDECAR), JSON.stringify(converted, null, "\t"));
	const terms: DigestTerm[] = vocabulary.map(([term, definition]) => ({
		id: termId(term), term, definition, page: 1, tier: "core", definitionPage: 1, definitionTier: "core",
		aliases: [], symbols: [], occurrenceCount: 1,
		occurrences: [{ part: 0, page: 1, tier: "core", definition, definitionPage: 1 }],
	}));
	const digest: MaterialDigest = {
		version: MATERIAL_DIGEST_VERSION, indexerVersion: MATERIAL_INDEXER_VERSION,
		sourceHash: sha256(contentMd), converter: "pdfjs", converterVersion: PDFJS_CONVERTER_VERSION,
		name, profile: material.profile!, pageCount: 1, sourcePageCount: 1, terms, concepts: [], figures: [],
		batches: splitMaterial(contentMd).map((batch, index) => ({
			index, pageStart: batch.pageStart, pageEnd: batch.pageEnd, pages: [...batch.pages], headingPath: [...batch.headingPath],
			charStart: batch.charStart, charEnd: batch.charEnd, status: "indexed",
			summaryBullets,
		})),
	};
	const stored = JSON.stringify(digest, null, "\t");
	const checked = parseStoredDigest(stored);
	if (!checked.ok) throw new Error(`Invalid fixture digest: ${checked.problem.reason}`);
	writeFileAtomicSync(aux(MATERIAL_DIGEST_FILE), stored);
}
