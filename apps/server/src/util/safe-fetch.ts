/**
 * Outbound HTTP for user-supplied URLs.
 *
 * Guards against SSRF: HTTPS only, every resolved address must be public,
 * redirects are followed manually and re-checked, and both time and response
 * size are capped. Connector hosts are fixed in code and use `fetchJson` directly.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { HttpError } from './errors.ts';

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const USER_AGENT = 'Patchbay/0.1 (+https://github.com/carnaby/patchbay)';

/**
 * Every range that must never be reached from user-supplied URLs. IPv6 forms
 * that embed IPv4 (mapped, compatible, NAT64, 6to4) are blocked wholesale,
 * because the URL parser normalises them into shapes that string checks miss.
 */
const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const) {
  BLOCKED.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 96], // unspecified, loopback and IPv4-compatible (IPv4-mapped is matched against the IPv4 rules by Node)
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48],
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link local
  ['ff00::', 8], // multicast
] as const) {
  BLOCKED.addSubnet(net, prefix, 'ipv6');
}

export function isPrivateAddress(raw: string): boolean {
  const ip = raw.replace(/^\[|\]$/g, '').split('%')[0]!;
  const family = isIP(ip);
  if (family === 0) return true; // not an IP at all: refuse rather than guess
  return BLOCKED.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'Invalid URL');
  }
  if (url.protocol !== 'https:') throw new HttpError(400, 'Only https:// URLs are allowed');
  if (url.username || url.password) throw new HttpError(400, 'URLs with credentials are not allowed');
  if (url.port && url.port !== '443') throw new HttpError(400, 'Only the default HTTPS port is allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isPrivateAddress(host)) {
    throw new HttpError(400, 'URLs pointing to private or local networks are not allowed');
  }
  return url;
}

/**
 * The address check runs inside the socket's DNS lookup, so the IP that is
 * validated is exactly the IP that is connected to (no DNS-rebinding window).
 */
const guardedAgent = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err, '', 0);
        const list = addresses as LookupAddress[];
        if (list.length === 0 || list.some((a) => isPrivateAddress(a.address))) {
          return callback(Object.assign(new Error('Blocked private address'), { code: 'EBLOCKED' }), '', 0);
        }
        if ((options as { all?: boolean }).all)
          return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
        callback(null, list[0]!.address, list[0]!.family);
      });
    },
  },
});

async function readCapped(res: Response, limit: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > limit) throw new HttpError(502, `Response larger than ${limit / 1024 / 1024} MB`);
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new HttpError(502, `Response larger than ${limit / 1024 / 1024} MB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface FetchJsonOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Fetches JSON from a trusted, hard-coded host (connectors). */
export async function fetchJson<T = unknown>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...options.headers },
    signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
  }).catch((e: unknown) => {
    throw new HttpError(502, `Upstream request failed: ${e instanceof Error ? e.message : String(e)}`);
  });
  if (!res.ok) throw new HttpError(502, `Upstream responded ${res.status} ${res.statusText}`);
  const text = await readCapped(res, options.maxBytes ?? MAX_BYTES);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(502, 'Upstream did not return valid JSON');
  }
}

/** Fetches JSON from an untrusted, user-supplied URL with SSRF protection. */
export async function safeFetchJson(raw: string, redirects = 3): Promise<unknown> {
  let url = await assertPublicUrl(raw);
  for (let hop = 0; hop <= redirects; hop++) {
    const res = await undiciFetch(url, {
      redirect: 'manual',
      dispatcher: guardedAgent,
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch((e: unknown) => {
      const cause = (e as { cause?: { code?: string } }).cause;
      if (cause?.code === 'EBLOCKED')
        throw new HttpError(400, 'URLs pointing to private or local networks are not allowed');
      throw new HttpError(502, `Request failed: ${e instanceof Error ? e.message : String(e)}`);
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = await assertPublicUrl(new URL(res.headers.get('location')!, url).toString());
      continue;
    }
    if (!res.ok) throw new HttpError(502, `Upstream responded ${res.status}`);
    const text = await readCapped(res as unknown as Response, MAX_BYTES);
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(502, 'Response is not valid JSON');
    }
  }
  throw new HttpError(502, 'Too many redirects');
}
