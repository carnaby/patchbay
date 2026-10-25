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

export const demoSales: Connector = {
  info: {
    id: 'demo.sales',
    name: 'Sales (demo)',
    category: 'Demo',
    description:
      'A synthetic order-level sales dataset (date, region, product, channel, units, revenue) for analytics demos.',
    params: [
      { name: 'days', label: 'Days', type: 'number', required: false, default: 90, description: '7-730' },
    ],
    minRefreshSec: 60,
    docsUrl: 'https://github.com/carnaby/patchbay',
    attribution: 'Synthetic data',
  },
  async fetch(params) {
    return this.sample(params);
  },
  sample(params) {
    const days = Math.min(Math.max(Number(params.days ?? 90), 7), 730);
    const r = rng(42);
    const end = floorTo(Date.now(), DAY);
    const regions = ['Europe', 'North America', 'Asia', 'LATAM'];
    const products = [
      { name: 'Mixer Pro', price: 899 },
      { name: 'Studio Monitor', price: 349 },
      { name: 'Headphones', price: 149 },
      { name: 'Audio Interface', price: 229 },
      { name: 'Cables', price: 19 },
    ];
    const channels = ['Online', 'Retail', 'Partner'];
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
