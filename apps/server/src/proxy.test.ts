/**
 * Behaviour behind a reverse proxy or CDN (Caddy, Cloudflare Tunnel): which client IP rate limits key on,
 * which responses a CDN may cache, and that live streams survive idle timeouts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, createDeps } from './app.ts';
import { loadConfig, type TrustProxy } from './config.ts';
import { clientIp, type Deps, rateKey } from './context.ts';
import { RateLimiter } from './util/rate-limit.ts';

const BASE = 'http://localhost:8787';
const SOCKET = { incoming: { socket: { remoteAddress: '172.18.0.3' } } };
let dir: string;
let dist: string;
let deps: Deps;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay-proxy-test-'));
  // A stand-in for the built web app, so static caching headers can be checked without a build.
  dist = join(dir, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  mkdirSync(join(dist, 'icons'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Patchbay</title>');
  writeFileSync(join(dist, 'sw.js'), '');
  writeFileSync(join(dist, 'theme-init.js'), '');
  writeFileSync(join(dist, 'manifest.webmanifest'), '{}');
  writeFileSync(join(dist, 'icons', 'icon-192.png'), '');
  writeFileSync(join(dist, 'assets', 'index-abc123.js'), '');
  deps = await createDeps(
    loadConfig({
      NODE_ENV: 'test',
      DATA_DIR: join(dir, 'data'),
      OFFLINE: '1',
      PUBLIC_URL: BASE,
      WEB_DIST: dist,
      PIPELINE_WORKERS: '0',
    }),
  );
});

afterAll(async () => {
  deps.hub.close();
  await deps.pipeline.close();
  deps.db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The app as deployed with the given TRUST_PROXY mode, with fresh rate limit buckets. */
function appWith(trustProxy: TrustProxy) {
  return createApp({
    ...deps,
    config: { ...deps.config, trustProxy },
    limits: { ...deps.limits, creates: new RateLimiter(2, 1) },
  });
}

describe('TRUST_PROXY', () => {
  it('parses the generic and the Cloudflare mode', () => {
    const mode = (TRUST_PROXY?: string) => loadConfig({ TRUST_PROXY }).trustProxy;
    expect(mode(undefined)).toBe('off');
    expect(mode('0')).toBe('off');
    expect(mode('1')).toBe('forwarded');
    expect(mode('true')).toBe('forwarded');
    expect(mode('cloudflare')).toBe('cloudflare');
    expect(() => mode('cf')).toThrow();
  });

  const ipApp = (mode: TrustProxy) => new Hono().get('/', (c) => c.text(clientIp(c as never, mode)));
  const ipFor = async (mode: TrustProxy, headers: Record<string, string>) =>
    (await ipApp(mode).request('/', { headers }, SOCKET)).text();

  it('reads CF-Connecting-IP only in Cloudflare mode', async () => {
    const headers = { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1, 203.0.113.7' };
    expect(await ipFor('cloudflare', headers)).toBe('203.0.113.7');
    expect(await ipFor('cloudflare', { 'cf-connecting-ip': '2001:db8::1' })).toBe('2001:db8::1');
    // Anywhere else the header is client-controlled and must be ignored.
    expect(await ipFor('off', headers)).toBe('172.18.0.3');
    expect(await ipFor('forwarded', { 'cf-connecting-ip': '203.0.113.7' })).toBe('172.18.0.3');
  });

  it('falls back to the socket address without a usable CF-Connecting-IP', async () => {
    expect(await ipFor('cloudflare', {})).toBe('172.18.0.3');
    expect(await ipFor('cloudflare', { 'cf-connecting-ip': 'not-an-ip' })).toBe('172.18.0.3');
    // X-Forwarded-For is not a substitute: in this mode nothing vouches for it.
    expect(await ipFor('cloudflare', { 'x-forwarded-for': '198.51.100.1' })).toBe('172.18.0.3');
  });

  it('keeps using the right-most X-Forwarded-For entry in the generic mode', async () => {
    expect(await ipFor('forwarded', { 'x-forwarded-for': '198.51.100.1, 203.0.113.7' })).toBe('203.0.113.7');
  });

  it('rate limits each client behind the tunnel separately, not the tunnel as a whole', async () => {
    const app = appWith('cloudflare');
    const create = (ip: string) =>
      app.request(
        `${BASE}/api/dashboards`,
        { method: 'POST', headers: { origin: BASE, 'cf-connecting-ip': ip } },
        SOCKET,
      );
    expect((await create('203.0.113.7')).status).toBe(201);
    expect((await create('203.0.113.7')).status).toBe(201);
    expect((await create('203.0.113.7')).status).toBe(429);
    // Same socket peer (the cloudflared container), different visitor.
    expect((await create('203.0.113.8')).status).toBe(201);
  });

  it('puts every address of one IPv6 /56 into the bucket for creates', async () => {
    const app = appWith('cloudflare');
    const create = (ip: string) =>
      app.request(
        `${BASE}/api/dashboards`,
        { method: 'POST', headers: { origin: BASE, 'cf-connecting-ip': ip } },
        SOCKET,
      );
    expect((await create('2001:db8:1:2::1')).status).toBe(201);
    expect((await create('2001:db8:1:2:dead:beef:0:1')).status).toBe(201);
    // Rotating the interface id, or the /64 inside the same /56, does not buy new attempts.
    expect((await create('2001:db8:1:2::ffff')).status).toBe(429);
    expect((await create('2001:db8:1:7f::1')).status).toBe(429);
    expect((await create('2001:db8:1:100::1')).status).toBe(201);
  });
});

describe('rate limit keys', () => {
  it('keeps IPv4 addresses whole and reduces IPv6 to the prefix', () => {
    expect(rateKey('203.0.113.7')).toBe('203.0.113.7');
    expect(rateKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2:0:0:0:0/64');
    expect(rateKey('2001:DB8:1:2::9')).toBe('2001:db8:1:2:0:0:0:0/64');
    expect(rateKey('2001:db8:1:2ff::1', 56)).toBe('2001:db8:1:200:0:0:0:0/56');
    expect(rateKey('2001:db8:1:2:3:4:5:6', 48)).toBe('2001:db8:1:0:0:0:0:0/48');
    expect(rateKey('::1')).toBe('0:0:0:0:0:0:0:0/64');
    expect(rateKey('fe80::1%eth0')).toBe('fe80:0:0:0:0:0:0:0/64');
    expect(rateKey('2001:db8:1:2::1.2.3.4')).toBe('2001:db8:1:2:0:0:0:0/64');
  });

  it('treats IPv4-mapped socket addresses as the IPv4 client they are', () => {
    expect(rateKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(rateKey('::ffff:cb00:7107')).toBe('203.0.113.7');
  });

  it('passes anything that is not an IP through unchanged', () => {
    expect(rateKey('unknown')).toBe('unknown');
  });
});

describe('rate limiter memory', () => {
  it('forgets idle buckets on a regular sweep, not only when the map is huge', () => {
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter(5, 60, { sweepEveryMs: 60_000 });
      for (let i = 0; i < 1000; i++) limiter.take(`2001:db8:${i.toString(16)}::/64`);
      expect(limiter.size).toBe(1000);
      // Five tokens refill in five seconds, so a minute later every bucket is full again and can go.
      vi.advanceTimersByTime(60_000);
      limiter.take('fresh');
      expect(limiter.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps buckets that are still draining, so a sweep never resets a limit', () => {
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter(3, 1, { sweepEveryMs: 1000 });
      for (let i = 0; i < 3; i++) expect(limiter.take('busy')).toBe(true);
      expect(limiter.take('busy')).toBe(false);
      vi.advanceTimersByTime(2000);
      limiter.take('other');
      expect(limiter.take('busy')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never grows past its hard cap, dropping the least recently used keys', () => {
    const limiter = new RateLimiter(5, 1, { maxEntries: 100 });
    for (let i = 0; i < 5; i++) limiter.take('keep');
    for (let i = 0; i < 1000; i++) {
      limiter.take(`k${i}`);
      if (i % 10 === 0) limiter.take('keep');
    }
    expect(limiter.size).toBe(100);
    // The key used recently survived the evictions and still remembers that it is spent.
    expect(limiter.take('keep')).toBe(false);
  });
});

describe('caching headers', () => {
  const cacheControl = async (path: string) =>
    (await appWith('off').request(`${BASE}${path}`)).headers.get('cache-control');

  it('never lets a CDN or browser keep dynamic responses', async () => {
    expect(await cacheControl('/api/me')).toBe('no-store');
    expect(await cacheControl('/api/does-not-exist')).toBe('no-store');
    expect(await cacheControl('/healthz')).toBe('no-store');
    expect(await cacheControl('/.well-known/oauth-authorization-server')).toBe('no-store');
  });

  it('revalidates every unhashed file and caches hashed assets forever', async () => {
    for (const path of [
      '/',
      '/d/abc',
      '/sw.js',
      '/theme-init.js',
      '/manifest.webmanifest',
      '/icons/icon-192.png',
    ])
      expect([path, await cacheControl(path)]).toEqual([path, 'no-cache']);
    expect(await cacheControl('/assets/index-abc123.js')).toBe('public, max-age=31536000, immutable');
    // A 404 under a hashed name must not be pinned at the edge for a year.
    expect(await cacheControl('/assets/index-missing.js')).toBe('no-store');
  });
});

describe('live stream behind a proxy', () => {
  it('is an uncompressed event stream with a heartbeat well inside idle timeouts', async () => {
    const app = appWith('off');
    const created = await app.request(`${BASE}/api/dashboards`, {
      method: 'POST',
      headers: { origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'public' }),
    });
    const id = ((await created.json()) as { envelope: { meta: { id: string } } }).envelope.meta.id;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const res = await app.request(`${BASE}/api/dashboards/${id}/events`);
      expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
      expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
      expect(res.headers.get('content-encoding')).toBeNull();
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
      expect((await reader.read()).value).toContain('"hello"');
      // Cloudflare drops a proxied connection after about 100 s without traffic.
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await reader.read()).value).toContain('event: ping');
      await reader.cancel();
    } finally {
      vi.useRealTimers();
    }
  });
});
