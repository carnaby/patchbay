/**
 * Export and import of a dashboard as a .patchbay.json file (format: packages/core/src/export.ts). An import creates
 * a dashboard from the file's document, then uploads each file under the id the document already uses, so nothing
 * inside the document is rewritten. The server checks everything again; what is checked here is for refusing early,
 * before anything is created.
 */
import {
  credentialLikeParams,
  type DashboardDoc,
  type DashboardEnvelope,
  type DashboardExport,
  ExportFormatError,
  exportFileName,
  LIMITS,
  MAX_EXPORT_FILE_BYTES,
  MAX_TABLE_FILE_BYTES,
  portability,
  readExport,
  type UploadedFile,
} from '@patchbay/core';
import { ApiError, NetworkError } from './api.ts';
import { getEditKey } from './edit-keys.ts';

/** A refusal whose message is meant for the person who chose the file. */
export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

const formatKb = (bytes: number) => `${Math.ceil(bytes / 1024)} KB`;
/** MB with one decimal; below 0.1 MB in KB, where one decimal of a MB would read "0.0 MB" for a small file. */
export const formatSize = (bytes: number) =>
  bytes < 0.1 * 1024 * 1024 ? formatKb(bytes) : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Names as a quoted list for a sentence: "A", "B" and "C". */
export function quoteList(names: readonly string[]): string {
  const quoted = names.map((n) => `"${n}"`);
  return quoted.length < 2 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`;
}

/** The upload route's body limit (8 MiB, counted after JSON escaping) less room for the other fields. */
const MAX_UPLOAD_BODY_BYTES = 8 * 1024 * 1024 - 4 * 1024;

/** The export in a chosen file. The size is checked before the file is read: a wrong pick can be gigabytes. */
export async function readImportFile(file: {
  size: number;
  text(): Promise<string>;
}): Promise<DashboardExport> {
  if (file.size > MAX_EXPORT_FILE_BYTES)
    throw new ImportError(
      `This file is larger than a Patchbay export can be (${MAX_EXPORT_FILE_BYTES / 1024 / 1024} MB).`,
    );
  let json: unknown;
  try {
    json = JSON.parse((await file.text()).replace(/^﻿/, ''));
  } catch {
    throw new ImportError('This file is not a Patchbay export: it is not valid JSON, or it is incomplete.');
  }
  let exp: DashboardExport;
  try {
    // Also where a file from a newer Patchbay is turned away with advice to update, before any request.
    exp = readExport(json);
  } catch (e) {
    if (e instanceof ExportFormatError) throw new ImportError(e.message);
    throw e;
  }
  // The server would answer a generic 413 only after reading the whole body; say it plainly here.
  const docBytes = new TextEncoder().encode(JSON.stringify(exp.doc)).length;
  if (docBytes > LIMITS.documentBytes)
    throw new ImportError(
      `The dashboard would take ${formatKb(docBytes)}; a dashboard document is limited to ${formatKb(LIMITS.documentBytes)}. Remove datasets or inline rows you do not need, then export it again.`,
    );
  return exp;
}

export interface PreparedFile {
  id: string;
  name: string;
  rows: number;
  columns: number;
  bytes: number;
  /** The packed table as uploaded (format "table"). */
  content: string;
}

/** Each file as it will be uploaded, measured once. */
export function prepareFiles(exp: DashboardExport): PreparedFile[] {
  const encoder = new TextEncoder();
  return exp.files.map((f) => {
    const content = JSON.stringify({ columns: f.columns, data: f.data });
    const bytes = encoder.encode(content).length;
    // The upload sends the table as a JSON string, which escaping can nearly double; the route caps that body.
    const wireBytes = encoder.encode(JSON.stringify(content)).length;
    if (bytes > MAX_TABLE_FILE_BYTES || wireBytes > MAX_UPLOAD_BODY_BYTES)
      throw new ImportError(
        `The file "${f.name}" in this export is too large to import (${formatSize(bytes)}; at most ${formatSize(MAX_TABLE_FILE_BYTES)} per file).`,
      );
    return { id: f.id, name: f.name, rows: f.data.length, columns: f.columns.length, bytes, content };
  });
}

const datasetNames = (doc: DashboardDoc, ids: Iterable<string>) => {
  const wanted = new Set(ids);
  return doc.datasets.filter((d) => wanted.has(d.id)).map((d) => d.name);
};

export interface ImportSummary {
  title: string;
  datasets: number;
  widgets: number;
  files: number;
  bytes: number;
  /** Datasets that used secrets where the file came from (removed on export, or removed by the import). */
  secretDatasets: string[];
  /** Upload datasets whose file is not in the export. */
  missingFileDatasets: string[];
  exportedAt: string | null;
}

/** `files` are the export's files as `prepareFiles` made them once, so a large file is not packed a second time. */
export function importSummary(exp: DashboardExport, files: readonly PreparedFile[]): ImportSummary {
  const { uploads, secrets } = portability(exp.doc);
  const carried = new Set(exp.files.map((f) => f.id));
  return {
    title: exp.doc.title,
    datasets: exp.doc.datasets.length,
    widgets: exp.doc.widgets.length,
    files: exp.files.length,
    bytes: files.reduce((sum, f) => sum + f.bytes, 0),
    secretDatasets: datasetNames(exp.doc, [...exp.secretsRemovedFrom, ...secrets.map((s) => s.datasetId)]),
    missingFileDatasets: datasetNames(
      exp.doc,
      uploads.filter((u) => !carried.has(u.fileId)).map((u) => u.datasetId),
    ),
    exportedAt: exp.exportedAt,
  };
}

export interface ExportSummary {
  datasets: number;
  widgets: number;
  uploadDatasets: string[];
  /** Whether the file will carry the uploaded tables (editors only). */
  filesIncluded: boolean;
  secretDatasets: string[];
  /** Addresses that seem to hold a key in the URL itself: the file will carry it. */
  keyInUrl: { dataset: string; params: string[] }[];
}

export function exportSummary(doc: DashboardDoc, canEdit: boolean): ExportSummary {
  const { uploads, secrets } = portability(doc);
  return {
    datasets: doc.datasets.length,
    widgets: doc.widgets.length,
    uploadDatasets: datasetNames(
      doc,
      uploads.map((u) => u.datasetId),
    ),
    filesIncluded: canEdit && uploads.length > 0,
    secretDatasets: datasetNames(
      doc,
      secrets.map((s) => s.datasetId),
    ),
    keyInUrl: doc.datasets.flatMap((d) => {
      if (d.source.kind !== 'http' && d.source.kind !== 'feed') return [];
      const params = credentialLikeParams(d.source.url);
      return params.length ? [{ dataset: d.name, params }] : [];
    }),
  };
}

/** Within this share of the import limit, a stored table may come out of an export larger than an import accepts. */
const NEAR_IMPORT_LIMIT = 0.9;

/**
 * Included files an import may refuse. A stored upload is measured as the table it became, which can be larger than
 * the file uploaded (CSV values gain quotes, dates become numbers), so a 5 MB CSV can export as a table over the
 * import limit. Its stored size is close to the packed table in the export, so those near the limit are named too.
 */
export function largeExportFiles(
  files: readonly Pick<UploadedFile, 'id' | 'name' | 'size' | 'storedBytes'>[],
): { id: string; name: string; bytes: number; over: boolean }[] {
  return files.flatMap((f) => {
    const bytes = f.storedBytes ?? f.size;
    if (bytes < MAX_TABLE_FILE_BYTES * NEAR_IMPORT_LIMIT) return [];
    return [{ id: f.id, name: f.name, bytes, over: bytes > MAX_TABLE_FILE_BYTES }];
  });
}

export interface ImportCalls {
  call: <T>(path: string, options: { body?: unknown; dashboardId?: string }) => Promise<T>;
  saveEditKey: (id: string, key: string, title: string) => void;
  /** Repeats a request the server turned away for now (lib/retry.ts). */
  retry: <T>(task: () => Promise<T>) => Promise<T>;
  onProgress?: (step: { done: number; total: number; name: string | null }) => void;
}

export interface ImportResult {
  id: string;
  notes: string[];
  failed: { id: string; name: string; message: string }[];
}

/**
 * Creates the dashboard, then uploads its files one at a time (the server parses one upload at a time anyway). A file
 * that fails does not stop the others; the dashboard stays and the caller lists what is missing.
 */
export async function runImport(
  exp: DashboardExport,
  files: PreparedFile[],
  calls: ImportCalls,
): Promise<ImportResult> {
  calls.onProgress?.({ done: 0, total: files.length, name: null });
  // Not retried: a create whose answer was lost may have landed, and a second one would be a second dashboard.
  const created = await calls.call<{ envelope: DashboardEnvelope; editKey?: string; notes: string[] }>(
    '/api/dashboards/import',
    { body: { doc: exp.doc, files: files.map(({ content: _content, ...declared }) => declared) } },
  );
  const id = created.envelope.meta.id;
  // Before the uploads: an anonymous dashboard's uploads need the key.
  if (created.editKey) calls.saveEditKey(id, created.editKey, created.envelope.doc.title);
  const failed: ImportResult['failed'] = [];
  for (const [index, f] of files.entries()) {
    calls.onProgress?.({ done: index, total: files.length, name: f.name });
    try {
      await calls.retry(() =>
        calls.call(`/api/dashboards/${id}/files`, {
          body: { name: f.name, format: 'table', fileId: f.id, content: f.content },
          dashboardId: id,
        }),
      );
    } catch (e) {
      // A retry whose first attempt landed finds the file stored already: that is success.
      if (e instanceof ApiError && e.status === 409 && e.body.code === 'FILE_EXISTS') continue;
      failed.push({
        id: f.id,
        name: f.name,
        message: e instanceof Error ? e.message : 'Something went wrong',
      });
    }
  }
  calls.onProgress?.({ done: files.length, total: files.length, name: null });
  return { id, notes: created.notes, failed };
}

/**
 * Downloads the export through fetch rather than a link: the editors of an anonymous dashboard prove themselves with
 * a header, which a link cannot send. A stream cut off midway rejects in blob(), so a half file is never saved.
 */
export async function downloadExport(id: string, title: string): Promise<void> {
  const key = getEditKey(id);
  let res: Response;
  try {
    res = await fetch(`/api/dashboards/${id}/export`, {
      credentials: 'same-origin',
      headers: key ? { 'x-edit-key': key } : {},
    });
  } catch (e) {
    throw new NetworkError(e);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new ApiError(res.status, String(body.error ?? res.statusText), body);
  }
  let blob: Blob;
  try {
    blob = await res.blob();
  } catch (e) {
    throw new NetworkError(e);
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = exportFileName(title);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
