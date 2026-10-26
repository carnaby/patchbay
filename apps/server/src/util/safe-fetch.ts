/**
 * Outbound HTTP for user-supplied URLs.
 *
 * Guards against SSRF: HTTPS only, every resolved address must be public,
 * redirects are followed manually and re-checked, and both time and response
 * size are capped. Connector hosts are fixed in code and use `fetchJson` directly.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { bindingLabel, bindingMatches, type SecretPlacement } from '@patchbay/core';
import { Agent, type Dispatcher, fetch as undiciFetch } from 'undici';
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

/** A decrypted secret for one request. Never stored, logged, cached or passed to pipeline workers. */
export interface Credential {
  id: string;
  revision: number;
  origin: string;
  pathPrefix: string;
  placement: SecretPlacement;
  paramName: string | null;
  value: string;
}

export interface SafeFetchOptions {
  /** Sent only on hops whose URL matches every credential's binding. */
  credentials?: Credential[];
  redirects?: number;
  /** Test seams, see `UpstreamTestSeam`. */
  test?: UpstreamTestSeam;
}

/**
 * Tests only, never read from the environment: `dispatcher` routes requests to a local server (production always
 * uses `guardedAgent`, so its DNS-level address check always applies; the URL-level checks run either way), and
 * `timeoutMs` shortens the request timeout.
 */
export interface UpstreamTestSeam {
  dispatcher?: Dispatcher;
  timeoutMs?: number;
}

const REDACTED = '[redacted]';

/** Every form a value can take in text we produce or receive: as is, and percent-encoded as in a query string. */
function redactionForms(values: string[]): string[] {
  const forms = values.flatMap((v) => [
    v,
    encodeURIComponent(v),
    new URLSearchParams({ v }).toString().slice(2),
  ]);
  // Longest first, so a shorter form never splits a longer one.
  return [...new Set(forms)].filter((f) => f.length > 0).sort((a, b) => b.length - a.length);
}

/** Last guard for messages from a credentialed request: no form of a value survives. */
export function redact(text: string, values: string[]): string {
  let out = text;
  for (const form of redactionForms(values)) out = out.split(form).join(REDACTED);
  return out;
}

/**
 * Replaces echoed secrets in parsed JSON (some APIs reflect credentials in /whoami answers or error payloads).
 * Matching parsed strings instead of raw text handles JSON escaping such as "\/".
 */
export function redactJson(value: unknown, values: string[]): unknown {
  const forms = redactionForms(values);
  const scrub = (s: string) => (forms.some((f) => s.includes(f)) ? redact(s, values) : s);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return scrub(v);
    if (typeof v === 'number' || typeof v === 'bigint') {
      const s = String(v);
      return forms.some((f) => s.includes(f)) ? REDACTED : v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [scrub(k), walk(x)]));
    }
    return v;
  };
  return walk(value);
}

/** The request for one hop: a copy of the URL (plus a query secret) and the headers. The document URL is untouched. */
function attach(url: URL, credentials: Credential[]) {
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': USER_AGENT };
  let search = url.search;
  for (const c of credentials) {
    if (c.placement === 'bearer') headers.authorization = `Bearer ${c.value}`;
    else if (c.placement === 'header') headers[c.paramName!.toLowerCase()] = c.value;
    else {
      // Appended as text, so the document's own query string keeps its exact encoding.
      const pair = `${encodeURIComponent(c.paramName!)}=${encodeURIComponent(c.value)}`;
      search = search ? `${search}&${pair}` : `?${pair}`;
    }
  }
  const target = new URL(url.href);
  target.search = search;
  return { target, headers };
}

/** Fetches JSON from an untrusted, user-supplied URL with SSRF protection, optionally with credentials. */
export async function safeFetchJson(raw: string, options: SafeFetchOptions = {}): Promise<unknown> {
  const credentials = options.credentials ?? [];
  if (credentials.length === 0) return fetchHops(raw, [], options);
  const values = credentials.map((c) => c.value);
  try {
    return redactJson(await fetchHops(raw, credentials, options), values);
  } catch (e) {
    // New errors without a cause: nothing that might hold request options reaches a logger.
    const err = e instanceof HttpError ? e : new HttpError(502, 'Request failed');
    throw new HttpError(err.status, redact(err.message, values));
  }
}

async function fetchHops(
  raw: string,
  credentials: Credential[],
  options: SafeFetchOptions,
): Promise<unknown> {
  const redirects = options.redirects ?? 3;
  let url = await assertPublicUrl(raw);
  for (let hop = 0; hop <= redirects; hop++) {
    for (const c of credentials) {
      if (bindingMatches(c, url.href).ok) continue;
      // Not retried without credentials either: an anonymous request to wherever the API pointed is not what the
      // user configured.
      if (hop === 0) throw new HttpError(400, 'Credentials for this source are bound to another address.');
      throw new HttpError(
        502,
        `The API redirected to another address. Credentials are only sent to ${bindingLabel(c)}, so the request was stopped.`,
      );
    }
    const { target, headers } = attach(url, credentials);
    const res = await undiciFetch(target, {
      redirect: 'manual',
      dispatcher: options.test?.dispatcher ?? guardedAgent,
      headers,
      signal: AbortSignal.timeout(options.test?.timeoutMs ?? TIMEOUT_MS),
    }).catch((e: unknown) => {
      const cause = (e as { cause?: { code?: string } }).cause;
      if (cause?.code === 'EBLOCKED')
        throw new HttpError(400, 'URLs pointing to private or local networks are not allowed');
      // Client errors can describe the request; with credentials, say only what kind of failure it was.
      if (credentials.length) {
        throw new HttpError(
          502,
          (e as Error)?.name === 'TimeoutError' ? 'Request timed out' : 'Request failed',
        );
      }
      throw new HttpError(502, `Request failed: ${e instanceof Error ? e.message : String(e)}`);
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel().catch(() => {});
      // Resolved against the document's URL, never against the request URL that carried a query secret.
      url = await assertPublicUrl(new URL(res.headers.get('location')!, url).toString());
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new HttpError(502, `Upstream responded ${res.status}`);
    }
    const text = await readCapped(res as unknown as Response, MAX_BYTES);
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(502, 'Response is not valid JSON');
    }
  }
  throw new HttpError(502, 'Too many redirects');
}
