/**
 * Outbound HTTP for user-supplied URLs.
 *
 * Guards against SSRF: HTTPS only, every resolved address must be public,
 * redirects are followed manually and re-checked, and both time and response
 * size are capped. Connector hosts are fixed in code and use `fetchJson` directly.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { HttpError } from './errors.ts';

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const USER_AGENT = 'Patchbay/0.1 (+https://github.com/carnaby/patchbay)';

function isPrivateIPv4(ip: string): boolean {
  const [a = 0, b = 0] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return isPrivateIPv4(ip);
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPrivateIPv4(mapped[1]!);
  return (
    v6 === '::' ||
    v6 === '::1' ||
    v6.startsWith('fc') ||
    v6.startsWith('fd') ||
    v6.startsWith('fe8') ||
    v6.startsWith('fe9') ||
    v6.startsWith('fea') ||
    v6.startsWith('feb') ||
    v6.startsWith('ff')
  );
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
