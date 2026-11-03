/** Export and import of a dashboard (.patchbay.json): packed-table uploads, the export route and the import route. */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_TABLE_FILE_BYTES, readExport } from '@patchbay/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, createDeps } from './app.ts';
import { loadConfig } from './config.ts';
import type { Deps } from './context.ts';
import { RateLimiter } from './util/rate-limit.ts';

const BASE = 'http://localhost:8787';
let dir: string;
let deps: Deps;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay-transfer-'));
  deps = await createDeps(
    loadConfig({
      NODE_ENV: 'test',
      DATA_DIR: dir,
      OFFLINE: '1',
      DEV_LOGIN: '1',
      PUBLIC_URL: BASE,
      // Small, so the anonymous cell limit is reachable in a test.
      UPLOAD_MAX_CELLS_ANONYMOUS: '1000',
      SECRETS: 'users',
      SECRETS_KEY: randomBytes(32).toString('base64'),
    }),
  );
  // These tests create many dashboards from one address.
  Object.assign(deps.limits, {
    api: new RateLimiter(100_000, 100_000),
    writes: new RateLimiter(100_000, 100_000),
    creates: new RateLimiter(100_000, 100_000),
  });
  app = createApp(deps);
});

afterAll(async () => {
  deps.hub.close();
  await deps.pipeline.close();
  deps.db.close();
  rmSync(dir, { recursive: true, force: true });
});

type Init = { method?: string; body?: unknown; cookie?: string; key?: string };

async function raw(path: string, init: Init = {}) {
  const headers: Record<string, string> = { origin: BASE };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.cookie) headers.cookie = init.cookie;
  if (init.key) headers['x-edit-key'] = init.key;
  return app.request(`${BASE}${path}`, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

async function call(path: string, init: Init = {}) {
  const res = await raw(path, init);
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

/** A dashboard of `cookie` (or anonymous, with its key) whose dataset "data" uses file `fileId`, not uploaded yet. */
async function withReference(fileId: string, cookie?: string) {
  const created = await call('/api/dashboards', { body: {}, ...(cookie ? { cookie } : {}) });
  const id = created.json.envelope.meta.id as string;
  const key = created.json.editKey as string | undefined;
  const auth = { ...(cookie ? { cookie } : {}), ...(key ? { key } : {}) };
  const ops = await call(`/api/dashboards/${id}/ops`, {
    body: {
      ops: [{ op: 'addDataset', dataset: { id: 'data', name: 'Data', source: { kind: 'upload', fileId } } }],
    },
    ...auth,
  });
  expect(ops.status).toBe(200);
  return { id, auth };
}

const packed = (columns: unknown[], data: unknown[][]) => JSON.stringify({ columns, data });

describe('uploading a packed table', () => {
  const columns = [
    { name: 'ok', type: 'boolean' },
    { name: 't', type: 'time' },
    { name: 'code', type: 'string' },
  ];

  it('stores it under the file id the document uses, with its column types', async () => {
    const cookie = await login('table@example.com');
    const { id, auth } = await withReference('f_given', cookie);
    const res = await call(`/api/dashboards/${id}/files`, {
      body: {
        name: 'flags.json',
        format: 'table',
        fileId: 'f_given',
        content: packed(columns, [
          [true, 1767225600000, '007'],
          [null, null, null],
        ]),
      },
      ...auth,
    });
    expect(res.status).toBe(201);
    expect(res.json.id).toBe('f_given');
    const data = await call(`/api/dashboards/${id}/data/data`, auth);
    expect(data.json.table.columns).toEqual(columns);
    expect(data.json.table.rows).toEqual([
      { ok: true, t: 1767225600000, code: '007' },
      { ok: null, t: null, code: null },
    ]);
  });

  it('never replaces a stored file: a second upload to the same id answers 409 FILE_EXISTS', async () => {
    const cookie = await login('twice@example.com');
    const { id, auth } = await withReference('f_once', cookie);
    const body = {
      name: 'a.json',
      format: 'table',
      fileId: 'f_once',
      content: packed(columns, [[true, 1, 'a']]),
    };
    expect((await call(`/api/dashboards/${id}/files`, { body, ...auth })).status).toBe(201);
    const again = await call(`/api/dashboards/${id}/files`, {
      body: { ...body, content: packed(columns, [[false, 2, 'b']]) },
      ...auth,
    });
    expect(again.status).toBe(409);
    expect(again.json.code).toBe('FILE_EXISTS');
    expect((await call(`/api/dashboards/${id}/data/data`, auth)).json.table.rows[0].code).toBe('a');
  });

  it('refuses a file id no dataset uses', async () => {
    const cookie = await login('unused@example.com');
    const { id, auth } = await withReference('f_used', cookie);
    const res = await call(`/api/dashboards/${id}/files`, {
      body: { name: 'a.json', format: 'table', fileId: 'f_other', content: packed(columns, []) },
      ...auth,
    });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('FILE_NOT_REFERENCED');
  });

  it('refuses damaged tables value by value', async () => {
    const cookie = await login('damaged@example.com');
    const { id, auth } = await withReference('f_bad', cookie);
    const send = (content: string) =>
      call(`/api/dashboards/${id}/files`, {
        body: { name: 'a.json', format: 'table', fileId: 'f_bad', content },
        ...auth,
      });
    const short = await send(packed(columns, [[true]]));
    expect(short.status).toBe(400);
    expect(short.json.error).toBe('Row 1 has 1 values; the table has 3 columns');
    const wrong = await send(packed(columns, [['yes', 1, 'a']]));
    expect(wrong.json.error).toBe('Row 1, column "ok": "yes" is not a boolean value');
    expect((await send('{"columns":')).status).toBe(400);
  });

  it('holds tables to the size and cell limits', async () => {
    const cookie = await login('limits@example.com');
    const { id, auth } = await withReference('f_big', cookie);
    const huge = await call(`/api/dashboards/${id}/files`, {
      body: {
        name: 'a.json',
        format: 'table',
        fileId: 'f_big',
        content: ' '.repeat(MAX_TABLE_FILE_BYTES + 1),
      },
      ...auth,
    });
    expect(huge.status).toBe(400);
    expect(huge.json.code).toBe('IMPORT_FILE_TOO_LARGE');
    expect(huge.json.error).toBe(
      'The file "a.json" in this export is too large to import (7.0 MB; at most 7.0 MB per file).',
    );
    // Anonymous dashboards accept 1,000 cells in this test server.
    const anon = await withReference('f_cells');
    const rows = Array.from({ length: 600 }, (_, i) => [i, `r${i}`]);
    const cells = await call(`/api/dashboards/${anon.id}/files`, {
      body: {
        name: 'a.json',
        format: 'table',
        fileId: 'f_cells',
        content: packed(
          [
            { name: 'n', type: 'number' },
            { name: 's', type: 'string' },
          ],
          rows,
        ),
      },
      ...anon.auth,
    });
    expect(cells.status).toBe(400);
    expect(cells.json.error).toContain('1,000 cells');
    expect(cells.json.error).toContain('Dashboards of signed-in users accept up to 500,000 cells.');
  });
});

const TEMPS_CSV =
  'date,city,temp\n2026-01-01,Bratislava,1.5\n2026-01-02,Vienna,-0.5\n2026-01-03,Bratislava,\n';
const FLAGS_JSON = JSON.stringify([
  { ok: true, n: 1, note: 'a' },
  { ok: false, n: null, note: 'b' },
]);

/**
 * A signed-in user's board: a CSV upload and a JSON upload used by datasets, one upload no dataset uses, an HTTP
 * dataset with a secret reference, and a widget.
 */
async function shopBoard(email: string) {
  const cookie = await login(email);
  const id = (await call('/api/dashboards', { body: { title: 'Shop board' }, cookie })).json.envelope.meta
    .id as string;
  const upload = async (name: string, content: string) =>
    (await call(`/api/dashboards/${id}/files`, { body: { name, content }, cookie })).json.id as string;
  const temps = await upload('temps.csv', TEMPS_CSV);
  const flags = await upload('flags.json', FLAGS_JSON);
  await upload('unused.csv', 'a\n1\n');
  const secret = await call('/api/secrets', {
    body: {
      name: 'Shop key',
      sendTo: 'https://api.example.com/v1/',
      placement: 'bearer',
      value: 'val_0123456789abcdef',
    },
    cookie,
  });
  expect(secret.status).toBe(201);
  const ops = await call(`/api/dashboards/${id}/ops`, {
    body: {
      ops: [
        {
          op: 'addDataset',
          dataset: { id: 'temps', name: 'Temperatures', source: { kind: 'upload', fileId: temps } },
        },
        {
          op: 'addDataset',
          dataset: { id: 'flags', name: 'Flags', source: { kind: 'upload', fileId: flags } },
        },
        {
          op: 'addDataset',
          dataset: {
            id: 'orders',
            name: 'Orders',
            source: { kind: 'http', url: 'https://api.example.com/v1/orders', secrets: [secret.json.id] },
          },
        },
        {
          op: 'addWidget',
          widget: { id: 'temps-table', type: 'table', datasetId: 'temps', title: 'Temperatures', config: {} },
        },
      ],
    },
    cookie,
  });
  expect(ops.status).toBe(200);
  return { id, cookie, temps, flags };
}

async function exportOf(id: string, init: Init = {}) {
  const res = await raw(`/api/dashboards/${id}/export`, init);
  return { res, text: await res.text() };
}

describe('export', () => {
  it('gives editors the document without secret references and the tables of the files datasets use', async () => {
    const { id, cookie, temps, flags } = await shopBoard('owner@example.com');
    const { res, text } = await exportOf(id, { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="shop-board.patchbay.json"');
    const exp = readExport(JSON.parse(text));
    expect(exp.secretsRemovedFrom).toEqual(['orders']);
    expect(exp.doc.datasets.find((d) => d.id === 'orders')!.source).toEqual({
      kind: 'http',
      url: 'https://api.example.com/v1/orders',
    });
    expect(text).not.toContain('sec_');
    expect(exp.files.map((f) => f.id).sort()).toEqual([temps, flags].sort());
    const t = exp.files.find((f) => f.id === temps)!;
    expect(t.name).toBe('temps.csv');
    expect(t.columns).toEqual([
      { name: 'date', type: 'time' },
      { name: 'city', type: 'string' },
      { name: 'temp', type: 'number' },
    ]);
    expect(t.data[0]).toEqual([Date.parse('2026-01-01T00:00:00Z'), 'Bratislava', 1.5]);
    expect(exp.files.find((f) => f.id === flags)!.columns.map((c) => c.type)).toEqual([
      'boolean',
      'number',
      'string',
    ]);
    // Everything else of the document is as stored.
    const stored = (await call(`/api/dashboards/${id}`, { cookie })).json.doc;
    expect({ ...exp.doc, datasets: [] }).toEqual({ ...stored, datasets: [] });
    expect(exp.doc.datasets.map((d) => d.id)).toEqual(stored.datasets.map((d: { id: string }) => d.id));
  });

  it('gives viewers the document only, and strangers the same 404 as a missing dashboard', async () => {
    const { id, cookie } = await shopBoard('public-owner@example.com');
    expect((await exportOf(id)).res.status).toBe(404);
    expect((await exportOf(id, { cookie: await login('stranger@example.com') })).res.status).toBe(404);
    await call(`/api/dashboards/${id}/settings`, {
      method: 'PATCH',
      body: { visibility: 'public', confirmPublicSecrets: true },
      cookie,
    });
    const viewer = await exportOf(id, { cookie: await login('viewer@example.com') });
    expect(viewer.res.status).toBe(200);
    const exp = readExport(JSON.parse(viewer.text));
    expect(exp.files).toEqual([]);
    expect(exp.doc.datasets.map((d) => d.id)).toEqual(['temps', 'flags', 'orders']);
    expect(viewer.text).not.toContain('Bratislava');
  });

  it('lets the editors of an anonymous dashboard export its files with the edit key', async () => {
    const anon = await withReference('f_anon');
    await call(`/api/dashboards/${anon.id}/files`, {
      body: {
        name: 'a.json',
        format: 'table',
        fileId: 'f_anon',
        content: JSON.stringify({ columns: [{ name: 'n', type: 'number' }], data: [[1]] }),
      },
      ...anon.auth,
    });
    expect(readExport(JSON.parse((await exportOf(anon.id, anon.auth)).text)).files).toHaveLength(1);
    expect(readExport(JSON.parse((await exportOf(anon.id)).text)).files).toHaveLength(0);
  });
});
