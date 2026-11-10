/**
 * The POST body field of the http source form: the text the user edits and the value the source holds. Kept out of the
 * component so its rules are tested without a browser; the limits are the schema's own (`httpBodyIssue`), so the
 * field refuses exactly what a save would.
 */
import { type HttpMethod, httpBodyIssue, type Source } from '@patchbay/core';

type HttpSource = Extract<Source, { kind: 'http' }>;

/** The field's text for a saved body: pretty-printed, empty when there is none. */
export function bodyText(body: unknown): string {
  return body === undefined ? '' : JSON.stringify(body, null, 2);
}

export type ParsedBody = { ok: true; body: unknown } | { ok: false; error: string };

/** Empty text means no body (a POST without one); anything else must be JSON within the schema's limits. */
export function parseBodyText(text: string): ParsedBody {
  if (text.trim() === '') return { ok: true, body: undefined };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const issue = httpBodyIssue(body);
  return issue ? { ok: false, error: issue } : { ok: true, body };
}

/** The source with this method. GET drops method and body, so a GET source is saved exactly as before POST existed. */
export function withMethod(source: HttpSource, method: HttpMethod): HttpSource {
  const { method: _method, body: _body, ...rest } = source;
  if (method === 'GET') return rest;
  return source.method === 'POST' ? source : { ...rest, method: 'POST' };
}

/** The form after a method switch: the source to keep in the draft, the body field's text and its error. */
export interface MethodSwitch {
  source: HttpSource;
  text: string;
  error: string | null;
}

/**
 * Switches the form's method. The typed text survives GET, so one stray click within an edit does not lose a query:
 * the GET source holds no body (it is saved exactly as before POST existed) and the text, which it never sends, cannot
 * block a save. Back on POST the text becomes the body again, or shows its error as it did before.
 */
export function switchMethod(source: HttpSource, method: HttpMethod, text: string): MethodSwitch {
  if (method === 'GET') return { source: withMethod(source, 'GET'), text, error: null };
  const post = withMethod(source, 'POST');
  const parsed = parseBodyText(text);
  return parsed.ok
    ? { source: withBody(post, parsed.body), text, error: null }
    : { source: post, text, error: parsed.error };
}

/** The source with this body; undefined removes it. */
export function withBody(source: HttpSource, body: unknown): HttpSource {
  const { body: _body, ...rest } = source;
  return body === undefined ? rest : { ...rest, body };
}
