"use client";

/**
 * The course page's three ways in (fork addition, 2026-11-25): Learn, Short question, Practice — side by side at the top
 * of the page. Learn and Practice start what the page's own actions already start (the first lesson of Next up, through
 * its pace dialog; Practice all over what is being learned); Short question starts a new Ask conversation on the course
 * (agent/ask-agent.ts).
 *
 * UI round 12 (owner: "Clicking the buttons for Learn, Practice or Short question from the class view should start a new
 * conversation, not just go to the old one"; "Why does the Short question button have an add sign inside it?"): every
 * card starts a NEW session, and Short question is a plain card like the others (no "+" inside, no "Continue:" line).
 * Earlier sessions, finished or not, stay one click away in Recent sessions.
 *
 * UI class page (2026-11-25, owner: "'Short question' should just be called that, no need for explanation"): a way in
 * that cannot start is not shown at all (before a skill map, only Short question), and a card's second line appears
 * only when it carries real state ("Next: Proton gradients…"), never a description. Short question's line is the one
 * short hint (UI round 12), in the same style.
 */

import { BookOpenIcon, DumbbellIcon, MessageCircleQuestionIcon } from "lucide-react";
import type { CourseView } from "@/src/core";
import { cn } from "@/lib/utils";

/** UI round 1b (SPEC §7 "Course page"): each way in is ONE whole-card button, no button inside a card. The card is a
 *  hairline surface that takes one fill step on hover; an unavailable card keeps its line readable (it says what is
 *  needed first) and only its icon and title go quiet. */
// UI round 2: one slim row of whole-card buttons (56px: icon, title, a one-line muted description) under the header, so
// Next up below is the page's dominant card.
const CARD =
	"lh-touch group/mode flex h-14 w-full min-w-0 items-center gap-3 rounded-lg border border-border bg-card px-3 text-left outline-none transition-colors duration-(--lh-duration-hover) ease-(--lh-ease) enabled:hover:bg-raised enabled:active:bg-raised-strong focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-default";

type ModesData = Pick<CourseView, "course" | "skills" | "nextUp" | "notExamined" | "learning" | "known" | "plan" | "sessions"> & { drafting?: boolean };

/** One way in: can it start now, and the line under it when it carries state (what it starts next). */
export interface ModeState {
	available: boolean;
	line?: string;
}

/** The UI name of the Ask mode (the session list and the prompts keep "Questions", COURSE_MODE_LABEL). */
export const SHORT_QUESTION = "Short question";
/** The Short question card's second line (UI round 12): a hint, since the card no longer continues an earlier one. */
export const SHORT_QUESTION_HINT = "Ask anything about this class";

/** What Learn starts: the first lesson the Next up box offers (today's first, else the next skill by exam priority, else
 *  a skill no exam uses), as a skill id; undefined when nothing is left to learn. Pure. */
export function learnTarget(data: ModesData): string | undefined {
	return data.plan.lessons[0] ?? data.nextUp[0] ?? data.notExamined[0];
}

/** The three ways in, for a course payload. Pure — exported for render tests. */
export function courseModeStates(data: ModesData): { learn: ModeState; practice: ModeState; ask: ModeState } {
	// Always a new conversation (UI round 12): the earlier ones are in Recent sessions.
	const ask = { available: true, line: SHORT_QUESTION_HINT };
	if (data.skills.length === 0) return { learn: { available: false }, practice: { available: false }, ask };
	const names = new Map(data.skills.map((s) => [s.id, s.name]));
	const target = learnTarget(data);
	const learn = target ? { available: true, line: `Next: ${names.get(target) ?? target}` } : { available: false };
	const n = data.learning.length;
	const practice = n > 0 ? { available: true, line: n === 1 ? "1 skill you are learning" : `${n} skills you are learning` } : { available: false };
	return { learn, practice, ask };
}

const GRID_COLS: Record<number, string> = { 1: "@lg:grid-cols-1", 2: "@lg:grid-cols-2", 3: "@lg:grid-cols-3" };

export function CourseModes({
	data,
	busy,
	onLearn,
	onPractice,
	onAsk,
}: {
	data: ModesData;
	busy: boolean;
	/** Start a lesson on this skill (the page's Learn: its pace dialog first). */
	onLearn: (skillId: string) => void;
	/** Practice everything being learned (the page's Practice all). */
	onPractice: () => void;
	/** Start a new Ask conversation. */
	onAsk?: () => void;
}) {
	const states = courseModeStates(data);
	const target = learnTarget(data);
	const card = (id: "learn" | "ask" | "practice", icon: React.ReactNode, label: string, state: ModeState, start: () => void) =>
		state.available && (
			<div key={id} className="min-w-0" data-testid={`course-mode-${id}`} data-available="true">
				<button type="button" className={CARD} disabled={busy} data-testid={`course-mode-${id}-start`} onClick={start} title={state.line}>
					<span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-sm bg-secondary text-foreground [&_svg]:size-4">
						{icon}
					</span>
					<span className="flex min-w-0 flex-1 flex-col">
						<span className="truncate whitespace-nowrap text-body font-semibold">{label}</span>
						{state.line && (
							<span className="truncate whitespace-nowrap text-meta text-muted-foreground" data-testid={`course-mode-${id}-line`}>
								{state.line}
							</span>
						)}
					</span>
				</button>
			</div>
		);
	const shown = [states.learn, states.ask, states.practice].filter((s) => s.available).length;
	return (
		<div className="@container">
			<section data-testid="course-modes" aria-label="Ways to study this class" className={cn("grid gap-3", GRID_COLS[shown])}>
				{card("learn", <BookOpenIcon strokeWidth={1.75} />, "Learn", states.learn, () => target && onLearn(target))}
				{card("ask", <MessageCircleQuestionIcon strokeWidth={1.75} />, SHORT_QUESTION, states.ask, () => onAsk?.())}
				{card("practice", <DumbbellIcon strokeWidth={1.75} />, "Practice", states.practice, onPractice)}
			</section>
		</div>
	);
}
