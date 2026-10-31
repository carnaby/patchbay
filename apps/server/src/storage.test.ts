/** Storage limits: document size, the anonymous ceiling, uploads counted on disk, shared copies and pruning. */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { type DashboardDoc, LIMITS } from '@patchbay/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, createDeps } from './app.ts';
import { loadConfig } from './config.ts';
import type { Deps } from './context.ts';
import { MAX_DASHBOARD_BYTES } from './services/dashboards.ts';

const BASE = 'http://localhost:8787';
let dir: string;
let deps: Deps;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay-storage-'));
  deps = await createDeps(
    loadConfig({
      NODE_ENV: 'test',
      DATA_DIR: dir,
      OFFLINE: '1',
      DEV_LOGIN: '1',
      ADMIN_EMAILS: 'admin@example.com',
      PUBLIC_URL: BASE,
      // Small enough to reach in a test, large enough for the document tests below.
      ANONYMOUS_STORAGE_LIMIT_MB: '6',
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

type Init = { method?: string; body?: unknown; cookie?: string; key?: string };

async function call(path: string, init: Init = {}) {
  const headers: Record<string, string> = { origin: BASE };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.cookie) headers.cookie = init.cookie;
  if (init.key) headers['x-edit-key'] = init.key;
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
}

async function login(email: string): Promise<string> {
  const res = await app.request(`${BASE}/auth/dev`, {
    method: 'POST',
    headers: { origin: BASE, 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

async function anonymous() {
  const { envelope, editKey } = (await call('/api/dashboards', { body: {} })).json;
  return { id: envelope.meta.id as string, key: editKey as string };
}

/** An inline dataset of about `kb` KB. */
function inline(id: string, kb: number) {
  const text = 'x'.repeat(LIMITS.inlineText - 20);
  const rows = Array.from({ length: Math.ceil((kb * 1024) / (text.length + 20)) }, (_, i) => ({ i, text }));
  return { op: 'addDataset', dataset: { id, name: id, source: { kind: 'inline', rows } } };
}

const folder = (id: string) => join(dir, 'dashboards', id);

describe('document size', () => {
  it('refuses writes that make a document too large, with advice an agent can act on (REST)', async () => {
    const cookie = await login('big@example.com');
    const id = (await call('/api/dashboards', { body: {}, cookie })).json.envelope.meta.id;
    expect(
      (await call(`/api/dashboards/${id}/ops`, { body: { ops: [inline('a', 600)] }, cookie })).status,
    ).toBe(200);
    const dry = await call(`/api/dashboards/${id}/ops`, {
      body: { ops: [inline('b', 600)], dryRun: true },
      cookie,
    });
    expect(dry.status).toBe(400);
    const res = await call(`/api/dashboards/${id}/ops`, { body: { ops: [inline('b', 600)] }, cookie });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('DOCUMENT_TOO_LARGE');
    expect(res.json.limitBytes).toBe(LIMITS.documentBytes);
    expect(res.json.error).toContain('Largest inline datasets: "a"');
    expect(res.json.error).toContain('upload_data');
    expect((await call(`/api/dashboards/${id}`, { cookie })).json.meta.version).toBe(2);
  });

  it('caps inline text and column names on writes, but keeps documents that already hold longer ones', async () => {
    const cookie = await login('long@example.com');
    const created = (await call('/api/dashboards', { body: {}, cookie })).json.envelope;
    const id = created.meta.id;
    const longText = 'x'.repeat(5000);
    const longName = `c${'n'.repeat(299)}`;
    const inlineDataset = (datasetId: string, rows: unknown[]) => ({
      op: 'addDataset',
      dataset: { id: datasetId, name: datasetId, source: { kind: 'inline', rows } },
    });

    // Adding either is refused, with a reason an agent can act on, over ops, dry runs and full saves alike.
    const value = await call(`/api/dashboards/${id}/ops`, {
      body: { ops: [inlineDataset('d', [{ text: longText }])] },
      cookie,
    });
    expect(value.status).toBe(400);
    expect(value.json.code).toBe('INLINE_VALUE_TOO_LONG');
    expect(value.json.error).toContain(`limited to ${LIMITS.inlineText} characters (this one has 5000)`);
    expect(value.json.error).toContain('upload_data');
    const name = await call(`/api/dashboards/${id}/ops`, {
      body: { ops: [inlineDataset('d', [{ [longName]: 1 }])], dryRun: true },
      cookie,
    });
    expect(name.status).toBe(400);
    expect(name.json.error).toContain(`limited to ${LIMITS.inlineColumnName} characters`);
    const oldRows = [
      { day: 1, [longName]: 'a', note: longText },
      { day: 2, [longName]: 'b', note: 'short' },
    ];
    const put = await call(`/api/dashboards/${id}`, {
      method: 'PUT',
      body: {
        doc: {
          ...created.doc,
          datasets: [{ id: 'old', name: 'Old', source: { kind: 'inline', rows: oldRows } }],
        },
        baseVersion: 1,
      },
      cookie,
    });
    expect(put.json.code).toBe('INLINE_VALUE_TOO_LONG');

    // A document saved before the limits, holding both.
    const legacy = {
      ...created.doc,
      datasets: [{ id: 'old', name: 'Old', source: { kind: 'inline', rows: oldRows } }],
    };
    writeFileSync(join(folder(id), 'dashboard.json'), JSON.stringify(legacy, null, 2));
    const loaded = await call(`/api/dashboards/${id}`, { cookie });
    expect(loaded.status).toBe(200);
    expect(loaded.json.doc.datasets[0].source.rows[0].note).toHaveLength(5000);
    expect((await call(`/api/dashboards/${id}/data/old`, { cookie })).json.table.rows).toHaveLength(2);

    // Other edits work, including edits of that dataset that keep its long values.
    const widget = { id: 'n', type: 'kpi', datasetId: 'old', config: { agg: 'count' } };
    const edits = await call(`/api/dashboards/${id}/ops`, {
      body: {
        ops: [
          { op: 'setMeta', title: 'Still mine' },
          { op: 'addWidget', widget },
          { op: 'updateDataset', id: 'old', set: { name: 'Renamed' } },
          {
            op: 'updateDataset',
            id: 'old',
            set: { source: { kind: 'inline', rows: [...oldRows, { day: 3 }] } },
          },
        ],
      },
      cookie,
    });
    expect(edits.status).toBe(200);
    const snapshot = await app.request(`${BASE}/api/dashboards/${id}/snapshot.png`, { headers: { cookie } });
    expect(snapshot.status).toBe(200);
    expect(snapshot.headers.get('content-type')).toContain('image/png');

    // But not new long values in it.
    const grow = await call(`/api/dashboards/${id}/ops`, {
      body: {
        ops: [
          {
            op: 'updateDataset',
            id: 'old',
            set: { source: { kind: 'inline', rows: [...oldRows, { day: 4, note: `${longText}!` }] } },
          },
        ],
      },
      cookie,
    });
    expect(grow.json.code).toBe('INLINE_VALUE_TOO_LONG');
    expect(grow.json.error).toContain('Dataset "old", inline row 3');
  });

  it('keeps loading a document stored before the limit, and lets it shrink but not grow', async () => {
    const cookie = await login('legacy@example.com');
    const id = (await call('/api/dashboards', { body: {}, cookie })).json.envelope.meta.id;
    const big = (await deps.store.readDoc(id))!;
    const rows = Array.from({ length: LIMITS.inlineRows }, (_, i) => ({ i, text: 'y'.repeat(600) }));
    const oversized: DashboardDoc = {
      ...big,
      datasets: ['a', 'b'].map((d) => ({
        id: d,
        name: d,
        source: { kind: 'inline' as const, rows },
        transforms: [],
        refreshSec: 0,
        accumulate: 0,
      })),
    };
    // As an earlier release would have written it: pretty-printed and over the limit.
    writeFileSync(join(folder(id), 'dashboard.json'), JSON.stringify(oversized, null, 2));
    expect((await call(`/api/dashboards/${id}`, { cookie })).json.doc.datasets).toHaveLength(2);

    const rename = await call(`/api/dashboards/${id}/ops`, {
      body: { ops: [{ op: 'setMeta', title: 'Old' }] },
      cookie,
    });
    expect(rename.status).toBe(200);
    const grow = await call(`/api/dashboards/${id}/ops`, { body: { ops: [inline('c', 10)] }, cookie });
    expect(grow.json.code).toBe('DOCUMENT_TOO_LARGE');
    const shrink = await call(`/api/dashboards/${id}/ops`, {
      body: { ops: [{ op: 'removeDataset', id: 'b' }] },
      cookie,
    });
    expect(shrink.status).toBe(200);
  });

  it('refuses the same over MCP', async () => {
    const cookie = await login('mcp-big@example.com');
    const pat = (
      await call('/api/tokens', {
        body: { name: 't', scopes: ['dashboards:read', 'dashboards:write'] },
        cookie,
      })
    ).json.token;
    const client = new Client({ name: 'vitest', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${pat}` } },
        fetch: async (url, init) => app.request(String(url), init as RequestInit),
      }),
    );
    try {
      const text = (r: { content?: unknown }) => (r.content as { text: string }[])[0]!.text;
      const created = await client.callTool({ name: 'create_dashboard', arguments: { title: 'Agent' } });
      const id = JSON.parse(text(created)).dashboardId;
      const res = await client.callTool({
        name: 'apply_operations',
        arguments: { dashboardId: id, operations: [inline('a', 1200)] },
      });
      expect(res.isError).toBe(true);
      expect(text(res)).toContain('a dashboard document is limited to');
      expect(text(res)).toContain('upload_data');
      const long = await client.callTool({
        name: 'apply_operations',
        arguments: {
          dashboardId: id,
          operations: [
            {
              op: 'addDataset',
              dataset: { id: 'l', name: 'l', source: { kind: 'inline', rows: [{ t: 'x'.repeat(5000) }] } },
            },
          ],
        },
      });
      expect(long.isError).toBe(true);
      expect(text(long)).toContain(
        `text values in inline rows are limited to ${LIMITS.inlineText} characters`,
      );
      const reference = await client.callTool({ name: 'get_reference', arguments: {} });
      expect(text(reference)).toContain(
        `${Math.floor(LIMITS.documentBytes / 1000)} KB for the whole document`,
      );
    } finally {
      await client.close();
    }
  });
});

describe('anonymous storage ceiling', () => {
  it('stops anonymous creates, writes and uploads at the ceiling, but not signed-in users', async () => {
    const indexed = () => deps.index.anonymousBytes();
    const a = await anonymous();
    // Each write stores the document twice (current + version): about 1.6 MB per 800 KB document.
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      const doc = (await call(`/api/dashboards/${a.id}`)).json.doc as DashboardDoc;
      const ops = [...doc.datasets.map((d) => ({ op: 'removeDataset', id: d.id })), inline(name, 780)];
      expect((await call(`/api/dashboards/${a.id}/ops`, { body: { ops }, key: a.key })).status).toBe(200);
    }
    // The index follows every write, so the ceiling sees what is on disk.
    const { size } = statSync(join(folder(a.id), 'dashboard.json'));
    expect(indexed()).toBeGreaterThan(3 * size);

    const b = await anonymous();
    const full = await call(`/api/dashboards/${b.id}/ops`, { body: { ops: [inline('x', 780)] }, key: b.key });
    expect(full.status).toBe(507);
    expect(full.json.code).toBe('ANONYMOUS_STORAGE_FULL');
    expect(full.json.error).toContain('Sign in');
    const upload = await call(`/api/dashboards/${b.id}/files`, {
      body: { name: 'x.csv', content: `n\n${`${'z'.repeat(100)}\n`.repeat(20_000)}` },
      key: b.key,
    });
    expect(upload.status).toBe(507);

    const cookie = await login('member@example.com');
    const mine = (await call('/api/dashboards', { body: {}, cookie })).json.envelope.meta.id;
    expect(
      (await call(`/api/dashboards/${mine}/ops`, { body: { ops: [inline('x', 780)] }, cookie })).status,
    ).toBe(200);

    // Claiming moves a dashboard out of the anonymous total.
    const before = indexed();
    const claimed = await call(`/api/dashboards/${a.id}/claim`, { body: {}, cookie, key: a.key });
    expect(claimed.status).toBe(200);
    expect(indexed()).toBeLessThan(before / 2);
    expect(
      (await call(`/api/dashboards/${b.id}/ops`, { body: { ops: [inline('x', 300)] }, key: b.key })).status,
    ).toBe(200);
  });
});

describe('uploads', () => {
  it('count what they take on disk, not what was uploaded', async () => {
    const cookie = await login('files@example.com');
    const id = (await call('/api/dashboards', { body: {}, cookie })).json.envelope.meta.id;
    const file = await call(`/api/dashboards/${id}/files`, {
      body: { name: 'a.csv', content: 'a,b\n1,2\n' },
      cookie,
    });
    expect(file.status).toBe(201);
    const path = join(folder(id), 'files', `${file.json.id}.json`);
    expect(file.json.storedBytes).toBe(statSync(path).size);
    expect((await call(`/api/dashboards/${id}/files`, { cookie })).json[0].storedBytes).toBe(
      statSync(path).size,
    );

    // A file from an earlier release whose parsed form fills the budget, though its upload was small.
    const head = {
      id: 'f_bloated',
      name: 'old.csv',
      rows: 1,
      columns: 1,
      size: 10,
      uploadedAt: '2026-01-01',
    };
    const padding = ' '.repeat(MAX_DASHBOARD_BYTES);
    writeFileSync(
      join(folder(id), 'files', 'f_bloated.json'),
      `${JSON.stringify(head).slice(0, -1)},"table":{"columns":[],"rows":[]}${padding}}`,
    );
    const refused = await call(`/api/dashboards/${id}/files`, {
      body: { name: 'b.csv', content: 'a\n1\n' },
      cookie,
    });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toContain('as stored on the server');
  });
});

describe('copies', () => {
  it('let viewers copy a public dashboard; the copy shares upload bytes and outlives the original', async () => {
    const cookie = await login('origin@example.com');
    const id = (await call('/api/dashboards', { body: { visibility: 'public' }, cookie })).json.envelope.meta
      .id;
    const csv = `n,label\n${Array.from({ length: 500 }, (_, i) => `${i},row ${i}`).join('\n')}\n`;
    const file = (
      await call(`/api/dashboards/${id}/files`, { body: { name: 'a.csv', content: csv }, cookie })
    ).json;
    const dataset = { id: 'up', name: 'Up', source: { kind: 'upload', fileId: file.id } };
    await call(`/api/dashboards/${id}/ops`, { body: { ops: [{ op: 'addDataset', dataset }] }, cookie });

    // A stranger without any key.
    const copy = await call(`/api/dashboards/${id}/duplicate`, { body: {} });
    expect(copy.status).toBe(201);
    const copyId = copy.json.envelope.meta.id;
    const original = statSync(join(folder(id), 'files', `${file.id}.json`));
    const shared = statSync(join(folder(copyId), 'files', `${file.id}.json`));
    expect(shared.ino).toBe(original.ino);
    expect(shared.nlink).toBe(2);
    expect((await call(`/api/dashboards/${copyId}/data/up`)).json.table.rows).toHaveLength(500);

    // Claiming the copy keeps its data; deleting the original does not take it away.
    const claimer = await login('copier@example.com');
    expect(
      (await call(`/api/dashboards/${copyId}/claim`, { body: {}, cookie: claimer, key: copy.json.editKey }))
        .status,
    ).toBe(200);
    expect((await call(`/api/dashboards/${id}`, { method: 'DELETE', cookie })).status).toBe(200);
    expect(
      (await call(`/api/dashboards/${copyId}/data/up`, { cookie: claimer })).json.table.rows,
    ).toHaveLength(500);
    expect(statSync(join(folder(copyId), 'files', `${file.id}.json`)).nlink).toBe(1);
    // Its file list still describes the upload, counted with the bytes it now holds alone.
    const listed = (await call(`/api/dashboards/${copyId}/files`, { cookie: claimer })).json;
    expect(listed).toEqual([
      { ...file, storedBytes: statSync(join(folder(copyId), 'files', `${file.id}.json`)).size },
    ]);
  });
});

describe('versions', () => {
  it('lists the history of an old folder without parsing its documents', async () => {
    const cookie = await login('history@example.com');
    const id = (await call('/api/dashboards', { body: {}, cookie })).json.envelope.meta.id;
    await call(`/api/dashboards/${id}/ops`, { body: { ops: [{ op: 'setMeta', title: 'Two' }] }, cookie });
    // As an earlier release left it: no index, and (here) documents that would not even parse.
    const versions = join(folder(id), 'versions');
    rmSync(join(versions, 'index.json'));
    for (const v of [1, 2]) {
      const raw = readFileSync(join(versions, `${v}.json`), 'utf8');
      writeFileSync(join(versions, `${v}.json`), `${raw.slice(0, raw.indexOf('"doc":') + 6)}"broken`);
    }
    const res = await call(`/api/dashboards/${id}/versions`, { cookie });
    expect(res.status).toBe(200);
    expect(res.json.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(res.json[0].changes.length).toBeGreaterThan(0);
    expect(res.json[0].actor.kind).toBe('user');
  });
});

describe('pruning', () => {
  it('removes anonymous dashboards that stayed blank, and nothing else', async () => {
    const blank = await anonymous();
    const edited = await anonymous();
    await call(`/api/dashboards/${edited.id}/ops`, {
      body: { ops: [{ op: 'setMeta', title: 'Kept' }] },
      key: edited.key,
    });
    const template = (await call('/api/dashboards', { body: { template: 'live-signal' } })).json.envelope.meta
      .id;
    const cookie = await login('owner-blank@example.com');
    const owned = (await call('/api/dashboards', { body: {}, cookie })).json.envelope.meta.id;

    expect(await deps.dashboards.pruneUntouched({ olderThanHours: 1 })).toEqual([]);
    const pruned = await deps.dashboards.pruneUntouched({ olderThanHours: 0 });
    expect(pruned).toContain(blank.id);
    for (const kept of [edited.id, template, owned]) expect(pruned).not.toContain(kept);
    expect((await call(`/api/dashboards/${blank.id}`)).status).toBe(404);
    expect((await call(`/api/dashboards/${edited.id}`)).status).toBe(200);
  });
});
