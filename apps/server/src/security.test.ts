/**
 * Regressions for the pre-launch security review: open redirects, OAuth client registration, existence leaks,
 * response headers and the reach of bearer tokens.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, createDeps } from './app.ts';
import { loadConfig } from './config.ts';
import type { Deps } from './context.ts';
import { safeReturnTo } from './routes/auth.ts';
import { CIMD_MAX_BYTES, CIMD_MAX_VALUES, CIMD_TIMEOUT_MS, describeRedirect } from './routes/oauth.ts';
import { HttpError } from './util/errors.ts';
import { RateLimiter } from './util/rate-limit.ts';
import { isPrivateAddress, safeFetchJson } from './util/safe-fetch.ts';

// The real implementation unless a test says otherwise, so the options callers pass can be checked.
vi.mock('./util/safe-fetch.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('./util/safe-fetch.ts')>();
  return { ...real, safeFetchJson: vi.fn(real.safeFetchJson) };
});

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
  // Rate limits are covered in proxy.test.ts; here they would only get in the way of the many registrations.
  app = createApp({ ...deps, limits: { ...deps.limits, auth: new RateLimiter(10_000, 10_000) } });
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

describe('OAuth dynamic client registration', () => {
  const register = (body: Record<string, unknown>) =>
    call('/oauth/register', { body: { redirect_uris: ['https://app.example/cb'], ...body } });
  const stored = (clientId: string) =>
    deps.db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId) as
      | { metadata: string; created_at: string; last_used_at: string | null }
      | undefined;

  it('caps every field and list', async () => {
    const tooLong = 'x'.repeat(5000);
    for (const body of [
      { client_name: 'x'.repeat(121) },
      { scope: tooLong },
      { grant_types: ['authorization_code', tooLong] },
      { grant_types: Array.from({ length: 9 }, () => 'authorization_code') },
      { response_types: Array.from({ length: 9 }, () => 'code') },
      { token_endpoint_auth_method: tooLong },
      { client_uri: `https://app.example/${tooLong}` },
      { software_id: tooLong },
      { redirect_uris: Array.from({ length: 9 }, (_, i) => `https://app.example/cb${i}`) },
      { redirect_uris: [`https://app.example/${tooLong}`] },
    ]) {
      const res = await register(body);
      expect([Object.keys(body)[0], res.status]).toEqual([Object.keys(body)[0], 400]);
    }
  });

  it('accepts unknown metadata (RFC 7591) without storing it', async () => {
    const res = await register({
      client_name: 'Client',
      contacts: ['a@example.com'],
      junk: 'y'.repeat(100_000),
      grant_types: ['authorization_code', 'refresh_token'],
    });
    expect(res.status).toBe(201);
    const row = stored(res.json.client_id)!;
    expect(row.metadata.length).toBeLessThan(500);
    expect(JSON.parse(row.metadata)).not.toHaveProperty('junk');
  });

  it('purges clients that never got a grant after a day, and idle ones after months', async () => {
    const user = deps.users.upsert({ email: 'purge@example.com', name: 'Purge' });
    const ids = {
      fresh: (await register({ client_name: 'fresh' })).json.client_id as string,
      abandoned: (await register({ client_name: 'abandoned' })).json.client_id as string,
      active: (await register({ client_name: 'active' })).json.client_id as string,
      idle: (await register({ client_name: 'idle' })).json.client_id as string,
      recent: (await register({ client_name: 'recent' })).json.client_id as string,
    };
    const day = 86_400_000;
    const backdate = (id: string, createdAgo: number, usedAgo: number | null) =>
      deps.db
        .prepare('UPDATE oauth_clients SET created_at = ?, last_used_at = ? WHERE client_id = ?')
        .run(
          new Date(Date.now() - createdAgo).toISOString(),
          usedAgo === null ? null : new Date(Date.now() - usedAgo).toISOString(),
          id,
        );
    backdate(ids.abandoned, day + 60_000, null);
    backdate(ids.active, 200 * day, 120 * day);
    backdate(ids.idle, 200 * day, 100 * day);
    backdate(ids.recent, 200 * day, 10 * day);
    // A live refresh token keeps a client, however long ago it last refreshed.
    deps.tokens.issueOAuth(user.id, ids.active, ['dashboards:read'], `${BASE}/mcp`);

    deps.users.purgeExpired();
    expect(stored(ids.fresh)).toBeDefined();
    expect(stored(ids.abandoned)).toBeUndefined();
    expect(stored(ids.active)).toBeDefined();
    expect(stored(ids.idle)).toBeUndefined();
    expect(stored(ids.recent)).toBeDefined();
  });

  it('records when a client last obtained tokens', async () => {
    const id = (await register({ client_name: 'used' })).json.client_id as string;
    expect(stored(id)!.last_used_at).toBeNull();
    const user = deps.users.upsert({ email: 'used@example.com', name: 'Used' });
    const { refreshToken } = deps.tokens.issueOAuth(user.id, id, ['dashboards:read'], `${BASE}/mcp`);
    const res = await app.request(`${BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: id }),
    });
    expect(res.status).toBe(200);
    expect(stored(id)!.last_used_at).not.toBeNull();
  });
});

describe('what a bearer token can reach', () => {
  const pkce = () => {
    const verifier = randomBytes(32).toString('base64url');
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
  };

  async function setup(email: string) {
    const cookie = await login(email);
    const pat = (
      await call('/api/tokens', {
        body: { name: 'script', scopes: ['dashboards:read', 'dashboards:write'] },
        cookie,
      })
    ).json.token as string;
    return { cookie, pat };
  }

  it('cannot approve a new OAuth grant with a token (no self-renewing access)', async () => {
    const { pat } = await setup('leak@example.com');
    const bearer = { authorization: `Bearer ${pat}` };
    const redirectUri = 'http://127.0.0.1:4444/callback';
    const clientId = (await call('/oauth/register', { body: { redirect_uris: [redirectUri] } })).json
      .client_id;
    const { challenge } = pkce();
    const authorize = await app.request(
      `${BASE}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256`,
    );
    const requestId = new URL(authorize.headers.get('location')!, BASE).searchParams.get('request');
    expect(requestId).toBeTruthy();
    expect((await call(`/api/oauth/requests/${requestId}`, { headers: bearer })).status).toBe(403);
    const approve = await call(`/api/oauth/requests/${requestId}`, {
      body: { approve: true },
      headers: bearer,
    });
    expect(approve.status).toBe(403);
    expect(approve.json.redirect).toBeUndefined();
  });

  it('cannot list or revoke tokens and connected clients', async () => {
    const { cookie, pat } = await setup('manage@example.com');
    const bearer = { authorization: `Bearer ${pat}` };
    const listed = await call('/api/tokens', { cookie });
    const patId = listed.json.tokens[0].id as string;
    expect((await call('/api/tokens', { headers: bearer })).status).toBe(403);
    expect((await call(`/api/tokens/${patId}`, { method: 'DELETE', headers: bearer })).status).toBe(403);
    expect((await call('/api/grants/grant_x', { method: 'DELETE', headers: bearer })).status).toBe(403);
    expect(
      (await call('/api/tokens', { body: { name: 'more', scopes: ['dashboards:read'] }, headers: bearer }))
        .status,
    ).toBe(403);
    // The session still manages everything.
    expect((await call(`/api/tokens/${patId}`, { method: 'DELETE', cookie })).status).toBe(200);
  });

  it('keeps OAuth access tokens on /mcp, where their audience is', async () => {
    const { pat } = await setup('audience@example.com');
    const user = deps.users.upsert({ email: 'audience@example.com', name: 'Audience' });
    const { accessToken } = deps.tokens.issueOAuth(
      user.id,
      'client',
      ['dashboards:read', 'dashboards:write'],
      `${BASE}/mcp`,
    );
    const me = (token: string) => call('/api/me', { headers: { authorization: `Bearer ${token}` } });
    expect((await me(accessToken)).status).toBe(401);
    expect(
      (await call('/api/dashboards', { headers: { authorization: `Bearer ${accessToken}` } })).status,
    ).toBe(401);
    // Personal access tokens are meant for scripts and keep working on the REST API.
    expect((await me(pat)).json.user.email).toBe('audience@example.com');
    // And the access token still works where it belongs.
    const mcp = await app.request(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      }),
    });
    expect(mcp.status).toBe(200);
  });
});

describe('OAuth consent screen data', () => {
  const startAuthorization = async (clientId: string, redirectUri: string) => {
    const res = await app.request(
      `${BASE}/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=abc&code_challenge_method=S256`,
    );
    return new URL(res.headers.get('location')!, BASE);
  };

  it('fetches client metadata documents without following redirects', async () => {
    const clientId = 'https://client.example/oauth/meta.json';
    vi.mocked(safeFetchJson).mockResolvedValueOnce({
      client_id: clientId,
      client_name: 'Claude',
      redirect_uris: ['https://client.example/cb'],
    });
    const consent = await startAuthorization(clientId, 'https://client.example/cb');
    expect(vi.mocked(safeFetchJson)).toHaveBeenLastCalledWith(clientId, {
      redirects: 0,
      maxBytes: CIMD_MAX_BYTES,
      maxValues: CIMD_MAX_VALUES,
      timeoutMs: CIMD_TIMEOUT_MS,
    });
    const cookie = await login('consent@example.com');
    const details = await call(`/api/oauth/requests/${consent.searchParams.get('request')}`, { cookie });
    // The name is the client's claim; the host is what the user can check.
    expect(details.json).toMatchObject({
      clientName: 'Claude',
      clientKind: 'cimd',
      clientHost: 'client.example',
      redirectHost: 'client.example',
      redirectKind: 'web',
    });
  });

  it('stores only the known fields of a metadata document, and fetches it through the outbound limiter', async () => {
    const clientId = 'https://extras.example/oauth/meta.json';
    vi.mocked(safeFetchJson).mockResolvedValueOnce({
      client_id: clientId,
      client_name: 'Extras',
      redirect_uris: ['https://extras.example/cb'],
      contacts: ['someone@example.com'],
      padding: 'x'.repeat(5000),
    });
    const run = vi.spyOn(deps.outbound, 'run');
    const consent = await startAuthorization(clientId, 'https://extras.example/cb');
    expect(consent.pathname).toBe('/oauth/consent');
    expect(run).toHaveBeenCalledWith(expect.stringMatching(/^ip:/), clientId, expect.any(Function));
    run.mockRestore();
    const row = deps.db.prepare('SELECT metadata FROM oauth_clients WHERE client_id = ?').get(clientId) as {
      metadata: string;
    };
    expect(JSON.parse(row.metadata)).toEqual({
      client_id: clientId,
      client_name: 'Extras',
      redirect_uris: ['https://extras.example/cb'],
    });
  });

  it('does not remember its own refusal as a broken metadata document', async () => {
    const clientId = 'https://busy.example/oauth/meta.json';
    const run = vi
      .spyOn(deps.outbound, 'run')
      .mockRejectedValueOnce(new HttpError(429, 'This server is already loading a lot from busy.example'));
    const refused = await startAuthorization(clientId, 'https://busy.example/cb');
    expect(refused.pathname).toBe('/oauth/error');
    expect(refused.searchParams.get('reason')).toContain('busy');
    run.mockRestore();
    vi.mocked(safeFetchJson).mockResolvedValueOnce({
      client_id: clientId,
      client_name: 'Busy',
      redirect_uris: ['https://busy.example/cb'],
    });
    expect((await startAuthorization(clientId, 'https://busy.example/cb')).pathname).toBe('/oauth/consent');
  });

  it('marks self-registered clients as having no verified identity', async () => {
    const reg = await call('/oauth/register', {
      body: { client_name: 'Claude', redirect_uris: ['http://127.0.0.1:4444/callback'] },
    });
    const consent = await startAuthorization(reg.json.client_id, 'http://127.0.0.1:4444/callback');
    const cookie = await login('consent2@example.com');
    const details = await call(`/api/oauth/requests/${consent.searchParams.get('request')}`, { cookie });
    expect(details.json).toMatchObject({
      clientKind: 'dcr',
      clientHost: null,
      redirectHost: '127.0.0.1:4444',
      redirectKind: 'loopback',
    });
  });

  it('describes where a redirect URI sends the user', () => {
    expect(describeRedirect('https://claude.ai/api/mcp/auth_callback')).toEqual({
      kind: 'web',
      target: 'claude.ai',
    });
    expect(describeRedirect('http://localhost:6274/cb')).toEqual({
      kind: 'loopback',
      target: 'localhost:6274',
    });
    expect(describeRedirect('cursor://anysphere.cursor-retrieval/oauth/callback')).toEqual({
      kind: 'app',
      target: 'cursor://anysphere.cursor-retrieval',
    });
    expect(describeRedirect('com.example.app:/callback')).toEqual({
      kind: 'app',
      target: 'com.example.app:',
    });
  });
});

describe('SSRF blocklist (IANA special-purpose registries)', () => {
  it('refuses IPv4-translated, 6to4 relay and the other special-purpose ranges', () => {
    for (const ip of [
      '::ffff:0:127.0.0.1', // IPv4-translated, the URL parser writes it as ::ffff:0:7f00:1
      '::ffff:0:7f00:1',
      '::ffff:0:a9fe:a9fe',
      '192.88.99.1', // 6to4 relay anycast
      '2001::1', // Teredo
      '2001:0:4136:e378:8000:63bf:3fff:fdd2',
      '2001:2::1', // benchmarking
      '2001:10::1', // ORCHID
      '3fff::1', // documentation
      '5f00::1', // SRv6
      'fec0::1', // site local
      '100:0:0:1::1', // dummy prefix
      '4000::1', // unallocated
      '::ffff:10.0.0.1',
      '::ffff:192.88.99.1',
    ]) {
      expect([ip, isPrivateAddress(ip)]).toEqual([ip, true]);
    }
  });

  it('still allows public addresses, including IPv4-mapped ones', () => {
    for (const ip of [
      '8.8.8.8',
      '192.88.98.1',
      '192.88.100.1',
      '2606:4700::1111',
      '2001:4860:4860::8888',
      '2001:200::1',
      '2a00:1450:4001::1',
      '::ffff:8.8.8.8',
    ]) {
      expect([ip, isPrivateAddress(ip)]).toEqual([ip, false]);
    }
  });

  it('refuses a literal IPv4-translated host in a URL', async () => {
    await expect(safeFetchJson('https://[::ffff:0:127.0.0.1]/x')).rejects.toThrow(/private/);
  });
});

describe('landing page showcase under load', () => {
  it('resolves once per second for all visitors, and once for concurrent requests', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const resolve = vi.spyOn(deps.data, 'resolve');
    try {
      // A separate app, so no earlier test has filled the cache.
      const fresh = createApp(deps);
      const get = () => fresh.request(`${BASE}/api/showcase`);
      const first = await Promise.all(Array.from({ length: 20 }, get));
      expect(first.every((r) => r.status === 200)).toBe(true);
      expect(first[0]!.headers.get('content-type')).toMatch(/^application\/json/);
      const bodies = await Promise.all(first.map((r) => r.json()));
      expect(Object.keys(bodies[0] as object).sort()).toEqual(['products', 'revenue', 'signal']);
      expect(resolve).toHaveBeenCalledTimes(3);
      vi.advanceTimersByTime(500);
      await get();
      expect(resolve).toHaveBeenCalledTimes(3);
      vi.advanceTimersByTime(600);
      await get();
      expect(resolve).toHaveBeenCalledTimes(6);
    } finally {
      resolve.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('response headers', () => {
  it('sends a CSP that also locks down <base> and plugins', async () => {
    const csp = (await app.request(`${BASE}/api/me`)).headers.get('content-security-policy')!;
    const directives = new Map(
      csp.split(';').map((d) => {
        const [name, ...values] = d.trim().split(/\s+/);
        return [name, values.join(' ')] as const;
      }),
    );
    expect(directives.get('base-uri')).toBe("'none'");
    expect(directives.get('object-src')).toBe("'none'");
    expect(directives.get('frame-ancestors')).toBe("'none'");
    expect(directives.get('script-src')).toContain("'self'");
    expect(directives.get('script-src')).not.toContain('unsafe');
  });
});

describe('private dashboards and missing ones look the same', () => {
  it('answers strangers, signed in or not, with an identical 404 on every route', async () => {
    const owner = await login('owner@example.com');
    const stranger = await login('stranger@example.com');
    const created = await call('/api/dashboards', { body: { visibility: 'private' }, cookie: owner });
    const id = created.json.envelope.meta.id as string;
    const missing = 'doesnotexist00';
    const requests: [string, Init][] = [
      ['', {}],
      ['/versions', {}],
      ['/events', {}],
      ['/files', {}],
      ['/data/x', {}],
      ['/snapshot.png', {}],
      ['/ops', { body: { ops: [{ op: 'setTitle', title: 'x' }] } }],
      ['/ops', { body: { ops: [{ op: 'setTitle', title: 'x' }], dryRun: true } }],
      ['', { method: 'PUT', body: { doc: {}, baseVersion: 1 } }],
      ['/settings', { method: 'PATCH', body: { visibility: 'public' } }],
      ['/claim', { method: 'POST' }],
      ['/versions/1/restore', { method: 'POST' }],
      ['', { method: 'DELETE' }],
      ['/files/f_1', { method: 'DELETE' }],
    ];
    for (const cookie of [undefined, stranger]) {
      for (const [suffix, init] of requests) {
        const withCookie = cookie ? { ...init, cookie } : init;
        const real = await call(`/api/dashboards/${id}${suffix}`, withCookie);
        const fake = await call(`/api/dashboards/${missing}${suffix}`, withCookie);
        const label = `${init.method ?? (init.body ? 'POST' : 'GET')} ${suffix || '/'} ${cookie ? 'signed in' : 'anonymous'}`;
        expect([label, real.status, real.json?.error]).toEqual([label, fake.status, fake.json?.error]);
      }
    }
    // The owner still sees it.
    expect((await call(`/api/dashboards/${id}`, { cookie: owner })).status).toBe(200);
  });
});
