"use client";

import { CircleAlertIcon, Loader2Icon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * THE ERROR NOTICE (UI round 8, 2026-11-25; SPEC §9): one shape for every failed job. A 14px alert icon in the danger
 * colour, one plain sentence in the text colour, the raw text the server or provider gave as a 12px muted details line,
 * and a ghost-sm "Try again" where retrying makes sense. It sits directly under the control that started the job.
 */

export interface PlainError {
	/** One plain sentence: what went wrong, said for a learner. */
	sentence: string;
	/** The raw text, kept for whoever wants it (the details line); null when the sentence already says it all. */
	detail: string | null;
}

/** Maps a raw failure ("429 rate limited: …", "the request timed out after 120 s", a fetch error) to one plain sentence,
 *  keeping the raw text as its detail. `what` names the job ("Couldn't weigh the exams."). Pure. */
export function plainError(raw: string, what?: string): PlainError {
	const text = raw.trim();
	const lower = text.toLowerCase();
	const lead = what ? `${what} ` : "";
	const wait = /wait\s+(\d+)\s*s/.exec(lower)?.[1];
	let why: string;
	if (/\b429\b|rate.?limit|too many requests|overloaded|\b529\b/.test(lower)) why = wait ? `The provider is busy; try again in ${wait} seconds.` : "The provider is busy right now; try again in a moment.";
	else if (/timed? ?out|timeout|took too long/.test(lower)) why = "The model took too long to answer.";
	else if (/cut off|truncat|max.?tokens|length limit/.test(lower)) why = "The model's reply was cut off.";
	else if (/could not be read|couldn't be read|not valid json|unexpected token|parse/.test(lower)) why = "The model's reply could not be read.";
	else if (/could not reach|failed to fetch|network|econnrefused|offline/.test(lower)) why = "The app could not reach the server.";
	else if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|api key|invalid key|not signed in/.test(lower)) why = "The provider refused the request; check the key in Settings → Providers.";
	else if (/\b5\d\d\b|server error|internal error/.test(lower)) why = "The provider had a problem on its side.";
	else why = "";
	if (!why) return { sentence: what ? `${what}` : capitalise(text), detail: what && text ? text : null };
	return { sentence: `${lead}${why}`, detail: text || null };
}

function capitalise(s: string): string {
	if (!s) return "Something went wrong.";
	const t = s[0]!.toUpperCase() + s.slice(1);
	return /[.!?…]$/.test(t) ? t : `${t}.`;
}

const RETRY = buttonVariants({ variant: "ghost", size: "sm" });

export function ErrorNotice({
	error,
	what,
	onRetry,
	retrying = false,
	retryLabel = "Try again",
	className,
	testid,
}: {
	/** The raw failure text. */
	error: string;
	/** What failed, as the sentence's start ("Couldn't draft the skill map."). */
	what?: string;
	/** Offer "Try again" (only where retrying makes sense). */
	onRetry?: () => void;
	/** The retry is running: the button shows the spinner and is disabled. */
	retrying?: boolean;
	retryLabel?: string;
	className?: string;
	testid?: string;
}) {
	const { sentence, detail } = plainError(error, what);
	return (
		<div role="alert" data-testid={testid} data-slot="error-notice" className={cn("flex items-start gap-2 rounded-md bg-destructive/[0.06] p-2 text-chrome", className)}>
			<CircleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" strokeWidth={2} aria-hidden />
			<div className="min-w-0 flex-1">
				<p className="text-foreground">{sentence}</p>
				{detail && (
					<p className="mt-0.5 break-words text-meta text-muted-foreground" data-testid={testid ? `${testid}-detail` : undefined} title={detail}>
						{detail}
					</p>
				)}
			</div>
			{onRetry && (
				<button type="button" className={cn(RETRY, "-my-0.5 shrink-0")} disabled={retrying} onClick={onRetry} data-testid={testid ? `${testid}-retry` : undefined}>
					{retrying && <Loader2Icon className="animate-spin" aria-hidden />}
					{retryLabel}
				</button>
			)}
		</div>
	);
}
