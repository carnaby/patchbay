/**
 * Outbound HTTP for user-supplied URLs.
 *
 * Guards against SSRF: https:// on port 443 to public addresses only, unless the caller passes the operator's
 * ALLOW_PRIVATE_HOSTS (util/private-hosts.ts) for a dashboard that may use it (DashboardService decides). Every
 * resolved address is checked inside the socket's DNS lookup, redirects are followed manually and re-checked, and
 * both time and response size are capped. Connector hosts are fixed in code and use `fetchJson` directly.
 */
import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { bindingLabel, bindingMatches, type SecretPlacement } from '@patchbay/core';
import { Agent, type Dispatcher, fetch as undiciFetch } from 'undici';
import { HttpError } from './errors.ts';
import { jsonShapeProblem, MAX_JSON_DEPTH } from './json-shape.ts';
import type { PrivateHosts } from './private-hosts.ts';

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
  ['192.88.99.0', 24], // 6to4 relay anycast (deprecated, RFC 7526)
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
  ['::ffff:0:0:0', 96], // IPv4-translated (SIIT), e.g. ::ffff:0:127.0.0.1
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48],
  ['100::', 64], // discard
  ['100:0:0:1::', 64], // dummy prefix (RFC 9780)
  ['2001::', 23], // IETF protocol assignments: Teredo (embeds IPv4), benchmarking, ORCHID, ...
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['3fff::', 20], // documentation (RFC 9637)
  ['5f00::', 16], // SRv6 SIDs (RFC 9602)
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link local
  ['fec0::', 10], // site local (deprecated, still routed by some stacks)
  ['ff00::', 8], // multicast
] as const) {
  BLOCKED.addSubnet(net, prefix, 'ipv6');
}

const IPV4_MAPPED = new BlockList();
IPV4_MAPPED.addSubnet('::ffff:0:0', 96, 'ipv6');
/** Everything else outside 2000::/3 is unallocated or special-purpose, so it is refused rather than listed. */
const GLOBAL_UNICAST = new BlockList();
GLOBAL_UNICAST.addSubnet('2000::', 3, 'ipv6');

export function isPrivateAddress(raw: string): boolean {
  const ip = raw.replace(/^\[|\]$/g, '').split('%')[0]!;
  const family = isIP(ip);
  if (family === 0) return true; // not an IP at all: refuse rather than guess
  if (family === 4) return BLOCKED.check(ip, 'ipv4');
  // An IPv4-mapped address is the IPv4 address it carries; Node checks it against the IPv4 rules.
  if (IPV4_MAPPED.check(ip, 'ipv6')) return BLOCKED.check(ip, 'ipv6');
  return !GLOBAL_UNICAST.check(ip, 'ipv6') || BLOCKED.check(ip, 'ipv6');
}

/** What the guard tells the user. The http and port texts name the setting, so a self-hoster knows what to change. */
export const URL_MESSAGES = {
  httpOff:
    'Only https:// URLs are allowed. Plain http:// works only on a self-hosted Patchbay, for hosts its operator lists in ALLOW_PRIVATE_HOSTS.',
  portOff:
    'Only the default HTTPS port is allowed. Other ports work only on a self-hosted Patchbay, for hosts its operator lists in ALLOW_PRIVATE_HOSTS.',
  privateOff: 'URLs pointing to private or local networks are not allowed',
  notListed: (host: string) =>
    `${host} is not covered by this server's ALLOW_PRIVATE_HOSTS. Private addresses, plain http:// and ports other than 443 work only for the hosts listed there.`,
  downgrade: 'The address redirected from https:// to http://, so the request was stopped.',
} as const;

/**
 * How a hop may connect. public: every address public (the only mode without a list). mixed (https on 443 with a
 * list): each address public or allowed by the list. lan (plain http or another port): each address allowed by the
 * list, so plain http never reaches a public address the list does not cover.
 */
export type HopMode = 'public' | 'mixed' | 'lan';

/**
 * The checks on a URL before any connection, and the mode of its hop. An IP literal is decided here (no DNS lookup
 * happens for it); a name is decided by the lookup (`guardedLookup`).
 */
export function checkUrl(raw: string, privateHosts: PrivateHosts | null = null): { url: URL; mode: HopMode } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'Invalid URL');
  }
  const plain = url.protocol === 'http:';
  if (url.protocol !== 'https:' && !plain) throw new HttpError(400, 'Only https:// URLs are allowed');
  // Before the credentials check, so a public instance keeps answering plain http:// with the https-only text.
  if (!privateHosts && plain) throw new HttpError(400, URL_MESSAGES.httpOff);
  if (url.username || url.password) throw new HttpError(400, 'URLs with credentials are not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const otherPort = url.port !== '' && url.port !== '443';
  if (!privateHosts) {
    if (otherPort) throw new HttpError(400, URL_MESSAGES.portOff);
    if (isIP(host) && isPrivateAddress(host)) throw new HttpError(400, URL_MESSAGES.privateOff);
    return { url, mode: 'public' };
  }
  if (isIP(host)) {
    if (privateHosts.listsHost(host)) return { url, mode: 'lan' };
    if (plain || otherPort || isPrivateAddress(host)) throw new HttpError(400, URL_MESSAGES.notListed(host));
    return { url, mode: 'public' };
  }
  return { url, mode: plain || otherPort ? 'lan' : 'mixed' };
}

/** The next hop of a redirect: the same checks as the first one, and never from https:// down to http://. */
export function redirectTarget(
  from: URL,
  location: string,
  privateHosts: PrivateHosts | null = null,
): { url: URL; mode: HopMode } {
  let target: string;
  try {
    target = new URL(location, from).toString();
  } catch {
    throw new HttpError(502, 'Invalid redirect');
  }
  const next = checkUrl(target, privateHosts);
  if (from.protocol === 'https:' && next.url.protocol === 'http:')
    throw new HttpError(502, URL_MESSAGES.downgrade);
  return next;
}

/** DNS answers for the guard; tests pass a fake. */
export type Resolver = (
  hostname: string,
  options: LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

const systemResolver: Resolver = (hostname, options, callback) => dnsLookup(hostname, options, callback);

/** Whether a hop of this mode may connect to `ip`, which `hostname` resolved to. */
export function addressAllowed(
  mode: HopMode,
  privateHosts: PrivateHosts | null,
  hostname: string,
  ip: string,
): boolean {
  if (mode === 'public' || !privateHosts) return !isPrivateAddress(ip);
  if (privateHosts.allowsAddress(hostname, ip)) return true;
  return mode === 'mixed' && !isPrivateAddress(ip);
}

/**
 * The socket's DNS lookup with the address check inside, so the IP that is validated is exactly the IP that is
 * connected to (no DNS-rebinding window). One disallowed address blocks the whole answer.
 */
export function guardedLookup(
  mode: HopMode,
  privateHosts: PrivateHosts | null,
  resolve: Resolver = systemResolver,
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (err, list) => {
      if (err) return callback(err, '', 0);
      if (list.length === 0 || list.some((a) => !addressAllowed(mode, privateHosts, hostname, a.address))) {
        return callback(Object.assign(new Error('Blocked address'), { code: 'EBLOCKED' }), '', 0);
      }
      if (options.all) return callback(null, list);
      callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

const guardedAgent = new Agent({ connect: { lookup: guardedLookup('public', null) } });
/** One pair of agents per policy object (one per server; tests build several). */
const policyAgents = new WeakMap<PrivateHosts, { mixed: Agent; lan: Agent }>();

function dispatcherFor(mode: HopMode, privateHosts: PrivateHosts | null): Dispatcher {
  if (mode === 'public' || !privateHosts) return guardedAgent;
  let agents = policyAgents.get(privateHosts);
  if (!agents) {
    agents = {
      mixed: new Agent({ connect: { lookup: guardedLookup('mixed', privateHosts) } }),
      lan: new Agent({ connect: { lookup: guardedLookup('lan', privateHosts) } }),
    };
    policyAgents.set(privateHosts, agents);
  }
  return agents[mode];
}

const sizeLabel = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${bytes / 1024 / 1024} MB` : `${Math.round(bytes / 1024)} KB`;

async function readCapped(res: Response, limit: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > limit) throw new HttpError(502, `Response larger than ${sizeLabel(limit)}`);
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
      throw new HttpError(502, `Response larger than ${sizeLabel(limit)}`);
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
  /**
   * The operator's ALLOW_PRIVATE_HOSTS, passed only for a dashboard that may use it (DashboardService decides).
   * Absent or null: public addresses over https:// on port 443 only, whatever the server is configured with.
   */
  privateHosts?: PrivateHosts | null;
  redirects?: number;
  /** A smaller body limit than the default 5 MB, for documents that are small by nature. */
  maxBytes?: number;
  /** A shorter timeout than the default 10 s. */
  timeoutMs?: number;
  /** JSON values the response may hold (default: no limit beyond its size); counted before it is parsed. */
  maxValues?: number;
  /** Test seams, see `UpstreamTestSeam`. */
  test?: UpstreamTestSeam;
}

/**
 * Tests only, never read from the environment: `dispatcher` routes requests to a local server (production always
 * uses the guarded agents, so its DNS-level address check always applies; the URL-level checks run either way), and
 * `timeoutMs` shortens the request timeout.
 */
export interface UpstreamTestSeam {
  dispatcher?: Dispatcher;
  timeoutMs?: number;
}

const REDACTED = '[redacted]';

/** Significant digits shorter than this are too common to treat a number as an echo of a digits-only value. */
const MIN_NEEDLE = 8;

/**
 * Base64 and base64url of a value as it appears inside a longer encoded string, for each of the three byte
 * alignments: only the characters that depend on the value's bytes alone. This also finds `user:value` in a Basic
 * authorization header an API echoes.
 */
function base64Cores(value: string): string[] {
  const bytes = Buffer.from(value, 'utf8');
  return [0, 1, 2].flatMap((pad) => {
    const encoded = Buffer.concat([Buffer.alloc(pad), bytes]).toString('base64');
    const core = encoded.slice(Math.ceil((8 * pad) / 6), Math.floor((8 * (pad + bytes.length)) / 6));
    return [core, core.replace(/\+/g, '-').replace(/\//g, '_')];
  });
}

interface Matcher {
  /** Lowercased strings whose presence in a normalised candidate means an echo. */
  needles: string[];
  /** The value as is and in the two common URL encodings, matched without case, for a readable partial redaction. */
  spans: RegExp;
}

function matcher(values: string[]): Matcher {
  const needles = values.flatMap((v) => {
    const significant = /^\d+$/.test(v) ? v.replace(/^0+/, '') : '';
    return [v, ...base64Cores(v), ...(significant.length >= MIN_NEEDLE ? [significant] : [])];
  });
  const spans = values
    .flatMap((v) => [v, encodeURIComponent(v), new URLSearchParams({ v }).toString().slice(2)])
    // Longest first, so a shorter form never splits a longer one.
    .sort((a, b) => b.length - a.length)
    .map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return {
    needles: [...new Set(needles.map((n) => n.toLowerCase()))].filter((n) => n.length > 0),
    spans: new RegExp(spans.join('|'), 'gi'),
  };
}

/** Decodes every run of %XX, leaving malformed escapes as they are; invalid UTF-8 becomes U+FFFD. */
function percentDecode(s: string): string {
  return s.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) =>
    Buffer.from(run.match(/%[0-9a-fA-F]{2}/g)!.map((h) => Number.parseInt(h.slice(1), 16))).toString('utf8'),
  );
}

/**
 * The spellings a string may hide a value in, lowercased: as is, with JSON escapes undone, and percent-decoded
 * repeatedly (double encoding) with and without "+" as a space.
 */
function candidates(s: string): string[] {
  if (!/[%\\+]/.test(s)) return [s.toLowerCase()];
  const out = new Set([s]);
  const unescaped = s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\\//g, '/');
  out.add(unescaped);
  for (const start of [unescaped, unescaped.replace(/\+/g, ' ')]) {
    let current = start;
    out.add(current);
    for (let i = 0; i < 4; i++) {
      const next = percentDecode(current);
      if (next === current) break;
      out.add(next);
      current = next;
    }
  }
  return [...out].map((c) => c.toLowerCase());
}

function contains(m: Matcher, s: string): boolean {
  return candidates(s).some((c) => m.needles.some((n) => c.includes(n)));
}

/**
 * Removes a value from a string: the plain spellings are replaced in place so the rest stays readable; if any other
 * spelling is still found (another encoding, base64, escapes), the whole string is replaced.
 */
function scrub(m: Matcher, s: string): string {
  if (!contains(m, s)) return s;
  const partial = s.replace(m.spans, REDACTED);
  return contains(m, partial) ? REDACTED : partial;
}

/** Last guard for messages from a credentialed request: no known spelling of a value survives. */
export function redact(text: string, values: string[]): string {
  return scrub(matcher(values), text);
}

/**
 * Replaces echoed secrets in parsed JSON (some APIs reflect credentials in /whoami answers, error payloads or
 * request dumps). Parsed strings are matched after undoing JSON escapes and URL encodings, without case, and
 * against base64 of the value. What is not caught: a partial echo (the last four characters, say) and any other
 * transformation (hashing, hex, splitting across fields).
 */
export function redactJson(value: unknown, values: string[]): unknown {
  const m = matcher(values);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return scrub(m, v);
    if (typeof v === 'number' || typeof v === 'bigint') return contains(m, String(v)) ? REDACTED : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [scrub(m, k), walk(x)]));
    }
    return v;
  };
  return walk(value);
}

/** The request for one hop: a copy of the URL (plus a query secret) and the headers. The document URL is untouched. */
function attach(url: URL, credentials: Credential[], accept: string) {
  const headers: Record<string, string> = { accept, 'user-agent': USER_AGENT };
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

/**
 * A redirect that keeps the query string (an added trailing slash, say) brings back the query secret we sent. That
 * parameter is removed so the secret can be attached again; only when its value is exactly the secret's, so a
 * redirect that sets the parameter to anything else still fails the binding check. Other parameters keep their
 * exact encoding.
 */
function withoutOwnQuerySecrets(url: URL, credentials: Credential[]): URL {
  const own = credentials.filter((c) => c.placement === 'query' && c.paramName);
  if (own.length === 0 || !url.search) return url;
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s.replace(/\+/g, ' '));
    } catch {
      return s;
    }
  };
  const pairs = url.search.slice(1).split('&');
  const kept = pairs.filter((pair) => {
    const eq = pair.indexOf('=');
    const name = decode(eq < 0 ? pair : pair.slice(0, eq)).toLowerCase();
    const value = eq < 0 ? '' : decode(pair.slice(eq + 1));
    return !own.some((c) => c.paramName!.toLowerCase() === name && c.value === value);
  });
  if (kept.length === pairs.length) return url;
  const next = new URL(url.href);
  next.search = kept.length ? `?${kept.join('&')}` : '';
  return next;
}

function parseJson(text: string, maxValues = Number.POSITIVE_INFINITY): unknown {
  // Parsed on this thread, so the one shape whose cost is not bounded by its size in bytes is refused first.
  const problem = jsonShapeProblem(text, { maxDepth: MAX_JSON_DEPTH, maxValues });
  if (problem?.kind === 'depth')
    throw new HttpError(502, `The response nests deeper than ${MAX_JSON_DEPTH} levels`);
  if (problem) throw new HttpError(502, `The response holds more than ${problem.limit} values`);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(502, 'Response is not valid JSON');
  }
}

/** Fetches JSON from an untrusted, user-supplied URL with SSRF protection, optionally with credentials. */
export async function safeFetchJson(raw: string, options: SafeFetchOptions = {}): Promise<unknown> {
  const credentials = options.credentials ?? [];
  if (credentials.length === 0)
    return parseJson((await fetchHops(raw, [], options, 'application/json')).text, options.maxValues);
  const values = credentials.map((c) => c.value);
  try {
    return redactJson(
      parseJson((await fetchHops(raw, credentials, options, 'application/json')).text, options.maxValues),
      values,
    );
  } catch (e) {
    // New errors without a cause: nothing that might hold request options reaches a logger.
    const err = e instanceof HttpError ? e : new HttpError(502, 'Request failed');
    throw new HttpError(err.status, redact(err.message, values));
  }
}

export interface FetchedText {
  text: string;
  /** The media type without parameters, lowercased ("application/rss+xml"); "" when the server sent none. */
  contentType: string;
  /** The address the body came from, after redirects: relative links in it resolve against this. */
  url: string;
}

/**
 * Fetches text (feeds, the HTML page that announces a feed) from an untrusted, user-supplied URL, with the same SSRF
 * protection, limits and redirect checks as JSON. Never with credentials; private hosts only when passed.
 */
export async function safeFetchText(
  raw: string,
  options: { accept: string; test?: UpstreamTestSeam | undefined; privateHosts?: PrivateHosts | null },
): Promise<FetchedText> {
  return fetchHops(
    raw,
    [],
    { ...(options.test ? { test: options.test } : {}), privateHosts: options.privateHosts ?? null },
    options.accept,
  );
}

async function fetchHops(
  raw: string,
  credentials: Credential[],
  options: SafeFetchOptions,
  accept: string,
): Promise<FetchedText> {
  const redirects = options.redirects ?? 3;
  const privateHosts = options.privateHosts ?? null;
  let { url, mode } = checkUrl(raw, privateHosts);
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
    const { target, headers } = attach(url, credentials, accept);
    const res = await undiciFetch(target, {
      redirect: 'manual',
      dispatcher: options.test?.dispatcher ?? dispatcherFor(mode, privateHosts),
      headers,
      signal: AbortSignal.timeout(options.test?.timeoutMs ?? options.timeoutMs ?? TIMEOUT_MS),
    }).catch((e: unknown) => {
      const cause = (e as { cause?: { code?: string } }).cause;
      if (cause?.code === 'EBLOCKED')
        throw new HttpError(
          400,
          mode === 'public' ? URL_MESSAGES.privateOff : URL_MESSAGES.notListed(url.hostname),
        );
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
      const next = redirectTarget(url, res.headers.get('location')!, privateHosts);
      url = withoutOwnQuerySecrets(next.url, credentials);
      mode = next.mode;
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new HttpError(502, `Upstream responded ${res.status}`);
    }
    const text = await readCapped(res as unknown as Response, options.maxBytes ?? MAX_BYTES);
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    return { text, contentType, url: url.href };
  }
  throw new HttpError(502, 'Too many redirects');
}
