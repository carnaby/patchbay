import { createHash } from 'node:crypto';
import type { HttpMethod } from '@patchbay/core';

/** What a URL source sends upstream: the parts URL_SOURCES=signed-in compares with the showcase's own sources. */
export interface SourceRequest {
  url: string;
  method: HttpMethod;
  /** POST only; the schema refuses a body on a GET. */
  body?: unknown;
}

/**
 * The key a source is trusted by. A GET (and a feed) is its URL, exactly. A POST adds a SHA-256 of its body as sent
 * (JSON.stringify, the text safeFetchJson sends), so a copy may repeat the showcase's query but never change it: key
 * order, an extra field or one character more is another request. A leaf module, because services/dashboards.ts
 * needs it and showcase/load.ts already imports that service.
 */
export function sourceTrustKey(r: SourceRequest): string {
  if (r.method === 'GET') return `GET ${r.url}`;
  const body = r.body === undefined ? '' : JSON.stringify(r.body);
  return `POST ${createHash('sha256').update(body).digest('hex')} ${r.url}`;
}
