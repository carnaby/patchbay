import { describe, expect, it } from 'vitest';
import {
  applyOps,
  buildChartOption,
  buildGaugeOption,
  ChartConfigSchema,
  COLOR_TOKENS,
  ColorSchema,
  contrastRatio,
  DashboardDocSchema,
  emptyDashboard,
  ensureContrast,
  GaugeConfigSchema,
  inferTable,
  MAX_SERIES,
  parseDashboard,
  resolveColor,
  STATUS_TEXT,
  seriesColors,
  THEMES,
} from './index.ts';

type Series = { name: string; itemStyle?: { color?: string }; data: unknown[] };
type PieItem = { name: string; value: number; itemStyle: { color: string } };

/** Hue in degrees from sRGB, enough to tell "still amber" from "now olive". */
function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

describe('colour tokens', () => {
  for (const mode of ['light', 'dark'] as const) {
    const theme = THEMES[mode];
    it(`every token's text colour reaches 4.5:1 on the ${mode} card`, () => {
      for (const token of COLOR_TOKENS) {
        const text = resolveColor(token, theme, 'text');
        expect(contrastRatio(text, theme.surface), `${token} → ${text}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`every token's fill keeps body text at 4.5:1 in ${mode}`, () => {
      for (const token of COLOR_TOKENS) {
        const fill = resolveColor(token, theme, 'fill');
        expect(contrastRatio(theme.textPrimary, fill), `${token} → ${fill}`).toBeGreaterThanOrEqual(4.5);
        // A tint, not paint: it stays close to the card.
        expect(contrastRatio(fill, theme.surface)).toBeLessThan(2.5);
      }
    });
  }

  it('resolves marks to the validated palette and status colours, per theme', () => {
    for (const mode of ['light', 'dark'] as const) {
      const t = THEMES[mode];
      for (let n = 1; n <= 8; n++) expect(resolveColor(`accent-${n}`, t, 'mark')).toBe(t.categorical[n - 1]);
      expect(resolveColor('positive', t, 'mark')).toBe(t.status.good);
      expect(resolveColor('warning', t, 'mark')).toBe(t.status.warning);
      expect(resolveColor('serious', t, 'mark')).toBe(t.status.serious);
      expect(resolveColor('negative', t, 'mark')).toBe(t.status.critical);
      expect(resolveColor('neutral', t, 'mark')).toBe(t.muted);
      expect(resolveColor('positive', t, 'text')).toBe(t.deltaGood);
      expect(resolveColor('negative', t, 'text')).toBe(t.deltaBad);
      expect(resolveColor('neutral', t, 'text')).toBe(t.textSecondary);
      expect(resolveColor('neutral', t, 'fill')).toBe(t.grid);
      expect(resolveColor('warning', t, 'text')).toBe(STATUS_TEXT[mode].warning);
    }
    expect(resolveColor('accent-1', THEMES.light, 'mark')).not.toBe(
      resolveColor('accent-1', THEMES.dark, 'mark'),
    );
  });

  it('keeps hex marks as given and contrast-checks hex text', () => {
    expect(resolveColor('#FAB219', THEMES.light, 'mark')).toBe('#FAB219');
    const text = resolveColor('#fab219', THEMES.light, 'text');
    expect(contrastRatio(text, THEMES.light.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it('accepts tokens and hex, rejects anything else', () => {
    expect(ColorSchema.safeParse('accent-3').success).toBe(true);
    expect(ColorSchema.safeParse('#12abEF').success).toBe(true);
    for (const bad of ['accent-9', 'red', '#fff', 'rgb(0,0,0)', ''])
      expect(ColorSchema.safeParse(bad).success).toBe(false);
  });
});

describe('ensureContrast', () => {
  const light = THEMES.light.surface;
  const dark = THEMES.dark.surface;

  it('leaves a colour that already passes alone', () => {
    expect(ensureContrast('#0b0b0b', light, 4.5)).toBe('#0b0b0b');
  });

  it('darkens a too-light colour on a light card, keeping its hue', () => {
    const out = ensureContrast('#fab219', light, 4.5);
    expect(contrastRatio(out, light)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(out, light)).toBeLessThan(5.2);
    expect(Math.abs(hue(out) - hue('#fab219'))).toBeLessThan(8);
  });

  it('lightens a too-dark colour on a dark card, keeping its hue', () => {
    const out = ensureContrast('#184f95', dark, 4.5);
    expect(contrastRatio(out, dark)).toBeGreaterThanOrEqual(4.5);
    expect(Math.abs(hue(out) - hue('#184f95'))).toBeLessThan(8);
  });

  it('is deterministic', () => {
    expect(ensureContrast('#e87ba4', light, 4.5)).toBe(ensureContrast('#e87ba4', light, 4.5));
  });
});

describe('seriesColors', () => {
  const t = THEMES.light;
  const c = t.categorical;

  it('without colours assigns the palette in order and mutes keys beyond MAX_SERIES (unchanged)', () => {
    const keys = Array.from({ length: 10 }, (_, i) => `k${i}`);
    const out = seriesColors(keys, undefined, t);
    expect(out.slice(0, MAX_SERIES)).toEqual(c);
    expect(out.slice(MAX_SERIES)).toEqual([t.muted, t.muted]);
  });

  it('gives mapped keys their colour and the rest the slots nobody claimed', () => {
    const out = seriesColors(['a', 'b', 'c'], { b: 'accent-1' }, t);
    expect(out).toEqual([c[1], c[0], c[2]]);
  });

  it('a mapped status colour takes no palette slot', () => {
    expect(seriesColors(['a', 'sun', 'z'], { sun: 'warning' }, t)).toEqual([c[0], t.status.warning, c[1]]);
  });

  it('a mapped hex equal to a palette colour claims that slot', () => {
    expect(seriesColors(['a', 'b'], { a: c[0]! }, t)).toEqual([c[0], c[1]]);
  });

  it('keeps mapped colours when a new key appears that sorts earlier', () => {
    const map = { shadow: 'accent-1', sun: 'warning' } as const;
    const before = seriesColors(['shadow', 'sun'], map, t);
    const after = seriesColors(['dusk', 'shadow', 'sun'], map, t);
    expect(after.slice(1)).toEqual(before);
    expect(after[0]).toBe(c[1]);
  });

  it('keeps the array form: a palette cycled in series order', () => {
    expect(seriesColors(['a', 'b', 'c'], ['#ff0000', 'accent-3'], t)).toEqual(['#ff0000', c[2], '#ff0000']);
  });

  it('uses dashboard entity colours after the widget map', () => {
    const out = seriesColors(['a', 'b'], { a: 'accent-5' }, t, {
      entityColors: { a: 'accent-2', b: 'accent-3' },
    });
    expect(out).toEqual([c[4], c[2]]);
  });

  it('mutes the "Other" key', () => {
    expect(seriesColors(['a', 'Other'], undefined, t, { other: 'Other' })).toEqual([c[0], t.muted]);
  });
});

describe('charts: colour follows the entity', () => {
  const t = THEMES.light;
  const c = t.categorical;
  const day = 86_400_000;
  const long = inferTable(
    ['sun', 'shadow', 'cloud'].flatMap((k, i) =>
      [0, 1, 2].map((d) => ({ day: new Date(d * day).toISOString(), kind: k, v: i + d })),
    ),
  );
  const colours = (option: Record<string, unknown>) =>
    Object.fromEntries((option.series as Series[]).map((s) => [s.name, s.itemStyle?.color]));

  it('colours y columns in configured order, exactly as before', () => {
    const table = inferTable([{ x: 'a', p: 1, q: 2, r: 3 }]);
    const option = buildChartOption(
      ChartConfigSchema.parse({ kind: 'bar', x: 'x', y: ['r', 'p', 'q'] }),
      table,
      t,
    );
    expect(colours(option)).toEqual({ r: c[0], p: c[1], q: c[2] });
  });

  it('colours split series alphabetically, exactly as before, and by map when given', () => {
    const auto = buildChartOption(
      ChartConfigSchema.parse({ kind: 'line', x: 'day', y: ['v'], series: 'kind' }),
      long,
      t,
    );
    expect(colours(auto)).toEqual({ cloud: c[0], shadow: c[1], sun: c[2] });
    const mapped = buildChartOption(
      ChartConfigSchema.parse({
        kind: 'line',
        x: 'day',
        y: ['v'],
        series: 'kind',
        colors: { sun: 'warning', shadow: 'accent-1' },
      }),
      long,
      t,
    );
    expect(colours(mapped)).toEqual({ cloud: c[1], shadow: c[0], sun: t.status.warning });
  });

  it('applies dashboard entity colours passed to the builder', () => {
    const option = buildChartOption(
      ChartConfigSchema.parse({ kind: 'line', x: 'day', y: ['v'], series: 'kind' }),
      long,
      t,
      {
        entityColors: { cloud: 'neutral' },
      },
    );
    expect(colours(option)).toEqual({ cloud: t.muted, shadow: c[0], sun: c[1] });
  });

  it('keeps a mapped key out of "Other" and mutes "Other"', () => {
    const rows = 'abcdefghij'.split('').map((k) => ({ x: 'p', k, v: 1 }));
    const config = ChartConfigSchema.parse({
      kind: 'bar',
      x: 'x',
      y: ['v'],
      series: 'k',
      colors: { j: 'accent-8' },
    });
    const option = buildChartOption(config, inferTable(rows), t);
    const byName = colours(option);
    expect(Object.keys(byName)).toContain('j');
    expect(byName.j).toBe(c[7]);
    expect(byName.Other).toBe(t.muted);
    expect(Object.keys(byName)).toHaveLength(MAX_SERIES);
  });

  it('pie slices keep their colour when their values cross', () => {
    const config = ChartConfigSchema.parse({ kind: 'donut', x: 'name', y: ['v'] });
    const slices = (rows: { name: string; v: number }[]) => {
      const items = (buildChartOption(config, inferTable(rows), t).series as { data: PieItem[] }[])[0]!.data;
      return Object.fromEntries(items.map((i) => [i.name, i.itemStyle.color]));
    };
    const before = slices([
      { name: 'a', v: 10 },
      { name: 'b', v: 5 },
    ]);
    const after = slices([
      { name: 'a', v: 5 },
      { name: 'b', v: 10 },
    ]);
    expect(after).toEqual(before);
    expect(before).toEqual({ a: c[0], b: c[1] });
  });

  it('pie slices follow a colour map and the folded "Other" is muted', () => {
    const rows = 'abcdefgh'.split('').map((name, i) => ({ name, v: 100 - i }));
    const config = ChartConfigSchema.parse({ kind: 'pie', x: 'name', y: ['v'], colors: { b: 'negative' } });
    const items = (buildChartOption(config, inferTable(rows), t).series as { data: PieItem[] }[])[0]!.data;
    const byName = Object.fromEntries(items.map((i) => [i.name, i.itemStyle.color]));
    expect(byName.b).toBe(t.status.critical);
    expect(byName.Other).toBe(t.muted);
    expect(byName.a).toBe(c[0]);
    expect(byName.c).toBe(c[1]);
  });

  it('resolves gauge band tokens per theme, hex unchanged', () => {
    const config = GaugeConfigSchema.parse({
      field: 'v',
      bands: [
        { upTo: 50, color: 'negative' },
        { upTo: 100, color: '#123456' },
      ],
    });
    for (const mode of ['light', 'dark'] as const) {
      const option = buildGaugeOption(config, 10, THEMES[mode]) as {
        series: { axisLine: { lineStyle: { color: [number, string][] } } }[];
      };
      expect(option.series[0]!.axisLine.lineStyle.color).toEqual([
        [0.5, THEMES[mode].status.critical],
        [1, '#123456'],
      ]);
    }
  });
});

describe('back-compat of documents written before colour tokens', () => {
  const old = {
    schemaVersion: 1,
    title: 'Old',
    datasets: [{ id: 'd', name: 'D', source: { kind: 'inline', rows: [{ a: 1 }] } }],
    widgets: [
      {
        id: 'c',
        type: 'chart',
        datasetId: 'd',
        config: { kind: 'bar', x: 'a', y: ['a'], colors: ['#AABBCC', '#112233'] },
      },
      {
        id: 'g',
        type: 'gauge',
        datasetId: 'd',
        config: { field: 'a', bands: [{ upTo: 5, color: '#d03b3b' }] },
      },
      { id: 't', type: 'table', datasetId: 'd', config: { columns: ['a', 'b'] } },
      { id: 'k', type: 'kpi', datasetId: 'd', config: { field: 'a', goodWhen: 'down' } },
    ],
    layout: [
      { i: 'c', x: 0, y: 0, w: 6, h: 4 },
      { i: 'g', x: 6, y: 0, w: 3, h: 3 },
      { i: 't', x: 0, y: 4, w: 6, h: 5 },
      { i: 'k', x: 9, y: 0, w: 3, h: 2 },
    ],
  };

  it('parses unchanged: no new fields appear and old values stay as written', () => {
    const doc = parseDashboard(old);
    expect('colors' in doc).toBe(false);
    const chart = doc.widgets[0]!;
    expect(chart.type === 'chart' && chart.config.colors).toEqual(['#AABBCC', '#112233']);
    expect(chart.type === 'chart' && 'referenceLines' in chart.config).toBe(false);
    const table = doc.widgets[2]!;
    expect(table.type === 'table' && table.config).toEqual({ columns: ['a', 'b'], pageSize: 25 });
    const kpi = doc.widgets[3]!;
    expect(kpi.type === 'kpi' && 'bands' in kpi.config).toBe(false);
    // A second round trip is stable, so saving an old document does not rewrite it.
    expect(DashboardDocSchema.parse(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });
});

describe('dashboard-wide colours (setMeta)', () => {
  it('sets, replaces and removes the map', () => {
    const base = emptyDashboard();
    const set = applyOps(base, [{ op: 'setMeta', colors: { Bratislava: 'accent-2' } }]);
    expect(set.doc.colors).toEqual({ Bratislava: 'accent-2' });
    expect(set.changes).toEqual(['Set dashboard colours for 1 entities']);
    const removed = applyOps(set.doc, [{ op: 'setMeta', colors: null }]);
    expect('colors' in removed.doc).toBe(false);
    expect(applyOps(set.doc, [{ op: 'setMeta', colors: {} }]).doc.colors).toBeUndefined();
    expect(applyOps(base, [{ op: 'setMeta', title: 'X' }]).changes).toEqual(['Updated title/description']);
  });

  it('rejects colours that are neither tokens nor hex', () => {
    expect(() => applyOps(emptyDashboard(), [{ op: 'setMeta', colors: { a: 'red' } }])).toThrow();
  });
});
