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

const US_STATES: Record<string, string> = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
  PR: 'Puerto Rico',
  // USGS writes Baja California as "B.C., MX".
  MX: 'Mexico',
};

/** Island groups and areas the feed names on their own, folded into the place people look for. */
const REGION_ALIASES: Record<string, string> = {
  'fiji islands': 'Fiji',
  'philippine islands': 'Philippines',
  'kermadec islands': 'New Zealand',
  'aleutian islands': 'Alaska',
  'andreanof islands': 'Alaska',
  'fox islands': 'Alaska',
  'rat islands': 'Alaska',
  honshu: 'Japan',
  hokkaido: 'Japan',
  kyushu: 'Japan',
  'izu islands': 'Japan',
  'bonin islands': 'Japan',
  'ryukyu islands': 'Japan',
  'baja california': 'Mexico',
};

/** Names that start with a compass word but are names, not "the southern part of X". */
const KEEP_QUALIFIER = new Set([
  'central america',
  'central african republic',
  'northern mariana islands',
  'western sahara',
  'western australia',
  'northern territory',
]);

/**
 * One name per region. The USGS "place" ends in a state code ("CA"), a state name ("Alaska"), a
 * country, or a Flinn-Engdahl region such as "Japan region" or "south of the Fiji Islands", so
 * grouping by its last part split California and Japan into several bars.
 */
export function normalizeRegion(place: string | null | undefined): string | null {
  if (!place) return null;
  let region = (place.split(',').pop() ?? '')
    .trim()
    .replace(/^\d+(\.\d+)?\s*km\s+[NSEW]{1,3}\s+of\s+/i, '')
    .replace(/^(near|off)\s+the\s+(\w+\s+)?coast\s+of\s+/i, '')
    .replace(/^(north|south|east|west)(east|west)?\s+of\s+(the\s+)?/i, '')
    .replace(/\s+region$/i, '')
    .trim();
  if (!KEEP_QUALIFIER.has(region.toLowerCase())) {
    region = region.replace(
      /^(northern|southern|eastern|western|central|(north|south)(east|west)ern|(north|south)-central)\s+/i,
      '',
    );
  }
  const state = US_STATES[region];
  if (state) return state;
  region = REGION_ALIASES[region.toLowerCase()] ?? region;
  return region ? region[0]!.toUpperCase() + region.slice(1) : null;
}

/** Raw place strings in the feed's own shapes; "{km}" is filled in per row. */
const SAMPLE_PLACES: { place: string; at: [number, number] }[] = [
  { place: '{km} km NW of The Geysers, CA', at: [38.8, -122.8] },
  { place: '{km} km SE of Ridgecrest, CA', at: [35.6, -117.6] },
  { place: 'Central California', at: [36.5, -120.5] },
  { place: '{km} km SSE of Sand Point, Alaska', at: [55.1, -160.4] },
  { place: 'Southern Alaska', at: [60, -150] },
  { place: 'Rat Islands, Aleutian Islands, Alaska', at: [51.5, 178.5] },
  { place: '{km} km E of Iwaki, Japan', at: [37, 141.5] },
  { place: 'Japan region', at: [36, 142] },
  { place: 'near the east coast of Honshu, Japan', at: [38.5, 142.5] },
  { place: '{km} km SW of Abepura, Indonesia', at: [-2.7, 140.5] },
  { place: 'Fiji region', at: [-18, 178] },
  { place: 'south of the Fiji Islands', at: [-24, -178] },
  { place: '{km} km NNE of Ovalle, Chile', at: [-30.4, -71] },
  { place: '{km} km N of Ensenada, B.C., MX', at: [32.2, -116.6] },
  { place: '{km} km NW of Toyah, TX', at: [31.4, -103.9] },
  { place: '{km} km SE of Pahala, Hawaii', at: [19.1, -155.4] },
  { place: 'Kermadec Islands region', at: [-30, -178] },
  { place: '{km} km ESE of Kos, Greece', at: [36.8, 27.4] },
  { place: '{km} km S of Sindirgi, Turkey', at: [39.1, 28.2] },
  { place: '{km} km WSW of Lima, Peru', at: [-12.1, -77.4] },
];

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
        region: normalizeRegion(f.properties.place),
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
    const count = Math.max(3, Math.round(hours * 1.2));
    const rows = Array.from({ length: count }, () => {
      const spot = SAMPLE_PLACES[Math.floor(r() * SAMPLE_PLACES.length)]!;
      const [lat, lon] = spot.at;
      // Raw places in the live feed's shapes, through the same normalisation, so offline data tells the truth.
      const place = spot.place.replace('{km}', String(1 + Math.round(r() * 80)));
      return {
        time: end - Math.floor(r() * hours * HOUR),
        magnitude: round(Math.max(minMag, minMag + -Math.log(1 - r()) * 0.8), 1),
        place,
        region: normalizeRegion(place),
        latitude: round(lat + (r() - 0.5) * 3, 3),
        longitude: round(lon + (r() - 0.5) * 3, 3),
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
