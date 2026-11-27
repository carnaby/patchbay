import { describe, expect, it } from 'vitest';
import {
  inferTable,
  STATUS_METRICS,
  StatusConfigSchema,
  type StatusItem,
  type StatusLayout,
  type StatusModel,
  statusColumns,
  statusFit,
  statusModel,
  statusMoreNames,
  statusMoreSectionsTitle,
  statusMoreTitle,
  statusSummary,
  statusTrimText,
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
  nuc: ['home-assistant', 'pihole', 'nuc', 'grafana', 'old-wiki'],
  internet: ['blog.example.com', 'status', 'patchbay'],
};

describe('statusFit', () => {
  it('draws every tile when there is room, problem tiles two columns wide', () => {
    const layout = statusFit(infra, { width: 480, height: 1000 });
    expect([layout.columns, layout.height, layout.fits, layout.clamped]).toEqual([3, 502, true, false]);
    expect(layout.sections.map((s) => s.section.label)).toEqual(['nas', 'nuc', 'internet']);
    expect(shape(layout)).toEqual(FULL);
    const [cue, blog, immich] = layout.sections[0]!.items;
    expect([cue!.span, cue!.x, cue!.y, cue!.height]).toEqual([2, 0, 52, 104]);
    expect(cue!.width).toBeCloseTo(317.33, 1);
    // Same row: stretched to the row's height, as CSS grid rows are.
    expect([blog!.span, blog!.y, blog!.height]).toEqual([1, 52, 104]);
    expect(blog!.x).toBeCloseTo(325.33, 1);
    expect([immich!.x, immich!.y, immich!.height]).toEqual([0, 164, 50]);
  });

  it('folds off tiles first, then ok tiles, from the last section upwards, only where that saves space', () => {
    // One pixel short. Folding the two off tiles of nuc saves no row (five cells or four take two rows of three), nor
    // do the three ok tiles of internet (the last section) as one cell: both stay tiles. Folding nuc's ok tiles does.
    const short = statusFit(infra, { width: 480, height: 501 });
    expect(short.height).toBe(444);
    expect(shape(short)).toEqual({ ...FULL, nuc: ['+3 more ok', 'grafana', 'old-wiki'] });
    const tighter = statusFit(infra, { width: 480, height: 443 });
    expect(tighter.height).toBe(386);
    expect(shape(tighter)).toEqual({
      nas: ['cue', '+4 more ok', 'umami'],
      nuc: ['+3 more ok', 'grafana', 'old-wiki'],
      internet: ['blog.example.com', 'status', 'patchbay'],
    });
  });

  it('skips a fold that would take the same rows, and folds the next section instead', () => {
    // Three columns: a takes two rows of ok tiles, b one row of an ok and two off tiles.
    const rows = [
      ...[1, 2, 3, 4, 5, 6].map((i) => ({ machine: 'a', service: `a${i}`, status: 'ok' })),
      { machine: 'b', service: 'b1', status: 'ok' },
      { machine: 'b', service: 'b2', status: 'off' },
      { machine: 'b', service: 'b3', status: 'off' },
    ];
    const model = statusModel(
      inferTable(rows),
      StatusConfigSchema.parse({ entity: 'service', status: 'status', group: 'machine' }),
    );
    const full = statusFit(model, { width: 480, height: 2000 });
    expect(shape(full)).toEqual({ a: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'], b: ['b1', 'b2', 'b3'] });
    const short = statusFit(model, { width: 480, height: full.height - 1 });
    expect([short.fits, short.height]).toEqual([true, full.height - 58]);
    // "+2 off" in b would leave its row as it is: b keeps its tiles and a folds instead.
    expect(shape(short)).toEqual({ a: ['+6 more ok'], b: ['b1', 'b2', 'b3'] });
  });

  it('folds ok and off tiles together when only both free their shared row', () => {
    // Three ok and three off tiles: either fold alone leaves four cells in two rows, both leave one row.
    const rows = [
      { machine: 'x', service: 'x1', status: 'fail' },
      ...[1, 2, 3].map((i) => ({ machine: 'y', service: `ok${i}`, status: 'ok' })),
      ...[1, 2, 3].map((i) => ({ machine: 'y', service: `off${i}`, status: 'off' })),
    ];
    const model = statusModel(
      inferTable(rows),
      StatusConfigSchema.parse({ entity: 'service', status: 'status', group: 'machine' }),
    );
    const full = statusFit(model, { width: 480, height: 2000 });
    const short = statusFit(model, { width: 480, height: full.height - 1 });
    expect([short.fits, short.height]).toEqual([true, full.height - 58]);
    // Not the header line alone: the two folds keep y's counts and names one click away.
    expect(shape(short)).toEqual({ x: ['x1'], y: ['+3 more ok', '+3 off'] });
  });

  /** n ok and m off tiles, optionally under one section "a" and after a failing section "x". */
  const calmTiles = (ok: number, off: number, grouping: 'flat' | 'one' | 'after-fail') => {
    const machine = grouping === 'flat' ? {} : { machine: 'a' };
    const rows = [
      ...(grouping === 'after-fail' ? [{ machine: 'x', service: 'x1', status: 'fail' }] : []),
      ...Array.from({ length: ok }, (_, i) => ({ ...machine, service: `ok${i}`, status: 'ok' })),
      ...Array.from({ length: off }, (_, i) => ({ ...machine, service: `off${i}`, status: 'off' })),
    ];
    const group = grouping === 'flat' ? {} : { group: 'machine' };
    return statusModel(
      inferTable(rows),
      StatusConfigSchema.parse({ entity: 'service', status: 'status', ...group }),
    );
  };

  it('folds the off tiles too when the ok fold saved a row but still does not fit', () => {
    // The off fold alone saves nothing (twelve cells or ten take four rows), so it is skipped at first; after the ok
    // fold, four cells take two rows and "+3 off" brings them to one.
    const flat = statusFit(calmTiles(9, 3, 'flat'), { width: 480, height: 135 });
    expect([flat.fits, flat.height]).toEqual([true, 78]);
    expect(shape(flat)).toEqual({ '': ['+9 more ok', '+3 off'] });
    // With sections the same two folds come before the header line.
    expect(shape(statusFit(calmTiles(6, 3, 'one'), { width: 480, height: 140 }))).toEqual({
      a: ['+6 more ok', '+3 off'],
    });
    expect(shape(statusFit(calmTiles(6, 3, 'after-fail'), { width: 480, height: 200 }))).toEqual({
      x: ['x1'],
      a: ['+6 more ok', '+3 off'],
    });
  });

  it('folds calm sections to their header line, last first', () => {
    expect(shape(statusFit(infra, { width: 480, height: 385 }))).toEqual({
      nas: ['cue', '+4 more ok', 'umami'],
      nuc: ['+3 more ok', 'grafana', 'old-wiki'],
      internet: ['(header)'],
    });
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
    // Hiding cue empties nas, so its header folds away too: the fold names cue, the summary counts nas.
    const over = statusFit(infra, { width: 480, height: 155 });
    expect([over.height, over.fits, over.clamped, over.hiddenProblems]).toEqual([78, true, true, 1]);
    expect(shape(over)).toEqual({ nas: ['+1 more problem'] });
    expect(over.sections[0]!.header).toBe(false);
    const more = over.sections[0]!.items[0]!.item;
    expect(more.kind === 'more' && [more.what, more.level, more.tiles.map((t) => t.entity)]).toEqual([
      'problems',
      'fail',
      ['cue'],
    ]);
    // Too small for the problem tile: it is counted, never cut.
    const tiny = statusFit(infra, { width: 480, height: 100 });
    expect([tiny.height, tiny.fits, tiny.hiddenProblems]).toEqual([78, true, 1]);
    expect(shape(tiny)).toEqual({ nas: ['+1 more problem'] });
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
    // b has no problem tile left, so its header folds away and the fold moves home to a, naming b's tiles too.
    const three = at(3);
    expect(shape(three)).toEqual({ a: ['a1', '+3 more problems'] });
    const moved = three.sections[0]!.items[1]!.item;
    expect(moved.kind === 'more' && [moved.level, moved.tiles.map((t) => t.entity)]).toEqual([
      'fail',
      ['a2', 'b1', 'b2'],
    ]);
  });

  /** Every machine has one failing check and three ok ones. */
  const failing = (n: number) =>
    statusModel(
      inferTable(
        Array.from({ length: n }, (_, m) =>
          Array.from({ length: 4 }, (_, s) => ({
            machine: `m${m}`,
            service: `m${m}-svc${s}`,
            status: s === 0 ? 'fail' : 'ok',
            detail: s === 0 ? 'connection refused' : null,
          })),
        ).flat(),
      ),
      StatusConfigSchema.parse({ entity: 'service', status: 'status', group: 'machine', detail: 'detail' }),
    );

  /** Nothing drawn below the box: no cell, and no header line. */
  const inside = (layout: StatusLayout, height: number) =>
    layout.sections.every(
      (s) =>
        (!s.header || s.y + STATUS_METRICS.headerHeight <= height) &&
        s.items.every((p) => p.y + p.height <= height),
    ) &&
    (!layout.moreSections || layout.moreSections.y + STATUS_METRICS.headerHeight <= height);

  /** Every check failing, one tile per service, flat, no summary line: heights are easy to count. */
  const failingChecks = (services: Record<string, number>, details: Record<string, string> = {}) =>
    statusModel(
      inferTable(
        Object.entries(services).flatMap(([service, n]) =>
          Array.from({ length: n }, (_, i) => ({
            service,
            check: `${service}-c${i + 1}`,
            status: 'fail',
            detail: details[service] ?? null,
          })),
        ),
      ),
      StatusConfigSchema.parse({
        entity: 'service',
        status: 'status',
        label: 'check',
        detail: 'detail',
        summary: false,
      }),
    );
  const tileItem = (layout: StatusLayout, entity: string) =>
    layout.sections
      .flatMap((s) => s.items)
      .map((p) => p.item)
      .find((item) => item.kind === 'tile' && item.tile.entity === entity) as Extract<
      StatusItem,
      { kind: 'tile' }
    >;

  it('shows the first failing checks of a tile and counts the rest instead of hiding the tile', () => {
    // A tile is 34 tall (padding and name) plus 22 per check; trimmed, one more 22 line says "+M more".
    // Eight checks take 210; in 120 the tile keeps two (34 + 2 × 22 + 22 = 100), three would take 122.
    const layout = statusFit(failingChecks({ db: 8 }), { width: 480, height: 120 });
    expect([layout.fits, layout.hiddenProblems, layout.height]).toEqual([true, 0, 100]);
    const db = tileItem(layout, 'db');
    expect(db.shown).toBe(2);
    expect(db.tile.problems.slice(0, db.shown).map((c) => c.label)).toEqual(['db-c1', 'db-c2']);
    expect(statusTrimText(db.tile.problems.length - db.shown)).toBe('+6 more');
  });

  it('trims round-robin from the last tile up, keeping trims that only pay off together', () => {
    // Two six-check tiles on rows of their own (166 + 8 + 166). The first trim of each saves nothing (a check of 22
    // becomes the "+M more" line of 22) and is kept; then b, a, b, a, b lose one each: 230 fits in 250.
    const layout = statusFit(failingChecks({ a: 6, b: 6 }), { width: 480, height: 250 });
    expect([layout.fits, layout.hiddenProblems, layout.height]).toEqual([true, 0, 230]);
    expect([tileItem(layout, 'a').shown, tileItem(layout, 'b').shown]).toEqual([3, 2]);
  });

  it('shows all the checks of a tile left alone after another tile is hidden', () => {
    // 640 px: four columns, both problem tiles two wide, one row. b (one check, detail clamped to two lines) is 88
    // tall and sets the row; trimming a to one check (78 → 78) cannot shorten it, so b goes into
    // "+1 more problem" and a, no longer trimmed, shows both checks (row 78).
    const model = failingChecks({ a: 2, b: 1 }, { b: 'x '.repeat(200).trim() });
    const layout = statusFit(model, { width: 640, height: 80 });
    expect([layout.fits, layout.hiddenProblems, layout.height]).toEqual([true, 1, 78]);
    expect(tileItem(layout, 'a').shown).toBe(2);
  });

  it('fits a mass outage in a small box quickly: a hide costs one measure, not a whole trimming', () => {
    // Hundreds of failing tiles at a phone width, folded one by one. Before the one-check shortcut this took seconds.
    const model = failingChecks(Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`s${i}`, 3])));
    statusFit(model, { width: 340, height: 162 });
    const start = performance.now();
    const layout = statusFit(model, { width: 340, height: 162 });
    expect(layout.fits).toBe(true);
    // Measured ~60 ms; the old quadratic trimming took ~2300 ms. The bound is far from both so a slow CI runner
    // cannot flake it.
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('starts the trimming over after a whole tile is hidden, so the others keep as many checks as fit', () => {
    // 8 + 8 checks in 163: trimmed alone, no tile can fall to one check each and still fit (34 + 22 + 22 = 78 each,
    // 78 + 8 + 78 = 164), so b goes into "+1 more problem"; a then gets a fresh trim from eight checks, not from
    // the state the trim of the pair left it in (a would be left with 1), and keeps four (34 + 4 × 22 + 22 = 144).
    const layout = statusFit(failingChecks({ a: 8, b: 8 }), { width: 480, height: 163 });
    expect([layout.fits, layout.hiddenProblems]).toEqual([true, 1]);
    expect(tileItem(layout, 'a').shown).toBe(4);
  });

  it.each([3, 4])('counts %i failing machines in a phone body instead of cutting their tiles', (n) => {
    const layout = statusFit(failing(n), { width: 340, height: 162 });
    expect([layout.height, layout.fits, layout.hiddenProblems]).toEqual([78, true, n]);
    expect(inside(layout, 162)).toBe(true);
    // Every section was emptied: one fold under the summary line, without a header, naming every failing tile.
    expect(layout.sections).toHaveLength(1);
    expect(layout.sections[0]!.header).toBe(false);
    const fold = layout.sections[0]!.items[0]!.item;
    expect(
      fold.kind === 'more' && [statusMoreTitle(fold), fold.level, fold.tiles.map((t) => t.entity)],
    ).toEqual([`+${n} more problems`, 'fail', Array.from({ length: n }, (_, m) => `m${m}-svc0`)]);
  });

  it('fits every box that holds the summary line and one fold, and draws nothing below it', () => {
    const bigDetail = 'x '.repeat(200).trim();
    for (const model of [
      infra,
      flat,
      failing(3),
      failing(4),
      machines(7),
      failingChecks({ a: 6, b: 4, c: 9 }),
      failingChecks({ a: 5, b: 1 }, { b: bigDetail }),
    ]) {
      for (const width of [340, 480, 612]) {
        for (let height = 78; height <= 700; height += 7) {
          const layout = statusFit(model, { width, height });
          expect(layout.fits).toBe(true);
          expect(inside(layout, height)).toBe(true);
          for (const p of layout.sections.flatMap((s) => s.items)) {
            if (p.item.kind !== 'tile') continue;
            const n = p.item.tile.problems.length;
            expect(n === 0 ? p.item.shown === 0 : p.item.shown >= 1 && p.item.shown <= n).toBe(true);
          }
        }
      }
    }
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
    // The three off tiles fill the row "+3 off" would take alone, so they stay tiles.
    expect(shape(layout)).toEqual({ '': ['cue', '+10 more ok', 'umami', 'grafana', 'old-wiki'] });
    const ok = layout.sections[0]!.items[1]!.item;
    expect(ok.kind === 'more' && statusMoreNames(ok.tiles)).toBe('blog, immich, nas, …');
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
