import { describe, expect, it } from 'vitest';
import { column, upstream } from './fake-upstream.ts';
import { earthquakes, normalizeRegion } from './world.ts';

describe('earthquake regions', () => {
  it.each([
    ['10 km NE of Ridgecrest, CA', 'California'],
    ['8 km NW of The Geysers, CA', 'California'],
    ['Central California', 'California'],
    ['57 km SSE of Sand Point, Alaska', 'Alaska'],
    ['Southern Alaska', 'Alaska'],
    ['Rat Islands, Aleutian Islands, Alaska', 'Alaska'],
    ['Japan region', 'Japan'],
    ['near the east coast of Honshu, Japan', 'Japan'],
    ['Fiji region', 'Fiji'],
    ['south of the Fiji Islands', 'Fiji'],
    ['Kermadec Islands region', 'New Zealand'],
    ['Philippine Islands region', 'Philippines'],
    ['12 km N of Ensenada, B.C., MX', 'Mexico'],
    ['6 km NW of Toyah, TX', 'Texas'],
    ['off the coast of Oregon', 'Oregon'],
    ['central Mid-Atlantic Ridge', 'Mid-Atlantic Ridge'],
    ['South Sandwich Islands region', 'South Sandwich Islands'],
    ['Central America', 'Central America'],
    ['Northern Mariana Islands', 'Northern Mariana Islands'],
    ['Puerto Rico region', 'Puerto Rico'],
  ])('%s -> %s', (place, region) => {
    expect(normalizeRegion(place)).toBe(region);
  });

  it('keeps a missing place missing', () => {
    expect(normalizeRegion(null)).toBeNull();
    expect(normalizeRegion('')).toBeNull();
  });

  it('normalises a recorded USGS feed shape', async () => {
    const feature = (place: string | null, mag: number, i: number) => ({
      type: 'Feature',
      id: `us7000${i}`,
      properties: {
        mag,
        place,
        time: 1_798_000_000_000 + i * 60_000,
        url: `https://earthquake.usgs.gov/earthquakes/eventpage/us7000${i}`,
        tsunami: 0,
        title: `M ${mag} - ${place}`,
      },
      geometry: { type: 'Point', coordinates: [-117.6, 35.7, 8.2] },
    });
    const { ctx, urls } = upstream({
      'https://earthquake.usgs.gov/': {
        type: 'FeatureCollection',
        features: [
          feature('10 km NE of Ridgecrest, CA', 2.7, 1),
          feature('Central California', 3.1, 2),
          feature('Japan region', 4.8, 3),
          feature('45 km E of Iwaki, Japan', 4.6, 4),
          feature(null, 2.5, 5),
        ],
      },
    });
    const table = await earthquakes.fetch({ period: 'day', minMagnitude: '2.5' }, ctx);
    expect(urls).toEqual(['https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson']);
    expect(column(table, 'region')).toEqual(['California', 'California', 'Japan', 'Japan', null]);
    // The raw place stays available for tooltips and tables.
    expect(column(table, 'place')[0]).toBe('10 km NE of Ridgecrest, CA');
  });

  it('produces only canonical region names offline', () => {
    const table = earthquakes.sample({ period: 'month', minMagnitude: '2.5' });
    const regions = new Set(column(table, 'region'));
    expect(regions.size).toBeGreaterThan(5);
    for (const region of regions) {
      expect(region).toEqual(expect.any(String));
      expect(region).not.toMatch(/region$|^[A-Z]{2}$|^(Southern|Central) |Islands$/);
    }
    // The raw places really are in the feed's mixed shapes, so the sample exercises normalisation.
    const places = column(table, 'place').join('\n');
    expect(places).toMatch(/, CA$/m);
    expect(places).toMatch(/region$/m);
  });
});
