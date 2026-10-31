/**
 * The offline stand-in for a feed (OFFLINE=1), like a connector's `sample`: deterministic per address, with a new
 * item every two minutes, so CI, demos and sound cues ("ding on a new article") work without network.
 */
import type { Row } from '@patchbay/core';
import type { ParsedFeed } from './parse.ts';
import { FEED_COLUMNS } from './parse.ts';

const STEP_MS = 2 * 60_000;
const TOPICS = [
  'City council approves new cycle lanes along the river',
  'Local team wins the regional final after extra time',
  'Researchers publish an open dataset of air quality readings',
  'New tram line opens with free rides this weekend',
  'Library extends opening hours during exam season',
  'Weather service expects the first frost of the season',
  'Open-source project ships a long-awaited release',
  'Museum reopens its renovated science wing',
  'Farmers market moves indoors for the winter',
  'Startup festival announces its speaker line-up',
  'Rail operator adds evening trains on the coastal line',
  'Volunteers plant two thousand trees in the city park',
];

function seed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function sampleFeed(url: string, now = Date.now()): ParsedFeed {
  let host = 'example.com';
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    // Unreachable for validated sources; keeps the sample total.
  }
  const source = `${host} (offline sample)`;
  const latest = Math.floor(now / STEP_MS);
  const offset = seed(url) % TOPICS.length;
  const rows: Row[] = [];
  for (let i = 0; i < 10; i++) {
    const n = latest - i;
    const title = TOPICS[(n + offset) % TOPICS.length]!;
    rows.push({
      id: `sample-${n}`,
      title,
      link: `https://example.com/news/${n}`,
      published: n * STEP_MS,
      summary: `${title}. This is synthetic text: the server runs with OFFLINE=1 and does not fetch feeds.`,
      author: null,
      source,
      image: null,
    });
  }
  return { title: source, table: { columns: FEED_COLUMNS, rows }, ttlMinutes: null };
}
