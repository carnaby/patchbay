import { describe, expect, it } from 'vitest';
import {
  applyOps,
  BindingError,
  bindingMatches,
  credentialLikeParams,
  type DashboardDoc,
  DatasetSchema,
  describePlacement,
  docSecretIds,
  emptyDashboard,
  parseBinding,
  parseDashboard,
  placementConflict,
  SourceSchema,
  secretParamIssue,
  secretRefChanges,
  secretValueIssue,
} from './index.ts';

const A = 'sec_AAAAAAAAAAAAAAAA';
const B = 'sec_BBBBBBBBBBBBBBBB';
const C = 'sec_CCCCCCCCCCCCCCCC';
const D = 'sec_DDDDDDDDDDDDDDDD';

describe('secret references in the schema', () => {
  const http = (extra: object) => ({ kind: 'http', url: 'https://api.example.com/v1/orders', ...extra });

  it('accepts 1-3 unique ids', () => {
    expect(SourceSchema.safeParse(http({ secrets: [A] })).success).toBe(true);
    expect(SourceSchema.safeParse(http({ secrets: [A, B, C] })).success).toBe(true);
    expect(SourceSchema.safeParse(http({})).success).toBe(true);
  });

  it('rejects other shapes', () => {
    for (const secrets of [
      [],
      [A, B, C, D],
      [A, A],
      ['sec_short'],
      ['tok_AAAAAAAAAAAAAAAA'],
      A,
      [{ id: A }],
      null,
    ]) {
      expect(SourceSchema.safeParse(http({ secrets })).success, JSON.stringify(secrets)).toBe(false);
    }
    // Secrets exist only on http sources, and the objects stay strict.
    expect(SourceSchema.safeParse({ kind: 'connector', connector: 'x', secrets: [A] }).success).toBe(false);
    expect(SourceSchema.safeParse(http({ secret: [A] })).success).toBe(false);
    const parsed = SourceSchema.safeParse(http({ secrets: ['sec_x'] }));
    expect(parsed.success || parsed.error.issues[0]!.message).toContain('list_secrets');
  });
});

describe('parseBinding', () => {
  it('normalises the address into origin and a prefix ending in "/"', () => {
    expect(parseBinding(' https://API.Example.com/v1 ')).toEqual({
      origin: 'https://api.example.com',
      pathPrefix: '/v1/',
    });
    expect(parseBinding('https://api.example.com')).toEqual({
      origin: 'https://api.example.com',
      pathPrefix: '/',
    });
    expect(parseBinding('https://bücher.example/a/./b/../c/').origin).toBe('https://xn--bcher-kva.example');
    expect(parseBinding('https://api.example.com/a/./b/../c/').pathPrefix).toBe('/a/c/');
    expect(parseBinding('https://api.example.com:443/x/').origin).toBe('https://api.example.com');
  });

  it('refuses what a binding cannot be', () => {
    for (const bad of [
      'http://api.example.com/',
      'api.example.com',
      'https://user:pw@api.example.com/',
      'https://api.example.com/v1/?key=1',
      'https://api.example.com/v1/?',
      'https://api.example.com/v1/#x',
      'https://api.example.com:8443/',
      'https://api.example.com/a%2fb/',
      'https://api.example.com/a/..;/b/',
    ]) {
      expect(() => parseBinding(bad), bad).toThrow(BindingError);
    }
  });
});

describe('bindingMatches', () => {
  const v1 = { origin: 'https://api.example.com', pathPrefix: '/v1/' };
  const root = { origin: 'https://api.example.com', pathPrefix: '/' };
  const reason = (b: Parameters<typeof bindingMatches>[0], url: string) => {
    const r = bindingMatches(b, url);
    return r.ok ? 'ok' : r.reason;
  };

  it('requires the exact origin', () => {
    expect(reason(v1, 'https://api.example.com/v1/orders')).toBe('ok');
    expect(reason(v1, 'https://API.EXAMPLE.COM/v1/orders')).toBe('ok');
    expect(reason(v1, 'https://api.example.com:443/v1/orders')).toBe('ok');
    for (const url of [
      'https://other.example.com/v1/',
      'https://sub.api.example.com/v1/',
      'https://api.example.com.evil.example/v1/',
      'https://api.example.com:8443/v1/',
      'http://api.example.com/v1/',
      'https://api.example.com./v1/',
      'https://user@api.example.com/v1/',
      'not a url',
    ]) {
      expect(reason(v1, url), url).toBe('origin');
    }
  });

  it('compares IDN hosts by their punycode form', () => {
    const idn = parseBinding('https://bücher.example/');
    expect(reason(idn, 'https://BÜCHER.example/list')).toBe('ok');
    expect(reason(idn, 'https://xn--bcher-kva.example/list')).toBe('ok');
    expect(reason(idn, 'https://bucher.example/list')).toBe('origin');
  });

  it('requires the path prefix, with "/" as a boundary', () => {
    expect(reason(v1, 'https://api.example.com/v1/')).toBe('ok');
    expect(reason(v1, 'https://api.example.com/v1')).toBe('ok');
    expect(reason(v1, 'https://api.example.com/v10')).toBe('path');
    expect(reason(v1, 'https://api.example.com/v10/x')).toBe('path');
    expect(reason(v1, 'https://api.example.com/v2/x')).toBe('path');
    expect(reason(v1, 'https://api.example.com/')).toBe('path');
    // Dot segments, plain or encoded, and backslashes are resolved by the URL parser before the comparison.
    expect(reason(v1, 'https://api.example.com/v1/../admin')).toBe('path');
    expect(reason(v1, 'https://api.example.com/v1/%2e%2e/admin')).toBe('path');
    expect(reason(v1, 'https://api.example.com/v1/.%2E/admin')).toBe('path');
    expect(reason(v1, 'https://api.example.com/v1\\..\\admin')).toBe('path');
    expect(reason(v1, 'https://api.example.com/v1\\orders')).toBe('ok');
  });

  it('refuses separators a server might decode after the comparison', () => {
    for (const url of [
      'https://api.example.com/v1/..%2fadmin',
      'https://api.example.com/v1/..%2Fadmin',
      'https://api.example.com/v1/..%5cadmin',
      'https://api.example.com/v1/%252e%252e/admin',
      'https://api.example.com/v1/..;/admin',
      'https://api.example.com/v1/%2e%2e;x/admin',
    ]) {
      expect(reason(v1, url), url).toBe('encoding');
    }
    // With the whole origin allowed there is nothing to escape from.
    expect(reason(root, 'https://api.example.com/a%2fb')).toBe('ok');
  });

  it('ignores query and fragment', () => {
    expect(reason(v1, 'https://api.example.com/v1/x?next=https://evil.example/#frag')).toBe('ok');
  });

  it('refuses a URL that already has the query secret’s parameter', () => {
    const q = { ...v1, placement: 'query' as const, paramName: 'api_key' };
    expect(reason(q, 'https://api.example.com/v1/x?city=Oslo')).toBe('ok');
    expect(reason(q, 'https://api.example.com/v1/x?api_key=mine')).toBe('param');
    expect(reason(q, 'https://api.example.com/v1/x?API_KEY=mine')).toBe('param');
    expect(reason(q, 'https://api.example.com/v1/x?api%5Fkey=mine')).toBe('param');
    expect(
      reason(
        { ...v1, placement: 'header' as const, paramName: 'api_key' },
        'https://api.example.com/v1/x?api_key=1',
      ),
    ).toBe('ok');
  });
});

describe('placement rules', () => {
  it('validates header and query names', () => {
    expect(secretParamIssue('bearer', null)).toBeNull();
    expect(secretParamIssue('bearer', 'X')).not.toBeNull();
    expect(secretParamIssue('header', 'X-API-Key')).toBeNull();
    expect(secretParamIssue('header', 'Authorization')).toBeNull();
    for (const bad of [
      '',
      'Host',
      'content-type',
      'Proxy-Authorization',
      'User-Agent',
      'X API',
      'X:Y',
      'a'.repeat(65),
    ]) {
      expect(secretParamIssue('header', bad), bad).not.toBeNull();
    }
    expect(secretParamIssue('query', 'api_key')).toBeNull();
    for (const bad of ['', 'a b', 'a&b', 'a=b', 'ä'])
      expect(secretParamIssue('query', bad), bad).not.toBeNull();
  });

  it('validates values without repeating them', () => {
    expect(secretValueIssue('abcd1234', 'bearer')).toBeNull();
    const issues = [
      secretValueIssue('short', 'bearer'),
      secretValueIssue('x'.repeat(4097), 'bearer'),
      secretValueIssue('abcd\n1234', 'header'),
      secretValueIssue('Bearer abcd1234', 'bearer'),
      secretValueIssue('pässwörd-1234', 'header'),
    ];
    for (const issue of issues) expect(issue).not.toBeNull();
    expect(issues.join(' ')).not.toMatch(/abcd|pässwörd/);
    expect(secretValueIssue('pässwörd-1234', 'query')).toBeNull();
  });

  it('detects secrets that would write the same slot', () => {
    const s = (name: string, placement: 'bearer' | 'header' | 'query', paramName: string | null = null) => ({
      name,
      placement,
      paramName,
    });
    expect(
      placementConflict([s('a', 'bearer'), s('b', 'header', 'X-Key'), s('c', 'query', 'key')]),
    ).toBeNull();
    expect(placementConflict([s('a', 'bearer'), s('b', 'bearer')])).toContain('"a" and "b"');
    expect(placementConflict([s('a', 'header', 'X-Key'), s('b', 'header', 'x-key')])).not.toBeNull();
    expect(placementConflict([s('a', 'bearer'), s('b', 'header', 'authorization')])).not.toBeNull();
    expect(placementConflict([s('a', 'query', 'k'), s('b', 'query', 'K')])).not.toBeNull();
    expect(describePlacement(s('a', 'query', 'k'))).toBe('Query parameter k');
  });
});

describe('secretRefChanges', () => {
  const doc = (datasets: unknown[]): DashboardDoc => parseDashboard({ ...emptyDashboard(), datasets });
  const ds = (id: string, url: string, secrets?: string[], path?: string) =>
    DatasetSchema.parse({
      id,
      name: id,
      source: { kind: 'http', url, ...(secrets ? { secrets } : {}), ...(path ? { path } : {}) },
    });
  const u = 'https://api.example.com/v1/orders';

  it('finds introductions and retargets only', () => {
    const before = doc([ds('a', u, [A]), ds('b', u), ds('c', u, [A, B])]);
    expect(secretRefChanges(before, before)).toEqual([]);
    // New dataset with a secret, and a dataset that gained one.
    expect(secretRefChanges(before, doc([...before.datasets, ds('n', u, [A])]))).toEqual(['n']);
    expect(secretRefChanges(before, doc([ds('a', u, [A]), ds('b', u, [B]), ds('c', u, [A, B])]))).toEqual([
      'b',
    ]);
    // URL changed while it has secrets; changed ids.
    expect(secretRefChanges(before, doc([ds('a', `${u}/1`, [A]), ds('b', u), ds('c', u, [A, B])]))).toEqual([
      'a',
    ]);
    expect(secretRefChanges(before, doc([ds('a', u, [B]), ds('b', u), ds('c', u, [A, B])]))).toEqual(['a']);
    // Removing a secret, reordering, changing only the JSON path or removing the dataset is not a change.
    expect(secretRefChanges(before, doc([ds('a', u), ds('b', `${u}/2`), ds('c', u, [B])]))).toEqual([]);
    expect(secretRefChanges(before, doc([ds('a', u, [A], 'data.items'), ds('c', u, [B, A])]))).toEqual([]);
    // A connector dataset turned into an http one with a secret.
    const connector = doc([
      { id: 'a', name: 'a', source: { kind: 'connector', connector: 'x', params: {} } },
    ]);
    expect(secretRefChanges(connector, doc([ds('a', u, [A])]))).toEqual(['a']);
    expect(docSecretIds(before)).toEqual([A, B]);
  });

  it('sees changes made through operations', () => {
    const before = doc([ds('a', u, [A])]);
    const after = applyOps(before, [
      {
        op: 'updateDataset',
        id: 'a',
        set: { source: { kind: 'http', url: 'https://api.example.com/v1/users', secrets: [A] } },
      },
    ]).doc;
    expect(secretRefChanges(before, after)).toEqual(['a']);
  });
});

describe('credentialLikeParams', () => {
  it('flags parameters that look like credentials', () => {
    expect(
      credentialLikeParams(
        'https://x.example/a?city=Oslo&api_key=1&Access-Token=2&apiKey=3&signature=4&token=5',
      ),
    ).toEqual(['api_key', 'Access-Token', 'apiKey', 'signature', 'token']);
    expect(credentialLikeParams('https://x.example/a?keyword=x&monkey=1')).toEqual([]);
    expect(credentialLikeParams('nope')).toEqual([]);
  });
});
