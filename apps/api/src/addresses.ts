import { lookup, type LookupAddress } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

/**
 * Whether an IP address is on the public internet: not loopback, private, link-local, shared,
 * multicast or reserved, however it's written. An IPv6 address carrying an IPv4 one (mapped,
 * compatible or NAT64) is judged by the IPv4 address it carries.
 */
export function isPublicAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
  if (isIP(ip) === 4) return isPublicIPv4(ip.split(".").map(Number));
  if (isIP(ip) !== 6) return false;
  const groups = ipv6Groups(ip);
  const carried = [groups[6]! >> 8, groups[6]! & 255, groups[7]! >> 8, groups[7]! & 255];
  const leadingZeros = groups.slice(0, 5).every((group) => group === 0);
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible, which includes :: and ::1)
  if (leadingZeros && (groups[5] === 0xffff || groups[5] === 0)) return isPublicIPv4(carried);
  // 64:ff9b::a.b.c.d (NAT64)
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) return isPublicIPv4(carried);
  const first = groups[0]!;
  return !((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00);
}

function isPublicIPv4([a, b]: number[]): boolean {
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a! >= 224
  );
}

/** The eight 16-bit groups of an IPv6 address, with :: filled in and a trailing a.b.c.d read as two groups. */
function ipv6Groups(ip: string): number[] {
  let text = ip;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.includes("::") ? text.split("::") : [text, undefined];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  return groups.map((group) => parseInt(group || "0", 16));
}

/**
 * Connections only to public addresses, checked as each connection is made: a name can't be
 * pointed somewhere private between being checked and being called.
 */
const publicOnlyLookup = ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
  lookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) return callback(error);
    if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
      return callback(Object.assign(new Error(`${hostname} isn't on the public internet.`), { code: "ENOTPUBLIC" }));
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
}) as unknown as LookupFunction;

const publicOnlyAgent = new Agent({ connect: { lookup: publicOnlyLookup } });

const MAX_REDIRECTS = 5;

/**
 * A fetch for addresses a Customer gave, for the hosted service: https only, public addresses
 * only, checked on every connection and every redirect, so Kovobot's servers never call into a
 * private network on a Customer's say-so.
 */
export async function publicOnlyFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  let url = new URL(input instanceof Request ? input.url : String(input));
  let method = init.method ?? (input instanceof Request ? input.method : "GET");
  let body = init.body;
  for (let hops = 0; ; hops += 1) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (url.protocol !== "https:" || (isIP(host) && !isPublicAddress(host))) {
      throw new Error("Kovobot calls outside servers only at public https addresses.");
    }
    const response = (await undiciFetch(url, {
      ...(init as object),
      method,
      body,
      redirect: "manual",
      dispatcher: publicOnlyAgent,
    } as never)) as unknown as Response;
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) return response;
    if (hops >= MAX_REDIRECTS) throw new Error("Too many redirects.");
    url = new URL(location, url);
    // 307 and 308 keep the method and body; the rest become a GET.
    if (response.status !== 307 && response.status !== 308) {
      method = "GET";
      body = undefined;
    }
  }
}
