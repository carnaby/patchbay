import { describe, expect, it } from 'vitest';
import { SHOWCASE_OWNER_ID, UseCaseMetaSchema, useCaseDashboardId } from './use-cases.ts';

describe('use cases', () => {
  it('accepts a valid meta and rejects unknown fields', () => {
    const meta = {
      id: 'morning-board',
      order: 1,
      title: 'Morning board',
      tab: 'Morning',
      description: 'Clock, news and weather.',
    };
    expect(UseCaseMetaSchema.parse(meta)).toEqual(meta);
    expect(() => UseCaseMetaSchema.parse({ ...meta, extra: 1 })).toThrow();
  });

  it('rejects slugs that are not lowercase words joined by single hyphens', () => {
    const base = { order: 1, title: 'T', tab: 'T', description: 'D' };
    for (const id of ['Morning', 'morning_board', '-a', 'a-', 'a--b', '../x', '']) {
      expect(() => UseCaseMetaSchema.parse({ ...base, id })).toThrow();
    }
  });

  it('needs at least four letters or digits, so the dashboard id has six characters', () => {
    const base = { order: 1, title: 'T', tab: 'T', description: 'D' };
    for (const id of ['abc', 'a-b-c']) {
      expect(() => UseCaseMetaSchema.parse({ ...base, id })).toThrow();
    }
    for (const id of ['abcd', 'a-b-c-d']) {
      const parsed = UseCaseMetaSchema.parse({ ...base, id });
      expect(useCaseDashboardId(parsed.id)).toMatch(/^[a-z0-9]{6,32}$/);
    }
  });

  it('derives a stable dashboard id the folder store accepts', () => {
    expect(useCaseDashboardId('morning-board')).toBe('scmorningboard');
    expect(useCaseDashboardId('own-data-csv')).toMatch(/^[a-z0-9]{6,32}$/);
    expect(useCaseDashboardId('a'.repeat(40))).toHaveLength(32);
  });

  it('uses a reserved owner id no real user can have', () => {
    expect(SHOWCASE_OWNER_ID).toBe('system');
  });
});
