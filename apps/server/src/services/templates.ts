/**
 * Starter dashboards. They are built with the same `applyOps` path agents use,
 * so every template is guaranteed to be a valid document.
 */
import { applyOps, type DashboardDoc, emptyDashboard, type OpInput } from '@patchbay/core';
import { badRequest } from '../util/errors.ts';

export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

interface Template extends TemplateInfo {
  ops: OpInput[];
}

const TEMPLATES: Template[] = [
  {
    id: 'blank',
    name: 'Blank',
    description: 'An empty canvas. Add data and widgets yourself or let your AI agent do it.',
    tags: [],
    ops: [],
  },
  {
    id: 'live-signal',
    name: 'Live signal',
    description: 'A second-by-second synthetic stream: watch the charts update in real time.',
    tags: ['real-time', 'demo'],
    ops: [
      { op: 'setMeta', title: 'Live signal', description: 'Synthetic data refreshed every second.' },
      {
        op: 'addDataset',
        dataset: {
          id: 'signal',
          name: 'Signal',
          source: {
            kind: 'connector',
            connector: 'demo.signal',
            params: { shape: 'walk', points: 120, series: 2 },
          },
          refreshSec: 1,
        },
      },
      {
        op: 'addDataset',
        dataset: {
          id: 'latest',
          name: 'Latest alpha',
          source: {
            kind: 'connector',
            connector: 'demo.signal',
            params: { shape: 'walk', points: 120, series: 2 },
          },
          transforms: [{ type: 'filter', expr: 'series == "alpha"' }],
          refreshSec: 1,
        },
      },
      {
        op: 'addWidget',
        widget: {
          id: 'now',
          type: 'kpi',
          title: 'Alpha now',
          datasetId: 'latest',
          config: { field: 'value', compare: 'previous', sparkline: true },
        },
      },
      {
        op: 'addWidget',
        widget: {
          id: 'gauge',
          type: 'gauge',
          title: 'Alpha level',
          datasetId: 'latest',
          config: { field: 'value', min: 0, max: 100 },
        },
      },
      {
        op: 'addWidget',
        widget: {
          id: 'avg',
          type: 'kpi',
          title: 'Alpha 2-minute average',
          datasetId: 'latest',
          config: { field: 'value', agg: 'avg', format: { style: 'number', decimals: 1 } },
        },
      },
      {
        op: 'addWidget',
        widget: {
          id: 'about',
          type: 'text',
          title: 'How this works',
          config: {
            markdown:
              'Each dataset refreshes every **second** on the server and is pushed to every open browser over Server-Sent Events. Only changed data is sent.',
          },
        },
        position: { w: 3, h: 3 },
      },
      {
        op: 'addWidget',
        widget: {
          id: 'stream',
          type: 'chart',
          title: 'Signal',
          datasetId: 'signal',
          config: { kind: 'line', x: 'time', y: ['value'], series: 'series', smooth: true },
        },
        position: { w: 12, h: 5 },
      },
    ],
  },
  {
    id: 'weather',
    name: 'Weather',
    description: 'Forecast, current conditions and air quality for a city (Open-Meteo).',
    tags: ['public API'],
    ops: [
      { op: 'setMeta', title: 'Weather in Bratislava' },
      {
        op: 'addDataset',
        dataset: {
          id: 'now',
          name: 'Current',
          source: { kind: 'connector', connector: 'weather.current', params: { city: 'Bratislava' } },
          refreshSec: 300,
        },
      },
      {
        op: 'addDataset',
        dataset: {
          id: 'forecast',
          name: 'Forecast',
          source: {
            kind: 'connector',
            connector: 'weather.forecast',
            params: { city: 'Bratislava', days: 3, pastDays: 1 },
          },
          refreshSec: 900,
        },
      },
      {
        op: 'addDataset',
        dataset: {
          id: 'daily',
          name: 'Daily summary',
          source: {
            kind: 'connector',
            connector: 'weather.forecast',
            params: { city: 'Bratislava', days: 7, pastDays: 0 },
          },
          transforms: [
            { type: 'timeBucket', field: 'time', unit: 'day' },
            {
              type: 'aggregate',
              groupBy: ['time'],
              metrics: [
                { op: 'max', field: 'temperature_2m', as: 'high' },
                { op: 'min', field: 'temperature_2m', as: 'low' },
                { op: 'sum', field: 'precipitation', as: 'rain_mm' },
              ],
            },
          ],
          refreshSec: 900,
        },
      },
      {
        op: 'addDataset',
        dataset: {
          id: 'air',
          name: 'Air quality',
          source: { kind: 'connector', connector: 'weather.air-quality', params: { city: 'Bratislava' } },
          refreshSec: 1800,
        },
      },
      {
        op: 'addWidget',
        widget: {
          id: 'temp',
          type: 'kpi',
          title: 'Temperature',
          datasetId: 'now',
          config: { field: 'temperature_2m', format: { style: 'number', decimals: 1, suffix: ' °C' } },
        },
      },
      {
        op: 'addWidget',
        widget: {
          id: 'feels',
          type: 'kpi',
          title: 'Feels like',
          datasetId: 'now',
          config: { field: 'apparent_temperature', format: { style: 'number', decimals: 1, suffix: ' °C' } },
        },
      },
      {
        op: 'addWidget',
        widget: {
          id: 'wind',
          type: 'kpi',
          title: 'Wind',
          datasetId: 'now',
          config: { field: 'wind_speed_10m', format: { style: 'number', decimals: 1, suffix: ' km/h' } },
        },
      },
      {
        op: 'addWidget',
        widget: {
          id: 'hum',
          type: 'gauge',
          title: 'Humidity',
          datasetId: 'now',
          config: {
            field: 'relative_humidity_2m',
            min: 0,
            max: 100,
            format: { style: 'number', suffix: '%' },
          },
        },
        position: { w: 3, h: 2 },
      },
      {
        op: 'addWidget',
        widget: {
          id: 'temps',
          type: 'chart',
          title: 'Temperature (hourly)',
          datasetId: 'forecast',
          config: {
            kind: 'area',
            x: 'time',
            y: ['temperature_2m'],
            smooth: true,
            format: { style: 'number', decimals: 1, suffix: ' °C' },
          },
        },
        position: { w: 8, h: 4 },
      },
      {
        op: 'addWidget',
        widget: {
          id: 'rain',
          type: 'chart',
          title: 'Rain per day (mm)',
          datasetId: 'daily',
          config: { kind: 'bar', x: 'time', y: ['rain_mm'] },
        },
        position: { w: 4, h: 4 },
      },
      {
        op: 'addWidget',
        widget: {
          id: 'range',
          type: 'chart',
          title: 'Daily high / low',
          datasetId: 'daily',
          config: { kind: 'line', x: 'time', y: ['high', 'low'] },
        },
        position: { w: 6, h: 4 },
      },
      {
        op: 'addWidget',
        widget: {
          id: 'aqi',
          type: 'chart',
          title: 'Particulate matter (µg/m³)',
          datasetId: 'air',
          config: { kind: 'line', x: 'time', y: ['pm10', 'pm2_5'] },
        },
        position: { w: 6, h: 4 },
      },
    ],
  },
  {
    id: 'crypto',
    name: 'Crypto markets',
    description: 'Prices, 24h movers and a price history (CoinGecko).',
    tags: ['public API', 'finance'],
    ops: [
      { op: 'setMeta', title: 'Crypto markets' },
      {
        op: 'addDataset',
        dataset: {
          id: 'markets',
          name: 'Top coins',
          source: { kind: 'connector', connector: 'crypto.markets', params: { limit: 10 } },
          refreshSec: 120,
        },
      },
      {
        op: 'addDataset',
        dataset: {
          id: 'btc',
          name: 'Bitcoin, 30 days',
          source: { kind: 'connector', connector: 'crypto.history', params: { coin: 'bitcoin', days: 30 } },
          transforms: [{ type: 'window', op: 'rolling_avg', field: 'price', size: 24, as: 'avg_24h' }],
          refreshSec: 300,
        },
      },
      {
        op: 'addDataset',
        dataset: {
          id: 'spot',
          name: 'BTC spot (live)',
          source: { kind: 'connector', connector: 'crypto.price', params: { coins: 'bitcoin' } },
          refreshSec: 60,
          accumulate: 240,
        },
      },
      {
        op: 'addWidget',
        widget: {
          id: 'btc-now',
          type: 'kpi',
          title: 'Bitcoin',
          datasetId: 'spot',
          config: {
            field: 'price',
            compare: 'previous',
            sparkline: true,
            format: { style: 'currency', currency: 'USD', decimals: 0 },
          },
        },
      },
      {
        op: 'addWidget',
        widget: {
          id: 'btc-24h',
          type: 'kpi',
          title: 'BTC 24h change',
          datasetId: 'spot',
          config: { field: 'change_24h_pct', format: { style: 'percent', decimals: 2 } },
        },
      },
      {
        op: 'addWidget',
        widget: {
          id: 'movers',
          type: 'chart',
          title: '24h change (%)',
          datasetId: 'markets',
          config: {
            kind: 'bar',
            x: 'symbol',
            y: ['change_24h_pct'],
            format: { style: 'number', decimals: 2, suffix: '%' },
          },
        },
        position: { w: 6, h: 4 },
      },
      {
        op: 'addWidget',
        widget: {
          id: 'history',
          type: 'chart',
          title: 'Bitcoin price, 30 days',
          datasetId: 'btc',
          config: {
            kind: 'line',
            x: 'time',
            y: ['price', 'avg_24h'],
            format: { style: 'currency', currency: 'USD', decimals: 0 },
          },
        },
        position: { w: 12, h: 4 },
      },
      {
        op: 'addWidget',
        widget: {
          id: 'table',
          type: 'table',
          title: 'Top 10 by market cap',
          datasetId: 'markets',
          config: {
            columns: ['rank', 'name', 'symbol', 'price', 'change_24h_pct', 'market_cap'],
            pageSize: 10,
          },
        },
        position: { w: 12, h: 5 },
      },
    ],
  },
  {
    id: 'earthquakes',
    name: 'Earthquakes',
    description: 'Live USGS feed: latest quakes, magnitudes by region and a world scatter.',
    tags: ['public API', 'real-time'],
    ops: [
      { op: 'setMeta', title: 'Earthquakes, past 7 days' },
      {
        op: 'addDataset',
        dataset: {
          id: 'quakes',
          name: 'M2.5+ this week',
          source: {
            kind: 'connector',
            connector: 'earthquakes',
            params: { period: 'week', minMagnitude: '2.5' },
          },
          refreshSec: 120,
        },
      },
      {
        op: 'addDataset',
        dataset: {
          id: 'byregion',
          name: 'By region',
          source: {
            kind: 'connector',
            connector: 'earthquakes',
            params: { period: 'week', minMagnitude: '2.5' },
          },
          transforms: [
            {
              type: 'aggregate',
              groupBy: ['region'],
              metrics: [
                { op: 'count', as: 'quakes' },
                { op: 'max', field: 'magnitude', as: 'strongest' },
              ],
            },
            { type: 'sort', by: [{ field: 'quakes', dir: 'desc' }] },
            { type: 'limit', n: 12 },
          ],
          refreshSec: 300,
        },
      },
      {
        op: 'addDataset',
        dataset: {
          id: 'daily',
          name: 'Per day',
          source: {
            kind: 'connector',
            connector: 'earthquakes',
            params: { period: 'week', minMagnitude: '2.5' },
          },
          transforms: [
            { type: 'timeBucket', field: 'time', unit: 'day' },
            { type: 'aggregate', groupBy: ['time'], metrics: [{ op: 'count', as: 'quakes' }] },
            { type: 'sort', by: [{ field: 'time' }] },
          ],
          refreshSec: 300,
        },
      },
      {
        op: 'addWidget',
        widget: {
          id: 'count',
          type: 'kpi',
          title: 'Quakes this week',
          datasetId: 'quakes',
          config: { agg: 'count' },
        },
      },
      {
        op: 'addWidget',
        widget: {
          id: 'max',
          type: 'kpi',
          title: 'Strongest',
          datasetId: 'quakes',
          config: { field: 'magnitude', agg: 'max', format: { style: 'number', decimals: 1, prefix: 'M' } },
        },
      },
      {
        op: 'addWidget',
        widget: {
          id: 'perday',
          type: 'chart',
          title: 'Quakes per day',
          datasetId: 'daily',
          config: { kind: 'bar', x: 'time', y: ['quakes'] },
        },
        position: { w: 6, h: 4 },
      },
      {
        op: 'addWidget',
        widget: {
          id: 'map',
          type: 'chart',
          title: 'Where (longitude × latitude)',
          datasetId: 'quakes',
          config: {
            kind: 'scatter',
            x: 'longitude',
            y: ['latitude'],
            xMin: -180,
            xMax: 180,
            yMin: -90,
            yMax: 90,
          },
        },
        position: { w: 6, h: 5 },
      },
      {
        op: 'addWidget',
        widget: {
          id: 'regions',
          type: 'chart',
          title: 'Most active regions',
          datasetId: 'byregion',
          config: { kind: 'bar', x: 'region', y: ['quakes'], horizontal: true },
        },
        position: { w: 6, h: 5 },
      },
      {
        op: 'addWidget',
        widget: {
          id: 'list',
          type: 'table',
          title: 'Latest',
          datasetId: 'quakes',
          config: { columns: ['time', 'magnitude', 'place', 'depth_km', 'url'], pageSize: 15 },
        },
        position: { w: 12, h: 6 },
      },
    ],
  },
  {
    id: 'sales',
    name: 'Sales analytics',
    description: 'A synthetic sales dataset showing grouping, time buckets, shares and rolling averages.',
    tags: ['demo', 'analytics'],
    ops: [
      {
        op: 'setMeta',
        title: 'Sales analytics',
        description: 'Synthetic orders - replace the source with your own CSV.',
      },
      {
        op: 'addDataset',
        dataset: {
          id: 'orders',
          name: 'Orders',
          source: { kind: 'connector', connector: 'demo.sales', params: { days: 180 } },
        },
      },
      {
        op: 'addDataset',
        dataset: {
          id: 'weekly',
          name: 'Weekly revenue',
          source: { kind: 'connector', connector: 'demo.sales', params: { days: 180 } },
          transforms: [
            { type: 'timeBucket', field: 'date', unit: 'week' },
            {
              type: 'aggregate',
              groupBy: ['date', 'region'],
              metrics: [{ op: 'sum', field: 'revenue', as: 'revenue' }],
            },
            { type: 'sort', by: [{ field: 'date' }] },
          ],
        },
      },
      {
        op: 'addDataset',
        dataset: {
          id: 'products',
          name: 'By product',
          source: { kind: 'connector', connector: 'demo.sales', params: { days: 180 } },
          transforms: [
            {
              type: 'aggregate',
              groupBy: ['product'],
              metrics: [
                { op: 'sum', field: 'revenue', as: 'revenue' },
                { op: 'sum', field: 'units', as: 'units' },
              ],
            },
            { type: 'sort', by: [{ field: 'revenue', dir: 'desc' }] },
          ],
        },
      },
      {
        op: 'addWidget',
        widget: {
          id: 'rev',
          type: 'kpi',
          title: 'Revenue',
          datasetId: 'orders',
          config: {
            field: 'revenue',
            agg: 'sum',
            format: { style: 'currency', currency: 'EUR', decimals: 0 },
          },
        },
      },
      {
        op: 'addWidget',
        widget: {
          id: 'units',
          type: 'kpi',
          title: 'Units sold',
          datasetId: 'orders',
          config: { field: 'units', agg: 'sum', format: { style: 'compact' } },
        },
      },
      {
        op: 'addWidget',
        widget: {
          id: 'aov',
          type: 'kpi',
          title: 'Average order',
          datasetId: 'orders',
          config: { field: 'revenue', agg: 'avg', format: { style: 'currency', currency: 'EUR' } },
        },
      },
      {
        op: 'addWidget',
        widget: {
          id: 'orders-count',
          type: 'kpi',
          title: 'Orders',
          datasetId: 'orders',
          config: { agg: 'count' },
        },
      },
      {
        op: 'addWidget',
        widget: {
          id: 'trend',
          type: 'chart',
          title: 'Weekly revenue by region',
          datasetId: 'weekly',
          config: {
            kind: 'area',
            x: 'date',
            y: ['revenue'],
            series: 'region',
            stacked: true,
            format: { style: 'compact' },
          },
        },
        position: { w: 8, h: 5 },
      },
      {
        op: 'addWidget',
        widget: {
          id: 'share',
          type: 'chart',
          title: 'Revenue share',
          datasetId: 'products',
          config: { kind: 'donut', x: 'product', y: ['revenue'] },
        },
        position: { w: 4, h: 5 },
      },
      {
        op: 'addWidget',
        widget: {
          id: 'top',
          type: 'table',
          title: 'Products',
          datasetId: 'products',
          config: { pageSize: 10, format: { style: 'number', decimals: 0 } },
        },
        position: { w: 12, h: 4 },
      },
    ],
  },
];

export function listTemplates(): TemplateInfo[] {
  return TEMPLATES.map(({ ops: _ops, ...info }) => info);
}

export function buildTemplate(id: string, title?: string): DashboardDoc {
  const template = TEMPLATES.find((t) => t.id === id);
  // Falling back to blank would hide a typo: the caller asked for something else.
  if (!template)
    throw badRequest(`Unknown template "${id}". Available: ${TEMPLATES.map((t) => t.id).join(', ')}`);
  let doc = applyOps(
    emptyDashboard(template.id === 'blank' ? 'Untitled dashboard' : template.name),
    template.ops,
  ).doc;
  if (title) doc = { ...doc, title };
  return doc;
}
