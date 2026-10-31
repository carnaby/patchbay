import { describe, expect, it } from 'vitest';
import {
  cellLink,
  DatasetSchema,
  formatRelative,
  inferTable,
  profileTable,
  suggestWidgets,
  TableConfigSchema,
  tableColumns,
} from './index.ts';

describe('feed source schema', () => {
  it('takes an https address and a limit', () => {
    const d = DatasetSchema.parse({
      id: 'n',
      name: 'News',
      source: { kind: 'feed', url: 'https://x.example/rss' },
    });
    expect(d.source).toEqual({ kind: 'feed', url: 'https://x.example/rss', limit: 30 });
    const bad = (source: unknown) => DatasetSchema.safeParse({ id: 'n', name: 'N', source }).success;
    expect(bad({ kind: 'feed', url: 'http://x.example/rss' })).toBe(false);
    expect(bad({ kind: 'feed', url: 'https://x.example/rss', limit: 500 })).toBe(false);
    expect(bad({ kind: 'feed', url: 'https://x.example/rss', secrets: ['sec_aaaaaaaaaaaaaaaa'] })).toBe(
      false,
    );
  });
});

describe('table links and list style', () => {
  const table = inferTable([
    { title: 'Safe', link: 'https://x.example/a' },
    { title: 'Script', link: 'javascript:alert(1)' },
    { title: 'Relative', link: '/a' },
    { title: 'None', link: null },
  ]);

  it('links only to absolute http(s) addresses', () => {
    const [title] = tableColumns(
      TableConfigSchema.parse({ columns: [{ field: 'title', link: 'link' }] }),
      table,
    );
    expect(table.rows.map((row) => cellLink(row, title!))).toEqual(['https://x.example/a', null, null, null]);
    const [plain] = tableColumns(TableConfigSchema.parse({}), table);
    expect(cellLink(table.rows[0]!, plain!)).toBeNull();
  });

  it('keeps old tables unchanged: style is optional, not defaulted', () => {
    expect(TableConfigSchema.parse({})).not.toHaveProperty('style');
    expect(TableConfigSchema.parse({ style: 'list' }).style).toBe('list');
    expect(TableConfigSchema.safeParse({ style: 'cards' }).success).toBe(false);
  });

  it('formats relative times', () => {
    const now = Date.UTC(2026, 9, 30, 12);
    expect(formatRelative(now - 12 * 60_000, now)).toBe('12 minutes ago');
    expect(formatRelative(now - 30_000, now)).toBe('this minute');
    expect(formatRelative(now - 26 * 3_600_000, now)).toBe('yesterday');
    expect(formatRelative(now + 2 * 3_600_000, now)).toBe('in 2 hours');
    expect(formatRelative(now - 3_600_000, now, 'not a locale!!')).toBe('1 hour ago');
  });

  it('suggests headlines for feed-shaped data', () => {
    const now = Date.UTC(2026, 9, 30, 12);
    const feed = inferTable(
      Array.from({ length: 6 }, (_, i) => ({
        id: `i${i}`,
        title: `Story ${i}`,
        link: `https://x.example/${i}`,
        published: now - i * 3_600_000,
        source: 'X',
      })),
      { types: { published: 'time' } },
    );
    const [first] = suggestWidgets(profileTable(feed), { now });
    expect(first).toMatchObject({
      title: 'Headlines',
      widget: {
        type: 'table',
        config: { style: 'list', columns: [{ field: 'title', link: 'link' }, 'source', 'published'] },
      },
    });
    expect(first!.rationale).toContain('id column');
  });
});
