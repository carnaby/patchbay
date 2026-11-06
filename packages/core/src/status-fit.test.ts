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
  statusMoreSectionsTitle,
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
    // Calm header lines go before any problem: merged into one line (two headers and a gap become one line,
    // 228 - 36), then that line goes too (192 - 36); the summary line still counts every check.
    const merged = statusFit(infra, { width: 480, height: 227 });
    expect([merged.height, merged.fits, merged.clamped, merged.hiddenProblems]).toEqual([
      192,
      true,
      false,
      0,
    ]);
    expect(shape(merged)).toEqual({ nas: ['cue'] });
    expect(merged.moreSections && statusMoreSectionsTitle(merged.moreSections.sections)).toBe(
      '+2 more sections · 10 ok · 3 off',
    );
    expect(merged.moreSections!.y).toBe(168);
    const dropped = statusFit(infra, { width: 480, height: 191 });
    expect([dropped.height, dropped.fits, dropped.hiddenProblems, dropped.moreSections]).toEqual([
      156,
      true,
      0,
      null,
    ]);
    expect(shape(dropped)).toEqual({ nas: ['cue'] });
    const over = statusFit(infra, { width: 480, height: 155 });
    expect([over.height, over.fits, over.clamped, over.hiddenProblems]).toEqual([102, true, true, 1]);
    expect(shape(over).nas).toEqual(['+1 more problem']);
    const more = over.sections[0]!.items[0]!.item;
    expect(more.kind === 'more' && [more.what, more.level, more.tiles.map((t) => t.entity)]).toEqual([
      'problems',
      'fail',
      ['cue'],
    ]);
    // Hiding that cannot make it fit gains nothing: the problem tile stays, cut at the bottom.
    const tiny = statusFit(infra, { width: 480, height: 100 });
    expect([tiny.fits, tiny.hiddenProblems]).toEqual([false, 0]);
    expect(shape(tiny).nas).toEqual(['cue']);
  });

  it('fits the small widget of a phone without hiding its only problem (the 390 px browser check)', () => {
    const small = statusModel(
      infraTable(),
      StatusConfigSchema.parse({ ...INFRA_STATUS_CONFIG, levels: { exited: 'off' } }),
    );
    // The body of a 4x3 card stacked on a 390 px wide phone.
    const layout = statusFit(small, { width: 340, height: 162 });
    expect([layout.height, layout.fits, layout.hiddenProblems, layout.moreSections]).toEqual([
      156,
      true,
      0,
      null,
    ]);
    expect(shape(layout)).toEqual({ nas: ['cue'] });
  });

  /** One failing check on m0, the other machines all ok: four services each. */
  const machines = (n: number) =>
    statusModel(
      inferTable(
        Array.from({ length: n }, (_, m) =>
          Array.from({ length: 4 }, (_, s) => ({
            machine: `m${m}`,
            service: `m${m}-svc${s}`,
            status: m === 0 && s === 0 ? 'fail' : 'ok',
            detail: m === 0 && s === 0 ? 'connection refused' : null,
          })),
        ).flat(),
      ),
      StatusConfigSchema.parse({ entity: 'service', status: 'status', group: 'machine', detail: 'detail' }),
    );

  it.each([
    [7, 612, 310, 304],
    [7, 342, 312, 304],
    [9, 612, 396, 376],
  ])(
    'with %i machines in %ix%i keeps the failing tile and merges calm sections',
    (n, width, height, used) => {
      const layout = statusFit(machines(n), { width, height });
      expect([layout.height, layout.fits, layout.hiddenProblems]).toEqual([used, true, 0]);
      expect(shape(layout).m0).toEqual(['m0-svc0']);
      // m0 plus four calm headers; the last two calm sections share one line.
      const merged = layout.moreSections!.sections.map((s) => s.label);
      expect(merged).toEqual([`m${n - 2}`, `m${n - 1}`]);
      expect(statusMoreSectionsTitle(layout.moreSections!.sections)).toBe('+2 more sections · 8 ok');
      expect(layout.sections.map((s) => s.section.label)).toEqual(
        Array.from({ length: n - 2 }, (_, i) => `m${i}`),
      );
    },
  );

  it('merges calm sections last first, one more at a time, and never folds a single one into "+1"', () => {
    const model = machines(7);
    const counts: number[] = [];
    for (let height = 400; height >= 120; height -= 4) {
      const layout = statusFit(model, { width: 612, height });
      if (layout.hiddenProblems) break;
      counts.push(layout.moreSections?.sections.length ?? 0);
    }
    expect(counts).not.toContain(1);
    // 2, 3, ... 6: every count from two to all six calm sections shows up on the way down.
    for (const n of [2, 3, 4, 5, 6]) expect(counts).toContain(n);
    for (let i = 1; i < counts.length; i++) {
      if (counts[i - 1]! > 0 && counts[i] !== 0) expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]!);
    }
  });

  it('hides problem tiles from the last section upwards and keeps "+N more problems" with the problems left', () => {
    const rows = [
      ...['a1', 'a2'].map((service) => ({ machine: 'a', service, status: 'fail' })),
      ...['b1', 'b2'].map((service) => ({ machine: 'b', service, status: 'warn' })),
      { machine: 'c', service: 'c1', status: 'ok' },
    ];
    const model = statusModel(
      inferTable(rows),
      StatusConfigSchema.parse({ entity: 'service', status: 'status', group: 'machine' }),
    );
    const at = (hidden: number) => {
      for (let height = 1000; height > 0; height--) {
        const layout = statusFit(model, { width: 480, height });
        if (layout.hiddenProblems === hidden) return layout;
      }
      throw new Error(`no box hides ${hidden}`);
    };
    const one = at(1);
    expect(shape(one)).toMatchObject({ a: ['a1', 'a2'], b: ['b1', '+1 more problem'] });
    const first = one.sections[1]!.items[1]!.item;
    expect(first.kind === 'more' && [first.level, first.tiles.map((t) => t.entity)]).toEqual([
      'warn',
      ['b2'],
    ]);
    // b has no problem tile left, so the fold moves home to a, still counting b's tiles, in reading order.
    const three = at(3);
    expect(shape(three)).toMatchObject({ a: ['a1', '+3 more problems'], b: ['(header)'] });
    const moved = three.sections[0]!.items[1]!.item;
    expect(moved.kind === 'more' && [moved.level, moved.tiles.map((t) => t.entity)]).toEqual([
      'fail',
      ['a2', 'b1', 'b2'],
    ]);
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
    // Blank lines inside a detail are drawn by `pre-line`, a trailing newline is not.
    expect(wrapText('a\n\nb', 10)).toEqual(['a', '', 'b']);
    expect(wrapText('a\n', 10)).toEqual(['a']);
    expect(wrapText('a\n\n', 10)).toEqual(['a', '']);
  });
});
