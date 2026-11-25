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

/**
 * IPv6 is an ALLOWLIST: only global unicast (2000::/3) can be public, so everything else (unspecified, loopback,
 * IPv4-compatible and -translated, NAT64, discard-only, unique local, link-local, site-local, multicast, 5f00::/16
 * and any range assigned later outside 2000::/3) is refused without being listed. Inside 2000::/3, the special ranges
 * below are refused too. This is safer than a list of bad ranges: a range the list forgot is refused, not allowed.
 */
const GLOBAL_UNICAST = new BlockList();
GLOBAL_UNICAST.addSubnet("2000::", 3, "ipv6");
for (const [network, prefix] of [
	["2001::", 23], // IETF protocol assignments: Teredo 2001::/32, benchmarking 2001:2::/48, AMT 2001:3::/32,
	// AS112 2001:4:112::/48, ORCHID 2001:10::/28, ORCHIDv2 2001:20::/28, DRIP 2001:30::/28, and the rest of the block
	["2001:db8::", 32], // documentation
	["2002::", 16], // 6to4 (carries an IPv4 address)
	["3fff::", 20], // documentation (RFC 9637)
] as const) NON_PUBLIC.addSubnet(network, prefix, "ipv6");

/** The IPv4 address an IPv4-mapped IPv6 address carries (::ffff:a.b.c.d, or ::ffff:XXXX:XXXX as URLs write it). */
function mappedIpv4(ip: string): string | undefined {
	const dotted = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)?.[1];
	if (dotted) return dotted;
	const hex = ip.match(/^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
	if (!hex || isIP(ip) !== 6) return undefined;
	const [hi, lo] = [Number.parseInt(hex[1]!, 16), Number.parseInt(hex[2]!, 16)];
	return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}

/** True when an IP address is on the public internet. IPv4-mapped IPv6
 *  (::ffff:a.b.c.d) is judged as the IPv4 address it carries. */
export function isPublicAddress(address: string): boolean {
	const unbracketed = address.replace(/^\[|\]$/g, "");
	const ip = mappedIpv4(unbracketed) ?? unbracketed;
	const family = isIP(ip);
	if (family === 4) return !NON_PUBLIC.check(ip, "ipv4");
	if (family === 6) return GLOBAL_UNICAST.check(ip, "ipv6") && !NON_PUBLIC.check(ip, "ipv6");
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
