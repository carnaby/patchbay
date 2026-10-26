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
  sourceSecretIds,
  TransformError,
} from '@patchbay/core';

import type { ConnectorService } from '../connectors/registry.ts';
import type { FolderStore } from '../store/folder-store.ts';
import { HttpError } from '../util/errors.ts';
import { type Credential, safeFetchJson, type UpstreamTestSeam } from '../util/safe-fetch.ts';
import { InlineRunner, type PipelineRunner } from './pipeline-pool.ts';

export const MAX_ROWS_OUT = 10_000;
/** Upper bound on live history buffers kept in memory (least recently used are dropped). */
const MAX_BUFFERS = 500;
const MAX_ROWS_IN = 100_000;
const HTTP_TTL_MS = 30_000;

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

/**
 * The dashboard a dataset belongs to. Secrets are resolved against its owner, never against whoever is asking, and
 * uploads and accumulate buffers are looked up by its id.
 */
export interface DashboardTarget {
  id: string;
  ownerId: string | null;
}

/** Decrypts a dataset's credentials or throws an HttpError with a message that is safe to show any viewer. */
export type CredentialResolver = (target: DashboardTarget, dataset: Dataset) => Promise<Credential[]>;

export interface DataServiceOptions {
  credentials?: CredentialResolver;
  /** Tests only, never from the environment. */
  upstreamTest?: UpstreamTestSeam;
}

interface HttpCacheEntry {
  table: DataTable;
  at: number;
}

interface Loaded {
  table: DataTable;
  fetchedAt: number;
  warning?: string;
  /** Identifies the credentials a response was fetched with ("" for none); part of every key derived from it. */
  credentialKey: string;
}

export class DataService {
  private readonly connectors: ConnectorService;
  private readonly store: FolderStore;
  /**
   * Keyed by credentials + URL + path. Two datasets with the same URL share a response only when they would send the
   * same credentials, so a public dataset never receives a secret-backed response, two users never share one, and
   * replacing a value (a new revision) invalidates at once.
   */
  private readonly httpCache = new Map<string, HttpCacheEntry>();
  private readonly httpInflight = new Map<string, Promise<HttpCacheEntry>>();
  /** Rolling buffers for `accumulate`, keyed by dashboard + dataset. In memory by design. */
  private readonly buffers = new Map<
    string,
    { rows: DataTable['rows']; lastFetchedAt: number; source: string }
  >();

  private readonly pipeline: PipelineRunner;
  private readonly credentialsFor: CredentialResolver;
  private readonly upstreamTest: UpstreamTestSeam | undefined;

  constructor(
    connectors: ConnectorService,
    store: FolderStore,
    pipeline: PipelineRunner = new InlineRunner(),
    options: DataServiceOptions = {},
  ) {
    this.connectors = connectors;
    this.store = store;
    this.pipeline = pipeline;
    // Without a resolver nothing may be sent: a dataset with secrets is never fetched without them.
    this.credentialsFor =
      options.credentials ??
      (async () => {
        throw new HttpError(403, 'Credentials are turned off on this server.');
      });
    this.upstreamTest = options.upstreamTest;
  }

  async loadSource(target: DashboardTarget, dataset: Dataset): Promise<Loaded> {
    const source = dataset.source;
    switch (source.kind) {
      case 'connector': {
        const r = await this.connectors.load(source.connector, source.params);
        return {
          table: r.table,
          fetchedAt: r.fetchedAt,
          credentialKey: '',
          ...(r.stale ? { warning: `Showing cached data: ${r.stale}` } : {}),
        };
      }
      case 'inline':
        return { table: inferTable(source.rows), fetchedAt: Date.now(), credentialKey: '' };
      case 'upload': {
        const table = await this.store.readFileTable(target.id, source.fileId);
        if (!table) throw new HttpError(404, `Uploaded file "${source.fileId}" not found`);
        return { table, fetchedAt: Date.now(), credentialKey: '' };
      }
      case 'http': {
        // Resolved on every call, before the cache: the switch, the owner's rights and the binding apply at once.
        const credentials = sourceSecretIds(source).length ? await this.credentialsFor(target, dataset) : [];
        const credentialKey = credentials
          .map((c) => `${target.ownerId}/${c.id}@${c.revision}`)
          .sort()
          .join(',');
        const key = `${credentialKey}|${source.url}#${source.path ?? ''}`;
        const hit = this.httpCache.get(key);
        if (hit && Date.now() - hit.at < HTTP_TTL_MS)
          return { table: hit.table, fetchedAt: hit.at, credentialKey };
        let pending = this.httpInflight.get(key);
        if (!pending) {
          pending = (async () => {
            const json = await safeFetchJson(source.url, {
              credentials,
              ...(this.upstreamTest ? { test: this.upstreamTest } : {}),
            });
            const entry = {
              table: inferTable(recordsFrom(json, source.path), { maxRows: MAX_ROWS_IN }),
              at: Date.now(),
            };
            this.httpCache.set(key, entry);
            if (this.httpCache.size > 200) this.httpCache.delete(this.httpCache.keys().next().value!);
            return entry;
          })().finally(() => this.httpInflight.delete(key));
          this.httpInflight.set(key, pending);
        }
        const entry = await pending;
        return { table: entry.table, fetchedAt: entry.at, credentialKey };
      }
    }
  }

  private accumulate(target: DashboardTarget, dataset: Dataset, loaded: Loaded): DataTable {
    const { table, fetchedAt } = loaded;
    const key = `${target.id}:${dataset.id}`;
    // Changing the source, or replacing a secret's value (perhaps with another account's token), starts a fresh
    // history instead of mixing two series.
    const source = `${JSON.stringify(dataset.source)}|${loaded.credentialKey}`;
    let buffer = this.buffers.get(key);
    if (!buffer || buffer.source !== source) buffer = { rows: [], lastFetchedAt: 0, source };
    // Re-insert to keep the Map in least-recently-used order.
    this.buffers.delete(key);
    this.buffers.set(key, buffer);
    if (this.buffers.size > MAX_BUFFERS) this.buffers.delete(this.buffers.keys().next().value!);
    // Only append when the upstream actually produced a new reading.
    if (fetchedAt !== buffer.lastFetchedAt) {
      buffer.rows.push(
        ...table.rows.slice(0, dataset.accumulate).map((r) => ({ ...r, fetched_at: fetchedAt })),
      );
      buffer.lastFetchedAt = fetchedAt;
      if (buffer.rows.length > dataset.accumulate)
        buffer.rows.splice(0, buffer.rows.length - dataset.accumulate);
    }
    const columns = table.columns.some((c) => c.name === 'fetched_at')
      ? table.columns
      : [...table.columns, { name: 'fetched_at', type: 'time' as const }];
    return { columns, rows: [...buffer.rows] };
  }

  async resolve(
    target: DashboardTarget,
    dataset: Dataset,
    options: { maxRows?: number } = {},
  ): Promise<DatasetResult> {
    const base = { datasetId: dataset.id };
    try {
      const loaded = await this.loadSource(target, dataset);
      const input = dataset.accumulate > 0 ? this.accumulate(target, dataset, loaded) : loaded.table;
      const { table, trace } = await this.pipeline.run(input, dataset.transforms);
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
