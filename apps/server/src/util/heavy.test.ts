import { describe, expect, it } from 'vitest';
import { heavyWork } from './heavy.ts';
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
