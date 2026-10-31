/**
 * Data responses stay bounded in bytes whatever the data looks like: long column names, results a pipeline blew up,
 * many readers at once. Each of these ran a 384 MB container out of memory with a single small upload.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeTable } from '@patchbay/core';
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
  dir = mkdtempSync(join(tmpdir(), 'patchbay-responses-test-'));
  deps = await createDeps(
    loadConfig({
      NODE_ENV: 'test',
      DATA_DIR: dir,
      OFFLINE: '1',
      PUBLIC_URL: BASE,
      PIPELINE_WORKERS: '1',
    }),
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

afterAll(async () => {
  deps.hub.close();
  await deps.pipeline.close();
  deps.db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(path: string, init: { body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { origin: BASE, ...init.headers };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.request(`${BASE}${path}`, {
    method: init.body !== undefined ? 'POST' : 'GET',
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text), headers: res.headers };
}

/** An anonymous dashboard with one uploaded CSV as dataset `d`, plus the given pipeline. */
async function dashboardWith(csv: string, transforms: unknown[] = []) {
  const created = (await call('/api/dashboards', { body: {} })).json;
  const id = created.envelope.meta.id as string;
  const headers = { 'x-edit-key': created.editKey as string };
  const file = await call(`/api/dashboards/${id}/files`, { body: { name: 'f.csv', content: csv }, headers });
  expect(file.status).toBe(201);
  const source = { kind: 'upload', fileId: file.json.id };
  const saved = await call(`/api/dashboards/${id}/ops`, {
    body: { ops: [{ op: 'addDataset', dataset: { id: 'd', name: 'D', source, transforms } }] },
    headers,
  });
  expect(saved.status).toBe(200);
  return { id, headers, source };
}

describe('data responses', () => {
  // 20 columns with 60-character names, 5,000 rows of digits: a 120 KB file, about 7 MB as rows of objects.
  const names = Array.from({ length: 20 }, (_, i) => `${i}_${'n'.repeat(58)}`);
  const wideCsv = `${names.join(',')}\n${`${names.map((_, i) => i % 10).join(',')}\n`.repeat(5_000)}`;

  it('send long column names once with rows as arrays, and refuse them as objects', async () => {
    const { id } = await dashboardWith(wideCsv);
    const objects = await call(`/api/dashboards/${id}/data/d`);
    expect(objects.status).toBe(200);
    expect(objects.text.length).toBeLessThan(10_000);
    expect(objects.json.table.rows).toEqual([]);
    expect(objects.json.table.columns.map((c: { name: string }) => c.name)).toEqual(names);
    expect(objects.json.error).toMatch(/too large to send.*more than the 4 MB a dataset may send/);

    const arrays = await call(`/api/dashboards/${id}/data/d?rows=arrays`);
    expect(arrays.status).toBe(200);
    expect(arrays.text.length).toBeLessThan(500_000);
    expect(arrays.json.error).toBeUndefined();
    const table = decodeTable(arrays.json.table);
    expect(table.rows).toHaveLength(5_000);
    expect(table.rows[0]).toEqual(Object.fromEntries(names.map((n, i) => [n, i % 10])));
  });

  it('refuse a result a pipeline made too large, with the same error for every reader', async () => {
    // 3,000 rows of 100 characters, each concatenated 17 times: about 5 MB however it is sent.
    const csv = `s\n${`${'abcdefghij'.repeat(10)}\n`.repeat(3_000)}`;
    const expr = `concat(${Array(17).fill('s').join(', ')})`;
    const { id, headers, source } = await dashboardWith(csv, [{ type: 'derive', as: 'big', expr }]);
    for (const query of ['', '?rows=arrays']) {
      const res = await call(`/api/dashboards/${id}/data/d${query}`);
      expect(res.status).toBe(200);
      expect(res.text.length).toBeLessThan(10_000);
      expect(res.json.error).toMatch(/too large to send.*filter or limit rows/);
      expect(res.json.table.columns.map((c: { name: string }) => c.name)).toEqual(['s', 'big']);
    }
    // What the snapshot renderer and MCP tools read is the same error.
    const doc = (await call(`/api/dashboards/${id}`)).json.doc;
    const result = await deps.data.resolve({ id, ownerId: null }, doc.datasets[0]);
    expect(result.error).toMatch(/too large to send/);
    expect(result.table.rows).toEqual([]);

    // The editor's preview keeps 500 rows, which fit; with a limit step the saved dataset would fit as well.
    const preview = await call(`/api/dashboards/${id}/preview?rows=arrays`, {
      body: { dataset: { source, transforms: [{ type: 'derive', as: 'big', expr }] } },
      headers,
    });
    expect(preview.status).toBe(200);
    expect(preview.json.result).toMatchObject({ truncated: true });
    expect(preview.json.result.table.rows).toHaveLength(500);
    const limited = await call(`/api/dashboards/${id}/preview?rows=arrays`, {
      body: {
        dataset: {
          source,
          transforms: [
            { type: 'derive', as: 'big', expr },
            { type: 'limit', n: 100 },
          ],
        },
      },
      headers,
    });
    expect(limited.json.result.error).toBeUndefined();
    expect(decodeTable(limited.json.result.table).rows).toHaveLength(100);
    expect(limited.json.profile.rows).toBe(100);
  });

  it('answer many concurrent readers from one shared body and give the budget back', async () => {
    const { id } = await dashboardWith(wideCsv);
    const responses = await Promise.all(
      Array.from({ length: 64 }, () => call(`/api/dashboards/${id}/data/d?rows=arrays`)),
    );
    expect(new Set(responses.map((r) => r.status))).toEqual(new Set([200]));
    expect(new Set(responses.map((r) => r.text)).size).toBe(1);
    expect(responses[0]!.headers.get('content-length')).toBe(String(Buffer.byteLength(responses[0]!.text)));
    expect(deps.wire.budget.stats()).toEqual({ bytes: 0, bodies: 0, waiting: 0 });
  });
});
