import { describe, expect, it } from 'vitest';
import { emailMatches, erasureItems } from './account.ts';

describe('emailMatches', () => {
  it('ignores case and surrounding spaces, and nothing else', () => {
    expect(emailMatches('  Ann@Example.com ', 'ann@example.com')).toBe(true);
    expect(emailMatches('ann@example.co', 'ann@example.com')).toBe(false);
    expect(emailMatches('', 'ann@example.com')).toBe(false);
  });
});

describe('erasureItems', () => {
  it('counts what exists with the right plural and skips zeros', () => {
    expect(erasureItems({ dashboards: 1, secrets: 0, tokens: 2, connectedApps: 0 })).toEqual([
      '1 dashboard',
      '2 personal access tokens',
    ]);
    expect(erasureItems({ dashboards: 0, secrets: 0, tokens: 0, connectedApps: 0 })).toEqual([]);
  });
});
