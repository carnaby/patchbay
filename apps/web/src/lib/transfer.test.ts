import {
  applyOps,
  type DashboardExport,
  EXPORT_FORMAT,
  EXPORT_VERSION,
  emptyDashboard,
  MAX_EXPORT_FILE_BYTES,
  MAX_TABLE_FILE_BYTES,
} from '@patchbay/core';
import { describe, expect, it } from 'vitest';
import { ApiError, NetworkError } from './api.ts';
import {
  exportSummary,
  formatSize,
  ImportError,
  importSummary,
  largeExportFiles,
  prepareFiles,
  quoteList,
  readImportFile,
  runImport,
} from './transfer.ts';

const doc = applyOps(emptyDashboard('Shop board'), [
  {
    op: 'addDataset',
    dataset: { id: 'sales', name: 'Sales', source: { kind: 'upload', fileId: 'f_sales' } },
  },
  {
    op: 'addDataset',
    dataset: { id: 'stock', name: 'Stock', source: { kind: 'upload', fileId: 'f_stock' } },
  },
  {
    op: 'addDataset',
    dataset: {
      id: 'orders',
      name: 'Orders',
      source: { kind: 'http', url: 'https://api.example.com/v1/orders?api_key=abc' },
    },
  },
  { op: 'addWidget', widget: { id: 'w', type: 'table', datasetId: 'sales', config: {} } },
]).doc;

const sales = {
  id: 'f_sales',
  name: 'sales.csv',
  columns: [{ name: 'n', type: 'number' as const }],
  data: [[1], [2]],
};

const exp: DashboardExport = {
  format: EXPORT_FORMAT,
  version: EXPORT_VERSION,
  exportedAt: '2026-11-03T10:00:00.000Z',
  secretsRemovedFrom: ['orders'],
  doc,
  files: [sales],
};

const file = (text: string, size = text.length) => ({ size, text: async () => text });

describe('readImportFile', () => {
  it('reads an export by its content, whatever the file is called', async () => {
    const read = await readImportFile(file(JSON.stringify(exp)));
    expect(read.doc.title).toBe('Shop board');
  });

  it('refuses oversize, truncated and foreign files in plain language', async () => {
    await expect(readImportFile(file('{}', MAX_EXPORT_FILE_BYTES + 1))).rejects.toThrow(
      'This file is larger than a Patchbay export can be (32 MB).',
    );
    await expect(readImportFile(file(JSON.stringify(exp).slice(0, 100)))).rejects.toThrow(
      'This file is not a Patchbay export: it is not valid JSON, or it is incomplete.',
    );
    await expect(readImportFile(file('{"hello":"world"}'))).rejects.toBeInstanceOf(ImportError);
  });

  it('advises updating when the file comes from a newer Patchbay, before any request', async () => {
    const newer = JSON.stringify({ ...exp, version: EXPORT_VERSION + 1 });
    await expect(readImportFile(file(newer))).rejects.toThrow(/newer version of Patchbay/);
    await expect(readImportFile(file(newer))).rejects.toThrow(/Update this server/);
  });

  it('refuses a document over the size limit with the size sentence, not a generic 413', async () => {
    const heavy = applyOps(emptyDashboard('Heavy'), [
      {
        op: 'addDataset',
        dataset: {
          id: 'd',
          name: 'D',
          source: {
            kind: 'inline',
            rows: Array.from({ length: 2000 }, (_, i) => ({ a: `${i}`.padEnd(600, 'x') })),
          },
        },
      },
    ]).doc;
    const text = JSON.stringify({ ...exp, doc: heavy, files: [] });
    await expect(readImportFile(file(text))).rejects.toThrow(/a dashboard document is limited to 977 KB/);
  });
});

describe('quoteList', () => {
  it('quotes and joins names in plain language', () => {
    expect(quoteList([])).toBe('');
    expect(quoteList(['A'])).toBe('"A"');
    expect(quoteList(['A', 'B'])).toBe('"A" and "B"');
    expect(quoteList(['A', 'B', 'C'])).toBe('"A", "B" and "C"');
  });
});

describe('prepareFiles', () => {
  it('declares each file with the bytes it will upload', () => {
    const [prepared] = prepareFiles(exp);
    expect(prepared).toMatchObject({ id: 'f_sales', name: 'sales.csv', rows: 2, columns: 1 });
    expect(prepared!.content).toBe(JSON.stringify({ columns: sales.columns, data: sales.data }));
    expect(prepared!.bytes).toBe(new TextEncoder().encode(prepared!.content).length);
  });

  it('refuses a table whose JSON-escaped upload exceeds the route body limit', () => {
    // Each quote doubles when the content is sent as a JSON string: under 7 MB packed, over 8 MiB on the wire.
    const quotes = {
      ...sales,
      data: [['"'.repeat(4_500_000)]],
      columns: [{ name: 's', type: 'string' as const }],
    };
    expect(() => prepareFiles({ ...exp, files: [quotes] })).toThrow(/is too large to import/);
  });

  it('refuses a table too large to import before any request', () => {
    const big = {
      ...sales,
      data: [['x'.repeat(MAX_TABLE_FILE_BYTES)]],
      columns: [{ name: 's', type: 'string' as const }],
    };
    expect(() => prepareFiles({ ...exp, files: [big] })).toThrow(/is too large to import/);
  });
});

describe('summaries', () => {
  it('says what an import brings and what it lacks', () => {
    // The files prepared once when the file was chosen: the summary measures those, it does not pack them again.
    const prepared = prepareFiles(exp).map((f) => ({ ...f, bytes: 1234 }));
    expect(importSummary(exp, prepared)).toEqual({
      title: 'Shop board',
      datasets: 3,
      widgets: 1,
      files: 1,
      bytes: 1234,
      secretDatasets: ['Orders'],
      missingFileDatasets: ['Stock'],
      exportedAt: '2026-11-03T10:00:00.000Z',
    });
  });

  it('says what an export holds for editors and viewers', () => {
    expect(exportSummary(doc, true)).toEqual({
      datasets: 3,
      widgets: 1,
      uploadDatasets: ['Sales', 'Stock'],
      filesIncluded: true,
      secretDatasets: [],
      keyInUrl: [{ dataset: 'Orders', params: ['api_key'] }],
    });
    expect(exportSummary(doc, false).filesIncluded).toBe(false);
  });
});

describe('runImport', () => {
  function fakeServer(failUpload?: (attempt: number) => Error | null) {
    const requests: { path: string; body: any; dashboardId?: string }[] = [];
    let attempts = 0;
    const calls = {
      call: async <T>(path: string, options: { body?: unknown; dashboardId?: string }): Promise<T> => {
        requests.push({
          path,
          body: options.body,
          ...(options.dashboardId ? { dashboardId: options.dashboardId } : {}),
        });
        if (path === '/api/dashboards/import')
          return { envelope: { meta: { id: 'newid1' }, doc }, editKey: 'pbk_key', notes: ['note'] } as T;
        const error = failUpload?.(++attempts);
        if (error) throw error;
        return { id: 'f_sales' } as T;
      },
      saved: [] as string[][],
      saveEditKey(id: string, key: string, title: string) {
        this.saved.push([id, key, title]);
      },
      retry: async <T>(task: () => Promise<T>) => {
        try {
          return await task();
        } catch (e) {
          if (e instanceof NetworkError) return task();
          throw e;
        }
      },
    };
    return { calls, requests };
  }

  it('creates from the document, keeps the edit key, then uploads each file under its id', async () => {
    const { calls, requests } = fakeServer();
    const result = await runImport(exp, prepareFiles(exp), calls);
    expect(result).toEqual({ id: 'newid1', notes: ['note'], failed: [] });
    expect(calls.saved).toEqual([['newid1', 'pbk_key', 'Shop board']]);
    expect(requests[0]!.body).toEqual({
      doc,
      files: [{ id: 'f_sales', name: 'sales.csv', rows: 2, columns: 1, bytes: prepareFiles(exp)[0]!.bytes }],
    });
    expect(requests[1]).toEqual({
      path: '/api/dashboards/newid1/files',
      body: { name: 'sales.csv', format: 'table', fileId: 'f_sales', content: prepareFiles(exp)[0]!.content },
      dashboardId: 'newid1',
    });
  });

  it('counts a retried upload that already landed as done', async () => {
    const { calls } = fakeServer((attempt) =>
      attempt === 1
        ? new NetworkError(new Error('reset'))
        : new ApiError(409, 'This dashboard already has file "f_sales"', { code: 'FILE_EXISTS' }),
    );
    expect((await runImport(exp, prepareFiles(exp), calls)).failed).toEqual([]);
  });

  it('reports files that could not be uploaded and keeps going', async () => {
    const { calls } = fakeServer(() => new ApiError(400, 'Imported tables are limited to 7.0 MB', {}));
    expect((await runImport(exp, prepareFiles(exp), calls)).failed).toEqual([
      { id: 'f_sales', name: 'sales.csv', message: 'Imported tables are limited to 7.0 MB' },
    ]);
  });
});

describe('largeExportFiles', () => {
  const file = (name: string, bytes: number) => ({ id: `f_${name}`, name, size: 1, storedBytes: bytes });

  it('names the tables an import may refuse: over the limit, or within a tenth below it', () => {
    expect(
      largeExportFiles([
        file('small.csv', 1_000_000),
        file('near.csv', MAX_TABLE_FILE_BYTES - 100_000),
        file('over.csv', MAX_TABLE_FILE_BYTES + 1),
      ]),
    ).toEqual([
      { id: 'f_near.csv', name: 'near.csv', bytes: MAX_TABLE_FILE_BYTES - 100_000, over: false },
      { id: 'f_over.csv', name: 'over.csv', bytes: MAX_TABLE_FILE_BYTES + 1, over: true },
    ]);
  });

  it('measures files stored before sizes were recorded by their upload', () => {
    expect(largeExportFiles([{ id: 'f_old', name: 'old.csv', size: MAX_TABLE_FILE_BYTES }])).toEqual([
      { id: 'f_old', name: 'old.csv', bytes: MAX_TABLE_FILE_BYTES, over: false },
    ]);
  });
});

describe('formatSize', () => {
  it('shows small files in KB, so a few rows never read as 0.0 MB', () => {
    expect(formatSize(0)).toBe('0 KB');
    expect(formatSize(300)).toBe('1 KB');
    expect(formatSize(12 * 1024)).toBe('12 KB');
    expect(formatSize(100 * 1024)).toBe('100 KB');
  });

  it('keeps MB from 0.1 MB up', () => {
    expect(formatSize(0.1 * 1024 * 1024)).toBe('0.1 MB');
    expect(formatSize(2.5 * 1024 * 1024)).toBe('2.5 MB');
    expect(formatSize(MAX_TABLE_FILE_BYTES)).toBe('7.0 MB');
  });
});
