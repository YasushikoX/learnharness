"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ClarifyWording } from "@/components/clarify-wording";
import { ConfidenceRail } from "@/components/confidence-rail";
import { GlyphMark } from "@/components/ui/glyph-mark";
import { StatusBadge } from "@/components/ui/status-badge";
import { SubmittedImages } from "./submitted-images";
import { ThinkingBlock } from "@/components/thinking-block";
import { PathText } from "@/components/file-path-chip";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { FigureScope } from "@/components/figures/figure-scope";
import { SketchReadingBody } from "@/components/artifacts/read-sketch-card";
import { SketchThumbnail } from "@/components/sketch/sketch-thumbnail";
import { AnsweredKeyPoints } from "@/components/answered-key-points";
import type { ArtifactPartProps, QuestionAnswerData } from "@/src/core";
import { answeredCardContent, answeredOptionLetters, parseAskInput, parseQuizInput } from "@/src/core";
import { useAppearance } from "@/components/settings/appearance";
import { questionCardLabel, questionCardStandIn } from "@/components/question-dock";
import {
	ANSWER_COLUMN_INSET_CSS,
	COLUMN_GAP_CSS,
	effectiveQuestionGeometry,
	layoutFontKey,
	rootRem,
	wideDockScreen,
} from "@/components/question-layout";
import { useQuestionLayout, type QuestionLayoutRequest } from "@/components/use-question-layout";

/** The nearest scrolling ancestor (the transcript), for "near the screen". */
function scrollParent(el: HTMLElement): HTMLElement | null {
	for (let p = el.parentElement; p; p = p.parentElement) {
		if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
	}
	return null;
}

/**
 * Static rendering of an answered question (tool part in `output-available`).
 *
 * Quiz answers are GRADED: ✓/✗ marks, the correct answers, and the
 * explanation. Ask answers are NOT graded — a plain record of what was said.
 * (The v1 bug this pins: ask answers must never get quiz grading UI.)
 * Explain answers are graded by the MODEL in its next reply, not by the
 * client — the card reveals his answer, the committed correct answer, and
 * the explanation, with NO verdict chips (owner ruling 2026-09-27).
 */
export function AnsweredCard({ answer: savedAnswer, input, chatId, reading, messageId, callId, toolCallId: givenToolCallId, keyPointsMet }: { answer: QuestionAnswerData; input?: unknown; chatId?: string; reading?: ArtifactPartProps["part"]; messageId?: string; callId?: string; toolCallId?: string; /** The tutor's verdict per key point (WP6, core/question-quality.ts keyPointMarksOf). */ keyPointsMet?: ReadonlySet<number> }) {
	// The question's call id: upstream names it `toolCallId` (the layout cache), the fork `callId` (the wording's threads).
	const toolCallId = givenToolCallId ?? callId;
	// What the card shows is decided in core/learner-seen.ts, where the vocabulary ledger reads the same decision (WP5).
	const content = answeredCardContent(savedAnswer, input);
	const answer = content.answer;
	const optionLetters = answeredOptionLetters(savedAnswer, input);
	const [whyOpen, setWhyOpen] = useState(false); // the tucked explanation (predictions, owner 2026-10-03)

	// ADAPT QUESTION LAYOUT on the record (owner, session-appearance-layout):
	// an answered question gets two columns exactly when its question card
	// did — the same solver, measured on a stand-in of the question card
	// (questionCardStandIn) built from this card's own rendered markdown,
	// at the same reference width. The card stays full transcript width:
	// the answer column keeps the question card's width, the question takes
	// the rest. Measured once, the first time the card nears the screen.
	const { appearance } = useAppearance();
	const cardRef = useRef<HTMLDivElement>(null);
	const questionColRef = useRef<HTMLDivElement>(null);
	const questionTextRef = useRef<HTMLDivElement>(null);
	const detailsRef = useRef<HTMLDivElement>(null);
	const optionsRef = useRef<HTMLDivElement>(null);
	const adaptable = appearance.adaptiveQuestions && !!toolCallId && !answer.dismissed
		&& (answer.kind === "quiz" || answer.kind === "ask") && (answer.options?.length ?? 0) > 0;
	const [near, setNear] = useState(false);
	const [cardInner, setCardInner] = useState(0);
	const [rem, setRem] = useState(16);
	const [wide, setWide] = useState(false);
	useEffect(() => {
		const card = cardRef.current;
		if (!adaptable || near || !card) return;
		const io = new IntersectionObserver((entries) => {
			if (entries.some((e) => e.isIntersecting)) setNear(true);
		}, { root: scrollParent(card), rootMargin: "100% 0px" });
		io.observe(card);
		return () => io.disconnect();
	}, [adaptable, near]);
	useEffect(() => {
		const card = cardRef.current;
		if (!adaptable || !near || !card) return;
		// The card's inner width (its padding included, borders not) is the
		// question card's budget in the dock: the same transcript width.
		const measure = () => {
			setCardInner(card.clientWidth);
			setRem(rootRem(card.ownerDocument));
			setWide(wideDockScreen());
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(card);
		return () => ro.disconnect();
	}, [adaptable, near]);
	const fontKey = layoutFontKey(appearance);
	// The pending dock's effective geometry (wide dock, Transcript width cap), so the answered card solves as it did.
	const geometry = effectiveQuestionGeometry(rem, wide, appearance.transcriptMaxWidth);
	const request: QuestionLayoutRequest | null = adaptable && near && cardInner > 0
		? { available: cardInner, base: geometry.base, floor: geometry.floor, key: fontKey }
		: null;
	const multiSelect = (answer.kind === "quiz" ? parseQuizInput(input)?.multiSelect : parseAskInput(input)?.multiSelect) ?? false;
	const label = questionCardLabel(answer.tool, answer.kind, answer.questionType);
	const layout = useQuestionLayout({
		cacheId: `answered|${toolCallId ?? ""}`,
		request,
		identity: toolCallId,
		live: () => {
			const card = cardRef.current;
			const question = questionColRef.current;
			const text = questionTextRef.current;
			if (!card || !question || !text) return null;
			return { root: card, question, options: optionsRef.current, observe: [text, detailsRef.current, optionsRef.current] };
		},
		parts: (live) => {
			const labels = [...(live.options?.querySelectorAll<HTMLElement>("[data-answered-option-label]") ?? [])];
			const standIn = questionCardStandIn(live.root.ownerDocument, {
				label,
				kind: answer.kind === "quiz" ? "quiz" : "ask",
				multiSelect,
				question: questionTextRef.current!,
				context: detailsRef.current,
				options: labels,
				optionLetters: answer.options?.map(({ index }) => optionLetters.get(index)),
			});
			return { root: live.root, ...standIn, media: { question: live.question, options: live.options } };
		},
	});
	const columns = layout?.kind === "columns" ? layout : null;
	const columnStyle: CSSProperties | undefined = columns
		? { gridTemplateColumns: `minmax(0, 1fr) calc(${columns.answer}px - ${ANSWER_COLUMN_INSET_CSS})`, columnGap: COLUMN_GAP_CSS }
		: undefined;

	if (content.dismissed) {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				<span className="font-medium">{content.questionText}</span> — {content.steer ? "set aside" : "skipped"}
				{content.steer && <p data-testid="answered-steer" className="mt-1.5 whitespace-pre-wrap text-foreground">You told the tutor: {content.steer}</p>}
			</div>
		);
	}

	const isQuiz = answer.kind === "quiz";
	const isExplain = answer.kind === "explain";
	const selectedIdx = new Set(answer.answers.map((a) => a.index));
	const correctIdx = new Set(answer.correctIndices ?? []);
	// The question's own context rides the ORIGINAL CALL, not the answer
	// snapshot (owner, 2026-10-12): the details line — and, for ask
	// questions, option descriptions — re-render from the persisted
	// arguments, so every existing transcript shows them too. The lean
	// snapshot (what the model sees, compactAnswerForModel) is untouched;
	// any parse failure or absent input renders exactly the older card.
	const parsedDetails = content.details;
	const descByIndex = content.optionDescriptions;

	return (
		// one figure scope for the whole card (figures, 2026-10-26)
		<FigureScope texts={[content.questionText, parsedDetails, content.tuckedExplanation, ...(answer.options ?? []).map((o) => o.label)]}>
		{/* The reading channel LIFTED (owner round, 2026-10-05): thoughts
		    captured while reading are chronologically PRIOR to the question —
		    rendered as its own user-side block ABOVE the card, the unified
		    ThinkingBlock, instead of an inset inside the answer. Same muted
		    rail as before; the label is now plain "Your thinking". */}
		{(answer.readingThinking || answer.images?.readingThinking?.length) && (
			<ThinkingBlock testId="reading-thinking-block" label="Your thinking" text={answer.readingThinking ?? ""} images={answer.images?.readingThinking} defaultOpen />
		)}
		{/* [&>*:last-child]:mb-0 (owner round, 2026-10-07): on ask cards the
		    thinking row is the last child — its my-3 stacked with the card's
		    p-4 into a 28px void below (12px above); the card's own padding is
		    the bottom rhythm when a row ends the card. */}
		<div
			ref={cardRef}
			className="rounded-xl border bg-card p-4 text-card-foreground [&>*:last-child]:mb-0"
			data-testid="answered-card"
			data-question-layout={columns ? "columns" : "stacked"}
		>
			{/* Two columns (Adapt question layout): question left; options,
			    confidence and the answer right, centered; everything else full
			    width below. Stacked, the wrappers are display: contents — the
			    card is exactly the stacked one. */}
			<div className={columns ? "grid" : "contents"} style={columnStyle}>
			<div ref={questionColRef} className={columns ? "min-w-0 [&>*:last-child]:mb-0" : "contents"}>
			<div className="mb-1 flex items-center gap-2 lh-eyebrow text-muted-foreground">
				{/* The tool's OWN name first (owner 2026-10-09): probe-phase
			    cards label Probe/Recall — the phase boundary visible in the
			    transcript. No `tool` on old records: kind labels as before. */}
				{label}
				{isQuiz &&
					(answer.dontKnow ? (
						<StatusBadge text="didn't know" />
					) : answer.correct ? (
						<StatusBadge text="correct" color="var(--lh-success)" />
					) : (
						<StatusBadge text="incorrect" color="var(--lh-error)" />
					))}
				{/* hints taken before answering (owner, 2026-11-13 — core/hints.ts) */}
				{Array.isArray(answer.hints) && answer.hints.length > 0 && (
					<StatusBadge text={`${answer.hints.length} hint${answer.hints.length === 1 ? "" : "s"}`} />
				)}
			</div>
			{/* The wording stays markable after the answer (owner, 2026-11-06): threads asked while it sat in the dock hang here. */}
			<ClarifyWording messageId={messageId} callId={toolCallId}>
				<div ref={questionTextRef} className="mb-3 font-medium">
					<ToolContentResponse>{content.questionText}</ToolContentResponse>
				</div>
				{parsedDetails && (
					// The details line, same paint as the pending dock (owner,
					// 2026-10-12): full markdown, LaTeX included.
					<div ref={detailsRef} className="mb-3 text-sm text-muted-foreground">
						<ToolContentResponse>{parsedDetails}</ToolContentResponse>
					</div>
				)}
			</ClarifyWording>
			</div>
			<div className={columns ? "flex min-w-0 flex-col justify-center" : "contents"}>

			{((answer.options?.length ?? 0) > 0 || answer.other) && (
				<div ref={optionsRef} className="flex flex-col gap-1.5 text-sm">
					{answer.options?.map((opt) => {
						const sel = selectedIdx.has(opt.index);
						const key = isQuiz && correctIdx.has(opt.index);
						const letter = optionLetters.get(opt.index);
						return (
							<div
								key={opt.index}
								className={cn(
									"flex items-center gap-2 rounded-md border border-border px-3 py-1.5",
									sel && key && "border-success/60 bg-success/10",
									sel && !key && isQuiz && "border-error/60 bg-error/10",
									sel && !isQuiz && "border-primary bg-primary/[0.07]",
									!sel && key && "border-success/40",
								)}
							>
								{letter && <span data-option-letter={letter} className="w-3 shrink-0 text-center text-xs font-medium text-muted-foreground">{letter}</span>}
								{isQuiz && (
									// Zapf-Dingbats-derived SVG outlines — the exact LaTeX \ding{51}/
									// \ding{55} hand-drawn shapes (owner, round 6); see ui/glyph-mark.
									<span
										aria-hidden
										data-mark={sel && key ? "check" : sel && !key ? "x" : !sel && key ? "check" : undefined}
										className={cn(
											"flex shrink-0 items-center",
											sel && key && "text-success",
											sel && !key && "text-error",
											!sel && key && "text-success",
										)}
									>
										{/* Owner round 8: a touch smaller than the text (size-4→size-3.5,
											   ≈14px vs the 16px row) while centered. */}
										{(key || sel) && <GlyphMark kind={key ? "check" : "x"} className="size-3.5" />}
									</span>
								)}
								<span data-answered-option-label="" className={cn(!sel && "text-muted-foreground")}>
									<ToolContentResponse>{opt.label}</ToolContentResponse>
									{descByIndex.get(opt.index) && (
										// Ask-option subtext (owner, 2026-10-12): same markdown path
										// as the pending dock — LaTeX included. Quiz options carry
										// none (owner ruling 2026-09-26); the map stays empty for them.
										<ToolContentResponse className="lh-prose block text-xs text-muted-foreground">
											{descByIndex.get(opt.index)}
										</ToolContentResponse>
									)}
								</span>
							</div>
						);
					})}
					{/* The learner's own typed option is an OPTION — same container,
					    same selected styling as its siblings, not a loose quote
					    floating outside the list. Quotes keep the learner's words. */}
					{answer.other && (
						<div
							data-testid="answered-other"
							className="flex items-center gap-2 rounded-md border border-primary bg-primary/[0.07] px-3 py-1.5"
						>
							<span>“<PathText text={answer.other} />”</span>
						</div>
					)}
				</div>
			)}

			{answer.text && <div className="lh-prose mt-2 whitespace-pre-wrap">“<PathText text={answer.text} />”</div>}
			<SubmittedImages images={answer.images?.answer} />

			{/* The confidence record (owner round 6): the slider's rail, disc
			    removed — the missing handle itself says "this is a record, not a
			    control". Same paint, same ticks, same ramp, same % read-out as the
			    live dock. Quiz answers only, and only when a confidence exists:
			    "I don't know" sent none (its slider was grayed out), explain and
			    ask never had one, and records from before the feature carry no
			    field — nothing to show, nothing rendered. */}
			{answer.confidence != null && (
				<div className="mt-3 flex items-center gap-3" data-testid="answered-confidence">
					<ConfidenceRail value={answer.confidence} className="min-w-0 flex-1" />
					{/* Sized for "100%", shorter values centered (as on the question card). */}
					<span className="w-[4ch] shrink-0 text-center text-sm tabular-nums text-muted-foreground">
						{answer.confidence}%
					</span>
				</div>
			)}
			{answer.dontKnow && (isQuiz || answer.tool === "recall") && (
				<div className="mt-2 text-sm text-muted-foreground">Answered “I don't know”.</div>
			)}
			</div>
			</div>

			{answer.sketch && chatId && <SketchThumbnail chatId={chatId} sketch={answer.sketch} />}
			{/* the tutor's reading of it, in this same box (owner, 2026-10-29) */}
			{reading && <SketchReadingBody part={reading} framed />}

			{((answer.thinking ?? answer.note) || answer.images?.thinking?.length) && (
				/* The SAME unified row (owner round, 2026-10-05): the quiz answer's
				    thinking is the identical collapsible ThinkingBlock — one
				    geometry, but NO band on the card (owner round five, 2026-10-07:
				    the accent lift read too light); rail only, heights identical. */
				<ThinkingBlock
					testId="your-thinking"
					label="Your thinking"
					text={answer.thinking ?? answer.note ?? ""}
					images={answer.images?.thinking}
					inCard
				/>
			)}

			{/* px-3→removed: card p-4 + box px-3 double-inset sat the "Why" label deeper
			    than the option box edges (owner, round 3). Sides flush with everything
			    else; py-2 stays for vertical air. */}
			{isQuiz && content.tuckedExplanation && (
				/* The TUCKED explanation — ALL questions (owner, 2026-10-07): the
				   verdict shows, the explanation sits collapsed behind the Why
				   toggle — viewable, never center stage. Identical to the
				   prediction pattern it generalizes (owner, 2026-10-03). */
				<div className="mt-2" data-testid="tucked-explanation">
					<Button
						type="button"
						variant="ghost"
						size="xs"
						onClick={() => setWhyOpen((v) => !v)}
						className="lh-touch -ml-2 text-muted-foreground hover:text-foreground"
					>
						{whyOpen ? "Hide why" : "Why"}
					</Button>
					{whyOpen && (
						<div className="mt-1.5 text-sm text-foreground">
							<span className="font-semibold">Why: </span>
							{/* Keep the first paragraph beside the label, not every paragraph:
							   later paragraphs must retain their recovered document structure. */}
							<ToolContentResponse className="inline [&>p:first-child]:inline [&>p:first-child]:m-0">{content.tuckedExplanation}</ToolContentResponse>
						</div>
					)}
				</div>
			)}

			{/* The explain reveal (owner ruling 2026-09-27): the committed answer
			    — one field, reasoning included — shown on submit; no verdict,
			    the model's next reply IS the grading. */}
			{isExplain && content.committed && (
				// UI round 1b (SPEC §7 "Feedback text"): an eyebrow label over the explanation, in the TEXT colour.
				<div className="mt-4 border-t border-border pt-3 text-foreground" data-testid="answered-committed">
					<div className="mb-1 lh-eyebrow text-muted-foreground">The answer</div>
					<ToolContentResponse>{content.committed}</ToolContentResponse>
				</div>
			)}
			{isExplain && <AnsweredKeyPoints points={content.keyPoints} met={keyPointsMet} />}
		</div>
		</FigureScope>
	);
}
