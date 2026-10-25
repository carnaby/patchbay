import { inferTable } from '@patchbay/core';
import { type Connector, DAY, floorTo, HOUR, rng, round, seedOf } from './types.ts';

const COINS: Record<string, { name: string; symbol: string; price: number }> = {
  bitcoin: { name: 'Bitcoin', symbol: 'btc', price: 98_000 },
  ethereum: { name: 'Ethereum', symbol: 'eth', price: 3_600 },
  solana: { name: 'Solana', symbol: 'sol', price: 190 },
  binancecoin: { name: 'BNB', symbol: 'bnb', price: 640 },
  ripple: { name: 'XRP', symbol: 'xrp', price: 2.3 },
  cardano: { name: 'Cardano', symbol: 'ada', price: 0.95 },
  dogecoin: { name: 'Dogecoin', symbol: 'doge', price: 0.32 },
  polkadot: { name: 'Polkadot', symbol: 'dot', price: 7.2 },
  chainlink: { name: 'Chainlink', symbol: 'link', price: 21 },
  litecoin: { name: 'Litecoin', symbol: 'ltc', price: 105 },
};

/** Random walk anchored to wall-clock buckets, so offline prices move but stay reproducible. */
function walk(seed: number, steps: number, start: number, vol: number) {
  const r = rng(seed);
  const out: number[] = [];
  let v = start;
  for (let i = 0; i < steps; i++) {
    v *= 1 + (r() - 0.5) * vol;
    out.push(v);
  }
  return out;
}

const ATTR_CG = 'Data provided by CoinGecko';

export const cryptoMarkets: Connector = {
  info: {
    id: 'crypto.markets',
    name: 'Crypto markets',
    category: 'Finance',
    description: 'Top cryptocurrencies by market cap with price, volume and 24h change (CoinGecko, no key).',
    params: [
      {
        name: 'currency',
        label: 'Currency',
        type: 'enum',
        required: false,
        default: 'usd',
        options: ['usd', 'eur', 'gbp', 'czk'].map((v) => ({ value: v, label: v.toUpperCase() })),
      },
      { name: 'limit', label: 'Coins', type: 'number', required: false, default: 10, description: '1-100' },
    ],
    minRefreshSec: 120,
    docsUrl: 'https://docs.coingecko.com/reference/coins-markets',
    attribution: ATTR_CG,
  },
  async fetch(params, ctx) {
    const limit = Math.min(Math.max(Number(params.limit ?? 10), 1), 100);
    const json = await ctx.fetchJson<Record<string, unknown>[]>(
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=${params.currency ?? 'usd'}&order=market_cap_desc&per_page=${limit}&page=1&price_change_percentage=24h`,
    );
    return inferTable(
      json.map((c) => ({
        rank: c.market_cap_rank,
        id: c.id,
        symbol: String(c.symbol ?? '').toUpperCase(),
        name: c.name,
        price: c.current_price,
        market_cap: c.market_cap,
        volume_24h: c.total_volume,
        change_24h_pct: c.price_change_percentage_24h,
        high_24h: c.high_24h,
        low_24h: c.low_24h,
      })),
    );
  },
  sample(params) {
    const bucket = floorTo(Date.now(), 60_000);
    const limit = Math.min(Number(params.limit ?? 10), Object.keys(COINS).length);
    const rows = Object.entries(COINS)
      .slice(0, limit)
      .map(([id, c], i) => {
        const r = rng(seedOf(id, bucket));
        const price = c.price * (1 + (r() - 0.5) * 0.02);
        return {
          rank: i + 1,
          id,
          symbol: c.symbol.toUpperCase(),
          name: c.name,
          price: round(price, price < 10 ? 4 : 2),
          market_cap: Math.round(price * 1e7 * (12 - i)),
          volume_24h: Math.round(price * 1e6 * (12 - i) * (0.5 + r())),
          change_24h_pct: round((r() - 0.45) * 8, 2),
          high_24h: round(price * 1.02, 2),
          low_24h: round(price * 0.98, 2),
        };
      });
    return inferTable(rows);
  },
};

export const cryptoHistory: Connector = {
  info: {
    id: 'crypto.history',
    name: 'Crypto price history',
    category: 'Finance',
    description:
      'Price, market cap and volume history of one coin (CoinGecko ids like "bitcoin", "ethereum").',
    params: [
      { name: 'coin', label: 'Coin id', type: 'string', required: true, default: 'bitcoin' },
      {
        name: 'currency',
        label: 'Currency',
        type: 'enum',
        required: false,
        default: 'usd',
        options: ['usd', 'eur', 'gbp'].map((v) => ({ value: v, label: v.toUpperCase() })),
      },
      { name: 'days', label: 'Days', type: 'number', required: false, default: 30, description: '1-365' },
    ],
    minRefreshSec: 300,
    docsUrl: 'https://docs.coingecko.com/reference/coins-id-market-chart',
    attribution: ATTR_CG,
  },
  async fetch(params, ctx) {
    const days = Math.min(Math.max(Number(params.days ?? 30), 1), 365);
    const json = await ctx.fetchJson<{
      prices: [number, number][];
      market_caps: [number, number][];
      total_volumes: [number, number][];
    }>(
      `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(String(params.coin))}/market_chart?vs_currency=${params.currency ?? 'usd'}&days=${days}`,
    );
    return inferTable(
      json.prices.map(([t, price], i) => ({
        time: t,
        price,
        market_cap: json.market_caps[i]?.[1] ?? null,
        volume: json.total_volumes[i]?.[1] ?? null,
      })),
      { types: { time: 'time' } },
    );
  },
  sample(params) {
    const coin = COINS[String(params.coin)] ?? COINS.bitcoin!;
    const days = Math.min(Number(params.days ?? 30), 365);
    const step = days <= 2 ? HOUR / 12 : days <= 90 ? HOUR : DAY;
    const steps = Math.round((days * DAY) / step);
    const end = floorTo(Date.now(), step);
    const prices = walk(seedOf(params.coin, end), steps, coin.price, 0.012);
    return inferTable(
      prices.map((p, i) => ({
        time: end - (steps - 1 - i) * step,
        price: round(p, p < 10 ? 4 : 2),
        market_cap: Math.round(p * 1.9e7),
        volume: Math.round(p * 4e5 * (0.6 + ((i * 7) % 10) / 10)),
      })),
      { types: { time: 'time' } },
    );
  },
};

export const cryptoPrice: Connector = {
  info: {
    id: 'crypto.price',
    name: 'Crypto spot price',
    category: 'Finance',
    description:
      'Current price and 24h change for a few coins. Ideal for live KPIs; use "accumulate" for a live chart.',
    params: [
      {
        name: 'coins',
        label: 'Coin ids',
        type: 'string',
        required: true,
        default: 'bitcoin,ethereum',
        description: 'Comma separated CoinGecko ids',
      },
      {
        name: 'currency',
        label: 'Currency',
        type: 'enum',
        required: false,
        default: 'usd',
        options: ['usd', 'eur', 'gbp'].map((v) => ({ value: v, label: v.toUpperCase() })),
      },
    ],
    minRefreshSec: 60,
    docsUrl: 'https://docs.coingecko.com/reference/simple-price',
    attribution: ATTR_CG,
  },
  async fetch(params, ctx) {
    const cur = String(params.currency ?? 'usd');
    const json = await ctx.fetchJson<Record<string, Record<string, number>>>(
      `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(String(params.coins))}&vs_currencies=${cur}&include_24hr_change=true`,
    );
    return inferTable(
      Object.entries(json).map(([coin, v]) => ({
        coin,
        price: v[cur] ?? null,
        change_24h_pct: v[`${cur}_24h_change`] ?? null,
      })),
    );
  },
  sample(params) {
    const bucket = floorTo(Date.now(), 10_000);
    return inferTable(
      String(params.coins ?? 'bitcoin')
        .split(',')
        .map((c) => c.trim())
        .map((coin) => {
          const base = COINS[coin]?.price ?? 1;
          const series = walk(
            seedOf(coin, floorTo(Date.now(), DAY)),
            Math.floor((bucket % DAY) / 10_000) + 1,
            base,
            0.0015,
          );
          return {
            coin,
            price: round(series[series.length - 1]!, 2),
            change_24h_pct: round((series[series.length - 1]! / base - 1) * 100, 2),
          };
        }),
    );
  },
};

const ATTR_FX = 'Exchange rates from the European Central Bank via Frankfurter';

export const fxRates: Connector = {
  info: {
    id: 'fx.rates',
    name: 'Exchange rates',
    category: 'Finance',
    description: 'Daily ECB reference rates as a long table (date, currency, rate). No key.',
    params: [
      { name: 'base', label: 'Base currency', type: 'string', required: false, default: 'EUR' },
      {
        name: 'symbols',
        label: 'Currencies',
        type: 'string',
        required: false,
        default: 'USD,GBP,CHF,CZK',
        description: 'Comma separated ISO codes',
      },
      {
        name: 'days',
        label: 'Days of history',
        type: 'number',
        required: false,
        default: 90,
        description: '1-3650',
      },
    ],
    minRefreshSec: 3600,
    docsUrl: 'https://frankfurter.dev',
    attribution: ATTR_FX,
  },
  async fetch(params, ctx) {
    const days = Math.min(Math.max(Number(params.days ?? 90), 1), 3650);
    const from = new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
    const json = await ctx.fetchJson<{ rates: Record<string, Record<string, number>> }>(
      `https://api.frankfurter.dev/v1/${from}..?base=${encodeURIComponent(String(params.base ?? 'EUR'))}&symbols=${encodeURIComponent(String(params.symbols ?? 'USD'))}`,
    );
    const rows = Object.entries(json.rates ?? {}).flatMap(([date, rates]) =>
      Object.entries(rates).map(([currency, rate]) => ({ date, currency, rate })),
    );
    return inferTable(rows);
  },
  sample(params) {
    const symbols = String(params.symbols ?? 'USD')
      .split(',')
      .map((s) => s.trim().toUpperCase());
    const days = Math.min(Number(params.days ?? 90), 3650);
    const end = floorTo(Date.now(), DAY);
    const anchors: Record<string, number> = {
      USD: 1.08,
      GBP: 0.85,
      CHF: 0.94,
      CZK: 25.2,
      JPY: 162,
      PLN: 4.3,
      HUF: 395,
    };
    const rows = symbols.flatMap((cur) => {
      const series = walk(seedOf('fx', cur, end), days, anchors[cur] ?? 1.5, 0.006);
      return series.map((rate, i) => ({
        date: end - (days - 1 - i) * DAY,
        currency: cur,
        rate: round(rate, 4),
      }));
    });
    return inferTable(rows, { types: { date: 'time' } });
  },
};
