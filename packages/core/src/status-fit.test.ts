import { describe, expect, it } from 'vitest';
import {
  inferTable,
  StatusConfigSchema,
  type StatusLayout,
  type StatusModel,
  statusColumns,
  statusFit,
  statusModel,
  statusMoreNames,
  statusMoreTitle,
  statusSummary,
  wrapText,
} from './index.ts';
import { INFRA_STATUS_CONFIG, infraTable } from './status.fixture.ts';

const infra = statusModel(infraTable(), StatusConfigSchema.parse(INFRA_STATUS_CONFIG));
const flat = statusModel(
  infraTable(),
  StatusConfigSchema.parse({ ...INFRA_STATUS_CONFIG, group: undefined }),
);

/** What each section draws: entity names and fold titles, or "(header)" for a section folded to its header line. */
function shape(layout: StatusLayout): Record<string, string[]> {
  return Object.fromEntries(
    layout.sections.map((s) => [
      s.section.label ?? '',
      s.collapsed
        ? ['(header)']
        : s.items.map((p) => (p.item.kind === 'tile' ? p.item.tile.entity : statusMoreTitle(p.item))),
    ]),
  );
}

const FULL = {
  nas: ['cue', 'blog', 'immich', 'nas', 'watchtower', 'umami'],
  internet: ['blog.example.com', 'patchbay', 'status'],
  nuc: ['home-assistant', 'nuc', 'pihole', 'grafana', 'old-wiki'],
};

describe('statusFit', () => {
  it('draws every tile when there is room, problem tiles two columns wide', () => {
    const layout = statusFit(infra, { width: 480, height: 1000 });
    expect([layout.columns, layout.height, layout.fits, layout.clamped]).toEqual([3, 502, true, false]);
    expect(layout.sections.map((s) => s.section.label)).toEqual(['nas', 'internet', 'nuc']);
    expect(shape(layout)).toEqual(FULL);
    const [cue, blog, immich] = layout.sections[0]!.items;
    expect([cue!.span, cue!.x, cue!.y, cue!.height]).toEqual([2, 0, 52, 104]);
    expect(cue!.width).toBeCloseTo(317.33, 1);
    // Same row: stretched to the row's height, as CSS grid rows are.
    expect([blog!.span, blog!.y, blog!.height]).toEqual([1, 52, 104]);
    expect(blog!.x).toBeCloseTo(325.33, 1);
    expect([immich!.x, immich!.y, immich!.height]).toEqual([0, 164, 50]);
  });

  it('folds off tiles first, then ok tiles, from the last section upwards', () => {
    // One pixel short: folding the two off tiles of nuc saves no row, folding its ok tiles does.
    expect(shape(statusFit(infra, { width: 480, height: 501 }))).toEqual({
      ...FULL,
      nuc: ['+3 more ok', '+2 off'],
    });
    const tighter = statusFit(infra, { width: 480, height: 443 });
    expect(tighter.height).toBe(386);
    expect(shape(tighter)).toEqual({
      nas: ['cue', '+4 more ok', 'umami'],
      internet: ['+3 more ok'],
      nuc: ['+3 more ok', '+2 off'],
    });
  });

  it('folds calm sections to their header line, last first', () => {
    expect(shape(statusFit(infra, { width: 480, height: 385 }))).toMatchObject({ nuc: ['(header)'] });
    const both = statusFit(infra, { width: 480, height: 335 });
    expect(both.height).toBe(286);
    expect(shape(both)).toEqual({
      nas: ['cue', '+4 more ok', 'umami'],
      internet: ['(header)'],
      nuc: ['(header)'],
    });
  });

  it('keeps problem tiles, then counts them in "+N more problems" when even they do not fit', () => {
    const bare = statusFit(infra, { width: 480, height: 285 });
    expect([bare.height, bare.clamped]).toEqual([228, false]);
    expect(shape(bare).nas).toEqual(['cue']);
    const over = statusFit(infra, { width: 480, height: 227 });
    expect([over.height, over.fits, over.clamped, over.hiddenProblems]).toEqual([174, true, true, 1]);
    expect(shape(over).nas).toEqual(['+1 more problem']);
    const more = over.sections[0]!.items[0]!.item;
    expect(more.kind === 'more' && [more.what, more.level, more.tiles.map((t) => t.entity)]).toEqual([
      'problems',
      'fail',
      ['cue'],
    ]);
    expect(statusFit(infra, { width: 480, height: 100 }).fits).toBe(false);
  });

  it('never folds a problem tile into an ok or off summary, and fits whenever it says so', () => {
    let previous = -1;
    for (let height = 120; height <= 700; height += 9) {
      const layout = statusFit(infra, { width: 480, height });
      if (layout.fits) expect(layout.height).toBeLessThanOrEqual(height);
      const items = layout.sections.flatMap((s) => s.items);
      for (const p of items) {
        if (p.item.kind === 'more' && p.item.what !== 'problems')
          expect(p.item.tiles.every((t) => t.problems.length === 0)).toBe(true);
      }
      // A taller box never shows fewer tiles.
      const tiles = items.filter((p) => p.item.kind === 'tile').length;
      expect(tiles).toBeGreaterThanOrEqual(previous);
      previous = tiles;
    }
  });

  it.each([
    [300, 1, 1],
    [400, 2, 2],
    [480, 3, 2],
    [1200, 7, 2],
  ])('at %i px uses %i columns and gives the problem tile a span of %i', (width, columns, span) => {
    const layout = statusFit(infra, { width, height: 5000 });
    expect(layout.columns).toBe(columns);
    const [cue, ...rest] = layout.sections[0]!.items;
    expect(cue!.item.kind === 'tile' && cue!.item.tile.entity).toBe('cue');
    expect(cue!.span).toBe(span);
    expect(rest.every((p) => p.span === 1)).toBe(true);
  });

  it('works the same without sections: one grid, no headers', () => {
    const layout = statusFit(flat, { width: 480, height: 200 });
    expect(layout.sections).toHaveLength(1);
    expect([layout.sections[0]!.header, layout.sections[0]!.collapsed]).toEqual([false, false]);
    expect(shape(layout)).toEqual({ '': ['cue', '+10 more ok', '+3 off'] });
    const ok = layout.sections[0]!.items[1]!.item;
    expect(ok.kind === 'more' && statusMoreNames(ok.tiles)).toBe('blog, blog.example.com, home-assistant, …');
  });

  it('clamps long details to two lines before giving up a problem tile', () => {
    const model = statusModel(
      inferTable([{ service: 'db', status: 'fail', detail: 'x '.repeat(200).trim() }]),
      StatusConfigSchema.parse({ entity: 'service', status: 'status', detail: 'detail' }),
    );
    const full = statusFit(model, { width: 480, height: 2000 });
    expect(full.clamped).toBe(false);
    const tight = statusFit(model, { width: 480, height: full.height - 1 });
    expect([tight.clamped, tight.fits, tight.hiddenProblems]).toEqual([true, true, 0]);
    expect(shape(tight)).toEqual({ '': ['db'] });
    expect(tight.height).toBeLessThan(full.height);
  });

  it('keeps the worst problems and counts the rest', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      service: `svc-${String(i + 1).padStart(2, '0')}`,
      status: i % 3 === 0 ? 'warn' : 'fail',
      detail: 'connection refused',
    }));
    const model: StatusModel = statusModel(
      inferTable(rows),
      StatusConfigSchema.parse({ entity: 'service', status: 'status', detail: 'detail' }),
    );
    expect(statusSummary(model)).toBe('12 problems (8 fail, 4 warn)');
    const layout = statusFit(model, { width: 480, height: 300 });
    const items = layout.sections[0]!.items;
    const shown = items.filter((p) => p.item.kind === 'tile');
    expect(layout.fits).toBe(true);
    expect(shown.length + layout.hiddenProblems).toBe(12);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((p) => p.item.kind === 'tile' && p.item.tile.level === 'fail')).toBe(true);
    expect(items.at(-1)!.item).toMatchObject({ kind: 'more', what: 'problems', level: 'fail' });
  });

  it('counts columns from the minimum tile width', () => {
    expect([statusColumns(100), statusColumns(307), statusColumns(308)]).toEqual([1, 1, 2]);
  });
});

describe('wrapText', () => {
  it('wraps at word boundaries like the browser, and cuts words longer than a line', () => {
    expect(wrapText('FAILED: cue: Postgres container cue-backup-1 is not running, no dump', 44)).toEqual([
      'FAILED: cue: Postgres container cue-backup-1',
      'is not running, no dump',
    ]);
    expect(wrapText('see https://example.com/a/very/long/path', 12)).toEqual([
      'see',
      'https://exam',
      'ple.com/a/ve',
      'ry/long/path',
    ]);
    expect(wrapText('one\ntwo   three', 20)).toEqual(['one', 'two three']);
    expect(wrapText('', 10)).toEqual(['']);
  });
});
