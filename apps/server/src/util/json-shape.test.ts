import { describe, expect, it } from 'vitest';
import { isLargeBody, LARGE_BODY_BYTES } from './json-body.ts';
import { jsonShapeProblem, MAX_JSON_DEPTH } from './json-shape.ts';
import { measureScaling, scalingProblem } from './scaling.test-helper.ts';

describe('isLargeBody', () => {
  it('judges large bodies by their headers', () => {
    const post = (headers: Record<string, string>) =>
      new Request('http://x/api', { method: 'POST', headers, body: 'x' });
    expect(isLargeBody(post({ 'content-length': String(LARGE_BODY_BYTES) }))).toBe(false);
    expect(isLargeBody(post({ 'content-length': String(LARGE_BODY_BYTES + 1) }))).toBe(true);
    expect(isLargeBody(post({ 'transfer-encoding': 'chunked' }))).toBe(true);
    expect(isLargeBody(new Request('http://x/api'))).toBe(false);
  });
});

const limits = { maxDepth: 4, maxValues: 10 };

describe('jsonShapeProblem', () => {
  it('measures depth and counts values without the keys', () => {
    expect(jsonShapeProblem('[[[[1]]]]', limits)).toBeNull();
    expect(jsonShapeProblem('[[[[[1]]]]]', limits)).toEqual({ kind: 'depth', limit: 4 });
    // 1 object + 4 values; the 4 keys do not count.
    expect(jsonShapeProblem('{"a":1,"b":"x","c":true,"d":null}', limits)).toBeNull();
    expect(jsonShapeProblem(JSON.stringify(Array.from({ length: 10 }, () => 1.5e-3)), limits)).toEqual({
      kind: 'values',
      limit: 10,
    });
    expect(jsonShapeProblem(JSON.stringify(Array.from({ length: 9 }, () => -12)), limits)).toBeNull();
  });

  it('ignores brackets, quotes and colons inside strings', () => {
    const tricky = JSON.stringify({ a: '[[[[[[[[{{{{', b: 'say \\"hi\\": [[[[', c: 'x\\', d: ':::' });
    expect(jsonShapeProblem(tricky, limits)).toBeNull();
    expect(JSON.parse(tricky)).toBeTruthy();
  });

  it('refuses a nested-array bomb in one fast pass', () => {
    const bombOf = (n: number) => '['.repeat(n) + ']'.repeat(n);
    const bomb = bombOf(2_000_000);
    expect(jsonShapeProblem(bomb, { maxDepth: MAX_JSON_DEPTH, maxValues: 1e9 })).toEqual({
      kind: 'depth',
      limit: MAX_JSON_DEPTH,
    });
    const times = measureScaling(
      (n) => {
        const text = bombOf(n);
        return () => jsonShapeProblem(text, { maxDepth: MAX_JSON_DEPTH, maxValues: 1e9 });
      },
      { size: 2_000_000 },
    );
    expect(scalingProblem(times)).toBeNull();
  });

  it('passes ordinary documents at the default depth', () => {
    const records = JSON.stringify(
      Array.from({ length: 1000 }, (_, i) => ({
        id: i,
        name: `n "${i}"`,
        tags: ['a', 'b'],
        geo: { lat: 1, lng: 2 },
      })),
    );
    expect(jsonShapeProblem(records, { maxDepth: MAX_JSON_DEPTH, maxValues: 9001 })).toBeNull();
    expect(jsonShapeProblem(records, { maxDepth: MAX_JSON_DEPTH, maxValues: 9000 })?.kind).toBe('values');
  });
});
