/** Export and import of a dashboard (.patchbay.json): packed-table uploads, the export route and the import route. */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DashboardExport, EXPORT_MAX_FILES, MAX_TABLE_FILE_BYTES, readExport } from '@patchbay/core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, createDeps } from './app.ts';
import { loadConfig } from './config.ts';
import type { Deps } from './context.ts';
import { MAX_FILES } from './services/dashboards.ts';
import { ResultWire } from './services/result-wire.ts';
import { ByteBudget } from './util/byte-budget.ts';
import { HEAVY_FILE_BYTES, heavyWork } from './util/heavy.ts';
import { memoryGuard } from './util/memory-pressure.ts';
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
    exports: new RateLimiter(100_000, 100_000),
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

/** A signed-in user's board with one stored table of `rows` rows of about 70 bytes each. */
async function bigFileBoard(email: string, rows: number) {
  const cookie = await login(email);
  const { id, auth } = await withReference('f_large', cookie);
  const up = await call(`/api/dashboards/${id}/files`, {
    body: {
      name: 'large.json',
      format: 'table',
      fileId: 'f_large',
      content: packed(
        [
          { name: 'n', type: 'number' },
          { name: 's', type: 'string' },
        ],
        Array.from({ length: rows }, (_, i) => [i, `row ${i} ${'x'.repeat(50)}`]),
      ),
    },
    ...auth,
  });
  expect(up.status).toBe(201);
  return { id, auth, storedBytes: up.json.storedBytes as number };
}

/** A public document of about 55 KB, over the size from which response bodies count against the budget. */
async function largeDocBoard(email: string) {
  const cookie = await login(email);
  const id = (await call('/api/dashboards', { body: { title: 'Wide doc', visibility: 'public' }, cookie }))
    .json.envelope.meta.id as string;
  const rows = Array.from({ length: 600 }, (_, i) => ({ a: `${i} ${'x'.repeat(80)}` }));
  const ops = await call(`/api/dashboards/${id}/ops`, {
    body: { ops: [{ op: 'addDataset', dataset: { id: 'x', name: 'X', source: { kind: 'inline', rows } } }] },
    cookie,
  });
  expect(ops.status).toBe(200);
  return id;
}

/** Simulates a 384 MB container at `fraction` of its limit (see memory.test.ts). */
function pressure(fraction: number) {
  const limit = 384 * 1024 * 1024;
  memoryGuard.configure({
    reader: () => ({ usedBytes: fraction * limit, limitBytes: limit, source: 'cgroup v2' }),
    sampleMs: 0,
    collect: () => {},
    log: () => {},
  });
}

describe('export stream', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    memoryGuard.configure({ reader: null });
  });

  it('loads a large file in the heavy turn and hands it out in small slices within the response budget', async () => {
    const { id, auth, storedBytes } = await bigFileBoard('heavy-export@example.com', 20_000);
    expect(storedBytes).toBeGreaterThanOrEqual(HEAVY_FILE_BYTES);
    // The upload left the table in the cache; an export usually finds it on disk.
    deps.data.dropCaches();
    const heavy = vi.spyOn(heavyWork, 'run');
    const res = await raw(`/api/dashboards/${id}/export`, auth);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const chunks: Uint8Array[] = [];
    let held = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      held = Math.max(held, deps.wire.budget.stats().bytes);
    }
    expect(heavy).toHaveBeenCalled();
    expect(Math.max(...chunks.map((c) => c.byteLength))).toBeLessThanOrEqual(64 * 1024);
    // One part of the table at a time is held, never the whole file.
    expect(held).toBeGreaterThan(0);
    expect(held).toBeLessThan(storedBytes);
    const exp = readExport(JSON.parse(Buffer.concat(chunks).toString()));
    expect(exp.files).toHaveLength(1);
    expect(exp.files[0]!.data).toHaveLength(20_000);
    expect(exp.files[0]!.data[19_999]).toEqual([19_999, `row 19999 ${'x'.repeat(50)}`]);
    expect(deps.wire.budget.stats()).toEqual({ bytes: 0, bodies: 0, waiting: 0, waitingBytes: 0 });
  });

  it('gives the budget back when the client goes away', async () => {
    const { id, auth } = await bigFileBoard('cancel-export@example.com', 20_000);
    const res = await raw(`/api/dashboards/${id}/export`, auth);
    const reader = res.body!.getReader();
    // The document is small and costs nothing; the first part of the table is held until it has been read.
    for (let i = 0; i < 10 && deps.wire.budget.stats().bytes === 0; i++) await reader.read();
    expect(deps.wire.budget.stats().bytes).toBeGreaterThan(0);
    await reader.cancel();
    expect(deps.wire.budget.stats()).toEqual({ bytes: 0, bodies: 0, waiting: 0, waitingBytes: 0 });
  });

  it('counts one document exported by many readers once', async () => {
    const id = await largeDocBoard('shared-export@example.com');
    const readers = await Promise.all(
      [1, 2, 3].map(async () => (await raw(`/api/dashboards/${id}/export`)).body!.getReader()),
    );
    for (const r of readers) await r.read();
    const stats = deps.wire.budget.stats();
    expect(stats.bodies).toBe(1);
    expect(stats.bytes).toBeGreaterThan(32 * 1024);
    for (const r of readers) await r.cancel();
    expect(deps.wire.budget.stats().bytes).toBe(0);
  });

  it('refuses exports before answering when a client asks too often, the budget is full or memory is short', async () => {
    const id = await largeDocBoard('admit-export@example.com');
    const limited = createApp({ ...deps, limits: { ...deps.limits, exports: new RateLimiter(1, 1) } });
    const first = await limited.request(`${BASE}/api/dashboards/${id}/export`);
    expect(first.status).toBe(200);
    await first.text();
    const second = await limited.request(`${BASE}/api/dashboards/${id}/export`);
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBeTruthy();
    expect(((await second.json()) as { error: string }).error).toMatch(
      /^Too many exports from you; try again in \d+ s$/,
    );

    const full = createApp({
      ...deps,
      wire: new ResultWire({
        budget: new ByteBudget({
          maxBytes: 1024,
          maxBytesPerClient: 1024,
          maxQueue: 0,
          maxQueuedPerClient: 0,
          maxWaitMs: 10,
          retryAfterSec: 2,
        }),
      }),
    });
    const busy = await full.request(`${BASE}/api/dashboards/${id}/export`);
    expect(busy.status).toBe(503);
    expect(busy.headers.get('retry-after')).toBe('2');

    const { id: withFiles, auth } = await bigFileBoard('pressure-export@example.com', 10);
    pressure(0.9);
    expect((await raw(`/api/dashboards/${withFiles}/export`, auth)).status).toBe(503);
    // The document alone takes no heavy work.
    const docOnly = await raw(`/api/dashboards/${id}/export`);
    expect(docOnly.status).toBe(200);
    await docOnly.text();
  });
});

const folders = () => readdirSync(join(dir, 'dashboards')).length;

const contentOf = (f: DashboardExport['files'][number]) =>
  JSON.stringify({ columns: f.columns, data: f.data });
const declared = (exp: DashboardExport) =>
  exp.files.map((f) => ({
    id: f.id,
    name: f.name,
    rows: f.data.length,
    columns: f.columns.length,
    bytes: Buffer.byteLength(contentOf(f)),
  }));

/** What the web app does: create from the document, then upload every file under its id. */
async function importAs(exp: DashboardExport, auth: { cookie?: string } = {}) {
  const created = await call('/api/dashboards/import', {
    body: { doc: exp.doc, files: declared(exp) },
    ...auth,
  });
  if (created.status !== 201) return { created };
  const id = created.json.envelope.meta.id as string;
  const editKey = created.json.editKey as string | undefined;
  const as = { ...auth, ...(editKey ? { key: editKey } : {}) };
  for (const f of exp.files) {
    const up = await call(`/api/dashboards/${id}/files`, {
      body: { name: f.name, format: 'table', fileId: f.id, content: contentOf(f) },
      ...as,
    });
    expect(up.status).toBe(201);
  }
  return { created, id, as };
}

describe('import', () => {
  it('round-trips a dashboard: same document, same ids, same data and column types', async () => {
    const board = await shopBoard('exporter@example.com');
    const exp = readExport(JSON.parse((await exportOf(board.id, { cookie: board.cookie })).text));
    const cookie = await login('importer@example.com');
    const { created, id, as } = await importAs(exp, { cookie });
    expect(created.status).toBe(201);
    expect(created.json.envelope.meta.visibility).toBe('private');
    expect(created.json.envelope.doc).toEqual(exp.doc);
    for (const dataset of ['temps', 'flags']) {
      const before = await call(`/api/dashboards/${board.id}/data/${dataset}`, { cookie: board.cookie });
      const after = await call(`/api/dashboards/${id}/data/${dataset}`, as!);
      expect(after.json.table).toEqual(before.json.table);
    }
    const versions = await call(`/api/dashboards/${id}/versions`, as!);
    expect(versions.json[0].changes[0]).toBe('Imported from a Patchbay export file');
  });

  it('imports the same file twice as two independent dashboards', async () => {
    const board = await shopBoard('twice-exporter@example.com');
    const exp = readExport(JSON.parse((await exportOf(board.id, { cookie: board.cookie })).text));
    const first = await importAs(exp);
    const second = await importAs(exp);
    expect(first.id).not.toBe(second.id);
    for (const r of [first, second]) {
      expect((await call(`/api/dashboards/${r.id}/data/temps`, r.as!)).json.table.rows).toHaveLength(3);
    }
  });

  it('always removes secret references, for signed-in and anonymous importers, and says so', async () => {
    const crafted = (secretId: string) => ({
      schemaVersion: 1,
      title: 'Crafted',
      datasets: [
        {
          id: 'orders',
          name: 'Orders',
          source: { kind: 'http', url: 'https://api.example.com/v1/orders', secrets: [secretId] },
        },
      ],
    });
    const cookie = await login('crafted@example.com');
    // The importer's own secret is removed too: the file may come from anywhere.
    const own = await call('/api/secrets', {
      body: {
        name: 'Own key',
        sendTo: 'https://api.example.com/v1/',
        placement: 'bearer',
        value: 'val_0123456789abcdef',
      },
      cookie,
    });
    expect(own.status).toBe(201);
    for (const [auth, secretId] of [
      [{ cookie }, own.json.id as string],
      [{}, 'sec_AAAAAAAAAAAAAAAA'],
    ] as const) {
      const res = await call('/api/dashboards/import', { body: { doc: crafted(secretId) }, ...auth });
      expect(res.status).toBe(201);
      expect(res.json.envelope.doc.datasets[0].source).toEqual({
        kind: 'http',
        url: 'https://api.example.com/v1/orders',
      });
      expect(res.json.notes[0]).toBe(
        'Removed secret references from "Orders": secrets belong to their owner. Add your own under Credentials.',
      );
    }
  });

  it('refuses what cannot fit before anything is created', async () => {
    const doc = {
      schemaVersion: 1,
      title: 'Big',
      datasets: [{ id: 'big', name: 'Big', source: { kind: 'upload', fileId: 'f_big' } }],
    };
    const file = { id: 'f_big', name: 'big.csv', rows: 600, columns: 2, bytes: 10_000 };
    const before = folders();
    const anon = await call('/api/dashboards/import', { body: { doc, files: [file] } });
    expect(anon.status).toBe(400);
    expect(anon.json.error).toMatch(/^File "big\.csv": The file has 600 rows × 2 columns; /);
    expect(anon.json.error).toContain('Dashboards of signed-in users accept up to 500,000 cells.');
    const cookie = await login('fits@example.com');
    const huge = await call('/api/dashboards/import', {
      body: { doc, files: [{ ...file, bytes: MAX_TABLE_FILE_BYTES + 1 }] },
      cookie,
    });
    expect(huge.status).toBe(400);
    expect(huge.json.code).toBe('IMPORT_FILE_TOO_LARGE');
    expect(EXPORT_MAX_FILES).toBe(MAX_FILES);
    const many = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ ...file, id: `f_${i}` }));
    const wide = await call('/api/dashboards/import', {
      body: { doc, files: [{ ...file, rows: 1, columns: 501 }] },
      cookie,
    });
    expect(wide.status).toBe(400);
    expect(wide.json.error).toMatch(/^File "big\.csv": The file has 501 columns; /);
    const tooMany = await call('/api/dashboards/import', { body: { doc, files: many }, cookie });
    expect(tooMany.status).toBe(400);
    expect(tooMany.json.error).toContain(`up to ${MAX_FILES} files`);
    const stray = await call('/api/dashboards/import', {
      body: { doc, files: [{ ...file, id: 'f_x' }] },
      cookie,
    });
    expect(stray.json.code).toBe('FILE_NOT_REFERENCED');
    expect(folders()).toBe(before);
  });

  it('refuses files that together exceed the storage of one dashboard', async () => {
    const doc = {
      schemaVersion: 1,
      title: 'Four',
      datasets: [1, 2, 3, 4].map((n) => ({
        id: `d${n}`,
        name: `D${n}`,
        source: { kind: 'upload', fileId: `f_${n}` },
      })),
    };
    const files = [1, 2, 3, 4].map((n) => ({
      id: `f_${n}`,
      name: `${n}.json`,
      rows: 10,
      columns: 2,
      bytes: MAX_TABLE_FILE_BYTES,
    }));
    const cookie = await login('totals@example.com');
    const before = folders();
    const res = await call('/api/dashboards/import', { body: { doc, files }, cookie });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('of uploaded data');
    expect(folders()).toBe(before);
  });

  it('refuses documents a save would refuse, before anything is created', async () => {
    const cookie = await login('rules@example.com');
    const before = folders();
    const newer = await call('/api/dashboards/import', {
      body: { doc: { schemaVersion: 2, title: 'X' } },
      cookie,
    });
    expect(newer.status).toBe(400);
    expect(newer.json.error).toMatch(/^The dashboard in this file is not valid: /);
    const unknown = await call('/api/dashboards/import', {
      body: {
        doc: {
          schemaVersion: 1,
          title: 'X',
          datasets: [{ id: 'x', name: 'X', source: { kind: 'connector', connector: 'nope.nothing' } }],
        },
      },
      cookie,
    });
    expect(unknown.status).toBe(400);
    expect(unknown.json.error).toContain('Unknown connector "nope.nothing"');
    const longText = await call('/api/dashboards/import', {
      body: {
        doc: {
          schemaVersion: 1,
          title: 'X',
          datasets: [{ id: 'x', name: 'X', source: { kind: 'inline', rows: [{ a: 'x'.repeat(5000) }] } }],
        },
      },
      cookie,
    });
    expect(longText.json.code).toBe('INLINE_VALUE_TOO_LONG');
    expect(folders()).toBe(before);
  });

  it('refuses a document by the same rules and with the same answer as operations that would build it', async () => {
    const cookie = await login('same-rules@example.com');
    const inline = (id: string, rows: unknown[]) => ({ id, name: id, source: { kind: 'inline', rows } });
    const wide = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`c${i}`, i]));
    // Half of a document over 1,000,000 bytes each: a request body is limited to 1 MB.
    const half = Array.from({ length: 510 }, (_, i) => ({ a: `${i}`.padEnd(990) }));
    const cases = [
      { code: 'INLINE_TOO_WIDE', datasets: [inline('x', [wide])] },
      { code: 'INLINE_VALUE_TOO_LONG', datasets: [inline('x', [{ a: 'x'.repeat(5000) }])] },
      { code: 'DOCUMENT_TOO_LARGE', datasets: [inline('x', half), inline('y', half)] },
    ];
    for (const { code, datasets } of cases) {
      const created = await call('/api/dashboards', { body: { title: 'Rules' }, cookie });
      const id = created.json.envelope.meta.id as string;
      let byOps: Awaited<ReturnType<typeof call>> | undefined;
      for (const dataset of datasets) {
        byOps = await call(`/api/dashboards/${id}/ops`, {
          body: { ops: [{ op: 'addDataset', dataset }] },
          cookie,
        });
      }
      const before = folders();
      const byImport = await call('/api/dashboards/import', {
        body: { doc: { ...created.json.envelope.doc, datasets } },
        cookie,
      });
      expect(byOps!.json.code).toBe(code);
      expect(byImport.status).toBe(byOps!.status);
      expect(byImport.json.code).toBe(code);
      expect(byImport.json.error).toBe(byOps!.json.error);
      expect(folders()).toBe(before);
    }
  });

  it('raises a refresh below the source minimum, like a save', async () => {
    const res = await call('/api/dashboards/import', {
      body: {
        doc: {
          schemaVersion: 1,
          title: 'Fast',
          datasets: [{ id: 'x', name: 'X', source: { kind: 'inline', rows: [{ a: 1 }] }, refreshSec: 5 }],
        },
      },
    });
    expect(res.status).toBe(201);
    expect(res.json.envelope.doc.datasets[0].refreshSec).toBe(0);
    expect(res.json.notes.join(' ')).toContain('Turned off live refresh');
  });
});

describe('import on a server that fetches URLs only for signed-in owners', () => {
  let urlDir: string;
  let urlDeps: Deps;
  let urlApp: ReturnType<typeof createApp>;

  beforeAll(async () => {
    urlDir = mkdtempSync(join(tmpdir(), 'patchbay-transfer-urls-'));
    urlDeps = await createDeps(
      loadConfig({
        NODE_ENV: 'test',
        DATA_DIR: urlDir,
        OFFLINE: '1',
        PUBLIC_URL: BASE,
        URL_SOURCES: 'signed-in',
      }),
    );
    urlApp = createApp(urlDeps);
  });

  afterAll(async () => {
    urlDeps.hub.close();
    await urlDeps.pipeline.close();
    urlDeps.db.close();
    rmSync(urlDir, { recursive: true, force: true });
  });

  const post = async (path: string, body: unknown, key?: string) => {
    const res = await urlApp.request(`${BASE}${path}`, {
      method: 'POST',
      headers: { origin: BASE, 'content-type': 'application/json', ...(key ? { 'x-edit-key': key } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };

  it('refuses an anonymous import with an http source like a save, and creates nothing', async () => {
    const dataset = {
      id: 'api',
      name: 'API',
      source: { kind: 'http', url: 'https://api.example.com/data.json' },
    };
    const created = await post('/api/dashboards', {});
    expect(created.status).toBe(201);
    const byOps = await post(
      `/api/dashboards/${created.json.envelope.meta.id}/ops`,
      { ops: [{ op: 'addDataset', dataset }] },
      created.json.editKey,
    );
    expect(byOps.status).toBe(400);
    const count = readdirSync(join(urlDir, 'dashboards')).length;
    const byImport = await post('/api/dashboards/import', {
      doc: { schemaVersion: 1, title: 'API', datasets: [dataset] },
    });
    expect(byImport.status).toBe(400);
    expect(byImport.json.error).toBe(byOps.json.error);
    expect(byImport.json.error).toMatch(/^This server loads data from URLs/);
    expect(readdirSync(join(urlDir, 'dashboards')).length).toBe(count);
  });
});
