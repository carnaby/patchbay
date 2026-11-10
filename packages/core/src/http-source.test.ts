import { describe, expect, it } from 'vitest';
import {
  applyOps,
  emptyDashboard,
  HTTP_METHODS,
  httpBodyIssue,
  LIMITS,
  parseDashboard,
  SourceSchema,
  stripSecretRefs,
} from './index.ts';

const GRAPHQL = 'https://api.github.com/graphql';
const QUERY = '{ viewer { login } }';
const parse = (extra: Record<string, unknown>) =>
  SourceSchema.safeParse({ kind: 'http', url: GRAPHQL, ...extra });
/** The issues of a parse as "path: message", empty when it passed. */
const issues = (extra: Record<string, unknown>) => {
  const r = parse(extra);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};
const nested = (levels: number) => {
  let v: unknown = 1;
  for (let i = 0; i < levels; i++) v = [v];
  return v;
};

describe('POST for http sources', () => {
  it('accepts method and body, POST without a body, and any JSON value as the body', () => {
    expect(HTTP_METHODS).toEqual(['GET', 'POST']);
    expect(issues({ method: 'POST', body: { query: QUERY } })).toEqual([]);
    expect(issues({ method: 'POST' })).toEqual([]);
    expect(issues({ method: 'GET' })).toEqual([]);
    for (const body of [[1, 2], 'plain text', 42, true, null, { variables: { n: 1 } }]) {
      expect(issues({ method: 'POST', body }), JSON.stringify(body)).toEqual([]);
    }
  });

  it('refuses a body without POST, and methods other than GET and POST', () => {
    const message = 'body: A body is sent only with method "POST": add method "POST" or remove the body';
    expect(issues({ body: { query: QUERY } })).toEqual([message]);
    expect(issues({ method: 'GET', body: { query: QUERY } })).toEqual([message]);
    expect(parse({ method: 'PUT' }).success).toBe(false);
    expect(parse({ method: 'post' }).success).toBe(false);
  });

  it('allows exactly 16,384 characters of JSON and refuses one more', () => {
    const at = { q: 'x'.repeat(LIMITS.httpBody - '{"q":""}'.length) };
    expect(JSON.stringify(at)).toHaveLength(16_384);
    expect(issues({ method: 'POST', body: at })).toEqual([]);
    expect(issues({ method: 'POST', body: { q: `${at.q}x` } })).toEqual([
      'body: The body is 16,385 characters as JSON; at most 16,384',
    ]);
  });

  it('allows 32 levels of nesting and refuses 33', () => {
    expect(LIMITS.httpBodyDepth).toBe(32);
    expect(issues({ method: 'POST', body: nested(32) })).toEqual([]);
    expect(issues({ method: 'POST', body: nested(33) })).toEqual([
      'body: The body nests deeper than 32 levels',
    ]);
  });

  it('refuses a string that holds JSON, the shape of an object sent as text', () => {
    const message =
      'body: The body is a string that looks like JSON; send the object or array itself, not text';
    expect(issues({ method: 'POST', body: '{"query":"{ viewer { login } }"}' })).toEqual([message]);
    expect(issues({ method: 'POST', body: ' [1, 2] ' })).toEqual([message]);
    expect(issues({ method: 'POST', body: '{ viewer { login } } is a query' })).toEqual([]);
  });

  it('says why a value cannot be sent at all', () => {
    expect(httpBodyIssue(undefined)).toBe('The body must be a JSON value');
    expect(httpBodyIssue(10n)).toBe('The body must be a JSON value');
    expect(httpBodyIssue({ query: QUERY })).toBeNull();
  });

  it('leaves documents without a method exactly as they were', () => {
    const doc = applyOps(emptyDashboard('t'), [
      {
        op: 'addDataset',
        dataset: {
          id: 'o',
          name: 'O',
          source: { kind: 'http', url: 'https://api.example.com/o', path: 'items' },
        },
      },
    ]).doc;
    expect(doc.datasets[0]!.source).toEqual({
      kind: 'http',
      url: 'https://api.example.com/o',
      path: 'items',
    });
    const text = JSON.stringify(doc);
    expect(JSON.stringify(parseDashboard(JSON.parse(text)))).toBe(text);
  });

  it('exports method and body with the document and strips only the secret references', () => {
    const doc = applyOps(emptyDashboard('GitHub'), [
      {
        op: 'addDataset',
        dataset: {
          id: 'me',
          name: 'Me',
          source: {
            kind: 'http',
            url: GRAPHQL,
            method: 'POST',
            body: { query: QUERY },
            path: 'data.viewer',
            secrets: ['sec_AAAAAAAAAAAAAAAA'],
          },
        },
      },
    ]).doc;
    const { doc: exported, datasetIds } = stripSecretRefs(doc);
    expect(datasetIds).toEqual(['me']);
    expect(exported.datasets[0]!.source).toEqual({
      kind: 'http',
      url: GRAPHQL,
      method: 'POST',
      body: { query: QUERY },
      path: 'data.viewer',
    });
  });
});
