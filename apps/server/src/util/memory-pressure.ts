/**
 * Admission by the container's real memory use.
 *
 * The gates in this folder bound each kind of work on its own (one heavy job at a time, a byte budget for response
 * bodies, one large request body), and each kind alone stays well inside a 384 MB container. All of them at their
 * limits at the same moment do not: the sum of many bounded parts is what the kernel's OOM killer sees, and it kills
 * the whole process, every viewer's connection included. This guard watches that sum and stops new work from adding
 * to it while it is high. Work already running always finishes; only new work is turned away with 503 and
 * Retry-After, which costs a client one retry instead of costing everyone the server.
 *
 * Levels, as fractions of the limit (MEMORY_SOFT_FRACTION, MEMORY_HARD_FRACTION):
 * - soft: new heavy work (heavy.ts turns, uploads and large bodies, snapshot renders, pipelines that need a worker,
 *   new serialisations of large results) is refused, except one job at a time on a server that has run no heavy work
 *   for the cool-down and still has room for one job's growth (`ONE_JOB_BYTES`). Memory that glibc and V8 keep after
 *   a burst can hold the resting level above the threshold with nobody using the server; refusing everything then
 *   refused every visitor until a restart. A burst gets at most one job per cool-down through it.
 * - hard: no new heavy work, no new live streams and no writes; reads that answer from memory (documents, cached
 *   results, the health check, static files) keep working.
 * A level is left once use is a margin below its threshold, so one sample near a threshold cannot make it flap. Soft
 * is also left below its threshold itself once no heavy work has run for a cool-down: a reading taken with nothing
 * running is the resting level, and no job's peak can swing it back.
 *
 * Under pressure memory is given back, not only kept from growing: the main thread collects, idle workers collect or
 * stop, and once nothing heavy has run for the cool-down the caches are emptied, the pipeline workers are replaced by
 * fresh ones and the main thread's heap is compacted. The level is also sampled on a slow timer, so this happens on
 * an idle server too, where no request would take a sample.
 *
 * What is measured, with cgroup v2: `memory.current` minus the page cache the kernel can drop (`active_file` and
 * `inactive_file` in `memory.stat`). The OOM killer acts on the cgroup's charge once reclaim has failed, and reclaim
 * drops clean page cache first: SQLite pages and dashboard files read through the cache inflate `memory.current`
 * without bringing a kill any closer. What remains (anonymous memory of every thread, tmpfs, kernel memory for
 * sockets and page tables) is what a kill is decided on.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { BusyError } from './gate.ts';
import { collectNow } from './workers.ts';

export type PressureLevel = 'normal' | 'soft' | 'hard';

export interface MemoryReading {
  /** Bytes that count towards an OOM kill: the cgroup's charge without reclaimable page cache, or the process's RSS. */
  usedBytes: number;
  limitBytes: number;
  source: 'cgroup v2' | 'cgroup v1' | 'process';
}

/** One sample, or null when it cannot be taken right now. Called at most once per sample interval. */
export type MemoryReader = () => MemoryReading | null;

/** Refused because memory is short. A BusyError: callers that skip busy work (live refreshes) skip it quietly. */
export class MemoryPressureError extends BusyError {
  constructor(retryAfterSec: number) {
    super('The server is low on memory; try again in a few seconds', retryAfterSec);
  }
}

export interface DetectOptions {
  /** MEMORY_LIMIT_MB: overrides the detected limit; 0 turns the guard off. */
  limitMb?: number | undefined;
  /** Tests: where cgroup files are read from. */
  readText?: (path: string) => string | null;
  /** Tests: the process's resident set size. */
  rss?: () => number;
}

/** cgroup v1 reports "no limit" as a page-aligned number near 2^63. */
const NO_LIMIT_V1 = 2 ** 60;

const readOrNull = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

/** Sum of the named fields of a memory.stat file. */
function statFields(text: string, names: readonly string[]): number {
  let sum = 0;
  for (const line of text.split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0 && names.includes(line.slice(0, space))) sum += Number(line.slice(space + 1)) || 0;
  }
  return sum;
}

const number = (text: string | null): number | null => {
  if (text === null) return null;
  const value = Number(text.trim());
  return Number.isFinite(value) ? value : null;
};

interface CgroupFiles {
  version: 'cgroup v2' | 'cgroup v1';
  usage: string;
  stat: string;
  limit: number | null;
  reclaimable: readonly string[];
}

/**
 * The cgroup this process is charged to. Docker gives a container its own cgroup namespace, so its files are at the
 * root of /sys/fs/cgroup; with the host's namespace they are at the path /proc/self/cgroup names.
 */
function findCgroup(read: (path: string) => string | null): CgroupFiles | null {
  const own = /^0::(\/.*)$/m.exec(read('/proc/self/cgroup') ?? '')?.[1];
  for (const dir of ['/sys/fs/cgroup', ...(own && own !== '/' ? [`/sys/fs/cgroup${own}`] : [])]) {
    const max = read(`${dir}/memory.max`);
    if (max === null || read(`${dir}/memory.current`) === null) continue;
    return {
      version: 'cgroup v2',
      usage: `${dir}/memory.current`,
      stat: `${dir}/memory.stat`,
      limit: max.trim() === 'max' ? null : number(max),
      reclaimable: ['active_file', 'inactive_file'],
    };
  }
  const v1 = '/sys/fs/cgroup/memory';
  const limit = number(read(`${v1}/memory.limit_in_bytes`));
  if (limit !== null && read(`${v1}/memory.usage_in_bytes`) !== null) {
    return {
      version: 'cgroup v1',
      usage: `${v1}/memory.usage_in_bytes`,
      stat: `${v1}/memory.stat`,
      limit: limit >= NO_LIMIT_V1 ? null : limit,
      reclaimable: ['total_active_file', 'total_inactive_file'],
    };
  }
  return null;
}

/**
 * How this process measures its memory, or null when there is no limit to measure against (a developer's machine
 * without MEMORY_LIMIT_MB, Windows, or MEMORY_LIMIT_MB=0). Without a cgroup limit the process's own RSS is compared
 * with MEMORY_LIMIT_MB: a cgroup without a limit is usually a whole login session or service, not this process.
 */
export function detectMemoryReader(options: DetectOptions = {}): MemoryReader | null {
  if (options.limitMb === 0) return null;
  const read = options.readText ?? readOrNull;
  const rss = options.rss ?? (() => process.memoryUsage.rss());
  const override = options.limitMb ? options.limitMb * 1024 * 1024 : null;
  const cgroup = findCgroup(read);
  if (cgroup?.limit) {
    const limitBytes = override ?? cgroup.limit;
    return () => {
      const usage = number(read(cgroup.usage));
      const stat = read(cgroup.stat);
      if (usage === null || stat === null) return null;
      const usedBytes = Math.max(0, usage - statFields(stat, cgroup.reclaimable));
      return { usedBytes, limitBytes, source: cgroup.version };
    };
  }
  if (override) return () => ({ usedBytes: rss(), limitBytes: override, source: 'process' });
  return null;
}

export interface MemoryGuardOptions {
  /** null: the guard is off and admits everything. */
  reader: MemoryReader | null;
  /** Fraction of the limit at which new heavy work is refused; by default from the limit (`defaultThresholds`). */
  soft?: number | undefined;
  /** Fraction of the limit at which writes and new live streams are refused too; by default from the limit. */
  hard?: number | undefined;
  /** A level is left once use is this fraction of the limit below its threshold. */
  margin?: number;
  /** A sample is reused this long: requests in a burst share one read of the cgroup files. */
  sampleMs?: number;
  /** Under pressure, garbage is collected at most this often: a full collection stalls the main thread. */
  reliefMs?: number;
  /** No heavy work for this long: the reading is the resting level (leaving soft, reclaiming memory). */
  coolDownMs?: number;
  /** A deep relief (caches, fresh workers, a compacting collection) at most this often. */
  reclaimMs?: number;
  /** A sample is taken on its own this often, so an idle server changes level and gives memory back; 0: never. */
  pollMs?: number;
  now?: () => number;
  log?: (message: string) => void;
  /**
   * Collects the main thread's garbage; by default `gc` when the process runs with --expose-gc. `compact`: also
   * compact the heap so its emptied pages go back to the system, which takes longer.
   */
  collect?: (compact: boolean) => void;
}

/**
 * Asked under pressure. `deep` once nothing heavy has run for the cool-down: then it may also drop what is costly to
 * rebuild (caches, a worker's isolate), because the server is idle and the memory is better back with the kernel.
 */
export type Relief = (deep: boolean) => void;

/** Heavy work admitted and counted ahead of running it; see `MemoryGuard.reserveHeavy`. */
export interface HeavyReservation {
  /** Runs the reserved work; what it starts is part of it, like inside `runHeavy`. */
  run<T>(task: () => Promise<T>): Promise<T>;
  /** Ends the count. Called once the work is done or given up; later calls do nothing. */
  release(): void;
}

export interface MemoryState {
  level: PressureLevel;
  usedBytes: number;
  limitBytes: number;
  source: MemoryReading['source'];
  soft: number;
  hard: number;
  /** Requests refused at each level since the server started. */
  refused: { soft: number; hard: number };
}

const DEFAULTS = {
  margin: 0.05,
  sampleMs: 250,
  reliefMs: 5000,
  coolDownMs: 30_000,
  reclaimMs: 60_000,
  pollMs: 0,
};

const MB = 1024 * 1024;
/** What one heavy job can add within a second: a worker heap filled to its limit (96 MB) plus the copy sent to it. */
const SOFT_RESERVE_BYTES = 128 * MB;
/** What work already running can still add once heavy work is refused: bodies being read, socket buffers, results. */
const HARD_RESERVE_BYTES = 64 * MB;
/**
 * What one heavy job may add to a resting server: measured up to 85–95 MB for a full render of a 60-chart dashboard
 * in a render worker started afresh (its heap from 40 to 90 MB, plus resvg's pixmap), less for an upload or a
 * pipeline. Under soft pressure a lone job is admitted only while this much is free below the limit, with room
 * to spare: 272 MB at 384 MB.
 */
const ONE_JOB_BYTES = 112 * MB;

/**
 * The thresholds for a limit when none are configured. The room needed above each is a fixed amount, not a share:
 * a heavy job takes the same memory in a 384 MB container as in a 4 GB one, because every worker has its own heap
 * limit. So a small container keeps that room (soft at 256 MB and hard at 320 MB of 384 MB), and a large one uses
 * 80% and 90%.
 */
export function defaultThresholds(limitBytes: number): { soft: number; hard: number } {
  const soft = Math.max(0.5, Math.min(0.8, 1 - SOFT_RESERVE_BYTES / limitBytes));
  const hard = Math.max(soft + 0.05, Math.min(0.9, 1 - HARD_RESERVE_BYTES / limitBytes));
  return { soft, hard };
}

const mb = (bytes: number) => Math.round(bytes / 1048576);

export class MemoryGuard {
  private options: Required<Omit<MemoryGuardOptions, 'reader' | 'soft' | 'hard'>> &
    Pick<MemoryGuardOptions, 'reader' | 'soft' | 'hard'>;
  private reading: MemoryReading | null = null;
  private sampledAt = Number.NEGATIVE_INFINITY;
  private relievedAt = Number.NEGATIVE_INFINITY;
  private reclaimedAt = Number.NEGATIVE_INFINITY;
  private current: PressureLevel = 'normal';
  private readonly refused = { soft: 0, hard: 0 };
  private readonly reliefs = new Map<string, Relief>();
  /** Heavy jobs running (`runHeavy`). Not reset by `configure`: jobs outlive it. */
  private running = 0;
  /** When the last heavy job ended. */
  private heavyEndedAt = Number.NEGATIVE_INFINITY;
  /** Set inside a running heavy job: what it starts is part of work already running. */
  private readonly inside = new AsyncLocalStorage<true>();
  private poll: NodeJS.Timeout | null = null;

  constructor(options: MemoryGuardOptions = { reader: null }) {
    this.options = this.resolve(options);
  }

  private resolve(options: MemoryGuardOptions) {
    return {
      ...DEFAULTS,
      now: () => performance.now(),
      log: (message: string) => console.log(message),
      collect: collectNow,
      ...options,
    };
  }

  /** Replaces the settings (at startup, from the environment; tests use a fake reader) and starts from normal. */
  configure(options: MemoryGuardOptions) {
    this.options = this.resolve(options);
    this.reading = null;
    this.sampledAt = Number.NEGATIVE_INFINITY;
    this.relievedAt = Number.NEGATIVE_INFINITY;
    this.reclaimedAt = Number.NEGATIVE_INFINITY;
    this.heavyEndedAt = Number.NEGATIVE_INFINITY;
    this.current = 'normal';
    this.refused.soft = 0;
    this.refused.hard = 0;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    if (this.options.reader && this.options.pollMs > 0) {
      this.poll = setInterval(() => this.sample(), this.options.pollMs);
      this.poll.unref();
    }
  }

  get enabled(): boolean {
    return Boolean(this.options.reader);
  }

  /** The thresholds in force for a limit: the configured ones, the rest from `defaultThresholds`. */
  thresholds(limitBytes: number): { soft: number; hard: number } {
    const fallback = defaultThresholds(limitBytes);
    const soft = this.options.soft ?? fallback.soft;
    const hard = this.options.hard ?? fallback.hard;
    return { soft, hard: hard > soft ? hard : Math.min(1, soft + 0.05) };
  }

  /**
   * Something that gives memory back when asked: idle workers collecting or stopping. Named, so a part that is
   * created again (a pool in tests) replaces its earlier registration instead of adding to it.
   */
  setRelief(name: string, relieve: Relief) {
    this.reliefs.set(name, relieve);
  }

  /** The level now, from a sample at most `sampleMs` old. */
  level(): PressureLevel {
    this.sample();
    return this.current;
  }

  /**
   * For work that takes a lot of memory while it runs; throws MemoryPressureError when it may not start now: above
   * the hard threshold, and above soft unless the server is resting (no heavy job has run for the cool-down) and has
   * room for one job (`ONE_JOB_BYTES`). Work started inside a running heavy job (`runHeavy`) is part of it and always
   * admitted.
   *
   * Only a check: work that runs for a while goes through `runHeavy`, which counts it, so that no second job starts
   * beside it and the cool-down starts again when it ends. `oneShot` is for work done right after the check and not
   * counted (serialising a large result, queueing a pipeline): admitted on a resting server, it counts as a job that
   * has just ended, so a burst of such requests gets one through, not all of them.
   */
  admitHeavy(options: { oneShot?: boolean } = {}) {
    const level = this.level();
    if (level === 'normal' || this.inside.getStore()) return;
    if (level === 'soft' && this.idleFor(this.options.coolDownMs) && this.roomForOneJob()) {
      if (options.oneShot) this.heavyEndedAt = this.options.now();
      return;
    }
    this.refused[level]++;
    throw new MemoryPressureError(level === 'hard' ? 10 : 5);
  }

  /**
   * Runs a heavy job if `admitHeavy` lets it start, and counts it while it runs: under soft pressure no other heavy
   * job starts meanwhile. A job inside a running one is part of it and runs at once.
   */
  async runHeavy<T>(task: () => Promise<T>): Promise<T> {
    if (this.inside.getStore()) return task();
    this.admitHeavy();
    this.running++;
    try {
      return await this.inside.run(true, task);
    } finally {
      this.running--;
      this.heavyEndedAt = this.options.now();
    }
  }

  /**
   * `admitHeavy`, counting the job from the moment it is admitted rather than from when it starts: for work that
   * waits between the two, like a large request body that is received and then queues for its turn. Counted only
   * once it ran, a burst of slow uploads all found a resting server and all passed the check; counted from
   * admission, the first one keeps the resting server's one admission and the rest are refused.
   */
  reserveHeavy(): HeavyReservation {
    if (this.inside.getStore()) return { run: (task) => task(), release: () => {} };
    this.admitHeavy();
    this.running++;
    let released = false;
    return {
      run: (task) => this.inside.run(true, task),
      release: () => {
        if (released) return;
        released = true;
        this.running--;
        this.heavyEndedAt = this.options.now();
      },
    };
  }

  /** Heavy jobs running now (diagnostics and tests). */
  heavyRunning(): number {
    return this.running;
  }

  private roomForOneJob(): boolean {
    const r = this.reading;
    return r !== null && r.usedBytes + ONE_JOB_BYTES <= r.limitBytes;
  }

  /** Nothing heavy runs, and nothing has for `ms`. */
  private idleFor(ms: number, t = this.options.now()): boolean {
    return this.running === 0 && t - this.heavyEndedAt >= ms;
  }

  /** For new live streams, writes and other work that is not a plain read; throws above the hard threshold. */
  admitRequest() {
    if (this.level() !== 'hard') return;
    this.refused.hard++;
    throw new MemoryPressureError(10);
  }

  /** The last sample and the level (admin page). Null while the guard is off. */
  state(): MemoryState | null {
    this.sample();
    const r = this.reading;
    if (!r) return null;
    return {
      level: this.current,
      usedBytes: r.usedBytes,
      limitBytes: r.limitBytes,
      source: r.source,
      ...this.thresholds(r.limitBytes),
      refused: { ...this.refused },
    };
  }

  /** What the guard watches, for the startup log. */
  describe(): string {
    if (!this.options.reader)
      return 'memory guard off: no memory limit found (set MEMORY_LIMIT_MB to turn it on)';
    const r = this.sample() ?? this.reading;
    if (!r) return 'memory guard on, but memory use cannot be read yet';
    const { soft, hard } = this.thresholds(r.limitBytes);
    return `memory guard on: ${mb(r.usedBytes)} MB of ${mb(r.limitBytes)} MB in use (${r.source}); new heavy work waits above ${mb(soft * r.limitBytes)} MB (one job on a resting server up to ${mb(Math.max(soft * r.limitBytes, Math.min(hard * r.limitBytes, r.limitBytes - ONE_JOB_BYTES)))} MB), writes and live streams wait above ${mb(hard * r.limitBytes)} MB`;
  }

  private sample(): MemoryReading | null {
    const { reader, now, sampleMs } = this.options;
    if (!reader) return null;
    const t = now();
    if (t - this.sampledAt < sampleMs) return this.reading;
    this.sampledAt = t;
    let reading: MemoryReading | null;
    try {
      reading = reader();
    } catch {
      reading = null;
    }
    // A failed read keeps the last level: guessing "normal" would admit work exactly when the files are unreadable.
    if (!reading || !(reading.limitBytes > 0)) return null;
    this.reading = reading;
    const next = this.next(reading.usedBytes / reading.limitBytes, this.thresholds(reading.limitBytes));
    if (next !== this.current) {
      this.options.log(
        `[memory] ${next === 'normal' ? 'back to normal' : `${next} pressure`}: ${mb(reading.usedBytes)} MB of ${mb(reading.limitBytes)} MB (${Math.round((reading.usedBytes / reading.limitBytes) * 100)}%)${next === 'soft' ? ', refusing new heavy work' : next === 'hard' ? ', refusing new heavy work, writes and live streams' : ''}`,
      );
      this.current = next;
    }
    if (this.current !== 'normal') this.relieve(t);
    return reading;
  }

  private next(fraction: number, { soft, hard }: { soft: number; hard: number }): PressureLevel {
    const { margin } = this.options;
    if (fraction >= hard) return 'hard';
    if (this.current === 'hard' && fraction >= hard - margin) return 'hard';
    if (fraction >= soft) return 'soft';
    if (this.current !== 'normal' && fraction >= soft - margin && !this.idleFor(this.options.coolDownMs))
      return 'soft';
    return 'normal';
  }

  /**
   * V8 collects when its heap needs room, not when the container does: a main thread that has handled a burst keeps
   * its garbage until its own heap limit, far above what the container can spare. Collecting here gives it back, and
   * idle workers do the same. After the current request, so the refusal itself is not delayed by the collection.
   *
   * Once nothing heavy has run for the cool-down, the relief goes deeper, at most every `reclaimMs`: a collection
   * frees garbage, but a worker's grown isolate, full caches and a fragmented heap stay. A fresh worker and empty
   * caches cost the next requests some time, which an idle server under pressure can spare.
   */
  private relieve(t: number) {
    if (t - this.relievedAt < this.options.reliefMs) return;
    this.relievedAt = t;
    const deep = this.idleFor(this.options.coolDownMs, t) && t - this.reclaimedAt >= this.options.reclaimMs;
    if (deep) this.reclaimedAt = t;
    setImmediate(() => {
      for (const [name, relieve] of this.reliefs) {
        try {
          relieve(deep);
        } catch (e) {
          console.warn(`[memory] relief "${name}" failed`, e);
        }
      }
      // After the reliefs, so what they let go of is collected in the same pass.
      this.options.collect(deep);
      if (deep && this.reading) {
        this.options.log(
          `[memory] idle under ${this.current} pressure at ${mb(this.reading.usedBytes)} MB: emptied caches, replaced idle workers, compacted the heap`,
        );
      }
    });
  }
}

/** The process's guard. Off until main.ts configures it, so tests and tools are never refused by it by accident. */
export const memoryGuard = new MemoryGuard();
