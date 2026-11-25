"use client";

import { buttonVariants } from "@/components/ui/button";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { TodayCourse } from "@/src/core";
import { SidebarToggle } from "@/components/sidebar";
import { HEAD_COUNT, PAGE_HEAD } from "@/components/section-heads";
import { todayItemCount, useStartReview, useTodayCourses } from "@/components/today-section";
import { cn } from "@/lib/utils";

/**
 * The Today page (owner, 2026-11-16): what to do today in every course, uncapped. One block per course with something to
 * do, soonest exam first (server order, core/exam-plan.ts): the course and its days to the exam, the review with Start,
 * and the lessons to take today with Learn (which opens the course on that lesson's pace dialog). The sidebar keeps one
 * row that opens this page. Same data as the sidebar row (GET /api/today), fresh on the same events.
 */

/** UI round 1b (SPEC §7 "Today"): the next due task is one dominant card with the page's ONE primary Start (32px); every
 *  other task is a quiet row (secondary sm button) on hairline separators, grouped under its course. The rows and the
 *  hero match the course page's Next up box (exam-plan.tsx), so the same tasks look the same on both pages. */
const BTN = buttonVariants({ variant: "secondary", size: "sm" });
const BTN_PRIMARY = buttonVariants({ className: "lh-touch" });
const HERO_CARD = "min-w-0 rounded-lg border border-border bg-card p-5 sm:p-6";
const ROW = "flex min-h-11 items-center justify-between gap-3 py-1.5 text-body";
/** One reading column for the page and its header (a list reads best at the settings width, SPEC §2). */
const COLUMN = "mx-auto w-full max-w-3xl px-4 sm:px-6";

/** "15 days to the exam", "exam today", "exam passed", or nothing without a date. Pure. */
export function examDaysLine(daysLeft: number | undefined): string | null {
	if (daysLeft === undefined) return null;
	if (daysLeft < 0) return "exam passed";
	if (daysLeft === 0) return "exam today";
	return daysLeft === 1 ? "1 day to the exam" : `${daysLeft} days to the exam`;
}

/** The page's next task (UI round 1b): the first course's review when one is due, else its first lesson. Pure. */
export function todayHero(courses: readonly TodayCourse[]): { courseId: string; kind: "review" } | { courseId: string; kind: "learn"; skillId: string } | null {
	for (const c of courses) {
		if (c.reviewDue > 0) return { courseId: c.courseId, kind: "review" };
		const first = c.lessons[0];
		if (first) return { courseId: c.courseId, kind: "learn", skillId: first.skillId };
	}
	return null;
}

const reviewText = (c: TodayCourse) => (c.reviewBatch < c.reviewDue ? `Review · ${c.reviewBatch} of ${c.reviewDue}` : `Review · ${c.reviewDue}`);
const DUE_DOT = <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: "var(--lh-due)" }} />;

export function TodayPage({ initial }: { initial: TodayCourse[] }) {
	const router = useRouter();
	const courses = useTodayCourses(initial) ?? initial;
	const { busy, startReview } = useStartReview();
	const count = todayItemCount(courses);
	const hero = todayHero(courses);
	const heroCourse = hero ? courses.find((c) => c.courseId === hero.courseId) : undefined;
	const heroLesson = hero?.kind === "learn" ? heroCourse?.lessons.find((l) => l.skillId === hero.skillId) : undefined;
	const learn = (courseId: string, skillId: string) => router.push(`/course/${courseId}?learn=${encodeURIComponent(skillId)}`);
	return (
		<div className="relative h-dvh overflow-y-auto">
			<header className="lh-drag z-10 bg-background pb-2 pt-[calc(0.5rem+var(--lh-safe-top))] sm:sticky sm:top-0">
				<div className={cn(COLUMN, "flex items-center gap-3")}>
					<SidebarToggle />
					<h1 className="min-w-0 flex-1 lh-page-title">Today</h1>
				</div>
			</header>
			<div className={cn(COLUMN, "pb-16 pt-4")} data-testid="today-page">
				{count === 0 ? (
					<p className="text-sm text-muted-foreground" data-testid="today-empty">
						Nothing to review or learn today. Open a course to practice or learn ahead.
					</p>
				) : (
					<div className="space-y-8">
						{hero && heroCourse && (
							// The next task (SPEC §7 "Today"): the one dominant card, the one primary Start.
							<section className={HERO_CARD} data-testid="today-next">
								<div className="flex min-w-0 items-baseline gap-1.5 text-meta text-muted-foreground">
									<span className="shrink-0 font-medium">Next up</span>
									<span aria-hidden>·</span>
									<Link href={`/course/${heroCourse.courseId}`} className="min-w-0 truncate hover:text-foreground hover:underline">
										{heroCourse.title}
									</Link>
									{examDaysLine(heroCourse.daysLeft) && (
										<>
											<span aria-hidden>·</span>
											<span className="shrink-0 whitespace-nowrap">{examDaysLine(heroCourse.daysLeft)}</span>
										</>
									)}
								</div>
								<div className="mt-3 flex items-center justify-between gap-4">
									<span className="flex min-w-0 items-center gap-2 text-lg leading-[22px] font-semibold">
										{hero.kind === "review" ? (
											<>
												{DUE_DOT}
												<span className="whitespace-nowrap">{reviewText(heroCourse)}</span>
											</>
										) : (
											<span className="line-clamp-2 break-words">
												{heroLesson?.name}
												{heroLesson && heroLesson.weight !== 1 && <span className="ml-2 text-meta font-normal text-muted-foreground">w{heroLesson.weight}</span>}
											</span>
										)}
									</span>
									<button
										type="button"
										className={BTN_PRIMARY}
										disabled={hero.kind === "review" && busy}
										data-testid="today-next-start"
										onClick={() => (hero.kind === "review" ? void startReview(hero.courseId) : learn(hero.courseId, hero.skillId))}
									>
										Start
									</button>
								</div>
							</section>
						)}
						{courses.map((c) => {
							const days = examDaysLine(c.daysLeft);
							const showReview = c.reviewDue > 0 && !(hero?.kind === "review" && hero.courseId === c.courseId);
							const lessons = c.lessons.filter((l) => !(hero?.kind === "learn" && hero.courseId === c.courseId && hero.skillId === l.skillId));
							if (!showReview && lessons.length === 0) return null;
							return (
								<section key={c.courseId} data-testid={`today-course-${c.courseId}`}>
									<div className="flex items-baseline justify-between gap-3 pb-2">
										<Link href={`/course/${c.courseId}`} className={cn(PAGE_HEAD, "min-w-0 truncate pb-0 hover:underline")}>
											{c.title}
										</Link>
										{days && <span className="shrink-0 whitespace-nowrap text-meta text-muted-foreground">{days}</span>}
									</div>
									<div className="divide-y divide-border border-y border-border">
										{showReview && (
											<div className={ROW} data-testid="today-review">
												<span className="flex min-w-0 items-center gap-2">
													{DUE_DOT}
													<span className="whitespace-nowrap">{reviewText(c)}</span>
												</span>
												<button type="button" className={BTN} disabled={busy} onClick={() => void startReview(c.courseId)}>
													Start
												</button>
											</div>
										)}
										{lessons.map((l) => (
											<div key={l.skillId} className={ROW} data-testid="today-learn">
												<span className="min-w-0 truncate">
													{l.name}
													{l.weight !== 1 && <span className={HEAD_COUNT}>w{l.weight}</span>}
												</span>
												<button type="button" className={BTN} onClick={() => learn(c.courseId, l.skillId)}>
													Learn
												</button>
											</div>
										))}
									</div>
								</section>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}
