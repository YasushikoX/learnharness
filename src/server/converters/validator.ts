import { contentPages } from "../../core/material-split.ts";
import type { ConverterValidationReport, ValidationCheck, ValidationCheckId } from "../../core/converter-settings.ts";
import { ConverterError, type ConvertResult, type PdfConverter } from "../../core/pdf-converter.ts";
import { REDACTED, SECRET_REDACTED_WARNING, redactDeep, redactSecrets, seconds } from "./http-common.ts";
import { normaliseConversion } from "./normalise.ts";
export type { ConverterValidationReport, ValidationCheck, ValidationCheckId };
import { BLANK_PAGE_FILENAME, BLANK_PAGE_SENTENCES, VALIDATION_FILENAME, VALIDATION_SENTENCES, blankPageTestPdf, validationPdf } from "./validation-fixture.ts";

/**
 * The converter test (fork addition, 2026-11-25): runs ANY converter (pdfjs, Docling, a preset, a custom profile, a
 * draft from the later AI wizard) on the bundled test PDFs (validation-fixture.ts) and says whether its answer can
 * be trusted with page citations. The converter is called directly, never through the registry's fallback, so an
 * unreachable service fails here instead of passing as pdfjs. Settings → PDF conversion → Test calls this.
 *
 * Checks, in order:
 *   converted   the converter answered the two-page PDF without an error;
 *   markers     the host's normaliser accepted the answer (pages 1 and 2, each once, no others) and wrote valid
 *               page-marked Markdown;
 *   page_1, page_2   each page carries its own sentence;
 *   own_pages   neither page carries the other page's sentence (catches shifted or swapped numbering);
 *   blank_page  the three-page PDF with a BLANK middle page: three pages reported, page 2 empty, page 1's and page
 *               3's sentences on their own pages (a converter that cannot place a blank page fails here, saying so);
 *   no_secret   no secret (the API key, in any form http-common.ts knows) appears in an answer, a warning or an error.
 * The whole test has its own deadline (CONVERTER_TEST_DEADLINE_MS), whatever the conversion deadlines are. Every
 * string in the report has every secret removed, whatever its length.
 */

/** The longest a whole converter test may take (both PDFs). */
export const CONVERTER_TEST_DEADLINE_MS = 2 * 60_000;

export interface ValidateConverterOptions {
	signal: AbortSignal;
	/** Values that must not appear in the answer (the converter's key). Every non-empty one is checked. */
	secrets?: string[];
	onProgress?: (stage: string) => void;
	/** The deadline of the whole test (tests shorten it). */
	deadlineMs?: number;
}

const PREVIEW_CHARS = 300;

/** Lowercase letters and digits only, single spaces: OCR punctuation and line breaks do not matter. */
function comparable(text: string): string {
	return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

type Converted = { ok: true; result: ConvertResult } | { ok: false; kind: ConverterError["kind"] | "internal"; message: string; retryable: boolean; raw: string };

export async function validateConverter(converter: PdfConverter, options: ValidateConverterOptions): Promise<ConverterValidationReport> {
	const started = Date.now();
	const secrets = (options.secrets ?? []).filter((s) => s.length > 0).flatMap((s) => (s.trim() && s.trim() !== s ? [s, s.trim()] : [s]));
	const redact = (text: string) => redactSecrets(text, secrets);
	const leaks = (value: unknown) => secrets.length > 0 && JSON.stringify(redactDeep(value, secrets)) !== JSON.stringify(value);
	const deadlineMs = options.deadlineMs ?? CONVERTER_TEST_DEADLINE_MS;

	const controller = new AbortController();
	let timedOut = false;
	const onParent = () => controller.abort(options.signal.reason);
	if (options.signal.aborted) onParent();
	else options.signal.addEventListener("abort", onParent, { once: true });
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort(new Error("converter test deadline elapsed"));
	}, deadlineMs);

	const checks: ValidationCheck[] = [];
	const check = (id: ValidationCheckId, status: ValidationCheck["status"], message: string) => checks.push({ id, status, message });
	const skip = (ids: ValidationCheckId[]) => ids.forEach((id) => check(id, "skipped", "Not checked, because an earlier check failed."));
	let leaked = false;

	async function convert(bytes: Uint8Array, filename: string, pageCount: number): Promise<Converted> {
		try {
			const result = await converter.convert({ bytes, filename, pageCount }, { signal: controller.signal, onProgress: (stage) => options.onProgress?.(stage) });
			if (leaks(result) || (result.warnings ?? []).includes(SECRET_REDACTED_WARNING)) leaked = true;
			return { ok: true, result };
		} catch (error) {
			if (options.signal.aborted) throw error;
			const raw = error instanceof Error ? error.message : String(error);
			// a converter that removed an echoed key from its own error left [redacted] in its place
			if (leaks(raw) || (secrets.length > 0 && raw.includes(REDACTED))) leaked = true;
			if (timedOut) return { ok: false, kind: "timeout", message: `The test did not finish within ${seconds(deadlineMs)}`, retryable: true, raw };
			return error instanceof ConverterError
				? { ok: false, kind: error.kind, message: redact(error.message), retryable: error.retryable, raw }
				: { ok: false, kind: "internal", message: redact(raw), retryable: true, raw };
		}
	}

	const finish = (extra: Partial<ConverterValidationReport>): ConverterValidationReport => {
		check("no_secret", leaked ? "fail" : "pass", leaked ? "The API key appeared in the service's answer or error (it was removed from this report)." : "The API key does not appear in the answer.");
		return redactDeep(
			{
				ok: checks.every((c) => c.status === "pass"),
				converterId: converter.id,
				checks,
				pages: [],
				warnings: [],
				durationMs: Date.now() - started,
				...extra,
			},
			secrets,
		);
	};

	try {
		const first = await convert(validationPdf(), VALIDATION_FILENAME, VALIDATION_SENTENCES.length);
		if (!first.ok) {
			check("converted", "fail", `The conversion failed (${first.kind}): ${first.message}`);
			skip(["markers", "page_1", "page_2", "own_pages", "blank_page"]);
			return finish({ error: { kind: first.kind, message: first.message, retryable: first.retryable } });
		}
		const result = first.result;
		check("converted", "pass", `${converter.label ?? converter.id} answered for ${result.pages?.length ?? 0} pages.`);
		const base = { converterVersion: result.converterVersion, warnings: result.warnings ?? [] };

		let pages: { page: number; text: string }[] = [];
		let placed = true;
		try {
			const normalised = normaliseConversion(result, VALIDATION_SENTENCES.length);
			const read = contentPages(normalised.content);
			if (read.length !== 2 || read[0]!.page !== 1 || read[1]!.page !== 2) throw new ConverterError("bad_response", "The page-marked Markdown does not have exactly pages 1 and 2", false);
			pages = read.map((p) => ({ page: p.page, text: p.text.trim() }));
			check("markers", "pass", "Both pages are present, in order, as valid page-marked Markdown.");
		} catch (error) {
			placed = false;
			check("markers", "fail", error instanceof ConverterError && error.kind === "no_text" ? "The converter found no text on either page." : `The answer cannot be placed on pages: ${(error as Error).message}`);
			skip(["page_1", "page_2", "own_pages"]);
		}

		if (placed) {
			const [first1, second] = VALIDATION_SENTENCES.map(comparable) as [string, string];
			const onPage = pages.map((p) => comparable(p.text));
			for (const [i, id] of (["page_1", "page_2"] as const).entries()) {
				if (onPage[i]!.includes(i === 0 ? first1 : second)) check(id, "pass", `Page ${i + 1} has its own sentence.`);
				else check(id, "fail", `Page ${i + 1} does not have its sentence "${VALIDATION_SENTENCES[i]}".`);
			}
			const swapped = [onPage[0]!.includes(second) && "page 1 has page 2's sentence", onPage[1]!.includes(first1) && "page 2 has page 1's sentence"].filter(Boolean);
			if (swapped.length) check("own_pages", "fail", `Text is on the wrong page (${swapped.join("; ")}): the service's page numbers are shifted or its page breaks are missing.`);
			else check("own_pages", "pass", "Neither page has the other page's sentence.");
		}

		await blankPageCheck();
		return finish({ ...base, pages: pages.map((p) => ({ page: p.page, text: redact(p.text).slice(0, PREVIEW_CHARS) })) });
	} finally {
		clearTimeout(timer);
		options.signal.removeEventListener("abort", onParent);
	}

	/** The three-page PDF with a blank middle page. */
	async function blankPageCheck(): Promise<void> {
		const cannot = "This converter cannot place a blank page, so the text of pages after a blank page could land on the wrong page.";
		const converted = await convert(blankPageTestPdf(), BLANK_PAGE_FILENAME, BLANK_PAGE_SENTENCES.length);
		if (!converted.ok) {
			check("blank_page", "fail", `The three-page test PDF with a blank middle page failed (${converted.kind}): ${converted.message}. ${converted.kind === "timeout" ? "" : cannot}`.trim());
			return;
		}
		let read: { page: number; text: string }[];
		try {
			read = contentPages(normaliseConversion(converted.result, BLANK_PAGE_SENTENCES.length).content).map((p) => ({ page: p.page, text: p.text.trim() }));
		} catch (error) {
			check("blank_page", "fail", `The three-page test PDF with a blank middle page cannot be placed on pages: ${redact((error as Error).message)}. ${cannot}`);
			return;
		}
		const problems: string[] = [];
		if (read.length !== 3 || read.some((p, i) => p.page !== i + 1)) problems.push(`it reported ${read.length} pages instead of 3`);
		else {
			const [one, , three] = BLANK_PAGE_SENTENCES.map((s) => (s ? comparable(s) : "")) as [string, string, string];
			const onPage = read.map((p) => comparable(p.text));
			if (onPage[1]) problems.push(onPage[1].includes(three) ? "page 3's sentence is on the blank page 2" : "the blank page 2 has text");
			if (!onPage[0]!.includes(one)) problems.push("page 1 does not have its sentence");
			if (!onPage[2]!.includes(three)) problems.push("page 3 does not have its sentence");
		}
		if (problems.length) check("blank_page", "fail", `With a blank middle page, ${problems.join("; ")}. ${cannot}`);
		else check("blank_page", "pass", "A blank middle page stays blank and the page after it keeps its own text.");
	}
}
