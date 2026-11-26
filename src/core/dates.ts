/**
 * THE ONE ON-SCREEN DATE (UI round 8, 2026-11-25; SPEC §9): a calendar day reads "Fri 27 Nov", with the year only when
 * it is not the current one ("Fri 27 Nov 2027"). Every list, card, change card and detail line goes through `dayLabel`;
 * no ISO date reaches the screen. Calendar days are "YYYY-MM-DD" (an ISO timestamp is cut to its day first) and are
 * read in UTC, so the label never shifts with the machine's time zone. Pure.
 */

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/** "Fri 27 Nov" (this year) or "Fri 27 Nov 2027"; the input unchanged when it is not a date. `now` decides the year. */
export function dayLabel(date: string, now: number = Date.now()): string {
	const m = DAY_RE.exec(date.trim());
	if (!m) return date;
	const label = dayMonthLabel(date);
	return Number(m[1]) === new Date(now).getFullYear() ? label : `${label} ${m[1]}`;
}

/** "Fri 27 Nov" without a year in any case (a prefix to recognise, a weekday-close date). Pure. */
export function dayMonthLabel(date: string): string {
	const m = DAY_RE.exec(date.trim());
	if (!m) return date;
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	const at = new Date(Date.UTC(y, mo - 1, d));
	if (Number.isNaN(at.getTime())) return date;
	const weekday = at.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
	const month = at.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
	return `${weekday} ${d} ${month}`;
}

/** The weekday alone ("Fri"), for a date within the coming week. Pure. */
export function weekdayLabel(date: string): string {
	const m = DAY_RE.exec(date.trim());
	if (!m) return date;
	return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
}

/** Whole days as words: "today", "tomorrow", "in 10 days", "yesterday", "3 days ago". Pure. */
export function relativeDays(days: number): string {
	if (days === 0) return "today";
	if (days === 1) return "tomorrow";
	if (days === -1) return "yesterday";
	return days > 0 ? `in ${days} days` : `${-days} days ago`;
}
