/**
 * Lightweight W3C Server-Timing header recorder for API routes.
 *
 * Emits metric names and millisecond durations only (`name;dur=1.2`) — never
 * descriptions, ids, titles, or request/transcript content.
 */

export interface ServerTiming {
	/** Record a synchronous step's duration under `name` and return its result. */
	measure<T>(name: string, fn: () => T): T;
	/** Record an async step's duration under `name` and return its result. */
	measureAsync<T>(name: string, fn: () => Promise<T>): Promise<T>;
	/** Build the `Server-Timing` header value, always ending with `total`. */
	header(): string;
	/** Return `Response.json(body, init)` with the `Server-Timing` header attached. */
	json(body: unknown, init?: ResponseInit): Response;
}

function sanitizeMetricName(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
}

function formatDur(ms: number): string {
	const clamped = Number.isFinite(ms) && ms > 0 ? ms : 0;
	return clamped.toFixed(1);
}

export function startServerTiming(): ServerTiming {
	const startedAt = performance.now();
	const entries: Array<{ name: string; dur: number }> = [];

	const measure = <T>(name: string, fn: () => T): T => {
		const t0 = performance.now();
		try {
			return fn();
		} finally {
			entries.push({ name: sanitizeMetricName(name), dur: performance.now() - t0 });
		}
	};

	const measureAsync = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
		const t0 = performance.now();
		try {
			return await fn();
		} finally {
			entries.push({ name: sanitizeMetricName(name), dur: performance.now() - t0 });
		}
	};

	const header = (): string => {
		const parts = entries.map((e) => `${e.name};dur=${formatDur(e.dur)}`);
		parts.push(`total;dur=${formatDur(performance.now() - startedAt)}`);
		return parts.join(", ");
	};

	const json = (body: unknown, init?: ResponseInit): Response => {
		const headers = new Headers(init?.headers);
		headers.set("Server-Timing", header());
		return Response.json(body, { ...init, headers });
	};

	return { measure, measureAsync, header, json };
}
