/**
 * What the pipeline pool and the feed parser share about their worker threads: the memory each may take, and how a
 * worker is ended before the next one starts.
 *
 * A worker's isolate keeps its whole heap until its thread has exited. Starting the replacement as soon as
 * `terminate()` is called lets a dying worker and its successor hold their heaps at the same time, and a burst of
 * hostile jobs then stacks several heaps at their limit. Waiting for the exit keeps at most one heap per worker slot.
 *
 * The limits only hold while the process runs without `--max-old-space-size` (or its percentage form): V8 applies
 * that flag to every isolate, overriding each worker's own limit. Workers report their real limit when they start.
 */
import type { ResourceLimits } from 'node:worker_threads';

/**
 * Young generation of every worker. V8 sizes it from the old generation otherwise; a fixed value keeps the budget in
 * guide/deployment.md exact. Larger values did not make parsing measurably faster.
 */
export const WORKER_YOUNG_GENERATION_MB = 8;
/** Node's default, stated so the budget is complete: deep recursion fails as a RangeError inside the worker. */
export const WORKER_STACK_MB = 4;

export function workerResourceLimits(oldGenerationMb: number): ResourceLimits {
  return {
    maxOldGenerationSizeMb: oldGenerationMb,
    maxYoungGenerationSizeMb: WORKER_YOUNG_GENERATION_MB,
    stackSizeMb: WORKER_STACK_MB,
  };
}

const warned = new Set<string>();

/**
 * Says once per kind of worker when its heap limit is not the one asked for, which happens when the process was
 * started with a heap size flag. The memory budget is then wrong, silently.
 */
export function checkHeapLimit(label: string, oldGenerationMb: number, heapLimitMb: number | undefined) {
  // The reported limit includes the young generation and a little bookkeeping.
  if (heapLimitMb === undefined || heapLimitMb <= oldGenerationMb + 2 * WORKER_YOUNG_GENERATION_MB) return;
  if (warned.has(label)) return;
  warned.add(label);
  console.warn(
    `[${label}] worker heap limit is ${Math.round(heapLimitMb)} MB instead of ${oldGenerationMb} MB: a --max-old-space-size flag overrides it. Remove the flag, or the memory budget in guide/deployment.md does not hold.`,
  );
}

/** Heap a worker may keep after a job before it collects: below this, leftovers cost less than a full collection. */
const COLLECT_ABOVE_BYTES = 32 * 1024 * 1024;

/**
 * Called by a worker after each job. V8 collects when it needs room, not when a job ends, so a worker that just
 * parsed a large file would keep that heap until its next job; collecting now gives it back while other workers take
 * their turn. A no-op without `--expose-gc` (dev, tests), where collection is left to V8.
 */
export function collectAfterLargeJob(usedHeapBytes: number) {
  if (usedHeapBytes > COLLECT_ABOVE_BYTES) collectNow();
}

/** A full collection of this thread's heap; a no-op without `--expose-gc`. */
export function collectNow() {
  const gc = (globalThis as { gc?: unknown }).gc;
  if (typeof gc === 'function') (gc as () => void)();
}

/** The part of `Worker` the pool and the feed parser use, so tests can stand in a fake. */
export interface WorkerLike {
  postMessage(value: unknown, transferList?: readonly ArrayBuffer[]): void;
  /** 'message' (a reply), 'error' (Error with an optional `code`) and 'exit' (the exit code), as on `Worker`. */
  on(event: 'message' | 'error' | 'exit', listener: (...args: any[]) => void): unknown;
  terminate(): Promise<number>;
  unref(): void;
}

/**
 * Ends a worker and resolves once its thread has exited, which is when its heap is released. A thread stuck in
 * native code may never notice the termination; after `graceMs` the caller goes on anyway, because a pool that never
 * replaces its worker would refuse all work from then on.
 */
export function retire(worker: WorkerLike, graceMs: number, label: string): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn(
        `[${label}] a terminated worker did not exit within ${graceMs} ms; starting a new one anyway`,
      );
      resolve();
    }, graceMs);
    timer.unref();
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    worker.terminate().then(done, done);
  });
}

/**
 * A large string as bytes to transfer to a worker (`postMessage(…, [bytes.buffer])`) instead of cloning it. Cloning
 * serialises the string into a buffer that grows by doubling, and as UTF-16 when it holds a single character beyond
 * Latin-1: up to four times the file's size in flight. The encoded bytes are one copy of the file's UTF-8 size, and
 * transferring them copies nothing.
 */
export function workerBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Decodes `workerBytes` exactly: a leading byte order mark is kept, as in the original string. */
export function textFromWorkerBytes(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
}
