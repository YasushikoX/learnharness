import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";

/**
 * Fetch for model-chosen URLs (research web_fetch / web_fetch_pdf): only
 * public internet addresses. A fetched page can steer the researcher, so
 * without this it could read loopback services, the LAN, or cloud metadata
 * (169.254.169.254) and hand the response back to the model.
 *
 * The check runs twice: on the addresses DNS returns, before any connection is
 * opened (a name that resolves only to private addresses gets no TCP
 * handshake, and no TLS hello naming it), and again on the address each
 * connection actually reaches, before any request bytes are sent, so
 * redirects, IP-literal URLs and DNS rebinding all go through it.
 *
 * Shared by the research tools (web.ts web_fetch, pdf-read.ts web_fetch_pdf)
 * and the connector wizard's documentation fetch
 * (src/server/converters/docs-fetch.ts).
 */

const NON_PUBLIC = new BlockList();
for (const [network, prefix] of [
	["0.0.0.0", 8], // "this network"
	["10.0.0.0", 8], // private
	["100.64.0.0", 10], // carrier-grade NAT
	["127.0.0.0", 8], // loopback
	["169.254.0.0", 16], // link-local, cloud metadata
	["172.16.0.0", 12], // private
	["192.0.0.0", 24], // IETF protocol assignments
	["192.0.2.0", 24], // documentation
	["192.88.99.0", 24], // 6to4 relay anycast
	["192.168.0.0", 16], // private
	["198.18.0.0", 15], // benchmarking
	["198.51.100.0", 24], // documentation
	["203.0.113.0", 24], // documentation
	["224.0.0.0", 4], // multicast
	["240.0.0.0", 4], // reserved, broadcast
] as const) NON_PUBLIC.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
	["::", 128], // unspecified
	["::1", 128], // loopback
	["::", 96], // IPv4-compatible (deprecated): ::127.0.0.1, ::169.254.169.254
	["::ffff:0:0:0", 96], // IPv4-translated (SIIT): ::ffff:0:127.0.0.1
	["64:ff9b::", 96], // NAT64
	["64:ff9b:1::", 48], // local-use NAT64
	["100::", 64], // discard-only
	["2001::", 32], // Teredo (carries an IPv4 address)
	["2001:10::", 28], // ORCHID (deprecated)
	["2001:20::", 28], // ORCHIDv2
	["2001:db8::", 32], // documentation
	["2002::", 16], // 6to4
	["fc00::", 7], // unique local
	["fe80::", 10], // link-local
	["fec0::", 10], // site-local (deprecated, still routed inside some networks)
	["ff00::", 8], // multicast
] as const) NON_PUBLIC.addSubnet(network, prefix, "ipv6");

/** True when an IP address is on the public internet. IPv4-mapped IPv6
 *  (::ffff:a.b.c.d) is judged as the IPv4 address it carries. */
export function isPublicAddress(address: string): boolean {
	const unbracketed = address.replace(/^\[|\]$/g, "");
	const mapped = unbracketed.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)?.[1];
	const ip = mapped ?? unbracketed;
	const family = isIP(ip);
	if (family === 4) return !NON_PUBLIC.check(ip, "ipv4");
	if (family === 6) return !NON_PUBLIC.check(ip, "ipv6");
	return false;
}

export class BlockedAddressError extends Error {}

/**
 * A DNS lookup that answers only addresses `allowed` accepts, and fails with
 * BlockedAddressError when none is left, so no connection is opened at all.
 */
function allowedLookup(allowed: (address: string) => boolean, base: LookupFunction = dnsLookup as unknown as LookupFunction): LookupFunction {
	return (hostname, options, callback) => {
		base(hostname, { ...options, all: true }, (error, addresses) => {
			if (error) return void (callback as (e: NodeJS.ErrnoException) => void)(error);
			const list = (Array.isArray(addresses) ? addresses : [{ address: addresses as unknown as string, family: 0 }]) as LookupAddress[];
			const kept = list.filter((a) => allowed(a.address));
			if (kept.length === 0) return void (callback as (e: NodeJS.ErrnoException) => void)(new BlockedAddressError(`refusing to connect to a private or local address (${hostname})`));
			if (options.all) (callback as (e: null, a: LookupAddress[]) => void)(null, kept);
			else (callback as (e: null, a: string, f: number) => void)(null, kept[0]!.address, kept[0]!.family);
		});
	};
}

/** An undici Agent whose connections may only reach addresses `allowed`
 *  accepts: checked on the DNS answer before connecting, on an address
 *  literal before connecting, and on the peer after connecting (exported
 *  with the check injectable, for tests). */
export function createAddressCheckedAgent(
	allowed: (address: string) => boolean = isPublicAddress,
	connectorOptions: Parameters<typeof buildConnector>[0] = {},
): Agent {
	// Optional connector settings let offline tests supply deterministic DNS and
	// a synthetic TLS CA. Production uses the standard connector unchanged.
	const base = (connectorOptions as { lookup?: LookupFunction }).lookup;
	const connect = buildConnector({ ...connectorOptions, lookup: allowedLookup(allowed, base) } as Parameters<typeof buildConnector>[0]);
	return new Agent({
		connect: (options, callback) => {
			const literal = (options.hostname ?? "").replace(/^\[|\]$/g, "");
			if (isIP(literal) && !allowed(literal)) {
				callback(new BlockedAddressError(`refusing to connect to a private or local address (${options.hostname})`), null);
				return;
			}
			connect(options, (error, socket) => {
				if (error || !socket) {
					callback(error ?? new Error("connection failed"), null);
					return;
				}
				const peer = socket.remoteAddress ?? "";
				if (!peer || !allowed(peer)) {
					socket.destroy();
					callback(new BlockedAddressError(`refusing to connect to a private or local address (${options.hostname})`), null);
					return;
				}
				callback(null, socket);
			});
		},
	});
}

const publicOnly = createAddressCheckedAgent();

/** Test seam — undefined in production. Tests that drive the research tools
 *  offline set a canned responder here (stubbing globalThis.fetch no longer
 *  reaches these tools, which use undici's own fetch). */
export const safeFetchOverride: { current?: (url: string, init: RequestInit) => Promise<Response> } = {};

/** fetch() limited to public addresses. A refusal surfaces as its own
 *  message instead of undici's generic "fetch failed". */
export async function safeFetch(url: string, init: RequestInit = {}, dispatcher: Agent = publicOnly): Promise<Response> {
	if (safeFetchOverride.current) return safeFetchOverride.current(url, init);
	try {
		return (await undiciFetch(url, { ...(init as object), dispatcher })) as unknown as Response;
	} catch (err) {
		const cause = (err as { cause?: unknown }).cause;
		if (cause instanceof BlockedAddressError) throw new Error(cause.message);
		throw err;
	}
}
