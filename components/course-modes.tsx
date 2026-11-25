"use client";

/**
 * The course page's three ways in (fork addition, 2026-11-25): Learn, Ask, Practice — side by side at the top of the
 * page. Learn and Practice start what the page's own actions already start (the first lesson of Next up, through its
 * pace dialog; Practice all over what is being learned); Ask opens the course's Ask conversation (agent/ask-agent.ts),
 * reopening the newest one, with a separate button for a fresh one. Before a skill map exists only Ask works, and Learn
 * and Practice say what is needed first, from the same course state the page already shows (status, draft, drafting).
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
const NEW_BTN = buttonVariants({ variant: "secondary", size: "xs" });

type ModesData = Pick<CourseView, "course" | "skills" | "nextUp" | "notExamined" | "learning" | "known" | "plan" | "sessions"> & { drafting?: boolean };

/** One way in: can it start now, and the line under it (what it starts, or what it needs first). */
export interface ModeState {
	available: boolean;
	line: string;
}

/** Why Learn and Practice cannot start yet while the course has no approved skill map (the page's own states). */
function noMapReason(data: ModesData): string {
	if (data.drafting || data.course.status === "drafting") return "Waits for the skill map, which is being drafted now.";
	if (data.course.draft) return "Waits for the skill map: review and approve the draft below.";
	if (data.course.status === "error") return "Waits for the skill map: drafting failed, see Course settings.";
	return "Waits for a skill map: add the class's sources and draft one in Course settings.";
}

/** What Learn starts: the first lesson the Next up box offers (today's first, else the next skill by exam priority, else
 *  a skill no exam uses), as a skill id; undefined when nothing is left to learn. Pure. */
export function learnTarget(data: ModesData): string | undefined {
	return data.plan.lessons[0] ?? data.nextUp[0] ?? data.notExamined[0];
}

/** The three ways in, for a course payload. Pure — exported for render tests. */
export function courseModeStates(data: ModesData): { learn: ModeState; practice: ModeState; ask: ModeState & { reopen?: string } } {
	const hasAsk = data.sessions.find((s) => s.mode === "ask");
	const ask = hasAsk
		? { available: true, line: "Continue your questions, or start a new conversation.", reopen: hasAsk.id }
		: { available: true, line: "Short answers from the class material, with page references." };
	if (data.skills.length === 0) {
		const line = noMapReason(data);
		return { learn: { available: false, line }, practice: { available: false, line }, ask };
	}
	const names = new Map(data.skills.map((s) => [s.id, s.name]));
	const target = learnTarget(data);
	const learn = target
		? { available: true, line: `Next: ${names.get(target) ?? target}` }
		: { available: false, line: "Every skill is learned. Practice and Review keep them." };
	const n = data.learning.length;
	const practice = n > 0
		? { available: true, line: n === 1 ? "The 1 skill you are learning." : `The ${n} skills you are learning, mixed.` }
		: {
				available: false,
				line: data.known.length === data.skills.length ? "Every skill is known. Review keeps them fresh." : "Finish a lesson first: Practice works on what you have learned.",
			};
	return { learn, practice, ask };
}

export function CourseModes({
	data,
	busy,
	onLearn,
	onPractice,
	onAsk,
	quiet = false,
}: {
	data: ModesData;
	busy: boolean;
	/** Start a lesson on this skill (the page's Learn: its pace dialog first). */
	onLearn: (skillId: string) => void;
	/** Practice everything being learned (the page's Practice all). */
	onPractice: () => void;
	/** Open the Ask conversation: `reopen` = an existing one's chat id; absent = a new one. */
	onAsk?: (reopen?: string) => void;
	/** Before a skill map (UI round 2): a quieter, smaller row below the setup; the shared reason shows once beneath it. */
	quiet?: boolean;
}) {
	const states = courseModeStates(data);
	const target = learnTarget(data);
	const card = (
		id: "learn" | "ask" | "practice",
		icon: React.ReactNode,
		label: string,
		state: ModeState,
		start: () => void,
		extra?: React.ReactNode,
	) => (
		<div className="relative min-w-0" data-testid={`course-mode-${id}`} data-available={state.available ? "true" : "false"}>
			<button type="button" className={cn(CARD, quiet && "h-12", extra && "pr-20")} disabled={busy || !state.available} data-testid={`course-mode-${id}-start`} onClick={start} title={state.line}>
				<span
					aria-hidden
					className={cn(
						"flex size-7 shrink-0 items-center justify-center rounded-sm bg-secondary [&_svg]:size-4",
						state.available ? "text-foreground" : "text-muted-foreground",
					)}
				>
					{icon}
				</span>
				<span className="flex min-w-0 flex-1 flex-col">
					<span className={cn("truncate whitespace-nowrap", quiet ? "text-chrome font-medium" : "text-body font-semibold", !state.available && "text-muted-foreground")}>{label}</span>
					<span className={cn("truncate whitespace-nowrap text-meta text-muted-foreground", quiet && !state.available && "sr-only")} data-testid={`course-mode-${id}-line`}>
						{state.line}
					</span>
				</span>
			</button>
			{extra && <span className="absolute top-1/2 right-3 -translate-y-1/2">{extra}</span>}
		</div>
	);
	return (
		<section data-testid="course-modes" aria-label="Ways to study this class" className={cn("grid gap-3 sm:grid-cols-3", quiet && "gap-2")}>
			{card("learn", <BookOpenIcon strokeWidth={1.75} />, "Learn", states.learn, () => target && onLearn(target))}
			{card(
				"ask",
				<MessageCircleQuestionIcon strokeWidth={1.75} />,
				"Ask about this class",
				states.ask,
				() => onAsk?.(states.ask.reopen),
				states.ask.reopen ? (
					<button
						type="button"
						className={cn(NEW_BTN, "lh-touch")}
						disabled={busy || !onAsk}
						aria-label="New conversation about this class"
						title="Start a new conversation"
						data-testid="course-mode-ask-new"
						onClick={() => onAsk?.()}
					>
						<PlusIcon aria-hidden />
						New
					</button>
				) : undefined,
			)}
			{card("practice", <DumbbellIcon strokeWidth={1.75} />, "Practice", states.practice, onPractice)}
			{quiet && !states.learn.available && (
				<p className="text-meta text-muted-foreground sm:col-span-3" data-testid="course-modes-reason">{states.learn.line}</p>
			)}
		</section>
	);
}
