import { inferTable } from '@patchbay/core';
import { type Connector, DAY, floorTo, HOUR, rng, round, seedOf } from './types.ts';

interface UsgsFeature {
  id: string;
  properties: {
    mag: number | null;
    place: string | null;
    time: number;
    url: string;
    tsunami: number;
    title: string;
  };
  geometry: { coordinates: [number, number, number] };
}

export const earthquakes: Connector = {
  info: {
    id: 'earthquakes',
    name: 'Earthquakes',
    category: 'Science',
    description:
      'Recent earthquakes worldwide from the USGS real-time feed: time, magnitude, place, coordinates, depth.',
    params: [
      {
        name: 'period',
        label: 'Period',
        type: 'enum',
        required: false,
        default: 'day',
        options: [
          { value: 'hour', label: 'Past hour' },
          { value: 'day', label: 'Past day' },
          { value: 'week', label: 'Past 7 days' },
          { value: 'month', label: 'Past 30 days' },
        ],
      },
      {
        name: 'minMagnitude',
        label: 'Minimum magnitude',
        type: 'enum',
        required: false,
        default: '2.5',
        options: [
          { value: 'all', label: 'All' },
          { value: '1.0', label: 'M1.0+' },
          { value: '2.5', label: 'M2.5+' },
          { value: '4.5', label: 'M4.5+' },
          { value: 'significant', label: 'Significant' },
        ],
      },
    ],
    minRefreshSec: 60,
    docsUrl: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php',
    attribution: 'U.S. Geological Survey',
  },
  async fetch(params, ctx) {
    const json = await ctx.fetchJson<{ features: UsgsFeature[] }>(
      `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/${params.minMagnitude ?? '2.5'}_${params.period ?? 'day'}.geojson`,
    );
    return inferTable(
      json.features.map((f) => ({
        time: f.properties.time,
        magnitude: f.properties.mag,
        place: f.properties.place,
        region: f.properties.place?.split(', ').pop() ?? null,
        latitude: f.geometry.coordinates[1],
        longitude: f.geometry.coordinates[0],
        depth_km: f.geometry.coordinates[2],
        tsunami: f.properties.tsunami === 1,
        url: f.properties.url,
      })),
      { types: { time: 'time' } },
    );
  },
  sample(params) {
    const hours = { hour: 1, day: 24, week: 168, month: 720 }[String(params.period ?? 'day')] ?? 24;
    const minMag = Number(params.minMagnitude) || 1;
    const end = floorTo(Date.now(), 60_000);
    const r = rng(seedOf('quake', floorTo(end, HOUR)));
    const regions = [
      'Alaska',
      'California',
      'Japan',
      'Indonesia',
      'Chile',
      'Turkey',
      'Greece',
      'Iceland',
      'Peru',
      'New Zealand',
    ];
    const coords: Record<string, [number, number]> = {
      Alaska: [61, -150],
      California: [36, -119],
      Japan: [36, 138],
      Indonesia: [-2, 118],
      Chile: [-30, -71],
      Turkey: [39, 35],
      Greece: [38, 23],
      Iceland: [64, -19],
      Peru: [-10, -76],
      'New Zealand': [-41, 174],
    };
    const count = Math.max(3, Math.round(hours * 1.2));
    const rows = Array.from({ length: count }, () => {
      const region = regions[Math.floor(r() * regions.length)]!;
      const [lat, lon] = coords[region]!;
      return {
        time: end - Math.floor(r() * hours * HOUR),
        magnitude: round(Math.max(minMag, minMag + -Math.log(1 - r()) * 0.8), 1),
        place: `${Math.round(r() * 80)} km of ${region}`,
        region,
        latitude: round(lat + (r() - 0.5) * 6, 3),
        longitude: round(lon + (r() - 0.5) * 6, 3),
        depth_km: round(r() * 60, 1),
        tsunami: false,
        url: 'https://earthquake.usgs.gov/earthquakes/map/',
      };
    }).sort((a, b) => b.time - a.time);
    return inferTable(rows, { types: { time: 'time' } });
  },
};

export const worldBank: Connector = {
  info: {
    id: 'worldbank.indicator',
    name: 'World Bank indicator',
    category: 'Economy',
    description:
      'Yearly development indicators (population, GDP, CO2, life expectancy, ...) for one or more countries.',
    params: [
      {
        name: 'countries',
        label: 'Countries',
        type: 'string',
        required: false,
        default: 'SK;CZ;AT;HU;PL',
        description: 'ISO codes separated by ";" (e.g. SK;CZ) or "all"',
      },
      {
        name: 'indicator',
        label: 'Indicator',
        type: 'string',
        required: false,
        default: 'NY.GDP.PCAP.CD',
        description:
          'e.g. SP.POP.TOTL (population), NY.GDP.PCAP.CD (GDP per capita), SP.DYN.LE00.IN (life expectancy), EN.GHG.CO2.PC.CE.AR5 (CO2 per capita)',
      },
      { name: 'from', label: 'From year', type: 'number', required: false, default: 2000 },
      { name: 'to', label: 'To year', type: 'number', required: false, default: 2025 },
    ],
    minRefreshSec: 86_400,
    docsUrl: 'https://datahelpdesk.worldbank.org/knowledgebase/articles/889392',
    attribution: 'The World Bank, World Development Indicators (CC BY 4.0)',
  },
  async fetch(params, ctx) {
    const json = await ctx.fetchJson<
      [
        unknown,
        { country: { value: string }; countryiso3code: string; date: string; value: number | null }[] | null,
      ]
    >(
      `https://api.worldbank.org/v2/country/${encodeURIComponent(String(params.countries ?? 'SK'))}/indicator/${encodeURIComponent(String(params.indicator ?? 'SP.POP.TOTL'))}?format=json&per_page=5000&date=${params.from ?? 2000}:${params.to ?? 2025}`,
    );
    const rows = (json[1] ?? [])
      .filter((r) => r.value !== null)
      .map((r) => ({
        year: Number(r.date),
        country: r.country.value,
        iso3: r.countryiso3code,
        value: r.value,
      }))
      .sort((a, b) => a.year - b.year);
    return inferTable(rows);
  },
  sample(params) {
    const countries = String(params.countries ?? 'SK').split(';');
    const names: Record<string, string> = {
      SK: 'Slovakia',
      CZ: 'Czechia',
      AT: 'Austria',
      HU: 'Hungary',
      PL: 'Poland',
      DE: 'Germany',
    };
    const from = Number(params.from ?? 2000);
    const to = Number(params.to ?? 2025);
    const rows = countries.flatMap((c) => {
      const r = rng(seedOf('wb', c, params.indicator));
      let v = 8000 + r() * 30_000;
      return Array.from({ length: to - from }, (_, i) => {
        v *= 1 + 0.01 + (r() - 0.4) * 0.06;
        return { year: from + i, country: names[c] ?? c, iso3: c, value: Math.round(v) };
      });
    });
    return inferTable(rows.sort((a, b) => a.year - b.year));
  },
};

export const issPosition: Connector = {
  info: {
    id: 'iss.position',
    name: 'ISS position',
    category: 'Science',
    description:
      'Where the International Space Station is right now (one row). Refresh every few seconds with "accumulate" to draw its track.',
    params: [],
    minRefreshSec: 5,
    docsUrl: 'https://wheretheiss.at/w/developer',
    attribution: 'wheretheiss.at',
  },
  async fetch(_params, ctx) {
    const j = await ctx.fetchJson<{
      latitude: number;
      longitude: number;
      altitude: number;
      velocity: number;
      visibility: string;
      timestamp: number;
    }>('https://api.wheretheiss.at/v1/satellites/25544');
    return inferTable(
      [
        {
          time: j.timestamp * 1000,
          latitude: j.latitude,
          longitude: j.longitude,
          altitude_km: j.altitude,
          velocity_kmh: j.velocity,
          daylight: j.visibility === 'daylight',
        },
      ],
      { types: { time: 'time' } },
    );
  },
  sample() {
    const t = floorTo(Date.now(), 1000);
    const phase = (t / (92.68 * 60_000)) * Math.PI * 2;
    return inferTable(
      [
        {
          time: t,
          latitude: round(51.6 * Math.sin(phase), 4),
          longitude: round((((t / 1000) * 0.0687) % 360) - 180, 4),
          altitude_km: round(418 + Math.sin(phase * 3) * 2, 2),
          velocity_kmh: round(27_600 + Math.cos(phase) * 30, 1),
          daylight: Math.cos(phase) > 0,
        },
      ],
      { types: { time: 'time' } },
    );
  },
};

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');

export const wikipediaViews: Connector = {
  info: {
    id: 'wikipedia.pageviews',
    name: 'Wikipedia page views',
    category: 'Culture',
    description: 'Daily page views of one or more Wikipedia articles.',
    params: [
      {
        name: 'articles',
        label: 'Articles',
        type: 'string',
        required: true,
        default: 'Model_Context_Protocol,Large_language_model',
        description: 'Comma separated article titles',
      },
      { name: 'project', label: 'Wiki', type: 'string', required: false, default: 'en.wikipedia.org' },
      { name: 'days', label: 'Days', type: 'number', required: false, default: 60, description: '1-365' },
    ],
    minRefreshSec: 6 * 3600,
    docsUrl: 'https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/',
    attribution: 'Wikimedia Foundation (CC0)',
  },
  async fetch(params, ctx) {
    const days = Math.min(Math.max(Number(params.days ?? 60), 1), 365);
    const end = Date.now() - DAY;
    const articles = String(params.articles)
      .split(',')
      .map((a) => a.trim().replace(/ /g, '_'))
      .filter(Boolean)
      .slice(0, 8);
    const results = await Promise.all(
      articles.map((article) =>
        ctx
          .fetchJson<{ items?: { timestamp: string; views: number }[] }>(
            `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${encodeURIComponent(String(params.project ?? 'en.wikipedia.org'))}/all-access/user/${encodeURIComponent(article)}/daily/${ymd(end - days * DAY)}/${ymd(end)}`,
          )
          .then((j) =>
            (j.items ?? []).map((it) => ({
              date: `${it.timestamp.slice(0, 4)}-${it.timestamp.slice(4, 6)}-${it.timestamp.slice(6, 8)}`,
              article: article.replace(/_/g, ' '),
              views: it.views,
            })),
          ),
      ),
    );
    return inferTable(results.flat());
  },
  sample(params) {
    const days = Number(params.days ?? 60);
    const end = floorTo(Date.now(), DAY) - DAY;
    const articles = String(params.articles ?? 'Example')
      .split(',')
      .map((a) => a.trim())
      .slice(0, 8);
    const rows = articles.flatMap((a, k) => {
      const r = rng(seedOf('wiki', a));
      return Array.from({ length: days }, (_, i) => ({
        date: end - (days - 1 - i) * DAY,
        article: a.replace(/_/g, ' '),
        views: Math.round(
          (2000 + k * 1500) *
            (1 + i / days) *
            (0.75 + r() * 0.5) *
            (new Date(end - (days - 1 - i) * DAY).getUTCDay() % 6 === 0 ? 0.7 : 1),
        ),
      }));
    });
    return inferTable(rows, { types: { date: 'time' } });
  },
};
