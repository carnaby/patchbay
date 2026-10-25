/** Thin fetch wrapper for the Patchbay API. */
import { getEditKey } from './edit-keys.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(status: number, message: string, body: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

interface Options {
  method?: string;
  body?: unknown;
  /** Dashboard whose locally stored edit key should be sent (anonymous dashboards). */
  dashboardId?: string;
  signal?: AbortSignal;
}

export async function api<T>(path: string, options: Options = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const key = options.dashboardId ? getEditKey(options.dashboardId) : undefined;
  if (key) headers['x-edit-key'] = key;
  const init: RequestInit = {
    method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
    headers,
    credentials: 'same-origin',
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  if (options.signal) init.signal = options.signal;
  const res = await fetch(path, init);
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { error: text };
  }
  if (!res.ok) {
    const body = (json ?? {}) as Record<string, unknown>;
    throw new ApiError(res.status, String(body.error ?? res.statusText), body);
  }
  return json as T;
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');
