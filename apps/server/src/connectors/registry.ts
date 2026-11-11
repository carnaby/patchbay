import type { ConnectorInfo, DataTable } from '@patchbay/core';
import { HttpError } from '../util/errors.ts';
import { OutboundLimiter } from '../util/outbound.ts';
import { currentClient } from '../util/request-context.ts';
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

/** Shared by previews and saves, so both tell agents the same thing. */
export const unknownConnectorMessage = (id: string) =>
  `Unknown connector "${id}". Use list_connectors to see what is available.`;

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
  private readonly outbound: OutboundLimiter;
  private readonly connectors: readonly Connector[];
  private readonly byId: Map<string, Connector>;
  private readonly schemas: Map<string, ReturnType<typeof paramsSchema>>;

  /**
   * `outbound` is the server's one limiter (app.ts), whose connector buckets count these loads per upstream host.
   * `connectors` replaces the built-in list in tests only.
   */
  constructor(options: { offline: boolean; outbound?: OutboundLimiter; connectors?: readonly Connector[] }) {
    this.offline = options.offline;
    this.outbound = options.outbound ?? new OutboundLimiter();
    this.connectors = options.connectors ?? CONNECTORS;
    this.byId = new Map(this.connectors.map((c) => [c.info.id, c]));
    this.schemas = new Map(this.connectors.map((c) => [c.info.id, paramsSchema(c.info.params)]));
  }

  list(): ConnectorInfo[] {
    return this.connectors.map((c) => c.info);
  }

  /** Connector id to credit text, for the snapshots' attribution line. */
  attributions(): Record<string, string> {
    return Object.fromEntries(this.connectors.map((c) => [c.info.id, c.info.attribution]));
  }

  get(id: string): Connector | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  validateParams(id: string, raw: Record<string, unknown>): Params {
    const schema = this.schemas.get(id);
    if (!schema) throw new HttpError(400, unknownConnectorMessage(id));
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
      // Read now, inside the request that started the load: the queues are fair between clients.
      const client = currentClient();
      const places = new Map<string, Promise<void>>();
      const releases: (() => void)[] = [];
      let ended = false;
      // Every filter value is a new set of params and so a new upstream load: the budget is taken on the first request
      // to each host, which the demo connectors never send. One place per host for the whole load, as Hacker News asks
      // its host for up to 50 items at once. The place is held until the load settles, not until every request it sent
      // has ended: when one request of a fan-out fails, its siblings still run until their own 10 s timeout. Bounded.
      const limited = async <T>(url: string, headers?: Record<string, string>): Promise<T> => {
        const host = new URL(url).hostname.toLowerCase();
        let place = places.get(host);
        if (!place) {
          place = this.outbound.acquireConnectorSlot(client, host).then((release) => {
            // A place granted after the load ended (it failed on another host meanwhile) goes straight back, and no
            // request follows it: fetchJson is never called without a held place.
            if (ended) {
              release();
              throw new Error('The load ended before its turn came');
            }
            releases.push(release);
          });
          places.set(host, place);
        }
        await place;
        // The place may have been granted long ago and given back since: a branch that asks again after a sibling
        // failed would otherwise send its request with no place held.
        if (ended) throw new Error('The load ended before its turn came');
        return fetchJson<T>(url, headers ? { headers } : {});
      };
      try {
        const table = this.offline
          ? connector.sample(params)
          : await connector.fetch(params, { fetchJson: limited });
        const fetchedAt = Date.now();
        this.cache.set(key, { table, fetchedAt, expiresAt: fetchedAt + connector.info.minRefreshSec * 1000 });
        this.evict();
        return { table, fetchedAt };
      } catch (e) {
        // Serve a recent copy rather than an empty widget when upstream hiccups. Also when our own limit refused the
        // refresh: no error, so no retry hint, and the page asks again at its normal interval.
        if (hit && now - hit.fetchedAt < 3_600_000) {
          return {
            table: hit.table,
            fetchedAt: hit.fetchedAt,
            stale: e instanceof Error ? e.message : String(e),
          };
        }
        throw e;
      } finally {
        ended = true;
        for (const release of releases.splice(0)) release();
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
