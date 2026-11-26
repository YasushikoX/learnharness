"use client";

/**
 * The course page's three ways in (fork addition, 2026-11-25): Learn, Short question, Practice — side by side at the top
 * of the page. Learn and Practice start what the page's own actions already start (the first lesson of Next up, through
 * its pace dialog; Practice all over what is being learned); Short question opens the course's Ask conversation
 * (agent/ask-agent.ts), reopening the newest one, with a separate button for a fresh one.
 *
 * UI class page (2026-11-25, owner: "'Short question' should just be called that, no need for explanation"): a way in
 * that cannot start is not shown at all (before a skill map, only Short question), and a card's second line appears
 * only when it carries real state ("Next: Proton gradients…"), never a description.
 */

import { buttonVariants } from "@/components/ui/button";
import { BookOpenIcon, DumbbellIcon, MessageCircleQuestionIcon, PlusIcon } from "lucide-react";
import type { CourseView } from "@/src/core";
import { cn } from "@/lib/utils";

/** UI round 1b (SPEC §7 "Course page"): each way in is ONE whole-card button, no button inside a card. The card is a
 *  hairline surface that takes one fill step on hover; an unavailable card keeps its line readable (it says what is
 *  needed first) and only its icon and title go quiet. Ask's "New" sits beside the card button, not inside it. */
// UI round 2: one slim row of whole-card buttons (56px: icon, title, a one-line muted description) under the header, so
// Next up below is the page's dominant card.
const CARD =
	"lh-touch group/mode flex h-14 w-full min-w-0 items-center gap-3 rounded-lg border border-border bg-card px-3 text-left outline-none transition-colors duration-(--lh-duration-hover) ease-(--lh-ease) enabled:hover:bg-raised enabled:active:bg-raised-strong focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-default";
/** Short question's "new conversation": a 32px icon button, so the card keeps room for its title at 1024. */
const NEW_BTN = buttonVariants({ variant: "secondary", size: "icon" });

type ModesData = Pick<CourseView, "course" | "skills" | "nextUp" | "notExamined" | "learning" | "known" | "plan" | "sessions"> & { drafting?: boolean };

/** One way in: can it start now, and the line under it when it carries state (what it starts next). */
export interface ModeState {
	available: boolean;
	line?: string;
}

/** The UI name of the Ask mode (the session list and the prompts keep "Questions", COURSE_MODE_LABEL). */
export const SHORT_QUESTION = "Short question";

/** What Learn starts: the first lesson the Next up box offers (today's first, else the next skill by exam priority, else
 *  a skill no exam uses), as a skill id; undefined when nothing is left to learn. Pure. */
export function learnTarget(data: ModesData): string | undefined {
	return data.plan.lessons[0] ?? data.nextUp[0] ?? data.notExamined[0];
}

/** The three ways in, for a course payload. Pure — exported for render tests. */
export function courseModeStates(data: ModesData): { learn: ModeState; practice: ModeState; ask: ModeState & { reopen?: string } } {
	const last = data.sessions.find((s) => s.mode === "ask");
	// the untouched default title ("Questions: <class>") says nothing: then only that there is one to continue
	const ask = last
		? { available: true, line: last.title === `Questions: ${data.course.title}` ? "Continue the last one" : `Continue: ${last.title}`, reopen: last.id }
		: { available: true };
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
	/** Open the Ask conversation: `reopen` = an existing one's chat id; absent = a new one. */
	onAsk?: (reopen?: string) => void;
}) {
	const states = courseModeStates(data);
	const target = learnTarget(data);
	const card = (id: "learn" | "ask" | "practice", icon: React.ReactNode, label: string, state: ModeState, start: () => void, extra?: React.ReactNode) =>
		state.available && (
			<div key={id} className="relative min-w-0" data-testid={`course-mode-${id}`} data-available="true">
				<button type="button" className={cn(CARD, extra && "pr-14")} disabled={busy} data-testid={`course-mode-${id}-start`} onClick={start} title={state.line}>
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
				{extra && <span className="absolute top-1/2 right-3 -translate-y-1/2">{extra}</span>}
			</div>
		);
	const shown = [states.learn, states.ask, states.practice].filter((s) => s.available).length;
	return (
		<div className="@container">
			<section data-testid="course-modes" aria-label="Ways to study this class" className={cn("grid gap-3", GRID_COLS[shown])}>
				{card("learn", <BookOpenIcon strokeWidth={1.75} />, "Learn", states.learn, () => target && onLearn(target))}
				{card(
					"ask",
					<MessageCircleQuestionIcon strokeWidth={1.75} />,
					SHORT_QUESTION,
					states.ask,
					() => onAsk?.(states.ask.reopen),
					states.ask.reopen ? (
						<button
							type="button"
							className={cn(NEW_BTN, "lh-touch")}
							disabled={busy || !onAsk}
							aria-label="New short question"
							title="New short question"
							data-testid="course-mode-ask-new"
							onClick={() => onAsk?.()}
						>
							<PlusIcon aria-hidden />
						</button>
					) : undefined,
				)}
				{card("practice", <DumbbellIcon strokeWidth={1.75} />, "Practice", states.practice, onPractice)}
			</section>
		</div>
	);
}
