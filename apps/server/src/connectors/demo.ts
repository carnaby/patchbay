/**
 * Synthetic sources. They never touch the network, so they are always
 * available - for the landing page demo, for trying real-time updates, and as
 * the default in templates when OFFLINE mode is on.
 */
import { inferTable } from '@patchbay/core';
import { type Connector, DAY, floorTo, rng, round, seedOf } from './types.ts';

export const demoSignal: Connector = {
  info: {
    id: 'demo.signal',
    name: 'Live signal (demo)',
    category: 'Demo',
    description: 'A synthetic real-time signal that moves every second. Great for testing live refresh.',
    params: [
      {
        name: 'shape',
        label: 'Shape',
        type: 'enum',
        required: false,
        default: 'sine',
        options: [
          { value: 'sine', label: 'Sine wave' },
          { value: 'walk', label: 'Random walk' },
          { value: 'traffic', label: 'Web traffic' },
        ],
      },
      {
        name: 'points',
        label: 'Points',
        type: 'number',
        required: false,
        default: 120,
        description: '10-2000 (one per second)',
      },
      { name: 'series', label: 'Series', type: 'number', required: false, default: 1, description: '1-4' },
    ],
    minRefreshSec: 1,
    docsUrl: 'https://github.com/carnaby/patchbay',
    attribution: 'Synthetic data',
  },
  async fetch(params) {
    return this.sample(params);
  },
  sample(params) {
    const points = Math.min(Math.max(Number(params.points ?? 120), 10), 2000);
    const seriesCount = Math.min(Math.max(Number(params.series ?? 1), 1), 4);
    const end = floorTo(Date.now(), 1000);
    const names = ['alpha', 'beta', 'gamma', 'delta'];
    const rows = [];
    for (let s = 0; s < seriesCount; s++) {
      for (let i = 0; i < points; i++) {
        const t = end - (points - 1 - i) * 1000;
        const sec = t / 1000;
        const r = rng(seedOf(s, sec))();
        let value: number;
        if (params.shape === 'walk') {
          value = 50 + Math.sin(sec / 37 + s) * 20 + Math.sin(sec / 7.3) * 6 + (r - 0.5) * 4;
        } else if (params.shape === 'traffic') {
          value = Math.max(0, 300 + Math.sin(sec / 45 + s) * 120 + Math.sin(sec / 9) * 40 + r * 60);
        } else {
          value = 50 + Math.sin(sec / 10 + s * 1.3) * 30 + (r - 0.5) * 6;
        }
        rows.push({ time: t, series: names[s]!, value: round(value, 2) });
      }
    }
    return inferTable(rows, { types: { time: 'time' } });
  },
};

const REGIONS = ['Europe', 'North America', 'Asia', 'LATAM'];
const PRODUCTS = [
  { name: 'Mixer Pro', price: 899 },
  { name: 'Studio Monitor', price: 349 },
  { name: 'Headphones', price: 149 },
  { name: 'Audio Interface', price: 229 },
  { name: 'Cables', price: 19 },
];
const CHANNELS = ['Online', 'Retail', 'Partner'];
/** Live mode: chance of an order in any given second, about one every 8 s. */
const ORDER_CHANCE = 0.12;
const LIVE_WINDOW_SEC = 30 * 60;

/**
 * Individual orders of the last 30 minutes. Every second decides on its own (seeded by the second),
 * so the same order keeps the same id and values on every refresh and new ones appear at the end:
 * exactly what live refresh and a newRows sound keyed by order_id need.
 */
function liveOrders(now: number) {
  const end = floorTo(now, 1000) / 1000;
  const rows = [];
  for (let sec = end - LIVE_WINDOW_SEC + 1; sec <= end; sec++) {
    const r = rng(seedOf('order', sec));
    if (r() >= ORDER_CHANCE) continue;
    const product = PRODUCTS[Math.floor(r() ** 1.4 * PRODUCTS.length)]!;
    const units = 1 + Math.floor(r() ** 3 * 6);
    rows.push({
      time: sec * 1000,
      order_id: `SO-${sec}`,
      region: REGIONS[Math.floor(r() ** 1.2 * REGIONS.length)]!,
      product: product.name,
      channel: CHANNELS[Math.floor(r() * CHANNELS.length)]!,
      units,
      revenue: round(units * product.price * (0.85 + r() * 0.2), 2),
    });
  }
  return inferTable(rows, { types: { time: 'time' } });
}

export const demoSales: Connector = {
  info: {
    id: 'demo.sales',
    name: 'Sales (demo)',
    category: 'Demo',
    description:
      'Synthetic sales for analytics demos: one row per order with date, region, product, channel, units and revenue. With live: true it returns the orders of the last 30 minutes instead (time to the second, order_id), with a new order every few seconds, for live refresh and sound cues.',
    params: [
      { name: 'days', label: 'Days', type: 'number', required: false, default: 90, description: '7-730' },
      {
        name: 'live',
        label: 'Live orders',
        type: 'boolean',
        required: false,
        default: false,
        description:
          'Orders of the last 30 minutes with time and order_id; refresh every few seconds. Ignores days.',
      },
    ],
    // Low so live mode can refresh every few seconds; the daily data is cheap to regenerate.
    minRefreshSec: 2,
    docsUrl: 'https://github.com/carnaby/patchbay',
    attribution: 'Synthetic data',
  },
  async fetch(params) {
    return this.sample(params);
  },
  sample(params) {
    if (params.live === true) return liveOrders(Date.now());
    const days = Math.min(Math.max(Number(params.days ?? 90), 7), 730);
    const r = rng(42);
    const end = floorTo(Date.now(), DAY);
    const regions = REGIONS;
    const products = PRODUCTS;
    const channels = CHANNELS;
    const rows = [];
    for (let d = 0; d < days; d++) {
      const date = end - (days - 1 - d) * DAY;
      const orders = 8 + Math.floor(r() * 10) + Math.floor(d / 30);
      for (let o = 0; o < orders; o++) {
        const product = products[Math.floor(r() ** 1.4 * products.length)]!;
        const units = 1 + Math.floor(r() ** 3 * 6);
        rows.push({
          date,
          region: regions[Math.floor(r() ** 1.2 * regions.length)]!,
          product: product.name,
          channel: channels[Math.floor(r() * channels.length)]!,
          units,
          revenue: round(units * product.price * (0.85 + r() * 0.2), 2),
        });
      }
    }
    return inferTable(rows, { types: { date: 'time' } });
  },
};
