import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultThresholds,
  detectMemoryReader,
  MemoryGuard,
  type MemoryGuardOptions,
  MemoryPressureError,
  type MemoryReading,
} from './memory-pressure.ts';

const MB = 1024 * 1024;

/** A guard over a reading the test sets, with its own clock. */
function setup(options: Partial<MemoryGuardOptions> = {}) {
  let used = 100 * MB;
  let clock = 0;
  const logs: string[] = [];
  const reader = vi.fn((): MemoryReading | null => ({
    usedBytes: used,
    limitBytes: 1000 * MB,
    source: 'cgroup v2',
  }));
  const collect = vi.fn();
  const guard = new MemoryGuard({
    reader,
    now: () => clock,
    log: (m) => logs.push(m),
    collect,
    ...options,
  });
  return {
    guard,
    reader,
    collect,
    logs,
    /** Sets use as a fraction of the 1000 MB limit and moves past the sample interval. */
    at(fraction: number) {
      used = fraction * 1000 * MB;
      clock += 1000;
      return guard.level();
    },
    tick(ms: number) {
      clock += ms;
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('MemoryGuard', () => {
  it('admits everything below the soft threshold', () => {
    const { guard, at } = setup();
    expect(at(0.5)).toBe('normal');
    expect(() => guard.admitHeavy()).not.toThrow();
    expect(() => guard.admitRequest()).not.toThrow();
  });

  it('above soft refuses new heavy work with 503, except one job at a time on a resting server', async () => {
    const { guard, at, tick } = setup({ coolDownMs: 30_000 });
    expect(at(0.82)).toBe('soft');
    expect(() => guard.admitRequest()).not.toThrow();
    // Nothing heavy has run: one job may start.
    let release!: () => void;
    const job = guard.runHeavy(() => new Promise<void>((resolve) => (release = resolve)));
    expect(guard.heavyRunning()).toBe(1);
    let error: unknown;
    try {
      guard.admitHeavy();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MemoryPressureError);
    expect((error as MemoryPressureError).status).toBe(503);
    expect((error as MemoryPressureError).retryAfterSec).toBe(5);
    await expect(guard.runHeavy(async () => 'second')).rejects.toBeInstanceOf(MemoryPressureError);
    release();
    await job;
    // A burst keeps the server busy and never gets past this: the cool-down starts again after each job.
    expect(() => guard.admitHeavy()).toThrow(MemoryPressureError);
    tick(30_000);
    expect(() => guard.admitHeavy()).not.toThrow();
    // Work that is not counted while it runs uses the rest up at once.
    guard.admitHeavy({ oneShot: true });
    expect(() => guard.admitHeavy()).toThrow(MemoryPressureError);
    expect(guard.state()?.refused).toEqual({ soft: 4, hard: 0 });
  });

  it('counts a reserved job from its admission, so work that waits before it runs cannot all pass at rest', async () => {
    const { guard, at, tick } = setup({ coolDownMs: 30_000 });
    expect(at(0.82)).toBe('soft');
    // Three slow uploads arrive together: the first takes the resting server's one admission, while it still arrives.
    const first = guard.reserveHeavy();
    expect(guard.heavyRunning()).toBe(1);
    expect(() => guard.reserveHeavy()).toThrow(MemoryPressureError);
    expect(() => guard.reserveHeavy()).toThrow(MemoryPressureError);
    // Its work runs inside the reservation: what it starts is admitted.
    await expect(first.run(async () => guard.runHeavy(async () => 'inner'))).resolves.toBe('inner');
    first.release();
    first.release();
    expect(guard.heavyRunning()).toBe(0);
    // Then the cool-down starts again, as after any heavy job.
    expect(() => guard.reserveHeavy()).toThrow(MemoryPressureError);
    tick(30_000);
    const next = guard.reserveHeavy();
    next.release();
    // Below soft, reservations never refuse.
    at(0.5);
    const many = [guard.reserveHeavy(), guard.reserveHeavy(), guard.reserveHeavy()];
    expect(guard.heavyRunning()).toBe(3);
    for (const r of many) r.release();
    expect(guard.heavyRunning()).toBe(0);
  });

  it('above soft admits the lone job only while one job’s growth still fits under the limit', () => {
    let used = 270 * MB;
    const guard = new MemoryGuard({
      reader: () => ({ usedBytes: used, limitBytes: 384 * MB, source: 'cgroup v2' }),
      sampleMs: 0,
      log: () => {},
      collect: () => {},
    });
    expect(guard.level()).toBe('soft');
    expect(() => guard.admitHeavy()).not.toThrow();
    used = 272 * MB;
    expect(() => guard.admitHeavy()).not.toThrow();
    used = 273 * MB;
    expect(() => guard.admitHeavy()).toThrow(MemoryPressureError);
    expect(guard.describe()).toContain(
      'new heavy work waits above 256 MB (one job on a resting server up to 272 MB), writes and live streams wait above 320 MB',
    );
  });

  it('above hard refuses all new heavy work, writes and live streams, never work inside a running job', async () => {
    const { guard, at } = setup();
    expect(at(0.93)).toBe('hard');
    expect(() => guard.admitHeavy()).toThrow(MemoryPressureError);
    expect(() => guard.admitRequest()).toThrow(MemoryPressureError);
    expect(guard.state()?.refused).toEqual({ soft: 0, hard: 2 });

    at(0.5);
    const inner = await guard.runHeavy(async () => {
      expect(at(0.95)).toBe('hard');
      expect(() => guard.admitHeavy()).not.toThrow();
      return guard.runHeavy(async () => 'inner');
    });
    expect(inner).toBe('inner');
    expect(guard.heavyRunning()).toBe(0);
  });

  it('leaves a level only a margin below its threshold while heavy work runs, so it does not flap', async () => {
    const { guard, at } = setup();
    let release!: () => void;
    const job = guard.runHeavy(() => new Promise<void>((resolve) => (release = resolve)));
    expect(at(0.81)).toBe('soft');
    expect(at(0.79)).toBe('soft');
    expect(at(0.76)).toBe('soft');
    expect(at(0.74)).toBe('normal');
    // Rising again needs the threshold itself, not the lower bound.
    expect(at(0.79)).toBe('normal');

    expect(at(0.91)).toBe('hard');
    expect(at(0.88)).toBe('hard');
    expect(at(0.86)).toBe('hard');
    expect(at(0.84)).toBe('soft');
    expect(at(0.76)).toBe('soft');
    expect(at(0.7)).toBe('normal');
    release();
    await job;
  });

  it('leaves soft below its threshold once no heavy work has run for the cool-down', async () => {
    const { guard, at, tick } = setup({ coolDownMs: 30_000 });
    await guard.runHeavy(async () => {});
    expect(at(0.82)).toBe('soft');
    // Right after a job the reading may be its peak on the way down: the margin holds.
    expect(at(0.78)).toBe('soft');
    tick(30_000);
    // Nothing ran since: this is the resting level.
    expect(at(0.78)).toBe('normal');
    // Above the threshold it stays soft, however long nothing ran.
    expect(at(0.81)).toBe('soft');
    tick(120_000);
    expect(at(0.81)).toBe('soft');
  });

  it('goes straight from hard to normal when use drops that far', () => {
    const { at } = setup();
    expect(at(0.95)).toBe('hard');
    expect(at(0.5)).toBe('normal');
  });

  it('reads memory at most once per sample interval', () => {
    const { guard, reader, tick } = setup({ sampleMs: 250 });
    guard.level();
    guard.level();
    tick(100);
    guard.admitHeavy();
    expect(reader).toHaveBeenCalledTimes(1);
    tick(150);
    guard.level();
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it('logs each transition once, with the numbers', () => {
    const { at, logs } = setup();
    at(0.5);
    at(0.85);
    at(0.86);
    at(0.95);
    at(0.96);
    at(0.6);
    at(0.6);
    expect(logs).toEqual([
      '[memory] soft pressure: 850 MB of 1000 MB (85%), refusing new heavy work',
      '[memory] hard pressure: 950 MB of 1000 MB (95%), refusing new heavy work, writes and live streams',
      '[memory] back to normal: 600 MB of 1000 MB (60%)',
    ]);
  });

  it('keeps the last level when a sample cannot be taken', () => {
    const { guard, reader, at, tick } = setup();
    expect(at(0.85)).toBe('soft');
    reader.mockImplementation(() => {
      throw new Error('EIO');
    });
    tick(1000);
    expect(guard.level()).toBe('soft');
    reader.mockReturnValue(null);
    tick(1000);
    expect(guard.level()).toBe('soft');
  });

  it('collects garbage and asks the reliefs under pressure, at most once per interval and never when normal', async () => {
    const { guard, at, collect } = setup({ reliefMs: 5000 });
    const relief = vi.fn();
    guard.setRelief('workers', relief);
    at(0.5);
    await flush();
    expect(collect).not.toHaveBeenCalled();
    at(0.85);
    at(0.86); // 1 s later: within the interval
    await flush();
    expect(collect).toHaveBeenCalledTimes(1);
    expect(relief).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 4; i++) at(0.86);
    await flush();
    expect(collect).toHaveBeenCalledTimes(2);
    expect(relief).toHaveBeenCalledTimes(2);
  });

  it('goes deep once idle under pressure: reliefs drop what is costly to rebuild and the heap is compacted', async () => {
    const { guard, at, tick, collect, logs } = setup({
      reliefMs: 5000,
      coolDownMs: 30_000,
      reclaimMs: 60_000,
    });
    const relief = vi.fn();
    guard.setRelief('caches', relief);
    await guard.runHeavy(async () => {});
    at(0.85);
    await flush();
    expect(relief).toHaveBeenLastCalledWith(false);
    expect(collect).toHaveBeenLastCalledWith(false);
    tick(30_000);
    at(0.85);
    await flush();
    expect(relief).toHaveBeenLastCalledWith(true);
    expect(collect).toHaveBeenLastCalledWith(true);
    expect(logs.at(-1)).toContain('idle under soft pressure at 850 MB');
    // At most once per reclaim interval; light reliefs in between.
    tick(10_000);
    at(0.85);
    await flush();
    expect(relief).toHaveBeenLastCalledWith(false);
    tick(60_000);
    at(0.85);
    await flush();
    expect(relief).toHaveBeenLastCalledWith(true);
    // Not while heavy work runs.
    let release!: () => void;
    const job = guard.runHeavy(() => new Promise<void>((resolve) => (release = resolve)));
    tick(120_000);
    at(0.85);
    await flush();
    expect(relief).toHaveBeenLastCalledWith(false);
    release();
    await job;
  });

  it('samples on its own timer when asked to, so an idle server changes level', () => {
    vi.useFakeTimers();
    try {
      let used = 100 * MB;
      const logs: string[] = [];
      const guard = new MemoryGuard({ reader: null });
      guard.configure({
        reader: () => ({ usedBytes: used, limitBytes: 1000 * MB, source: 'cgroup v2' }),
        pollMs: 10_000,
        sampleMs: 0,
        log: (m) => logs.push(m),
        collect: () => {},
      });
      used = 850 * MB;
      vi.advanceTimersByTime(10_000);
      expect(logs[0]).toBe('[memory] soft pressure: 850 MB of 1000 MB (85%), refusing new heavy work');
      const logged = logs.length;
      guard.configure({ reader: null });
      used = 100 * MB;
      vi.advanceTimersByTime(60_000);
      expect(logs).toHaveLength(logged);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces a relief registered again under the same name', async () => {
    const { guard, at } = setup();
    const first = vi.fn();
    const second = vi.fn();
    guard.setRelief('pool', first);
    guard.setRelief('pool', second);
    at(0.85);
    await flush();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('admits everything and reports nothing while it is off', () => {
    const guard = new MemoryGuard({ reader: null });
    expect(guard.enabled).toBe(false);
    expect(guard.level()).toBe('normal');
    expect(() => guard.admitHeavy()).not.toThrow();
    expect(guard.state()).toBeNull();
    expect(guard.describe()).toContain('off');
  });

  it('keeps a fixed amount free above its default thresholds on small limits, and 80% / 90% on large ones', () => {
    const at = (limitMb: number) => {
      const { soft, hard } = defaultThresholds(limitMb * MB);
      return [Math.round(soft * limitMb), Math.round(hard * limitMb)];
    };
    expect(at(384)).toEqual([256, 320]);
    expect(at(512)).toEqual([384, 448]);
    expect(at(4096)).toEqual([3277, 3686]);
    // Tiny limits: never below half, and hard always above soft.
    expect(at(128)).toEqual([64, 70]);
  });

  it('uses configured thresholds over the defaults, keeping hard above soft', () => {
    const guard = new MemoryGuard({ reader: null, soft: 0.6 });
    expect(guard.thresholds(384 * MB)).toEqual({ soft: 0.6, hard: 1 - 64 / 384 });
    const inverted = new MemoryGuard({ reader: null, soft: 0.9, hard: 0.85 });
    expect(inverted.thresholds(384 * MB).hard).toBeCloseTo(0.95);
  });

  it('starts from normal when configured again', () => {
    const { guard, at } = setup();
    expect(at(0.95)).toBe('hard');
    guard.configure({ reader: () => ({ usedBytes: 1, limitBytes: 100, source: 'process' }) });
    expect(guard.level()).toBe('normal');
    expect(guard.state()?.refused).toEqual({ soft: 0, hard: 0 });
  });
});

/** cgroup files as the kernel writes them, with a memory.stat that has the fields the reader uses. */
function files(entries: Record<string, string>) {
  return (path: string) => entries[path] ?? null;
}
const stat = (fields: Record<string, number>) =>
  Object.entries(fields)
    .map(([k, v]) => `${k} ${v}`)
    .join('\n')
    .concat('\n');

describe('detectMemoryReader', () => {
  it('reads cgroup v2 and leaves out the page cache the kernel can reclaim', () => {
    const read = detectMemoryReader({
      readText: files({
        '/sys/fs/cgroup/memory.max': '402653184\n',
        '/sys/fs/cgroup/memory.current': `${300 * MB}\n`,
        '/sys/fs/cgroup/memory.stat': stat({
          anon: 200 * MB,
          file: 90 * MB,
          active_file: 30 * MB,
          inactive_file: 50 * MB,
          shmem: 10 * MB,
          kernel: 10 * MB,
        }),
      }),
    });
    expect(read?.()).toEqual({ usedBytes: 220 * MB, limitBytes: 384 * MB, source: 'cgroup v2' });
  });

  it('finds the cgroup through /proc/self/cgroup when the namespace is the host’s', () => {
    const dir = '/sys/fs/cgroup/system.slice/docker-abc.scope';
    const read = detectMemoryReader({
      readText: files({
        '/proc/self/cgroup': '0::/system.slice/docker-abc.scope\n',
        [`${dir}/memory.max`]: `${512 * MB}`,
        [`${dir}/memory.current`]: `${100 * MB}`,
        [`${dir}/memory.stat`]: stat({ active_file: 0, inactive_file: 0 }),
      }),
    });
    expect(read?.()).toMatchObject({ usedBytes: 100 * MB, limitBytes: 512 * MB });
  });

  it('falls back to cgroup v1', () => {
    const read = detectMemoryReader({
      readText: files({
        '/sys/fs/cgroup/memory/memory.limit_in_bytes': `${256 * MB}`,
        '/sys/fs/cgroup/memory/memory.usage_in_bytes': `${120 * MB}`,
        '/sys/fs/cgroup/memory/memory.stat': stat({
          cache: 40 * MB,
          total_active_file: 10 * MB,
          total_inactive_file: 10 * MB,
        }),
      }),
    });
    expect(read?.()).toEqual({ usedBytes: 100 * MB, limitBytes: 256 * MB, source: 'cgroup v1' });
  });

  it('lets MEMORY_LIMIT_MB override the cgroup limit, and 0 turn the guard off', () => {
    const cgroup = files({
      '/sys/fs/cgroup/memory.max': `${512 * MB}`,
      '/sys/fs/cgroup/memory.current': `${100 * MB}`,
      '/sys/fs/cgroup/memory.stat': stat({}),
    });
    expect(detectMemoryReader({ readText: cgroup, limitMb: 300 })?.()).toMatchObject({
      limitBytes: 300 * MB,
    });
    expect(detectMemoryReader({ readText: cgroup, limitMb: 0 })).toBeNull();
  });

  it('without a cgroup limit, compares the process with MEMORY_LIMIT_MB or stays off', () => {
    const unlimited = files({
      '/sys/fs/cgroup/memory.max': 'max\n',
      '/sys/fs/cgroup/memory.current': `${9000 * MB}`,
      '/sys/fs/cgroup/memory.stat': stat({}),
    });
    expect(detectMemoryReader({ readText: unlimited })).toBeNull();
    const read = detectMemoryReader({ readText: unlimited, limitMb: 400, rss: () => 150 * MB });
    expect(read?.()).toEqual({ usedBytes: 150 * MB, limitBytes: 400 * MB, source: 'process' });
  });

  it('stays off without cgroup files (Windows, macOS) unless a limit is given', () => {
    const none = files({});
    expect(detectMemoryReader({ readText: none })).toBeNull();
    expect(detectMemoryReader({ readText: none, limitMb: 200, rss: () => MB })?.()).toMatchObject({
      source: 'process',
    });
  });

  it('treats cgroup v1’s huge "no limit" number as no limit', () => {
    const read = detectMemoryReader({
      readText: files({
        '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712',
        '/sys/fs/cgroup/memory/memory.usage_in_bytes': `${120 * MB}`,
        '/sys/fs/cgroup/memory/memory.stat': stat({}),
      }),
    });
    expect(read).toBeNull();
  });

  it('gives no sample while a file cannot be read', () => {
    let current: string | null = `${100 * MB}`;
    const read = detectMemoryReader({
      readText: (path) =>
        ({
          '/sys/fs/cgroup/memory.max': `${512 * MB}`,
          '/sys/fs/cgroup/memory.current': current,
          '/sys/fs/cgroup/memory.stat': stat({}),
        })[path] ?? null,
    });
    expect(read?.()).not.toBeNull();
    current = null;
    expect(read?.()).toBeNull();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
