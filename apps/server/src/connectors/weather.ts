import { type DataTable, inferTable } from '@patchbay/core';
import { HttpError } from '../util/errors.ts';
import {
  type Connector,
  type ConnectorContext,
  floorTo,
  HOUR,
  type Params,
  rng,
  round,
  seedOf,
} from './types.ts';

const ATTRIBUTION = 'Weather data by Open-Meteo.com (CC BY 4.0)';
const geocodeCache = new Map<string, { latitude: number; longitude: number; name: string }>();

const locationParams = [
  {
    name: 'city',
    label: 'City',
    type: 'string',
    required: false,
    default: 'Bratislava',
    description: 'Resolved with the Open-Meteo geocoder. Ignored when latitude/longitude are set.',
  },
  { name: 'latitude', label: 'Latitude', type: 'number', required: false },
  { name: 'longitude', label: 'Longitude', type: 'number', required: false },
] as const;

async function resolveLocation(params: Params, ctx: ConnectorContext) {
  if (typeof params.latitude === 'number' && typeof params.longitude === 'number') {
    return { latitude: params.latitude, longitude: params.longitude };
  }
  const city = String(params.city ?? 'Bratislava');
  const key = city.toLowerCase();
  const cached = geocodeCache.get(key);
  if (cached) return cached;
  const res = await ctx.fetchJson<{ results?: { latitude: number; longitude: number; name: string }[] }>(
    `https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=${encodeURIComponent(city)}`,
  );
  const hit = res.results?.[0];
  if (!hit) throw new HttpError(400, `Unknown city "${city}"`);
  geocodeCache.set(key, hit);
  return hit;
}

const HOURLY_VARS = [
  'temperature_2m',
  'apparent_temperature',
  'precipitation',
  'relative_humidity_2m',
  'wind_speed_10m',
  'cloud_cover',
  'pressure_msl',
];

function hourlyTable(json: { hourly?: Record<string, (number | null)[]> }, vars: string[]): DataTable {
  const hourly = json.hourly ?? {};
  const time = (hourly.time ?? []) as number[];
  const rows = time.map((t, i) => {
    const row: Record<string, number | null> = { time: t * 1000 };
    for (const v of vars) row[v] = hourly[v]?.[i] ?? null;
    return row;
  });
  return inferTable(rows, { types: { time: 'time' } });
}

function varsOf(params: Params, allowed: string[], fallback: string) {
  const vars = String(params.variables ?? fallback)
    .split(',')
    .map((v) => v.trim())
    .filter((v) => allowed.includes(v));
  return vars.length ? vars : fallback.split(',');
}

function synthHourly(params: Params, vars: string[], from: number, hours: number): DataTable {
  const r = rng(seedOf('weather', params.city, params.latitude));
  const rows = Array.from({ length: hours }, (_, i) => {
    const t = from + i * HOUR;
    const hourOfDay = new Date(t).getUTCHours();
    const daily = Math.sin(((hourOfDay - 9) / 24) * Math.PI * 2);
    const row: Record<string, number> = { time: t };
    for (const v of vars) {
      const noise = r() - 0.5;
      row[v] =
        v === 'temperature_2m' || v === 'apparent_temperature'
          ? round(11 + daily * 6 + noise * 2 - (v === 'apparent_temperature' ? 2 : 0), 1)
          : v === 'precipitation'
            ? round(Math.max(0, noise * 3 - 0.8), 1)
            : v === 'relative_humidity_2m'
              ? Math.round(70 - daily * 15 + noise * 10)
              : v === 'cloud_cover'
                ? Math.round(Math.min(100, Math.max(0, 50 + noise * 90)))
                : v === 'pressure_msl'
                  ? round(1013 + Math.sin(i / 30) * 6 + noise, 1)
                  : round(12 + noise * 10 + daily * 3, 1);
    }
    return row;
  });
  return inferTable(rows, { types: { time: 'time' } });
}

export const weatherForecast: Connector = {
  info: {
    id: 'weather.forecast',
    name: 'Weather forecast',
    category: 'Weather',
    description: 'Hourly forecast (and optionally recent past) for any city from Open-Meteo. No API key.',
    params: [
      ...locationParams,
      {
        name: 'variables',
        label: 'Variables',
        type: 'string',
        required: false,
        default: 'temperature_2m,precipitation,wind_speed_10m',
        description: `Comma separated: ${HOURLY_VARS.join(', ')}`,
      },
      {
        name: 'days',
        label: 'Forecast days',
        type: 'number',
        required: false,
        default: 3,
        description: '1-16',
      },
      {
        name: 'pastDays',
        label: 'Past days',
        type: 'number',
        required: false,
        default: 1,
        description: '0-7',
      },
    ],
    minRefreshSec: 900,
    docsUrl: 'https://open-meteo.com/en/docs',
    attribution: ATTRIBUTION,
  },
  async fetch(params, ctx) {
    const loc = await resolveLocation(params, ctx);
    const vars = varsOf(params, HOURLY_VARS, 'temperature_2m,precipitation,wind_speed_10m');
    const days = Math.min(Math.max(Number(params.days ?? 3), 1), 16);
    const past = Math.min(Math.max(Number(params.pastDays ?? 1), 0), 7);
    const json = await ctx.fetchJson<{ hourly?: Record<string, (number | null)[]> }>(
      `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&hourly=${vars.join(',')}&forecast_days=${days}&past_days=${past}&timeformat=unixtime&timezone=UTC`,
    );
    return hourlyTable(json, vars);
  },
  sample(params) {
    const vars = varsOf(params, HOURLY_VARS, 'temperature_2m,precipitation,wind_speed_10m');
    const past = Number(params.pastDays ?? 1);
    const days = Number(params.days ?? 3);
    return synthHourly(params, vars, floorTo(Date.now(), 86_400_000) - past * 86_400_000, (past + days) * 24);
  },
};

const CURRENT_VARS = [
  'temperature_2m',
  'apparent_temperature',
  'relative_humidity_2m',
  'wind_speed_10m',
  'precipitation',
  'cloud_cover',
  'weather_code',
];

export const weatherCurrent: Connector = {
  info: {
    id: 'weather.current',
    name: 'Current weather',
    category: 'Weather',
    description:
      'Current conditions for a city (one row). Combine with "accumulate" to build a live history.',
    params: [...locationParams],
    minRefreshSec: 300,
    docsUrl: 'https://open-meteo.com/en/docs',
    attribution: ATTRIBUTION,
  },
  async fetch(params, ctx) {
    const loc = await resolveLocation(params, ctx);
    const json = await ctx.fetchJson<{ current?: Record<string, number> }>(
      `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=${CURRENT_VARS.join(',')}&timeformat=unixtime&timezone=UTC`,
    );
    const c = json.current ?? {};
    const row: Record<string, number | null> = { time: (c.time ?? Date.now() / 1000) * 1000 };
    for (const v of CURRENT_VARS) row[v] = c[v] ?? null;
    return inferTable([row], { types: { time: 'time' } });
  },
  sample(params) {
    const t = floorTo(Date.now(), 60_000);
    const r = rng(seedOf('current', params.city, t));
    const daily = Math.sin(((new Date(t).getUTCHours() - 9) / 24) * Math.PI * 2);
    return inferTable(
      [
        {
          time: t,
          temperature_2m: round(11 + daily * 6 + r(), 1),
          apparent_temperature: round(9 + daily * 6 + r(), 1),
          relative_humidity_2m: Math.round(65 + r() * 20),
          wind_speed_10m: round(8 + r() * 10, 1),
          precipitation: 0,
          cloud_cover: Math.round(r() * 100),
          weather_code: 3,
        },
      ],
      { types: { time: 'time' } },
    );
  },
};

const AIR_VARS = ['pm10', 'pm2_5', 'european_aqi', 'nitrogen_dioxide', 'ozone'];

export const airQuality: Connector = {
  info: {
    id: 'weather.air-quality',
    name: 'Air quality',
    category: 'Weather',
    description: 'Hourly particulate matter, ozone and European AQI from Open-Meteo.',
    params: [
      ...locationParams,
      {
        name: 'variables',
        label: 'Variables',
        type: 'string',
        required: false,
        default: 'pm10,pm2_5,european_aqi',
        description: `Comma separated: ${AIR_VARS.join(', ')}`,
      },
    ],
    minRefreshSec: 1800,
    docsUrl: 'https://open-meteo.com/en/docs/air-quality-api',
    attribution: ATTRIBUTION,
  },
  async fetch(params, ctx) {
    const loc = await resolveLocation(params, ctx);
    const vars = varsOf(params, AIR_VARS, 'pm10,pm2_5,european_aqi');
    const json = await ctx.fetchJson<{ hourly?: Record<string, (number | null)[]> }>(
      `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${loc.latitude}&longitude=${loc.longitude}&hourly=${vars.join(',')}&past_days=1&forecast_days=2&timeformat=unixtime&timezone=UTC`,
    );
    return hourlyTable(json, vars);
  },
  sample(params) {
    const vars = varsOf(params, AIR_VARS, 'pm10,pm2_5,european_aqi');
    const r = rng(seedOf('air', params.city));
    const from = floorTo(Date.now(), 86_400_000) - 86_400_000;
    const rows = Array.from({ length: 72 }, (_, i) => {
      const base = 18 + Math.sin(i / 5) * 8 + r() * 4;
      const row: Record<string, number> = { time: from + i * HOUR };
      for (const v of vars)
        row[v] = round(
          v === 'pm2_5' ? base * 0.6 : v === 'european_aqi' ? base * 1.4 : v === 'ozone' ? 60 + base : base,
          1,
        );
      return row;
    });
    return inferTable(rows, { types: { time: 'time' } });
  },
};
