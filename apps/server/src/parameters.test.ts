/**
 * Dashboard filters (proposal 0010) end to end over REST (and, from the MCP task on, over MCP): views of the data,
 * suggest, preview and snapshot routes. Upstream-level checks (one fetch per value) live in services/view.test.ts.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { DatasetResult } from '@patchbay/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

/** A select fed by the "country" column of "orders", a dataset filtered by it, and a table of that dataset. */
const COUNTRY_OPS = [
  {
    op: 'addDataset',
    dataset: {
      id: 'orders',
      name: 'Orders',
      source: {
        kind: 'inline',
        rows: [
          { country: 'SK', n: 1 },
          { country: 'AT', n: 2 },
        ],
      },
    },
  },
  {
    op: 'addParameter',
    parameter: {
      id: 'country',
      label: 'Country',
      type: 'select',
      optionsFrom: { dataset: 'orders', field: 'country' },
      all: 'All',
      default: null,
    },
  },
  {
    op: 'addDataset',
    dataset: {
      id: 'mine',
      name: 'Mine',
      source: { kind: 'dataset', id: 'orders' },
      transforms: [{ type: 'filter', expr: '$param.country == null || country == $param.country' }],
    },
  },
  { op: 'addWidget', widget: { id: 'table', type: 'table', datasetId: 'mine', config: {} } },
];

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

  it('reads a filter whose choices come from a dataset column, also in a preview', async () => {
    const { id, headers } = await filtered(COUNTRY_OPS);
    expect((await call(`/api/dashboards/${id}/data/mine?p.country=AT`)).json.table.rows).toEqual([
      { country: 'AT', n: 2 },
    ]);
    const bad = await call(`/api/dashboards/${id}/data/mine?p.country=DE`);
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('Filter "country" has no value "DE"; choose one of AT, SK, or * for all');
    const preview = await call(`/api/dashboards/${id}/preview`, {
      body: {
        dataset: {
          source: { kind: 'dataset', id: 'orders' },
          transforms: [{ type: 'filter', expr: 'country == $param.country' }],
        },
        parameters: { country: 'SK' },
      },
      headers,
    });
    expect(preview.json.result.table.rows).toEqual([{ country: 'SK', n: 1 }]);
  });

  it('draws a snapshot of a view whose filter takes its choices from data, and refuses a value it lacks', async () => {
    const { id } = await filtered(COUNTRY_OPS);
    const shot = await call(`/api/dashboards/${id}/snapshot.png?p.country=AT`);
    expect(shot.status, JSON.stringify(shot.json)).toBe(200);
    expect(shot.headers.get('content-type')).toBe('image/png');
    const widget = await call(`/api/dashboards/${id}/snapshot.png?widget=table&p.country=SK`);
    expect(widget.status, JSON.stringify(widget.json)).toBe(200);
    const bad = await call(`/api/dashboards/${id}/snapshot.png?p.country=DE`);
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('Filter "country" has no value "DE"; choose one of AT, SK, or * for all');
  });

  it('refuses a preview to a viewer who may not edit, before the options dataset is read', async () => {
    const { id } = await filtered(COUNTRY_OPS);
    const scope = vi.spyOn(deps.data, 'scope');
    const load = vi.spyOn(deps.data, 'loadSource');
    try {
      scope.mockClear();
      load.mockClear();
      // No edit key: the dashboard is public, so this principal may view it, but not edit it.
      const refused = await call(`/api/dashboards/${id}/preview`, {
        body: { dataset: { source: { kind: 'inline', rows: [{ a: 1 }] } }, parameters: { country: 'DE' } },
      });
      expect(refused.status, JSON.stringify(refused.json)).toBe(403);
      expect(scope).not.toHaveBeenCalled();
      expect(load).not.toHaveBeenCalled();
    } finally {
      scope.mockRestore();
      load.mockRestore();
    }
  });

  it('answers 400 for a refused filter value even when the widget drawn does not use that filter', async () => {
    const { id } = await filtered();
    // "bars" reads "sales", which uses "region" only; "days" is declared but unused there.
    expect((await call(`/api/dashboards/${id}/snapshot.png?widget=bars&p.region=eu`)).status).toBe(200);
    const bad = await call(`/api/dashboards/${id}/snapshot.png?widget=bars&p.days=bad`);
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/^Filter "days" has no value "bad"/);
  });

  it('sends no referrer, so a view link opened from a dashboard does not carry its values', async () => {
    const res = await app.request(`${BASE}/api/connectors`);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});

describe('filters over MCP', () => {
  const clients: Client[] = [];
  afterAll(async () => {
    for (const c of clients) await c.close();
  });

  async function agent(email: string, scopes = ['dashboards:read', 'dashboards:write']) {
    const login = await app.request(`${BASE}/auth/dev`, {
      method: 'POST',
      headers: { origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const pat = await call('/api/tokens', { body: { name: 'test', scopes }, headers: { cookie } });
    const c = new Client({ name: 'vitest', version: '1.0.0' });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${pat.json.token}` } },
        fetch: async (url, init) => app.request(String(url), init as RequestInit),
      }),
    );
    clients.push(c);
    return c;
  }
  const text = (r: { content?: unknown }) =>
    (r.content as { type: string; text?: string }[]).find((c) => c.type === 'text')!.text!;
  const tool = async (c: Client, name: string, args: Record<string, unknown>) =>
    JSON.parse(text(await c.callTool({ name, arguments: args })));

  it('reads, suggests, previews and draws a view, echoes it, and checks writes with the defaults', async () => {
    const c = await agent('filters-agent@example.com');
    const { dashboardId } = await tool(c, 'create_dashboard', { title: 'Filters' });
    const applied = await tool(c, 'apply_operations', {
      dashboardId,
      operations: [
        { op: 'addParameter', parameter: REGION },
        { op: 'addDataset', dataset: SALES },
        { op: 'addWidget', widget: BARS },
      ],
    });
    expect(applied.dataChecks).toEqual([expect.objectContaining({ datasetId: 'sales', rowCount: 2 })]);
    expect(applied.parametersNote).toBe(
      'Checked with the defaults (Region: All regions); use get_data with parameters to check another view.',
    );

    const eu = await tool(c, 'get_data', { dashboardId, datasetId: 'sales', parameters: { region: 'eu' } });
    expect(eu.rowCount).toBe(1);
    expect(eu.parameters).toEqual({ region: 'eu' });
    expect(eu.viewUrl).toBe(`${BASE}/d/${dashboardId}?p.region=eu`);
    const bad = await c.callTool({
      name: 'get_data',
      arguments: { dashboardId, datasetId: 'sales', parameters: { region: 'xx' } },
    });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toBe('Filter "region" has no value "xx"; choose one of eu, us, or * for all');

    const suggested = await tool(c, 'suggest_widgets', {
      dashboardId,
      datasetId: 'sales',
      parameters: { region: 'us' },
    });
    expect(suggested.rows).toBe(1);
    expect(suggested.parameters).toEqual({ region: 'us' });

    const preview = await tool(c, 'preview_data', {
      dashboardId,
      source: { kind: 'inline', rows: [{ region: 'eu' }, { region: 'us' }] },
      transforms: [{ type: 'filter', expr: 'region == $param.region' }],
      parameters: { region: 'us' },
    });
    expect(preview.rowCount).toBe(1);

    const shot = await c.callTool({
      name: 'render_snapshot',
      arguments: { dashboardId, parameters: { region: 'eu' } },
    });
    expect(text(shot)).toContain('Filters: Region: EU');
  });

  it('reads and draws a view whose filter takes its choices from data, and refuses a value it lacks', async () => {
    const c = await agent('filters-data-agent@example.com');
    const { dashboardId } = await tool(c, 'create_dashboard', { title: 'Choices from data' });
    await tool(c, 'apply_operations', { dashboardId, operations: COUNTRY_OPS });
    const at = await tool(c, 'get_data', { dashboardId, datasetId: 'mine', parameters: { country: 'AT' } });
    expect(at.rowCount).toBe(1);
    expect(at.parameters).toEqual({ country: 'AT' });
    const shot = await c.callTool({
      name: 'render_snapshot',
      arguments: { dashboardId, parameters: { country: 'SK' } },
    });
    expect(shot.isError, text(shot)).toBeFalsy();
    expect(text(shot)).toContain('Filters: Country: SK');
    const refused = 'Filter "country" has no value "DE"; choose one of AT, SK, or * for all';
    for (const [name, args] of [
      ['get_data', { dashboardId, datasetId: 'mine' }],
      ['render_snapshot', { dashboardId }],
    ] as const) {
      const bad = await c.callTool({ name, arguments: { ...args, parameters: { country: 'DE' } } });
      expect(bad.isError, name).toBe(true);
      expect(text(bad), name).toBe(refused);
    }
  });

  it('refuses a read-only preview_data with a bad filter value in the words get_data uses', async () => {
    const { id } = await filtered([
      ...COUNTRY_OPS.slice(0, 1),
      {
        op: 'addParameter',
        parameter: {
          id: 'reg',
          label: 'Region',
          type: 'select',
          optionsFrom: { dataset: 'orders', field: 'country' },
          all: 'All',
          default: null,
        },
      },
    ]);
    const reader = await agent('filters-preview-reader@example.com', ['dashboards:read']);
    const parameters = { reg: 'nope' };
    const viaGet = await reader.callTool({
      name: 'get_data',
      arguments: { dashboardId: id, datasetId: 'orders', parameters },
    });
    const viaPreview = await reader.callTool({
      name: 'preview_data',
      arguments: {
        dashboardId: id,
        source: { kind: 'inline', rows: [{ country: 'SK' }] },
        parameters,
      },
    });
    expect(viaGet.isError, text(viaGet)).toBe(true);
    expect(text(viaGet)).toBe('Filter "reg" has no value "nope"; choose one of AT, SK, or * for all');
    expect(viaPreview.isError, text(viaPreview)).toBe(true);
    expect(text(viaPreview)).toBe(text(viaGet));
  });

  it('names the filter when get_data and suggest_widgets get a value it does not offer', async () => {
    const c = await agent('filters-bad-value-agent@example.com');
    const { dashboardId } = await tool(c, 'create_dashboard', { title: 'Bad value' });
    await tool(c, 'apply_operations', {
      dashboardId,
      operations: [
        { op: 'addParameter', parameter: REGION },
        { op: 'addParameter', parameter: DAYS },
        { op: 'addDataset', dataset: SALES },
        { op: 'addWidget', widget: BARS },
      ],
    });
    // "days" is not used by "sales": a refused value is refused all the same.
    for (const name of ['get_data', 'suggest_widgets']) {
      const bad = await c.callTool({
        name,
        arguments: { dashboardId, datasetId: 'sales', parameters: { days: 'bad' } },
      });
      expect(bad.isError, name).toBe(true);
      expect(text(bad), name).toMatch(/^Filter "days" has no value "bad"/);
    }
  });

  it('reads and draws a view of a date range and a text filter', async () => {
    const c = await agent('filters-dates-agent@example.com');
    const { dashboardId } = await tool(c, 'create_dashboard', { title: 'Dates and text' });
    await tool(c, 'apply_operations', {
      dashboardId,
      operations: [
        {
          op: 'addParameter',
          parameter: {
            id: 'period',
            label: 'Period',
            type: 'dateRange',
            presets: ['last7d'],
            custom: true,
            default: 'last7d',
          },
        },
        { op: 'addParameter', parameter: { id: 'q', label: 'Search', type: 'text' } },
        {
          op: 'addDataset',
          dataset: {
            id: 'orders',
            name: 'Orders',
            source: {
              kind: 'inline',
              rows: [
                { at: '2026-01-05', name: 'shoes' },
                { at: '2026-02-05', name: 'shirts' },
                { at: '2026-01-20', name: 'hats' },
              ],
            },
            transforms: [
              {
                type: 'filter',
                expr: 'at >= $param.period.start && at < $param.period.end && ($param.q == "" || contains(name, $param.q))',
              },
            ],
          },
        },
        { op: 'addWidget', widget: { id: 'table', type: 'table', datasetId: 'orders', config: {} } },
      ],
    });
    const period = '2026-01-01..2026-01-31';

    const both = await tool(c, 'get_data', {
      dashboardId,
      datasetId: 'orders',
      parameters: { period, q: 'sh' },
    });
    expect(both.rowCount).toBe(1);
    expect(both.parameters).toEqual({ period, q: 'sh' });
    expect(both.viewUrl).toBe(`${BASE}/d/${dashboardId}?p.period=2026-01-01..2026-01-31&p.q=sh`);

    const periodOnly = await tool(c, 'get_data', {
      dashboardId,
      datasetId: 'orders',
      parameters: { period },
    });
    expect(periodOnly.rowCount).toBe(2);

    const shot = await c.callTool({
      name: 'render_snapshot',
      arguments: { dashboardId, parameters: { period, q: 'sh' } },
    });
    expect(shot.isError, text(shot)).toBeFalsy();
    expect(text(shot)).toContain('Filters: Period: 2026-01-01 – 2026-01-31 · Search: "sh"');

    const refusals: [Record<string, string>, string][] = [
      [
        { period: '2026-02-01..2026-01-01' },
        'Filter "period": the range 2026-02-01..2026-01-01 ends before it starts',
      ],
      [
        { period: 'last30d' },
        'Filter "period" has no value "last30d"; choose one of last7d, or a range like 2026-01-01..2026-01-31',
      ],
      [{ q: 'x'.repeat(101) }, 'Filter "q" takes at most 100 characters'],
    ];
    for (const [parameters, message] of refusals) {
      const bad = await c.callTool({
        name: 'get_data',
        arguments: { dashboardId, datasetId: 'orders', parameters },
      });
      expect(bad.isError, message).toBe(true);
      expect(text(bad)).toBe(message);
    }
  });

  it('previews a connector parameter bound to a filter', async () => {
    const c = await agent('filters-preview-days@example.com');
    const { dashboardId } = await tool(c, 'create_dashboard', { title: 'Preview days' });
    await tool(c, 'apply_operations', { dashboardId, operations: [{ op: 'addParameter', parameter: DAYS }] });
    const source = { kind: 'connector', connector: 'demo.sales', params: { days: '$param.days' } };

    const base = await tool(c, 'preview_data', { dashboardId, source });
    const ninety = await tool(c, 'preview_data', { dashboardId, source, parameters: { days: '90' } });
    expect(ninety.rowCount).toBeGreaterThan(base.rowCount);
    expect(ninety.parameters).toEqual({ days: '90' });

    const bad = await c.callTool({
      name: 'preview_data',
      arguments: { dashboardId, source, parameters: { days: '7' } },
    });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toBe('Filter "days" has no value "7"; choose one of 30, 90');
  });

  it('keeps a read-only token from previewing a POST, with filter values or without', async () => {
    const reader = await agent('filters-reader@example.com', ['dashboards:read']);
    const r = await reader.callTool({
      name: 'preview_data',
      arguments: {
        source: {
          kind: 'http',
          url: 'https://api.example.com/q?region=$param.region',
          method: 'POST',
          body: { r: 1 },
        },
        parameters: { region: 'eu' },
      },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Previewing a POST source needs the dashboards:write scope/);
  });
});

/** Lets every request through: a clock set back would leave the real limiter's buckets empty. */
class Unlimited extends RateLimiter {
  override take() {
    return true;
  }
}

describe('calendar window of a data answer', () => {
  const ORDERS = {
    id: 'orders',
    name: 'Orders',
    source: { kind: 'inline', rows: [{ at: '2026-11-09', n: 1 }] },
    // A column of ISO days is read as a time column (milliseconds), so it is compared with the range's start.
    transforms: [{ type: 'filter', expr: 'at >= $param.period.start' }],
  };
  let id: string;
  let api: RateLimiter;

  // Created under the real clock: one set back in time would also empty the create budget of this address.
  beforeAll(async () => {
    ({ id } = await filtered([
      {
        op: 'addParameter',
        parameter: {
          id: 'period',
          label: 'Period',
          type: 'dateRange',
          presets: ['yesterday', 'last7d'],
          custom: true,
          default: 'last7d',
        },
      },
      { op: 'addDataset', dataset: ORDERS },
      {
        op: 'addDataset',
        dataset: { id: 'plain', name: 'Plain', source: { kind: 'inline', rows: [{ a: 1 }] } },
      },
      {
        op: 'addDataset',
        dataset: { id: 'recent', name: 'Recent', source: { kind: 'dataset', id: 'orders' } },
      },
      {
        op: 'addDataset',
        dataset: {
          id: 'broken',
          name: 'Broken',
          source: { kind: 'dataset', id: 'orders' },
          transforms: [{ type: 'rename', map: { n: 'at' } }],
        },
      },
    ]));
  });

  beforeEach(() => {
    api = deps.limits.api;
    deps.limits.api = new Unlimited(1, 1);
    vi.useFakeTimers({ toFake: ['Date'] });
    // Half a minute before the server's midnight.
    vi.setSystemTime(new Date('2026-11-10T23:59:30.200Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    deps.limits.api = api;
  });

  it('states the window of a relative period and the seconds until midnight', async () => {
    const res = await call(`/api/dashboards/${id}/data/orders`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.table.rows).toEqual([{ at: Date.UTC(2026, 10, 9), n: 1 }]);
    expect(res.json.calendar).toEqual({ window: '2026-11-04..2026-11-10', validForSec: 30 });
  });

  it('states no window for a fixed period or for a dataset without date filters', async () => {
    const fixed = await call(`/api/dashboards/${id}/data/orders?p.period=2026-11-01..2026-11-05`);
    expect(fixed.status, JSON.stringify(fixed.json)).toBe(200);
    expect(fixed.json).not.toHaveProperty('calendar');
    const plain = await call(`/api/dashboards/${id}/data/plain`);
    expect(plain.status, JSON.stringify(plain.json)).toBe(200);
    expect(plain.json).not.toHaveProperty('calendar');
  });

  it('counts the validity per request and never writes it into the shared result', async () => {
    const original = deps.data.sharedFinal.bind(deps.data);
    const shared: DatasetResult[] = [];
    const spy = vi.spyOn(deps.data, 'sharedFinal').mockImplementation(async (key, build) => {
      const r = await original(key, build);
      shared.push(r);
      return r;
    });
    try {
      const first = await call(`/api/dashboards/${id}/data/recent`);
      vi.setSystemTime(new Date('2026-11-10T23:59:32.200Z'));
      const second = await call(`/api/dashboards/${id}/data/recent`);
      expect(first.json.calendar).toEqual({ window: '2026-11-04..2026-11-10', validForSec: 30 });
      expect(second.json.calendar).toEqual({ window: '2026-11-04..2026-11-10', validForSec: 28 });
      // The second read is served the object the first one built.
      expect(shared).toHaveLength(2);
      expect(shared[1]).toBe(shared[0]);
      for (const r of shared) expect(r).not.toHaveProperty('calendar');
    } finally {
      spy.mockRestore();
    }
  });

  it('keys cached snapshots by the calendar window', async () => {
    const snapshots = deps.limits.snapshots;
    deps.limits.snapshots = new Unlimited(1, 1);
    const scope = vi.spyOn(deps.data, 'scope');
    try {
      for (let i = 0; i < 2; i++) {
        const res = await app.request(`${BASE}/api/dashboards/${id}/snapshot.png`, {
          headers: { origin: BASE },
        });
        expect(res.status, `request ${i}`).toBe(200);
      }
      expect(scope).toHaveBeenCalledTimes(1);
      vi.setSystemTime(new Date('2026-11-11T00:00:30Z'));
      const next = await app.request(`${BASE}/api/dashboards/${id}/snapshot.png`, {
        headers: { origin: BASE },
      });
      expect(next.status).toBe(200);
      expect(scope).toHaveBeenCalledTimes(2);
    } finally {
      scope.mockRestore();
      deps.limits.snapshots = snapshots;
    }
  });

  it('states the window on an error result too', async () => {
    const res = await call(`/api/dashboards/${id}/data/broken`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.error).toBeTruthy();
    expect(res.json.calendar).toEqual({ window: '2026-11-04..2026-11-10', validForSec: 30 });
  });
});
