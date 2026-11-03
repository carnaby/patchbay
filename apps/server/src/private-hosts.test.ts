/**
 * ALLOW_PRIVATE_HOSTS through the REST API and MCP: who may save, load and preview sources on the operator's
 * network, and what a public instance answers instead. The upstream is a local server on 127.0.0.1, reached for real (no test
 * dispatcher): an IP literal needs no DNS lookup, so this runs the production agents.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, createDeps } from './app.ts';
import { loadConfig } from './config.ts';
import { RateLimiter } from './util/rate-limit.ts';
import { URL_MESSAGES } from './util/safe-fetch.ts';

const BASE = 'http://localhost:8787';
const ADMIN = 'admin@example.com';
const TOKEN = 'ha-token-1234567890';
let upstream: Server;
let port = 0;
/** Requests that reached the listed host: a refusal must happen before any connection. */
let hits = 0;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    if (req.url?.startsWith('/api/states')) {
      hits++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            entity_id: 'light.kitchen',
            state: 'on',
            authorized: req.headers.authorization === `Bearer ${TOKEN}`,
          },
        ]),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  port = (upstream.address() as { port: number }).port;
});

afterAll(async () => {
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
});

const states = () => `http://127.0.0.1:${port}/api/states`;
const home = (url: string, extra: Record<string, unknown> = {}) => ({
  id: 'home',
  name: 'Home',
  source: { kind: 'http' as const, url, ...extra },
});

type Init = { method?: string; body?: unknown; headers?: Record<string, string> };
type Target = { id: string; headers: Record<string, string> };

async function instance(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'patchbay-private-hosts-'));
  const deps = await createDeps(
    loadConfig({
      NODE_ENV: 'test',
      DATA_DIR: dir,
      OFFLINE: '1',
      DEV_LOGIN: '1',
      PUBLIC_URL: BASE,
      PIPELINE_WORKERS: '0',
      ADMIN_EMAILS: ADMIN,
      ...env,
    }),
  );
  const generous = () => new RateLimiter(100_000, 100_000);
  const app = createApp({
    ...deps,
    limits: {
      api: generous(),
      writes: generous(),
      auth: generous(),
      mcp: generous(),
      creates: generous(),
      snapshots: generous(),
    },
  });
  const call = async (path: string, init: Init = {}) => {
    const headers: Record<string, string> = { origin: BASE, ...init.headers };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
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
    return { status: res.status, json };
  };
  const login = async (email: string) => {
    const res = await app.request(`${BASE}/auth/dev`, {
      method: 'POST',
      headers: { origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    return { cookie: res.headers.get('set-cookie')!.split(';')[0]! };
  };
  /** A new dashboard: owned by `email`, or anonymous (edited with its edit key). */
  const dashboard = async (email?: string) => {
    const auth = email ? await login(email) : undefined;
    const { envelope, editKey } = (
      await call('/api/dashboards', { body: {}, ...(auth ? { headers: auth } : {}) })
    ).json;
    return {
      id: envelope.meta.id as string,
      ownerId: envelope.meta.ownerId as string | null,
      headers: auth ?? { 'x-edit-key': editKey as string },
    };
  };
  const addDataset = (d: Target, dataset: unknown, dryRun = false) =>
    call(`/api/dashboards/${d.id}/ops`, {
      body: { ops: [{ op: 'addDataset', dataset }], ...(dryRun ? { dryRun } : {}) },
      headers: d.headers,
    });
  const preview = (d: Target, dataset: unknown) =>
    call(`/api/dashboards/${d.id}/preview`, { body: { dataset }, headers: d.headers });
  const data = (d: Target) => call(`/api/dashboards/${d.id}/data/home`, { headers: d.headers });
  const clients: Client[] = [];
  /** An MCP connection with a personal access token of `email`, read-only unless `write`. */
  const mcp = async (email: string, write: boolean) => {
    const scopes = write ? ['dashboards:read', 'dashboards:write'] : ['dashboards:read'];
    const token = (
      await call('/api/tokens', { body: { name: 'agent', scopes }, headers: await login(email) })
    ).json.token as string;
    const client = new Client({ name: 'vitest', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
        fetch: async (url, init) => app.request(String(url), init as RequestInit),
      }),
    );
    clients.push(client);
    /** preview_data's answer: the rows, or the refusal text. */
    return async (args: Record<string, unknown>) => {
      const res = (await client.callTool({ name: 'preview_data', arguments: args })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      return { isError: res.isError === true, text: res.content.map((c) => c.text).join(' ') };
    };
  };
  const close = async () => {
    for (const c of clients) await c.close().catch(() => {});
    deps.hub.close();
    await deps.pipeline.close();
    deps.db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { deps, call, login, dashboard, addDataset, preview, data, mcp, close };
}
type Instance = Awaited<ReturnType<typeof instance>>;

describe('a public instance (ALLOW_PRIVATE_HOSTS empty)', () => {
  let pub: Instance;
  beforeAll(async () => {
    pub = await instance({});
  });
  afterAll(() => pub.close());

  it('refuses http:// with a message that names the setting, when saved and when previewed', async () => {
    const admin = await pub.dashboard(ADMIN);
    const add = await pub.addDataset(admin, home(states()));
    expect(add.status).toBe(400);
    expect(add.json.error).toContain(`Dataset "home": ${URL_MESSAGES.httpOff}`);
    expect((await pub.preview(admin, home(states()))).json.result.error).toContain(URL_MESSAGES.httpOff);
    expect((await pub.preview(admin, home('https://192.168.1.20/api/states'))).json.result.error).toContain(
      URL_MESSAGES.privateOff,
    );
    expect(pub.deps.dashboards.networkAccess(admin.ownerId)).toEqual({ kind: 'public' });
  });
});

describe('a self-hosted instance with ALLOW_PRIVATE_HOSTS=127.0.0.1', () => {
  let lan: Instance;
  beforeAll(async () => {
    lan = await instance({
      ALLOW_PRIVATE_HOSTS: '127.0.0.1',
      SECRETS: 'admins',
      SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
    });
  });
  afterAll(() => lan.close());

  it("loads a listed host over http:// for an administrator's dashboard", async () => {
    const admin = await lan.dashboard(ADMIN);
    expect((await lan.addDataset(admin, home(states()))).status).toBe(200);
    const loaded = await lan.data(admin);
    expect(loaded.json.error ?? null).toBeNull();
    expect(loaded.json.table.rows).toEqual([{ entity_id: 'light.kitchen', state: 'on', authorized: false }]);
    expect(lan.deps.dashboards.networkAccess(admin.ownerId)).toEqual({
      kind: 'private',
      entries: ['127.0.0.1'],
    });
  });

  it('refuses other owners and anonymous dashboards, at save and when a stored source is loaded', async () => {
    const other = await lan.dashboard('someone@example.com');
    const anon = await lan.dashboard();
    for (const d of [other, anon]) {
      const add = await lan.addDataset(d, home(states()));
      expect(add.status).toBe(400);
      expect(add.json.error).toContain('only dashboards owned by an administrator');
    }
    // Another port needs the list as much as http:// does, so the owner hears why, not the public instance's text.
    const ported = await lan.addDataset(other, home('https://nas.example:8443/api'));
    expect(ported.status).toBe(400);
    expect(ported.json.error).toContain('only dashboards owned by an administrator');
    expect(lan.deps.dashboards.networkAccess(other.ownerId)).toEqual({ kind: 'not-yours' });
    // A document saved some other way (a copy, a restore, an older version) is refused when it loads, too.
    const meta = (await lan.deps.store.readMeta(other.id))!;
    const doc = (await lan.deps.store.readDoc(other.id))!;
    await lan.deps.store.writeDoc(
      { ...meta, version: meta.version + 1 },
      { ...doc, datasets: [{ ...home(states()), transforms: [], refreshSec: 0, accumulate: 0 }] } as never,
      { kind: 'anonymous', label: 'test' },
      ['Saved before'],
    );
    expect((await lan.data(other)).json.error).toContain('only dashboards owned by an administrator');
    // A restore brings back what was stored and leaves the decision to the load.
    const restored = await lan.call(`/api/dashboards/${other.id}/versions/${meta.version + 1}/restore`, {
      body: {},
      headers: other.headers,
    });
    expect(restored.status).toBe(200);
    expect((await lan.data(other)).json.error).toContain('only dashboards owned by an administrator');
  });

  it("never lends an administrator's private hosts to a viewer of the dashboard", async () => {
    const auth = await lan.login(ADMIN);
    const { envelope } = (
      await lan.call('/api/dashboards', { body: { visibility: 'public' }, headers: auth })
    ).json;
    const id = envelope.meta.id as string;
    const before = hits;
    const rest = await lan.call(`/api/dashboards/${id}/preview`, {
      body: { dataset: home(states()) },
      headers: await lan.login('viewer@example.com'),
    });
    expect(rest.status).toBe(403);
    const viewer = await lan.mcp('viewer@example.com', true);
    for (const dashboardId of [id, undefined]) {
      const res = await viewer({ ...(dashboardId ? { dashboardId } : {}), source: home(states()).source });
      expect(res.isError, dashboardId).toBe(true);
      expect(res.text).toContain('only dashboards owned by an administrator');
    }
    expect(hits).toBe(before);
  });

  it('keeps a read-only token from previewing what needs ALLOW_PRIVATE_HOSTS, also for an administrator', async () => {
    const auth = await lan.login(ADMIN);
    const { envelope } = (await lan.call('/api/dashboards', { body: {}, headers: auth })).json;
    const readOnly = await lan.mcp(ADMIN, false);
    const before = hits;
    for (const dashboardId of [envelope.meta.id as string, undefined]) {
      for (const url of [states(), `https://127.0.0.1:${port}/api/states`, 'https://127.0.0.1/api/states']) {
        const res = await readOnly({
          ...(dashboardId ? { dashboardId } : {}),
          source: { kind: 'http', url },
        });
        expect(res.isError, url).toBe(true);
        expect(res.text, url).toContain('dashboards:write');
      }
    }
    expect(hits).toBe(before);
    // The administrator's own preview with write access still reaches the listed host.
    const writer = await lan.mcp(ADMIN, true);
    // A URL of its own, so the answer cannot come from an earlier test's cache.
    const ok = await writer({
      dashboardId: envelope.meta.id,
      source: { kind: 'http', url: `${states()}?own` },
    });
    expect(ok.isError, ok.text).toBe(false);
    expect(ok.text).toContain('light.kitchen');
    expect(hits).toBe(before + 1);
  });

  it('answers a read-only token of a user without the list the same for listed and unlisted names', async () => {
    const named = await instance({ ALLOW_PRIVATE_HOSTS: '127.0.0.1, homeassistant.lan' });
    try {
      const before = hits;
      const nobody = await named.mcp('someone@example.com', false);
      const answer = async (host: string) => {
        const res = await nobody({ source: { kind: 'http', url: `https://${host}/api` } });
        return { ...res, text: res.text.split(host).join('HOST') };
      };
      const listed = await answer('homeassistant.lan');
      const unlisted = await answer('pihole.lan');
      expect(listed).toEqual(unlisted);
      expect(listed.text).not.toContain('dashboards:write');
      expect(hits).toBe(before);
    } finally {
      await named.close();
    }
  });

  it('keeps a read-only preview of a name that resolves to loopback on the public rules', async () => {
    const both = await instance({ ALLOW_PRIVATE_HOSTS: '127.0.0.1 ::1' });
    try {
      const before = hits;
      // https on 443 is a "mixed" hop for a writer: localhost resolves to a listed address, so the lookup lets it
      // through (and the connect then fails, nothing listens on 443). A read-only token gets no list at all.
      const url = 'https://localhost/api/states';
      const readOnly = await (await both.mcp(ADMIN, false))({ source: { kind: 'http', url } });
      expect(readOnly.isError).toBe(true);
      expect(readOnly.text).toContain(URL_MESSAGES.privateOff);
      const writer = await (await both.mcp(ADMIN, true))({ source: { kind: 'http', url } });
      expect(writer.isError).toBe(true);
      expect(writer.text).not.toContain(URL_MESSAGES.privateOff);
      expect(hits).toBe(before);
    } finally {
      await both.close();
    }
  });

  it('refuses an http:// secret binding to a user who may not use the list', async () => {
    const users = await instance({
      ALLOW_PRIVATE_HOSTS: '127.0.0.1',
      SECRETS: 'users',
      SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
    });
    try {
      const cookie = await users.login('someone@example.com');
      for (const sendTo of [`http://127.0.0.1:${port}/api/`, 'https://127.0.0.1:8443/api/']) {
        const res = await users.call('/api/secrets', {
          body: { name: 'Home Assistant', sendTo, placement: 'bearer', value: TOKEN },
          headers: cookie,
        });
        expect(res.status, sendTo).toBe(400);
      }
      expect((await users.call('/api/secrets', { headers: cookie })).json.secrets).toEqual([]);
      const admin = await users.login(ADMIN);
      const ok = await users.call('/api/secrets', {
        body: {
          name: 'Home Assistant',
          sendTo: `http://127.0.0.1:${port}/api/`,
          placement: 'bearer',
          value: TOKEN,
        },
        headers: admin,
      });
      expect(ok.status).toBe(201);
    } finally {
      await users.close();
    }
  });

  it('refuses an http:// address the list does not cover in any spelling, and leaves names to the fetch', async () => {
    const admin = await lan.dashboard(ADMIN);
    const ip = await lan.addDataset(admin, home('http://192.168.0.1/api'));
    expect(ip.status).toBe(400);
    expect(ip.json.error).toContain(URL_MESSAGES.notListed('192.168.0.1'));
    expect((await lan.addDataset(admin, home('http://nas.invalid:8080/api'), true)).status).toBe(200);
    for (const url of [
      'http://3232235521/api',
      'http://[::ffff:c0a8:1]/api',
      'https://169.254.169.254/latest/meta-data/',
    ]) {
      expect((await lan.preview(admin, home(url))).json.result.error, url).toContain('is not covered by');
    }
  });

  it('sends a secret over http:// to a listed host, and refuses one bound to a host the list does not name', async () => {
    const auth = await lan.login(ADMIN);
    const admin = await lan.dashboard(ADMIN);
    const created = await lan.call('/api/secrets', {
      body: {
        name: 'Home Assistant',
        sendTo: `http://127.0.0.1:${port}/api/`,
        placement: 'bearer',
        value: TOKEN,
      },
      headers: auth,
    });
    expect(created.status).toBe(201);
    expect((await lan.addDataset(admin, home(states(), { secrets: [created.json.id] }))).status).toBe(200);
    expect((await lan.data(admin)).json.table.rows).toEqual([
      { entity_id: 'light.kitchen', state: 'on', authorized: true },
    ]);
    const refused = await lan.call('/api/secrets', {
      body: { name: 'Router', sendTo: 'http://192.168.0.1/', placement: 'bearer', value: TOKEN },
      headers: auth,
    });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toContain('only for hosts listed in ALLOW_PRIVATE_HOSTS by name or address');
    expect((await lan.call('/api/me', { headers: auth })).json.privateHosts).toBe(true);
  });

  it('opens the list to anonymous dashboards with PRIVATE_HOSTS_FOR=everyone', async () => {
    const open = await instance({ ALLOW_PRIVATE_HOSTS: '127.0.0.1', PRIVATE_HOSTS_FOR: 'everyone' });
    try {
      const anon = await open.dashboard();
      expect((await open.addDataset(anon, home(states()))).status).toBe(200);
      expect((await open.data(anon)).json.table.rows).toHaveLength(1);
    } finally {
      await open.close();
    }
  });

  it('opens the list to every signed-in owner with PRIVATE_HOSTS_FOR=signed-in, not to anonymous dashboards', async () => {
    const signedIn = await instance({ ALLOW_PRIVATE_HOSTS: '127.0.0.1', PRIVATE_HOSTS_FOR: 'signed-in' });
    try {
      const owned = await signedIn.dashboard('someone@example.com');
      expect((await signedIn.addDataset(owned, home(states()))).status).toBe(200);
      expect((await signedIn.data(owned)).json.table.rows).toHaveLength(1);
      const anon = await signedIn.dashboard();
      const add = await signedIn.addDataset(anon, home(states()));
      expect(add.status).toBe(400);
      expect(add.json.error).toContain('Sign in and claim this dashboard first');
    } finally {
      await signedIn.close();
    }
  });
});
