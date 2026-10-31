/**
 * Resolves a dataset definition into rows: load the source, run the pipeline,
 * optionally accumulate a rolling history, cap what goes over the wire.
 *
 * Pipelines run on the server so the browser, the MCP agent and the PNG
 * renderer all see exactly the same numbers.
 *
 * Everything held in memory is bounded by approximate bytes: parsed tables
 * (uploads, inline rows, HTTP responses), recent results and accumulate
 * buffers. Loads of the same table are shared while in flight, so a burst of
 * viewers on one dashboard costs one parse, not one per viewer.
 */
import {
  type Dataset,
  type DatasetResult,
  type DataTable,
  FEED_MIN_REFRESH_SEC,
  HTTP_MIN_REFRESH_SEC,
  hashTable,
  inferTable,
  isStaticSource,
  type PipelineResult,
  sourceSecretIds,
  type Transform,
  TransformError,
  wireSize,
} from '@patchbay/core';

import type { ConnectorService } from '../connectors/registry.ts';
import { FeedService } from '../feeds/service.ts';
import type { FolderStore } from '../store/folder-store.ts';
import { HttpError } from '../util/errors.ts';
import { BusyError, Gate } from '../util/gate.ts';
import { approxTableBytes, ByteLru } from '../util/lru.ts';
import { OutboundLimiter } from '../util/outbound.ts';
import { currentClient } from '../util/request-context.ts';
import { type Credential, safeFetchJson, type UpstreamTestSeam } from '../util/safe-fetch.ts';
import { InlineRunner, type PipelineRunner } from './pipeline-pool.ts';
import { MAX_RESULT_BYTES, tooLargeResult } from './result-wire.ts';
import type { UploadInput } from './upload-parse.ts';

export const MAX_ROWS_OUT = 10_000;
const MAX_ROWS_IN = 100_000;
/** Default cap on the table an HTTP source may produce; a 5 MB body of short values is far more. */
export const DEFAULT_MAX_SOURCE_CELLS = 500_000;
const HTTP_TTL_MS = HTTP_MIN_REFRESH_SEC * 1000;
/** A failing address is not asked again sooner than a working one would be. */
const HTTP_ERROR_TTL_MS = HTTP_TTL_MS;
/** Results are reused this briefly: long enough to absorb a burst of viewers, short enough for `now()` in steps. */
const RESULT_TTL_MS = 5_000;
export const DEFAULT_CACHE_BYTES = 48 * 1024 * 1024;
const RESULT_CACHE_BYTES = 16 * 1024 * 1024;
const BUFFER_BYTES = 16 * 1024 * 1024;

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

/** Infers a table of at most `maxCells` cells, judging the width from the first records so it never builds more. */
export function cappedTable(records: unknown[], maxCells: number): { table: DataTable; capped: boolean } {
  const width = Math.max(1, inferTable(records.slice(0, 200)).columns.length);
  const maxRows = Math.max(1, Math.min(MAX_ROWS_IN, Math.floor(maxCells / width)));
  let table = inferTable(records, { maxRows });
  let capped = records.length > maxRows;
  // Later records may add columns the first ones did not have.
  const cells = table.rows.length * table.columns.length;
  if (cells > maxCells) {
    table = {
      columns: table.columns,
      rows: table.rows.slice(0, Math.floor(maxCells / table.columns.length)),
    };
    capped = true;
  }
  return { table, capped };
}

/** FNV-1a over a string: tells inline row sets apart without keeping them. */
function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + text.length.toString(36);
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
  /** Throws when this instance does not fetch URLs (http and feed sources) for the dashboard. */
  urlPolicy?: (target: DashboardTarget) => void;
  /** OFFLINE=1: feeds return their deterministic sample instead of fetching. */
  offline?: boolean;
  /** Memory for parsed tables (uploads, inline rows, HTTP responses), in bytes. */
  cacheBytes?: number;
  /** Largest table an HTTP source may produce, in cells; the rest of the response is dropped. */
  maxSourceCells?: number;
  /** Tests only: the admission gates. */
  heavy?: Gate;
  outbound?: OutboundLimiter;
  /** Tests only, never from the environment. */
  upstreamTest?: UpstreamTestSeam;
}

type CacheEntry =
  | { table: DataTable; at: number; stamp: string; capped?: boolean }
  | { error: { status: number; message: string }; at: number };

interface Loaded {
  table: DataTable;
  fetchedAt: number;
  warning?: string;
  /** Identifies the credentials a response was fetched with ("" for none); part of every key derived from it. */
  credentialKey: string;
  /** For sources that change only when edited: which content this is. A new reading exactly when it changes. */
  stamp?: string;
}

type Computed = Pick<DatasetResult, 'table' | 'hash' | 'truncated' | 'trace' | 'error'>;

interface HistoryBuffer {
  rows: DataTable['rows'];
  reading: string;
  source: string;
  rowBytes: number;
}

export class DataService {
  private readonly connectors: ConnectorService;
  private readonly store: FolderStore;
  /**
   * Parsed tables. HTTP entries are keyed by credentials + URL + path: two datasets with the same URL share a
   * response only when they would send the same credentials, so a public dataset never receives a secret-backed
   * response, two users never share one, and replacing a value (a new revision) invalidates at once.
   */
  private readonly tables: ByteLru<CacheEntry>;
  private readonly loading = new Map<string, Promise<CacheEntry>>();
  /** Recent pipeline results, keyed by the identity of the input table. */
  private readonly results = new ByteLru<Computed>(RESULT_CACHE_BYTES);
  private readonly computing = new Map<string, Promise<Computed>>();
  private readonly tableIds = new WeakMap<DataTable, number>();
  private nextTableId = 1;
  /** Rolling buffers for `accumulate`, keyed by dashboard + dataset. In memory by design. */
  private readonly buffers = new ByteLru<HistoryBuffer>(BUFFER_BYTES);

  private readonly pipeline: PipelineRunner;
  private readonly credentialsFor: CredentialResolver;
  private readonly urlPolicy: (target: DashboardTarget) => void;
  private readonly upstreamTest: UpstreamTestSeam | undefined;
  private readonly feeds: FeedService;
  private readonly maxSourceCells: number;
  /** Loading a stored upload builds its whole table on this thread: only a couple at a time. */
  private readonly heavy: Gate;
  private readonly outbound: OutboundLimiter;

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
    this.urlPolicy = options.urlPolicy ?? (() => {});
    this.upstreamTest = options.upstreamTest;
    this.tables = new ByteLru(options.cacheBytes ?? DEFAULT_CACHE_BYTES);
    this.maxSourceCells = options.maxSourceCells ?? DEFAULT_MAX_SOURCE_CELLS;
    this.heavy =
      options.heavy ?? new Gate({ concurrency: 2, maxQueue: 32, maxQueuedPerClient: 8, maxWaitMs: 20_000 });
    this.outbound = options.outbound ?? new OutboundLimiter();
    this.feeds = new FeedService({
      offline: options.offline ?? false,
      test: options.upstreamTest,
      outbound: this.outbound,
    });
  }

  /**
   * How often the live hub may refresh a dataset, in seconds, or null when it must not refresh it on a timer at all
   * (no refresh asked for, or a source that only changes when the dashboard is edited).
   */
  refreshIntervalSec(dataset: Dataset): number | null {
    if (dataset.refreshSec <= 0 || isStaticSource(dataset.source)) return null;
    const source = dataset.source;
    const min =
      source.kind === 'http'
        ? HTTP_MIN_REFRESH_SEC
        : source.kind === 'feed'
          ? FEED_MIN_REFRESH_SEC
          : source.kind === 'connector'
            ? (this.connectors.get(source.connector)?.info.minRefreshSec ?? 0)
            : 0;
    return Math.max(dataset.refreshSec, min, 1);
  }

  /** Parses an uploaded file in the pipeline worker, a few at a time. */
  parseUpload(input: UploadInput): Promise<DataTable> {
    return this.heavy.run(currentClient(), () => this.pipeline.parseUpload(input));
  }

  /** Keeps a freshly saved upload's table, so the preview that usually follows does not parse it again. */
  async uploaded(dashboardId: string, fileId: string, table: DataTable) {
    const stamp = await this.store.fileStamp(dashboardId, fileId);
    if (!stamp) return;
    this.tables.set(
      `upload:${stamp.key}`,
      { table, at: stamp.mtimeMs, stamp: stamp.key },
      approxTableBytes(table),
    );
  }

  /**
   * Keyed by the stored file, not by dashboard: copies of a dashboard share their uploads through hard links, and a
   * shared file is parsed and held once. Permission was checked before this point (the caller resolved `target`).
   */
  private async loadUpload(target: DashboardTarget, fileId: string): Promise<Loaded> {
    const stamp = await this.store.fileStamp(target.id, fileId);
    if (!stamp) throw new HttpError(404, `Uploaded file "${fileId}" not found`);
    const key = `upload:${stamp.key}`;
    let entry = this.tables.get(key);
    if (!entry || !('table' in entry)) {
      let pending = this.loading.get(key);
      if (!pending) {
        pending = this.heavy
          .run(currentClient(), async (): Promise<CacheEntry> => {
            const table = await this.store.readFileTable(target.id, fileId);
            if (!table) throw new HttpError(404, `Uploaded file "${fileId}" not found`);
            return { table, at: stamp.mtimeMs, stamp: stamp.key };
          })
          .then((e) => {
            if ('table' in e) this.tables.set(key, e, approxTableBytes(e.table));
            return e;
          })
          .finally(() => this.loading.delete(key));
        this.loading.set(key, pending);
      }
      entry = await pending;
    }
    if (!('table' in entry)) throw new HttpError(500, 'Failed to load data');
    return { table: entry.table, fetchedAt: entry.at, credentialKey: '', stamp: key };
  }

  private loadInline(rows: Record<string, unknown>[]): Loaded {
    const stamp = `inline:${fnv(JSON.stringify(rows))}`;
    let entry = this.tables.get(stamp);
    if (!entry || !('table' in entry)) {
      const table = inferTable(rows);
      entry = { table, at: Date.now(), stamp };
      this.tables.set(stamp, entry, approxTableBytes(table));
    }
    return { table: entry.table, fetchedAt: entry.at, credentialKey: '', stamp };
  }

  private async loadHttp(
    target: DashboardTarget,
    dataset: Dataset,
    source: Extract<Dataset['source'], { kind: 'http' }>,
  ): Promise<Loaded> {
    // Resolved on every call, before the cache: the switch, the owner's rights and the binding apply at once.
    const credentials = sourceSecretIds(source).length ? await this.credentialsFor(target, dataset) : [];
    const credentialKey = credentials
      .map((c) => `${target.ownerId}/${c.id}@${c.revision}`)
      .sort()
      .join(',');
    const key = `http:${credentialKey}|${source.url}#${source.path ?? ''}`;
    let entry = this.tables.get(key);
    if (!entry) {
      let pending = this.loading.get(key);
      if (!pending) {
        pending = this.fetchHttp(key, source, credentials).finally(() => this.loading.delete(key));
        this.loading.set(key, pending);
      }
      entry = await pending;
    }
    if ('error' in entry) throw new HttpError(entry.error.status as 400, entry.error.message);
    return {
      table: entry.table,
      fetchedAt: entry.at,
      credentialKey,
      ...(entry.capped
        ? {
            warning: `Showing the first ${entry.table.rows.length.toLocaleString('en-US')} rows of the response`,
          }
        : {}),
    };
  }

  private async fetchHttp(
    key: string,
    source: Extract<Dataset['source'], { kind: 'http' }>,
    credentials: Credential[],
  ): Promise<CacheEntry> {
    try {
      const json = await this.outbound.run(currentClient(), source.url, () =>
        safeFetchJson(source.url, {
          credentials,
          ...(this.upstreamTest ? { test: this.upstreamTest } : {}),
        }),
      );
      const { table, capped } = cappedTable(recordsFrom(json, source.path), this.maxSourceCells);
      const entry: CacheEntry = { table, at: Date.now(), stamp: '', ...(capped ? { capped } : {}) };
      this.tables.set(key, entry, approxTableBytes(table), HTTP_TTL_MS);
      return entry;
    } catch (e) {
      // Our own refusals (busy, over the host's budget) say nothing about the address, so they are not remembered.
      if (e instanceof HttpError && e.status !== 429 && e.status !== 503) {
        const entry: CacheEntry = { error: { status: e.status, message: e.message }, at: Date.now() };
        this.tables.set(key, entry, 256 + e.message.length * 2, HTTP_ERROR_TTL_MS);
      }
      throw e;
    }
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
        return this.loadInline(source.rows);
      case 'upload':
        return this.loadUpload(target, source.fileId);
      case 'http':
        this.urlPolicy(target);
        return this.loadHttp(target, dataset, source);
      case 'feed': {
        this.urlPolicy(target);
        const feed = await this.feeds.load(source.url);
        const rows = feed.table.rows.slice(0, source.limit);
        return { table: { columns: feed.table.columns, rows }, fetchedAt: feed.fetchedAt, credentialKey: '' };
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
    if (!buffer || buffer.source !== source) buffer = { rows: [], reading: '', source, rowBytes: 0 };
    // Only append when the source actually produced a new reading: a new fetch time, or for an upload or inline
    // rows, new content. Merely reading a static source again is not a reading.
    const reading = loaded.stamp ?? `t${fetchedAt}`;
    if (reading !== buffer.reading) {
      const added = table.rows.slice(0, dataset.accumulate).map((r) => ({ ...r, fetched_at: fetchedAt }));
      if (added.length) {
        const sample = approxTableBytes({ columns: table.columns, rows: added }) / added.length;
        buffer.rowBytes = buffer.rowBytes ? (buffer.rowBytes + sample) / 2 : sample;
      }
      buffer.rows.push(...added);
      buffer.reading = reading;
      if (buffer.rows.length > dataset.accumulate)
        buffer.rows.splice(0, buffer.rows.length - dataset.accumulate);
    }
    this.buffers.set(key, buffer, 128 + buffer.rows.length * buffer.rowBytes);
    const columns = table.columns.some((c) => c.name === 'fetched_at')
      ? table.columns
      : [...table.columns, { name: 'fetched_at', type: 'time' as const }];
    return { columns, rows: [...buffer.rows] };
  }

  private tableId(table: DataTable): number {
    let id = this.tableIds.get(table);
    if (id === undefined) {
      id = this.nextTableId++;
      this.tableIds.set(table, id);
    }
    return id;
  }

  private async compute(input: DataTable, transforms: Transform[], max: number): Promise<Computed> {
    const { table, trace }: PipelineResult = await this.pipeline.run(input, transforms);
    const truncated = table.rows.length > max;
    const out: DataTable = truncated ? { columns: table.columns, rows: table.rows.slice(-max) } : table;
    // Measured in the compact form the web app reads, before anything is hashed, kept or serialised: a result too
    // large to send is an error for every reader alike (widget, agent, snapshot), and only the error is kept.
    const size = wireSize(out, 'arrays');
    if (size > MAX_RESULT_BYTES) return tooLargeResult({ table: out, hash: '', truncated, trace }, size);
    return { table: out, hash: hashTable(out), truncated, trace };
  }

  /** The same input table with the same steps gives the same result: computed once for concurrent callers. */
  private computeShared(input: DataTable, transforms: Transform[], max: number): Promise<Computed> {
    const key = `${this.tableId(input)}|${max}|${JSON.stringify(transforms)}`;
    const hit = this.results.get(key);
    if (hit) return Promise.resolve(hit);
    let pending = this.computing.get(key);
    if (!pending) {
      pending = this.compute(input, transforms, max)
        .then((c) => {
          this.results.set(key, c, approxTableBytes(c.table) + c.hash.length, RESULT_TTL_MS);
          return c;
        })
        .finally(() => this.computing.delete(key));
      this.computing.set(key, pending);
    }
    return pending;
  }

  /**
   * Errors of the dataset itself come back in the result, for the widget to show. A BusyError is thrown instead:
   * the server, not the dataset, is the problem, and callers answer 503 or skip a refresh.
   */
  async resolve(
    target: DashboardTarget,
    dataset: Dataset,
    options: { maxRows?: number } = {},
  ): Promise<DatasetResult> {
    const base = { datasetId: dataset.id };
    try {
      const loaded = await this.loadSource(target, dataset);
      const max = options.maxRows ?? MAX_ROWS_OUT;
      const computed =
        dataset.accumulate > 0
          ? await this.compute(this.accumulate(target, dataset, loaded), dataset.transforms, max)
          : await this.computeShared(loaded.table, dataset.transforms, max);
      return {
        ...base,
        ...computed,
        fetchedAt: new Date(loaded.fetchedAt).toISOString(),
        ...(computed.error || loaded.warning ? { error: computed.error ?? loaded.warning } : {}),
      };
    } catch (e) {
      if (e instanceof BusyError) throw e;
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
    this.buffers.deleteWhere((key) => key.startsWith(`${dashboardId}:`));
    // Uploads are cached by file (see loadUpload), possibly shared with copies; a deleted one is never asked for
    // again and leaves the byte-bounded cache in its turn. Only files without inode numbers are keyed by path.
    this.tables.deleteWhere((key) => key.startsWith(`upload:${dashboardId}/`));
  }
}
