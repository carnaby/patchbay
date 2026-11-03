/** Export and import of a dashboard (.patchbay.json): packed-table uploads, the export route and the import route. */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_TABLE_FILE_BYTES } from '@patchbay/core';
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
