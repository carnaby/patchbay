/// <reference types="node" />
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildMapOption,
  describeMap,
  emptyDashboard,
  escapeHtml,
  inferTable,
  type MapConfig,
  MapConfigSchema,
  mapBounds,
  mapRows,
  mapTableColumns,
  mapTime,
  nightPolygon,
  parseDashboard,
  subsolarPoint,
  THEMES,
  trackSegments,
  WORLD_MAP,
} from './index.ts';

const GEO = fileURLToPath(new URL('../geo/world-110m.json', import.meta.url).href);
const theme = THEMES.light;
const config = (input: Partial<MapConfig> = {}) =>
  MapConfigSchema.parse({ lat: 'latitude', lon: 'longitude', ...input });

type Series = {
  id: string;
  type: string;
  name?: string;
  data: unknown[];
  large?: boolean;
  renderItem?: (params: unknown, api: unknown) => { shape: { points: number[][] } };
};
const seriesOf = (option: Record<string, unknown>) => option.series as Series[];

const quakes = inferTable(
  [
    {
      time: Date.UTC(2026, 9, 27, 10),
      place: 'Near <b>Tokyo</b>',
      magnitude: 6.1,
      depth: 30,
      latitude: 35.6,
      longitude: 139.7,
    },
    {
      time: Date.UTC(2026, 9, 27, 11),
      place: 'Iceland',
      magnitude: 2.5,
      depth: 5,
      latitude: 64.1,
      longitude: -21.9,
    },
    {
      time: Date.UTC(2026, 9, 27, 12),
      place: 'Chile',
      magnitude: 4.3,
      depth: 80,
      latitude: -33.4,
      longitude: -70.6,
    },
    {
      time: Date.UTC(2026, 9, 27, 13),
      place: 'Nowhere',
      magnitude: 3,
      depth: 1,
      latitude: null,
      longitude: 12,
    },
  ],
  { types: { time: 'time' } },
);

describe('base map data', () => {
  const raw = readFileSync(GEO, 'utf8');
  const geo = JSON.parse(raw) as {
    type: string;
    features: {
      type: string;
      properties: Record<string, unknown>;
      geometry: { type: string; coordinates: unknown };
    }[];
  };

  it('is a GeoJSON FeatureCollection of polygons that carry only iso_a3', () => {
    expect(geo.type).toBe('FeatureCollection');
    expect(geo.features.length).toBeGreaterThan(150);
    for (const f of geo.features) {
      expect(f.type).toBe('Feature');
      expect(Object.keys(f.properties)).toEqual(['iso_a3']);
      expect(f.properties.iso_a3).toMatch(/^[A-Z]{3}$/);
      expect(['Polygon', 'MultiPolygon']).toContain(f.geometry.type);
    }
    expect(geo.features.map((f) => f.properties.iso_a3)).toEqual(
      expect.arrayContaining(['FRA', 'NOR', 'SVK']),
    );
  });

  it('stays within its size budget, so a higher-resolution export fails here', () => {
    expect(statSync(GEO).size).toBeLessThanOrEqual(300 * 1024);
  });

  it('has closed rings with coordinates in range', () => {
    for (const f of geo.features) {
      const polygons = (
        f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates
      ) as number[][][][];
      for (const ring of polygons.flat()) {
        expect(ring.length).toBeGreaterThanOrEqual(4);
        expect(ring[0]).toEqual(ring.at(-1));
        for (const [lon, lat] of ring) {
          expect(Math.abs(lon!)).toBeLessThanOrEqual(180);
          expect(Math.abs(lat!)).toBeLessThanOrEqual(90);
        }
      }
    }
  });
});

describe('trackSegments', () => {
  it('keeps a track that never crosses the antimeridian in one piece', () => {
    expect(
      trackSegments([
        [10, 0],
        [20, 5],
        [30, 10],
      ]),
    ).toEqual([
      [
        [10, 0],
        [20, 5],
        [30, 10],
      ],
    ]);
  });

  it('splits an eastward crossing at +180 and resumes at -180 with the interpolated latitude', () => {
    const [a, b] = trackSegments([
      [170, 0],
      [-170, 10],
    ]);
    expect(a).toEqual([
      [170, 0],
      [180, 5],
    ]);
    expect(b).toEqual([
      [-180, 5],
      [-170, 10],
    ]);
  });

  it('splits a westward crossing at -180 and resumes at +180', () => {
    const [a, b] = trackSegments([
      [-175, 20],
      [175, 30],
    ]);
    expect(a).toEqual([
      [-175, 20],
      [-180, 25],
    ]);
    expect(b).toEqual([
      [180, 25],
      [175, 30],
    ]);
  });

  it('handles a position exactly on the antimeridian without an empty segment', () => {
    const segments = trackSegments([
      [170, 0],
      [180, 4],
      [-170, 8],
    ]);
    expect(segments).toEqual([
      [
        [170, 0],
        [180, 4],
      ],
      [
        [-180, 4],
        [-170, 8],
      ],
    ]);
  });

  it('splits repeated crossings (an orbit) into one segment per lap', () => {
    const orbit: [number, number][] = [];
    for (let i = 0; i < 200; i++) orbit.push([((((i * 10) % 360) + 360) % 360) - 180, Math.sin(i / 10) * 50]);
    const segments = trackSegments(orbit);
    expect(segments.length).toBe(Math.ceil(200 / 36));
    for (const s of segments) {
      for (let i = 1; i < s.length; i++) expect(Math.abs(s[i]![0] - s[i - 1]![0])).toBeLessThanOrEqual(180);
    }
  });
});

describe('solar position', () => {
  it('matches the declination at both solstices and an equinox within 0.5°', () => {
    expect(subsolarPoint(Date.UTC(2024, 5, 20, 20, 51)).lat).toBeCloseTo(23.44, 0);
    expect(Math.abs(subsolarPoint(Date.UTC(2024, 5, 20, 20, 51)).lat - 23.44)).toBeLessThan(0.5);
    expect(Math.abs(subsolarPoint(Date.UTC(2024, 11, 21, 9, 21)).lat + 23.44)).toBeLessThan(0.5);
    expect(Math.abs(subsolarPoint(Date.UTC(2024, 2, 20, 3, 6)).lat)).toBeLessThan(0.5);
  });

  it('puts the sun over Greenwich at noon UTC when the equation of time is small', () => {
    // Mid-April the equation of time is close to zero.
    expect(Math.abs(subsolarPoint(Date.UTC(2024, 3, 15, 12)).lon)).toBeLessThan(0.5);
    // Early November the sun runs about 16 minutes ahead, i.e. 4° west at noon UTC.
    expect(subsolarPoint(Date.UTC(2024, 10, 3, 12)).lon).toBeCloseTo(-4.1, 0);
    // Six hours later it is a quarter of the way round.
    expect(Math.abs(subsolarPoint(Date.UTC(2024, 3, 15, 18)).lon + 90)).toBeLessThan(0.5);
  });

  it('draws the night as a closed ring over the pole in darkness', () => {
    const june = nightPolygon(Date.UTC(2024, 5, 21, 12));
    expect(june[0]).toEqual(june.at(-1));
    expect(june).toContainEqual([180, -90]);
    expect(june.some(([, lat]) => lat === 90)).toBe(false);
    const december = nightPolygon(Date.UTC(2024, 11, 21, 12));
    expect(december).toContainEqual([180, 90]);
    // At noon UTC the night side is centred on the antimeridian: the terminator crosses the equator near ±90°.
    const equinox = nightPolygon(Date.UTC(2024, 2, 20, 12));
    const at = (lon: number) => equinox.find((p) => p[0] === lon)![1];
    expect(Math.abs(at(-180))).toBeGreaterThan(80);
    expect(Math.abs(at(0))).toBeGreaterThan(80);
    expect(Math.abs(at(90) - at(-90))).toBeGreaterThan(100);
  });
});

describe('mapRows, mapTime and describeMap', () => {
  it('skips rows without valid coordinates and counts them', () => {
    const { rows, skipped } = mapRows(config(), quakes);
    expect(rows.map((r) => r.place)).toEqual(['Near <b>Tokyo</b>', 'Iceland', 'Chile']);
    expect(skipped).toBe(1);
    const outOfRange = inferTable([
      { latitude: 91, longitude: 0 },
      { latitude: 0, longitude: -181 },
    ]);
    expect(mapRows(config(), outOfRange).skipped).toBe(2);
  });

  it('keeps the newest maxPoints rows', () => {
    const many = inferTable(Array.from({ length: 30 }, (_, i) => ({ i, latitude: i, longitude: i })));
    expect(mapRows(config({ maxPoints: 10 }), many).rows.map((r) => r.i)).toEqual(
      Array.from({ length: 10 }, (_, i) => 20 + i),
    );
  });

  it('times the night shading by the data, not the clock', () => {
    expect(mapTime(quakes)).toBe(Date.UTC(2026, 9, 27, 13));
    expect(mapTime(inferTable([{ latitude: 1, longitude: 2 }]), '2026-10-27T14:05:00.000Z')).toBe(
      Date.UTC(2026, 9, 27, 14, 5),
    );
    expect(mapTime(inferTable([{ latitude: 1, longitude: 2 }]))).toBeUndefined();
  });

  it('describes points, tracks, skipped rows and the shading time', () => {
    expect(
      describeMap(config({ size: 'magnitude', terminator: true }), quakes, Date.UTC(2026, 9, 27, 14, 5)),
    ).toBe(
      'Map of 3 points between 33.4°S and 64.1°N, sized by magnitude. 1 row without coordinates left out. Night shading for 14:05 UTC.',
    );
    expect(describeMap(config({ mode: 'track' }), quakes)).toBe(
      'Track of 3 positions; latest 33.4°S, 70.6°W at 12:00 UTC. 1 row without coordinates left out.',
    );
    expect(describeMap(config(), inferTable([]))).toBe('Map with no points.');
  });

  it('lists the table alternative columns in reading order', () => {
    expect(mapTableColumns(config({ label: 'place', size: 'magnitude', color: 'depth' }), quakes)).toEqual([
      'place',
      'latitude',
      'longitude',
      'magnitude',
      'depth',
    ]);
    expect(mapTableColumns(config({ mode: 'track' }), quakes)).toEqual(['time', 'latitude', 'longitude']);
  });
});

describe('buildMapOption', () => {
  it('draws points on the registered world map, framed around the data', () => {
    const option = buildMapOption(config(), quakes, theme);
    const geo = option.geo as Record<string, any>;
    expect(geo.map).toBe(WORLD_MAP);
    expect(geo.aspectScale).toBe(1);
    expect(geo.roam).toBe(false);
    expect(geo.itemStyle).toMatchObject({ areaColor: theme.grid, borderColor: theme.surface });
    const [points] = seriesOf(option);
    expect(points).toMatchObject({ type: 'scatter', id: 'points:' });
    expect(points!.data).toEqual([
      [139.7, 35.6, '-'],
      [-21.9, 64.1, '-'],
      [-70.6, -33.4, '-'],
    ]);
    // 70.6°W to 139.7°E plus 10 % on each side, centred on the data.
    const [[west, north], [east, south]] = geo.boundingCoords;
    expect(east - west).toBeCloseTo(210.3 * 1.2);
    expect((west + east) / 2).toBeCloseTo((139.7 - 70.6) / 2);
    expect(north - south).toBeCloseTo(97.5 * 1.2);
  });

  it('gives a single point the minimum span instead of zooming to street level', () => {
    const one = mapBounds(config(), [[17.1, 48.1]]);
    expect(one[1][0] - one[0][0]).toBeCloseTo(30);
    expect(one[0][1] - one[1][1]).toBeCloseTo(15);
    expect((one[0][0] + one[1][0]) / 2).toBeCloseTo(17.1);
    // Near the edge of the world the frame shifts instead of leaving it.
    const edge = mapBounds(config(), [[179, 89]]);
    expect(edge[1][0]).toBe(180);
    expect(edge[0][1]).toBe(90);
    expect(mapBounds(config({ view: 'world' }), [[17.1, 48.1]])).toEqual([
      [-180, 84],
      [180, -60],
    ]);
  });

  it('hides borders for land only and the land itself for none', () => {
    const land = buildMapOption(config({ basemap: 'land' }), quakes, theme).geo as Record<string, any>;
    expect(land.itemStyle.borderColor).toBe(theme.grid);
    const none = buildMapOption(config({ basemap: 'none' }), quakes, theme).geo as Record<string, any>;
    expect(none.itemStyle.areaColor).toBe('transparent');
  });

  it('sizes dots by area, biggest first, with a size legend', () => {
    const option = buildMapOption(config({ size: 'magnitude' }), quakes, theme);
    const data = seriesOf(option)[0]!.data as { value: number[]; symbolSize: number }[];
    expect(data.map((d) => d.value[0])).toEqual([139.7, -70.6, -21.9]);
    expect(data[0]!.symbolSize).toBeCloseTo(24);
    expect(data[2]!.symbolSize).toBeCloseTo(4);
    // Area, not diameter, grows linearly: the middle value gets half the extra area.
    const mid = Math.sqrt(16 + (576 - 16) * ((4.3 - 2.5) / (6.1 - 2.5)));
    expect(data[1]!.symbolSize).toBeCloseTo(mid);
    const legend = (option.graphic as { id: string }[]).find((g) => g.id === 'size-legend');
    expect(legend).toBeDefined();
  });

  it('colours by a numeric column on the sequential ramp without its lightest steps', () => {
    const option = buildMapOption(config({ color: 'depth' }), quakes, theme);
    const visualMap = option.visualMap as Record<string, any>;
    expect(visualMap).toMatchObject({ dimension: 2, min: 5, max: 80, seriesIndex: 0 });
    expect(visualMap.inRange.color).toEqual(theme.sequential.slice(2));
    expect(seriesOf(option)[0]!.data[0]).toEqual([139.7, 35.6, 30]);
    // Dark mode orders its ramp the other way round, so the strongest values stay the most visible.
    const dark = buildMapOption(config({ color: 'depth' }), quakes, THEMES.dark).visualMap as Record<
      string,
      any
    >;
    expect(dark.inRange.color[0]).toBe(THEMES.dark.sequential[2]);
  });

  it('gives each entity its categorical colour and a legend entry', () => {
    const table = inferTable([
      { network: 'us', latitude: 1, longitude: 1 },
      { network: 'ak', latitude: 2, longitude: 2 },
      { network: 'us', latitude: 3, longitude: 3 },
    ]);
    const option = buildMapOption(config({ series: 'network' }), table, theme);
    const series = seriesOf(option);
    expect(series.map((s) => s.name)).toEqual(['ak', 'us']);
    expect((series[0] as any).itemStyle.color).toBe(theme.categorical[0]);
    expect((series[1] as any).itemStyle.color).toBe(theme.categorical[1]);
    expect((option.legend as any).data).toEqual(['ak', 'us']);
  });

  it('switches to large mode for many plain dots', () => {
    const many = inferTable(
      Array.from({ length: 2500 }, (_, i) => ({ latitude: (i % 160) - 80, longitude: (i % 360) - 180 })),
    );
    expect(seriesOf(buildMapOption(config(), many, theme))[0]!.large).toBe(true);
    expect(seriesOf(buildMapOption(config(), quakes, theme))[0]!.large).toBe(false);
  });

  it('draws a track in row order, split at the antimeridian, with the newest position marked', () => {
    const iss = inferTable(
      [
        { time: 1, latitude: 10, longitude: 170 },
        { time: 2, latitude: 20, longitude: -170 },
        { time: 3, latitude: 30, longitude: -160 },
      ],
      { types: { time: 'time' } },
    );
    const series = seriesOf(buildMapOption(config({ mode: 'track' }), iss, theme));
    expect(series.map((s) => s.type)).toEqual(['lines', 'scatter']);
    const lines = series[0]!.data as { coords: number[][] }[];
    expect(lines.map((l) => l.coords)).toEqual([
      [
        [170, 10],
        [180, 15],
      ],
      [
        [-180, 15],
        [-170, 20],
        [-160, 30],
      ],
    ]);
    const latest = series[1]!.data as { value: number[]; symbolSize: number }[];
    expect(latest.map((d) => d.value)).toEqual([
      [-160, 30],
      [-160, 30],
    ]);
    expect(latest[0]!.symbolSize).toBeGreaterThan(latest[1]!.symbolSize);
  });

  it('shades the night under the data for the time of the data', () => {
    const at = Date.UTC(2026, 5, 21, 12);
    const option = buildMapOption(config({ terminator: true }), quakes, theme, { at });
    const night = seriesOf(option).find((s) => s.id === 'night')!;
    expect(night.type).toBe('custom');
    const drawn = night.renderItem!({}, { coord: (p: number[]) => p });
    expect(drawn.shape.points).toEqual(nightPolygon(at));
    expect((option.graphic as { style?: { text?: string } }[])[0]!.style!.text).toBe(
      'Night shading for 12:00 UTC',
    );
    // Without an explicit time it falls back to the newest time in the data.
    const fallback = buildMapOption(config({ terminator: true }), quakes, theme);
    expect(JSON.stringify(fallback.graphic)).toContain('13:00 UTC');
    expect(seriesOf(buildMapOption(config(), quakes, theme)).some((s) => s.id === 'night')).toBe(false);
  });

  it('escapes every data string in tooltips', () => {
    const option = buildMapOption(config({ label: 'place', size: 'magnitude' }), quakes, theme);
    const formatter = (option.tooltip as { formatter: (p: unknown) => string }).formatter;
    const html = formatter({ seriesId: 'points:', dataIndex: 0 });
    expect(html).toContain('<b>Near &lt;b&gt;Tokyo&lt;/b&gt;</b>');
    expect(html).toContain('35.6°N, 139.7°E');
    expect(html).toContain('magnitude: 6.1');
    expect(escapeHtml(`<img src=x onerror="a('b')">&`)).toBe(
      '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;',
    );
  });

  it('says which column is missing instead of drawing an empty map', () => {
    const option = buildMapOption(config({ size: 'nope' }), quakes, theme);
    expect((option.title as { text: string }).text).toBe('Missing column: nope');
  });
});

describe('map widget schema', () => {
  const doc = (mapConfig: Record<string, unknown>) => ({
    ...emptyDashboard('Map'),
    datasets: [{ id: 'q', name: 'Quakes', source: { kind: 'inline', rows: [] } }],
    widgets: [
      {
        id: 'quakes',
        type: 'map',
        datasetId: 'q',
        config: { lat: 'latitude', lon: 'longitude', ...mapConfig },
      },
    ],
    layout: [{ i: 'quakes', x: 0, y: 0, w: 6, h: 5 }],
  });

  it('fills in defaults and rejects unknown keys', () => {
    const parsed = parseDashboard(doc({}));
    expect(parsed.widgets[0]!.config).toMatchObject({
      mode: 'points',
      view: 'fit',
      basemap: 'countries',
      terminator: false,
      maxPoints: 5000,
    });
    expect(() => parseDashboard(doc({ colour: 'depth' }))).toThrow();
  });

  it('rejects series and color together: a map has one colour channel', () => {
    expect(() => parseDashboard(doc({ series: 'network', color: 'depth' }))).toThrow(
      'Widget "quakes": use series or color, not both; a map has one colour channel',
    );
  });
});
