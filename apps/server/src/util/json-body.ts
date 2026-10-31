/**
 * Request bodies are parsed with `JSON.parse` on the main thread, before any permission check: a stranger's 7 MB of
 * `[[[[…` to the upload route took the whole container down without a dashboard of its own. Every body is measured
 * first (util/json-shape.ts) and refused with 400 when it nests too deeply or holds too many values.
 *
 * Hono caches the text read here, so the route's `c.req.json()` parses that same string: no second copy.
 *
 * Large bodies (uploads, MCP uploads) are also admitted only a few at a time (`newLargeBodyGate`).
 */
import type { Context, MiddlewareHandler } from 'hono';
import { Gate } from './gate.ts';
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
 * Requests with large bodies admitted at the same time. Each one holds its body as bytes, as text and as parsed
 * values until it is answered, two to three times its size; ten 7 MB requests at once took 120 MB of the main
 * thread's memory. Waiting requests have not been read yet, so they cost only their socket. One at a time: uploads are
 * parsed and saved one at a time anyway (DashboardService), and the main thread's share of the memory budget
 * (guide/deployment.md) has room for one large body next to its caches, not two.
 */
export const newLargeBodyGate = () =>
  new Gate({ concurrency: 1, maxQueue: 8, maxQueuedPerClient: 2, maxWaitMs: 15_000, retryAfterSec: 5 });
