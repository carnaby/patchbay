/**
 * Checks that work grows linearly with its input without a millisecond budget: a slow or busy machine slows both
 * sizes alike, so the ratio between them stays put while an absolute bound would not. Quadratic work on 4x the input
 * costs about 16x; the bound is 10x plus a small floor, because allocation-heavy linear work on a shared CI runner
 * (garbage collection, cache misses) has been seen near 8x. `ceilingMs` is only a safety net for a regression so bad
 * that even the ratio hides it (the small size is already slow).
 */
export interface ScalingOptions {
  /** The large size; the small one is a quarter of it. */
  size: number;
  /** Measurements per size, interleaved; the fastest one counts, since noise only ever adds time. */
  repeat?: number;
  ceilingMs?: number;
}

/** Time of one call, in milliseconds; a refusal (thrown by `fn`) still counts as finished work. */
function time(fn: () => unknown, refusal: (e: unknown) => boolean): number {
  const started = performance.now();
  try {
    fn();
  } catch (e) {
    if (!refusal(e)) throw e;
  }
  return performance.now() - started;
}

/**
 * `make(n)` builds the input of size `n` outside the measurement and returns the work to time.
 * Returns the measured times so a failure message can show them.
 */
export function measureScaling(
  make: (n: number) => () => unknown,
  { size, repeat = 5 }: ScalingOptions,
  refusal: (e: unknown) => boolean = () => false,
) {
  const small = make(Math.floor(size / 4));
  const large = make(size);
  // Warm-up: compiles the code under test at both sizes before anything is measured.
  time(small, refusal);
  time(large, refusal);
  // Interleaved, so a slow stretch of the machine (another job, a GC) hits both sizes instead of only one.
  let smallMs = Number.POSITIVE_INFINITY;
  let largeMs = Number.POSITIVE_INFINITY;
  for (let i = 0; i < repeat; i++) {
    smallMs = Math.min(smallMs, time(small, refusal));
    largeMs = Math.min(largeMs, time(large, refusal));
  }
  return { smallMs, largeMs };
}

export function scalingProblem(
  times: { smallMs: number; largeMs: number },
  { ceilingMs = 5000 }: Pick<ScalingOptions, 'ceilingMs'> = {},
): string | null {
  const { smallMs, largeMs } = times;
  const shown = `${smallMs.toFixed(1)} ms at 1/4 size, ${largeMs.toFixed(1)} ms at full size`;
  if (largeMs > ceilingMs) return `took too long: ${shown}`;
  if (largeMs > smallMs * 10 + 50) return `grows faster than linearly: ${shown}`;
  return null;
}
