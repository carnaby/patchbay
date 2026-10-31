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
 * - soft: no new heavy work (heavy.ts turns, uploads and large bodies, snapshot renders, pipelines that need a
 *   worker, new serialisations of large results);
 * - hard: also no new live streams and no writes; reads that answer from memory (documents, cached results, the
 *   health check, static files) keep working.
 * A level is left only once use is a margin below its threshold, so one sample near a threshold cannot make it flap.
 *
 * What is measured, with cgroup v2: `memory.current` minus the page cache the kernel can drop (`active_file` and
 * `inactive_file` in `memory.stat`). The OOM killer acts on the cgroup's charge once reclaim has failed, and reclaim
 * drops clean page cache first: SQLite pages and dashboard files read through the cache inflate `memory.current`
 * without bringing a kill any closer. What remains (anonymous memory of every thread, tmpfs, kernel memory for
 * sockets and page tables) is what a kill is decided on.
 */
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
  now?: () => number;
  log?: (message: string) => void;
  /** Collects the main thread's garbage; by default `gc` when the process runs with --expose-gc. */
  collect?: () => void;
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

const DEFAULTS = { margin: 0.05, sampleMs: 250, reliefMs: 5000 };

const MB = 1024 * 1024;
/** What one heavy job can add within a second: a worker heap filled to its limit (96 MB) plus the copy sent to it. */
const SOFT_RESERVE_BYTES = 128 * MB;
/** What work already running can still add once heavy work is refused: bodies being read, socket buffers, results. */
const HARD_RESERVE_BYTES = 64 * MB;

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
  private current: PressureLevel = 'normal';
  private readonly refused = { soft: 0, hard: 0 };
  private readonly reliefs = new Map<string, () => void>();

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
    this.current = 'normal';
    this.refused.soft = 0;
    this.refused.hard = 0;
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
  setRelief(name: string, relieve: () => void) {
    this.reliefs.set(name, relieve);
  }

  /** The level now, from a sample at most `sampleMs` old. */
  level(): PressureLevel {
    this.sample();
    return this.current;
  }

  /** For work that takes a lot of memory while it runs; throws MemoryPressureError above the soft threshold. */
  admitHeavy() {
    const level = this.level();
    if (level === 'normal') return;
    this.refused[level]++;
    throw new MemoryPressureError(level === 'hard' ? 10 : 5);
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
    return `memory guard on: ${mb(r.usedBytes)} MB of ${mb(r.limitBytes)} MB in use (${r.source}); new heavy work waits above ${mb(soft * r.limitBytes)} MB, writes and live streams above ${mb(hard * r.limitBytes)} MB`;
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
    if (this.current !== 'normal' && fraction >= soft - margin) return 'soft';
    return 'normal';
  }

  /**
   * V8 collects when its heap needs room, not when the container does: a main thread that has handled a burst keeps
   * its garbage until its own heap limit, far above what the container can spare. Collecting here gives it back, and
   * idle workers do the same. After the current request, so the refusal itself is not delayed by the collection.
   */
  private relieve(t: number) {
    if (t - this.relievedAt < this.options.reliefMs) return;
    this.relievedAt = t;
    setImmediate(() => {
      this.options.collect();
      for (const [name, relieve] of this.reliefs) {
        try {
          relieve();
        } catch (e) {
          console.warn(`[memory] relief "${name}" failed`, e);
        }
      }
    });
  }
}

/** The process's guard. Off until main.ts configures it, so tests and tools are never refused by it by accident. */
export const memoryGuard = new MemoryGuard();
