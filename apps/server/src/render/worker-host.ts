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
import { BusyError } from '../util/gate.ts';
import { checkHeapLimit, retire, workerResourceLimits } from '../util/workers.ts';
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
export class RenderFailedError extends BusyError {
  /** Trying the same render again would fail the same way (time, memory), so the snapshot cache remembers it. */
  readonly lasting: boolean;
  constructor(message: string, options: { retryAfterSec?: number; lasting?: boolean } = {}) {
    super(message, options.retryAfterSec ?? 30);
    this.lasting = options.lasting ?? false;
  }
}

export interface RenderWorkerOptions {
  /** Hard limit per render, start-up excluded; the worker is terminated when it is exceeded. */
  timeoutMs?: number;
  /**
   * Old generation of the worker; young generation and stack follow the other workers (util/workers.ts). resvg's
   * pixmaps are native memory outside this limit, bounded by MAX_PIXELS instead.
   */
  oldGenerationMb?: number;
  /** The worker stops after this long without a render. */
  idleMs?: number;
  /** The worker is replaced after this many renders, so fragmentation in native memory cannot add up. */
  maxRenders?: number;
  /** Limit for loading the renderer in a new worker. */
  startTimeoutMs?: number;
  /** How long a terminated worker may take to exit before the next one starts anyway (see util/workers.ts). */
  retireGraceMs?: number;
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
  renders: number;
  current: Pending | null;
}

const WORKER_URL = new URL('./worker.ts', import.meta.url);

/**
 * The renderer's old generation, part of the memory budget in guide/deployment.md. The heaviest dashboard the drawing
 * budgets allow (60 charts of 10,000 points) peaks at about 85 MB; 128 MB left 30 MB that the 384 MB container
 * needed elsewhere.
 */
export const RENDER_WORKER_MEMORY_MB = 96;

export class RenderWorker {
  private readonly timeoutMs: number;
  private readonly oldGenerationMb: number;
  private readonly idleMs: number;
  private readonly maxRenders: number;
  private readonly startTimeoutMs: number;
  private readonly retireGraceMs: number;
  private readonly url: URL;
  private live: Live | null = null;
  /** Termination of the previous worker, awaited before a new one starts. */
  private stopping: Promise<void> = Promise.resolve();
  private tail: Promise<unknown> = Promise.resolve();
  private idle: NodeJS.Timeout | null = null;
  /** Renders asked for and not finished, waiting ones included. */
  private inFlight = 0;
  private nextId = 1;
  private started = 0;
  private closed = false;

  constructor(options: RenderWorkerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.oldGenerationMb = options.oldGenerationMb ?? RENDER_WORKER_MEMORY_MB;
    this.idleMs = options.idleMs ?? 60_000;
    this.maxRenders = options.maxRenders ?? 100;
    this.startTimeoutMs = options.startTimeoutMs ?? 30_000;
    this.retireGraceMs = options.retireGraceMs ?? 30_000;
    this.url = options.url ?? WORKER_URL;
  }

  /** Renders in the worker, one task after the other. */
  render(task: RenderTask): Promise<Buffer> {
    this.inFlight++;
    const turn = this.tail.then(() => this.run(task)).finally(() => this.inFlight--);
    this.tail = turn.catch(() => undefined);
    return turn;
  }

  /**
   * Stops the worker now if nothing is being drawn or waiting, instead of after `idleMs`: asked under memory pressure
   * (util/memory-pressure.ts). The next snapshot starts a fresh one.
   */
  releaseIdle() {
    if (!this.live || this.inFlight > 0 || this.live.current) return;
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.stop(this.live);
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
    this.stopping = Promise.all([previous, retire(live.worker, this.retireGraceMs, 'render')]).then(
      () => undefined,
    );
  }

  private async start(): Promise<Live> {
    await this.stopping;
    if (this.live) {
      await this.live.ready;
      return this.live;
    }
    const worker = new Worker(this.url, { resourceLimits: workerResourceLimits(this.oldGenerationMb) });
    worker.unref();
    this.started++;
    let ready!: () => void;
    let notReady!: (err: Error) => void;
    const live: Live = {
      worker,
      ready: new Promise<void>((res, rej) => {
        ready = res;
        notReady = rej;
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
      (msg: {
        ready?: true;
        heapLimitMb?: number;
        id?: number;
        ok?: boolean;
        png?: Uint8Array;
        message?: string;
      }) => {
        if (msg.ready) {
          clearTimeout(startTimer);
          checkHeapLimit('render', this.oldGenerationMb, msg.heapLimitMb);
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
      const reason = new RenderFailedError('The snapshot renderer stopped', { retryAfterSec: 5 });
      notReady(reason);
      live.current?.reject(reason);
      if (this.live === live) this.live = null;
    });
    await live.ready;
    return live;
  }
}
