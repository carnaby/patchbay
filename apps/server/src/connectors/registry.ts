import type { ConnectorInfo, DataTable } from '@patchbay/core';
import { HttpError } from '../util/errors.ts';
import { fetchJson } from '../util/safe-fetch.ts';
import { demoSales, demoSignal } from './demo.ts';
import { githubRepo, hackerNews, npmDownloads } from './dev.ts';
import { cryptoHistory, cryptoMarkets, cryptoPrice, fxRates } from './finance.ts';
import { type Connector, type Params, paramsSchema } from './types.ts';
import { airQuality, weatherCurrent, weatherForecast } from './weather.ts';
import { earthquakes, issPosition, wikipediaViews, worldBank } from './world.ts';

export const CONNECTORS: Connector[] = [
  weatherForecast,
  weatherCurrent,
  airQuality,
  cryptoMarkets,
  cryptoPrice,
  cryptoHistory,
  fxRates,
  earthquakes,
  issPosition,
  worldBank,
  wikipediaViews,
  hackerNews,
  githubRepo,
  npmDownloads,
  demoSignal,
  demoSales,
];

const byId = new Map(CONNECTORS.map((c) => [c.info.id, c]));
const schemas = new Map(CONNECTORS.map((c) => [c.info.id, paramsSchema(c.info.params)]));

interface CacheEntry {
  table: DataTable;
  fetchedAt: number;
  expiresAt: number;
}

export interface ConnectorResult {
  table: DataTable;
  fetchedAt: number;
  /** Set when upstream failed and a recent cached copy was served instead. */
  stale?: string;
}

/**
 * Calls connectors with a shared TTL cache. Many viewers of many dashboards
 * asking for the same city's weather result in one upstream request per TTL,
 * which keeps us well inside the free tiers' rate limits.
 */
export class ConnectorService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<ConnectorResult>>();
  private readonly offline: boolean;

  constructor(options: { offline: boolean }) {
    this.offline = options.offline;
  }

  list(): ConnectorInfo[] {
    return CONNECTORS.map((c) => c.info);
  }

  get(id: string): Connector | undefined {
    return byId.get(id);
  }

  validateParams(id: string, raw: Record<string, unknown>): Params {
    const schema = schemas.get(id);
    if (!schema)
      throw new HttpError(400, `Unknown connector "${id}". Use list_connectors to see what is available.`);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new HttpError(
        400,
        `Invalid params for ${id}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; ')}`,
      );
    }
    return parsed.data as Params;
  }

  async load(id: string, rawParams: Record<string, unknown>): Promise<ConnectorResult> {
    const connector = this.get(id);
    if (!connector) throw new HttpError(400, `Unknown connector "${id}"`);
    const params = this.validateParams(id, rawParams);
    const key = `${id}:${JSON.stringify(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)))}`;
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > now) return { table: hit.table, fetchedAt: hit.fetchedAt };
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const run = (async (): Promise<ConnectorResult> => {
      try {
        const table = this.offline
          ? connector.sample(params)
          : await connector.fetch(params, {
              fetchJson: (url, headers) => fetchJson(url, headers ? { headers } : {}),
            });
        const fetchedAt = Date.now();
        this.cache.set(key, { table, fetchedAt, expiresAt: fetchedAt + connector.info.minRefreshSec * 1000 });
        this.evict();
        return { table, fetchedAt };
      } catch (e) {
        // Serve a recent copy rather than an empty widget when upstream hiccups.
        if (hit && now - hit.fetchedAt < 3_600_000) {
          return {
            table: hit.table,
            fetchedAt: hit.fetchedAt,
            stale: e instanceof Error ? e.message : String(e),
          };
        }
        throw e;
      }
    })();
    this.inflight.set(key, run);
    // Cleanup must be chained after set: an offline sample resolves synchronously, so a
    // `finally` inside the IIFE ran before set and left a settled promise cached forever.
    const settle = () => {
      if (this.inflight.get(key) === run) this.inflight.delete(key);
    };
    run.then(settle, settle);
    return run;
  }

  private evict() {
    if (this.cache.size <= 500) return;
    const oldest = [...this.cache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt).slice(0, 100);
    for (const [k] of oldest) this.cache.delete(k);
  }
}
