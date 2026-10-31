/** Self-service account deletion (GDPR erasure): what goes, what must stay, and that a failed attempt can be repeated. */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SHOWCASE_OWNER_ID } from '@patchbay/core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, createDeps } from './app.ts';
import { loadConfig } from './config.ts';
import type { Deps } from './context.ts';
import { sha256 } from './util/crypto.ts';

const BASE = 'http://localhost:8787';
let dir: string;
let deps: Deps;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay-account-'));
  deps = await createDeps(
    loadConfig({
      NODE_ENV: 'test',
      DATA_DIR: dir,
      OFFLINE: '1',
      DEV_LOGIN: '1',
      ADMIN_EMAILS: 'admin@example.com',
      PUBLIC_URL: BASE,
      SECRETS: 'users',
      SECRETS_KEY: randomBytes(32).toString('base64'),
    }),
  );
  app = createApp(deps);
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  deps.hub.close();
  await deps.pipeline.close();
  deps.db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Init {
  method?: string;
  body?: unknown;
  cookie?: string;
  headers?: Record<string, string>;
}

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
  return { status: res.status, json, res };
}

async function login(email: string): Promise<string> {
  const res = await app.request(`${BASE}/auth/dev`, {
    method: 'POST',
    headers: { origin: BASE, 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

const erase = (cookie: string, confirm: unknown, extra: Init = {}) =>
  call('/api/me', { method: 'DELETE', cookie, body: { confirm }, ...extra });

/** Through the service: the create limiter of the HTTP route (20 per minute) is not what these tests are about. */
async function dashboard(cookie: string, visibility: 'public' | 'private' = 'private'): Promise<string> {
  const user = deps.users.userForSession(decodeURIComponent(cookie.split('=')[1]!))!;
  const created = await deps.dashboards.create({ user, isAdmin: false, viaToken: false }, { visibility });
  return created.envelope.meta.id;
}

async function upload(id: string, cookie: string): Promise<string> {
  const res = await call(`/api/dashboards/${id}/files`, {
    body: { name: 'a.csv', content: 'a,b\n1,2\n3,4\n' },
    cookie,
  });
  expect(res.status).toBe(201);
  return res.json.id;
}

const countRows = (table: string, column: string, value: string) =>
  Number(
    (deps.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(value) as { n: number }).n,
  );

/** Everything a user can own, so the tests can check that none of it is left. */
async function populate(email: string) {
  const cookie = await login(email);
  const user = deps.users.upsert({ email, name: email });
  const dashboards = [await dashboard(cookie), await dashboard(cookie, 'public')];
  const fileId = await upload(dashboards[1]!, cookie);
  // Only files a dataset uses travel with a copy.
  const used = await call(`/api/dashboards/${dashboards[1]}/ops`, {
    cookie,
    body: {
      ops: [{ op: 'addDataset', dataset: { id: 'f', name: 'File', source: { kind: 'upload', fileId } } }],
    },
  });
  expect(used.status, used.json?.error).toBe(200);
  const pat = (await call('/api/tokens', { cookie, body: { name: 't', scopes: ['dashboards:write'] } })).json;
  const secret = await call('/api/secrets', {
    cookie,
    body: { name: 'Key', sendTo: 'https://api.example.com/v1/', placement: 'bearer', value: 'sekret-value' },
  });
  expect(secret.status, secret.json?.error).toBe(201);
  // An unfinished OAuth sign-in and a refresh token, the other things keyed by this user.
  deps.db
    .prepare(
      `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scopes, resource, expires_at)
       VALUES (?, 'c', ?, 'http://x/cb', 'ch', 'dashboards:read', 'r', '2999-01-01T00:00:00Z')`,
    )
    .run(sha256(`code-${email}`), user.id);
  return { cookie, user, dashboards, fileId, pat: pat.token as string };
}

describe('DELETE /api/me', () => {
  it('deletes the account and everything it owns, and nothing else', async () => {
    const alice = await populate('alice@example.com');
    const bob = await populate('bob@example.com');
    const anon = await call('/api/dashboards', { body: {} });
    const anonId = anon.json.envelope.meta.id as string;

    // A showcase dashboard (owner "system") that Alice has a copy of.
    const showcaseId = await dashboard(bob.cookie, 'public');
    const meta = (await deps.store.readMeta(showcaseId))!;
    await deps.store.writeMeta({ ...meta, ownerId: SHOWCASE_OWNER_ID });
    deps.index.upsert({ ...meta, ownerId: SHOWCASE_OWNER_ID }, { title: 'Showcase', widgets: 0 });

    // Bob duplicates Alice's public dashboard with an upload: the file is hard-linked into his copy.
    const copy = await call(`/api/dashboards/${alice.dashboards[1]}/duplicate`, {
      body: {},
      cookie: bob.cookie,
    });
    expect(copy.status).toBe(201);
    const copyId = copy.json.envelope.meta.id as string;
    expect((await deps.store.listFiles(copyId)).map((f) => f.id)).toContain(alice.fileId);

    const res = await erase(alice.cookie, ' Alice@Example.COM ');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      ok: true,
      deleted: { dashboards: 2, secrets: 1, tokens: 1, codes: 1, users: 1 },
    });
    expect(res.json.deleted.sessions).toBeGreaterThanOrEqual(1);

    for (const id of alice.dashboards) {
      expect(existsSync(deps.store.dir(id))).toBe(false);
      expect((await call(`/api/dashboards/${id}`)).status).toBe(404);
    }
    expect(deps.users.byId(alice.user.id)).toBeNull();
    for (const table of [
      'dashboards:owner_id',
      'secrets:user_id',
      'tokens:user_id',
      'oauth_codes:user_id',
      'sessions:user_id',
    ]) {
      const [t, c] = table.split(':') as [string, string];
      expect(countRows(t, c, alice.user.id), table).toBe(0);
    }
    expect(await deps.store.listFiles(alice.dashboards[1]!)).toEqual([]);

    // Others are untouched, including the copy whose upload shared a file with a deleted dashboard.
    expect((await call(`/api/dashboards/${bob.dashboards[0]}`, { cookie: bob.cookie })).status).toBe(200);
    expect((await call(`/api/dashboards/${showcaseId}`)).status).toBe(200);
    expect((await call(`/api/dashboards/${anonId}`)).status).toBe(200);
    expect((await call(`/api/dashboards/${copyId}`, { cookie: bob.cookie })).status).toBe(200);
    expect((await deps.store.listFiles(copyId)).map((f) => f.id)).toContain(alice.fileId);
    expect(await deps.store.readFileTable(copyId, alice.fileId)).not.toBeNull();
    expect(countRows('secrets', 'user_id', bob.user.id)).toBe(1);
    expect(countRows('tokens', 'user_id', bob.user.id)).toBe(1);
  });

  it('clears the session cookie and the old session is anonymous afterwards', async () => {
    const { cookie, pat } = await populate('carol@example.com');
    const res = await erase(cookie, 'carol@example.com');
    expect(res.status).toBe(200);
    expect(res.res.headers.get('set-cookie')).toMatch(/pb_session=;.*(Max-Age=0|Expires=Thu, 01 Jan 1970)/is);
    expect((await call('/api/me', { cookie })).json.user).toBeNull();
    expect((await call('/api/dashboards', { cookie })).status).toBe(401);
    // The token is gone with the account.
    expect((await call('/api/dashboards', { headers: { authorization: `Bearer ${pat}` } })).status).toBe(401);
  });

  it('refuses tokens with 403 and deletes nothing', async () => {
    const { pat, user, cookie } = await populate('dave@example.com');
    const res = await call('/api/me', {
      method: 'DELETE',
      body: { confirm: 'dave@example.com' },
      headers: { authorization: `Bearer ${pat}` },
    });
    expect(res.status).toBe(403);
    expect(deps.users.byId(user.id)).not.toBeNull();
    expect((await call('/api/me', { cookie })).json.user).not.toBeNull();
  });

  it('answers 400 to a wrong or missing confirmation and 401 when signed out', async () => {
    const { cookie, user } = await populate('erin@example.com');
    expect((await erase(cookie, 'someone@example.com')).status).toBe(400);
    expect((await erase(cookie, '')).status).toBe(400);
    expect((await erase(cookie, 42)).status).toBe(400);
    expect((await call('/api/me', { method: 'DELETE', cookie })).status).toBe(400);
    expect(
      (await call('/api/me', { method: 'DELETE', cookie, body: { confirm: 'erin@example.com', x: 1 } }))
        .status,
    ).toBe(400);
    expect((await call('/api/me', { method: 'DELETE', body: { confirm: 'erin@example.com' } })).status).toBe(
      401,
    );
    expect(deps.users.byId(user.id)).not.toBeNull();
    expect(countRows('dashboards', 'owner_id', user.id)).toBe(2);
  });

  it('rejects a cross-site request', async () => {
    const { cookie, user } = await populate('frank@example.com');
    const res = await erase(cookie, 'frank@example.com', { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expect(deps.users.byId(user.id)).not.toBeNull();
  });

  it('can be repeated after a failure midway and then finishes the job', async () => {
    const { cookie, user, dashboards } = await populate('grace@example.com');
    const spy = vi.spyOn(deps.users, 'eraseUser').mockImplementationOnce(() => {
      throw new Error('disk I/O error');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = await erase(cookie, 'grace@example.com');
    expect(failed.status).toBe(500);
    // Dashboards were already removed, the account is intact and still signed in.
    for (const id of dashboards) expect(existsSync(deps.store.dir(id))).toBe(false);
    expect(deps.users.byId(user.id)).not.toBeNull();
    expect(countRows('secrets', 'user_id', user.id)).toBe(1);

    const retry = await erase(cookie, 'grace@example.com');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(retry.status).toBe(200);
    expect(deps.users.byId(user.id)).toBeNull();
    expect(countRows('secrets', 'user_id', user.id)).toBe(0);
  });

  it('finds a dashboard that is missing from the index', async () => {
    const { cookie, dashboards } = await populate('heidi@example.com');
    deps.index.remove(dashboards[0]!);
    const res = await erase(cookie, 'heidi@example.com');
    expect(res.status).toBe(200);
    expect(existsSync(deps.store.dir(dashboards[0]!))).toBe(false);
  });

  it('lets an administrator delete their own account', async () => {
    const { cookie, user } = await populate('admin@example.com');
    expect((await erase(cookie, 'admin@example.com')).status).toBe(200);
    expect(deps.users.byId(user.id)).toBeNull();
    // Signing in again creates a fresh, empty account.
    const again = await login('admin@example.com');
    expect((await call('/api/dashboards', { cookie: again })).json).toEqual([]);
  });
});
