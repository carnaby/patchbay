import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import {
  type DatasetResult,
  emptyDashboard,
  inferTable,
  type WidgetInput,
  WidgetSchema,
} from '@patchbay/core';
import { Resvg } from '@resvg/resvg-js';
import { describe, expect, it } from 'vitest';
import { renderDashboardPng, renderWidgetPng } from './snapshot.ts';

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
});
