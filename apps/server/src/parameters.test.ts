/**
 * Dashboard filters (proposal 0010) end to end over REST (and, from the MCP task on, over MCP): views of the data,
 * suggest, preview and snapshot routes. Upstream-level checks (one fetch per value) live in services/view.test.ts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  dir = mkdtempSync(join(tmpdir(), 'patchbay-filters-test-'));
  deps = await createDeps(
    loadConfig({
      NODE_ENV: 'test',
      DATA_DIR: dir,
      OFFLINE: '1',
      DEV_LOGIN: '1',
      PUBLIC_URL: BASE,
      PIPELINE_WORKERS: '0',
    }),
  );
  // Tests write and draw far faster than people; the budgets themselves are tested in proxy.test.ts.
  deps.limits.writes = new RateLimiter(100_000, 100_000);
  deps.limits.mcp = new RateLimiter(100_000, 100_000);
  deps.limits.snapshots = new RateLimiter(100_000, 100_000);
  app = createApp(deps);
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

const REGION = {
  id: 'region',
  label: 'Region',
  type: 'select',
  options: [
    { value: 'eu', label: 'EU' },
    { value: 'us', label: 'US' },
  ],
  all: 'All regions',
  default: null,
};
const DAYS = {
  id: 'days',
  label: 'Days',
  type: 'select',
  options: [{ value: 30 }, { value: 90 }],
  default: 30,
};
const SALES = {
  id: 'sales',
  name: 'Sales',
  source: {
    kind: 'inline',
    rows: [
      { region: 'eu', v: 1 },
      { region: 'us', v: 2 },
    ],
  },
  transforms: [{ type: 'filter', expr: '$param.region == null || region == $param.region' }],
};
const BARS = {
  id: 'bars',
  type: 'chart',
  datasetId: 'sales',
  config: { kind: 'bar', x: 'region', y: ['v'] },
};

/** An anonymous public dashboard with the given filters and datasets (by default two filters, a dataset, a chart). */
async function filtered(
  ops: unknown[] = [
    { op: 'addParameter', parameter: REGION },
    { op: 'addParameter', parameter: DAYS },
    { op: 'addDataset', dataset: SALES },
    { op: 'addWidget', widget: BARS },
  ],
) {
  const created = await call('/api/dashboards', { body: {} });
  const id = created.json.envelope.meta.id as string;
  const headers = { 'x-edit-key': created.json.editKey as string };
  const applied = await call(`/api/dashboards/${id}/ops`, { body: { ops }, headers });
  expect(applied.status, JSON.stringify(applied.json)).toBe(200);
  return { id, headers };
}

describe('views over REST', () => {
  it('filters rows by the values in the query, and answers 400 for a value the filter does not offer', async () => {
    const { id } = await filtered();
    const rows = async (query: string) =>
      (await call(`/api/dashboards/${id}/data/sales${query}`)).json.table.rows.map(
        (r: { region: string }) => r.region,
      );
    expect(await rows('')).toEqual(['eu', 'us']);
    expect(await rows('?p.region=eu')).toEqual(['eu']);
    expect(await rows('?p.region=*&p.gone=1')).toEqual(['eu', 'us']);
    // Prototype names are no filter ids: ignored like any unknown one.
    expect(await rows('?p.__proto__=eu&p.constructor=us')).toEqual(['eu', 'us']);
    const bad = await call(`/api/dashboards/${id}/data/sales?p.region=xx`);
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('Filter "region" has no value "xx"; choose one of eu, us, or * for all');
  });

  it('reads a filter named like a member of every object from the query, and only from there', async () => {
    const { id } = await filtered([
      { op: 'addParameter', parameter: { ...REGION, id: 'constructor', label: 'Kind' } },
      {
        op: 'addDataset',
        dataset: {
          ...SALES,
          transforms: [
            { type: 'filter', expr: '$param.constructor == null || region == $param.constructor' },
          ],
        },
      },
    ]);
    const rows = async (query: string) =>
      (await call(`/api/dashboards/${id}/data/sales${query}`)).json.table.rows.map(
        (r: { region: string }) => r.region,
      );
    expect(await rows('')).toEqual(['eu', 'us']);
    expect(await rows('?p.constructor=us')).toEqual(['us']);
    expect(await rows('?p.constructor=*')).toEqual(['eu', 'us']);
    const bad = await call(`/api/dashboards/${id}/data/sales?p.constructor=Object`);
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe(
      'Filter "constructor" has no value "Object"; choose one of eu, us, or * for all',
    );
  });

  it('suggests widgets and draws snapshots for a view', async () => {
    const { id } = await filtered();
    const suggested = await call(`/api/dashboards/${id}/suggest/sales?p.region=us`);
    expect(suggested.status).toBe(200);
    expect(suggested.json.profile.rows).toBe(1);
    const shot = await call(`/api/dashboards/${id}/snapshot.png?p.region=eu`);
    expect(shot.status).toBe(200);
    expect(shot.headers.get('content-type')).toBe('image/png');
    expect((await call(`/api/dashboards/${id}/snapshot.png?p.region=xx`)).status).toBe(400);
  });

  it('previews a draft with the values of the view, bound before anything judges it', async () => {
    const { id, headers } = await filtered();
    const preview = (body: Record<string, unknown>) =>
      call(`/api/dashboards/${id}/preview`, { body, headers });
    const draft = {
      source: { kind: 'inline', rows: [{ region: 'eu' }, { region: 'us' }] },
      transforms: [{ type: 'filter', expr: 'region == $param.region' }],
    };
    expect((await preview({ dataset: draft, parameters: { region: 'us' } })).json.result.table.rows).toEqual([
      { region: 'us' },
    ]);
    expect((await preview({ dataset: draft })).json.result.table.rows).toEqual([]);
    const unknown = await preview({
      dataset: { ...draft, transforms: [{ type: 'filter', expr: '$param.nope == 1' }] },
    });
    expect(unknown.status).toBe(400);
    expect(unknown.json.error).toBe(
      'Dataset "preview" (filter step): unknown filter "nope"; declared filters: region, days',
    );
    // The save rules hold for a draft too: the binder trusts them and would put "All" into a path as nothing.
    const path = await preview({
      dataset: { source: { kind: 'http', url: 'https://api.example.com/$param.region/sales' } },
    });
    expect(path.status).toBe(400);
    expect(path.json.error).toBe(
      'Dataset "preview" (URL path): filter "region" offers "All", which no path segment can mean; use it in the query string',
    );
    expect((await preview({ dataset: draft, parameters: { region: 'xx' } })).status).toBe(400);
    // A connector parameter that is a reference is validated once bound: "$param.days" is no number.
    const connector = await preview({
      dataset: { source: { kind: 'connector', connector: 'demo.sales', params: { days: '$param.days' } } },
      parameters: { days: '90' },
    });
    expect(connector.status, JSON.stringify(connector.json)).toBe(200);
    expect(connector.json.result.table.rows.length).toBeGreaterThan(0);
  });

  it('sends no referrer, so a view link opened from a dashboard does not carry its values', async () => {
    const res = await app.request(`${BASE}/api/connectors`);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});
