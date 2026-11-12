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
import { createHash } from 'node:crypto';
import {
  CACHED_DATA_WARNING,
  type DashboardDoc,
  type Dataset,
  type DatasetResult,
  type DataTable,
  FEED_MIN_REFRESH_SEC,
  findRecords,
  HTTP_MIN_REFRESH_SEC,
  type HttpMethod,
  hashTable,
  INFER_MAX_COLUMNS,
  inferTableCapped,
  isStaticSource,
  PathNotFoundError,
  PIPELINE_LIMITS,
  type PipelineInputs,
  type PipelineResult,
  parameterRefs,
  pickPath,
  sourceSecretIds,
  TableTooWideError,
  type Transform,
  upstreamOf,
  wireSize,
} from '@patchbay/core';

import type { ConnectorService } from '../connectors/registry.ts';
import { FeedService } from '../feeds/service.ts';
import type { FolderStore } from '../store/folder-store.ts';
import { HttpError, lastingError } from '../util/errors.ts';
import { BusyError, Gate } from '../util/gate.ts';
import { HEAVY_FILE_BYTES, HEAVY_PIPELINE_CELLS, heavyWork } from '../util/heavy.ts';
import { approxTableBytes, ByteLru } from '../util/lru.ts';
import { OutboundLimiter } from '../util/outbound.ts';
import type { PrivateHosts } from '../util/private-hosts.ts';
import { currentClient } from '../util/request-context.ts';
import { type Credential, safeFetchJson, type UpstreamTestSeam } from '../util/safe-fetch.ts';
import { cellsOf, InlineRunner, type PipelineRunner } from './pipeline-pool.ts';
import { MAX_RESULT_BYTES, tooLargeResult } from './result-wire.ts';
import { errorResult, ResolveScope, type ScopeOptions } from './scope.ts';
import type { UploadInput } from './upload-parse.ts';

export const MAX_ROWS_OUT = 10_000;

/** The message for a dataset resolved without its document: it reads other datasets, which only a scope can load. */
export const readsOtherDatasets = (id: string) =>
  `Dataset "${id}" reads other datasets and can only be loaded with its dashboard`;
/** The message for a dataset with filter references resolved without its document: only a scope binds values. */
export const usesFilters = (id: string) => `Dataset "${id}" uses filters; resolve it through its dashboard.`;
/** Default cap on the table an HTTP source may produce; a 5 MB body of short values is far more. */
export const DEFAULT_MAX_SOURCE_CELLS = 500_000;
const HTTP_TTL_MS = HTTP_MIN_REFRESH_SEC * 1000;
/** A failing address is not asked again sooner than a working one would be. */
const HTTP_ERROR_TTL_MS = HTTP_TTL_MS;
/** Results are reused this briefly: long enough to absorb a burst of viewers, short enough for `now()` in steps. */
const RESULT_TTL_MS = 5_000;
export const DEFAULT_CACHE_BYTES = 32 * 1024 * 1024;
/** Results reused for a burst of viewers (RESULT_TTL_MS); part of the memory budget in guide/deployment.md. */
const RESULT_CACHE_BYTES = 8 * 1024 * 1024;
const BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * Finds the records in a JSON response with the rules JSON uploads use too (`findRecords` in core): the given path,
 * then a list, a column-shaped object's rows, the first array property or the object itself. At most `maxCells` cells
 * of column-shaped data are turned into rows; `cappedTable` then cuts the table and says so. `maxCells` is required
 * because this runs on the main thread: a call without it would turn a dense response into rows without bound.
 */
export function recordsFrom(json: unknown, path: string | undefined, maxCells: number): unknown[] {
  let target: unknown;
  try {
    target = pickPath(json, path, 'response');
  } catch (e) {
    if (e instanceof PathNotFoundError) throw new HttpError(400, e.message);
    throw e;
  }
  const records = findRecords(target, { viaPath: Boolean(path), maxCells });
  if (!records) throw new HttpError(400, 'The response does not contain a list of records');
  return records;
}

/**
 * Infers a table of at most `maxCells` cells and `INFER_MAX_COLUMNS` columns. The limits hold while the records are
 * read (see `inferTableCapped`), so a wide record anywhere in the response cannot multiply the table before a cap
 * applies. Too many columns is an error for the dataset: dropping columns would silently change what it shows.
 */
export function cappedTable(records: unknown[], maxCells: number): { table: DataTable; capped: boolean } {
  try {
    return inferTableCapped(records, {
      maxRows: PIPELINE_LIMITS.maxRows,
      maxCells,
      maxColumns: INFER_MAX_COLUMNS,
    });
  } catch (e) {
    if (e instanceof TableTooWideError) throw new HttpError(400, e.message);
    throw e;
  }
}

/** The warning a dataset shows when its source was cut to fit the cell limit. */
const cappedWarning = (table: DataTable, of: string) =>
  `Showing the first ${table.rows.length.toLocaleString('en-US')} rows of ${of}`;

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
  /** A read-only token's preview: the operator's private hosts never apply, whoever the owner is. */
  publicOnly?: boolean;
  /**
   * An unsaved draft's preview: it shows the accumulated history of the datasets it reads but never adds to it. Its
   * fetch may be a reading of its own (another cache entry, a viewer's network rights), and the owner's history
   * must hold only the dashboard's own readings.
   */
  preview?: boolean;
}

/** Decrypts a dataset's credentials or throws an HttpError with a message that is safe to show any viewer. */
export type CredentialResolver = (target: DashboardTarget, dataset: Dataset) => Promise<Credential[]>;

export interface DataServiceOptions {
  credentials?: CredentialResolver;
  /**
   * Called before every http or feed load: throws when this instance does not fetch the URL for the dashboard,
   * otherwise returns the private hosts (ALLOW_PRIVATE_HOSTS) its sources may reach, or null for public addresses
   * only. DashboardService decides, by the dashboard's owner. http sources pass their method and, for a POST, their
   * body (a trusted showcase request is matched with both); feeds pass neither.
   */
  urlPolicy?: (
    target: DashboardTarget,
    url: string,
    method?: HttpMethod,
    body?: unknown,
  ) => PrivateHosts | null;
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
  | { error: { status: number; message: string; lasting?: boolean }; at: number };

interface Loaded {
  table: DataTable;
  fetchedAt: number;
  warning?: string;
  /** Identifies the credentials a response was fetched with ("" for none); part of every key derived from it. */
  credentialKey: string;
  /** For sources that change only when edited: which content this is. A new reading exactly when it changes. */
  stamp?: string;
  /** The cached table `table` was cut from, when it is a new object on every load (a feed's first items). */
  origin?: DataTable;
}

export type Computed = Pick<DatasetResult, 'table' | 'hash' | 'truncated' | 'trace' | 'error' | 'lasting'>;

interface HistoryBuffer {
  rows: DataTable['rows'];
  reading: string;
  source: string;
  rowBytes: number;
}

type HttpSource = Extract<Dataset['source'], { kind: 'http' }>;

/**
 * What goes out for an http source: credentials, private-host flag, method, URL and, for a POST, a SHA-256 of its JSON
 * body. A GET's key is exactly what it was before POST existed, so a deploy does not empty the cache. Two queries on
 * one URL never share a request, and a body cannot be crafted to collide with another. The two kinds never meet:
 * after the credentials a GET key goes on with its URL ("http…"), a POST key with "POST:". The path is not here: it
 * is read from the response and never sent, so datasets that differ only in it share one request.
 */
export function httpRequestKey(source: HttpSource, credentialKey: string, lan: boolean): string {
  const head = `http:${lan ? 'lan|' : ''}${credentialKey}|`;
  if (source.method !== 'POST') return head + source.url;
  const body = source.body === undefined ? '' : JSON.stringify(source.body);
  return `${head}POST:${createHash('sha256').update(body).digest('base64url')}|${source.url}`;
}

/** The cache key of a parsed table: the request key plus the path, because one response can feed several datasets. */
export function httpCacheKey(source: HttpSource, credentialKey: string, lan: boolean): string {
  return `${httpRequestKey(source, credentialKey, lan)}#${source.path ?? ''}`;
}

export class DataService {
  private readonly connectors: ConnectorService;
  private readonly store: FolderStore;
  /**
   * Parsed tables. HTTP entries are keyed by credentials + URL + path (+ method and body for a POST): two
   * datasets with the same URL share a response only when they would send the same credentials, so a public
   * dataset never receives a secret-backed response, two users never share one, and replacing a value (a new
   * revision) invalidates at once.
   */
  private readonly tables: ByteLru<CacheEntry>;
  private readonly loading = new Map<string, Promise<CacheEntry>>();
  /**
   * Responses in flight, by request, so datasets that read different paths of one response (GraphQL aliases, a status
   * page's summary.json) share one request. Only parsed tables are cached, per path.
   */
  private readonly requests = new Map<string, Promise<unknown>>();
  /**
   * Recent pipeline results, keyed by the identity of the input table: capped results for widgets, and (keys starting
   * with "full|") uncapped ones that derived datasets read. One byte budget for both.
   */
  private readonly results = new ByteLru<Computed | PipelineResult>(RESULT_CACHE_BYTES);
  private readonly computing = new Map<string, Promise<Computed | PipelineResult>>();
  private readonly tableIds = new WeakMap<DataTable, number>();
  private nextTableId = 1;
  /**
   * Capped results by uncapped table and row limit. Widget answers and the live hub serialise once per table object
   * (ResultWire), so a dataset read through a scope must give every request the same capped table while its uncapped
   * one is shared, not a new slice to hash, serialise and budget each time.
   */
  private readonly finished = new WeakMap<DataTable, Map<number, Computed>>();
  /**
   * Final capped results of datasets resolved through a scope, keyed by their lineage, the readings of its roots and
   * the target's policy (ResolveScope.finalKey). Without them every request re-runs the whole chain: a parent too
   * large for `results` is processed again for each reader. Only capped tables are kept, never an uncapped parent.
   */
  private readonly finals = new ByteLru<DatasetResult>(RESULT_CACHE_BYTES);
  private readonly finalizing = new Map<string, Promise<DatasetResult>>();
  /** Rolling buffers for `accumulate`, keyed by dashboard + dataset. In memory by design. */
  private readonly buffers = new ByteLru<HistoryBuffer>(BUFFER_BYTES);

  private readonly pipeline: PipelineRunner;
  private readonly credentialsFor: CredentialResolver;
  private readonly urlPolicy: (
    target: DashboardTarget,
    url: string,
    method?: HttpMethod,
    body?: unknown,
  ) => PrivateHosts | null;
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
        throw lastingError(403, 'Credentials are turned off on this server.');
      });
    this.urlPolicy = options.urlPolicy ?? (() => null);
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
   * Forgets parsed tables and recent results; they are built again on the next request. For an idle server under
   * memory pressure (util/memory-pressure.ts). The accumulate buffers stay: they are history, not a cache.
   */
  dropCaches() {
    this.tables.clear();
    this.results.clear();
    this.finals.clear();
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
    return this.heavy.run(currentClient(), () => heavyWork.run(() => this.pipeline.parseUpload(input)));
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
   * A stored upload's whole table, for an export; the caller checked who may read it (DashboardService.exportPlan).
   * The stamp names the stored file this table was read from, so a reader across several loads can tell when the
   * file under this id was replaced in between.
   */
  async uploadTable(target: DashboardTarget, fileId: string): Promise<{ table: DataTable; stamp: string }> {
    const { table, stamp } = await this.loadUpload(target, fileId);
    return { table, stamp: stamp ?? '' };
  }

  /**
   * Keyed by the stored file, not by dashboard: copies of a dashboard share their uploads through hard links, and a
   * shared file is parsed and held once. Permission was checked before this point (the caller resolved `target`).
   */
  private async loadUpload(target: DashboardTarget, fileId: string): Promise<Loaded> {
    const stamp = await this.store.fileStamp(target.id, fileId);
    if (!stamp) throw lastingError(404, `Uploaded file "${fileId}" not found`);
    const key = `upload:${stamp.key}`;
    let entry = this.tables.get(key);
    if (!entry || !('table' in entry)) {
      let pending = this.loading.get(key);
      if (!pending) {
        const read = async (): Promise<CacheEntry> => {
          const table = await this.store.readFileTable(target.id, fileId);
          if (!table) throw lastingError(404, `Uploaded file "${fileId}" not found`);
          return { table, at: stamp.mtimeMs, stamp: stamp.key };
        };
        pending = this.heavy
          // A large file holds its text, its parsed values and the table at once: it takes its heavy turn.
          .run(currentClient(), () => (stamp.bytes >= HEAVY_FILE_BYTES ? heavyWork.run(read) : read()))
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

  /**
   * Inline rows are at most 2,000 in a document of at most 1 MB, and the table built from them is held to the same
   * cell limit as an HTTP response, so this is cheap enough for the main thread; stored documents that predate the
   * write limits (LIMITS.inlineColumns) still load, within these limits. A refusal is remembered like a table, so a
   * crowd of viewers costs one attempt.
   */
  private loadInline(rows: Record<string, unknown>[]): Loaded {
    const stamp = `inline:${fnv(JSON.stringify(rows))}`;
    let entry = this.tables.get(stamp);
    if (!entry) {
      try {
        const { table, capped } = cappedTable(rows, this.maxSourceCells);
        entry = { table, at: Date.now(), stamp, ...(capped ? { capped } : {}) };
        this.tables.set(stamp, entry, approxTableBytes(table));
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        // Inline rows are part of the document: only an edit changes them, and the refusal with them.
        entry = { error: { status: e.status, message: e.message, lasting: true }, at: Date.now() };
        this.tables.set(stamp, entry, 256 + e.message.length * 2);
      }
    }
    if ('error' in entry)
      throw new HttpError(entry.error.status as 400, entry.error.message, undefined, {
        lasting: entry.error.lasting,
      });
    return {
      table: entry.table,
      fetchedAt: entry.at,
      credentialKey: '',
      stamp,
      ...(entry.capped ? { warning: cappedWarning(entry.table, 'the inline rows') } : {}),
    };
  }

  private async loadHttp(
    target: DashboardTarget,
    dataset: Dataset,
    source: Extract<Dataset['source'], { kind: 'http' }>,
    privateHosts: PrivateHosts | null,
  ): Promise<Loaded> {
    // Resolved on every call, before the cache: the switch, the owner's rights and the binding apply at once.
    const credentials = sourceSecretIds(source).length ? await this.credentialsFor(target, dataset) : [];
    const credentialKey = credentials
      .map((c) => `${target.ownerId}/${c.id}@${c.revision}`)
      .sort()
      .join(',');
    // A response fetched with the operator's private hosts never answers a dashboard that may not use them.
    const key = httpCacheKey(source, credentialKey, Boolean(privateHosts));
    const requestKey = httpRequestKey(source, credentialKey, Boolean(privateHosts));
    let entry = this.tables.get(key);
    if (!entry) {
      let pending = this.loading.get(key);
      if (!pending) {
        pending = this.fetchHttp(key, requestKey, source, credentials, privateHosts).finally(() =>
          this.loading.delete(key),
        );
        this.loading.set(key, pending);
      }
      entry = await pending;
    }
    if ('error' in entry)
      throw new HttpError(entry.error.status as 400, entry.error.message, undefined, {
        lasting: entry.error.lasting,
      });
    return {
      table: entry.table,
      fetchedAt: entry.at,
      credentialKey,
      ...(entry.capped ? { warning: cappedWarning(entry.table, 'the response') } : {}),
    };
  }

  private response(
    requestKey: string,
    source: HttpSource,
    credentials: Credential[],
    privateHosts: PrivateHosts | null,
  ): Promise<unknown> {
    let pending = this.requests.get(requestKey);
    if (!pending) {
      // One request takes one place and one token of the host's budget, whoever waits on it.
      pending = this.outbound
        .run(currentClient(), source.url, () =>
          safeFetchJson(source.url, {
            credentials,
            // Only a POST carries these, so a GET is fetched with exactly the options it always had.
            ...(source.method === 'POST'
              ? { method: 'POST' as const, ...(source.body !== undefined ? { body: source.body } : {}) }
              : {}),
            ...(privateHosts ? { privateHosts } : {}),
            ...(this.upstreamTest ? { test: this.upstreamTest } : {}),
          }),
        )
        .finally(() => this.requests.delete(requestKey));
      this.requests.set(requestKey, pending);
    }
    return pending;
  }

  private async fetchHttp(
    key: string,
    requestKey: string,
    source: Extract<Dataset['source'], { kind: 'http' }>,
    credentials: Credential[],
    privateHosts: PrivateHosts | null,
  ): Promise<CacheEntry> {
    try {
      const json = await this.response(requestKey, source, credentials, privateHosts);
      // The response is shared by every waiter: reading a path builds new rows and must never write into it.
      const { table, capped } = cappedTable(
        recordsFrom(json, source.path, this.maxSourceCells),
        this.maxSourceCells,
      );
      const entry: CacheEntry = { table, at: Date.now(), stamp: '', ...(capped ? { capped } : {}) };
      this.tables.set(key, entry, approxTableBytes(table), HTTP_TTL_MS);
      return entry;
    } catch (e) {
      // Our own refusals (busy, over the host's budget) say nothing about the address, so they are not remembered.
      if (e instanceof HttpError && e.status !== 429 && e.status !== 503) {
        const entry: CacheEntry = {
          error: { status: e.status, message: e.message, lasting: e.lasting },
          at: Date.now(),
        };
        this.tables.set(key, entry, 256 + e.message.length * 2, HTTP_ERROR_TTL_MS);
      }
      throw e;
    }
  }

  async loadSource(target: DashboardTarget, dataset: Dataset): Promise<Loaded> {
    const source = dataset.source;
    // Every upstream load passes here: a reference left unbound (a binding that failed upstream of the caller) would
    // otherwise be sent as text, with the owner's credentials when the source is secret-backed.
    if (parameterRefs({ source, transforms: [] }).length) throw lastingError(400, usesFilters(dataset.id));
    switch (source.kind) {
      case 'connector': {
        const r = await this.connectors.load(source.connector, source.params);
        return {
          table: r.table,
          fetchedAt: r.fetchedAt,
          credentialKey: '',
          ...(r.stale ? { warning: `${CACHED_DATA_WARNING}: ${r.stale}` } : {}),
        };
      }
      case 'inline':
        return this.loadInline(source.rows);
      case 'upload':
        return this.loadUpload(target, source.fileId);
      case 'http': {
        const method = source.method ?? 'GET';
        return this.loadHttp(
          target,
          dataset,
          source,
          this.urlPolicy(target, source.url, method, method === 'POST' ? source.body : undefined),
        );
      }
      case 'feed': {
        const feed = await this.feeds.load(source.url, this.urlPolicy(target, source.url));
        const rows = feed.table.rows.slice(0, source.limit);
        return {
          table: { columns: feed.table.columns, rows },
          fetchedAt: feed.fetchedAt,
          credentialKey: '',
          origin: feed.table,
        };
      }
      case 'dataset':
        throw lastingError(400, readsOtherDatasets(dataset.id));
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
    // A preview works on a copy that is never stored (see DashboardTarget.preview).
    if (target.preview) buffer = { ...buffer, rows: [...buffer.rows] };
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
    if (!target.preview) this.buffers.set(key, buffer, 128 + buffer.rows.length * buffer.rowBytes);
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

  private async run(
    input: DataTable,
    transforms: Transform[],
    inputs?: PipelineInputs,
    open?: boolean,
  ): Promise<PipelineResult> {
    const run = () => this.pipeline.run(input, transforms, inputs, open);
    // A large table can fill the pipeline worker's heap: it waits for its turn with the other heavy jobs. The tables a
    // join or union reads are copied to the worker too, so they count.
    const heavy = transforms.length > 0 && cellsOf(input, transforms, inputs) >= HEAVY_PIPELINE_CELLS;
    return heavy ? heavyWork.run(run) : run();
  }

  /** Caps a processed table for widgets, agents and snapshots: the last `max` rows, the wire size check, the hash. */
  finish(result: PipelineResult, max = MAX_ROWS_OUT): Computed {
    const { table, trace } = result;
    let byMax = this.finished.get(table);
    const hit = byMax?.get(max);
    if (hit) return hit.trace === trace ? hit : { ...hit, trace };
    const truncated = table.rows.length > max;
    const out: DataTable = truncated ? { columns: table.columns, rows: table.rows.slice(-max) } : table;
    // Measured in the compact form the web app reads, before anything is hashed, kept or serialised: a result too
    // large to send is an error for every reader alike (widget, agent, snapshot), and only the error is kept.
    const size = wireSize(out, 'arrays');
    const computed =
      size > MAX_RESULT_BYTES
        ? tooLargeResult({ table: out, hash: '', truncated, trace }, size)
        : { table: out, hash: hashTable(out), truncated, trace };
    if (!byMax) {
      byMax = new Map();
      this.finished.set(table, byMax);
    }
    byMax.set(max, computed);
    return computed;
  }

  private async compute(input: DataTable, transforms: Transform[], max: number): Promise<Computed> {
    return this.finish(await this.run(input, transforms), max);
  }

  /** The same input table with the same steps gives the same result: computed once for concurrent callers. */
  private computeShared(input: DataTable, transforms: Transform[], max: number): Promise<Computed> {
    const key = `${this.tableId(input)}|${max}|${JSON.stringify(transforms)}`;
    const hit = this.results.get(key) as Computed | undefined;
    if (hit) return Promise.resolve(hit);
    let pending = this.computing.get(key) as Promise<Computed> | undefined;
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
   * An uncapped pipeline result, shared by concurrent callers like `computeShared`: a burst of viewers of a dashboard
   * with derived datasets costs one run per dataset. The key names every table the run reads (and the names a union
   * labels rows with), so two runs over the same table that join or union different tables never share a result.
   * `fresh` inputs (accumulate buffers, a new table on every call) are never shared.
   */
  processShared(
    input: DataTable,
    transforms: Transform[],
    inputs?: PipelineInputs,
    fresh = false,
    open = input.rows.length === 0,
  ): Promise<PipelineResult> {
    if (fresh) return this.run(input, transforms, inputs, open);
    // Openness is part of the key: the same empty table checks columns or not depending on where it came from.
    const read = inputs
      ? JSON.stringify([
          inputs.self,
          Object.entries(inputs.tables).map(([id, t]) => [
            id,
            t.name,
            this.tableId(t.table),
            t.open ?? t.table.rows.length === 0,
          ]),
        ])
      : '';
    const key = `full|${open}|${this.tableId(input)}|${read}|${JSON.stringify(transforms)}`;
    const hit = this.results.get(key) as PipelineResult | undefined;
    if (hit) return Promise.resolve(hit);
    let pending = this.computing.get(key) as Promise<PipelineResult> | undefined;
    if (!pending) {
      pending = this.run(input, transforms, inputs, open)
        .then((r) => {
          this.results.set(key, r, approxTableBytes(r.table), RESULT_TTL_MS);
          return r;
        })
        .finally(() => this.computing.delete(key));
      this.computing.set(key, pending);
    }
    return pending;
  }

  /**
   * The table a dataset's pipeline starts from: its source, or the accumulated history of it. `reading` names what
   * was loaded (absent for a history, which is a new table on every call): equal readings are the same cached table
   * object, fetched with the same credentials, and so give the same result.
   */
  async loadInput(
    target: DashboardTarget,
    dataset: Dataset,
  ): Promise<{ table: DataTable; fetchedAt: number; warning?: string; fresh: boolean; reading?: string }> {
    const loaded = await this.loadSource(target, dataset);
    const fresh = dataset.accumulate > 0;
    return {
      table: fresh ? this.accumulate(target, dataset, loaded) : loaded.table,
      fetchedAt: loaded.fetchedAt,
      fresh,
      ...(loaded.warning ? { warning: loaded.warning } : {}),
      ...(fresh
        ? {}
        : {
            reading: JSON.stringify([
              this.tableId(loaded.origin ?? loaded.table),
              loaded.credentialKey,
              loaded.fetchedAt,
              loaded.warning ?? '',
            ]),
          }),
    };
  }

  /**
   * A scope's final result under `key` (see `finals`): reused for RESULT_TTL_MS, and built once for concurrent
   * scopes, which then all hold the same object and so the same serialisation. A failure is never kept.
   */
  sharedFinal(key: string, build: () => Promise<DatasetResult>): Promise<DatasetResult> {
    const hit = this.finals.get(key);
    if (hit) return Promise.resolve(hit);
    let pending = this.finalizing.get(key);
    if (!pending) {
      pending = build()
        .then((r) => {
          const bytes =
            approxTableBytes(r.table) +
            2 * (key.length + r.hash.length + (r.error?.length ?? 0) + (r.warning?.length ?? 0));
          this.finals.set(key, r, bytes, RESULT_TTL_MS);
          return r;
        })
        .finally(() => this.finalizing.delete(key));
      this.finalizing.set(key, pending);
    }
    return pending;
  }

  /** One per request, hub tick, snapshot or MCP call: see `ResolveScope`. */
  scope(target: DashboardTarget, doc: DashboardDoc, options: ScopeOptions = {}): ResolveScope {
    return new ResolveScope(this, target, doc, options);
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
      if (upstreamOf(dataset).length) throw lastingError(400, readsOtherDatasets(dataset.id));
      // An unbound reference would reach a fetch or a step as text: refused, never guessed.
      if (parameterRefs(dataset).length) throw lastingError(400, usesFilters(dataset.id));
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
        ...(loaded.warning ? { warning: loaded.warning } : {}),
      };
    } catch (e) {
      if (e instanceof BusyError) throw e;
      return errorResult(dataset.id, e);
    }
  }

  forget(dashboardId: string) {
    this.buffers.deleteWhere((key) => key.startsWith(`${dashboardId}:`));
    // Uploads are cached by file (see loadUpload), possibly shared with copies; a deleted one is never asked for
    // again and leaves the byte-bounded cache in its turn. Only files without inode numbers are keyed by path.
    this.tables.deleteWhere((key) => key.startsWith(`upload:${dashboardId}/`));
  }
}
