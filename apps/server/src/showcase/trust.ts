import { createHash } from 'node:crypto';
import type { HttpMethod } from '@patchbay/core';

/** What a URL source sends upstream: the parts URL_SOURCES=signed-in compares with the showcase's own sources. */
export interface SourceRequest {
  url: string;
  method: HttpMethod;
  /** POST only; the schema refuses a body on a GET. */
  body?: unknown;
  /** Read from the response, never sent. It is part of the key so a copy cannot vary it to refetch the request. */
  path?: string;
}

/**
 * The key a source is trusted by: a SHA-256 of the JSON array [method, url, path, body as sent]. The body is the text
 * safeFetchJson sends (JSON.stringify), so a copy may repeat the showcase's query but never change it: key order, an
 * extra field or one character more is another request. The path counts although it is not sent: it is in the cache
 * key, so a copy that varied it would send the trusted request again for each value. A JSON array keeps the parts
 * apart whatever characters a URL or path holds. A leaf module, because services/dashboards.ts needs it and
 * showcase/load.ts already imports that service.
 */
export function sourceTrustKey(r: SourceRequest): string {
  const body = r.method === 'POST' && r.body !== undefined ? JSON.stringify(r.body) : null;
  return createHash('sha256')
    .update(JSON.stringify([r.method, r.url, r.path ?? null, body]))
    .digest('hex');
}
