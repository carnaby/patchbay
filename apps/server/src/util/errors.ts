import { DocumentError, ExprError, OpError, TransformError } from '@patchbay/core';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';

export class HttpError extends Error {
  readonly status: ContentfulStatusCode;
  readonly details: unknown;
  constructor(status: ContentfulStatusCode, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/**
 * A refusal that passes: the client may repeat the request after `retryAfterSec`. The app's error handler turns it
 * into a Retry-After header, so every busy or rate-limited answer says when to come back the same way.
 */
export class RetryLaterError extends HttpError {
  readonly retryAfterSec: number;
  constructor(status: 429 | 503, message: string, retryAfterSec: number) {
    super(status, message);
    this.retryAfterSec = Math.max(1, Math.ceil(retryAfterSec));
  }
}

export const notFound = (what = 'Not found') => new HttpError(404, what);
export const forbidden = (why = 'Forbidden') => new HttpError(403, why);
export const unauthorized = (why = 'Sign in required') => new HttpError(401, why);
export const badRequest = (why: string, details?: unknown) => new HttpError(400, why, details);

/** Maps domain errors to an HTTP status and a message that is safe to show. */
export function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof DocumentError) return new HttpError(400, err.message, { issues: err.issues });
  if (err instanceof OpError || err instanceof TransformError || err instanceof ExprError) {
    return new HttpError(400, err.message);
  }
  if (err instanceof ZodError) {
    return new HttpError(
      400,
      err.issues
        .slice(0, 10)
        .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
        .join('; '),
    );
  }
  return new HttpError(500, 'Internal server error');
}
