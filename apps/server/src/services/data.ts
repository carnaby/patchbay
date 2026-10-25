/**
 * Resolves a dataset definition into rows: load the source, run the pipeline,
 * optionally accumulate a rolling history, cap what goes over the wire.
 *
 * Pipelines run on the server so the browser, the MCP agent and the PNG
 * renderer all see exactly the same numbers.
 */
import {
  type Dataset,
  type DatasetResult,
  type DataTable,
  hashTable,
  inferTable,
  runPipeline,
  type Source,
  TransformError,
} from '@patchbay/core';
import type { ConnectorService } from '../connectors/registry.ts';
import type { FolderStore } from '../store/folder-store.ts';
import { HttpError } from '../util/errors.ts';
import { safeFetchJson } from '../util/safe-fetch.ts';

export const MAX_ROWS_OUT = 10_000;
const MAX_ROWS_IN = 100_000;

function pick(json: unknown, path: string | undefined): unknown {
  if (!path) return json;
  let cur: unknown = json;
  for (const part of path.split('.').filter(Boolean)) {
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, part)) {
      throw new HttpError(400, `Path "${path}" not found in the response (stopped at "${part}")`);
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Finds the array of records in a JSON response: the given path, the root, or the first array property. */
export function recordsFrom(json: unknown, path?: string): unknown[] {
  const target = pick(json, path);
  if (Array.isArray(target)) return target;
  if (target && typeof target === 'object') {
    const firstArray = Object.values(target).find(Array.isArray);
    if (firstArray && !path) return firstArray;
    return [target];
  }
  throw new HttpError(400, 'The response does not contain a list of records');
}

interface HttpCacheEntry {
  table: DataTable;
  at: number;
}

export class DataService {
  private readonly connectors: ConnectorService;
  private readonly store: FolderStore;
  private readonly httpCache = new Map<string, HttpCacheEntry>();
  /** Rolling buffers for `accumulate`, keyed by dashboard + dataset. In memory by design. */
  private readonly buffers = new Map<string, { rows: DataTable['rows']; lastFetchedAt: number }>();

  constructor(connectors: ConnectorService, store: FolderStore) {
    this.connectors = connectors;
    this.store = store;
  }

  async loadSource(
    dashboardId: string,
    source: Source,
  ): Promise<{ table: DataTable; fetchedAt: number; warning?: string }> {
    switch (source.kind) {
      case 'connector': {
        const r = await this.connectors.load(source.connector, source.params);
        return {
          table: r.table,
          fetchedAt: r.fetchedAt,
          ...(r.stale ? { warning: `Showing cached data: ${r.stale}` } : {}),
        };
      }
      case 'inline':
        return { table: inferTable(source.rows), fetchedAt: Date.now() };
      case 'upload': {
        const table = await this.store.readFileTable(dashboardId, source.fileId);
        if (!table) throw new HttpError(404, `Uploaded file "${source.fileId}" not found`);
        return { table, fetchedAt: Date.now() };
      }
      case 'http': {
        const key = `${source.url}#${source.path ?? ''}`;
        const hit = this.httpCache.get(key);
        if (hit && Date.now() - hit.at < 30_000) return { table: hit.table, fetchedAt: hit.at };
        const json = await safeFetchJson(source.url);
        const table = inferTable(recordsFrom(json, source.path), { maxRows: MAX_ROWS_IN });
        this.httpCache.set(key, { table, at: Date.now() });
        if (this.httpCache.size > 200) this.httpCache.delete(this.httpCache.keys().next().value!);
        return { table, fetchedAt: Date.now() };
      }
    }
  }

  private accumulate(key: string, dataset: Dataset, table: DataTable, fetchedAt: number): DataTable {
    const buffer = this.buffers.get(key) ?? { rows: [], lastFetchedAt: 0 };
    // Only append when the upstream actually produced a new reading.
    if (fetchedAt !== buffer.lastFetchedAt) {
      buffer.rows.push(...table.rows.map((r) => ({ ...r, fetched_at: fetchedAt })));
      buffer.lastFetchedAt = fetchedAt;
      if (buffer.rows.length > dataset.accumulate)
        buffer.rows.splice(0, buffer.rows.length - dataset.accumulate);
      this.buffers.set(key, buffer);
    }
    const columns = table.columns.some((c) => c.name === 'fetched_at')
      ? table.columns
      : [...table.columns, { name: 'fetched_at', type: 'time' as const }];
    return { columns, rows: [...buffer.rows] };
  }

  async resolve(
    dashboardId: string,
    dataset: Dataset,
    options: { maxRows?: number } = {},
  ): Promise<DatasetResult> {
    const base = { datasetId: dataset.id };
    try {
      const loaded = await this.loadSource(dashboardId, dataset.source);
      const input =
        dataset.accumulate > 0
          ? this.accumulate(
              // Changing the source starts a fresh history instead of mixing two series.
              `${dashboardId}:${dataset.id}:${JSON.stringify(dataset.source)}`,
              dataset,
              loaded.table,
              loaded.fetchedAt,
            )
          : loaded.table;
      const { table, trace } = runPipeline(input, dataset.transforms);
      const max = options.maxRows ?? MAX_ROWS_OUT;
      const truncated = table.rows.length > max;
      const out: DataTable = truncated ? { columns: table.columns, rows: table.rows.slice(-max) } : table;
      return {
        ...base,
        table: out,
        fetchedAt: new Date(loaded.fetchedAt).toISOString(),
        hash: hashTable(out),
        truncated,
        trace,
        ...(loaded.warning ? { error: loaded.warning } : {}),
      };
    } catch (e) {
      const message =
        e instanceof HttpError || e instanceof TransformError || e instanceof Error
          ? e.message
          : 'Failed to load data';
      return {
        ...base,
        table: { columns: [], rows: [] },
        fetchedAt: new Date().toISOString(),
        hash: `error:${message}`,
        truncated: false,
        error: message,
      };
    }
  }

  forget(dashboardId: string) {
    for (const key of this.buffers.keys()) if (key.startsWith(`${dashboardId}:`)) this.buffers.delete(key);
  }
}
