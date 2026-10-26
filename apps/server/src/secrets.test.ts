/**
 * Secrets for HTTP sources (proposal 0003), end to end: management, the rules in DashboardService, fetching with
 * credentials, caches, and a canary that must never surface anywhere.
 *
 * The upstream is a local HTTP server. A test-only dispatcher routes every outgoing request to it, whatever the host
 * in the URL, so the URL-level SSRF checks (https, port 443, no private IP literals) still run; only the DNS-level
 * check of the production agent is replaced, exactly as the dispatcher seam documents.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { fromJsonSchema, type JsonSchemaType } from '@modelcontextprotocol/server';
import type { SecretInfo } from '@patchbay/core';
import { Agent } from 'undici';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, createDeps } from './app.ts';
import { loadConfig } from './config.ts';
import type { Deps } from './context.ts';
import { RateLimiter } from './util/rate-limit.ts';

const BASE = 'http://localhost:8787';
const API = 'https://api.example.com';
const key = () => randomBytes(32).toString('base64');
const value = (prefix = 'val') => `${prefix}_${randomBytes(16).toString('hex')}`;

// ---------------------------------------------------------------------------------------------------------------
// The upstream: records every request it receives and answers by path.

interface Received {
  host: string;
  url: string;
  headers: IncomingHttpHeaders;
}

class Upstream {
  readonly received: Received[] = [];
  counter = 0;
  private server!: Server;
  dispatcher!: Agent;

  async start() {
    this.server = createServer((req, res) => {
      const host = req.headers.host ?? '';
      const url = new URL(req.url ?? '/', `https://${host}`);
      this.received.push({ host, url: req.url ?? '', headers: req.headers });
      const auth = req.headers.authorization ?? null;
      const apiKey = (req.headers['x-api-key'] as string | undefined) ?? null;
      const queryKey = url.searchParams.get('api_key');
      const presented = [auth?.replace(/^Bearer /, ''), apiKey, queryKey].filter(Boolean);
      // Identifies the credentials without echoing them, like an account id would.
      const account = presented.length
        ? `acct-${createHash('sha256').update(presented.join('|')).digest('hex').slice(0, 8)}`
        : 'anonymous';
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (host !== 'api.example.com') return json(200, { items: [{ stolen: true }] });
      switch (url.pathname) {
        case '/v1/orders':
          return json(200, {
            items: [
              { id: 1, total: 10, account },
              { id: 2, total: 20, account },
            ],
          });
        case '/v1/counter':
          return json(200, { items: [{ n: ++this.counter, account }] });
        case '/v1/whoami':
          // Echoes everything it received, as some APIs do in debug fields and error payloads.
          return json(200, {
            items: [
              {
                account,
                echoAuth: auth,
                echoKey: apiKey,
                echoUrl: req.url,
                [`key:${apiKey ?? queryKey ?? auth}`]: 1,
                numeric: Number(queryKey ?? 0),
              },
            ],
          });
        case '/v1/redirect-same':
          res.writeHead(302, { location: '/v1/orders' });
          return res.end();
        case '/v1/redirect-other':
          res.writeHead(302, { location: 'https://other.example.com/steal' });
          return res.end();
        case '/v1/redirect-outside':
          res.writeHead(302, { location: '/admin/orders' });
          return res.end();
        case '/v1/redirect-echo':
          // A redirect whose target carries the credential it received.
          res.writeHead(302, {
            location: `https://other.example.com/steal?got=${encodeURIComponent(auth ?? '')}`,
          });
          return res.end();
        case '/v1/unauthorized':
          return json(401, { error: 'bad credential', received: { headers: req.headers, url: req.url } });
        case '/v1/invalid':
          res.writeHead(200, { 'content-type': 'text/plain' });
          return res.end(`not json: ${auth} ${apiKey} ${req.url}`);
        case '/v1/big':
          res.writeHead(200, {
            'content-type': 'application/json',
            'content-length': String(6 * 1024 * 1024),
          });
          res.write(`{"auth":"${auth}","pad":"`);
          setTimeout(() => res.destroy(), 50);
          return;
        case '/v1/slow':
          setTimeout(() => json(200, { items: [{ auth }] }), 1500);
          return;
        case '/admin/orders':
          return json(200, { items: [{ admin: true, account }] });
        default:
          return json(404, { error: 'not found', url: req.url });
      }
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const port = (this.server.address() as { port: number }).port;
    this.dispatcher = new Agent({
      connect: (_options, callback) => {
        const socket = connect(port, '127.0.0.1');
        socket.once('connect', () => callback(null, socket));
        socket.once('error', (e) => callback(e, null));
      },
    });
  }

  async stop() {
    await this.dispatcher.close();
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  since(mark: number) {
    return this.received.slice(mark);
  }
}

const upstream = new Upstream();

// ---------------------------------------------------------------------------------------------------------------
// An app instance over a data directory, with the REST and MCP harnesses of server.test.ts.

type Init = {
  method?: string;
  body?: unknown;
  rawBody?: string;
  cookie?: string;
  headers?: Record<string, string>;
};

class Env {
  deps!: Deps;
  app!: ReturnType<typeof createApp>;
  /** Every response body and header seen by a client, for the canary. */
  readonly seen: string[] = [];
  readonly dir: string;
  private readonly clients: Client[] = [];

  constructor(dir?: string) {
    this.dir = dir ?? mkdtempSync(join(tmpdir(), 'patchbay-secrets-test-'));
  }

  async start(env: Record<string, string>) {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATA_DIR: this.dir,
      OFFLINE: '1',
      DEV_LOGIN: '1',
      ADMIN_EMAILS: 'admin@example.com',
      PUBLIC_URL: BASE,
      PIPELINE_WORKERS: '0',
      ...env,
    });
    this.deps = await createDeps(config, {
      upstreamTest: { dispatcher: upstream.dispatcher, timeoutMs: 500 },
    });
    // Tests write far faster than people; the budgets are covered elsewhere.
    const generous = () => new RateLimiter(100_000, 100_000);
    this.app = createApp({
      ...this.deps,
      limits: { api: generous(), writes: generous(), auth: generous(), mcp: generous(), creates: generous() },
    });
    return this;
  }

  async close(removeDir = true) {
    for (const c of this.clients) await c.close().catch(() => {});
    this.deps.hub.close();
    await this.deps.pipeline.close();
    this.deps.db.close();
    if (removeDir) rmSync(this.dir, { recursive: true, force: true });
  }

  async call(path: string, init: Init = {}) {
    const headers: Record<string, string> = { origin: BASE, ...init.headers };
    const hasBody = init.body !== undefined || init.rawBody !== undefined;
    if (hasBody) headers['content-type'] = 'application/json';
    if (init.cookie) headers.cookie = init.cookie;
    const res = await this.app.request(`${BASE}${path}`, {
      method: init.method ?? (hasBody ? 'POST' : 'GET'),
      headers,
      ...(hasBody ? { body: init.rawBody ?? JSON.stringify(init.body) } : {}),
    });
    const text = await res.text();
    this.seen.push(text, JSON.stringify([...res.headers]));
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json, text };
  }

  async login(email: string): Promise<string> {
    const res = await this.app.request(`${BASE}/auth/dev`, {
      method: 'POST',
      headers: { origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    return res.headers.get('set-cookie')!.split(';')[0]!;
  }

  async pat(cookie: string, scopes = ['dashboards:read', 'dashboards:write']): Promise<string> {
    return (await this.call('/api/tokens', { body: { name: 'agent', scopes }, cookie })).json.token;
  }

  async mcp(token: string): Promise<Client> {
    const client = new Client({ name: 'vitest', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
        fetch: async (url, init) => {
          const res = await this.app.request(String(url), init as RequestInit);
          // Not awaited: a long-lived stream must not block the client.
          void res
            .clone()
            .text()
            .then((t) => this.seen.push(t, JSON.stringify([...res.headers])))
            .catch(() => {});
          return res;
        },
      }),
    );
    this.clients.push(client);
    return client;
  }

  async secret(cookie: string, over: Record<string, unknown> = {}): Promise<SecretInfo> {
    const res = await this.call('/api/secrets', {
      cookie,
      body: {
        name: `Secret ${randomBytes(3).toString('hex')}`,
        sendTo: `${API}/v1/`,
        placement: 'bearer',
        value: value(),
        ...over,
      },
    });
    expect(res.status, res.text).toBe(201);
    return res.json;
  }

  async dashboard(cookie: string, visibility: 'public' | 'private' = 'private'): Promise<string> {
    return (await this.call('/api/dashboards', { body: { visibility }, cookie })).json.envelope.meta.id;
  }

  ops(id: string, cookie: string | undefined, ops: unknown[], extra: Record<string, unknown> = {}) {
    return this.call(`/api/dashboards/${id}/ops`, { body: { ops, ...extra }, ...(cookie ? { cookie } : {}) });
  }

  async data(id: string, datasetId: string, cookie?: string) {
    return (await this.call(`/api/dashboards/${id}/data/${datasetId}`, cookie ? { cookie } : {})).json;
  }
}

const http = (id: string, path: string, secrets?: string[], extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  source: { kind: 'http', url: `${API}${path}`, ...(secrets ? { secrets } : {}) },
  ...extra,
});
const addDataset = (dataset: unknown) => ({ op: 'addDataset', dataset });
const text = (r: { content?: unknown }) =>
  (r.content as { type: string; text?: string }[]).find((c) => c.type === 'text')!.text!;

const KEY = key();
let env: Env;

beforeAll(async () => {
  await upstream.start();
  env = await new Env().start({ SECRETS: 'users', SECRETS_KEY: KEY });
});

afterAll(async () => {
  await env?.close();
  await upstream.stop();
});

// ---------------------------------------------------------------------------------------------------------------

describe('managing secrets over REST', () => {
  it('creates, lists, renames, replaces and deletes, and never returns a value', async () => {
    const cookie = await env.login('manager@example.com');
    const me = await env.call('/api/me', { cookie });
    expect(me.json).toMatchObject({ secrets: 'users', canUseSecrets: true });
    expect((await env.call('/api/me')).json).toMatchObject({ user: null, canUseSecrets: false });

    const v = value();
    const created = await env.call('/api/secrets', {
      cookie,
      body: {
        name: ' Shop API ',
        sendTo: 'https://API.example.com/v1',
        placement: 'header',
        paramName: 'X-API-Key',
        value: ` ${v} `,
      },
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({
      name: 'Shop API',
      origin: API,
      pathPrefix: '/v1/',
      placement: 'header',
      paramName: 'X-API-Key',
      lastUsedAt: null,
    });
    const id = created.json.id;
    expect(Object.keys(created.json).sort()).toEqual(
      [
        'createdAt',
        'id',
        'lastUsedAt',
        'name',
        'origin',
        'paramName',
        'pathPrefix',
        'placement',
        'updatedAt',
      ].sort(),
    );

    const dash = await env.dashboard(cookie);
    expect((await env.ops(dash, cookie, [addDataset(http('orders', '/v1/orders', [id]))])).status).toBe(200);
    const list = await env.call('/api/secrets', { cookie });
    expect(list.json).toMatchObject({ mode: 'users', canUseSecrets: true });
    expect(list.json.secrets).toHaveLength(1);
    expect(list.json.secrets[0]).toMatchObject({
      id,
      sentAs: 'Header X-API-Key',
      usedBy: [{ dashboardId: dash, datasetId: 'orders', datasetName: 'orders' }],
    });

    const renamed = await env.call(`/api/secrets/${id}`, { method: 'PATCH', body: { name: 'Shop' }, cookie });
    expect(renamed.json.name).toBe('Shop');
    const v2 = value();
    const replaced = await env.call(`/api/secrets/${id}/value`, {
      method: 'PUT',
      body: { value: v2 },
      cookie,
    });
    expect(replaced.status).toBe(200);
    expect(replaced.json.origin).toBe(API);
    // The binding cannot be changed: there is no field for it.
    const rebind = await env.call(`/api/secrets/${id}`, {
      method: 'PATCH',
      body: { name: 'Shop', sendTo: 'https://evil.example/' },
      cookie,
    });
    expect(rebind.status).toBe(400);

    // Another user sees and touches nothing.
    const other = await env.login('other-manager@example.com');
    expect((await env.call('/api/secrets', { cookie: other })).json.secrets).toEqual([]);
    expect((await env.call(`/api/secrets/${id}`, { method: 'DELETE', cookie: other })).status).toBe(404);
    expect(
      (await env.call(`/api/secrets/${id}/value`, { method: 'PUT', body: { value: value() }, cookie: other }))
        .status,
    ).toBe(404);

    expect((await env.call(`/api/secrets/${id}`, { method: 'DELETE', cookie })).status).toBe(200);
    expect((await env.call('/api/secrets', { cookie })).json.secrets).toEqual([]);
    for (const t of env.seen) {
      expect(t).not.toContain(v);
      expect(t).not.toContain(v2);
    }
  });

  it('validates input without repeating the value', async () => {
    const cookie = await env.login('validator@example.com');
    const v = value();
    const bad = async (over: Record<string, unknown>, message: RegExp) => {
      const res = await env.call('/api/secrets', {
        cookie,
        body: { name: 'X', sendTo: `${API}/`, placement: 'bearer', value: v, ...over },
      });
      expect(res.status, JSON.stringify(over)).toBe(400);
      expect(res.json.error).toMatch(message);
      expect(res.text).not.toContain(v);
    };
    await bad({ sendTo: 'http://api.example.com/' }, /https/);
    await bad({ sendTo: `${API}/v1/?key=1` }, /query/);
    await bad({ sendTo: 'https://u:p@api.example.com/' }, /user name/);
    await bad({ placement: 'header', paramName: 'Host' }, /cannot carry/);
    await bad({ placement: 'header' }, /header name/);
    await bad({ placement: 'query', paramName: 'a b' }, /Query parameter names/);
    await bad({ placement: 'bearer', paramName: 'X' }, /no parameter/);
    await bad({ value: `Bearer ${v}` }, /only the token/);
    await bad({ value: 'short' }, /at least 8/);
    await bad({ value: `${v}\n${v}` }, /control characters/);
    await bad({ name: '' }, /Names are/);
    await bad({ placement: 'cookie' }, /placement/);
    await bad({ extra: 1 }, /extra/);
    // A malformed body quotes its input in JSON.parse's message; it must not come back.
    const broken = await env.call('/api/secrets', { cookie, rawBody: `{"value": "${v}", oops}` });
    expect(broken.status).toBe(400);
    expect(broken.text).not.toContain(v);
  });

  it('refuses every bearer token for writes, and cross-site requests', async () => {
    const cookie = await env.login('tokens@example.com');
    const user = env.deps.users.upsert({ email: 'tokens@example.com', name: 'Tokens' });
    const existing = await env.secret(cookie);
    const pat = await env.pat(cookie);
    const oauth = env.deps.tokens.issueOAuth(
      user.id,
      'client',
      ['dashboards:read', 'dashboards:write'],
      `${BASE}/mcp`,
    );
    for (const token of [pat, oauth.accessToken]) {
      const headers = { authorization: `Bearer ${token}` };
      const body = { name: 'T', sendTo: `${API}/`, placement: 'bearer', value: value() };
      const attempts = [
        await env.call('/api/secrets', { body, headers }),
        await env.call(`/api/secrets/${existing.id}/value`, {
          method: 'PUT',
          body: { value: value() },
          headers,
        }),
        await env.call(`/api/secrets/${existing.id}`, { method: 'PATCH', body: { name: 'T' }, headers }),
        await env.call(`/api/secrets/${existing.id}`, { method: 'DELETE', headers }),
      ];
      for (const a of attempts) {
        expect(a.status).toBe(403);
        expect(a.json.error).toMatch(/web app/);
      }
      // Listing is fine: metadata only.
      expect((await env.call('/api/secrets', { headers })).json.secrets[0].id).toBe(existing.id);
    }
    const crossSite = await env.call('/api/secrets', {
      cookie,
      headers: { origin: 'https://evil.example' },
      body: { name: 'T', sendTo: `${API}/`, placement: 'bearer', value: value() },
    });
    expect(crossSite.status).toBe(403);
    expect(
      (
        await env.call(`/api/secrets/${existing.id}`, {
          method: 'DELETE',
          cookie,
          headers: { origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(403);
    expect((await env.call('/api/secrets', { cookie })).json.secrets).toHaveLength(1);
  });

  it('limits secrets per user', async () => {
    const cookie = await env.login('hoarder@example.com');
    for (let i = 0; i < 20; i++) await env.secret(cookie, { name: `S${i}` });
    const res = await env.call('/api/secrets', {
      cookie,
      body: { name: 'S20', sendTo: `${API}/`, placement: 'bearer', value: value() },
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/up to 20/);
  });

  it('shows the operator counts per user, never names or values', async () => {
    const admin = await env.login('admin@example.com');
    const res = await env.call('/api/admin/secrets', { cookie: admin });
    expect(res.status).toBe(200);
    expect(res.json.users.find((u: { email: string }) => u.email === 'hoarder@example.com').secrets).toBe(20);
    expect(res.text).not.toMatch(/"name"|S19/);
    expect(
      (await env.call('/api/admin/secrets', { cookie: await env.login('nobody@example.com') })).status,
    ).toBe(403);
  });
});

describe('fetching with secrets', () => {
  it('sends each placement to the bound address only, and redacts echoes', async () => {
    const cookie = await env.login('fetcher@example.com');
    const bearer = value('bearer');
    const header = value('header');
    // Digits only, so the upstream can also echo it as a JSON number.
    const query = `9${String(randomBytes(5).readUIntBE(0, 5)).padStart(13, '0')}`;
    const b = await env.secret(cookie, { value: bearer });
    const h = await env.secret(cookie, { placement: 'header', paramName: 'X-API-Key', value: header });
    const q = await env.secret(cookie, { placement: 'query', paramName: 'api_key', value: query });
    const dash = await env.dashboard(cookie);
    const res = await env.ops(dash, cookie, [
      addDataset(http('who', '/v1/whoami?city=Oslo%20Center&x=a+b', [b.id, h.id, q.id])),
    ]);
    expect(res.status, res.text).toBe(200);
    const mark = upstream.received.length;
    const result = await env.data(dash, 'who', cookie);
    expect(result.error).toBeUndefined();
    const sent = upstream.since(mark);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.host).toBe('api.example.com');
    expect(sent[0]!.headers.authorization).toBe(`Bearer ${bearer}`);
    expect(sent[0]!.headers['x-api-key']).toBe(header);
    // The document's own query keeps its exact encoding; the secret is appended.
    expect(sent[0]!.url).toBe(`/v1/whoami?city=Oslo%20Center&x=a+b&api_key=${query}`);
    const row = result.table.rows[0];
    expect(row.account).toMatch(/^acct-[0-9a-f]{8}$/);
    expect(row.echoAuth).toBe('Bearer [redacted]');
    expect(row.echoKey).toBe('[redacted]');
    expect(row.echoUrl).toBe('/v1/whoami?city=Oslo%20Center&x=a+b&api_key=[redacted]');
    expect(row.numeric).toBe('[redacted]');
    const json = JSON.stringify(result);
    for (const v of [bearer, header, query]) expect(json).not.toContain(v);
    expect(Object.keys(row).some((k) => k.startsWith('key:') && k.includes('[redacted]'))).toBe(true);
    // The document holds ids only.
    const doc = await env.call(`/api/dashboards/${dash}`, { cookie });
    expect(doc.json.doc.datasets[0].source.secrets).toEqual([b.id, h.id, q.id]);
    expect(
      env.deps.secrets.info(env.deps.users.upsert({ email: 'fetcher@example.com', name: 'F' }).id, b.id)!
        .lastUsedAt,
    ).toBeTruthy();
  });

  it('follows redirects that stay inside the binding and stops at any other', async () => {
    const cookie = await env.login('redirects@example.com');
    const v = value();
    const s = await env.secret(cookie, { value: v });
    const dash = await env.dashboard(cookie);
    await env.ops(dash, cookie, [
      addDataset(http('same', '/v1/redirect-same', [s.id])),
      addDataset(http('other', '/v1/redirect-other', [s.id])),
      addDataset(http('outside', '/v1/redirect-outside', [s.id])),
      addDataset(http('echo', '/v1/redirect-echo', [s.id])),
    ]);
    let mark = upstream.received.length;
    const same = await env.data(dash, 'same', cookie);
    expect(same.error).toBeUndefined();
    expect(same.table.rows).toHaveLength(2);
    expect(upstream.since(mark).map((r) => [r.url, r.headers.authorization])).toEqual([
      ['/v1/redirect-same', `Bearer ${v}`],
      ['/v1/orders', `Bearer ${v}`],
    ]);
    for (const id of ['other', 'outside', 'echo']) {
      mark = upstream.received.length;
      const r = await env.data(dash, id, cookie);
      expect(r.error).toBe(
        `The API redirected to another address. Credentials are only sent to ${API}/v1/, so the request was stopped.`,
      );
      // The second host received nothing at all, not even an anonymous request.
      expect(upstream.since(mark).map((x) => x.host)).toEqual(['api.example.com']);
      expect(JSON.stringify(r)).not.toContain(v);
    }
  });

  it('keeps upstream bodies out of errors and resolves nothing it should not', async () => {
    const cookie = await env.login('errors@example.com');
    const v = value();
    const s = await env.secret(cookie, { value: v });
    const dash = await env.dashboard(cookie);
    await env.ops(dash, cookie, [
      addDataset(http('unauth', '/v1/unauthorized', [s.id])),
      addDataset(http('invalid', '/v1/invalid', [s.id])),
      addDataset(http('big', '/v1/big', [s.id])),
      addDataset(http('slow', '/v1/slow', [s.id])),
    ]);
    expect((await env.data(dash, 'unauth', cookie)).error).toBe('Upstream responded 401');
    expect((await env.data(dash, 'invalid', cookie)).error).toBe('Response is not valid JSON');
    expect((await env.data(dash, 'big', cookie)).error).toBe('Response larger than 5 MB');
    expect((await env.data(dash, 'slow', cookie)).error).toBe('Request timed out');
  });
});

describe('who can use which secret', () => {
  it("resolves against the dashboard's owner only", async () => {
    const alice = await env.login('alice-owner@example.com');
    const mallory = await env.login('mallory@example.com');
    const secret = await env.secret(alice);
    const own = await env.dashboard(mallory);
    // Mallory saw the id in one of Alice's public documents. Saving it is refused...
    const refused = await env.ops(own, mallory, [addDataset(http('steal', '/v1/orders', [secret.id]))]);
    expect(refused.status).toBe(400);
    expect(refused.json.error).toMatch(/no secret "sec_/);
    // ...and a document that holds it anyway (written by hand) resolves to nothing.
    const meta = (await env.deps.store.readMeta(own))!;
    const doc = (await env.deps.store.readDoc(own))!;
    await env.deps.store.writeDoc(
      { ...meta, version: meta.version + 1 },
      { ...doc, datasets: [http('steal', '/v1/orders', [secret.id]) as never] },
      { kind: 'user', label: 'hand' },
      ['by hand'],
    );
    const mark = upstream.received.length;
    expect((await env.data(own, 'steal', mallory)).error).toBe(
      'Credentials for this source are not available.',
    );
    // Never fetched without the credential either.
    expect(upstream.since(mark)).toEqual([]);
  });

  it('checks binding and conflicts at save, and the binding again at use', async () => {
    const cookie = await env.login('binder@example.com');
    const a = await env.secret(cookie, { name: 'Shop API' });
    const b = await env.secret(cookie, { name: 'Other bearer' });
    const dash = await env.dashboard(cookie);
    const wrongHost = await env.ops(dash, cookie, [
      addDataset({
        ...http('x', '/v1/orders', [a.id]),
        source: { kind: 'http', url: 'https://other.example.com/v1/orders', secrets: [a.id] },
      }),
    ]);
    expect(wrongHost.status).toBe(400);
    expect(wrongHost.json.error).toBe(
      `Dataset "x": Secret "Shop API" is only sent to ${API}/v1/. Use a URL under that address or pick another secret.`,
    );
    expect((await env.ops(dash, cookie, [addDataset(http('x', '/v2/orders', [a.id]))])).status).toBe(400);
    expect(
      (await env.ops(dash, cookie, [addDataset(http('x', '/v1/..%2fadmin', [a.id]))])).json.error,
    ).toMatch(/encoded/);
    const conflict = await env.ops(dash, cookie, [addDataset(http('x', '/v1/orders', [a.id, b.id]))]);
    expect(conflict.json.error).toMatch(/would both set Authorization: Bearer/);
    const q = await env.secret(cookie, { placement: 'query', paramName: 'api_key' });
    expect(
      (await env.ops(dash, cookie, [addDataset(http('x', '/v1/orders?api_key=mine', [q.id]))])).json.error,
    ).toMatch(/already has a "api_key"/);
    // Also for full-document saves and dry runs.
    const current = (await env.call(`/api/dashboards/${dash}`, { cookie })).json;
    const put = await env.call(`/api/dashboards/${dash}`, {
      method: 'PUT',
      cookie,
      body: {
        doc: { ...current.doc, datasets: [http('x', '/v2/x', [a.id])] },
        baseVersion: current.meta.version,
      },
    });
    expect(put.status).toBe(400);
    expect(
      (await env.ops(dash, cookie, [addDataset(http('x', '/v2/x', [a.id]))], { dryRun: true })).status,
    ).toBe(400);
    // At use time, a preview of a URL outside the binding is refused with the generic message and nothing is sent.
    const mark = upstream.received.length;
    const preview = await env.call(`/api/dashboards/${dash}/preview`, {
      cookie,
      body: { dataset: { source: { kind: 'http', url: `${API}/admin/orders`, secrets: [a.id] } } },
    });
    expect(preview.json.result.error).toBe('Credentials for this source are bound to another address.');
    expect(upstream.since(mark)).toEqual([]);
  });

  it('never lets an anonymous dashboard hold a reference, so claiming is safe', async () => {
    const victim = await env.login('victim-claim@example.com');
    const secret = await env.secret(victim);
    const { envelope, editKey } = (await env.call('/api/dashboards', { body: {} })).json;
    const id = envelope.meta.id;
    const headers = { 'x-edit-key': editKey };
    // An attacker prepares the anonymous dashboard with the victim's id on a revealing path...
    const prepared = await env.call(`/api/dashboards/${id}/ops`, {
      body: { ops: [addDataset(http('loot', '/v1/orders', [secret.id]))] },
      headers,
    });
    expect(prepared.status).toBe(400);
    expect(prepared.json.error).toBe('Sign in and claim this dashboard to use secrets.');
    const put = await env.call(`/api/dashboards/${id}`, {
      method: 'PUT',
      headers,
      body: { doc: { ...envelope.doc, datasets: [http('loot', '/v1/orders', [secret.id])] }, baseVersion: 1 },
    });
    expect(put.status).toBe(400);
    // ...so no version holds it, and the claim brings nothing along.
    const claimed = await env.call(`/api/dashboards/${id}/claim`, { body: {}, cookie: victim, headers });
    expect(claimed.status).toBe(200);
    expect(claimed.json.doc.datasets).toEqual([]);
    for (const v of (await env.call(`/api/dashboards/${id}/versions`, { cookie: victim })).json) {
      const stored = await env.deps.store.readVersion(id, v.version);
      expect(JSON.stringify(stored)).not.toContain('sec_');
    }
    // Previewing with secrets on an anonymous dashboard never resolves them.
    const anon = (await env.call('/api/dashboards', { body: {} })).json;
    const preview = await env.call(`/api/dashboards/${anon.envelope.meta.id}/preview`, {
      headers: { 'x-edit-key': anon.editKey },
      body: { dataset: { source: { kind: 'http', url: `${API}/v1/orders`, secrets: [secret.id] } } },
    });
    expect(preview.json.result.error).toBe('Credentials for this source are not available.');
  });

  it('keeps references for the owner’s copy and strips them from anyone else’s', async () => {
    const owner = await env.login('dup-owner@example.com');
    const s = await env.secret(owner);
    const dash = await env.dashboard(owner);
    await env.ops(dash, owner, [addDataset(http('orders', '/v1/orders', [s.id]))]);
    await env.call(`/api/dashboards/${dash}/settings`, {
      method: 'PATCH',
      body: { visibility: 'public', confirmPublicSecrets: true },
      cookie: owner,
    });
    const mine = await env.call(`/api/dashboards/${dash}/duplicate`, { body: {}, cookie: owner });
    expect(mine.json.envelope.meta.visibility).toBe('private');
    expect(mine.json.envelope.doc.datasets[0].source.secrets).toEqual([s.id]);
    expect((await env.data(mine.json.envelope.meta.id, 'orders', owner)).error).toBeUndefined();

    const stranger = await env.login('dup-stranger@example.com');
    for (const cookie of [stranger, undefined]) {
      const copy = await env.call(`/api/dashboards/${dash}/duplicate`, {
        body: {},
        ...(cookie ? { cookie } : {}),
      });
      expect(copy.status).toBe(201);
      const copied = copy.json.envelope;
      expect(copied.doc.datasets[0].source).toEqual({ kind: 'http', url: `${API}/v1/orders` });
      const versions = (
        await env.call(`/api/dashboards/${copied.meta.id}/versions`, cookie ? { cookie } : {})
      ).json;
      expect(versions[0].changes).toContain('Removed secret references (secrets belong to their owner)');
      // The copy loads without credentials: the upstream sees an anonymous request.
      const r = await env.data(copied.meta.id, 'orders', cookie);
      expect(r.table.rows[0].account).toBe('anonymous');
    }
  });

  it('lets tokens work on private dashboards but not publish data fetched with secrets', async () => {
    const cookie = await env.login('publisher@example.com');
    const pat = await env.pat(cookie);
    const auth = { authorization: `Bearer ${pat}` };
    const s = await env.secret(cookie, { name: 'Stats key' });
    const s2 = await env.secret(cookie, { placement: 'header', paramName: 'X-API-Key', name: 'Second' });
    const dash = await env.dashboard(cookie);
    // Private: agents can do everything.
    const added = await env.call(`/api/dashboards/${dash}/ops`, {
      body: { ops: [addDataset(http('orders', '/v1/orders', [s.id]))] },
      headers: auth,
    });
    expect(added.status).toBe(200);

    // Tokens cannot make it public, with or without the confirmation flag.
    for (const confirmPublicSecrets of [undefined, true]) {
      const res = await env.call(`/api/dashboards/${dash}/settings`, {
        method: 'PATCH',
        body: { visibility: 'public', confirmPublicSecrets },
        headers: auth,
      });
      expect(res.status).toBe(403);
      expect(res.json.error).toMatch(/Make it public in the web app/);
    }
    // The web app must confirm first; the answer names the secrets for the dialog.
    const ask = await env.call(`/api/dashboards/${dash}/settings`, {
      method: 'PATCH',
      body: { visibility: 'public' },
      cookie,
    });
    expect(ask.status).toBe(428);
    expect(ask.json).toMatchObject({
      code: 'confirm_public_secrets',
      secrets: [{ id: s.id, name: 'Stats key' }],
    });
    expect(ask.json.error).toContain('"Stats key"');
    const published = await env.call(`/api/dashboards/${dash}/settings`, {
      method: 'PATCH',
      body: { visibility: 'public', confirmPublicSecrets: true },
      cookie,
    });
    expect(published.json.meta.visibility).toBe('public');

    // Public: tokens cannot add or re-point secrets...
    const viaToken = (ops: unknown[]) =>
      env.call(`/api/dashboards/${dash}/ops`, { body: { ops, confirmPublicSecrets: true }, headers: auth });
    for (const ops of [
      [addDataset(http('more', '/v1/orders', [s2.id]))],
      [
        {
          op: 'updateDataset',
          id: 'orders',
          set: { source: { kind: 'http', url: `${API}/v1/whoami`, secrets: [s.id] } },
        },
      ],
      [
        {
          op: 'updateDataset',
          id: 'orders',
          set: { source: { kind: 'http', url: `${API}/v1/orders`, secrets: [s.id, s2.id] } },
        },
      ],
    ]) {
      const res = await viaToken(ops);
      expect(res.status).toBe(403);
      expect(res.json.error).toMatch(/Agents cannot point secrets at new URLs on a public dashboard/);
    }
    // ...but other edits, a new JSON path and removing a secret are fine.
    expect((await viaToken([{ op: 'setMeta', title: 'Renamed by agent' }])).status).toBe(200);
    expect(
      (
        await viaToken([
          {
            op: 'updateDataset',
            id: 'orders',
            set: { source: { kind: 'http', url: `${API}/v1/orders`, path: 'items', secrets: [s.id] } },
          },
        ])
      ).status,
    ).toBe(200);
    // The web app is asked to confirm, then may.
    const change = [addDataset(http('more', '/v1/orders', [s2.id]))];
    const confirm = await env.ops(dash, cookie, change);
    expect(confirm.status).toBe(428);
    expect(confirm.json.secrets).toEqual([{ id: s2.id, name: 'Second' }]);
    expect((await env.ops(dash, cookie, change, { confirmPublicSecrets: true })).status).toBe(200);
    // Unchanged references never ask again (autosave of unrelated edits).
    expect((await env.ops(dash, cookie, [{ op: 'setMeta', title: 'Again' }])).status).toBe(200);
    expect(
      (
        await viaToken([
          { op: 'updateDataset', id: 'more', set: { source: { kind: 'http', url: `${API}/v1/orders` } } },
        ])
      ).status,
    ).toBe(200);

    // Private again: tokens may add secrets.
    await env.call(`/api/dashboards/${dash}/settings`, {
      method: 'PATCH',
      body: { visibility: 'private' },
      headers: auth,
    });
    expect((await viaToken([addDataset(http('third', '/v1/orders', [s2.id]))])).status).toBe(200);
  });

  it('restores versions with deleted secrets, but not past the public rules', async () => {
    const cookie = await env.login('restorer@example.com');
    const pat = await env.pat(cookie);
    const s = await env.secret(cookie);
    const dash = await env.dashboard(cookie);
    await env.ops(dash, cookie, [addDataset(http('orders', '/v1/orders', [s.id]))]); // v2
    await env.ops(dash, cookie, [{ op: 'removeDataset', id: 'orders' }]); // v3
    await env.call(`/api/secrets/${s.id}`, { method: 'DELETE', cookie });
    const restored = await env.call(`/api/dashboards/${dash}/versions/2/restore`, { body: {}, cookie });
    expect(restored.status).toBe(200);
    expect((await env.data(dash, 'orders', cookie)).error).toBe(
      'Credentials for this source are not available.',
    );
    // Deleting a secret never blocks unrelated edits.
    expect((await env.ops(dash, cookie, [{ op: 'setMeta', title: 'Still editable' }])).status).toBe(200);

    // On a public dashboard a token cannot restore a version that brings references back.
    await env.ops(dash, cookie, [{ op: 'removeDataset', id: 'orders' }]);
    await env.call(`/api/dashboards/${dash}/settings`, {
      method: 'PATCH',
      body: { visibility: 'public' },
      cookie,
    });
    const versions = (await env.call(`/api/dashboards/${dash}/versions`, { cookie })).json;
    expect(versions[0].version).toBeGreaterThan(4);
    const byToken = await env.call(`/api/dashboards/${dash}/versions/2/restore`, {
      body: {},
      headers: { authorization: `Bearer ${pat}` },
    });
    expect(byToken.status).toBe(403);
    expect((await env.call(`/api/dashboards/${dash}/versions/2/restore`, { body: {}, cookie })).status).toBe(
      428,
    );
    expect(
      (
        await env.call(`/api/dashboards/${dash}/versions/2/restore`, {
          body: { confirmPublicSecrets: true },
          cookie,
        })
      ).status,
    ).toBe(200);
  });

  it('applies the instance switch at use time and always allows cleaning up', async () => {
    const cookie = await env.login('switch@example.com');
    const s = await env.secret(cookie);
    const dash = await env.dashboard(cookie);
    await env.ops(dash, cookie, [addDataset(http('orders', '/v1/orders', [s.id]))]);
    expect((await env.data(dash, 'orders', cookie)).error).toBeUndefined();

    // The same data directory, restarted with SECRETS=off and no key.
    const off = await new Env(env.dir).start({ SECRETS: 'off' });
    try {
      const offCookie = await off.login('switch@example.com');
      const mark = upstream.received.length;
      expect((await off.data(dash, 'orders', offCookie)).error).toBe(
        'Credentials are turned off on this server.',
      );
      expect(upstream.since(mark)).toEqual([]);
      expect((await off.call('/api/me', { cookie: offCookie })).json).toMatchObject({
        secrets: 'off',
        canUseSecrets: false,
      });
      const listed = await off.call('/api/secrets', { cookie: offCookie });
      expect(listed.json.secrets.map((x: SecretInfo) => x.id)).toEqual([s.id]);
      const create = await off.call('/api/secrets', {
        cookie: offCookie,
        body: { name: 'New', sendTo: `${API}/`, placement: 'bearer', value: value() },
      });
      expect(create.status).toBe(403);
      expect(create.json.error).toBe('Secrets are turned off on this server.');
      expect(
        (
          await off.call(`/api/secrets/${s.id}/value`, {
            method: 'PUT',
            body: { value: value() },
            cookie: offCookie,
          })
        ).status,
      ).toBe(403);
      const add = await off.ops(dash, offCookie, [addDataset(http('more', '/v1/orders', [s.id]))]);
      expect(add.status).toBe(400);
      // Unrelated edits still save.
      expect((await off.ops(dash, offCookie, [{ op: 'setMeta', title: 'Off' }])).status).toBe(200);
      expect((await off.call(`/api/secrets/${s.id}`, { method: 'DELETE', cookie: offCookie })).status).toBe(
        200,
      );
    } finally {
      await off.close(false);
    }
  });

  it('lets only administrators use secrets in admins mode', async () => {
    const admins = await new Env().start({ SECRETS: 'admins', SECRETS_KEY: key() });
    try {
      const user = await admins.login('regular@example.com');
      expect((await admins.call('/api/me', { cookie: user })).json).toMatchObject({
        secrets: 'admins',
        canUseSecrets: false,
      });
      const res = await admins.call('/api/secrets', {
        cookie: user,
        body: { name: 'X', sendTo: `${API}/`, placement: 'bearer', value: value() },
      });
      expect(res.status).toBe(403);
      expect(res.json.error).toMatch(/only lets administrators/);
      const admin = await admins.login('admin@example.com');
      expect((await admins.call('/api/me', { cookie: admin })).json.canUseSecrets).toBe(true);
      const s = await admins.secret(admin);
      const dash = await admins.dashboard(admin);
      expect((await admins.ops(dash, admin, [addDataset(http('orders', '/v1/orders', [s.id]))])).status).toBe(
        200,
      );
      expect((await admins.data(dash, 'orders', admin)).error).toBeUndefined();
    } finally {
      await admins.close();
    }
  });
});

describe('caches never cross credentials', () => {
  const resolve = (ownerId: string | null, dashboardId: string, dataset: unknown) =>
    env.deps.data.resolve({ id: dashboardId, ownerId }, dataset as never) as Promise<any>;
  const ds = (path: string, secrets?: string[], extra: Record<string, unknown> = {}) => ({
    ...http('d', path, secrets),
    transforms: [],
    refreshSec: 0,
    accumulate: 0,
    ...extra,
  });

  it('separates public requests, users and revisions', async () => {
    const aliceCookie = await env.login('cache-alice@example.com');
    const bobCookie = await env.login('cache-bob@example.com');
    const alice = env.deps.users.upsert({ email: 'cache-alice@example.com', name: 'A' });
    const bob = env.deps.users.upsert({ email: 'cache-bob@example.com', name: 'B' });
    const a = await env.secret(aliceCookie);
    const b = await env.secret(bobCookie);
    const account = async (ownerId: string | null, secrets?: string[]) =>
      (await resolve(ownerId, 'cachetest01', ds('/v1/orders?cache=1', secrets))).table.rows[0].account;

    const anonymous = await account(null);
    const aliceAccount = await account(alice.id, [a.id]);
    const bobAccount = await account(bob.id, [b.id]);
    expect(anonymous).toBe('anonymous');
    expect(aliceAccount).not.toBe('anonymous');
    expect(bobAccount).not.toBe(aliceAccount);
    // Within the TTL each still gets its own cached answer.
    const mark = upstream.received.length;
    expect(await account(null)).toBe('anonymous');
    expect(await account(alice.id, [a.id])).toBe(aliceAccount);
    expect(upstream.since(mark)).toEqual([]);
    // Replacing a value invalidates at once.
    await env.call(`/api/secrets/${a.id}/value`, {
      method: 'PUT',
      body: { value: value() },
      cookie: aliceCookie,
    });
    const after = await account(alice.id, [a.id]);
    expect(after).not.toBe(aliceAccount);
    expect(upstream.since(mark)).toHaveLength(1);
  });

  it('restarts accumulated history when a value is replaced', async () => {
    const cookie = await env.login('cache-acc@example.com');
    const owner = env.deps.users.upsert({ email: 'cache-acc@example.com', name: 'C' });
    const s = await env.secret(cookie);
    const dataset = ds('/v1/counter', [s.id], { id: 'acc', accumulate: 10 });
    const first = await resolve(owner.id, 'acctest0001', dataset);
    expect(first.table.rows).toHaveLength(1);
    await env.call(`/api/secrets/${s.id}/value`, { method: 'PUT', body: { value: value() }, cookie });
    const second = await resolve(owner.id, 'acctest0001', dataset);
    expect(second.table.rows).toHaveLength(1);
    expect(second.table.rows[0].n).toBeGreaterThan(first.table.rows[0].n);
    expect(second.table.rows[0].account).not.toBe(first.table.rows[0].account);
  });

  it('de-duplicates concurrent requests with the same credentials only', async () => {
    const cookie = await env.login('cache-flight@example.com');
    const owner = env.deps.users.upsert({ email: 'cache-flight@example.com', name: 'D' });
    const s = await env.secret(cookie);
    const mark = upstream.received.length;
    const results = await Promise.all([
      resolve(owner.id, 'flight00001', ds('/v1/counter?flight=1', [s.id])),
      resolve(owner.id, 'flight00002', ds('/v1/counter?flight=1', [s.id])),
      resolve(null, 'flight00003', ds('/v1/counter?flight=1')),
    ]);
    expect(upstream.since(mark)).toHaveLength(2);
    expect(results[0]!.table.rows[0].n).toBe(results[1]!.table.rows[0].n);
    expect(results[2]!.table.rows[0].account).toBe('anonymous');
  });
});

describe('secrets over MCP', () => {
  it('lists secrets, uses them on private dashboards and warns about keys in URLs', async () => {
    const cookie = await env.login('mcp-secrets@example.com');
    const s = await env.secret(cookie, { name: 'Shop', placement: 'query', paramName: 'api_key' });
    const client = await env.mcp(await env.pat(cookie));
    const listed = JSON.parse(text(await client.callTool({ name: 'list_secrets', arguments: {} })));
    expect(listed.secrets).toEqual([
      {
        id: s.id,
        name: 'Shop',
        origin: API,
        pathPrefix: '/v1/',
        sentAs: 'Query parameter api_key',
        updatedAt: s.updatedAt,
        lastUsedAt: null,
      },
    ]);
    expect(listed.note).toBe(
      `Values are never readable. To add one, ask the user to open ${BASE}/settings#secrets.`,
    );

    const ref = text(await client.callTool({ name: 'get_reference', arguments: {} }));
    expect(ref).toContain('## Secrets (http sources)');
    expect(ref).toContain(`${BASE}/settings#secrets`);

    const id = JSON.parse(
      text(await client.callTool({ name: 'create_dashboard', arguments: { title: 'Shop' } })),
    ).dashboardId;
    const operations = [
      addDataset(http('orders', '/v1/orders', [s.id])),
      addDataset({
        ...http('leaky', '/v1/orders'),
        source: { kind: 'http', url: `${API}/v1/orders?token=abc` },
      }),
    ];
    // The advertised schema accepts what the server accepts.
    const { tools } = await client.listTools();
    const advertised = fromJsonSchema(
      tools.find((t) => t.name === 'apply_operations')!.inputSchema as JsonSchemaType,
    );
    expect((await advertised['~standard'].validate({ dashboardId: id, operations })).issues).toBeUndefined();
    expect(
      (
        await advertised['~standard'].validate({
          dashboardId: id,
          operations: [addDataset(http('o', '/v1/o', ['nope']))],
        })
      ).issues,
    ).toBeDefined();
    const applied = JSON.parse(
      text(await client.callTool({ name: 'apply_operations', arguments: { dashboardId: id, operations } })),
    );
    expect(applied.dataChecks.find((d: { datasetId: string }) => d.datasetId === 'orders')).toMatchObject({
      rows: 2,
    });
    expect(applied.warnings).toEqual([expect.stringContaining('"token"')]);

    // Without a dashboard, a preview uses the caller's own secrets.
    const preview = await client.callTool({
      name: 'preview_data',
      arguments: { source: { kind: 'http', url: `${API}/v1/orders`, secrets: [s.id] } },
    });
    expect(preview.isError).toBeFalsy();
    expect(JSON.parse(text(preview)).rowCount).toBe(2);

    // Someone else's public dashboard: no preview with secrets, and their ids resolve to nothing for us.
    const other = await env.login('mcp-other@example.com');
    const theirs = await env.secret(other);
    const theirDash = await env.dashboard(other, 'public');
    const denied = await client.callTool({
      name: 'preview_data',
      arguments: {
        dashboardId: theirDash,
        source: { kind: 'http', url: `${API}/v1/orders`, secrets: [theirs.id] },
      },
    });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toMatch(/Only editors/);
    const notMine = await client.callTool({
      name: 'preview_data',
      arguments: { source: { kind: 'http', url: `${API}/v1/orders`, secrets: [theirs.id] } },
    });
    expect(text(notMine)).toBe('Credentials for this source are not available.');

    // set_visibility through MCP is a token too.
    const pub = await client.callTool({
      name: 'set_visibility',
      arguments: { dashboardId: id, visibility: 'public' },
    });
    expect(pub.isError).toBe(true);
    expect(text(pub)).toMatch(/Make it public in the web app/);
    // Agents cannot write secrets: there is no such tool.
    expect(tools.map((t) => t.name).filter((n) => n.includes('secret'))).toEqual(['list_secrets']);
  });
});

// ---------------------------------------------------------------------------------------------------------------

/** Files under a directory, read as bytes so binary SQLite pages are searched too. */
function filesUnder(dir: string): { path: string; content: string }[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesUnder(path);
    return [{ path, content: readFileSync(path).toString('latin1') }];
  });
}

describe('canary', () => {
  it('never shows a secret value in any response, error, log line, version or dashboard folder', async () => {
    const canaries = {
      bearer: `cnryB${randomBytes(16).toString('hex')}`,
      header: `cnryH${randomBytes(16).toString('hex')}`,
      query: `cnryQ${randomBytes(16).toString('hex')}`,
    };
    const values = Object.values(canaries);
    const firstKey = key();
    const logs: string[] = [];
    const capture = (...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 8 }))).join(' '));
    };
    const spies = [
      ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation(capture),
      ),
      vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
        logs.push(String(chunk));
        return true;
      }) as never),
      vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
        logs.push(String(chunk));
        return true;
      }) as never),
    ];
    const envs: Env[] = [];
    const dirs: string[] = [];
    const markUpstream = upstream.received.length;
    try {
      const c = await new Env().start({ SECRETS: 'users', SECRETS_KEY: firstKey });
      envs.push(c);
      dirs.push(c.dir);
      const owner = await c.login('canary-owner@example.com');
      const stranger = await c.login('canary-stranger@example.com');
      const admin = await c.login('admin@example.com');

      // Management, including the failure paths that see the value.
      const bearer = await c.secret(owner, { name: 'Bearer', value: canaries.bearer });
      const header = await c.secret(owner, {
        name: 'Header',
        placement: 'header',
        paramName: 'X-API-Key',
        value: canaries.header,
      });
      const query = await c.secret(owner, {
        name: 'Query',
        placement: 'query',
        paramName: 'api_key',
        value: canaries.query,
      });
      await c.call(`/api/secrets/${bearer.id}/value`, {
        method: 'PUT',
        body: { value: canaries.bearer },
        cookie: owner,
      });
      await c.call(`/api/secrets/${bearer.id}`, {
        method: 'PATCH',
        body: { name: 'Bearer token' },
        cookie: owner,
      });
      await c.call('/api/secrets', { cookie: owner, rawBody: `{"name":"x","value":"${canaries.bearer}",}` });
      await c.call('/api/secrets', {
        cookie: owner,
        body: { name: 'Dup', sendTo: 'ftp://x', placement: 'bearer', value: canaries.bearer },
      });
      await c.call('/api/secrets', {
        cookie: owner,
        body: { name: 'Bearer token', sendTo: `${API}/`, placement: 'bearer', value: canaries.bearer },
      });
      await c.call(`/api/secrets/${bearer.id}/value`, {
        method: 'PUT',
        body: { value: `Bearer ${canaries.bearer}` },
        cookie: owner,
      });
      const pat = await c.pat(owner);
      await c.call('/api/secrets', {
        headers: { authorization: `Bearer ${pat}` },
        body: { name: 'T', sendTo: `${API}/`, placement: 'bearer', value: canaries.bearer },
      });
      await c.call('/api/secrets', { cookie: owner });
      await c.call('/api/secrets', { headers: { authorization: `Bearer ${pat}` } });
      await c.call('/api/me', { cookie: owner });
      await c.call('/api/admin/secrets', { cookie: admin });

      // A dashboard using all three, live, plus every failure path.
      const all = [bearer.id, header.id, query.id];
      const dash = await c.dashboard(owner);
      const datasets = [
        http('who', '/v1/whoami', all, { refreshSec: 1 }),
        http('orders', '/v1/orders', [bearer.id, header.id], { accumulate: 5 }),
        http('same', '/v1/redirect-same', all),
        http('other', '/v1/redirect-other', all),
        http('echo', '/v1/redirect-echo', all),
        http('outside', '/v1/redirect-outside', all),
        http('unauth', '/v1/unauthorized', all),
        http('invalid', '/v1/invalid', all),
        http('big', '/v1/big', all),
        http('slow', '/v1/slow', all),
        http('gone', '/v1/orders?gone=1', [header.id]),
        http('bq', '/v1/whoami?bq=1', [bearer.id, query.id]),
      ];
      expect((await c.ops(dash, owner, datasets.map(addDataset))).status).toBe(200);
      await c.ops(dash, owner, [
        { op: 'addWidget', widget: { id: 'who-table', type: 'table', datasetId: 'who', config: {} } },
        {
          op: 'addWidget',
          widget: {
            id: 'orders-kpi',
            type: 'kpi',
            datasetId: 'orders',
            config: { field: 'total', agg: 'sum' },
          },
        },
        { op: 'addWidget', widget: { id: 'unauth-table', type: 'table', datasetId: 'unauth', config: {} } },
      ]);
      for (const d of datasets) {
        await c.call(`/api/dashboards/${dash}/data/${d.id}`, { cookie: owner });
        await c.call(`/api/dashboards/${dash}/suggest/${d.id}`, { cookie: owner });
      }
      await c.call(`/api/dashboards/${dash}/preview`, {
        cookie: owner,
        body: { dataset: { source: datasets[0]!.source } },
      });
      await c.call(`/api/dashboards/${dash}/preview`, {
        cookie: owner,
        body: { dataset: { source: { kind: 'http', url: 'https://other.example.com/v1/x', secrets: all } } },
      });
      await c.call(`/api/dashboards/${dash}/preview`, {
        cookie: owner,
        body: { dataset: { source: { kind: 'http', url: 'https://127.0.0.1/v1/x', secrets: all } } },
      });
      // Bad host at save time, with the address in the message.
      await c.ops(dash, owner, [
        addDataset({
          ...http('bad', '/x'),
          source: { kind: 'http', url: 'https://other.example.com/v1/', secrets: all },
        }),
      ]);
      await c.call(`/api/dashboards/${dash}/snapshot.png`, { cookie: owner });
      await c.call(`/api/dashboards/${dash}/snapshot.png?widget=who-table&theme=dark`, { cookie: owner });
      await c.call(`/api/dashboards/${dash}`, { cookie: owner });
      await c.call(`/api/dashboards/${dash}/versions`, { cookie: owner });
      await c.call('/api/dashboards', { cookie: owner });
      await c.call('/api/admin/dashboards', { cookie: admin });
      await c.call(`/api/dashboards/${dash}`, { cookie: admin });
      await c.call(`/api/dashboards/${dash}/data/who`, { cookie: admin });
      await c.call(`/api/dashboards/${dash}/settings`, {
        method: 'PATCH',
        body: { visibility: 'public' },
        cookie: owner,
      });
      await c.call(`/api/dashboards/${dash}/settings`, {
        method: 'PATCH',
        body: { visibility: 'public', confirmPublicSecrets: true },
        cookie: owner,
      });
      await c.call(`/api/dashboards/${dash}/data/who`);
      await c.call(`/api/dashboards/${dash}/snapshot.png`);
      await c.call(`/api/dashboards/${dash}/duplicate`, { body: {}, cookie: owner });
      await c.call(`/api/dashboards/${dash}/duplicate`, { body: {}, cookie: stranger });
      await c.call(`/api/dashboards/${dash}/duplicate`, { body: {} });
      await c.call(`/api/dashboards/${dash}/versions/2/restore`, {
        body: { confirmPublicSecrets: true },
        cookie: owner,
      });

      // The live stream of the public dashboard, as an anonymous viewer.
      const stream = await c.app.request(`${BASE}/api/dashboards/${dash}/events`);
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let events = '';
      const until = Date.now() + 4000;
      while (Date.now() < until && !events.includes('"type":"data"')) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>((r) =>
            setTimeout(() => r({ done: true, value: undefined }), 1500),
          ),
        ]);
        if (chunk.value) events += decoder.decode(chunk.value);
      }
      await reader.cancel();
      expect(events).toContain('"type":"data"');
      c.seen.push(events);

      // Every MCP tool, through a PAT.
      const client = await c.mcp(pat);
      const call = (name: string, args: Record<string, unknown> = {}) =>
        client.callTool({ name, arguments: args });
      await call('get_reference');
      await call('list_connectors');
      await call('list_secrets');
      await call('list_dashboards');
      await call('get_dashboard', { dashboardId: dash });
      const created = JSON.parse(text(await call('create_dashboard', { title: 'Agent canary' }))).dashboardId;
      await call('apply_operations', {
        dashboardId: created,
        operations: datasets.map(addDataset),
        dryRun: true,
      });
      await call('apply_operations', { dashboardId: created, operations: datasets.map(addDataset) });
      await call('apply_operations', {
        dashboardId: created,
        operations: [{ op: 'addWidget', widget: { id: 'w', type: 'table', datasetId: 'who', config: {} } }],
      });
      for (const d of datasets) {
        await call('get_data', { dashboardId: created, datasetId: d.id });
        await call('suggest_widgets', { dashboardId: created, datasetId: d.id });
      }
      await call('preview_data', { source: datasets[0]!.source });
      await call('preview_data', { dashboardId: created, source: datasets[6]!.source });
      await call('preview_data', { source: { kind: 'http', url: `${API}/admin/orders`, secrets: all } });
      await call('upload_data', {
        dashboardId: created,
        name: 'x.csv',
        format: 'csv',
        content: 'a,b\n1,2\n',
      });
      await call('render_snapshot', { dashboardId: created });
      await call('render_snapshot', { dashboardId: created, widgetId: 'w' });
      await call('list_versions', { dashboardId: created });
      await call('restore_version', { dashboardId: created, version: 1 });
      await call('restore_version', { dashboardId: created, version: 3 });
      await call('set_visibility', { dashboardId: created, visibility: 'public' });
      await call('apply_operations', {
        dashboardId: dash,
        operations: [addDataset(http('agent', '/v1/whoami', all))],
      });

      // A deleted secret.
      await c.call(`/api/secrets/${header.id}`, { method: 'DELETE', cookie: owner });
      expect((await c.data(dash, 'gone', owner)).error).toBe(
        'Credentials for this source are not available.',
      );
      await c.call(`/api/dashboards/${dash}/data/orders`, { cookie: owner });
      await c.call(`/api/dashboards/${dash}/data/gone`);

      // Rotation: restart with a new key and the old one as previous, then once more with only a third key.
      const secondKey = key();
      await c.close(false);
      envs.length = 0;
      const rotated = await new Env(c.dir).start({
        SECRETS: 'users',
        SECRETS_KEY: secondKey,
        SECRETS_KEY_PREVIOUS: firstKey,
      });
      envs.push(rotated);
      expect(logs.join('\n')).toContain('re-encrypted 2 secrets with the current SECRETS_KEY');
      const ownerAgain = await rotated.login('canary-owner@example.com');
      const afterRotation = await rotated.data(dash, 'bq', ownerAgain);
      expect(afterRotation.error).toBeUndefined();
      expect(afterRotation.table.rows[0].echoAuth).toBe('Bearer [redacted]');
      await rotated.data(dash, 'bq');
      await rotated.close(false);
      envs.length = 0;
      const lost = await new Env(c.dir).start({ SECRETS: 'users', SECRETS_KEY: key() });
      envs.push(lost);
      expect(logs.join('\n')).toContain('2 secrets cannot be decrypted with the configured keys');
      const ownerLost = await lost.login('canary-owner@example.com');
      expect((await lost.data(dash, 'bq', ownerLost)).error).toBe(
        'Credentials could not be decrypted on this server.',
      );
      await lost.data(dash, 'bq');
      await lost.call(`/api/secrets/${bearer.id}/value`, {
        method: 'PUT',
        body: { value: canaries.bearer },
        cookie: ownerLost,
      });
      await lost.call('/api/secrets', { cookie: ownerLost });
      expect(logs.join('\n')).toContain(`secret ${bearer.id} cannot be decrypted`);
      await new Promise((r) => setTimeout(r, 200));
      await lost.close(false);
      envs.length = 0;

      // The secrets were really used, and only ever sent to the bound host.
      const sent = upstream.since(markUpstream);
      const toBound = sent.filter((r) => r.host === 'api.example.com');
      expect(toBound.some((r) => r.headers.authorization === `Bearer ${canaries.bearer}`)).toBe(true);
      expect(toBound.some((r) => r.headers['x-api-key'] === canaries.header)).toBe(true);
      expect(toBound.some((r) => r.url.includes(`api_key=${canaries.query}`))).toBe(true);
      expect(sent.filter((r) => r.host !== 'api.example.com')).toEqual([]);
      // Nothing outside the bound path prefix received them either.
      for (const r of toBound.filter((x) => !x.url.startsWith('/v1/'))) {
        expect(JSON.stringify(r)).not.toMatch(/cnry/);
      }

      // Everything a client, a log or the data directory (folders, versions, SQLite files) ever held.
      const everything = [
        ...c.seen,
        ...rotated.seen,
        ...lost.seen,
        ...logs,
        ...filesUnder(c.dir).map((f) => `${f.path}\n${f.content}`),
      ];
      // The corpus is what it claims to be: echoes that were redacted, errors, PNGs, SSE events and the database.
      expect(everything.length).toBeGreaterThan(200);
      const corpus = everything.join('\n');
      for (const expected of [
        'Bearer [redacted]',
        'Upstream responded 401',
        'The API redirected to another address',
        'Request timed out',
        'Credentials could not be decrypted on this server.',
        '"type":"data"',
        'PNG',
        'SQLite format 3',
        bearer.id,
      ]) {
        expect(corpus).toContain(expected);
      }
      expect(filesUnder(c.dir).some((f) => f.path.includes('versions'))).toBe(true);
      for (const v of values) {
        for (const form of [v, encodeURIComponent(v), v.toUpperCase()]) {
          const hit = everything.find((t) => t.includes(form));
          expect(hit, `canary found: ${hit?.slice(0, 300)}`).toBeUndefined();
        }
      }
    } finally {
      for (const s of spies) s.mockRestore();
      for (const e of envs) await e.close().catch(() => {});
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
