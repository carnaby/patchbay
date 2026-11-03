import { describe, expect, it } from 'vitest';
import {
  applyOps,
  type DashboardDoc,
  EXPORT_FORMAT,
  EXPORT_MAX_FILES,
  EXPORT_VERSION,
  ExportFormatError,
  emptyDashboard,
  exportedFile,
  exportFileName,
  FileIdSchema,
  packedTableIssue,
  portability,
  readExport,
  SourceSchema,
  stripSecretRefs,
  tableFromPacked,
} from './index.ts';

const SECRET = 'sec_AAAAAAAAAAAAAAAA';

function shop(): DashboardDoc {
  return applyOps(emptyDashboard('Shop board'), [
    {
      op: 'addDataset',
      dataset: { id: 'sales', name: 'Sales', source: { kind: 'upload', fileId: 'f_sales' } },
    },
    {
      op: 'addDataset',
      dataset: {
        id: 'orders',
        name: 'Orders',
        source: { kind: 'http', url: 'https://api.example.com/v1/orders', path: 'items', secrets: [SECRET] },
      },
    },
    {
      op: 'addWidget',
      widget: { id: 'sales-table', type: 'table', datasetId: 'sales', title: 'Sales', config: {} },
    },
  ]).doc;
}

const salesFile = {
  id: 'f_sales',
  name: 'sales.csv',
  columns: [
    { name: 'date', type: 'time' },
    { name: 'revenue', type: 'number' },
    { name: 'paid', type: 'boolean' },
  ],
  data: [
    [1767225600000, 120.5, true],
    [null, null, null],
  ],
};

const envelope = (extra: Record<string, unknown> = {}) => ({
  format: EXPORT_FORMAT,
  version: EXPORT_VERSION,
  exportedAt: '2026-11-03T10:00:00.000Z',
  secretsRemovedFrom: ['orders'],
  doc: stripSecretRefs(shop()).doc,
  files: [salesFile],
  ...extra,
});

/** The message of the ExportFormatError that `fn` throws. */
function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ExportFormatError);
    return (e as Error).message;
  }
  throw new Error('expected a refusal');
}

describe('portability', () => {
  it('lists upload sources and secret references per dataset', () => {
    expect(portability(shop())).toEqual({
      uploads: [{ datasetId: 'sales', fileId: 'f_sales' }],
      secrets: [{ datasetId: 'orders', secretIds: [SECRET] }],
    });
  });
});

describe('stripSecretRefs', () => {
  it('removes only the secret references and says from which datasets', () => {
    const before = shop();
    const { doc, datasetIds } = stripSecretRefs(before);
    expect(datasetIds).toEqual(['orders']);
    expect(doc.datasets[1]!.source).toEqual({
      kind: 'http',
      url: 'https://api.example.com/v1/orders',
      path: 'items',
    });
    expect(doc.datasets.map((d) => d.id)).toEqual(['sales', 'orders']);
    expect(doc.widgets).toEqual(before.widgets);
    expect(doc.layout).toEqual(before.layout);
  });

  it('returns the same document when there is nothing to remove', () => {
    const doc = stripSecretRefs(shop()).doc;
    expect(stripSecretRefs(doc).doc).toBe(doc);
  });
});

describe('exportFileName', () => {
  it('makes an ASCII slug of the title', () => {
    expect(exportFileName('Shop board')).toBe('shop-board.patchbay.json');
    expect(exportFileName('Počasie v Bratislave!')).toBe('pocasie-v-bratislave.patchbay.json');
    expect(exportFileName('???')).toBe('dashboard.patchbay.json');
    const long = exportFileName(`${'a'.repeat(59)} b c`);
    expect(long).toBe(`${'a'.repeat(59)}.patchbay.json`);
  });
});

describe('packed tables', () => {
  it('packs rows in column order and reads them back', () => {
    const table = {
      columns: [
        { name: 'city', type: 'string' as const },
        { name: 'temp', type: 'number' as const },
      ],
      rows: [{ city: 'Bratislava', temp: 1.5 }, { temp: 2 }],
    };
    const file = exportedFile({ id: 'f_1', name: 'temps.csv' }, table as never);
    expect(file).toEqual({
      id: 'f_1',
      name: 'temps.csv',
      columns: table.columns,
      data: [
        ['Bratislava', 1.5],
        [null, 2],
      ],
    });
    expect(tableFromPacked({ columns: file.columns, data: file.data })).toEqual({
      columns: table.columns,
      rows: [
        { city: 'Bratislava', temp: 1.5 },
        { city: null, temp: 2 },
      ],
    });
  });

  it('refuses values that do not fit their column, rows of the wrong length and duplicate columns', () => {
    const columns = salesFile.columns as never;
    expect(packedTableIssue(columns, [[1, 2]])).toBe('Row 1 has 2 values; the table has 3 columns');
    expect(packedTableIssue(columns, [['2026-01-01', 1, true]])).toBe(
      'Row 1, column "date": "2026-01-01" is not a time value',
    );
    expect(packedTableIssue(columns, [[1, 1, 'yes']])).toBe(
      'Row 1, column "paid": "yes" is not a boolean value',
    );
    expect(packedTableIssue(columns, ['x'])).toBe('Row 1 is not a list of values');
    expect(
      packedTableIssue(
        [
          { name: 'a', type: 'string' },
          { name: 'a', type: 'string' },
        ],
        [],
      ),
    ).toBe('Column "a" appears twice');
    expect(refusal(() => tableFromPacked({ columns: [], data: [] }))).toMatch(/columns/);
    expect(refusal(() => tableFromPacked({ ...salesFile }))).toMatch(/Unrecognized key/);
  });
});

describe('readExport', () => {
  it('reads an export and keeps every id of the document', () => {
    const read = readExport(envelope());
    expect(read.doc).toEqual(stripSecretRefs(shop()).doc);
    expect(read.files).toEqual([salesFile]);
    expect(read.secretsRemovedFrom).toEqual(['orders']);
    expect(read.exportedAt).toBe('2026-11-03T10:00:00.000Z');
  });

  it('drops files no dataset uses', () => {
    const extra = { ...salesFile, id: 'f_other' };
    expect(readExport(envelope({ files: [salesFile, extra] })).files.map((f) => f.id)).toEqual(['f_sales']);
  });

  it('refuses files from a newer version with advice', () => {
    expect(refusal(() => readExport(envelope({ version: 2 })))).toBe(
      'This file was exported by a newer version of Patchbay (export format 2; this server reads up to 1). Update this server, or export the dashboard again from a server running this version.',
    );
    const newerDoc = { ...stripSecretRefs(shop()).doc, schemaVersion: 2 };
    expect(refusal(() => readExport(envelope({ doc: newerDoc })))).toBe(
      'The dashboard in this file was made with a newer version of Patchbay (document version 2). Update this server to import it.',
    );
  });

  it('says plainly when a file is not an export at all', () => {
    const notAnExport =
      'This file is not a Patchbay export. Choose a .patchbay.json file made with Export file.';
    for (const raw of [null, 'text', [1, 2], { hello: 'world' }, { format: 'something-else', version: 1 }]) {
      expect(refusal(() => readExport(raw))).toBe(notAnExport);
    }
  });

  it('names what is damaged', () => {
    expect(refusal(() => readExport(envelope({ version: '1' })))).toMatch(/^This export file is damaged/);
    expect(refusal(() => readExport(envelope({ extra: true })))).toMatch(/Unrecognized key/);
    expect(refusal(() => readExport(envelope({ files: [salesFile, salesFile] })))).toMatch(/appears twice/);
    const broken = { ...salesFile, data: [[1767225600000, 'lots', true]] };
    expect(refusal(() => readExport(envelope({ files: [broken] })))).toBe(
      'The file "sales.csv" in this export is damaged: Row 1, column "revenue": "lots" is not a number value',
    );
    expect(refusal(() => readExport(envelope({ doc: { schemaVersion: 1 } })))).toMatch(
      /^The dashboard in this file is not valid: /,
    );
    const many = Array.from({ length: EXPORT_MAX_FILES + 1 }, (_, i) => ({ ...salesFile, id: `f_${i}` }));
    expect(refusal(() => readExport(envelope({ files: many })))).toMatch(/^This export file is damaged/);
  });

  it('accepts a bare document and the REST answer of GET /api/dashboards/:id', () => {
    const doc = shop();
    for (const raw of [doc, { meta: { id: 'abcdef' }, doc, access: {} }]) {
      const read = readExport(raw);
      expect(read.doc).toEqual(doc);
      expect(read.files).toEqual([]);
      expect(read.exportedAt).toBeNull();
    }
  });
});

describe('FileIdSchema', () => {
  it('is the rule of upload sources', () => {
    expect(FileIdSchema.safeParse('f_abc-123').success).toBe(true);
    expect(FileIdSchema.safeParse('../x').success).toBe(false);
    expect(SourceSchema.safeParse({ kind: 'upload', fileId: '../x' }).success).toBe(false);
  });
});
