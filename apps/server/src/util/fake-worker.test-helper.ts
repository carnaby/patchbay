/**
 * A stand-in for a worker thread whose exit the test controls: `terminate()` resolves only when the test calls
 * `exit()`, so a test can see what its owner does while a worker is still shutting down.
 */
import { EventEmitter } from 'node:events';
import type { WorkerLike } from './workers.ts';

export class FakeWorker extends EventEmitter implements WorkerLike {
  readonly posted: { value: unknown; transfer: readonly ArrayBuffer[] | undefined }[] = [];
  terminated = false;
  private exited: ((code: number) => void) | null = null;
  private readonly stopped: Promise<number>;

  constructor(ready = true) {
    super();
    this.stopped = new Promise((resolve) => {
      this.exited = resolve;
    });
    if (ready) queueMicrotask(() => this.emit('message', { ready: true }));
  }

  postMessage(value: unknown, transfer?: readonly ArrayBuffer[]) {
    this.posted.push({ value, transfer });
  }

  terminate() {
    this.terminated = true;
    return this.stopped;
  }

  /** The thread has ended: its heap is gone. */
  exit(code = 1) {
    this.exited?.(code);
    this.emit('exit', code);
  }

  unref() {}

  /** Fails like a worker that ran out of its heap. */
  outOfMemory() {
    this.emit(
      'error',
      Object.assign(new Error('Worker terminated due to reaching memory limit'), {
        code: 'ERR_WORKER_OUT_OF_MEMORY',
      }),
    );
  }
}

/** Lets pending promise callbacks and microtasks run. */
export const settle = () => new Promise((resolve) => setImmediate(resolve));
