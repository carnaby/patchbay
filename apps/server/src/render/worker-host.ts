/**
 * Runs snapshot rendering in a worker thread.
 *
 * Building the SVG and rasterising it is synchronous work of up to seconds; on the main thread it stalled every other
 * request, the health check included, until Docker marked the container unhealthy. In a worker the main thread only
 * copies the resolved tables over and gets a PNG back.
 *
 * The worker has its own heap limits and a hard time limit per render. A render that exceeds either has its worker
 * terminated, the only reliable way to stop a runaway computation in JavaScript, and the next render starts a fresh
 * one once the old one is gone: two renderers alive at once could take the memory one was meant to bound. The worker
 * starts on the first snapshot and stops after a while without one, so a server nobody asks for images keeps none
 * of the renderer's memory (ECharts, the world map, fonts, resvg's leftovers).
 *
 * One render at a time: `snapshotGate` (render/gate.ts) queues and admits them.
 */
import { Worker } from 'node:worker_threads';
import type { ColorMap, DashboardDoc, DatasetResult, ThemeMode, Widget } from '@patchbay/core';
import { HttpError } from '../util/errors.ts';
import type { DashboardRenderOptions } from './snapshot.ts';

export type RenderTask =
  | {
      kind: 'widget';
      widget: Widget;
      result: DatasetResult | undefined;
      options: { theme?: ThemeMode; entityColors?: ColorMap | undefined };
    }
  | {
      kind: 'dashboard';
      doc: DashboardDoc;
      results: Map<string, DatasetResult>;
      options: DashboardRenderOptions;
    };

/** A render the worker could not finish: it ran out of time or memory, or the worker died. */
export class RenderFailedError extends HttpError {
  readonly retryAfterSec: number;
  /** Trying the same render again would fail the same way (time, memory), so the snapshot cache remembers it. */
  readonly lasting: boolean;
  constructor(message: string, options: { retryAfterSec?: number; lasting?: boolean } = {}) {
    super(503, message);
    this.retryAfterSec = options.retryAfterSec ?? 30;
    this.lasting = options.lasting ?? false;
  }
}

export interface RenderWorkerOptions {
  /** Hard limit per render, start-up excluded; the worker is terminated when it is exceeded. */
  timeoutMs?: number;
  /** Heap limits of the worker. resvg's pixmaps are native memory outside them, bounded by MAX_PIXELS instead. */
  oldGenerationMb?: number;
  youngGenerationMb?: number;
  /** The worker stops after this long without a render. */
  idleMs?: number;
  /** The worker is replaced after this many renders, so fragmentation in native memory cannot add up. */
  maxRenders?: number;
  /** Limit for loading the renderer in a new worker. */
  startTimeoutMs?: number;
  /** Tests point this at a worker that misbehaves. */
  url?: URL;
}

interface Pending {
  id: number;
  resolve: (png: Buffer) => void;
  reject: (err: Error) => void;
}

interface Live {
  worker: Worker;
  ready: Promise<void>;
  exited: Promise<void>;
  renders: number;
  current: Pending | null;
}

const WORKER_URL = new URL('./worker.ts', import.meta.url);

export class RenderWorker {
  private readonly timeoutMs: number;
  private readonly oldGenerationMb: number;
  private readonly youngGenerationMb: number;
  private readonly idleMs: number;
  private readonly maxRenders: number;
  private readonly startTimeoutMs: number;
  private readonly url: URL;
  private live: Live | null = null;
  /** Termination of the previous worker, awaited before a new one starts. */
  private stopping: Promise<void> = Promise.resolve();
  private tail: Promise<unknown> = Promise.resolve();
  private idle: NodeJS.Timeout | null = null;
  private nextId = 1;
  private started = 0;
  private closed = false;

  constructor(options: RenderWorkerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.oldGenerationMb = options.oldGenerationMb ?? 128;
    this.youngGenerationMb = options.youngGenerationMb ?? 16;
    this.idleMs = options.idleMs ?? 60_000;
    this.maxRenders = options.maxRenders ?? 100;
    this.startTimeoutMs = options.startTimeoutMs ?? 30_000;
    this.url = options.url ?? WORKER_URL;
  }

  /** Renders in the worker, one task after the other. */
  render(task: RenderTask): Promise<Buffer> {
    const turn = this.tail.then(() => this.run(task));
    this.tail = turn.catch(() => undefined);
    return turn;
  }

  /** Workers started so far (tests and diagnostics). */
  starts(): number {
    return this.started;
  }

  /** Whether a worker is alive right now (tests and diagnostics). */
  running(): boolean {
    return this.live !== null;
  }

  async close() {
    this.closed = true;
    if (this.idle) clearTimeout(this.idle);
    if (this.live) this.stop(this.live);
    await this.stopping;
  }

  private async run(task: RenderTask): Promise<Buffer> {
    if (this.closed) throw new RenderFailedError('The server is shutting down', { retryAfterSec: 5 });
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const live = await this.start();
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(() => {
          live.current?.reject(
            new RenderFailedError(
              `This snapshot took longer than ${this.timeoutMs / 1000} s to draw and was stopped; draw fewer or smaller charts`,
              { lasting: true },
            ),
          );
          this.stop(live);
        }, this.timeoutMs);
        const settle =
          <A>(fn: (arg: A) => void) =>
          (arg: A) => {
            clearTimeout(timer);
            live.current = null;
            fn(arg);
          };
        const job: Pending = { id: this.nextId++, resolve: settle(resolve), reject: settle(reject) };
        live.current = job;
        try {
          // Structured clone, on this thread: the tables are bounded by the upload and response cell limits.
          live.worker.postMessage({ id: job.id, task });
        } catch (e) {
          job.reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    } finally {
      live.renders++;
      if (this.live === live && live.renders >= this.maxRenders) this.stop(live);
      else if (this.live === live) this.armIdle(live);
    }
  }

  private armIdle(live: Live) {
    this.idle = setTimeout(() => {
      if (this.live === live && !live.current) this.stop(live);
    }, this.idleMs);
    this.idle.unref();
  }

  /** Terminates a worker; the next render waits for it to be gone before it starts another. */
  private stop(live: Live) {
    if (this.live === live) this.live = null;
    const previous = this.stopping;
    this.stopping = Promise.all([previous, live.worker.terminate().then(() => live.exited)]).then(
      () => undefined,
    );
  }

  private async start(): Promise<Live> {
    await this.stopping;
    if (this.live) {
      await this.live.ready;
      return this.live;
    }
    const worker = new Worker(this.url, {
      resourceLimits: {
        maxOldGenerationSizeMb: this.oldGenerationMb,
        maxYoungGenerationSizeMb: this.youngGenerationMb,
      },
    });
    worker.unref();
    this.started++;
    let ready!: () => void;
    let notReady!: (err: Error) => void;
    let exited!: () => void;
    const live: Live = {
      worker,
      ready: new Promise<void>((res, rej) => {
        ready = res;
        notReady = rej;
      }),
      exited: new Promise<void>((res) => {
        exited = res;
      }),
      renders: 0,
      current: null,
    };
    // Nobody may be waiting for readiness when the worker dies later; that must not be an unhandled rejection.
    live.ready.catch(() => undefined);
    this.live = live;
    const startTimer = setTimeout(() => {
      notReady(new RenderFailedError('The snapshot renderer did not start in time'));
      this.stop(live);
    }, this.startTimeoutMs);
    startTimer.unref();

    worker.on(
      'message',
      (msg: { ready?: true; id?: number; ok?: boolean; png?: Uint8Array; message?: string }) => {
        if (msg.ready) {
          clearTimeout(startTimer);
          ready();
          return;
        }
        const job = live.current;
        if (!job || job.id !== msg.id) return;
        if (msg.ok && msg.png)
          job.resolve(Buffer.from(msg.png.buffer, msg.png.byteOffset, msg.png.byteLength));
        // The renderer threw: a bug or data it cannot draw. Not the worker's fault, so it stays.
        else job.reject(new Error(msg.message ?? 'Rendering failed'));
      },
    );
    worker.on('error', (err: Error & { code?: string }) => {
      const reason =
        err.code === 'ERR_WORKER_OUT_OF_MEMORY'
          ? new RenderFailedError(
              'This snapshot needed more memory than the server allows; draw fewer or smaller charts',
              { lasting: true },
            )
          : new RenderFailedError(`The snapshot renderer crashed: ${err.message}`);
      clearTimeout(startTimer);
      notReady(reason);
      live.current?.reject(reason);
      this.stop(live);
    });
    worker.on('exit', () => {
      clearTimeout(startTimer);
      exited();
      const reason = new RenderFailedError('The snapshot renderer stopped', { retryAfterSec: 5 });
      notReady(reason);
      live.current?.reject(reason);
      if (this.live === live) this.live = null;
    });
    await live.ready;
    return live;
  }
}
