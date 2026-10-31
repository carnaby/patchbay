/**
 * Retries a request the server turned away for now. Under load the server answers 503 (busy, low on memory) or 429
 * (rate limited) with Retry-After rather than failing; a save that gave up there would lose the user's edit, or show
 * an error for something that fixes itself seconds later. Every other error is final and thrown at once: a 4xx
 * means the request itself is wrong, and sending it again would be refused again.
 */
import { ApiError } from './api.ts';

/** Statuses that mean "not now" rather than "no". */
export const RETRYABLE_STATUSES: readonly number[] = [429, 503];
/** No wait is shorter than this, whatever Retry-After says. */
export const MIN_RETRY_DELAY_MS = 1000;
/** No wait is longer than this, whatever Retry-After says. */
export const MAX_RETRY_DELAY_MS = 30_000;
/** Without Retry-After: 2 s, 4 s, 8 s, ... up to MAX_RETRY_DELAY_MS. */
export const FIRST_RETRY_DELAY_MS = 2000;
/** Retrying stops once the next attempt would start later than this after the first one. */
export const RETRY_FOR_MS = 90_000;

export function isRetryable(error: unknown): error is ApiError {
  return error instanceof ApiError && RETRYABLE_STATUSES.includes(error.status);
}

/** How long to wait before attempt `attempt + 1` (the first retry is attempt 1). */
export function retryDelayMs(error: ApiError, attempt: number): number {
  // At least a second: "Retry-After: 0" from a busy server must not turn into a burst of immediate retries.
  if (error.retryAfterSec !== null)
    return Math.min(Math.max(error.retryAfterSec * 1000, MIN_RETRY_DELAY_MS), MAX_RETRY_DELAY_MS);
  return Math.min(FIRST_RETRY_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
}

export interface RetryOptions {
  /** Called before each wait, e.g. to say what is going on; the attempt that failed is `attempt`. */
  onRetry?: (error: ApiError, delayMs: number, attempt: number) => void;
  /** Total time to keep trying, from the first attempt (default RETRY_FOR_MS). */
  retryForMs?: number;
  /** Tests: the clock and the wait. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs `task`, and again after a wait while it fails with a retryable status, for at most `retryForMs`. */
export async function withRetry<T>(task: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? wait;
  const retryFor = options.retryForMs ?? RETRY_FOR_MS;
  const started = now();
  for (let attempt = 1; ; attempt++) {
    try {
      return await task();
    } catch (e) {
      if (!isRetryable(e)) throw e;
      const delay = retryDelayMs(e, attempt);
      if (now() + delay - started > retryFor) throw e;
      options.onRetry?.(e, delay, attempt);
      await sleep(delay);
    }
  }
}
