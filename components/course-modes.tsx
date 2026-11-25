"use client";

/**
 * The course page's three ways in (fork addition, 2026-11-25): Learn, Ask, Practice — side by side at the top of the
 * page. Learn and Practice start what the page's own actions already start (the first lesson of Next up, through its
 * pace dialog; Practice all over what is being learned); Ask opens the course's Ask conversation (agent/ask-agent.ts),
 * reopening the newest one, with a separate button for a fresh one. Before a skill map exists only Ask works, and Learn
 * and Practice say what is needed first, from the same course state the page already shows (status, draft, drafting).
 */

import { buttonVariants } from "@/components/ui/button";
import { BookOpenIcon, DumbbellIcon, MessageCircleQuestionIcon } from "lucide-react";
import type { CourseView } from "@/src/core";
import { cn } from "@/lib/utils";

/** UI round 1 (SPEC §3): ordinary actions are secondary sm Buttons; the region's one emphasised action is primary. */
const BTN = buttonVariants({ variant: "secondary", size: "sm" });
const CARD = "flex min-w-0 flex-col gap-2 rounded-xl border border-border/60 bg-card/50 p-4";

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
	const card = (
		id: "learn" | "ask" | "practice",
		icon: React.ReactNode,
		label: string,
		state: ModeState,
		start: () => void,
		extra?: React.ReactNode,
	) => (
		<div className={CARD} data-testid={`course-mode-${id}`} data-available={state.available ? "true" : "false"}>
			<div className="flex items-center justify-between gap-2">
				<button
					type="button"
					className={cn(BTN, "lh-touch flex items-center gap-1.5 text-sm", state.available && "bg-raised-strong")}
					disabled={busy || !state.available}
					data-testid={`course-mode-${id}-start`}
					onClick={start}
				>
					{icon}
					{label}
				</button>
				{extra}
			</div>
			<p className="text-xs leading-relaxed text-muted-foreground" data-testid={`course-mode-${id}-line`}>
				{state.line}
			</p>
		</div>
	);
	return (
		<section data-testid="course-modes" aria-label="Ways to study this class" className="grid gap-3 sm:grid-cols-3">
			{card("learn", <BookOpenIcon className="size-3.5" aria-hidden />, "Learn", states.learn, () => target && onLearn(target))}
			{card(
				"ask",
				<MessageCircleQuestionIcon className="size-3.5" aria-hidden />,
				"Ask about this class",
				states.ask,
				() => onAsk?.(states.ask.reopen),
				states.ask.reopen ? (
					<button type="button" className={cn(BTN, "lh-touch")} disabled={busy || !onAsk} data-testid="course-mode-ask-new" onClick={() => onAsk?.()}>
						New
					</button>
				) : undefined,
			)}
			{card("practice", <DumbbellIcon className="size-3.5" aria-hidden />, "Practice", states.practice, onPractice)}
		</section>
	);
}
