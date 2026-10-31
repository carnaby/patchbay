/**
 * Request bodies are parsed with `JSON.parse` on the main thread, before any permission check: a stranger's 7 MB of
 * `[[[[…` to the upload route took the whole container down without a dashboard of its own. Every body is measured
 * first (util/json-shape.ts) and refused with 400 when it nests too deeply or holds too many values.
 *
 * Hono caches the text read here, so the route's `c.req.json()` parses that same string: no second copy.
 *
 * Large bodies (uploads, MCP uploads) are received in full at a minimum pace first (`LargeBodyReceiver`), then
 * processed one at a time (`newLargeBodyGate`).
 */
import type { Context, MiddlewareHandler } from 'hono';
import { HttpError } from './errors.ts';
import { BusyError, Gate } from './gate.ts';
import { type JsonShapeProblem, jsonShapeProblem, MAX_JSON_DEPTH } from './json-shape.ts';

/** Far above any request the API takes (a 1 MB dashboard, an upload is a few values around one string). */
export const MAX_BODY_JSON_VALUES = 500_000;

const LIMITS = { maxDepth: MAX_JSON_DEPTH, maxValues: MAX_BODY_JSON_VALUES };

/** Whether a request may carry a body that a route parses as JSON (Hono's `json()` ignores the content type). */
function mayCarryJson(request: Request): boolean {
  if (!request.body || request.method === 'GET' || request.method === 'HEAD') return false;
  return !/^\s*(application\/x-www-form-urlencoded|multipart\/form-data)/i.test(
    request.headers.get('content-type') ?? '',
  );
}

export function bodyShapeMessage(problem: NonNullable<JsonShapeProblem>): string {
  return problem.kind === 'depth'
    ? `The request body nests deeper than ${problem.limit} levels`
    : `The request body holds more than ${problem.limit.toLocaleString('en-US')} values`;
}

/** The request's body text after checking its shape, or a problem; null when the request has no JSON body. */
export async function checkedBody(c: Context): Promise<{ text: string } | { problem: string } | null> {
  if (!mayCarryJson(c.req.raw)) return null;
  const text = await c.req.text();
  const problem = jsonShapeProblem(text, LIMITS);
  return problem ? { problem: bodyShapeMessage(problem) } : { text };
}

/** For routes that read bodies through Hono. /mcp hands the raw request to the MCP SDK and checks it itself. */
export const jsonBodyGuard: MiddlewareHandler = async (c, next) => {
  const checked = await checkedBody(c);
  if (checked && 'problem' in checked) return c.json({ error: checked.problem }, 400);
  await next();
};

/** Bodies above this (or of unknown length) count as large. Everything but uploads and MCP is capped at 1 MB. */
export const LARGE_BODY_BYTES = 1024 * 1024;

/**
 * Whether a request will bring a large body into memory. Decided from the headers alone: on Node, touching
 * `request.body` creates the body stream, which starts pulling from the socket.
 */
export function isLargeBody(request: Request): boolean {
  if (request.method === 'GET' || request.method === 'HEAD') return false;
  const length = request.headers.get('content-length');
  if (length === null) return request.headers.has('transfer-encoding');
  return Number(length) > LARGE_BODY_BYTES;
}

/**
 * Requests with large bodies processed at the same time. Each one holds its body as bytes, as text and as parsed
 * values until it is answered, two to three times its size; ten 7 MB requests at once took 120 MB of the main
 * thread's memory. One at a time: uploads are parsed and saved one at a time anyway (DashboardService), and the main
 * thread's share of the memory budget (guide/deployment.md) has room for one large body next to its caches, not two.
 * A body is received in full (`LargeBodyReceiver`) before it queues here, so the turn is never held by a slow sender.
 */
export const newLargeBodyGate = () =>
  new Gate({ concurrency: 1, maxQueue: 8, maxQueuedPerClient: 2, maxWaitMs: 15_000, retryAfterSec: 5 });

/** A large body that arrived too slowly; answered with 408 and the connection closed. */
export class BodyTimeoutError extends HttpError {
  constructor() {
    super(408, 'The request body arrived too slowly; try again on a faster connection');
  }
}

export class BodyTooLargeError extends HttpError {
  constructor() {
    super(413, 'Request body too large');
  }
}

export interface ReceiveOptions {
  /** Bytes of large bodies held at once, received or arriving, until they are handed to their route. */
  maxHeldBytes?: number;
  /** Large bodies one client may be sending, or have waiting for their turn, at the same time. */
  maxPerClient?: number;
  /** A body's pace is checked only after this: the first moments of a connection are often its slowest. */
  graceMs?: number;
  /** Slower than this on average after the grace, a body is refused with 408. */
  minBytesPerSec?: number;
  /** A body still arriving after this is refused with 408, whatever its pace. */
  maxMs?: number;
  /** How often the pace is checked. */
  checkMs?: number;
  now?: () => number;
}

const RECEIVE_DEFAULTS = {
  maxHeldBytes: 16 * 1024 * 1024,
  maxPerClient: 2,
  graceMs: 5000,
  minBytesPerSec: 32 * 1024,
  maxMs: 60_000,
  checkMs: 1000,
};

/** A received body: its bytes as they arrived, and the call that stops counting them. */
export interface ReceivedBody {
  chunks: Uint8Array[];
  bytes: number;
  release: () => void;
}

/**
 * Reads large request bodies in full before they take their turn (`newLargeBodyGate`).
 *
 * Reading a body inside the turn let one client hold it for everyone: a 3 MB body sent at 2 KB/s kept every other
 * upload waiting until Node's request timeout, and two such clients reconnecting blocked uploads for good. Here a
 * sender is held to a pace instead (`minBytesPerSec` after `graceMs`, all of it within `maxMs`), and a slow one costs
 * only the few bytes it managed to send. What arrived is bounded in bytes across the server (`maxHeldBytes`), so
 * bodies that are fast and many get 503 instead of filling the memory the turn was there to protect.
 */
export class LargeBodyReceiver {
  private readonly options: Required<ReceiveOptions>;
  private held = 0;
  private readonly perClient = new Map<string, number>();

  constructor(options: ReceiveOptions = {}) {
    this.options = { ...RECEIVE_DEFAULTS, now: () => performance.now(), ...options };
  }

  /** Bytes held and bodies in progress (diagnostics and tests). */
  stats() {
    return { bytes: this.held, bodies: [...this.perClient.values()].reduce((a, b) => a + b, 0) };
  }

  /**
   * The whole body of `request`, at most `maxBytes`. Throws BodyTooLargeError, BodyTimeoutError, or BusyError when
   * the client already sends its share or the server holds too many bytes of bodies. The bytes count until
   * `release`, which the caller calls once the body is handed on, or at the latest when the request is answered.
   */
  async receive(request: Request, client: string, maxBytes: number): Promise<ReceivedBody> {
    const { maxPerClient, maxHeldBytes, graceMs, minBytesPerSec, maxMs, checkMs, now } = this.options;
    const mine = this.perClient.get(client) ?? 0;
    if (mine >= maxPerClient) throw new BusyError(undefined, 5);
    this.perClient.set(client, mine + 1);
    let bytes = 0;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.held -= bytes;
      const left = (this.perClient.get(client) ?? 1) - 1;
      if (left > 0) this.perClient.set(client, left);
      else this.perClient.delete(client);
    };
    const chunks: Uint8Array[] = [];
    if (!request.body) return { chunks, bytes, release };
    // Not cancelled on a refusal: cancelling destroys the socket before the answer is sent. The server drains and
    // closes the connection once it has answered (@hono/node-server, and `Connection: close`).
    const reader = request.body.getReader();
    const start = now();
    let timer: NodeJS.Timeout | undefined;
    const tooSlow = new Promise<never>((_, reject) => {
      timer = setInterval(() => {
        const elapsed = now() - start;
        if (elapsed > maxMs || (elapsed > graceMs && bytes / (elapsed / 1000) < minBytesPerSec))
          reject(new BodyTimeoutError());
      }, checkMs);
    });
    tooSlow.catch(() => {});
    try {
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), tooSlow]);
        if (done) break;
        if (bytes + value.byteLength > maxBytes) throw new BodyTooLargeError();
        if (this.held + value.byteLength > maxHeldBytes) throw new BusyError(undefined, 5);
        bytes += value.byteLength;
        this.held += value.byteLength;
        chunks.push(value);
      }
    } catch (e) {
      release();
      throw e;
    } finally {
      clearInterval(timer);
    }
    return { chunks, bytes, release };
  }
}

/** `request` with a body read earlier; the chunks are handed on as they are, without a copy. */
export function withReceivedBody(request: Request, chunks: Uint8Array[]): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Request(request, { body, duplex: 'half' } as RequestInit);
}
