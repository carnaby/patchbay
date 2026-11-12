/**
 * Resolution of datasets that read other datasets (proposal 0005), one scope per request, hub tick, snapshot or MCP
 * call. Each dataset of the document is loaded and processed at most once per scope, however many datasets read it,
 * and children always get their parent's uncapped table, never the 10,000 rows a widget receives.
 */
import { createHash } from 'node:crypto';
import {
  bindDataset,
  bindDoc,
  type DashboardDoc,
  type Dataset,
  type DatasetResult,
  type DataTable,
  defaultParameterValues,
  hasLineage,
  lineageCycles,
  lineageDatasets,
  lineageKey,
  type ParameterValues,
  PIPELINE_LIMITS,
  type PipelineInputs,
  type PipelineResult,
  stepInputsOf,
  upstreamOf,
} from '@patchbay/core';
import { HttpError, lastingError, RetryLaterError } from '../util/errors.ts';
import { BusyError } from '../util/gate.ts';
import { heavyWork } from '../util/heavy.ts';
import type { DashboardTarget, DataService } from './data.ts';

export const SCOPE_DEADLINE_MS = 20_000;
export const SCOPE_TIMEOUT_MESSAGE =
  'Loading this dataset and the datasets it reads took longer than 20 s; shorten the chain or simplify its steps';
/** The deadline passed while `id`'s source was still loading: the load goes on, so asking again joins or reads it. */
export const stillLoadingMessage = (id: string) =>
  `Source dataset "${id}" is still loading (its source is slow or busy); it is asked again shortly`;
/** The same, shown on the widget of the dataset whose own source is the slow one. */
export const STILL_LOADING_OWN = 'Still loading; trying again shortly';
/** As the connector limiter's busy-host hint: a load still in flight has usually finished by then. */
const STILL_LOADING_RETRY_SEC = 10;

export interface FullResult {
  /** The processed rows, at most PIPELINE_LIMITS.maxRows (the last ones). */
  table: DataTable;
  trace: PipelineResult['trace'];
  /** Epoch ms of the oldest input: the data is as old as its stalest part. */
  fetchedAt: number;
  /** Stale or capped inputs, shown on the widget like a root's warning. */
  warning?: string;
  /** Rows dropped from the start to fit PIPELINE_LIMITS.maxRows. */
  cut: number;
  /** No rows, from a source that returned none: datasets reading it do not check columns (core runPipeline). */
  open?: boolean;
}

export interface ScopeOptions {
  /** Tables already known (the live hub's latest), used instead of loading those datasets again. */
  seed?: (id: string) => FullResult | undefined;
  /** Overall time for the scope; a chain of slow steps ends with a clear error instead of holding the request. */
  deadlineMs?: number;
  /** The view's filter values (services/view.ts); the declared defaults when absent. */
  parameters?: ParameterValues;
}

/** A failure upstream, named once after the dataset that actually failed, however deep the chain. */
export class UpstreamError extends Error {
  readonly datasetId: string;
  /** Set when that dataset was refused by this server's own limit, so its readers may ask again as soon as it may. */
  readonly retryAfterSec: number | undefined;
  /** That dataset's failure needs an edit, a secret or a setting (HttpError.lasting), and so its readers' do too. */
  readonly lasting: boolean;
  constructor(
    datasetId: string,
    message: string,
    hint: { retryAfterSec?: number | undefined; lasting?: boolean } = {},
  ) {
    super(`Source dataset "${datasetId}" failed: ${message}`);
    this.name = 'UpstreamError';
    this.datasetId = datasetId;
    this.retryAfterSec = hint.retryAfterSec;
    this.lasting = hint.lasting ?? false;
  }
}

/** The scope ran out of time. With a source load still pending, the page may ask again: the load goes on. */
export class ScopeTimeoutError extends HttpError {
  readonly retryAfterSec: number | undefined;
  /** The dataset whose source load was still pending, by id. */
  readonly source: string | undefined;
  constructor(message: string, options: { retryAfterSec?: number; source?: string } = {}) {
    super(504, message);
    this.retryAfterSec = options.retryAfterSec;
    this.source = options.source;
  }
}
const isTimeout = (e: unknown) => e instanceof ScopeTimeoutError;

const isLasting = (e: unknown) =>
  (e instanceof HttpError || e instanceof UpstreamError || e instanceof CycleError) && e.lasting;

/** The result a widget shows for a dataset that could not be resolved. Inner messages are already viewer-safe. */
export function errorResult(datasetId: string, e: unknown): DatasetResult {
  const message = e instanceof Error ? e.message : 'Failed to load data';
  // A lasting failure is asked for again only rarely (the page's slow cadence), so it carries no retry hint.
  const lasting = isLasting(e);
  // A refusal is in-band (a 503 would fail every widget of the request), so the page learns when to ask again here.
  const retryAfterSec =
    !lasting && (e instanceof RetryLaterError || e instanceof UpstreamError || e instanceof ScopeTimeoutError)
      ? e.retryAfterSec
      : undefined;
  return {
    datasetId,
    table: { columns: [], rows: [] },
    fetchedAt: new Date().toISOString(),
    hash: `error:${message}`,
    truncated: false,
    error: message,
    ...(retryAfterSec ? { retryAfterSec } : {}),
    ...(lasting ? { lasting: true as const } : {}),
  };
}

const rows = (n: number) => n.toLocaleString('en-US');

/**
 * A table cut to its last PIPELINE_LIMITS.maxRows rows, the same object for as long as the uncapped one is shared:
 * children key their shared runs, and widgets their serialisation, by table identity.
 */
const cutTables = new WeakMap<DataTable, DataTable>();
function lastRows(table: DataTable): DataTable {
  let cut = cutTables.get(table);
  if (!cut) {
    cut = { columns: table.columns, rows: table.rows.slice(-PIPELINE_LIMITS.maxRows) };
    cutTables.set(table, cut);
  }
  return cut;
}

/**
 * A cycle in a document that did not pass validation (lineageIssues refuses them on every write and read). Named like
 * the validation names it, and passed on unwrapped: it is not a failure of one upstream dataset.
 */
class CycleError extends Error {
  /** Only an edit of the document breaks the cycle. */
  readonly lasting = true;
  constructor(path: readonly string[]) {
    super(
      path.length === 2 && path[0] === path[1]
        ? `Dataset "${path[0]}" reads itself`
        : `Datasets ${path.map((id) => `"${id}"`).join(' → ')} form a cycle`,
    );
    this.name = 'CycleError';
  }
}

/**
 * For each dataset of `doc` on a cycle, the cycle. Checked up front because two callers entering a cycle from both
 * ends would each wait for the other's memoised promise, which no chain of waiting datasets can see.
 */
function cyclesIn(doc: DashboardDoc): Map<string, string[]> {
  const on = new Map<string, string[]>();
  for (const d of doc.datasets) if (upstreamOf(d).includes(d.id)) on.set(d.id, [d.id, d.id]);
  for (const cycle of lineageCycles(doc)) for (const id of cycle) if (!on.has(id)) on.set(id, cycle);
  return on;
}

export class ResolveScope {
  readonly target: DashboardTarget;
  /** The document with the view's values bound in: nothing below ever sees a filter reference. */
  readonly doc: DashboardDoc;
  private readonly values: ParameterValues;
  /** Each stored dataset to its bound twin, so a caller's dataset object finds its shared, bound definition. */
  private readonly twins: Map<Dataset, Dataset>;
  /** Datasets whose values could not be bound (a path value ".."): they fail with this message. */
  private readonly bindErrors: ReadonlyMap<string, string>;
  private readonly data: DataService;
  private readonly seed: ((id: string) => FullResult | undefined) | undefined;
  private readonly deadline: number;
  private readonly memo = new Map<string, Promise<FullResult>>();
  private readonly done = new Map<string, FullResult>();
  /** Source loads of the document's datasets: the final key reads them first, and processing must see the same. */
  private readonly loads = new Map<string, ReturnType<DataService['loadInput']>>();
  /** Source loads started by this scope and not settled yet, by dataset id: what a timeout says is still loading. */
  private readonly pending = new Map<string, number>();
  private cycles: Map<string, string[]> | undefined;

  constructor(data: DataService, target: DashboardTarget, doc: DashboardDoc, options: ScopeOptions = {}) {
    this.data = data;
    this.target = target;
    // Bound once, before anything is resolved: every cache below is keyed by the bound definitions, which is what
    // gives each view its own entries without a key built by hand (proposal 0010).
    this.values = options.parameters ?? defaultParameterValues(doc.parameters);
    const bound = bindDoc(doc, this.values);
    this.doc = bound.doc;
    this.bindErrors = bound.errors;
    this.twins = new Map(doc.datasets.map((d, i) => [d, bound.doc.datasets[i]!]));
    this.seed = options.seed;
    this.deadline = Date.now() + (options.deadlineMs ?? SCOPE_DEADLINE_MS);
  }

  /**
   * The uncapped processed table of a dataset of `doc`, shared by every caller in this scope. `path` is the chain of
   * datasets waiting for this one: meeting `id` on it again means a cycle, which would otherwise wait for itself.
   */
  full(id: string, path: readonly string[] = []): Promise<FullResult> {
    this.cycles ??= cyclesIn(this.doc);
    const cycle = this.cycles.get(id);
    if (cycle) return Promise.reject(new CycleError(cycle));
    // A draft outside `doc` can still close a cycle through it.
    const at = path.indexOf(id);
    if (at >= 0) return Promise.reject(new CycleError([...path.slice(at), id]));
    let pending = this.memo.get(id);
    if (!pending) {
      const seeded = this.seed?.(id);
      const dataset = this.doc.datasets.find((d) => d.id === id);
      const unbound = this.bindErrors.get(id);
      // The work starts on a later microtask, after the memo entry below is in place.
      pending = unbound
        ? Promise.reject(lastingError(400, unbound))
        : seeded
          ? Promise.resolve(seeded)
          : dataset
            ? Promise.resolve().then(() => this.process(dataset, [...path, id]))
            : Promise.reject(lastingError(404, `Unknown dataset "${id}"`));
      pending.then(
        (r) => this.done.set(id, r),
        () => {},
      );
      this.memo.set(id, pending);
    }
    return pending;
  }

  /** Full tables resolved so far; the live hub keeps those that other datasets read. */
  settled(): ReadonlyMap<string, FullResult> {
    return this.done;
  }

  /**
   * What widgets, agents and snapshots get. `dataset` may be a draft that is not in `doc` (previews): its upstream is
   * then read from `doc`.
   */
  async resolve(input: Dataset, options: { maxRows?: number } = {}): Promise<DatasetResult> {
    let dataset: Dataset;
    try {
      const unbound = this.twins.has(input) ? this.bindErrors.get(input.id) : undefined;
      if (unbound) throw lastingError(400, unbound);
      // A stored dataset finds its bound twin; a draft (a preview) is bound with the same values.
      dataset = this.twins.get(input) ?? bindDataset(input, this.values);
    } catch (e) {
      return errorResult(input.id, e);
    }
    // Nothing reads it and it reads nothing: today's path, with its caches, exactly as before.
    if (upstreamOf(dataset).length === 0 && !hasLineage(this.doc, dataset.id))
      return this.data.resolve(this.target, dataset, options);
    try {
      const stored = this.doc.datasets.find((d) => d.id === dataset.id);
      const same =
        stored === dataset || (stored !== undefined && JSON.stringify(stored) === JSON.stringify(dataset));
      const build = async (): Promise<DatasetResult> => {
        // The whole wait is bounded too, not only each load and run: a caller never outlives the scope's deadline.
        const full = await this.within(() =>
          same ? this.full(dataset.id) : this.process(dataset, [dataset.id]),
        );
        const computed = this.data.finish(full, options.maxRows);
        return {
          datasetId: dataset.id,
          ...computed,
          fetchedAt: new Date(full.fetchedAt).toISOString(),
          ...(full.warning ? { warning: full.warning } : {}),
        };
      };
      const key = same ? await this.finalKey(dataset.id, options.maxRows) : undefined;
      if (!key) return await build();
      // Its later heavy runs (children after their parent) are not refused once its first is admitted.
      const run = () => heavyWork.chain(build);
      for (;;) {
        try {
          return await this.within(() => this.data.sharedFinal(key, run));
        } catch (e) {
          // A build this scope joined runs against the deadline of the scope that started it. When that one ran out
          // and this one has time left, it builds again under its own: the loads and runs still in flight are
          // shared, so nothing is done twice. Its own build ending past its own deadline ends the loop.
          if (!isTimeout(e) || this.deadline <= Date.now()) throw e;
        }
      }
    } catch (e) {
      // The server, not the dataset, is the problem: callers answer 503 or skip a refresh.
      if (e instanceof BusyError) throw e;
      let timedOut = e;
      if (e instanceof ScopeTimeoutError && e.source !== undefined) {
        // The deadline is the scope's; the source it names must be one this dataset reads, or the widget would wait on
        // another chain's load with a retry hint it does not need.
        const lineage = new Set([
          dataset.id,
          ...upstreamOf(dataset).flatMap((u) => lineageDatasets(this.doc, u).map((d) => d.id)),
        ]);
        if (!lineage.has(e.source)) timedOut = this.timeoutError(lineage);
      }
      // The widget's own source is the slow one: naming itself as a "source dataset" would read as another dataset.
      const shown =
        timedOut instanceof ScopeTimeoutError && timedOut.source === dataset.id
          ? new ScopeTimeoutError(STILL_LOADING_OWN, {
              retryAfterSec: timedOut.retryAfterSec,
              source: timedOut.source,
            })
          : timedOut;
      return errorResult(dataset.id, shown);
    }
  }

  /**
   * The key under which a stored dataset's final result is shared across scopes, or undefined when it must not be.
   * It names everything the result depends on: the definitions of the dataset and of all it reads (lineageKey), what
   * each root of that lineage loaded (the cached table object, its credentials, fetch time and warning), the target's
   * policy and the row cap. A new reading of any root is a new table object and so a new key. Never shared: previews
   * (their loads are their own) and seeded scopes (the live hub, whose inputs are the room's tables and which keeps
   * the full tables it settles), and histories, which are a new table on every read.
   */
  private async finalKey(id: string, maxRows: number | undefined): Promise<string | undefined> {
    if (this.target.preview || this.seed) return undefined;
    const lineage = lineageDatasets(this.doc, id);
    // A dataset that failed to bind still holds its template: loading it would send the references as text. The
    // build reports the failure, named after that dataset.
    if (lineage.some((d) => this.bindErrors.has(d.id))) return undefined;
    const roots = lineage.filter((d) => d.source.kind !== 'dataset');
    if (roots.some((d) => d.accumulate > 0)) return undefined;
    let inputs: Awaited<ReturnType<DataService['loadInput']>>[];
    try {
      inputs = await Promise.all(roots.map((d) => this.within(() => this.load(d))));
    } catch {
      // Resolved without the cache, which reports the failure where it belongs (the dataset or its upstream).
      return undefined;
    }
    const readings = inputs.map((i) => i.reading);
    if (readings.some((r) => r === undefined)) return undefined;
    const { ownerId, publicOnly } = this.target;
    const parts = [
      this.target.id,
      ownerId,
      publicOnly === true,
      maxRows ?? null,
      lineageKey(this.doc, id),
      readings,
    ];
    return `final|${createHash('sha256').update(JSON.stringify(parts)).digest('base64url')}`;
  }

  /** A stored dataset's source, loaded once per scope; a draft that is not the stored object loads its own. */
  private load(dataset: Dataset): ReturnType<DataService['loadInput']> {
    if (this.doc.datasets.find((d) => d.id === dataset.id) !== dataset)
      return this.track(dataset.id, this.data.loadInput(this.target, dataset));
    let pending = this.loads.get(dataset.id);
    if (!pending) {
      pending = this.track(dataset.id, this.data.loadInput(this.target, dataset));
      // Its readers may give up on it first (the deadline); a later failure must not go unhandled.
      pending.catch(() => {});
      this.loads.set(dataset.id, pending);
    }
    return pending;
  }

  /** Counts a source load as pending until it settles, either way; the count's own chain never rejects. */
  private track<T>(id: string, load: Promise<T>): Promise<T> {
    this.pending.set(id, (this.pending.get(id) ?? 0) + 1);
    const done = () => {
      const left = (this.pending.get(id) ?? 1) - 1;
      if (left > 0) this.pending.set(id, left);
      else this.pending.delete(id);
    };
    load.then(done, done);
    return load;
  }

  /**
   * The error for running out of time, built when it happens. The first pending load in the document's order (drafts
   * after it) is named, so a wall screen keeps showing the same text however the loads interleave. `within` limits it
   * to one dataset's lineage: a widget names only what it waits for.
   */
  private timeoutError(within?: ReadonlySet<string>): ScopeTimeoutError {
    const mine = (id: string) => !within || within.has(id);
    const id =
      this.doc.datasets.find((d) => this.pending.has(d.id) && mine(d.id))?.id ??
      [...this.pending.keys()].find(mine);
    return id === undefined
      ? new ScopeTimeoutError(SCOPE_TIMEOUT_MESSAGE)
      : new ScopeTimeoutError(stillLoadingMessage(id), {
          retryAfterSec: STILL_LOADING_RETRY_SEC,
          source: id,
        });
  }

  private async process(dataset: Dataset, path: readonly string[]): Promise<FullResult> {
    const source = dataset.source;
    const refs = stepInputsOf(dataset);
    // Per input, so that warnings, like failures, come in declared order and not in the order the inputs arrive:
    // with two inputs down or stale, that order changes from tick to tick, and so would what wall screens show.
    const said = [[], ...refs.map(() => [])] as string[][];
    const loading =
      source.kind === 'dataset'
        ? this.upstream(source.id, said[0]!, path).then((p) => ({ ...p, fresh: false }))
        : this.within(() => this.load(dataset));
    const reading = refs.map((id, i) => this.upstream(id, said[i + 1]!, path));
    const failed = (await Promise.allSettled([loading, ...reading])).find((s) => s.status === 'rejected');
    if (failed) throw failed.reason;
    const input = await loading;
    const others = await Promise.all(reading);
    if (input.warning && source.kind !== 'dataset') said[0]!.push(input.warning);
    const warnings = said.flat();
    let fetchedAt = input.fetchedAt;
    let inputs: PipelineInputs | undefined;
    if (refs.length) {
      const tables: PipelineInputs['tables'] = {};
      refs.forEach((id, i) => {
        tables[id] = { name: this.nameOf(id), table: others[i]!.table, open: others[i]!.open === true };
        fetchedAt = Math.min(fetchedAt, others[i]!.fetchedAt);
      });
      // Union labels the rows it starts with after where they came from: the parent of a derived dataset.
      const self = source.kind === 'dataset' ? source.id : dataset.id;
      inputs = { tables, self: { id: self, name: self === dataset.id ? dataset.name : this.nameOf(self) } };
    }
    // Shared across requests only while in flight in practice: the result cache is the 8 MB one widget results use,
    // so a large table is not kept. Across requests the final capped results are shared instead (finalKey).
    // A derived dataset's input is its parent's result: a parent a filter emptied still has known columns.
    const open =
      source.kind === 'dataset' ? 'open' in input && input.open === true : input.table.rows.length === 0;
    const result = await this.within(() =>
      this.data.processShared(input.table, dataset.transforms, inputs, input.fresh, open),
    );
    const cut = Math.max(0, result.table.rows.length - PIPELINE_LIMITS.maxRows);
    const table = cut ? lastRows(result.table) : result.table;
    const warning = [...new Set(warnings)].join('; ');
    return {
      table,
      trace: result.trace,
      fetchedAt,
      cut,
      ...(warning ? { warning } : {}),
      ...(result.open ? { open: true } : {}),
    };
  }

  /** A dataset this one reads, with its warnings passed on and its failure named after it. */
  private async upstream(id: string, warnings: string[], path: readonly string[]): Promise<FullResult> {
    let r: FullResult;
    try {
      r = await this.full(id, path);
    } catch (e) {
      if (e instanceof BusyError || e instanceof UpstreamError || e instanceof CycleError) throw e;
      if (isTimeout(e)) throw e;
      throw new UpstreamError(id, e instanceof Error ? e.message : 'Failed to load data', {
        retryAfterSec: e instanceof RetryLaterError ? e.retryAfterSec : undefined,
        lasting: isLasting(e),
      });
    }
    if (r.warning) warnings.push(r.warning);
    if (r.cut) {
      const max = rows(PIPELINE_LIMITS.maxRows);
      warnings.push(`Source dataset "${id}" has more than ${max} rows; only its last ${max} are used`);
    }
    return r;
  }

  private nameOf(id: string): string {
    return this.doc.datasets.find((d) => d.id === id)?.name ?? id;
  }

  /**
   * Races work against the scope's deadline. The work itself still ends at its own limit. It is a thunk so that past
   * the deadline nothing starts: a run begun and then abandoned would fail later with nobody listening.
   */
  private within<T>(work: () => Promise<T>): Promise<T> {
    const left = this.deadline - Date.now();
    if (left <= 0) return Promise.reject(this.timeoutError());
    // Started before the timer, and a synchronous throw becomes a rejection: no timer is ever left armed for it.
    let started: Promise<T>;
    try {
      started = work();
    } catch (e) {
      return Promise.reject(e);
    }
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      // Built when it fires, from the loads pending then: the outer and inner races of one scope say the same.
      timer = setTimeout(() => reject(this.timeoutError()), left);
      timer.unref();
    });
    // The race handles a rejection of `work` that comes after the deadline.
    return Promise.race([started, late]).finally(() => clearTimeout(timer));
  }
}
