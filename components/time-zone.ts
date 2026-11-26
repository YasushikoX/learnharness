/** The browser's IANA time zone as the X-LH-Time-Zone request header, or nothing when unknown. The chat route reads it
 *  (src/server/chat-handler.ts), and so do the class page's read, its class-position edit and the Today list (WP9 review
 *  1, finding 10: every "today" is the learner's). */
export function clientTimeZoneHeader(): Record<string, string> {
	try {
		const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
		return tz ? { "X-LH-Time-Zone": tz } : {};
	} catch {
		return {};
	}
}
