/**
 * The guards that keep a small public instance alive under ordinary traffic, through the REST API: upload cell
 * limits, refresh floors on every write path, the URL_SOURCES switch and the 503 answer of a saturated server.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, createDeps } from './app.ts';
import { loadConfig } from './config.ts';
import type { Deps } from './context.ts';
import { BusyError } from './util/gate.ts';
import { RateLimiter } from './util/rate-limit.ts';

const BASE = 'http://localhost:8787';
let dir: string;
let deps: Deps;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay-limits-test-'));
  deps = await createDeps(
    loadConfig({
      NODE_ENV: 'test',
      DATA_DIR: dir,
      OFFLINE: '1',
      DEV_LOGIN: '1',
      PUBLIC_URL: BASE,
      PIPELINE_WORKERS: '1',
      UPLOAD_MAX_CELLS: '4000',
      UPLOAD_MAX_CELLS_ANONYMOUS: '1000',
      URL_SOURCES: 'signed-in',
    }),
  );
  const generous = () => new RateLimiter(100_000, 100_000);
  app = createApp({
    ...deps,
    limits: { api: generous(), writes: generous(), auth: generous(), mcp: generous(), creates: generous() },
  });
});

afterAll(async () => {
  deps.hub.close();
  await deps.pipeline.close();
  deps.db.close();
  rmSync(dir, { recursive: true, force: true });
});

type Init = { method?: string; body?: unknown; headers?: Record<string, string> };
async function call(path: string, init: Init = {}) {
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
  return { status: res.status, json, headers: res.headers };
}

async function login(email: string) {
  const res = await app.request(`${BASE}/auth/dev`, {
    method: 'POST',
    headers: { origin: BASE, 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  return { cookie: res.headers.get('set-cookie')!.split(';')[0]! };
}

async function anonymous() {
  const { envelope, editKey } = (await call('/api/dashboards', { body: {} })).json;
  return { id: envelope.meta.id as string, doc: envelope.doc, headers: { 'x-edit-key': editKey as string } };
}

async function owned() {
  const auth = await login('owner@example.com');
  const { envelope } = (await call('/api/dashboards', { body: {}, headers: auth })).json;
  return { id: envelope.meta.id as string, doc: envelope.doc, headers: auth };
}

const csv = (rows: number, cols: number) =>
  [
    Array.from({ length: cols }, (_, i) => `c${i}`).join(','),
    ...Array.from({ length: rows }, () => Array.from({ length: cols }, (_, i) => i).join(',')),
  ].join('\n');

describe('uploads', () => {
  it('limits anonymous dashboards to fewer cells than owned ones, and says so', async () => {
    const anon = await anonymous();
    const big = csv(100, 20); // 2,000 cells
    const refused = await call(`/api/dashboards/${anon.id}/files`, {
      body: { name: 'big.csv', content: big },
      headers: anon.headers,
    });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toContain('up to 1,000 cells');
    expect(refused.json.error).toContain('signed-in users accept up to 4,000 cells');
    const mine = await owned();
    const ok = await call(`/api/dashboards/${mine.id}/files`, {
      body: { name: 'big.csv', content: big },
      headers: mine.headers,
    });
    expect(ok.status).toBe(201);
    expect(ok.json).toMatchObject({ rows: 100, columns: 20 });
    const tooBig = await call(`/api/dashboards/${mine.id}/files`, {
      body: { name: 'bigger.csv', content: csv(1000, 20) },
      headers: mine.headers,
    });
    expect(tooBig.status).toBe(400);
    expect(tooBig.json.error).toContain('more than');
  });

  it('lists files from their headers without parsing their tables or writing anything', async () => {
    const mine = await owned();
    const up = await call(`/api/dashboards/${mine.id}/files`, {
      body: { name: 'a.csv', content: csv(10, 2) },
      headers: mine.headers,
    });
    const files = join(deps.store.dir(mine.id), 'files');
    expect(readdirSync(files)).toEqual([`${up.json.id}.json`]);
    const read = vi.spyOn(deps.store, 'readFileTable');
    const listed = await call(`/api/dashboards/${mine.id}/files`, { headers: mine.headers });
    expect(listed.json).toEqual([up.json]);
    expect(readdirSync(files)).toEqual([`${up.json.id}.json`]);
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
  });
});

describe('refresh floors', () => {
  it('apply to full saves as well as to operations', async () => {
    const mine = await owned();
    const up = await call(`/api/dashboards/${mine.id}/files`, {
      body: { name: 'a.csv', content: csv(5, 2) },
      headers: mine.headers,
    });
    const datasets = [
      { id: 'up', name: 'Up', source: { kind: 'upload', fileId: up.json.id }, refreshSec: 5 },
      { id: 'web', name: 'Web', source: { kind: 'http', url: 'https://example.com/a.json' }, refreshSec: 1 },
      { id: 'rows', name: 'Rows', source: { kind: 'inline', rows: [{ a: 1 }] }, refreshSec: 10 },
    ];
    const put = await call(`/api/dashboards/${mine.id}`, {
      method: 'PUT',
      body: { doc: { ...mine.doc, datasets }, baseVersion: 1 },
      headers: mine.headers,
    });
    expect(put.status).toBe(200);
    const saved = Object.fromEntries(
      put.json.envelope.doc.datasets.map((d: { id: string; refreshSec: number }) => [d.id, d.refreshSec]),
    );
    expect(saved).toEqual({ up: 0, web: 30, rows: 0 });
    expect(put.json.changes.join('\n')).toMatch(/Turned off live refresh of dataset "Up"/);

    const ops = await call(`/api/dashboards/${mine.id}/ops`, {
      body: { ops: [{ op: 'updateDataset', id: 'web', set: { refreshSec: 2 } }] },
      headers: mine.headers,
    });
    expect(ops.json.envelope.doc.datasets.find((d: { id: string }) => d.id === 'web').refreshSec).toBe(30);
  });
});

describe('URL_SOURCES=signed-in', () => {
  const web = { id: 'web', name: 'Web', source: { kind: 'http', url: 'https://example.com/a.json' } };

  it('refuses URL sources on anonymous dashboards when saved, previewed or loaded', async () => {
    const anon = await anonymous();
    const add = await call(`/api/dashboards/${anon.id}/ops`, {
      body: { ops: [{ op: 'addDataset', dataset: web }] },
      headers: anon.headers,
    });
    expect(add.status).toBe(400);
    expect(add.json.error).toContain('only for dashboards with an owner');
    const feed = await call(`/api/dashboards/${anon.id}/ops`, {
      body: {
        ops: [
          { op: 'addDataset', dataset: { ...web, source: { kind: 'feed', url: 'https://example.com/f' } } },
        ],
      },
      headers: anon.headers,
    });
    expect(feed.status).toBe(400);
    const preview = await call(`/api/dashboards/${anon.id}/preview`, {
      body: { dataset: web },
      headers: anon.headers,
    });
    expect(preview.json.result.error).toContain('only for dashboards with an owner');

    // A document stored before the switch was turned on: the URL is still not fetched.
    const meta = (await deps.store.readMeta(anon.id))!;
    await deps.store.writeDoc(
      { ...meta, version: 2 },
      { ...anon.doc, datasets: [{ ...web, transforms: [], refreshSec: 0, accumulate: 0 }] },
      { kind: 'anonymous', label: 'test' },
      ['Saved before'],
    );
    const loaded = await call(`/api/dashboards/${anon.id}/data/web`);
    expect(loaded.json.error).toContain('only for dashboards with an owner');
  });

  it('lets owned dashboards save URL sources', async () => {
    const mine = await owned();
    const add = await call(`/api/dashboards/${mine.id}/ops`, {
      body: { ops: [{ op: 'addDataset', dataset: web }], dryRun: true },
      headers: mine.headers,
    });
    expect(add.status).toBe(200);
  });
});

describe('a saturated server', () => {
  it('answers 503 with Retry-After instead of queueing without limit', async () => {
    const anon = await anonymous();
    await call(`/api/dashboards/${anon.id}/ops`, {
      body: {
        ops: [{ op: 'addDataset', dataset: { id: 'x', name: 'X', source: { kind: 'inline', rows: [] } } }],
      },
      headers: anon.headers,
    });
    const busy = vi.spyOn(deps.data, 'resolve').mockRejectedValueOnce(new BusyError(undefined, 7));
    const res = await call(`/api/dashboards/${anon.id}/data/x`);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('7');
    busy.mockRestore();
  });
});
