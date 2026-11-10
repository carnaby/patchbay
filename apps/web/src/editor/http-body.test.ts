import { SourceSchema } from '@patchbay/core';
import { describe, expect, it } from 'vitest';
import { bodyText, parseBodyText, switchMethod, withBody, withMethod } from './http-body.ts';

const get = { kind: 'http' as const, url: 'https://api.github.com/graphql', path: 'data.viewer' };

describe('the POST body field', () => {
  it('shows a saved body pretty-printed, and nothing for none', () => {
    expect(bodyText({ query: '{ viewer { login } }' })).toBe('{\n  "query": "{ viewer { login } }"\n}');
    expect(bodyText(undefined)).toBe('');
    expect(bodyText(null)).toBe('null');
  });

  it('parses JSON, reads empty text as no body and explains what it refuses', () => {
    expect(parseBodyText(' {"query": "x"} ')).toEqual({ ok: true, body: { query: 'x' } });
    expect(parseBodyText('  \n')).toEqual({ ok: true, body: undefined });
    const broken = parseBodyText('{"query": ');
    expect(broken.ok).toBe(false);
    expect(!broken.ok && broken.error).toMatch(/^Not valid JSON/);
    const big = parseBodyText(JSON.stringify({ q: 'x'.repeat(16_384) }));
    expect(!big.ok && big.error).toMatch(/at most 16,384/);
    const deep = parseBodyText(`${'['.repeat(33)}${']'.repeat(33)}`);
    expect(!deep.ok && deep.error).toMatch(/deeper than 32/);
  });

  it('switches methods without leaving a body behind', () => {
    const post = withMethod(get, 'POST');
    expect(post).toEqual({ ...get, method: 'POST' });
    const withQuery = withBody(post, { query: 'x' });
    expect(withQuery).toEqual({ ...get, method: 'POST', body: { query: 'x' } });
    expect(withMethod(withQuery, 'POST')).toBe(withQuery);
    // GET removes method and body, so the source is saved exactly as before POST existed.
    expect(withMethod(withQuery, 'GET')).toEqual(get);
    expect(withBody(withQuery, undefined)).toEqual({ ...get, method: 'POST' });
  });

  it('keeps the typed body through GET and back to POST, without saving it on the GET source', () => {
    const text = '{\n  "query": "x"\n}';
    const post = withBody(withMethod(get, 'POST'), { query: 'x' });
    const toGet = switchMethod(post, 'GET', text);
    // The saved GET source is exactly as before POST existed, and valid under the strict schema.
    expect(toGet).toEqual({ source: get, text, error: null });
    expect(SourceSchema.parse(toGet.source)).toEqual(get);
    const back = switchMethod(toGet.source, 'POST', toGet.text);
    expect(back).toEqual({ source: post, text, error: null });
    expect(switchMethod(back.source, 'GET', back.text).source).toEqual(get);
  });

  it('brings back unfinished body text with its error, and GET never blocks on it', () => {
    const text = '{"query": ';
    const back = switchMethod(get, 'POST', text);
    expect(back.source).toEqual({ ...get, method: 'POST' });
    expect(back.text).toBe(text);
    expect(back.error).toMatch(/^Not valid JSON/);
    // A GET sends no body, so text it does not send must not keep Save disabled.
    expect(switchMethod(back.source, 'GET', text)).toEqual({ source: get, text, error: null });
  });
});
