/**
 * Regressions for the pre-launch security review: open redirects, OAuth client registration, existence leaks,
 * response headers and the reach of bearer tokens.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, createDeps } from './app.ts';
import { loadConfig } from './config.ts';
import type { Deps } from './context.ts';
import { safeReturnTo } from './routes/auth.ts';

const BASE = 'http://localhost:8787';
let dir: string;
let deps: Deps;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay-security-test-'));
  deps = await createDeps(
    loadConfig({
      NODE_ENV: 'test',
      DATA_DIR: dir,
      OFFLINE: '1',
      DEV_LOGIN: '1',
      PUBLIC_URL: BASE,
      PIPELINE_WORKERS: '0',
      // Never contacted: only the redirect to Google and the cookies set on the way are checked.
      GOOGLE_CLIENT_ID: 'test-client',
      GOOGLE_CLIENT_SECRET: 'test-secret',
    }),
  );
  app = createApp(deps);
});

afterAll(async () => {
  deps.hub.close();
  await deps.pipeline.close();
  deps.db.close();
  rmSync(dir, { recursive: true, force: true });
});

type Init = { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> };

async function call(path: string, init: Init = {}) {
  const headers: Record<string, string> = { origin: BASE, ...init.headers };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.cookie) headers.cookie = init.cookie;
  const res = await app.request(`${BASE}${path}`, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
}

async function login(email: string): Promise<string> {
  const res = await call('/auth/dev', { body: { email } });
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

describe('returnTo after sign-in', () => {
  const ORIGIN = 'https://patchbay.me.uk';
  // What a browser does with the Location header: the WHATWG parser strips tabs and newlines and reads `\` as `/`.
  const landsOn = (location: string) => new URL(location, ORIGIN).origin;

  const attacks = [
    '/\t/evil.com',
    '/\n/evil.com',
    '/\r\n/evil.com',
    '/ /evil.com',
    '/\\evil.com',
    '/\\/evil.com',
    '//evil.com',
    '///evil.com',
    '/.//evil.com',
    '/./\t/evil.com',
    '/\u0000/evil.com',
    '/​/evil.com',
    'https://evil.com/',
    '\t//evil.com',
    ' /evil.com',
    'evil.com',
    '',
  ];

  it('refuses every way of leaving the site', () => {
    for (const raw of attacks) {
      const out = safeReturnTo(raw);
      expect([raw, out]).toEqual([raw, '/me']);
    }
  });

  it('keeps encoded variants on our own origin', () => {
    for (const raw of [
      '/%09/evil.com',
      '/%2F/evil.com',
      '/%2F%2Fevil.com',
      '/%5Cevil.com',
      '/%5C%5Cevil.com',
    ]) {
      const out = safeReturnTo(raw);
      expect(out.startsWith('/')).toBe(true);
      expect(out.startsWith('//')).toBe(false);
      expect([raw, landsOn(out)]).toEqual([raw, ORIGIN]);
    }
  });

  it('keeps ordinary paths, queries and fragments as they are', () => {
    expect(safeReturnTo('/d/abc123')).toBe('/d/abc123');
    expect(safeReturnTo('/oauth/consent?request=req_1')).toBe('/oauth/consent?request=req_1');
    expect(safeReturnTo('/d/abc?tv=1#w1')).toBe('/d/abc?tv=1#w1');
    expect(safeReturnTo(undefined)).toBe('/me');
    expect(safeReturnTo(`/${'a'.repeat(600)}`)).toBe('/me');
  });

  it('never stores an unsafe value in the cookie on the way to Google', async () => {
    const res = await app.request(`${BASE}/auth/google?returnTo=%2F%09%2Fevil.com`);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).hostname).toBe('accounts.google.com');
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('pb_return_to='))!;
    expect(decodeURIComponent(cookie.split(';')[0]!.slice('pb_return_to='.length))).toBe('/me');
  });

  it('checks the cookie again on the way back', async () => {
    // Google's token endpoint, answering with an (unsigned) ID token; arctic only decodes it.
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const idToken = `${b64({ alg: 'none' })}.${b64({ sub: 'g-1', email: 'g@example.com', email_verified: true })}.x`;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ access_token: 'a', token_type: 'Bearer', id_token: idToken }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    try {
      const back = async (returnTo: string) => {
        const cookie = `pb_oauth_state=s; pb_oauth_verifier=v; pb_return_to=${encodeURIComponent(returnTo)}`;
        const res = await app.request(`${BASE}/auth/google/callback?state=s&code=c`, { headers: { cookie } });
        return res.headers.get('location')!;
      };
      // A cookie is client-controlled: it must not be trusted just because the server set that name earlier.
      expect(await back('/\t/evil.com')).toBe('/me');
      expect(await back('/\\evil.com')).toBe('/me');
      expect(await back('/d/abc')).toBe('/d/abc');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('sanitises the dev login return path the same way', async () => {
    const res = await call('/auth/dev', { body: { email: 'dev@example.com', returnTo: '/\t/evil.com' } });
    expect(res.json.returnTo).toBe('/me');
  });
});
