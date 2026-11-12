import { describe, expect, it } from 'vitest';
import { sourceTrustKey } from './trust.ts';

const URL = 'https://gitlab.example/api/graphql';
const QUERY = { query: '{ project(fullPath: "a/b") { name } }' };

describe('sourceTrustKey', () => {
  it('keys a GET by its exact URL', () => {
    expect(sourceTrustKey({ url: URL, method: 'GET' })).toBe(`GET ${URL}`);
    expect(sourceTrustKey({ url: `${URL}/`, method: 'GET' })).not.toBe(
      sourceTrustKey({ url: URL, method: 'GET' }),
    );
  });

  it('keys a POST by its URL and the JSON text of its body, never like a GET', () => {
    const post = sourceTrustKey({ url: URL, method: 'POST', body: QUERY });
    expect(post).not.toBe(sourceTrustKey({ url: URL, method: 'GET' }));
    expect(post).toBe(sourceTrustKey({ url: URL, method: 'POST', body: JSON.parse(JSON.stringify(QUERY)) }));
    expect(post).toMatch(/^POST [0-9a-f]{64} https:/);
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
});
