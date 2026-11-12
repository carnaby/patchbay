import { describe, expect, it } from 'vitest';
import { npmDownloads } from './dev.ts';
import { column, upstream } from './fake-upstream.ts';

const day = (d: string, downloads: number) => ({ day: d, downloads });

describe('npm downloads', () => {
  // Routes match by prefix in this order: the packages first, since the registry total's URL is a prefix of theirs.
  const routes = {
    'https://api.npmjs.org/downloads/range/last-month/react': {
      downloads: [day('2026-09-06', 17_693_894), day('2026-09-07', 0), day('2026-09-09', 32_073_030)],
    },
    'https://api.npmjs.org/downloads/range/last-month/tiny-pkg': {
      downloads: [day('2026-09-06', 0), day('2026-09-07', 0), day('2026-09-09', 3)],
    },
    'https://api.npmjs.org/downloads/range/last-month': {
      downloads: [day('2026-09-06', 18_279_318_156), day('2026-09-07', 0), day('2026-09-09', 41_185_039_010)],
    },
  };

  it("reads a day npm lost for every package as empty, and keeps a small package's real 0", async () => {
    const { ctx, urls } = upstream(routes);
    const table = await npmDownloads.fetch({ packages: 'react,tiny-pkg' }, ctx);
    expect(column(table, 'downloads')).toEqual([17_693_894, null, 32_073_030, 0, null, 3]);
    expect(urls).toContain('https://api.npmjs.org/downloads/range/last-month');
    expect(table.columns.find((c) => c.name === 'downloads')?.type).toBe('number');
  });

  it("keeps npm's numbers when the registry total cannot be read", async () => {
    const { ctx } = upstream(routes);
    const failing = {
      fetchJson: async <T>(url: string) => {
        if (url === 'https://api.npmjs.org/downloads/range/last-month') throw new Error('502');
        return ctx.fetchJson<T>(url);
      },
    };
    const table = await npmDownloads.fetch({ packages: 'react' }, failing);
    expect(column(table, 'downloads')).toEqual([17_693_894, 0, 32_073_030]);
  });
});
