/**
 * The memory guard (util/memory-pressure.ts) through the REST API, with memory use simulated: heavy routes answer
 * 503 with Retry-After under pressure, while the health check and reads that answer from memory keep working.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp, createDeps } from './app.ts';
import { loadConfig } from './config.ts';
import type { Deps } from './context.ts';
import { heavyWork } from './util/heavy.ts';
import { MemoryPressureError, memoryGuard } from './util/memory-pressure.ts';
import { RateLimiter } from './util/rate-limit.ts';

const BASE = 'http://localhost:8787';
const LIMIT = 384 * 1024 * 1024;
let dir: string;
let deps: Deps;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay-memory-test-'));
  deps = await createDeps(
    loadConfig({ NODE_ENV: 'test', DATA_DIR: dir, OFFLINE: '1', PUBLIC_URL: BASE, PIPELINE_WORKERS: '1' }),
  );
  const generous = () => new RateLimiter(100_000, 100_000);
  app = createApp({
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
});

afterEach(() => memoryGuard.configure({ reader: null }));

afterAll(async () => {
  deps.hub.close();
  await deps.pipeline.close();
  deps.db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Simulates the container at `fraction` of its limit, sampled on every check. */
function pressure(fraction: number) {
  memoryGuard.configure({
    reader: () => ({ usedBytes: fraction * LIMIT, limitBytes: LIMIT, source: 'cgroup v2' }),
    sampleMs: 0,
    collect: () => {},
    log: () => {},
  });
}

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

const csv = (rows: number) =>
  ['n,label,value', ...Array.from({ length: rows }, (_, i) => `${i},row ${i},${(i * 7919) % 1000}`)].join(
    '\n',
  );

/** An anonymous dashboard with an uploaded table of 2,000 rows (about 60 KB as JSON) and a widget on it. */
async function dashboard() {
  const { envelope, editKey } = (await call('/api/dashboards', { body: {} })).json;
  const id = envelope.meta.id as string;
  const headers = { 'x-edit-key': editKey as string };
  const up = await call(`/api/dashboards/${id}/files`, {
    body: { name: 't.csv', content: csv(2000) },
    headers,
  });
  expect(up.status).toBe(201);
  const ops = await call(`/api/dashboards/${id}/ops`, {
    headers,
    body: {
      ops: [
        { op: 'addDataset', dataset: { id: 'u', name: 'u', source: { kind: 'upload', fileId: up.json.id } } },
        {
          op: 'addWidget',
          widget: {
            id: 'w',
            type: 'chart',
            title: 'c',
            datasetId: 'u',
            config: { kind: 'line', x: 'n', y: ['value'] },
          },
          position: { x: 0, y: 0, w: 6, h: 4 },
        },
      ],
    },
  });
  expect(ops.status).toBe(200);
  return { id, headers };
}

const expectRefused = (res: { status: number; headers: Headers; json: any }, retryAfter: string) => {
  expect(res.status).toBe(503);
  expect(res.headers.get('retry-after')).toBe(retryAfter);
  expect(res.json.error).toContain('low on memory');
};

describe('memory guard', () => {
  it('admits everything while memory is below the soft threshold', async () => {
    pressure(0.5);
    const d = await dashboard();
    expect((await call(`/api/dashboards/${d.id}/snapshot.png?widget=w`)).status).toBe(200);
  });

  it('above soft refuses new heavy work and keeps light reads, cached results and the health check', async () => {
    const d = await dashboard();
    // Served once before the pressure: its serialised bytes are cached.
    expect((await call(`/api/dashboards/${d.id}/data/u?rows=arrays`)).status).toBe(200);
    pressure(0.85);

    expectRefused(
      await call(`/api/dashboards/${d.id}/files`, {
        body: { name: 'b.csv', content: csv(10) },
        headers: d.headers,
      }),
      '5',
    );
    expectRefused(await call(`/api/dashboards/${d.id}/snapshot.png?widget=w&theme=dark`), '5');
    // A large result not serialised yet (the other rows format) would be a new copy of the table.
    expectRefused(await call(`/api/dashboards/${d.id}/data/u`), '5');

    expect((await call('/healthz')).status).toBe(200);
    expect((await call(`/api/dashboards/${d.id}`)).status).toBe(200);
    expect((await call(`/api/dashboards/${d.id}/data/u?rows=arrays`)).status).toBe(200);
    expect((await call('/api/templates')).status).toBe(200);
    // Small writes are not heavy work.
    const write = await call(`/api/dashboards/${d.id}/ops`, {
      headers: d.headers,
      body: { ops: [{ op: 'setMeta', title: 'still editable' }] },
    });
    expect(write.status).toBe(200);
    expect(memoryGuard.state()).toMatchObject({ level: 'soft', refused: { soft: 3, hard: 0 } });
  });

  it('refuses pipelines that need a worker above soft; inline ones still run', async () => {
    const d = await dashboard();
    const fileId = (await call(`/api/dashboards/${d.id}/files`, { headers: d.headers })).json[0].id;
    const withSource = (id: string, transforms: unknown[]) =>
      call(`/api/dashboards/${d.id}/ops`, {
        headers: d.headers,
        body: {
          ops: [
            { op: 'addDataset', dataset: { id, name: id, source: { kind: 'upload', fileId }, transforms } },
          ],
        },
      });
    pressure(0.85);
    expect((await withSource('f', [{ type: 'filter', expr: 'value > 500' }])).status).toBe(200);
    expectRefused(await call(`/api/dashboards/${d.id}/data/f?rows=arrays`), '5');
    expect((await withSource('l', [{ type: 'limit', n: 5 }])).status).toBe(200);
    expect((await call(`/api/dashboards/${d.id}/data/l?rows=arrays`)).status).toBe(200);
  });

  it('above hard also refuses writes and new live streams, never the health check or plain reads', async () => {
    const d = await dashboard();
    pressure(0.95);
    expectRefused(
      await call(`/api/dashboards/${d.id}/ops`, {
        headers: d.headers,
        body: { ops: [{ op: 'setMeta', title: 'later' }] },
      }),
      '10',
    );
    expectRefused(await call(`/api/dashboards/${d.id}/events`), '10');
    expectRefused(await call('/api/dashboards', { body: {} }), '10');
    expect((await call('/healthz')).status).toBe(200);
    expect((await call(`/api/dashboards/${d.id}`)).status).toBe(200);
    expect((await call('/api/me')).status).toBe(200);
  });

  it('admits again once memory is back below the threshold', async () => {
    const d = await dashboard();
    pressure(0.85);
    expectRefused(await call(`/api/dashboards/${d.id}/snapshot.png?widget=w`), '5');
    pressure(0.5);
    expect((await call(`/api/dashboards/${d.id}/snapshot.png?widget=w`)).status).toBe(200);
  });

  it('refuses a heavy job whose turn comes under pressure, but never one inside a running turn', async () => {
    let release!: () => void;
    const first = heavyWork.run(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve('first');
        }),
    );
    const second = heavyWork.run(async () => 'second');
    await new Promise((resolve) => setTimeout(resolve, 5));
    pressure(0.85);
    const nested = heavyWork.run(async () => 'never');
    await expect(nested).rejects.toBeInstanceOf(MemoryPressureError);
    release();
    await expect(first).resolves.toBe('first');
    await expect(second).rejects.toBeInstanceOf(MemoryPressureError);

    memoryGuard.configure({ reader: null });
    const inside = await heavyWork.run(async () => {
      pressure(0.95);
      return heavyWork.run(async () => 'inside');
    });
    expect(inside).toBe('inside');
  });
});
