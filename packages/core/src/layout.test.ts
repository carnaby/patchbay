import { describe, expect, it } from 'vitest';
import {
  applyOps,
  emptyDashboard,
  GRID_COLUMNS,
  type LayoutItem,
  normalizeLayout,
  readingOrder,
} from './index.ts';
import { compact, reorderLayout } from './layout.ts';

const item = (i: string, x: number, y: number, w: number, h: number): LayoutItem => ({ i, x, y, w, h });

const overlapping = (layout: LayoutItem[]) =>
  layout.some((a, n) =>
    layout.slice(n + 1).some((b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h),
  );

describe('reorderLayout', () => {
  const kpis = [item('a', 0, 0, 3, 2), item('b', 3, 0, 3, 2), item('c', 6, 0, 3, 2), item('d', 9, 0, 3, 2)];

  it('swaps two widgets of the same size and leaves the rest alone', () => {
    expect(reorderLayout(kpis, 'c', 'b')).toEqual([
      item('a', 0, 0, 3, 2),
      item('b', 6, 0, 3, 2),
      item('c', 3, 0, 3, 2),
      item('d', 9, 0, 3, 2),
    ]);
  });

  it('moves a widget to the top by shifting the others one slot along', () => {
    const next = reorderLayout(kpis, 'd', 'a');
    expect(readingOrder(next)).toEqual(['d', 'a', 'b', 'c']);
    expect(next).toEqual([
      item('a', 3, 0, 3, 2),
      item('b', 6, 0, 3, 2),
      item('c', 9, 0, 3, 2),
      item('d', 0, 0, 3, 2),
    ]);
  });

  it('moves a widget to the end', () => {
    expect(readingOrder(reorderLayout(kpis, 'a', null))).toEqual(['b', 'c', 'd', 'a']);
  });

  it('keeps sizes and the wanted order when the widgets differ in size', () => {
    const layout = [item('kpi', 0, 0, 3, 2), item('chart', 3, 0, 6, 4), item('side', 9, 0, 3, 2)];
    const next = reorderLayout(layout, 'chart', 'kpi');
    expect(readingOrder(next)).toEqual(['chart', 'kpi', 'side']);
    expect(next.map(({ i, w, h }) => ({ i, w, h }))).toEqual(layout.map(({ i, w, h }) => ({ i, w, h })));
    expect(overlapping(next)).toBe(false);
  });

  it('moves a full-width widget between rows', () => {
    const layout = [item('a', 0, 0, 6, 2), item('b', 6, 0, 6, 2), item('wide', 0, 2, 12, 4)];
    const next = reorderLayout(layout, 'wide', 'a');
    expect(next).toEqual([item('a', 0, 4, 6, 2), item('b', 6, 4, 6, 2), item('wide', 0, 0, 12, 4)]);
  });

  it('returns the same layout when nothing would change', () => {
    expect(reorderLayout(kpis, 'b', 'c')).toBe(kpis);
    expect(reorderLayout(kpis, 'd', null)).toBe(kpis);
    expect(reorderLayout(kpis, 'b', 'b')).toBe(kpis);
  });

  it('always yields the requested reading order on a valid grid (randomised)', () => {
    // A small deterministic PRNG keeps failures reproducible.
    let seed = 42;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const widths = [2, 3, 4, 6, 8, 12];
    for (let run = 0; run < 400; run++) {
      const count = 2 + Math.floor(random() * 9);
      const raw = Array.from({ length: count }, (_, n) => {
        const w = widths[Math.floor(random() * widths.length)]!;
        return item(
          `w${n}`,
          Math.floor(random() * (GRID_COLUMNS - w + 1)),
          Math.floor(random() * 10),
          w,
          1 + Math.floor(random() * 5),
        );
      });
      const layout = normalizeLayout(
        raw,
        raw.map((r) => ({ id: r.i, type: 'chart' as const })),
      );
      const order = readingOrder(layout);
      const id = order[Math.floor(random() * count)]!;
      const others = order.filter((o) => o !== id);
      const beforeIndex = Math.floor(random() * (others.length + 1));
      const before = others[beforeIndex] ?? null;

      const next = reorderLayout(layout, id, before);
      const wanted = [...others];
      wanted.splice(beforeIndex, 0, id);
      expect(readingOrder(next)).toEqual(wanted);
      expect(overlapping(next)).toBe(false);
      expect(next.every((it) => it.x >= 0 && it.x + it.w <= GRID_COLUMNS)).toBe(true);
      expect(next.map((it) => [it.i, it.w, it.h])).toEqual(layout.map((it) => [it.i, it.w, it.h]));
      // applyOps normalises after every batch; a reorder must survive that untouched.
      expect(
        normalizeLayout(
          next,
          next.map((r) => ({ id: r.i, type: 'chart' as const })),
        ),
      ).toEqual(next);
    }
  });
});

describe('compact', () => {
  /** The original row-by-row walk, kept as the reference the jumping version must match exactly. */
  const stepwise = (layout: LayoutItem[]): LayoutItem[] => {
    const hits = (a: Omit<LayoutItem, 'i'>, b: Omit<LayoutItem, 'i'>) =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    const placed: LayoutItem[] = [];
    for (const it of [...layout].sort((a, b) => a.y - b.y || a.x - b.x)) {
      let y = it.y;
      while (y > 0 && !placed.some((p) => hits(p, { ...it, y: y - 1 }))) y--;
      while (placed.some((p) => hits(p, { ...it, y }))) y++;
      placed.push({ ...it, y });
    }
    const order = new Map(layout.map((it, idx) => [it.i, idx]));
    return placed.sort((a, b) => order.get(a.i)! - order.get(b.i)!);
  };

  it('matches the row-by-row walk, overlapping inputs included (randomised)', () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let run = 0; run < 2000; run++) {
      const count = 1 + Math.floor(random() * 14);
      const layout = Array.from({ length: count }, (_, n) => {
        const w = 1 + Math.floor(random() * GRID_COLUMNS);
        return item(
          `w${n}`,
          Math.floor(random() * (GRID_COLUMNS - w + 1)),
          Math.floor(random() * (run % 2 ? 12 : 200)),
          w,
          1 + Math.floor(random() * 8),
        );
      });
      expect(compact(layout)).toEqual(stepwise(layout));
    }
  });

  it('pulls a widget stored far down to the top without walking every row', () => {
    const layout = Array.from({ length: 60 }, (_, n) => item(`w${n}`, n % 12, 10_000, 1, 40));
    const started = performance.now();
    const out = compact(layout);
    expect(performance.now() - started).toBeLessThan(50);
    expect(Math.max(...out.map((it) => it.y + it.h))).toBe(200);
  });
});

describe('reorderWidget operation', () => {
  const text = (id: string) => ({ id, type: 'text', config: { markdown: id } });
  const base = applyOps(emptyDashboard('Order'), [
    { op: 'addWidget', widget: text('a'), position: { w: 4, h: 2 } },
    { op: 'addWidget', widget: text('b'), position: { w: 4, h: 2 } },
    { op: 'addWidget', widget: text('c'), position: { w: 4, h: 2 } },
  ]).doc;

  it('moves a widget up in reading order and logs it', () => {
    const { doc, changes } = applyOps(base, [{ op: 'reorderWidget', id: 'c', before: 'b' }]);
    expect(readingOrder(doc.layout)).toEqual(['a', 'c', 'b']);
    expect(changes).toEqual(['Moved widget "c" before "b"']);
  });

  it('moves a widget to the end with before: null', () => {
    const { doc, changes } = applyOps(base, [{ op: 'reorderWidget', id: 'a', before: null }]);
    expect(readingOrder(doc.layout)).toEqual(['b', 'c', 'a']);
    expect(changes).toEqual(['Moved widget "a" to the end']);
  });

  it('rejects unknown widgets and placing a widget before itself', () => {
    expect(() => applyOps(base, [{ op: 'reorderWidget', id: 'a', before: 'zzz' }])).toThrow(
      /Unknown widget "zzz"/,
    );
    expect(() => applyOps(base, [{ op: 'reorderWidget', id: 'a', before: 'a' }])).toThrow(/before itself/);
  });

  it('replays onto a newer version that gained a widget (rebase)', () => {
    const theirs = applyOps(base, [{ op: 'addWidget', widget: text('d'), position: { w: 4, h: 2 } }]).doc;
    const { doc } = applyOps(theirs, [{ op: 'reorderWidget', id: 'c', before: 'a' }]);
    expect(readingOrder(doc.layout)).toEqual(['c', 'a', 'b', 'd']);
  });
});
