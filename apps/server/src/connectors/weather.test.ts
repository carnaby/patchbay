import { inferTable, profileTable, suggestWidgets } from '@patchbay/core';
import { describe, expect, it } from 'vitest';
import { upstream } from './fake-upstream.ts';
import { weatherCurrent, weatherForecast } from './weather.ts';

describe('weather location columns', () => {
  const hourly = {
    hourly: {
      time: [1_798_000_000, 1_798_003_600],
      temperature_2m: [11.2, 12.4],
      precipitation: [0, 0.1],
      wind_speed_10m: [7.1, 8.3],
    },
  };

  it('labels forecast rows with the geocoded city and its coordinates', async () => {
    const { ctx, urls } = upstream({
      'https://geocoding-api.open-meteo.com/': {
        results: [{ name: 'Vienna', latitude: 48.20849, longitude: 16.37208 }],
      },
      'https://api.open-meteo.com/': hourly,
    });
    const table = await weatherForecast.fetch({ city: 'wien-test-1' }, ctx);
    expect(urls[1]).toContain('latitude=48.20849&longitude=16.37208');
    expect(table.columns.map((c) => c.name)).toEqual([
      'time',
      'city',
      'temperature_2m',
      'precipitation',
      'wind_speed_10m',
      'latitude',
      'longitude',
    ]);
    expect(table.rows[0]).toMatchObject({ city: 'Vienna', latitude: 48.20849, longitude: 16.37208 });
  });

  it('keeps two cities apart once their rows are combined', async () => {
    const one = upstream({
      'https://geocoding-api.open-meteo.com/': {
        results: [{ name: 'Bratislava', latitude: 48.15, longitude: 17.11 }],
      },
      'https://api.open-meteo.com/': hourly,
    });
    const two = upstream({ 'https://api.open-meteo.com/': hourly });
    const a = await weatherForecast.fetch({ city: 'bratislava-test-2' }, one.ctx);
    // Explicit coordinates have no name, so the coordinates become the label.
    const b = await weatherForecast.fetch({ latitude: 50.0875, longitude: 14.4214 }, two.ctx);
    expect(b.rows[0]).toMatchObject({ city: '50.09, 14.42', latitude: 50.0875, longitude: 14.4214 });
    const combined = inferTable([...a.rows, ...b.rows], { types: { time: 'time' } });
    const city = profileTable(combined).columns.find((c) => c.name === 'city');
    expect(city).toMatchObject({ role: 'dimension', distinct: 2 });
  });

  it('adds the city to current conditions too', async () => {
    const { ctx } = upstream({
      'https://geocoding-api.open-meteo.com/': {
        results: [{ name: 'Prague', latitude: 50.08, longitude: 14.42 }],
      },
      'https://api.open-meteo.com/': { current: { time: 1_798_000_000, temperature_2m: 9.5 } },
    });
    const table = await weatherCurrent.fetch({ city: 'praha-test-3' }, ctx);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toMatchObject({ city: 'Prague', temperature_2m: 9.5, latitude: 50.08 });
  });

  it('has the same columns offline, and no single-point map suggestion', () => {
    const table = weatherForecast.sample({ city: 'Vienna' });
    expect(table.columns.map((c) => c.name)).toEqual([
      'time',
      'city',
      'temperature_2m',
      'precipitation',
      'wind_speed_10m',
      'latitude',
      'longitude',
    ]);
    expect(table.rows[0]).toMatchObject({ city: 'Vienna', latitude: 48.2085, longitude: 16.3721 });
    expect(weatherCurrent.sample({ city: 'Unknown Town' }).rows[0]?.city).toBe('Unknown Town');
    const titles = suggestWidgets(profileTable(table)).map((s) => s.title);
    expect(titles).not.toContain('Locations');
  });
});
