import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, parseRetryAfter } from './api.ts';
import { RETRY_FOR_MS, retryDelayMs, withRetry } from './retry.ts';

const busy = (status = 503, retryAfterSec: number | null = null) =>
  new ApiError(status, 'The server is busy; try again in a few seconds', {}, retryAfterSec);

/** A task that fails with the given errors in turn, then answers "saved"; records when each attempt started. */
function scripted(errors: Error[]) {
  const started: number[] = [];
  const task = vi.fn(async () => {
    started.push(Date.now());
    const next = errors.shift();
    if (next) throw next;
    return 'saved';
  });
  return { task, started };
}

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  it('waits out 503 and 429 for as long as Retry-After says, then returns the answer', async () => {
    const { task, started } = scripted([busy(503, 5), busy(429, 3)]);
    const result = withRetry(task);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(result).resolves.toBe('saved');
    expect(started).toEqual([0, 5000, 8000]);
  });

  it('backs off 2 s, 4 s, 8 s ... up to 30 s without Retry-After', async () => {
    const { task, started } = scripted([busy(), busy(), busy(), busy(), busy(), busy()]);
    const result = withRetry(task);
    await vi.advanceTimersByTimeAsync(RETRY_FOR_MS);
    await expect(result).resolves.toBe('saved');
    const waits = started.slice(1).map((t, i) => t - started[i]!);
    expect(waits).toEqual([2000, 4000, 8000, 16_000, 30_000, 30_000]);
  });

  it('keeps every wait between 1 s and 30 s whatever Retry-After says', () => {
    expect(retryDelayMs(busy(503, 0), 1)).toBe(1000);
    expect(retryDelayMs(busy(503, 3600), 1)).toBe(30_000);
    expect(retryDelayMs(busy(503, null), 10)).toBe(30_000);
  });

  it('does not retry anything else: validation errors, conflicts, server errors, network failures', async () => {
    for (const error of [
      new ApiError(400, 'Invalid', {}),
      new ApiError(409, 'Conflict', {}),
      new ApiError(428, 'Confirm', {}),
      new ApiError(500, 'Broken', {}),
      new TypeError('Failed to fetch'),
    ]) {
      const { task } = scripted([error]);
      await expect(withRetry(task)).rejects.toBe(error);
      expect(task).toHaveBeenCalledTimes(1);
    }
  });

  it('gives up with the last busy answer once the next attempt would start after about 90 s', async () => {
    const errors = Array.from({ length: 50 }, () => busy(503, 20));
    const { task, started } = scripted(errors);
    const onRetry = vi.fn();
    const result = withRetry(task, { onRetry });
    const settled = expect(result).rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await settled;
    // Attempts at 0, 20, 40, 60 and 80 s; the next would start at 100 s.
    expect(started).toEqual([0, 20_000, 40_000, 60_000, 80_000]);
    expect(onRetry).toHaveBeenCalledTimes(4);
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates, and nothing else', () => {
    expect(parseRetryAfter('5')).toBe(5);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
    const now = Date.parse('2026-10-31T12:00:00Z');
    expect(parseRetryAfter('Sat, 31 Oct 2026 12:00:10 GMT', now)).toBe(10);
    expect(parseRetryAfter('Sat, 31 Oct 2026 11:00:00 GMT', now)).toBe(0);
  });
});
