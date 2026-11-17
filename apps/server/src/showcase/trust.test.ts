import { describe, expect, it } from 'vitest';
import { sourceTrustKey } from './trust.ts';

const URL = 'https://gitlab.example/api/graphql';
const QUERY = { query: '{ project(fullPath: "a/b") { name } }' };

describe('sourceTrustKey', () => {
  it('keys a GET by its exact URL', () => {
    expect(sourceTrustKey({ url: URL, method: 'GET' })).toMatch(/^[0-9a-f]{64}$/);
    expect(sourceTrustKey({ url: `${URL}/`, method: 'GET' })).not.toBe(
      sourceTrustKey({ url: URL, method: 'GET' }),
    );
  });

  it('keys a POST by its URL and the JSON text of its body, never like a GET', () => {
    const post = sourceTrustKey({ url: URL, method: 'POST', body: QUERY });
    expect(post).not.toBe(sourceTrustKey({ url: URL, method: 'GET' }));
    expect(post).toBe(sourceTrustKey({ url: URL, method: 'POST', body: JSON.parse(JSON.stringify(QUERY)) }));
  });

  it('tells apart bodies that differ in any byte of what is sent', () => {
    const key = (body: unknown) => sourceTrustKey({ url: URL, method: 'POST', body });
    const keys = [
      key(QUERY),
      key({ query: `${QUERY.query} ` }),
      key({ ...QUERY, variables: {} }),
      key({ a: 1, b: 2 }),
      key({ b: 2, a: 1 }),
      key(undefined),
      key(''),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('tells apart paths, on a GET and on a POST, and a missing path from an empty one', () => {
    for (const request of [
      { url: URL, method: 'GET' as const },
      { url: URL, method: 'POST' as const, body: QUERY },
    ]) {
      const keys = [undefined, '', 'data', 'data.a', 'data.b'].map((path) =>
        sourceTrustKey({ ...request, ...(path !== undefined ? { path } : {}) }),
      );
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('keeps the parts apart when a URL holds a space or what looks like another part', () => {
    const spaced = 'https://x.example/a b';
    const keys = [
      sourceTrustKey({ url: spaced, method: 'GET' }),
      sourceTrustKey({ url: 'https://x.example/a', method: 'GET', path: 'b' }),
      sourceTrustKey({ url: 'https://x.example/a', method: 'GET', path: ' b' }),
      sourceTrustKey({ url: `${spaced}`, method: 'GET', path: '' }),
      sourceTrustKey({ url: 'https://x.example/a b', method: 'POST', body: 'c' }),
      sourceTrustKey({ url: 'https://x.example/a', method: 'POST', body: 'b c' }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});
