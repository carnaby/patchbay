import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { fromJsonSchema, type JsonSchemaType } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, createDeps } from './app.ts';
import { loadConfig } from './config.ts';
import type { Deps } from './context.ts';
import { isAcceptableRedirect, redirectMatches } from './routes/oauth.ts';
import { buildTemplate, listTemplates } from './services/templates.ts';
import { isPrivateAddress, safeFetchJson } from './util/safe-fetch.ts';

const BASE = 'http://localhost:8787';
let dir: string;
let deps: Deps;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay-test-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    DATA_DIR: dir,
    OFFLINE: '1',
    DEV_LOGIN: '1',
    ADMIN_EMAILS: 'admin@example.com',
    PUBLIC_URL: BASE,
  });
  deps = await createDeps(config);
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
  const res = await app.request(`${BASE}/auth/dev`, {
    method: 'POST',
    headers: { origin: BASE, 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  expect(cookie).toMatch(/^pb_session=/);
  return cookie;
}

describe('dashboards over REST', () => {
  it('lets anyone create a public dashboard, editable only with its edit key', async () => {
    const created = await call('/api/dashboards', { body: { template: 'live-signal' } });
    expect(created.status).toBe(201);
    const { envelope, editKey } = created.json;
    expect(envelope.meta.visibility).toBe('public');
    expect(envelope.access).toMatchObject({ canEdit: true, anonymous: true });
    const id = envelope.meta.id;

    const op = { ops: [{ op: 'setMeta', title: 'Mine' }] };
    expect((await call(`/api/dashboards/${id}/ops`, { body: op })).status).toBe(403);
    const ok = await call(`/api/dashboards/${id}/ops`, { body: op, headers: { 'x-edit-key': editKey } });
    expect(ok.status).toBe(200);
    expect(ok.json.envelope.meta.version).toBe(2);
    expect((await call(`/api/dashboards/${id}`)).json.doc.title).toBe('Mine');
  });

  it('rejects unknown connectors on save, but keeps documents that name a removed one', async () => {
    const cookie = await login('dora@example.com');
    const { envelope } = (await call('/api/dashboards', { body: {}, cookie })).json;
    const id = envelope.meta.id;
    const dataset = (connector: string) => ({
      id: 'feed',
      name: 'Feed',
      source: { kind: 'connector', connector, params: {} },
    });

    const bad = await call(`/api/dashboards/${id}/ops`, {
      body: {
        ops: [
          { op: 'setMeta', title: 'x' },
          { op: 'addDataset', dataset: dataset('no.such') },
        ],
      },
      cookie,
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toContain('Operation 2: Unknown connector "no.such"');
    const dry = await call(`/api/dashboards/${id}/ops`, {
      body: { ops: [{ op: 'addDataset', dataset: dataset('no.such') }], dryRun: true },
      cookie,
    });
    expect(dry.status).toBe(400);
    const put = await call(`/api/dashboards/${id}`, {
      method: 'PUT',
      body: { doc: { ...envelope.doc, datasets: [dataset('no.such')] }, baseVersion: 1 },
      cookie,
    });
    expect(put.status).toBe(400);
    expect(put.json.error).toContain('Unknown connector "no.such"');
    // All or nothing: the setMeta before the bad op was not saved either.
    expect((await call(`/api/dashboards/${id}`, { cookie })).json.meta.version).toBe(1);

    // A document stored while "retired.feed" still existed.
    const meta = (await deps.store.readMeta(id))!;
    await deps.store.writeDoc(
      { ...meta, version: 2 },
      { ...envelope.doc, datasets: [dataset('retired.feed')] },
      { kind: 'user', label: 'test' },
      ['Saved before the connector was removed'],
    );
    const legacy = await call(`/api/dashboards/${id}`, { cookie });
    expect(legacy.status).toBe(200);
    expect(legacy.json.doc.datasets[0].source.connector).toBe('retired.feed');
    const unrelated = await call(`/api/dashboards/${id}/ops`, {
      body: {
        ops: [
          { op: 'updateDataset', id: 'feed', set: { refreshSec: 60 } },
          { op: 'addWidget', widget: { id: 'note', type: 'text', config: { markdown: 'Hi' } } },
        ],
      },
      cookie,
    });
    expect(unrelated.status).toBe(200);
    const editorSave = await call(`/api/dashboards/${id}`, {
      method: 'PUT',
      body: { doc: { ...unrelated.json.envelope.doc, title: 'Renamed' }, baseVersion: 3 },
      cookie,
    });
    expect(editorSave.status).toBe(200);
    const repoint = await call(`/api/dashboards/${id}/ops`, {
      body: {
        ops: [
          {
            op: 'updateDataset',
            id: 'feed',
            set: { source: { kind: 'connector', connector: 'also.gone', params: {} } },
          },
        ],
      },
      cookie,
    });
    expect(repoint.status).toBe(400);
    expect(repoint.json.error).toContain('Operation 1: Unknown connector "also.gone"');
  });

  it('rejects unknown templates', async () => {
    const res = await call('/api/dashboards', { body: { template: 'no-such-template' } });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('Unknown template "no-such-template"');
    expect(res.json.error).toContain('blank');
    // What the template picker offers (GET /api/templates) is exactly what create accepts.
    for (const t of listTemplates()) expect(buildTemplate(t.id).title).toBeTruthy();
    expect((await call('/api/dashboards', { body: { template: 'weather' } })).status).toBe(201);
  });

  it('rejects cross-site writes', async () => {
    const res = await call('/api/dashboards', { body: {}, headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
  });

  it('hides private dashboards from everyone but the owner', async () => {
    const alice = await login('alice@example.com');
    const bob = await login('bob@example.com');
    const created = await call('/api/dashboards', {
      body: { title: 'Secret', visibility: 'private' },
      cookie: alice,
    });
    const id = created.json.envelope.meta.id;
    expect((await call(`/api/dashboards/${id}`, { cookie: alice })).status).toBe(200);
    expect((await call(`/api/dashboards/${id}`)).status).toBe(401);
    expect((await call(`/api/dashboards/${id}`, { cookie: bob })).status).toBe(404);
    expect((await call(`/api/dashboards/${id}/snapshot.png`, { cookie: bob })).status).toBe(404);
    const admin = await login('admin@example.com');
    expect((await call(`/api/dashboards/${id}`, { cookie: admin })).status).toBe(200);
    expect(
      (await call('/api/dashboards', { cookie: alice })).json.map((d: { id: string }) => d.id),
    ).toContain(id);
  });

  it('detects concurrent edits with baseVersion', async () => {
    const cookie = await login('carol@example.com');
    const { envelope } = (await call('/api/dashboards', { body: {}, cookie })).json;
    const id = envelope.meta.id;
    const save = (title: string) =>
      call(`/api/dashboards/${id}`, {
        method: 'PUT',
        body: { doc: { ...envelope.doc, title }, baseVersion: 1 },
        cookie,
      });
    expect((await save('First')).status).toBe(200);
    const conflict = await save('Second');
    expect(conflict.status).toBe(409);
    expect(conflict.json.current.doc.title).toBe('First');
  });

  it('lets a signed-in user claim an anonymous dashboard', async () => {
    const { envelope, editKey } = (await call('/api/dashboards', { body: {} })).json;
    const cookie = await login('dave@example.com');
    const id = envelope.meta.id;
    expect((await call(`/api/dashboards/${id}/claim`, { body: {}, cookie })).status).toBe(403);
    const claimed = await call(`/api/dashboards/${id}/claim`, {
      body: {},
      cookie,
      headers: { 'x-edit-key': editKey },
    });
    expect(claimed.status).toBe(200);
    expect(claimed.json.access.isOwner).toBe(true);
    // The old edit key no longer grants anything.
    expect(
      (
        await call(`/api/dashboards/${id}/ops`, {
          body: { ops: [{ op: 'setMeta', title: 'x' }] },
          headers: { 'x-edit-key': editKey },
        })
      ).status,
    ).toBe(403);
  });

  it('uploads CSV, previews it and suggests widgets', async () => {
    const cookie = await login('erin@example.com');
    const id = (await call('/api/dashboards', { body: {}, cookie })).json.envelope.meta.id;
    const csv = 'date,region,amount\n2026-01-01,EU,10\n2026-01-02,US,12.5\n2026-01-03,EU,7\n';
    const file = await call(`/api/dashboards/${id}/files`, {
      body: { name: 'sales.csv', content: csv },
      cookie,
    });
    expect(file.status).toBe(201);
    const preview = await call(`/api/dashboards/${id}/preview`, {
      body: {
        dataset: {
          source: { kind: 'upload', fileId: file.json.id },
          transforms: [{ type: 'filter', expr: 'amount > 8' }],
        },
      },
      cookie,
    });
    expect(preview.json.result.table.rows).toHaveLength(2);
    expect(preview.json.profile.columns.map((c: { role: string }) => c.role)).toEqual([
      'time',
      'dimension',
      'measure',
    ]);
    expect(preview.json.suggestions[0].widget.config.kind).toBe('line');
  });

  it('versions every change and can restore', async () => {
    const cookie = await login('frank@example.com');
    const id = (await call('/api/dashboards', { body: { title: 'v1' }, cookie })).json.envelope.meta.id;
    await call(`/api/dashboards/${id}/ops`, { body: { ops: [{ op: 'setMeta', title: 'v2' }] }, cookie });
    const versions = (await call(`/api/dashboards/${id}/versions`, { cookie })).json;
    expect(versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    const restored = await call(`/api/dashboards/${id}/versions/1/restore`, { body: {}, cookie });
    expect(restored.json.envelope.doc.title).toBe('v1');
    expect(restored.json.envelope.meta.version).toBe(3);
  });

  it('forgets dashboards whose folder was deleted by hand', async () => {
    const id = (await call('/api/dashboards', { body: {} })).json.envelope.meta.id;
    rmSync(join(dir, 'dashboards', id), { recursive: true });
    expect((await call(`/api/dashboards/${id}`)).status).toBe(404);
    expect(deps.index.allIds()).not.toContain(id);
  });

  it('restricts the admin API to configured admins', async () => {
    const user = await login('gina@example.com');
    expect((await call('/api/admin/dashboards', { cookie: user })).status).toBe(403);
    const admin = await login('admin@example.com');
    const res = await call('/api/admin/dashboards', { cookie: admin });
    expect(res.status).toBe(200);
    expect(res.json.stats.dashboards).toBeGreaterThan(0);
  });
});

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

describe('OAuth 2.1 for MCP', () => {
  it('publishes discovery metadata and challenges unauthenticated MCP calls', async () => {
    const res = await app.request(`${BASE}/mcp`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(
      'resource_metadata="http://localhost:8787/.well-known/oauth-protected-resource/mcp"',
    );
    const prm = (await call('/.well-known/oauth-protected-resource/mcp')).json;
    expect(prm).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [BASE] });
    const asm = (await call('/.well-known/oauth-authorization-server')).json;
    expect(asm.code_challenge_methods_supported).toEqual(['S256']);
    expect(asm.client_id_metadata_document_supported).toBe(true);
  });

  it('runs register → authorize → consent → token → refresh, with reuse detection', async () => {
    const reg = await call('/oauth/register', {
      body: { client_name: 'Test Agent', redirect_uris: ['http://127.0.0.1:3333/callback'] },
    });
    expect(reg.status).toBe(201);
    const clientId = reg.json.client_id;
    const { verifier, challenge } = pkce();
    const authorize = await app.request(
      `${BASE}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent('http://127.0.0.1:4444/callback')}&code_challenge=${challenge}&code_challenge_method=S256&state=xyz&scope=dashboards:read%20dashboards:write&resource=${encodeURIComponent(`${BASE}/mcp`)}`,
    );
    expect(authorize.status).toBe(302);
    const consentUrl = new URL(authorize.headers.get('location')!, BASE);
    expect(consentUrl.pathname).toBe('/oauth/consent');
    const requestId = consentUrl.searchParams.get('request')!;

    const cookie = await login('oauth-user@example.com');
    expect((await call(`/api/oauth/requests/${requestId}`)).status).toBe(401);
    const details = await call(`/api/oauth/requests/${requestId}`, { cookie });
    expect(details.json.clientName).toBe('Test Agent');
    const approved = await call(`/api/oauth/requests/${requestId}`, { body: { approve: true }, cookie });
    const redirect = new URL(approved.json.redirect);
    expect(redirect.searchParams.get('state')).toBe('xyz');
    expect(redirect.searchParams.get('iss')).toBe(BASE);
    const code = redirect.searchParams.get('code')!;

    const form = (fields: Record<string, string>) =>
      app.request(`${BASE}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
      });
    const wrongVerifier = await form({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      code_verifier: pkce().verifier,
      redirect_uri: 'http://127.0.0.1:4444/callback',
    });
    expect(wrongVerifier.status).toBe(400);

    // The code was burned by the failed attempt: a fresh authorization is needed.
    const again = await app.request(
      `${BASE}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent('http://127.0.0.1:3333/callback')}&code_challenge=${challenge}&code_challenge_method=S256`,
    );
    const req2 = new URL(again.headers.get('location')!, BASE).searchParams.get('request')!;
    const code2 = new URL(
      (await call(`/api/oauth/requests/${req2}`, { body: { approve: true }, cookie })).json.redirect,
    ).searchParams.get('code')!;
    const redirectUri = 'http://127.0.0.1:3333/callback';
    // redirect_uri must be repeated at the token endpoint (OAuth 2.1).
    expect(
      (
        await form({
          grant_type: 'authorization_code',
          code: code2,
          client_id: clientId,
          code_verifier: verifier,
        })
      ).status,
    ).toBe(400);
    const again2 = await app.request(
      `${BASE}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256`,
    );
    const req3 = new URL(again2.headers.get('location')!, BASE).searchParams.get('request')!;
    const code3 = new URL(
      (await call(`/api/oauth/requests/${req3}`, { body: { approve: true }, cookie })).json.redirect,
    ).searchParams.get('code')!;
    const tokenRes = await form({
      grant_type: 'authorization_code',
      code: code3,
      client_id: clientId,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string; scope: string };
    expect(tokens.scope).toBe('dashboards:read dashboards:write');
    const me = await call('/api/me', { headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(me.json.user.email).toBe('oauth-user@example.com');

    const rotated = (await (
      await form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId })
    ).json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    // Replaying an authorization code revokes everything issued from it.
    const replay = await form({
      grant_type: 'authorization_code',
      code: code3,
      client_id: clientId,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    });
    expect(replay.status).toBe(400);
    expect(
      (await call('/api/me', { headers: { authorization: `Bearer ${rotated.access_token}` } })).status,
    ).toBe(401);
    // Replaying the old refresh token revokes the whole grant.
    expect(
      (await form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }))
        .status,
    ).toBe(400);
    expect(
      (await call('/api/me', { headers: { authorization: `Bearer ${rotated.access_token}` } })).status,
    ).toBe(401);
  });

  it('never redirects to an unregistered redirect_uri', async () => {
    const reg = await call('/oauth/register', { body: { redirect_uris: ['https://app.example/cb'] } });
    const res = await app.request(
      `${BASE}/oauth/authorize?response_type=code&client_id=${reg.json.client_id}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}&code_challenge=x&code_challenge_method=S256`,
    );
    expect(new URL(res.headers.get('location')!, BASE).pathname).toBe('/oauth/error');
  });

  it('validates redirect URIs', () => {
    expect(isAcceptableRedirect('https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(isAcceptableRedirect('http://localhost:6274/oauth/callback')).toBe(true);
    expect(isAcceptableRedirect('cursor://anysphere.cursor-retrieval/oauth/callback')).toBe(true);
    expect(isAcceptableRedirect('http://evil.example/cb')).toBe(false);
    expect(isAcceptableRedirect('javascript:alert(1)')).toBe(false);
    expect(redirectMatches(['http://127.0.0.1:1/cb'], 'http://127.0.0.1:9999/cb')).toBe(true);
    expect(redirectMatches(['https://a.example/cb'], 'https://a.example/cb2')).toBe(false);
  });
});

describe('MCP tools', () => {
  let client: Client;

  beforeAll(async () => {
    const cookie = await login('agent-owner@example.com');
    const pat = await call('/api/tokens', {
      body: { name: 'test', scopes: ['dashboards:read', 'dashboards:write'] },
      cookie,
    });
    expect(pat.json.token).toMatch(/^pb_pat_/);
    client = new Client({ name: 'vitest', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${pat.json.token}` } },
      fetch: async (url, init) => app.request(String(url), init as RequestInit),
    });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client?.close();
  });

  const text = (r: { content?: unknown }) =>
    (r.content as { type: string; text?: string }[]).find((c) => c.type === 'text')!.text!;

  it('lists the tools and the reference', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'create_dashboard',
        'apply_operations',
        'preview_data',
        'render_snapshot',
        'upload_data',
        'restore_version',
      ]),
    );
    const ref = await client.callTool({ name: 'get_reference', arguments: {} });
    expect(text(ref)).toContain('timeBucket');
    expect(text(ref)).toContain('Sound cues');
    expect(text(ref)).toContain('sparingly');
  });

  it('keeps tools/list compact', async () => {
    const list = await client.listTools();
    // Every client pays for this on every connection. It was 55.7 KB before shared subschemas were emitted once;
    // raise the budget only for a deliberate addition (33,000 -> 33,500: the reorderWidget op).
    expect(JSON.stringify(list).length).toBeLessThanOrEqual(33_500);

    const ops = list.tools.find((t) => t.name === 'apply_operations')!.inputSchema as any;
    expect(Object.keys(ops.$defs)).toEqual(expect.arrayContaining(['Widget', 'Transform', 'Source']));
    const json = JSON.stringify(ops);
    // The widget union (one branch per widget type) must appear once, not once per op that takes a widget.
    expect(json.split('"const":"gauge"').length - 1).toBe(1);
    // References carry a type, for clients that read `type` and never resolve `$ref`.
    expect(json).toContain('{"$ref":"#/$defs/Widget","type":"object"}');
    expect(JSON.stringify(ops.$defs.Source)).toContain('"enum":["weather.forecast"');

    const create = list.tools.find((t) => t.name === 'create_dashboard')!.inputSchema as any;
    expect(create.properties.template.enum).toEqual(expect.arrayContaining(['blank', 'weather']));
  });

  it('validates a realistic batch through the compact schema, as strictly as before', async () => {
    const id = JSON.parse(
      text(await client.callTool({ name: 'create_dashboard', arguments: { title: 'Schema check' } })),
    ).dashboardId;
    const operations = [
      { op: 'setMeta', description: 'Quakes this week' },
      {
        op: 'addDataset',
        dataset: {
          id: 'daily',
          name: 'Daily quakes',
          source: { kind: 'connector', connector: 'earthquakes', params: { period: 'week' } },
          transforms: [
            { type: 'filter', expr: 'magnitude >= 2' },
            { type: 'derive', as: 'strong', expr: 'magnitude >= 4' },
            { type: 'timeBucket', field: 'time', unit: 'day', as: 'day' },
            {
              type: 'aggregate',
              groupBy: ['day', 'region'],
              metrics: [
                { op: 'count', as: 'quakes' },
                { op: 'max', field: 'magnitude', as: 'max_mag' },
              ],
            },
            { type: 'sort', by: [{ field: 'day', dir: 'asc' }] },
          ],
          refreshSec: 300,
        },
      },
      {
        op: 'addWidget',
        widget: {
          id: 'per-day',
          type: 'chart',
          title: 'Quakes per day',
          datasetId: 'daily',
          config: { kind: 'line', x: 'day', y: ['quakes'], series: 'region', format: { style: 'compact' } },
        },
        position: { w: 8, h: 4 },
      },
      {
        op: 'addWidget',
        widget: {
          id: 'strongest',
          type: 'kpi',
          datasetId: 'daily',
          config: { field: 'max_mag', agg: 'max', format: { decimals: 1 } },
          sound: { trigger: { kind: 'condition', expr: 'max_mag >= 6' }, sound: 'alert' },
        },
      },
      { op: 'addStep', datasetId: 'daily', step: { type: 'limit', n: 500, from: 'end' } },
      {
        op: 'replaceWidget',
        widget: { id: 'strongest', type: 'gauge', datasetId: 'daily', config: { field: 'max_mag', max: 10 } },
      },
      { op: 'moveWidget', id: 'per-day', x: 0, y: 0 },
    ];

    // The advertised schema is self-contained and accepts what the server accepts.
    const { tools } = await client.listTools();
    const advertised = fromJsonSchema(
      tools.find((t) => t.name === 'apply_operations')!.inputSchema as JsonSchemaType,
    );
    const ok = await advertised['~standard'].validate({ dashboardId: id, operations });
    expect(ok.issues).toBeUndefined();

    const applied = await client.callTool({
      name: 'apply_operations',
      arguments: { dashboardId: id, operations },
    });
    expect(applied.isError).toBeFalsy();
    const result = JSON.parse(text(applied));
    expect(result.changes).toHaveLength(operations.length);
    // Sound cues are spelled out, so the agent need not fetch the document to check them.
    expect(result.changes[3]).toContain('sound cue: "alert" when `max_mag >= 6` becomes true');
    expect(result.changes[5]).toContain('its sound cue was removed');
    expect(result.dataChecks[0]).toMatchObject({ datasetId: 'daily' });
    expect(result.dataChecks[0].error).toBeUndefined();
    expect(result.dataChecks[0].rows).toBeGreaterThan(0);

    // Strict objects still reject unknown keys, on the server and in the advertised schema.
    const typo = [
      {
        op: 'addWidget',
        widget: {
          id: 'typo',
          type: 'chart',
          datasetId: 'daily',
          config: { kind: 'bar', x: 'day', y: ['quakes'], colour: 'red' },
        },
      },
    ];
    const rejected = await client.callTool({
      name: 'apply_operations',
      arguments: { dashboardId: id, operations: typo },
    });
    expect(rejected.isError).toBe(true);
    expect(text(rejected)).toContain('colour');
    expect(
      (await advertised['~standard'].validate({ dashboardId: id, operations: typo })).issues,
    ).toBeDefined();
    const doc = JSON.parse(
      text(await client.callTool({ name: 'get_dashboard', arguments: { dashboardId: id } })),
    );
    expect(doc.doc.widgets.map((w: { id: string }) => w.id)).not.toContain('typo');
  });

  it('rejects datasets from unknown connectors', async () => {
    const id = JSON.parse(
      text(await client.callTool({ name: 'create_dashboard', arguments: { title: 'Connectors' } })),
    ).dashboardId;
    const dataset = {
      id: 'feed',
      name: 'Feed',
      source: { kind: 'connector', connector: 'no.such', params: {} },
    };
    for (const dryRun of [true, false]) {
      const res = await client.callTool({
        name: 'apply_operations',
        arguments: { dashboardId: id, dryRun, operations: [{ op: 'addDataset', dataset }] },
      });
      expect(res.isError).toBe(true);
      expect(text(res)).toContain('Operation 1: Unknown connector "no.such"');
    }
    const doc = JSON.parse(
      text(await client.callTool({ name: 'get_dashboard', arguments: { dashboardId: id } })),
    );
    expect(doc.doc.datasets).toEqual([]);
  });

  it('accepts only real template ids', async () => {
    const bad = await client.callTool({
      name: 'create_dashboard',
      arguments: { title: 'Nope', template: 'no-such-template' },
    });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain('template');
    const good = JSON.parse(
      text(
        await client.callTool({ name: 'create_dashboard', arguments: { title: 'Wx', template: 'weather' } }),
      ),
    );
    expect(good.doc.datasets.length).toBeGreaterThan(0);
  });

  it('builds a dashboard end to end and renders it', async () => {
    const created = JSON.parse(
      text(await client.callTool({ name: 'create_dashboard', arguments: { title: 'Agent built' } })),
    );
    const id = created.dashboardId;

    const preview = JSON.parse(
      text(
        await client.callTool({
          name: 'preview_data',
          arguments: { source: { kind: 'connector', connector: 'earthquakes', params: { period: 'week' } } },
        }),
      ),
    );
    expect(preview.columns.map((c: { name: string }) => c.name)).toContain('magnitude');
    expect(preview.suggestions.length).toBeGreaterThan(0);

    const applied = await client.callTool({
      name: 'apply_operations',
      arguments: {
        dashboardId: id,
        operations: [
          {
            op: 'addDataset',
            dataset: {
              id: 'quakes',
              name: 'Quakes',
              source: { kind: 'connector', connector: 'earthquakes', params: { period: 'week' } },
            },
          },
          {
            op: 'addWidget',
            widget: {
              id: 'strongest',
              type: 'kpi',
              title: 'Strongest',
              datasetId: 'quakes',
              config: { field: 'magnitude', agg: 'max' },
            },
          },
          {
            op: 'addWidget',
            widget: {
              id: 'by-region',
              type: 'chart',
              title: 'By region',
              datasetId: 'quakes',
              config: { kind: 'bar', x: 'region', y: ['magnitude'] },
            },
          },
        ],
      },
    });
    const result = JSON.parse(text(applied));
    expect(result.version).toBe(2);
    expect(result.dataChecks[0].rows).toBeGreaterThan(0);

    const snap = await client.callTool({ name: 'render_snapshot', arguments: { dashboardId: id } });
    const image = (snap.content as { type: string; data?: string }[]).find((c) => c.type === 'image')!;
    expect(Buffer.from(image.data!, 'base64').subarray(1, 4).toString()).toBe('PNG');

    const versions = JSON.parse(
      text(await client.callTool({ name: 'list_versions', arguments: { dashboardId: id } })),
    );
    expect(versions[0].actor).toMatchObject({ kind: 'mcp', label: 'Personal token (MCP)' });
  });

  it('reports invalid operations without changing anything', async () => {
    const id = JSON.parse(
      text(await client.callTool({ name: 'create_dashboard', arguments: { title: 'Strict' } })),
    ).dashboardId;
    const bad = await client.callTool({
      name: 'apply_operations',
      arguments: { dashboardId: id, operations: [{ op: 'removeWidget', id: 'nope' }] },
    });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain('Unknown widget "nope"');
  });

  it('cannot touch other people’s private dashboards', async () => {
    const other = await login('stranger@example.com');
    const id = (await call('/api/dashboards', { body: { visibility: 'private' }, cookie: other })).json
      .envelope.meta.id;
    const res = await client.callTool({ name: 'get_dashboard', arguments: { dashboardId: id } });
    expect(res.isError).toBe(true);
  });

  it('enforces scopes', async () => {
    const cookie = await login('reader@example.com');
    const pat = (await call('/api/tokens', { body: { name: 'ro', scopes: ['dashboards:read'] }, cookie }))
      .json.token;
    const ro = new Client({ name: 'ro', version: '1' });
    await ro.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${pat}` } },
        fetch: async (url, init) => app.request(String(url), init as RequestInit),
      }),
    );
    const res = await ro.callTool({ name: 'create_dashboard', arguments: { title: 'nope' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('dashboards:write');
    await ro.close();
  });
});

describe('SSRF protection', () => {
  it('classifies private addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '192.168.0.1',
      '172.20.0.1',
      '169.254.169.254',
      '::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      '100.64.0.1',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of [
      '::ffff:7f00:1',
      '::ffff:a9fe:a9fe',
      '::7f00:1',
      '64:ff9b::7f00:1',
      '2002:7f00:1::',
      '[::1]',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('refuses non-https and private targets', async () => {
    await expect(safeFetchJson('http://example.com/data.json')).rejects.toThrow(/https/);
    await expect(safeFetchJson('https://127.0.0.1/x')).rejects.toThrow(/private/);
    await expect(safeFetchJson('https://user:pw@example.com/x')).rejects.toThrow(/credentials/);
    await expect(safeFetchJson('https://[::ffff:127.0.0.1]/x')).rejects.toThrow(/private/);
  });
});

describe('hardening (security review regressions)', () => {
  it('enforces token scopes on the REST API and never grants admin to tokens', async () => {
    const admin = await login('admin@example.com');
    const ro = (
      await call('/api/tokens', { body: { name: 'ro', scopes: ['dashboards:read'] }, cookie: admin })
    ).json.token;
    const owner = await login('victim@example.com');
    const id = (await call('/api/dashboards', { body: { visibility: 'private' }, cookie: owner })).json
      .envelope.meta.id;
    const auth = { authorization: `Bearer ${ro}` };
    expect((await call(`/api/dashboards/${id}`, { headers: auth })).status).toBe(404);
    expect((await call(`/api/dashboards/${id}`, { method: 'DELETE', headers: auth })).status).toBe(403);
    expect((await call('/api/dashboards', { body: {}, headers: auth })).status).toBe(403);
  });

  it('disconnects live streams when a dashboard becomes private', async () => {
    const cookie = await login('streamer@example.com');
    const id = (
      await call('/api/dashboards', { body: { visibility: 'public', template: 'live-signal' }, cookie })
    ).json.envelope.meta.id;
    const res = await app.request(`${BASE}/api/dashboards/${id}/events`);
    const reader = res.body!.getReader();
    await reader.read(); // hello
    expect(deps.hub.watchers(id)).toBe(1);
    await call(`/api/dashboards/${id}/settings`, {
      method: 'PATCH',
      body: { visibility: 'private' },
      cookie,
    });
    // The stream ends instead of continuing to deliver data.
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    expect(deps.hub.watchers(id)).toBe(0);
  });

  it('does not leak refresh loops when viewers come and go quickly', async () => {
    const id = (await call('/api/dashboards', { body: { template: 'live-signal' } })).json.envelope.meta.id;
    const sub = () => ({
      send: () => {},
      close: () => {},
      principal: { user: null, isAdmin: false, viaToken: false },
    });
    for (let i = 0; i < 20; i++) deps.hub.subscribe(id, sub())();
    await new Promise((r) => setTimeout(r, 50));
    expect(deps.hub.watchers(id)).toBe(0);
    expect(deps.hub.activeTimers()).toBe(0);
  });

  it('keeps uploaded files away from mere viewers', async () => {
    const cookie = await login('uploader@example.com');
    const id = (await call('/api/dashboards', { body: { visibility: 'public' }, cookie })).json.envelope.meta
      .id;
    await call(`/api/dashboards/${id}/files`, {
      body: { name: 'secret.csv', content: 'a,b\n1,2\n' },
      cookie,
    });
    expect((await call(`/api/dashboards/${id}/files`)).status).toBe(403);
    expect((await call(`/api/dashboards/${id}/files`, { cookie })).json).toHaveLength(1);
  });

  it('rejects oversized request bodies', async () => {
    const res = await call('/api/dashboards', { body: { title: 'x'.repeat(2 * 1024 * 1024) } });
    expect(res.status).toBe(413);
  });

  it('refuses DEV_LOGIN outside localhost', () => {
    expect(() => loadConfig({ DEV_LOGIN: '1', PUBLIC_URL: 'https://dash.example.com' })).toThrow(/DEV_LOGIN/);
    expect(() =>
      loadConfig({ DEV_LOGIN: '1', NODE_ENV: 'production', PUBLIC_URL: 'http://localhost:8787' }),
    ).toThrow(/DEV_LOGIN/);
  });
});
