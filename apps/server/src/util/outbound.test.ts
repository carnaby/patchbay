import { afterEach, describe, expect, it, vi } from 'vitest';
import { RetryLaterError } from './errors.ts';
import { OutboundLimiter } from './outbound.ts';

const limiter = (connector: Record<string, number>) => new OutboundLimiter({ connector });

describe('connector budget', () => {
  afterEach(() => vi.useRealTimers());

  it('queues a load above the per-host concurrency and starts it when a place frees', async () => {
    const l = limiter({ perHostConcurrency: 1, perHostPerMinute: 60, maxWaitMs: 8000 });
    const first = await l.acquireConnectorSlot('a', 'h.example');
    let started = false;
    const second = l.acquireConnectorSlot('b', 'h.example').then((r) => {
      started = true;
      return r;
    });
    await Promise.resolve();
    expect(started).toBe(false);
    first();
    (await second)();
    expect(started).toBe(true);
  });

  it('refuses after the wait with a RetryLaterError naming the host', async () => {
    vi.useFakeTimers();
    const l = limiter({ perHostConcurrency: 1, perHostPerMinute: 60, maxWaitMs: 8000 });
    await l.acquireConnectorSlot('a', 'h.example');
    const waiting = l.acquireConnectorSlot('b', 'h.example');
    vi.advanceTimersByTime(8001);
    await expect(waiting).rejects.toBeInstanceOf(RetryLaterError);
    await expect(waiting).rejects.toThrow(/already loading a lot from h\.example; it will try again shortly/);
  });

  it('waits for a token when the minute budget is spent, then starts', async () => {
    vi.useFakeTimers();
    const l = limiter({ perHostConcurrency: 10, perHostPerMinute: 2, maxWaitMs: 60_000 });
    (await l.acquireConnectorSlot('a', 'h.example'))();
    (await l.acquireConnectorSlot('a', 'h.example'))();
    const third = l.acquireConnectorSlot('a', 'h.example');
    await vi.advanceTimersByTimeAsync(30_000); // one token per 30 s at 2/min
    await expect(third).resolves.toBeTypeOf('function');
  });

  it('keeps hosts apart, and keeps connector buckets apart from http-source buckets', async () => {
    const l = limiter({ perHostConcurrency: 1, perHostPerMinute: 60 });
    await l.acquireConnectorSlot('a', 'one.example');
    await expect(l.acquireConnectorSlot('a', 'two.example')).resolves.toBeTypeOf('function');
    await expect(l.run('a', 'https://one.example/x', async () => 1)).resolves.toBe(1);
  });

  it('serves waiters first: a new request never jumps ahead of the queue', async () => {
    const l = limiter({ perHostConcurrency: 1, perHostPerMinute: 60 });
    const first = await l.acquireConnectorSlot('a', 'h.example');
    const order: string[] = [];
    const b = l.acquireConnectorSlot('b', 'h.example').then((r) => {
      order.push('b');
      return r;
    });
    first(); // b is granted on release; c arrives after and must queue behind b's place
    const c = l.acquireConnectorSlot('c', 'h.example').then((r) => {
      order.push('c');
      return r;
    });
    (await b)();
    (await c)();
    expect(order).toEqual(['b', 'c']);
  });

  it('never arms a busy wake timer when the minute budget is zero', async () => {
    vi.useFakeTimers();
    const l = limiter({ perHostConcurrency: 1, perHostPerMinute: 0, maxWaitMs: 1000 });
    const waiting = l.acquireConnectorSlot('a', 'h.example');
    expect(vi.getTimerCount()).toBe(1); // only the waiter's own timeout
    vi.advanceTimersByTime(1001);
    await expect(waiting).rejects.toBeInstanceOf(RetryLaterError);
  });

  it('refuses at once beyond the queue caps (per host and per client on that host)', async () => {
    const l = limiter({
      perHostConcurrency: 1,
      perHostPerMinute: 60,
      maxQueuePerHost: 2,
      maxQueuedPerClient: 1,
    });
    await l.acquireConnectorSlot('a', 'h.example');
    void l.acquireConnectorSlot('b', 'h.example').catch(() => {});
    await expect(l.acquireConnectorSlot('b', 'h.example')).rejects.toBeInstanceOf(RetryLaterError); // client cap
    void l.acquireConnectorSlot('c', 'h.example').catch(() => {});
    await expect(l.acquireConnectorSlot('d', 'h.example')).rejects.toBeInstanceOf(RetryLaterError); // host cap
  });

  it('turns an http-source refusal into a RetryLaterError with status 429', async () => {
    const l = new OutboundLimiter({ perHostConcurrency: 1 });
    const slow = l.run('a', 'https://h.example/1', () => new Promise(() => {}));
    void slow;
    const refused = l.run('a', 'https://h.example/2', async () => 1);
    await expect(refused).rejects.toMatchObject({ status: 429, retryAfterSec: 10 });
    await expect(refused).rejects.toThrow(/already loading a lot from h\.example; it will try again shortly/);
  });
});
