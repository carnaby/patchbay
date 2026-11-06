import { afterEach, describe, expect, it } from 'vitest';
import { heavyWork } from './heavy.ts';
import { MemoryPressureError, memoryGuard } from './memory-pressure.ts';
import { runAsClient } from './request-context.ts';

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('heavyWork', () => {
  it('runs heavy jobs one at a time, in order', async () => {
    const log: string[] = [];
    let running = 0;
    let most = 0;
    const job = (name: string) =>
      runAsClient(`ip:${name}`, () =>
        heavyWork.run(async () => {
          running++;
          most = Math.max(most, running);
          log.push(`start ${name}`);
          await tick();
          log.push(`end ${name}`);
          running--;
        }),
      );
    await Promise.all([job('a'), job('b'), job('c')]);
    expect(most).toBe(1);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('runs a heavy job started inside another in the same turn instead of waiting for itself', async () => {
    const order: string[] = [];
    const outer = heavyWork.run(async () => {
      order.push('outer');
      await heavyWork.run(async () => {
        order.push('inner');
        await tick();
      });
      order.push('outer done');
    });
    const next = heavyWork.run(async () => {
      order.push('next');
    });
    await Promise.all([outer, next]);
    expect(order).toEqual(['outer', 'inner', 'outer done', 'next']);
    expect(heavyWork.stats()).toEqual({ active: 0, waiting: 0 });
  });

  it('refuses a client that queues more than its share', async () => {
    let release!: () => void;
    const holding = runAsClient('ip:holder', () =>
      heavyWork.run(() => new Promise<void>((r) => (release = r))),
    );
    await tick();
    const queued = Array.from({ length: 4 }, () =>
      runAsClient('ip:greedy', () => heavyWork.run(async () => {})),
    );
    await expect(runAsClient('ip:greedy', () => heavyWork.run(async () => {}))).rejects.toMatchObject({
      status: 503,
    });
    release();
    await holding;
    await Promise.all(queued);
  });
});

describe('heavy chains', () => {
  const limit = 512 * 1024 * 1024;
  let fraction = 0.3;
  const guard = () =>
    memoryGuard.configure({
      reader: () => ({ usedBytes: fraction * limit, limitBytes: limit, source: 'cgroup v2' }),
      sampleMs: 0,
      collect: () => {},
      log: () => {},
    });
  afterEach(() => memoryGuard.configure({ reader: null }));

  it('checks a chain at its first turn and lets its later runs through once it is admitted', async () => {
    fraction = 0.3;
    guard();
    const ran: string[] = [];
    await heavyWork.chain(async () => {
      await heavyWork.run(async () => {
        ran.push('parent');
        fraction = 0.97;
      });
      await heavyWork.run(async () => ran.push('child'));
    });
    expect(ran).toEqual(['parent', 'child']);
    await expect(heavyWork.chain(() => heavyWork.run(async () => ran.push('late')))).rejects.toBeInstanceOf(
      MemoryPressureError,
    );
    expect(ran).toHaveLength(2);
    expect(memoryGuard.heavyRunning()).toBe(0);
  });

  it('refuses every chain whose first turn comes after memory rose, however many arrived at normal', async () => {
    fraction = 0.3;
    guard();
    const ran: number[] = [];
    const chains = [0, 1, 2, 3].map((i) =>
      runAsClient(`ip:chain${i}`, () =>
        heavyWork.chain(async () => {
          await heavyWork.run(async () => {
            ran.push(i);
            await tick();
            fraction = 0.97;
          });
          await heavyWork.run(async () => ran.push(i));
        }),
      ),
    );
    const settled = await Promise.allSettled(chains);
    expect(settled.map((s) => s.status)).toEqual(['fulfilled', 'rejected', 'rejected', 'rejected']);
    for (const s of settled.slice(1))
      expect((s as PromiseRejectedResult).reason).toBeInstanceOf(MemoryPressureError);
    expect(ran).toEqual([0, 0]);
    expect(memoryGuard.heavyRunning()).toBe(0);
  });

  it('checks a run of an ended chain again when its turn comes', async () => {
    fraction = 0.3;
    guard();
    let releaseFirst!: () => void;
    let started!: () => void;
    const firstStarted = new Promise<void>((r) => (started = r));
    let left: Promise<unknown> | undefined;
    const chain = heavyWork.chain(async () => {
      await heavyWork.run(
        () =>
          new Promise<void>((r) => {
            releaseFirst = r;
            started();
          }),
      );
      // Abandoned: the chain ends (as at its deadline) while this run still waits for its turn.
      left = heavyWork.run(async () => 'ran');
      left.catch(() => {});
    });
    await firstStarted;
    let free!: () => void;
    const blocker = runAsClient('ip:other', () => heavyWork.run(() => new Promise<void>((r) => (free = r))));
    releaseFirst();
    await chain;
    fraction = 0.97;
    free();
    await blocker;
    await expect(left).rejects.toBeInstanceOf(MemoryPressureError);
    expect(memoryGuard.heavyRunning()).toBe(0);
  });

  it('does not count work that outlives a reservation or a heavy job as part of it', async () => {
    fraction = 0.3;
    guard();
    const outlive = async (start: (task: () => Promise<void>) => Promise<unknown>, end: () => void) => {
      let resume!: () => void;
      let inner: Promise<void> | undefined;
      await start(async () => {
        inner = new Promise<void>((r) => (resume = r)).then(() => memoryGuard.admitHeavy());
        inner.catch(() => {});
      });
      end();
      fraction = 0.97;
      resume();
      await expect(inner).rejects.toBeInstanceOf(MemoryPressureError);
      fraction = 0.3;
    };
    const reservation = memoryGuard.reserveHeavy();
    await outlive(reservation.run, () => reservation.release());
    await outlive(
      (task) => memoryGuard.runHeavy(task),
      () => {},
    );
    expect(memoryGuard.heavyRunning()).toBe(0);
  });
});
