/**
 * Loads feed sources: fetch through the SSRF guard, find the feed a page announces, parse, cache.
 *
 * A feed is asked for at most every five minutes per address, shared by every dashboard on the instance, whatever a
 * dataset's refresh interval: many publishers block clients that poll faster, and news does not need it. A failure
 * is remembered for a few minutes too: otherwise every read of a dashboard pointing at a broken or hostile address
 * would fetch and parse it again.
 */

import { FEED_MIN_REFRESH_SEC } from '@patchbay/core';
import { HttpError } from '../util/errors.ts';
import type { OutboundLimiter } from '../util/outbound.ts';
import { currentClient } from '../util/request-context.ts';
import { safeFetchText, type UpstreamTestSeam } from '../util/safe-fetch.ts';
import { discoverFeed } from './discover.ts';
import { looksLikeHtml, type ParsedFeed } from './parse.ts';
import { FeedParser, type ParseFn } from './parser.ts';
import { sampleFeed } from './sample.ts';

export const FEED_MIN_TTL_MS = FEED_MIN_REFRESH_SEC * 1000;
/** A feed's own longer `<ttl>` is honoured up to this. */
const FEED_MAX_TTL_MS = 60 * 60_000;
const DISCOVERY_TTL_MS = 24 * 60 * 60_000;
export const FEED_FAILURE_TTL_MS = 3 * 60_000;
const MAX_ENTRIES = 200;
const ACCEPT =
  'application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.5, */*;q=0.1';

export interface LoadedFeed extends ParsedFeed {
  fetchedAt: number;
  /** The feed's own address when it was found through a page. */
  feedUrl: string;
}

interface Entry {
  feed: LoadedFeed;
  expiresAt: number;
}

/** One parsing worker for the whole process, started on first use. */
let sharedParser: FeedParser | undefined;
const parseOnWorker: ParseFn = (body, contentType, base) => {
  sharedParser ??= new FeedParser();
  return sharedParser.parse(body, contentType, base);
};

/** Map insertion order doubles as age: the oldest entry goes first when a map is full. */
function remember<V>(map: Map<string, V>, key: string, value: V) {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_ENTRIES) map.delete(map.keys().next().value!);
}

export class FeedService {
  private readonly cache = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<LoadedFeed>>();
  /** Page address -> the feed it announces. */
  private readonly discovered = new Map<string, { feedUrl: string; at: number }>();
  /** Address -> why it failed, until when. */
  private readonly failed = new Map<string, { error: unknown; until: number }>();
  private readonly offline: boolean;
  private readonly test: UpstreamTestSeam | undefined;
  private readonly parse: ParseFn;
  private readonly outbound: OutboundLimiter | undefined;

  constructor(options: {
    offline: boolean;
    test?: UpstreamTestSeam | undefined;
    parse?: ParseFn;
    /** The limiter HTTP sources go through: feed addresses are chosen by users just the same. */
    outbound?: OutboundLimiter | undefined;
  }) {
    this.offline = options.offline;
    this.test = options.test;
    this.parse = options.parse ?? parseOnWorker;
    this.outbound = options.outbound;
  }

  private get(url: string) {
    const fetchText = () => safeFetchText(url, { accept: ACCEPT, test: this.test });
    return this.outbound ? this.outbound.run(currentClient(), url, fetchText) : fetchText();
  }

  async load(url: string): Promise<LoadedFeed> {
    const now = Date.now();
    if (this.offline) return { ...sampleFeed(url, now), fetchedAt: now, feedUrl: url };
    const hit = this.cache.get(url);
    if (hit && hit.expiresAt > now) return hit.feed;
    const failure = this.failed.get(url);
    if (failure && failure.until > now) throw failure.error;
    let pending = this.inflight.get(url);
    if (!pending) {
      pending = this.fetchOrRemember(url);
      this.inflight.set(url, pending);
      // Chained after set: cleanup must never run before the entry exists (see ConnectorService.load).
      const settle = () => {
        if (this.inflight.get(url) === pending) this.inflight.delete(url);
      };
      pending.then(settle, settle);
    }
    return pending;
  }

  private async fetchOrRemember(url: string): Promise<LoadedFeed> {
    try {
      const feed = await this.fetch(url);
      this.failed.delete(url);
      return feed;
    } catch (e) {
      // 503 is this server being busy or shutting down and 429 its own per-host budget, not the address failing.
      if (!(e instanceof HttpError && (e.status === 503 || e.status === 429)))
        remember(this.failed, url, { error: e, until: Date.now() + FEED_FAILURE_TTL_MS });
      throw e;
    }
  }

  private async fetch(url: string): Promise<LoadedFeed> {
    const known = this.discovered.get(url);
    const start = known && Date.now() - known.at < DISCOVERY_TTL_MS ? known.feedUrl : url;
    let res = await this.get(start);
    if (looksLikeHtml(res.text, res.contentType)) {
      const feedUrl = discoverFeed(res.text, res.url);
      if (!feedUrl) {
        throw new HttpError(
          502,
          `No feed found at ${url}. Paste the feed address instead (often ending in /rss, /feed or .xml).`,
        );
      }
      remember(this.discovered, url, { feedUrl, at: Date.now() });
      res = await this.get(feedUrl);
      if (looksLikeHtml(res.text, res.contentType))
        throw new HttpError(502, `${feedUrl} is a web page, not a feed`);
    }
    const parsed = await this.parse(res.text, res.contentType, res.url);
    const fetchedAt = Date.now();
    const feed: LoadedFeed = { ...parsed, fetchedAt, feedUrl: res.url };
    const ttl = Math.min(FEED_MAX_TTL_MS, Math.max(FEED_MIN_TTL_MS, (parsed.ttlMinutes ?? 0) * 60_000));
    remember(this.cache, url, { feed, expiresAt: fetchedAt + ttl });
    return feed;
  }
}
