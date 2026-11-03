/**
 * The `.patchbay.json` file: one dashboard, moved between servers or shared as a template. It carries the document
 * whole (dataset, step, widget, layout and file ids unchanged, so every reference inside it stays valid) and the
 * tables of the uploaded files its datasets use, in the packed form the server stores them in, with their column
 * types. It never carries what belongs to an account or a server: secret references, owner, sharing, edit keys,
 * version history.
 *
 * A reader accepts every envelope version up to EXPORT_VERSION and refuses newer ones with advice. Any change to the
 * envelope's shape bumps EXPORT_VERSION (the schema is strict); the document follows its own schemaVersion.
 */
import { z } from 'zod';
import { applyOps } from './ops.ts';
import {
  type DashboardDoc,
  DocumentError,
  FileIdSchema,
  formatZodIssues,
  IdSchema,
  LIMITS,
  parseDashboard,
  SCHEMA_VERSION,
  type Source,
} from './schema.ts';
import { sourceSecretIds } from './secrets.ts';
import {
  type Column,
  type ColumnType,
  type DataTable,
  INFER_MAX_COLUMNS,
  type Row,
  type Scalar,
} from './table.ts';

export const EXPORT_FORMAT = 'patchbay-dashboard';
export const EXPORT_VERSION = 1;
export const EXPORT_EXTENSION = '.patchbay.json';
/** Files one dashboard can hold (the server's MAX_FILES). */
export const EXPORT_MAX_FILES = 20;
/**
 * The largest export the web app reads. A dashboard holds at most a 1 MB document and 25 MB of stored tables, which
 * the file carries in the same packed form, so a real export stays below this.
 */
export const MAX_EXPORT_FILE_BYTES = 32 * 1024 * 1024;
/**
 * The largest packed table one import upload may carry, measured on the packed text. The upload body is limited too,
 * after JSON escaping, and escaping can make a table under this size exceed it, so the web import also measures the
 * escaped size before uploading.
 */
export const MAX_TABLE_FILE_BYTES = 7 * 1024 * 1024;

const PackedColumnSchema = z.strictObject({
  name: z.string().max(LIMITS.inlineColumnName),
  type: z.enum(['number', 'string', 'boolean', 'time']),
});

/** An uploaded table as stored and exported: column types, then rows as arrays in column order. */
export const PackedTableSchema = z.strictObject({
  columns: z.array(PackedColumnSchema).min(1).max(INFER_MAX_COLUMNS),
  data: z.array(z.unknown()),
});

const ExportedFileSchema = z.strictObject({
  id: FileIdSchema,
  name: z.string().min(1).max(200),
  columns: PackedTableSchema.shape.columns,
  data: PackedTableSchema.shape.data,
});

const EnvelopeSchema = z.strictObject({
  format: z.literal(EXPORT_FORMAT),
  version: z.literal(EXPORT_VERSION),
  exportedAt: z.string().max(40),
  secretsRemovedFrom: z.array(IdSchema).max(LIMITS.datasets).default([]),
  doc: z.unknown(),
  files: z.array(z.unknown()).max(EXPORT_MAX_FILES).default([]),
});

export interface ExportedFile {
  id: string;
  name: string;
  columns: Column[];
  data: Scalar[][];
}

export interface DashboardExport {
  format: typeof EXPORT_FORMAT;
  version: number;
  /** Null for a bare document, which carries no envelope. */
  exportedAt: string | null;
  /** Datasets whose secret references were removed when the file was made. */
  secretsRemovedFrom: string[];
  doc: DashboardDoc;
  files: ExportedFile[];
}

/** A refusal whose message is meant for the person who chose the file. */
export class ExportFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportFormatError';
  }
}

export interface Portability {
  /** Upload sources: their files live in the dashboard's folder on one server. */
  uploads: { datasetId: string; fileId: string }[];
  /** Secret references: ids of one account's secrets on one server. */
  secrets: { datasetId: string; secretIds: string[] }[];
}

/** What ties a document to its server and account. The showcase refuses both; an export carries files, not secrets. */
export function portability(doc: DashboardDoc): Portability {
  return {
    uploads: doc.datasets.flatMap((d) =>
      d.source.kind === 'upload' ? [{ datasetId: d.id, fileId: d.source.fileId }] : [],
    ),
    secrets: doc.datasets.flatMap((d) => {
      const secretIds = sourceSecretIds(d.source);
      return secretIds.length ? [{ datasetId: d.id, secretIds }] : [];
    }),
  };
}

/** The document without secret references, as operations, and the datasets that had them. */
export function stripSecretRefs(doc: DashboardDoc): { doc: DashboardDoc; datasetIds: string[] } {
  const ops: { op: 'updateDataset'; id: string; set: { source: Source } }[] = [];
  for (const d of doc.datasets) {
    if (d.source.kind !== 'http' || !d.source.secrets) continue;
    const { secrets: _removed, ...source } = d.source;
    ops.push({ op: 'updateDataset', id: d.id, set: { source } });
  }
  if (ops.length === 0) return { doc, datasetIds: [] };
  return { doc: applyOps(doc, ops).doc, datasetIds: ops.map((o) => o.id) };
}

/** An ASCII file name, so the Content-Disposition header needs no encoding and nothing can be injected into it. */
export function exportFileName(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '');
  return `${slug || 'dashboard'}${EXPORT_EXTENSION}`;
}

/** The same packing as `packTable` in the folder store, which also reads older stored shapes; keep the two in step. */
export function exportedFile(file: { id: string; name: string }, table: DataTable): ExportedFile {
  return {
    id: file.id,
    name: file.name,
    columns: table.columns.map(({ name, type }) => ({ name, type })),
    data: table.rows.map((row) => table.columns.map((c) => row[c.name] ?? null)),
  };
}

function fits(value: unknown, type: ColumnType): boolean {
  if (value === null) return true;
  if (type === 'number' || type === 'time') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  return typeof value === 'string';
}

const preview = (value: unknown) =>
  value === undefined ? 'nothing' : (JSON.stringify(value) ?? '?').slice(0, 40);

/**
 * Why these rows cannot be stored under these columns, or null. Value by value: a damaged or hand-edited file must
 * be refused, never stored with values its column type does not allow. Linear and without allocation.
 */
export function packedTableIssue(columns: readonly Column[], data: readonly unknown[]): string | null {
  const names = new Set<string>();
  for (const c of columns) {
    if (names.has(c.name)) return `Column "${c.name.slice(0, 40)}" appears twice`;
    names.add(c.name);
  }
  for (let r = 0; r < data.length; r++) {
    const values = data[r];
    if (!Array.isArray(values)) return `Row ${r + 1} is not a list of values`;
    if (values.length !== columns.length)
      return `Row ${r + 1} has ${values.length} values; the table has ${columns.length} columns`;
    for (let i = 0; i < columns.length; i++) {
      const column = columns[i]!;
      if (!fits(values[i], column.type))
        return `Row ${r + 1}, column "${column.name.slice(0, 40)}": ${preview(values[i])} is not a ${column.type} value`;
    }
  }
  return null;
}

/** The table of a packed upload (`{ columns, data }`), refused with ExportFormatError when anything does not fit. */
export function tableFromPacked(raw: unknown): DataTable {
  const parsed = PackedTableSchema.safeParse(raw);
  if (!parsed.success)
    throw new ExportFormatError(formatZodIssues(parsed.error)[0] ?? 'The table is not valid');
  const { columns, data } = parsed.data;
  const issue = packedTableIssue(columns, data);
  if (issue) throw new ExportFormatError(issue);
  const rows = (data as Scalar[][]).map((values) => {
    const row: Row = {};
    for (let i = 0; i < columns.length; i++) row[columns[i]!.name] = values[i] ?? null;
    return row;
  });
  return { columns, rows };
}

const NOT_AN_EXPORT =
  'This file is not a Patchbay export. Choose a .patchbay.json file made with Export file.';
const damaged = (why: string) =>
  new ExportFormatError(`This export file is damaged or was edited by hand: ${why}`);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function readDoc(raw: unknown): DashboardDoc {
  const version = isRecord(raw) ? raw.schemaVersion : undefined;
  if (typeof version === 'number' && version > SCHEMA_VERSION)
    throw new ExportFormatError(
      `The dashboard in this file was made with a newer version of Patchbay (document version ${version}). Update this server to import it.`,
    );
  try {
    return parseDashboard(raw);
  } catch (e) {
    if (e instanceof DocumentError)
      throw new ExportFormatError(
        `The dashboard in this file is not valid: ${e.issues.slice(0, 3).join('; ')}`,
      );
    throw e;
  }
}

/**
 * Reads a parsed `.patchbay.json` file. Also accepted, without files: a bare document (a showcase dashboard.json,
 * get_dashboard's `doc`) and the answer of GET /api/dashboards/:id (`{ meta, doc, access }`). The content decides,
 * never the file name, so a renamed file still works. Throws ExportFormatError with a message for the user.
 */
export function readExport(raw: unknown): DashboardExport {
  if (!isRecord(raw)) throw new ExportFormatError(NOT_AN_EXPORT);
  if (raw.format === undefined) {
    const bare = 'schemaVersion' in raw ? raw : 'meta' in raw && isRecord(raw.doc) ? raw.doc : null;
    if (!bare) throw new ExportFormatError(NOT_AN_EXPORT);
    return {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: null,
      secretsRemovedFrom: [],
      doc: readDoc(bare),
      files: [],
    };
  }
  if (raw.format !== EXPORT_FORMAT) throw new ExportFormatError(NOT_AN_EXPORT);
  const version = raw.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
    throw damaged('its format version is missing or not a whole number');
  if (version > EXPORT_VERSION)
    throw new ExportFormatError(
      `This file was exported by a newer version of Patchbay (export format ${version}; this server reads up to ${EXPORT_VERSION}). Update this server, or export the dashboard again from a server running this version.`,
    );
  const envelope = EnvelopeSchema.safeParse(raw);
  if (!envelope.success) throw damaged(formatZodIssues(envelope.error)[0] ?? 'unexpected content');
  const doc = readDoc(envelope.data.doc);
  const used = new Set(portability(doc).uploads.map((u) => u.fileId));
  const seen = new Set<string>();
  const files: ExportedFile[] = [];
  for (const [index, entry] of envelope.data.files.entries()) {
    const file = ExportedFileSchema.safeParse(entry);
    if (!file.success) throw damaged(`file ${index + 1}: ${formatZodIssues(file.error)[0] ?? 'not valid'}`);
    const { id, name, columns, data } = file.data;
    if (seen.has(id)) throw damaged(`the file id "${id}" appears twice`);
    seen.add(id);
    const issue = packedTableIssue(columns, data);
    if (issue) throw new ExportFormatError(`The file "${name}" in this export is damaged: ${issue}`);
    // Only files a dataset uses: an export never writes others, and the server would refuse them.
    if (used.has(id)) files.push({ id, name, columns, data: data as Scalar[][] });
  }
  return {
    format: EXPORT_FORMAT,
    version,
    exportedAt: envelope.data.exportedAt,
    secretsRemovedFrom: envelope.data.secretsRemovedFrom,
    doc,
    files,
  };
}
