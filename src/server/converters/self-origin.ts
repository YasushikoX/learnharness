import os from "node:os";
import { normalizeBaseUrl } from "../../core/settings.ts";

/**
 * The app is never a PDF service to itself (fork addition, 2026-11-25). A service URL that points at this app's own
 * server would let a profile make the app send requests to its own API (in browser-only mode, a request the app makes
 * to itself carries no Origin, so its own request guard would let it through). Such a URL is refused when it is
 * saved and again before any request.
 *
 * What the app knows of its own addresses:
 *   - its port: PORT, which Next sets in the server process once it listens (`next dev`, `next start`, the
 *     standalone server; the desktop shell also passes it), and the port of __NEXT_PRIVATE_ORIGIN;
 *   - the hosts that reach it on that port: every loopback name and address (localhost, *.localhost, 127.0.0.0/8,
 *     ::1, 0.0.0.0, ::), every address of this computer's network interfaces, its host name, HOSTNAME;
 *   - and every host:port the converter settings routes were actually reached at (noteAppRequest).
 * What it cannot know: another DNS name that resolves to this computer and was never used to open Settings, or a
 * forwarding proxy in front of it. Those are covered by the other rules: a service URL is only ever one the user
 * typed (or a bundled preset's), and nothing is sent before it is saved.
 */

const observed = new Set<string>();

function hostPort(url: URL): string {
	const port = url.port || (url.protocol === "https:" ? "443" : "80");
	return `${url.hostname.toLowerCase()}:${port}`;
}

/** Remember the host:port a converter settings request reached this app at. */
export function noteAppRequest(requestUrl: string): void {
	try {
		const url = new URL(requestUrl);
		if (url.protocol === "http:" || url.protocol === "https:") observed.add(hostPort(url));
	} catch {
		// not a URL: nothing to remember
	}
}

function appPorts(env: Record<string, string | undefined>): Set<string> {
	const ports = new Set<string>();
	if (env.PORT && /^\d{1,5}$/.test(env.PORT)) ports.add(String(Number(env.PORT)));
	try {
		if (env.__NEXT_PRIVATE_ORIGIN) {
			const url = new URL(env.__NEXT_PRIVATE_ORIGIN);
			ports.add(url.port || (url.protocol === "https:" ? "443" : "80"));
		}
	} catch {
		// ignore a malformed value
	}
	return ports;
}

function isLoopback(host: string): boolean {
	return host === "localhost" || host.endsWith(".localhost") || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host === "[::1]" || host === "0.0.0.0" || host === "[::]" || host === "[::ffff:127.0.0.1]" || host === "[::ffff:7f00:1]";
}

function localHosts(env: Record<string, string | undefined>): Set<string> {
	const hosts = new Set<string>();
	try {
		for (const list of Object.values(os.networkInterfaces())) {
			for (const entry of list ?? []) hosts.add(entry.family === "IPv6" ? `[${entry.address.split("%")[0]!.toLowerCase()}]` : entry.address);
		}
	} catch {
		// no interface list: loopback names still apply
	}
	try {
		const name = os.hostname().toLowerCase();
		if (name) hosts.add(name).add(`${name.replace(/\.local$/, "")}.local`);
	} catch {
		// ignore
	}
	if (env.HOSTNAME) hosts.add(env.HOSTNAME.toLowerCase());
	try {
		if (env.__NEXT_PRIVATE_ORIGIN) hosts.add(new URL(env.__NEXT_PRIVATE_ORIGIN).hostname.toLowerCase());
	} catch {
		// ignore
	}
	return hosts;
}

/** Why `baseUrl` is this app's own address (and so refused), or undefined. */
export function selfOriginProblem(baseUrl: string, env: Record<string, string | undefined> = process.env): string | undefined {
	const canonical = normalizeBaseUrl(baseUrl);
	if (!canonical) return undefined;
	const url = new URL(canonical);
	const target = hostPort(url);
	const refusal = `${url.origin} is this app's own address; a PDF service must be another server`;
	if (observed.has(target)) return refusal;
	const port = target.slice(target.lastIndexOf(":") + 1);
	if (!appPorts(env).has(port)) return undefined;
	const host = url.hostname.toLowerCase();
	return isLoopback(host) || localHosts(env).has(host) ? refusal : undefined;
}
