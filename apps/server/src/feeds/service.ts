/**
 * Loads feed sources: fetch through the SSRF guard, find the feed a page announces, parse, cache.
 *
 * A feed is asked for at most every five minutes per address, shared by every dashboard on the instance, whatever a
 * dataset's refresh interval: many publishers block clients that poll faster, and news does not need it.
 */

import { FEED_MIN_REFRESH_SEC } from '@patchbay/core';
import { HttpError } from '../util/errors.ts';
import { safeFetchText, type UpstreamTestSeam } from '../util/safe-fetch.ts';
import { discoverFeed } from './discover.ts';
import { looksLikeHtml, type ParsedFeed, parseFeed } from './parse.ts';
import { sampleFeed } from './sample.ts';

export const FEED_MIN_TTL_MS = FEED_MIN_REFRESH_SEC * 1000;
/** A feed's own longer `<ttl>` is honoured up to this. */
const FEED_MAX_TTL_MS = 60 * 60_000;
const DISCOVERY_TTL_MS = 24 * 60 * 60_000;
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

export class FeedService {
  private readonly cache = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<LoadedFeed>>();
  /** Page address -> the feed it announces. */
  private readonly discovered = new Map<string, { feedUrl: string; at: number }>();
  private readonly offline: boolean;
  private readonly test: UpstreamTestSeam | undefined;

  constructor(options: { offline: boolean; test?: UpstreamTestSeam | undefined }) {
    this.offline = options.offline;
    this.test = options.test;
  }

  async load(url: string): Promise<LoadedFeed> {
    const now = Date.now();
    if (this.offline) return { ...sampleFeed(url, now), fetchedAt: now, feedUrl: url };
    const hit = this.cache.get(url);
    if (hit && hit.expiresAt > now) return hit.feed;
    let pending = this.inflight.get(url);
    if (!pending) {
      pending = this.fetch(url);
      this.inflight.set(url, pending);
      // Chained after set: cleanup must never run before the entry exists (see ConnectorService.load).
      const settle = () => {
        if (this.inflight.get(url) === pending) this.inflight.delete(url);
      };
      pending.then(settle, settle);
    }
    return pending;
  }

  private async fetch(url: string): Promise<LoadedFeed> {
    const known = this.discovered.get(url);
    const start = known && Date.now() - known.at < DISCOVERY_TTL_MS ? known.feedUrl : url;
    let res = await safeFetchText(start, { accept: ACCEPT, test: this.test });
    if (looksLikeHtml(res.text, res.contentType)) {
      const feedUrl = discoverFeed(res.text, res.url);
      if (!feedUrl) {
        throw new HttpError(
          502,
          `No feed found at ${url}. Paste the feed address instead (often ending in /rss, /feed or .xml).`,
        );
      }
      this.discovered.set(url, { feedUrl, at: Date.now() });
      res = await safeFetchText(feedUrl, { accept: ACCEPT, test: this.test });
      if (looksLikeHtml(res.text, res.contentType))
        throw new HttpError(502, `${feedUrl} is a web page, not a feed`);
    }
    const parsed = parseFeed(res.text, res.contentType, res.url);
    const fetchedAt = Date.now();
    const feed: LoadedFeed = { ...parsed, fetchedAt, feedUrl: res.url };
    const ttl = Math.min(FEED_MAX_TTL_MS, Math.max(FEED_MIN_TTL_MS, (parsed.ttlMinutes ?? 0) * 60_000));
    this.cache.set(url, { feed, expiresAt: fetchedAt + ttl });
    if (this.cache.size > MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
    if (this.discovered.size > MAX_ENTRIES) this.discovered.delete(this.discovered.keys().next().value!);
    return feed;
  }
}
