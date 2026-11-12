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

  it('drops a waiter whose load ended, without spending a token on it', async () => {
    const l = limiter({ perHostConcurrency: 1, perHostPerMinute: 2, maxWaitMs: 8000 });
    const holder = await l.acquireConnectorSlot('x', 'h.example'); // 1 token left
    const ended = new AbortController();
    const waiting = l.acquireConnectorSlot('y', 'h.example', ended.signal);
    ended.abort();
    await expect(waiting).rejects.toThrow('The load ended before its turn came');
    holder();
    // The token the abandoned waiter would have taken is still there.
    await expect(
      Promise.race([
        l.acquireConnectorSlot('z', 'h.example'),
        new Promise((r) => setTimeout(() => r('blocked'), 50)),
      ]),
    ).resolves.toBeTypeOf('function');
  });

  it('refuses at once when the load already ended, and takes no place', async () => {
    const l = limiter({ perHostConcurrency: 1, perHostPerMinute: 60, maxWaitMs: 8000 });
    const ended = new AbortController();
    ended.abort();
    await expect(l.acquireConnectorSlot('x', 'h.example', ended.signal)).rejects.toThrow(
      'The load ended before its turn came',
    );
    const release = await l.acquireConnectorSlot('y', 'h.example'); // the only place is still free
    release();
  });

  it('keeps the order of the others when a waiter in the middle leaves', async () => {
    const l = limiter({ perHostConcurrency: 1, perHostPerMinute: 60, maxWaitMs: 8000 });
    const holder = await l.acquireConnectorSlot('x', 'h.example');
    const order: string[] = [];
    const queue = (client: string, signal?: AbortSignal) =>
      l.acquireConnectorSlot(client, 'h.example', signal).then((release) => {
        order.push(client);
        return release;
      });
    const endedB = new AbortController();
    const a = queue('a');
    const b = queue('b', endedB.signal);
    const c = queue('c');
    endedB.abort();
    await expect(b).rejects.toThrow('The load ended before its turn came');
    holder();
    const releaseA = await a;
    await Promise.resolve();
    expect(order).toEqual(['a']); // c still waits for a's place
    releaseA();
    (await c)();
    expect(order).toEqual(['a', 'c']);
  });

  it('clears the wait timeout of a waiter whose load ended, so it fails once', async () => {
    vi.useFakeTimers();
    const l = limiter({ perHostConcurrency: 1, perHostPerMinute: 60, maxWaitMs: 1000 });
    const holder = await l.acquireConnectorSlot('x', 'h.example');
    const ended = new AbortController();
    const waiting = l.acquireConnectorSlot('y', 'h.example', ended.signal);
    ended.abort();
    await expect(waiting).rejects.toThrow('The load ended before its turn came');
    expect(vi.getTimerCount()).toBe(0); // its timeout went with it
    vi.advanceTimersByTime(1001);
    holder();
    await expect(l.acquireConnectorSlot('z', 'h.example')).resolves.toBeTypeOf('function');
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
});

describe('http source budget', () => {
  afterEach(() => vi.useRealTimers());
  const never = () => new Promise<number>(() => {});

  it('queues requests above the per-host concurrency instead of refusing them, never more than two at once', async () => {
    const l = new OutboundLimiter();
    let running = 0;
    let most = 0;
    const task = async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return 1;
    };
    const urls = [1, 2, 3, 4, 5].map((i) => `https://status.example/${i}`);
    expect(await Promise.all(urls.map((u) => l.run('a', u, task)))).toEqual([1, 1, 1, 1, 1]);
    expect(most).toBe(2);
  });

  it('refuses after the wait with the busy-host RetryLaterError', async () => {
    vi.useFakeTimers();
    const l = new OutboundLimiter({ perHostConcurrency: 1, maxWaitMs: 8000 });
    void l.run('a', 'https://h.example/1', never);
    const waiting = l.run('b', 'https://h.example/2', async () => 1);
    const refused = expect(waiting).rejects.toMatchObject({ status: 429, retryAfterSec: 10 });
    await vi.advanceTimersByTimeAsync(8001);
    await refused;
    await expect(waiting).rejects.toThrow(/already loading a lot from h\.example; it will try again shortly/);
  });

  it('refuses at once beyond the queue caps (per host, and per client on that host)', async () => {
    const l = new OutboundLimiter({ perHostConcurrency: 1, maxQueuePerHost: 2, maxQueuedPerClient: 1 });
    void l.run('a', 'https://h.example/0', never);
    void l.run('b', 'https://h.example/1', never).catch(() => {});
    await expect(l.run('b', 'https://h.example/2', never)).rejects.toMatchObject({ status: 429 }); // client cap
    void l.run('c', 'https://h.example/3', never).catch(() => {});
    await expect(l.run('d', 'https://h.example/4', never)).rejects.toMatchObject({ status: 429 }); // host cap
  });

  it('waits for a token when the minute budget is spent, then runs', async () => {
    vi.useFakeTimers();
    const l = new OutboundLimiter({ perHostConcurrency: 10, perHostPerMinute: 2, maxWaitMs: 60_000 });
    await l.run('a', 'https://h.example/1', async () => 1);
    await l.run('a', 'https://h.example/2', async () => 2);
    const third = l.run('a', 'https://h.example/3', async () => 3);
    await vi.advanceTimersByTimeAsync(30_000); // one token per 30 s at 2/min
    await expect(third).resolves.toBe(3);
  });

  it('refuses at once when asked not to wait', async () => {
    const l = new OutboundLimiter({ perHostConcurrency: 1 });
    void l.run('a', 'https://h.example/1', never);
    await expect(l.run('b', 'https://h.example/2', async () => 1, { wait: false })).rejects.toMatchObject({
      status: 429,
      retryAfterSec: 10,
    });
  });

  it('frees the host place when the task fails', async () => {
    const l = new OutboundLimiter({ perHostConcurrency: 1 });
    await expect(
      l.run('a', 'https://h.example/1', async () => Promise.reject(new Error('down'))),
    ).rejects.toThrow('down');
    await expect(l.run('a', 'https://h.example/2', async () => 2, { wait: false })).resolves.toBe(2);
  });
});
