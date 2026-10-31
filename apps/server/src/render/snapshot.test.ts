import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import {
  type DatasetResult,
  emptyDashboard,
  inferTable,
  parseDashboard,
  resolveColor,
  THEMES,
  type WidgetInput,
  WidgetSchema,
} from '@patchbay/core';
import { Resvg } from '@resvg/resvg-js';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { buildTemplate, listTemplates } from '../services/templates.ts';
import {
  DRAW_TIME_MS,
  drawLimits,
  MARK_BUDGET,
  MAX_PIXELS,
  POINT_BUDGET,
  renderDashboardPng,
  renderWidgetPng,
  shareMarks,
} from './snapshot.ts';

// Widget snapshots are 640x360 rendered at 1.5x; boxes below are in SVG coordinates.
const SCALE = 1.5;

interface Image {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** Decodes the 8-bit RGBA, non-interlaced PNGs resvg writes; enough to look at pixels without a dependency. */
function decodePng(png: Buffer): Image {
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString('ascii', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect([data[8], data[9], data[12]]).toEqual([8, 6, 0]);
    } else if (type === 'IDAT') idat.push(data);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rgba = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x]!;
      const a = x >= 4 ? rgba[y * stride + x - 4]! : 0;
      const b = y > 0 ? rgba[(y - 1) * stride + x]! : 0;
      const c = x >= 4 && y > 0 ? rgba[(y - 1) * stride + x - 4]! : 0;
      const p = a + b - c;
      const paeth =
        Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
          ? a
          : Math.abs(p - b) <= Math.abs(p - c)
            ? b
            : c;
      const predictor = [0, a, b, (a + b) >> 1, paeth][filter]!;
      rgba[y * stride + x] = (value + predictor) & 0xff;
    }
  }
  return { width, height, rgba };
}

/** Columns that hold dark pixels (text or marks on the light card) inside an SVG-coordinate box. */
function inkColumns(
  img: Image,
  box: { x: number; y: number; w: number; h: number },
  scale = SCALE,
): number[] {
  const columns: number[] = [];
  for (let x = Math.round(box.x * scale); x < Math.round((box.x + box.w) * scale); x++) {
    for (let y = Math.round(box.y * scale); y < Math.round((box.y + box.h) * scale); y++) {
      const i = (y * img.width + x) * 4;
      const luminance = 0.2126 * img.rgba[i]! + 0.7152 * img.rgba[i + 1]! + 0.0722 * img.rgba[i + 2]!;
      if (luminance < 200) {
        columns.push(x);
        break;
      }
    }
  }
  return columns;
}

const widget = (input: WidgetInput) => WidgetSchema.parse(input);

const result: DatasetResult = {
  datasetId: 'sales',
  table: inferTable([
    { month: 'Jan', revenue: 1200, units: 30 },
    { month: 'Feb', revenue: 1800, units: 42 },
    { month: 'Mar', revenue: 1500, units: 37 },
  ]),
  fetchedAt: new Date(0).toISOString(),
  hash: 'x',
  truncated: false,
};

const render = (input: WidgetInput) =>
  decodePng(renderWidgetPng(widget(input), input.type === 'text' ? undefined : result));

// The card title is drawn at (14, 24) in 14 px semibold; widget bodies start at (14, 36).
const TITLE = { x: 14, y: 8, w: 400, h: 22 };

describe('snapshot text', () => {
  it('draws titles, KPI values, table cells, text widgets and chart axis labels', () => {
    const kpi = render({
      id: 'k',
      type: 'kpi',
      title: 'Revenue',
      datasetId: 'sales',
      config: { field: 'revenue' },
    });
    expect(inkColumns(kpi, TITLE).length).toBeGreaterThan(20);
    expect(inkColumns(kpi, { x: 14, y: 36, w: 300, h: 45 }).length).toBeGreaterThan(40);

    const table = render({ id: 't', type: 'table', title: 'Orders', datasetId: 'sales', config: {} });
    expect(inkColumns(table, TITLE).length).toBeGreaterThan(20);
    // First data row, below the header rule; the rule itself is too light to count as ink.
    expect(inkColumns(table, { x: 14, y: 60, w: 600, h: 18 }).length).toBeGreaterThan(30);

    const text = render({
      id: 'x',
      type: 'text',
      title: 'Notes',
      config: { markdown: 'Revenue grew in March.' },
    });
    expect(inkColumns(text, { x: 14, y: 40, w: 600, h: 18 }).length).toBeGreaterThan(40);

    const chart = render({
      id: 'c',
      type: 'chart',
      title: 'Revenue by month',
      datasetId: 'sales',
      config: { kind: 'line', x: 'month', y: ['revenue'] },
    });
    expect(inkColumns(chart, TITLE).length).toBeGreaterThan(40);
    // Category labels under the x axis: a strip that holds no marks, only text.
    expect(inkColumns(chart, { x: 14, y: 326, w: 612, h: 18 }).length).toBeGreaterThan(20);
  });

  it('uses the bundled Inter, whatever fonts the machine has', () => {
    const title = 'Snapshot fonts';
    const snapshot = render({ id: 'x', type: 'text', title, config: { markdown: '' } });
    // The same string set in the bundled Inter SemiBold alone, at the card title's position and size.
    const reference = decodePng(
      new Resvg(
        `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="40"><rect width="640" height="40" fill="#fff"/><text x="14" y="24" font-family="Inter" font-size="14" font-weight="600">${title}</text></svg>`,
        {
          font: {
            loadSystemFonts: false,
            fontFiles: [fileURLToPath(new URL('./fonts/Inter-SemiBold.ttf', import.meta.url))],
          },
          fitTo: { mode: 'zoom', value: SCALE },
        },
      )
        .render()
        .asPng(),
    );
    const want = inkColumns(reference, TITLE);
    const got = inkColumns(snapshot, TITLE);
    expect(want.length).toBeGreaterThan(50);
    // A fallback font (or none) changes where the title starts and ends; Inter puts it exactly here.
    expect(Math.abs(got[0]! - want[0]!)).toBeLessThanOrEqual(1);
    expect(Math.abs(got.at(-1)! - want.at(-1)!)).toBeLessThanOrEqual(1);
  });

  it('draws the dashboard title', () => {
    const img = decodePng(renderDashboardPng(emptyDashboard('Sales analytics'), new Map()));
    // Dashboard snapshots are not scaled; the title sits at (16, 40) in 22 px bold.
    expect(inkColumns(img, { x: 16, y: 20, w: 200, h: 26 }, 1).length).toBeGreaterThan(80);
  });
});

describe('map snapshots', () => {
  /** The colour under a longitude/latitude in a 640x360 widget snapshot with the world view. */
  function pixelAt(img: Image, lon: number, lat: number, top = 4): number[] {
    // The body starts at (14, 36) and is 612x310; the geo box keeps 4 px on the other sides (`top` makes room for a
    // caption) and fits the world view's 360x144 degrees into it without distortion.
    const box = { x: 18, y: 36 + top, w: 604, h: 306 - top };
    const scale = Math.min(box.w / 360, box.h / 144);
    const x = box.x + (box.w - 360 * scale) / 2 + (lon + 180) * scale;
    const y = box.y + (box.h - 144 * scale) / 2 + (84 - lat) * scale;
    const i = (Math.round(y * SCALE) * img.width + Math.round(x * SCALE)) * 4;
    return [img.rgba[i]!, img.rgba[i + 1]!, img.rgba[i + 2]!];
  }
  const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const near = (got: number[], hex: string, tolerance = 12) =>
    got.every((v, i) => Math.abs(v - rgb(hex)[i]!) <= tolerance);
  const mapResult = (rows: Record<string, unknown>[]): DatasetResult => ({
    datasetId: 'm',
    table: inferTable(rows as never, { types: { time: 'time' } }),
    fetchedAt: new Date(0).toISOString(),
    hash: 'm',
    truncated: false,
  });

  it('draws the bundled base map and the points where they belong', () => {
    const img = decodePng(
      renderWidgetPng(
        widget({
          id: 'quakes',
          type: 'map',
          title: 'Earthquakes',
          datasetId: 'm',
          config: { lat: 'latitude', lon: 'longitude', label: 'place', view: 'world' },
        }),
        mapResult([
          { place: 'Indian Ocean', latitude: -40, longitude: 100 },
          { place: 'South Pacific', latitude: -10, longitude: -120 },
        ]),
      ),
    );
    // Central Africa is land, the mid-Atlantic is ocean (the card background), the quakes are dots.
    expect(near(pixelAt(img, 22, 2), '#e1e0d9')).toBe(true);
    expect(near(pixelAt(img, -30, 0), '#fcfcfb')).toBe(true);
    // Dots are drawn at 85 % opacity.
    expect(near(pixelAt(img, 100, -40), '#2a78d6', 40)).toBe(true);
    expect(near(pixelAt(img, -120, -10), '#2a78d6', 40)).toBe(true);
  });

  it('shades the night for the time of the data and draws the track', () => {
    // Around noon UTC at the March equinox: day around Greenwich, night around the antimeridian.
    const img = decodePng(
      renderWidgetPng(
        widget({
          id: 'iss',
          type: 'map',
          title: 'Track',
          datasetId: 'm',
          config: { lat: 'latitude', lon: 'longitude', mode: 'track', terminator: true, view: 'world' },
        }),
        mapResult(
          Array.from({ length: 40 }, (_, i) => ({
            time: Date.UTC(2024, 2, 20, 11) + i * 90_000,
            latitude: 0,
            longitude: -100 + i * 5,
          })),
        ),
      ),
    );
    // The "Night shading for …" caption takes the top 26 px.
    const day = pixelAt(img, -30, -30, 26);
    const night = pixelAt(img, -150, -30, 26);
    expect(near(day, '#fcfcfb')).toBe(true);
    expect(night[0]!).toBeLessThan(day[0]! - 15);
    // The track runs along the equator in the first palette colour.
    expect(near(pixelAt(img, -20, 0, 26), '#2a78d6', 40)).toBe(true);
  });

  it('draws a zoomed-in map inside a dashboard, with the dashboard colour of each entity', () => {
    // Two cities a few degrees apart: `fit` zooms in about twelvefold, so the land runs far beyond the card.
    const rows = [
      { city: 'Bratislava', lat: 48.15, lon: 17.11 },
      { city: 'Kosice', lat: 48.72, lon: 21.26 },
    ];
    const doc = parseDashboard({
      ...emptyDashboard('Cities'),
      colors: { Kosice: 'accent-5' },
      datasets: [
        {
          id: 'cities',
          name: 'Cities',
          source: { kind: 'inline', rows },
        },
      ],
      widgets: [
        {
          id: 'map',
          type: 'map',
          datasetId: 'cities',
          config: { lat: 'lat', lon: 'lon', series: 'city' },
        },
      ],
      layout: [{ i: 'map', x: 0, y: 0, w: 6, h: 5 }],
    });
    const results = new Map([['cities', { ...mapResult(rows), datasetId: 'cities' }]]);
    const img = decodePng(renderDashboardPng(doc, results));
    // Dashboard snapshots are not scaled, and pixelsOf expects widget coordinates: divide the card's box by SCALE.
    const card = { x: 12 / SCALE, y: 64 / SCALE, w: 620 / SCALE, h: 388 / SCALE };
    expect(pixelsOf(img, '#e1e0d9', card)).toBeGreaterThan(20_000);
    // Dots are drawn at 85 % opacity over the land: Bratislava takes the first free slot, Kosice its dashboard colour.
    const onLand = (hex: string) =>
      `#${[1, 3, 5]
        .map(
          (i) =>
            Number.parseInt(hex.slice(i, i + 2), 16) * 0.85 +
            Number.parseInt('e1e0d9'.slice(i - 1, i + 1), 16) * 0.15,
        )
        .map((v) => Math.round(v).toString(16).padStart(2, '0'))
        .join('')}`;
    expect(pixelsOf(img, onLand(THEMES.light.categorical[0]!), card)).toBeGreaterThan(10);
    expect(pixelsOf(img, onLand(THEMES.light.categorical[4]!), card)).toBeGreaterThan(10);
  });
});

/** Pixels within a small distance of a colour, optionally inside an SVG-coordinate box. */
function pixelsOf(img: Image, hex: string, box?: { x: number; y: number; w: number; h: number }): number {
  const want = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const x0 = box ? Math.round(box.x * SCALE) : 0;
  const y0 = box ? Math.round(box.y * SCALE) : 0;
  const x1 = box ? Math.round((box.x + box.w) * SCALE) : img.width;
  const y1 = box ? Math.round((box.y + box.h) * SCALE) : img.height;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4;
      if (want.every((v, c) => Math.abs(img.rgba[i + c]! - v) <= 6)) n++;
    }
  }
  return n;
}

describe('snapshot colours', () => {
  for (const mode of ['light', 'dark'] as const) {
    const theme = THEMES[mode];
    const draw = (input: WidgetInput, entityColors?: Record<string, string>) =>
      decodePng(renderWidgetPng(widget(input), result, { theme: mode, entityColors }));

    it(`draws mapped series colours and a reference line in ${mode}`, () => {
      const img = draw({
        id: 'c',
        type: 'chart',
        title: 'Revenue',
        datasetId: 'sales',
        config: {
          kind: 'bar',
          x: 'month',
          y: ['revenue'],
          colors: { revenue: 'accent-3' },
          referenceLines: [{ value: 2500, label: 'Target', color: 'negative' }],
        },
      });
      expect(pixelsOf(img, theme.categorical[2]!)).toBeGreaterThan(2000);
      expect(pixelsOf(img, theme.categorical[0]!)).toBe(0);
      // The dashed line above every bar: the axis was widened to show it.
      expect(pixelsOf(img, theme.status.critical, { x: 60, y: 36, w: 560, h: 120 })).toBeGreaterThan(100);
    });

    it(`uses dashboard entity colours in widget snapshots in ${mode}`, () => {
      const img = draw(
        { id: 'c', type: 'chart', datasetId: 'sales', config: { kind: 'bar', x: 'month', y: ['units'] } },
        { units: 'accent-5' },
      );
      expect(pixelsOf(img, theme.categorical[4]!)).toBeGreaterThan(2000);
    });

    it(`colours a KPI value from its bands with contrast in ${mode}`, () => {
      const img = draw({
        id: 'k',
        type: 'kpi',
        datasetId: 'sales',
        config: { field: 'revenue', bands: [{ upTo: 2000, color: 'warning' }] },
      });
      expect(
        pixelsOf(img, resolveColor('warning', theme, 'text'), { x: 14, y: 36, w: 300, h: 50 }),
      ).toBeGreaterThan(100);
    });

    it(`tints table cells from rules in ${mode}`, () => {
      const img = draw({
        id: 't',
        type: 'table',
        datasetId: 'sales',
        config: {
          columns: [{ field: 'month', label: 'Month' }, 'revenue'],
          rules: [{ when: 'revenue > 1600', color: 'positive' }],
        },
      });
      // Only the February row (the second) is tinted.
      const fill = resolveColor('positive', theme, 'fill');
      expect(pixelsOf(img, fill, { x: 10, y: 78, w: 600, h: 18 })).toBeGreaterThan(3000);
      expect(pixelsOf(img, fill, { x: 10, y: 58, w: 600, h: 18 })).toBe(0);
    });
  }
});

describe('start page widget snapshots', () => {
  it('draws a digital and an analog clock filling the card', () => {
    // A fixed time: how wide the digits are depends on which they are, and 11:11 is a lot narrower than 08:48.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-15T07:48:00Z'));
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const digital = render({ id: 'c', type: 'clock', config: { timeZone: 'Europe/Bratislava' } });
    // The time is the widest text: it spans most of the card's width in the middle band.
    expect(inkColumns(digital, { x: 14, y: 90, w: 612, h: 120 }).length).toBeGreaterThan(400);
    // An untitled clock has no title row text (the id is not shown).
    expect(inkColumns(digital, TITLE).length).toBe(0);

    const analog = render({
      id: 'a',
      type: 'clock',
      title: 'Tokyo',
      config: { style: 'analog', timeZone: 'Asia/Tokyo' },
    });
    expect(inkColumns(analog, TITLE).length).toBeGreaterThan(20);
    // The face is a circle centred in the body: ink in the middle, nothing at the far left edge.
    expect(inkColumns(analog, { x: 250, y: 60, w: 140, h: 250 }).length).toBeGreaterThan(150);
    expect(inkColumns(analog, { x: 14, y: 60, w: 100, h: 250 }).length).toBe(0);
  });

  it('draws the search field with its placeholder', () => {
    const img = render({ id: 's', type: 'search', config: { engine: 'duckduckgo' } });
    // Untitled: the field starts at the top padding, no empty title row.
    expect(inkColumns(img, { x: 48, y: 14, w: 300, h: 40 }).length).toBeGreaterThan(60);
  });
});

describe('list-style table snapshots', () => {
  it('draws headlines with a muted line under each', () => {
    const now = Date.now();
    const feed: DatasetResult = {
      datasetId: 'news',
      table: inferTable(
        [0, 1, 2].map((i) => ({
          title: `Headline number ${i}`,
          link: `https://x.example/${i}`,
          source: 'X',
          published: now - i * 3_600_000,
        })),
        { types: { published: 'time' } },
      ),
      fetchedAt: new Date(now).toISOString(),
      hash: 'f',
      truncated: false,
    };
    const img = decodePng(
      renderWidgetPng(
        widget({
          id: 'h',
          type: 'table',
          title: 'News',
          datasetId: 'news',
          config: { style: 'list', columns: [{ field: 'title', link: 'link' }, 'source', 'published'] },
        }),
        feed,
      ),
    );
    // Title line, then the meta line ("X · 1 hour ago") of the second item, 42 px apart.
    expect(inkColumns(img, { x: 14, y: 38, w: 300, h: 16 }).length).toBeGreaterThan(80);
    expect(inkColumns(img, { x: 14, y: 42 + 56, w: 200, h: 14 }).length).toBeGreaterThan(30);
    // No header row as in table style: the strip right under the title row is empty.
    expect(inkColumns(img, { x: 300, y: 36, w: 300, h: 16 }).length).toBe(0);
  });
});

describe('snapshot budgets', () => {
  /** Width and height from the PNG header, without decoding a possibly large image. */
  const size = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
  const textDoc = (layout: { x: number; y: number; w: number; h: number }[]) =>
    parseDashboard({
      ...emptyDashboard('Tall'),
      widgets: layout.map((_, n) => ({
        id: `t${n}`,
        type: 'text',
        title: `Note ${n}`,
        config: { markdown: 'hi' },
      })),
      layout: layout.map((it, n) => ({ i: `t${n}`, ...it })),
    });

  it('keeps every template at the size it always had', () => {
    for (const { id } of listTemplates()) {
      const doc = buildTemplate(id);
      const bottom = doc.layout.reduce((m, it) => Math.max(m, it.y + it.h), 0);
      expect(size(renderDashboardPng(doc, new Map()))).toEqual({
        width: 1280,
        height: 64 + bottom * 80 + 24,
      });
    }
  });

  it('adds one credit line under dashboards that use connectors with an attribution', () => {
    const doc = parseDashboard({
      ...emptyDashboard('Weather'),
      datasets: [
        { id: 'w', name: 'Weather', source: { kind: 'connector', connector: 'weather-now', params: {} } },
      ],
      widgets: [{ id: 'v', type: 'kpi', datasetId: 'w', config: { field: 'temperature' } }],
      layout: [{ i: 'v', x: 0, y: 0, w: 6, h: 2 }],
    });
    const credits = { attributions: { 'weather-now': 'Open-Meteo' } };
    const without = renderDashboardPng(doc, new Map());
    const withCredit = renderDashboardPng(doc, new Map(), credits);
    expect(size(withCredit).height).toBe(size(without).height + 26);
    expect(withCredit.equals(without)).toBe(false);
    // No credit for a source that is not on the dashboard, or when nothing says what to credit.
    expect(
      renderDashboardPng(doc, new Map(), { attributions: { crypto: 'CoinGecko' } }).equals(without),
    ).toBe(true);
    expect(renderDashboardPng(textDoc([{ x: 0, y: 0, w: 6, h: 2 }]), new Map(), credits).length).toBe(
      renderDashboardPng(textDoc([{ x: 0, y: 0, w: 6, h: 2 }]), new Map()).length,
    );
  });

  it('draws a widget stored far down where the browser shows it, at the top', () => {
    const started = Date.now();
    const far = renderDashboardPng(textDoc([{ x: 0, y: 10_000, w: 1, h: 2 }]), new Map());
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(size(far)).toEqual({ width: 1280, height: 64 + 2 * 80 + 24 });
    expect(far.equals(renderDashboardPng(textDoc([{ x: 0, y: 0, w: 1, h: 2 }]), new Map()))).toBe(true);
  });

  it('cuts a dashboard taller than the pixel budget off and says so', () => {
    // The largest layout the schema allows: 60 full-width widgets of 40 rows, 2 400 rows after compaction.
    const tall = Array.from({ length: 60 }, (_, n) => ({ x: 0, y: n * 40, w: 12, h: 40 }));
    const started = Date.now();
    const png = renderDashboardPng(textDoc(tall), new Map());
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(size(png)).toEqual({ width: 1280, height: Math.floor(MAX_PIXELS / 1280) });
    const img = decodePng(png);
    // The note sits centred in the bottom 40 px.
    expect(inkColumns(img, { x: 440, y: img.height - 30, w: 400, h: 20 }, 1).length).toBeGreaterThan(100);
  });

  it('keeps a wider snapshot within the same number of pixels', () => {
    const tall = Array.from({ length: 10 }, (_, n) => ({ x: 0, y: n * 40, w: 12, h: 40 }));
    for (const width of [2560, 100_000]) {
      const got = size(renderDashboardPng(textDoc(tall), new Map(), { width }));
      expect(got.width).toBe(2560);
      expect(got.width * got.height).toBeLessThanOrEqual(MAX_PIXELS);
    }
  });

  it('scales a large widget down instead of exceeding the budget', () => {
    const big = size(
      renderWidgetPng(widget({ id: 't', type: 'text', config: { markdown: 'hi' } }), undefined, {
        width: 50_000,
        height: 50_000,
      }),
    );
    expect(big.width * big.height).toBeLessThanOrEqual(MAX_PIXELS);
    // The default size is untouched: 640x360 at 1.5x.
    const normal = render({ id: 't', type: 'text', config: { markdown: 'hi' } });
    expect({ width: normal.width, height: normal.height }).toEqual({ width: 960, height: 540 });
  });

  it('shares the mark budget fairly and leaves small widgets alone', () => {
    expect(
      shareMarks(
        new Map([
          ['a', 5000],
          ['b', 5000],
          ['c', 0],
        ]),
      ),
    ).toEqual(new Map());
    const limits = shareMarks(
      new Map([
        ['small', 100],
        ['big', 20_000],
        ['huge', 20_000],
      ]),
      10_000,
    );
    expect(limits.get('small')).toBeUndefined();
    expect(limits.get('big')! + limits.get('huge')!).toBeLessThanOrEqual(9_900);
    const many = shareMarks(
      new Map(Array.from({ length: 60 }, (_, n) => [`w${n}`, 10_000] as [string, number])),
    );
    expect([...many.values()].reduce((s, v) => s + v, 0)).toBeLessThanOrEqual(MARK_BUDGET);
  });

  it('renders sixty scatter charts of ten thousand rows in bounded time', () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => ({ x: (i * 37) % 1000, y: (i * 91) % 1000 }));
    const results = new Map([
      [
        'd',
        {
          datasetId: 'd',
          table: inferTable(rows),
          fetchedAt: new Date(0).toISOString(),
          hash: 'd',
          truncated: false,
        },
      ],
    ]);
    const doc = parseDashboard({
      ...emptyDashboard('Dots'),
      datasets: [{ id: 'd', name: 'd', source: { kind: 'inline', rows: [] } }],
      widgets: Array.from({ length: 60 }, (_, n) => ({
        id: `c${n}`,
        type: 'chart',
        datasetId: 'd',
        config: { kind: 'scatter', x: 'x', y: ['y'], maxPoints: 20_000 },
      })),
      layout: Array.from({ length: 60 }, (_, n) => ({ i: `c${n}`, x: (n * 2) % 12, y: 0, w: 2, h: 2 })),
    });
    const started = Date.now();
    renderDashboardPng(doc, results);
    // Without the mark budget this took about 15 s and 1.9 GB.
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  describe('across chart kinds', () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => ({
      x: i,
      y: (i * 37) % 1000,
      z: (i * 7919) % 1000,
      s: `s${i % 12}`,
      two: i % 2 ? 'odd' : 'even',
    }));
    const data: DatasetResult = {
      datasetId: 'u',
      table: inferTable(rows),
      fetchedAt: new Date(0).toISOString(),
      hash: 'u',
      truncated: false,
    };
    const chart = (id: string, config: Record<string, unknown>) =>
      WidgetSchema.parse({
        id,
        type: 'chart',
        datasetId: 'u',
        config: { x: 'x', y: ['y'], maxPoints: 20_000, ...config },
      });
    const KINDS = ['scatter', 'line', 'bar', 'heatmap', 'area', 'scatter'];
    /** The dashboard that stalled production for 7 s a render: one upload, sixty charts asking for every row. */
    const heavy = () => {
      const widgets = Array.from({ length: 60 }, (_, i) =>
        chart(`w${i}`, {
          kind: KINDS[i % KINDS.length],
          y: ['y', 'z'],
          ...(i % 3 === 0 ? { series: 's' } : {}),
        }),
      );
      return parseDashboard({
        ...emptyDashboard('Heavy'),
        datasets: [{ id: 'u', name: 'u', source: { kind: 'inline', rows: [] } }],
        widgets,
        layout: widgets.map((w, i) => ({ i: w.id, x: (i % 4) * 3, y: Math.floor(i / 4) * 3, w: 3, h: 3 })),
      });
    };

    it('counts a mark per y field and a line point per series', () => {
      const limits = drawLimits(
        [
          chart('dots', { kind: 'scatter', y: ['y', 'z'] }),
          chart('split', { kind: 'scatter', series: 's' }),
          chart('line', { kind: 'line', y: ['y', 'z'] }),
          chart('lines', { kind: 'line', series: 'two' }),
        ].map((w) => ({ widget: w, result: data })),
        { marks: 6_000, points: 8_000 },
      );
      // Marks: 20 000 for two y fields and 10 000 split by series share 6 000 evenly.
      expect(limits.get('dots')).toBe(1_500);
      expect(limits.get('split')).toBe(3_000);
      // Points: each line chart has two series, so 4 000 points are 2 000 rows.
      expect(limits.get('line')).toBe(2_000);
      expect(limits.get('lines')).toBe(2_000);
    });

    it('leaves charts alone that draw a few aggregates, and small ones', () => {
      const limits = drawLimits(
        [
          chart('pie', { kind: 'pie' }),
          chart('radar', { kind: 'radar' }),
          chart('small', { kind: 'scatter', maxPoints: 100 }),
        ].map((w) => ({ widget: w, result: data })),
      );
      expect(limits).toEqual(new Map());
    });

    it('trims a single widget snapshot to the same budgets', () => {
      const many = chart('many', { kind: 'line', series: 's', maxPoints: 20_000 });
      // Ten thousand rows of nine series (eight and the folded rest) are 90 000 points: within the budget.
      expect(drawLimits([{ widget: many, result: data }])).toEqual(new Map());
      const dots = chart('dots', { kind: 'scatter', y: ['y', 'z'] });
      expect(drawLimits([{ widget: dots, result: data }]).get('dots')).toBe(MARK_BUDGET / 2);
      expect(POINT_BUDGET).toBeGreaterThanOrEqual(90_000);
    });

    it('draws the heaviest dashboard well within the render time limit', () => {
      const started = Date.now();
      renderDashboardPng(heavy(), new Map([['u', data]]));
      // It took 5 s on a desktop and 7 s on the production NAS before the line budget and the lower mark budget.
      expect(Date.now() - started).toBeLessThan(DRAW_TIME_MS);
    }, 20_000);

    it('leaves out the charts left once the time or SVG size is spent, and says so', () => {
      const results = new Map([['u', data]]);
      const started = Date.now();
      const outOfTime = renderDashboardPng(heavy(), results, { drawTimeMs: -1 });
      expect(Date.now() - started).toBeLessThan(5_000);
      // Either backstop leaves the same cards: every chart replaced by its note.
      expect(outOfTime.equals(renderDashboardPng(heavy(), results, { svgBytes: 0 }))).toBe(true);
      const img = decodePng(outOfTime);
      // The first card's body holds the note's text, not a chart: ink in its first line, none further down.
      expect(inkColumns(img, { x: 26, y: 100, w: 250, h: 14 }, 1).length).toBeGreaterThan(100);
      expect(inkColumns(img, { x: 26, y: 140, w: 250, h: 80 }, 1).length).toBe(0);
    });
  });
});
