import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../util/rate-limit.ts';
import { runAsClient } from '../util/request-context.ts';
import { SnapshotCache } from './cache.ts';
import { chargeSnapshot, RenderBusyError, RenderGate, SnapshotRateError } from './gate.ts';
import { RenderFailedError } from './worker-host.ts';

/** A gate whose tasks are functions it calls, in place of the render worker. */
const testGate = (maxPending: number, maxPendingPerClient = maxPending) =>
  new RenderGate<() => unknown, unknown>({
    maxPending,
    maxPendingPerClient,
    render: async (task) => task(),
  });

/** A promise with its resolve function, to hold a job open until the test lets it go. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('RenderGate', () => {
  it('turns requests beyond the limit away with 503 and Retry-After', async () => {
    const gate = testGate(2);
    const hold = deferred();
    const jobs = [gate.run(() => hold.promise), gate.run(() => hold.promise)];
    expect(gate.pending()).toBe(2);
    const busy = await gate.run(async () => 'never').catch((e: unknown) => e);
    expect(busy).toBeInstanceOf(RenderBusyError);
    expect((busy as RenderBusyError).status).toBe(503);
    expect((busy as RenderBusyError).retryAfterSec).toBeGreaterThan(0);
    hold.resolve();
    await Promise.all(jobs);
    expect(gate.pending()).toBe(0);
    await expect(gate.run(async () => 'now')).resolves.toBe('now');
  });

  it('never runs two draws at once, across jobs', async () => {
    const gate = testGate(5);
    let active = 0;
    let most = 0;
    const order: number[] = [];
    const jobs = Array.from({ length: 5 }, (_, n) =>
      gate.run(async (draw) => {
        await new Promise((r) => setTimeout(r, 5 - n));
        return draw(async () => {
          active++;
          most = Math.max(most, active);
          order.push(n);
          await new Promise((r) => setTimeout(r, 3));
          active--;
          return n;
        });
      }),
    );
    expect(await Promise.all(jobs)).toEqual([0, 1, 2, 3, 4]);
    expect(most).toBe(1);
    expect(order).toHaveLength(5);
  });

  it('keeps one client from taking every slot', async () => {
    const gate = testGate(4, 2);
    const hold = deferred();
    const mine = [
      runAsClient('ip:a', () => gate.run(() => hold.promise)),
      runAsClient('ip:a', () => gate.run(() => hold.promise)),
    ];
    const third = await runAsClient('ip:a', () => gate.run(async () => 'never')).catch((e: unknown) => e);
    expect(third).toBeInstanceOf(RenderBusyError);
    // Someone else still gets in while the first client waits.
    await expect(runAsClient('ip:b', () => gate.run(async () => 'other'))).resolves.toBe('other');
    hold.resolve();
    await Promise.all(mine);
    await expect(runAsClient('ip:a', () => gate.run(async () => 'again'))).resolves.toBe('again');
  });

  it('frees the slot of a job that fails, in the draw or before it', async () => {
    const gate = testGate(1);
    await expect(
      gate.run((draw) =>
        draw(() => {
          throw new Error('broken widget');
        }),
      ),
    ).rejects.toThrow('broken widget');
    await expect(gate.run(async () => Promise.reject(new Error('no data')))).rejects.toThrow('no data');
    expect(gate.pending()).toBe(0);
    // A failed draw does not wedge the queue for the next one.
    await expect(gate.run((draw) => draw(() => 'fine'))).resolves.toBe('fine');
  });
});

describe('chargeSnapshot', () => {
  it('lets a client draw a few snapshots, then answers 429 with Retry-After', () => {
    const limiter = new RateLimiter(2, 30);
    chargeSnapshot(limiter, 'ip:a');
    chargeSnapshot(limiter, 'ip:a');
    let limited: unknown;
    try {
      chargeSnapshot(limiter, 'ip:a');
    } catch (e) {
      limited = e;
    }
    expect(limited).toBeInstanceOf(SnapshotRateError);
    expect((limited as SnapshotRateError).status).toBe(429);
    // 30 a minute: the next one is free in two seconds at most.
    expect((limited as SnapshotRateError).retryAfterSec).toBeGreaterThanOrEqual(1);
    expect((limited as SnapshotRateError).retryAfterSec).toBeLessThanOrEqual(2);
    // Other clients have their own budget.
    expect(() => chargeSnapshot(limiter, 'ip:b')).not.toThrow();
  });
});

describe('SnapshotCache', () => {
  const png = (text: string) => Buffer.from(text);

  it('serves a repeat from memory and shares a render in flight', async () => {
    const cache = new SnapshotCache();
    let renders = 0;
    const hold = deferred<Buffer>();
    const render = () => {
      renders++;
      return hold.promise;
    };
    const key = SnapshotCache.key({ id: 'd', version: 3, theme: 'light' });
    const first = cache.get(key, render);
    const second = cache.get(key, render);
    hold.resolve(png('image'));
    expect((await first).toString()).toBe('image');
    expect((await second).toString()).toBe('image');
    await cache.get(key, render);
    expect(renders).toBe(1);
  });

  it('renders again after the time to live, a new version, another theme or widget', async () => {
    let now = 0;
    const cache = new SnapshotCache({ ttlMs: 1000, now: () => now });
    let renders = 0;
    const render = async () => png(`r${++renders}`);
    const key = (parts: Partial<Parameters<typeof SnapshotCache.key>[0]> = {}) =>
      SnapshotCache.key({ id: 'd', version: 1, theme: 'light', ...parts });
    await cache.get(key(), render);
    await cache.get(key({ version: 2 }), render);
    await cache.get(key({ theme: 'dark' }), render);
    await cache.get(key({ widget: 'w1' }), render);
    expect(renders).toBe(4);
    now = 1001;
    expect((await cache.get(key(), render)).toString()).toBe('r5');
  });

  it('does not remember failures and keeps within its byte budget', async () => {
    const cache = new SnapshotCache({ maxBytes: 10 });
    const key = (n: number) => SnapshotCache.key({ id: `d${n}`, version: 1, theme: 'light' });
    await expect(cache.get(key(0), async () => Promise.reject(new RenderBusyError()))).rejects.toThrow();
    expect(cache.size()).toBe(0);
    for (let n = 1; n <= 4; n++) await cache.get(key(n), async () => png('1234'));
    // Two images of four bytes fit into ten; the oldest went first.
    expect(cache.size()).toBe(2);
    let renders = 0;
    await cache.get(key(4), async () => {
      renders++;
      return png('1234');
    });
    expect(renders).toBe(0);
  });

  it('remembers a render that ran out of time until it expires, so it is not paid for again', async () => {
    let now = 0;
    const cache = new SnapshotCache({ ttlMs: 1000, now: () => now });
    let renders = 0;
    const key = SnapshotCache.key({ id: 'heavy', version: 1, theme: 'light' });
    const timeout = async () => {
      renders++;
      throw new RenderFailedError('too slow', { lasting: true });
    };
    await expect(cache.get(key, timeout)).rejects.toThrow('too slow');
    await expect(cache.get(key, timeout)).rejects.toThrow('too slow');
    expect(renders).toBe(1);
    now = 1001;
    await expect(cache.get(key, async () => png('drawn'))).resolves.toEqual(png('drawn'));
  });
});
