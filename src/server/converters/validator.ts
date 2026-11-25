import { contentPages } from "../../core/material-split.ts";
import type { ConverterValidationReport, ValidationCheck, ValidationCheckId } from "../../core/converter-settings.ts";
import { ConverterError, type ConvertResult, type PdfConverter } from "../../core/pdf-converter.ts";
import { SECRET_REDACTED_WARNING } from "./http-declarative.ts";
import { normaliseConversion } from "./normalise.ts";
export type { ConverterValidationReport, ValidationCheck, ValidationCheckId };
import { VALIDATION_FILENAME, VALIDATION_SENTENCES, validationPdf } from "./validation-fixture.ts";

/**
 * The converter test (fork addition, 2026-11-25): runs ANY converter (pdfjs, Docling, a preset, a custom profile, a
 * draft from the later AI wizard) on the bundled two-page PDF (validation-fixture.ts) and says whether its answer can
 * be trusted with page citations. The converter is called directly, never through the registry's fallback, so an
 * unreachable service fails here instead of passing as pdfjs. Settings → PDF conversion → Test calls this.
 *
 * Checks, in order:
 *   converted   the converter answered without an error;
 *   markers     the host's normaliser accepted the answer (pages 1 and 2, each once, no others) and wrote valid
 *               page-marked Markdown;
 *   page_1, page_2   each page carries its own sentence;
 *   own_pages   neither page carries the other page's sentence (catches shifted or swapped numbering);
 *   no_secret   no secret (the API key) appears in the answer, its warnings or its errors.
 * Every string in the report has the secrets removed.
 */

export interface ValidateConverterOptions {
	signal: AbortSignal;
	/** Values that must not appear in the answer (the converter's key). */
	secrets?: string[];
	onProgress?: (stage: string) => void;
}

const PREVIEW_CHARS = 300;

/** Lowercase letters and digits only, single spaces: OCR punctuation and line breaks do not matter. */
function comparable(text: string): string {
	return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export async function validateConverter(converter: PdfConverter, options: ValidateConverterOptions): Promise<ConverterValidationReport> {
	const started = Date.now();
	const secrets = (options.secrets ?? []).map((s) => s.trim()).filter((s) => s.length >= 4);
	const redact = (text: string) => secrets.reduce((out, secret) => out.split(secret).join("[redacted]"), text);
	const checks: ValidationCheck[] = [];
	const check = (id: ValidationCheckId, status: ValidationCheck["status"], message: string) => checks.push({ id, status, message: redact(message) });
	const skipRest = (from: ValidationCheckId[]) => from.forEach((id) => check(id, "skipped", "Not checked, because an earlier check failed."));
	const report = (extra: Partial<ConverterValidationReport>): ConverterValidationReport => ({
		ok: checks.every((c) => c.status === "pass"),
		converterId: converter.id,
		checks,
		pages: [],
		warnings: [],
		durationMs: Date.now() - started,
		...extra,
	});

	let result: ConvertResult;
	try {
		result = await converter.convert(
			{ bytes: validationPdf(), filename: VALIDATION_FILENAME, pageCount: VALIDATION_SENTENCES.length },
			{ signal: options.signal, onProgress: (stage) => options.onProgress?.(stage) },
		);
	} catch (error) {
		if (options.signal.aborted) throw error;
		const failure = error instanceof ConverterError
			? { kind: error.kind, message: redact(error.message), retryable: error.retryable }
			: { kind: "internal" as const, message: redact(error instanceof Error ? error.message : String(error)), retryable: true };
		check("converted", "fail", `The conversion failed (${failure.kind}): ${failure.message}`);
		skipRest(["markers", "page_1", "page_2", "own_pages"]);
		const leaked = secrets.some((s) => (error instanceof Error ? error.message : String(error)).includes(s));
		check("no_secret", leaked ? "fail" : "pass", leaked ? "The error message contained the API key." : "The API key does not appear in the answer.");
		return report({ error: failure });
	}
	check("converted", "pass", `${converter.label ?? converter.id} answered for ${result.pages?.length ?? 0} pages.`);
	const warnings = (result.warnings ?? []).map(redact);

	const raw = JSON.stringify(result);
	const leaked = secrets.some((s) => raw.includes(s)) || (result.warnings ?? []).includes(SECRET_REDACTED_WARNING);

	let pages: { page: number; text: string }[] = [];
	try {
		const normalised = normaliseConversion(result, VALIDATION_SENTENCES.length);
		const read = contentPages(normalised.content);
		if (read.length !== 2 || read[0]!.page !== 1 || read[1]!.page !== 2) throw new ConverterError("bad_response", "The page-marked Markdown does not have exactly pages 1 and 2", false);
		pages = read.map((p) => ({ page: p.page, text: p.text.trim() }));
		check("markers", "pass", "Both pages are present, in order, as valid page-marked Markdown.");
	} catch (error) {
		check("markers", "fail", error instanceof ConverterError && error.kind === "no_text" ? "The converter found no text on either page." : `The answer cannot be placed on pages: ${(error as Error).message}`);
		skipRest(["page_1", "page_2", "own_pages"]);
		check("no_secret", leaked ? "fail" : "pass", leaked ? "The service's answer contained the API key." : "The API key does not appear in the answer.");
		return report({ converterVersion: result.converterVersion, warnings });
	}

	const [first, second] = VALIDATION_SENTENCES.map(comparable) as [string, string];
	const onPage = pages.map((p) => comparable(p.text));
	for (const [i, id] of (["page_1", "page_2"] as const).entries()) {
		const ownSentence = i === 0 ? first : second;
		if (onPage[i]!.includes(ownSentence)) check(id, "pass", `Page ${i + 1} has its own sentence.`);
		else check(id, "fail", `Page ${i + 1} does not have its sentence "${VALIDATION_SENTENCES[i]}".`);
	}
	const swapped = [onPage[0]!.includes(second) && "page 1 has page 2's sentence", onPage[1]!.includes(first) && "page 2 has page 1's sentence"].filter(Boolean);
	if (swapped.length) check("own_pages", "fail", `Text is on the wrong page (${swapped.join("; ")}): the service's page numbers are shifted or its page breaks are missing.`);
	else check("own_pages", "pass", "Neither page has the other page's sentence.");
	check("no_secret", leaked ? "fail" : "pass", leaked ? "The service's answer contained the API key." : "The API key does not appear in the answer.");

	return report({
		converterVersion: result.converterVersion,
		warnings,
		pages: pages.map((p) => ({ page: p.page, text: redact(p.text.slice(0, PREVIEW_CHARS)) })),
	});
}
