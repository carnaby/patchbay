import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { Agent } from 'undici';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../util/errors.ts';
import { FakeWorker, settle } from '../util/fake-worker.test-helper.ts';
import { OutboundLimiter } from '../util/outbound.ts';
import { discoverFeed } from './discover.ts';
import { looksLikeHtml, parseFeed, plainText, safeLink } from './parse.ts';
import { FeedParser } from './parser.ts';
import { sampleFeed } from './sample.ts';
import { cdataSections, stripMarkup, unclosedTagStarts } from './scan.ts';
import { FEED_FAILURE_TTL_MS, FEED_MIN_TTL_MS, FeedService } from './service.ts';

const BASE = 'https://news.example.com/feed.xml';
const rowsOf = (body: string, type = 'application/rss+xml') => parseFeed(body, type, BASE).table.rows;

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">
<channel>
  <title>Example &amp; News</title>
  <ttl>30</ttl>
  <item>
    <title><![CDATA[Older <b>bold</b> story]]></title>
    <link>/2026/older</link>
    <guid isPermaLink="false">id-1</guid>
    <pubDate>Thu, 29 Oct 2026 10:00:00 GMT</pubDate>
    <description>&lt;p&gt;First&amp;nbsp;paragraph&lt;/p&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;p&gt;second&lt;/p&gt;</description>
    <dc:creator>Jane Doe</dc:creator>
    <media:thumbnail url="https://cdn.example.com/a.jpg"/>
  </item>
  <item>
    <title>Newer story &#8211; with a dash</title>
    <link>javascript:alert(1)</link>
    <guid>https://news.example.com/newer</guid>
    <pubDate>Fri, 30 Oct 2026 08:30:00 +0100</pubDate>
    <enclosure url="http://cdn.example.com/b.jpg" type="image/jpeg" length="1"/>
  </item>
  <item>
    <title>Undated</title>
    <description>No date at all</description>
  </item>
</channel>
</rss>`;

describe('parseFeed', () => {
  it('reads RSS 2.0 into the fixed columns, newest first, as plain text', () => {
    const feed = parseFeed(RSS, 'application/rss+xml', BASE);
    expect(feed.title).toBe('Example & News');
    expect(feed.ttlMinutes).toBe(30);
    expect(feed.table.columns.map((c) => c.name)).toEqual([
      'id',
      'title',
      'link',
      'published',
      'summary',
      'author',
      'source',
      'image',
    ]);
    const [newer, older, undated] = feed.table.rows;
    expect(newer).toMatchObject({
      id: 'https://news.example.com/newer',
      title: 'Newer story – with a dash',
      // javascript: is dropped; a permalink guid stands in.
      link: 'https://news.example.com/newer',
      published: Date.UTC(2026, 9, 30, 7, 30),
      // http images are not kept: browsers will load them later, so https only.
      image: null,
      source: 'Example & News',
    });
    expect(older).toMatchObject({
      id: 'id-1',
      title: 'Older bold story',
      link: 'https://news.example.com/2026/older',
      summary: 'First paragraph second',
      author: 'Jane Doe',
      image: 'https://cdn.example.com/a.jpg',
    });
    expect(undated).toMatchObject({ title: 'Undated', published: null, link: null });
    // No link and no guid: a stable id from title and date.
    expect(undated!.id).toMatch(/^[0-9a-f]{16}$/);
    expect(rowsOf(RSS)[2]!.id).toBe(undated!.id);
  });

  it('reads RSS 1.0 (RDF)', () => {
    const rows = rowsOf(`<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://x.example/"><title>RDF feed</title></channel>
  <item rdf:about="https://x.example/1"><title>One</title><link>https://x.example/1</link><dc:date>2026-10-30T10:00:00Z</dc:date></item>
</rdf:RDF>`);
    expect(rows).toEqual([
      expect.objectContaining({
        title: 'One',
        link: 'https://x.example/1',
        source: 'RDF feed',
        published: Date.UTC(2026, 9, 30, 10),
      }),
    ]);
  });

  it('reads Atom, including xhtml content and enclosures', () => {
    const rows = rowsOf(
      `<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="html">Release &lt;i&gt;notes&lt;/i&gt;</title>
  <entry>
    <id>tag:x,2026:1</id>
    <title>v2.0</title>
    <link rel="enclosure" type="image/png" href="https://x.example/shot.png"/>
    <link href="/releases/v2.0"/>
    <updated>2026-10-30T09:00:00Z</updated>
    <author><name>Ann</name></author><author><name>Bo</name></author>
    <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Faster <em>maps</em>.</p></div></content>
  </entry>
</feed>`,
      'application/atom+xml',
    );
    expect(rows[0]).toEqual({
      id: 'tag:x,2026:1',
      title: 'v2.0',
      link: 'https://news.example.com/releases/v2.0',
      published: Date.UTC(2026, 9, 30, 9),
      summary: 'Faster maps .',
      author: 'Ann, Bo',
      source: 'Release notes',
      image: 'https://x.example/shot.png',
    });
  });

  it('reads JSON Feed', () => {
    const rows = rowsOf(
      JSON.stringify({
        version: 'https://jsonfeed.org/version/1.1',
        title: 'JSON news',
        items: [
          {
            id: 7,
            url: 'https://j.example/7',
            title: 'Seven',
            content_html: '<p>Hi &amp; bye</p>',
            date_published: '2026-10-30T10:00:00Z',
            authors: [{ name: 'Cy' }],
          },
        ],
      }),
      'application/feed+json',
    );
    expect(rows[0]).toMatchObject({
      id: '7',
      title: 'Seven',
      summary: 'Hi & bye',
      author: 'Cy',
      source: 'JSON news',
    });
  });

  it('refuses DTD entities, other documents and plain JSON', () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><rss><channel><title>&lol2;</title></channel></rss>`;
    expect(() => rowsOf(bomb)).toThrow('DTD entities');
    expect(() => rowsOf('<html><body>hi</body></html>', 'text/xml')).toThrow('did not return an RSS');
    expect(() => rowsOf('{"items":[]}', 'application/json')).toThrow('did not return an RSS');
    expect(() => rowsOf('not xml at all <<<', 'text/xml')).toThrow();
  });

  it('cuts long text and keeps only http(s) links', () => {
    expect(plainText(`<p>${'word '.repeat(200)}</p>`, 50)).toHaveLength(50);
    expect(plainText('a<style>.x{}</style>b<!-- c -->d', 100)).toBe('a b d');
    expect(safeLink('data:text/html,hi', BASE)).toBeNull();
    expect(safeLink(' /a?x=1&amp;y=2 ', BASE)).toBe('https://news.example.com/a?x=1&y=2');
  });

  it('recognises web pages', () => {
    expect(looksLikeHtml('<!DOCTYPE html><html>', '')).toBe(true);
    expect(looksLikeHtml('﻿  <!-- hi --><html lang="en">', 'text/plain')).toBe(true);
    expect(looksLikeHtml(RSS, 'application/xml')).toBe(false);
  });
});

describe('discoverFeed', () => {
  it('finds the announced feed with attributes in any order', () => {
    const html = `<html><head>
      <link rel="stylesheet" href="/a.css">
      <link href='/rss?x=1&amp;y=2' type="application/rss+xml" rel="alternate" title="News">
    </head></html>`;
    expect(discoverFeed(html, 'https://site.example/news/')).toBe('https://site.example/rss?x=1&y=2');
  });

  it('upgrades http, takes Atom and ignores other alternates', () => {
    expect(
      discoverFeed(
        '<link rel="alternate" hreflang="de" href="/de/"><link rel="Alternate" type="application/atom+xml" href="http://blog.example/atom.xml">',
        'https://blog.example/',
      ),
    ).toBe('https://blog.example/atom.xml');
    expect(discoverFeed('<p>no feed here</p>', 'https://x.example/')).toBeNull();
  });
});

// The largest body safe-fetch accepts. Before the linear scans, a few hundred kilobytes of these inputs blocked
// the event loop for seconds to hours; now each takes milliseconds, so the bound leaves room for slow CI runners.
const MAX_BODY = 5 * 1024 * 1024;
const LIMIT_MS = 200;
const fill = (unit: string, length = MAX_BODY) => unit.repeat(Math.ceil(length / unit.length));
const rssWith = (inner: string) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title><item><title>x</title>${inner}</item></channel></rss>`;

/** Runs `fn` and returns how long it took; refusing the input is fine, hanging is not. */
function timed(fn: () => unknown): number {
  const started = performance.now();
  try {
    fn();
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
  }
  return performance.now() - started;
}

describe('hostile feeds', () => {
  const parse = (body: string) => () => parseFeed(body, 'application/rss+xml', BASE);
  const cases: [string, () => unknown][] = [
    [
      'unclosed <script in CDATA',
      parse(rssWith(`<description><![CDATA[${fill('<script')}]]></description>`)),
    ],
    ['unclosed <style in CDATA', parse(rssWith(`<description><![CDATA[${fill('<style')}]]></description>`))],
    ['unclosed <!-- in CDATA', parse(rssWith(`<description><![CDATA[${fill('<!--')}]]></description>`))],
    ['unclosed <p in CDATA', parse(rssWith(`<description><![CDATA[${fill('<p')}]]></description>`))],
    ['escaped <![CDATA[ openers', parse(rssWith(`<description>${fill('&lt;![CDATA[')}</description>`))],
    ['unclosed tags in a text element', parse(rssWith(`<description>${fill('<a')}`))],
    ['unclosed quoted tags in a text element', parse(rssWith(`<description>${fill(`<x'`)}>`))],
    [
      'deeply nested elements',
      parse(rssWith(`<guid>${fill('<a>', MAX_BODY / 2)}${fill('</a>', MAX_BODY / 2)}</guid>`)),
    ],
    [
      'deeply nested markup in CDATA',
      parse(rssWith(`<description><![CDATA[${fill('<div><span>')}]]></description>`)),
    ],
    ['a DOCTYPE flood', parse(fill('<!DOCTYPE ['))],
    ['an unclosed DOCTYPE subset', parse(`<!DOCTYPE${fill('[')}`)],
    [
      '200 items of unclosed tags',
      parse(
        `<rss><channel>${fill(`<item><description><![CDATA[${'<p'.repeat(12_000)}]]></description></item>`)}</channel></rss>`,
      ),
    ],
    [
      'a JSON Feed summary of unclosed tags',
      () =>
        parseFeed(
          JSON.stringify({
            version: 'https://jsonfeed.org/version/1.1',
            items: [{ content_html: fill('<style') }],
          }),
          'application/feed+json',
          BASE,
        ),
    ],
    ['plainText over unclosed tags', () => plainText(fill('<script<!--<p '), 500)],
    // The helpers themselves, past the per-field cut that normally keeps their input small.
    ['CDATA openers without an end', () => cdataSections(fill('<![CDATA[x', 1024 * 1024))],
    ['markup soup', () => stripMarkup(fill('<script><style><!--<p <a href="', 1024 * 1024))],
    ['a page of comments', () => looksLikeHtml(fill('<!---->'), 'text/plain')],
    ['a <link flood', () => discoverFeed(`<html>${fill('<link')}`, 'https://site.example/')],
    [
      'a <link with endless attributes',
      () => discoverFeed(`<html><link ${fill('a="b" ')}`, 'https://site.example/'),
    ],
  ];
  it.each(cases)('reads %s in linear time', (_label, fn) => {
    expect(timed(fn)).toBeLessThan(LIMIT_MS);
  });

  it('refuses documents the XML parser would rescan from every tag', () => {
    expect(unclosedTagStarts('<a><b x="1">t</b></a>')).toBe(0);
    expect(unclosedTagStarts('<a><b x=">">t</b></a>')).toBe(0);
    expect(unclosedTagStarts(`<d>${'<a'.repeat(5)}`)).toBe(5);
    expect(unclosedTagStarts(`<d>'<a>`)).toBe(0);
    expect(unclosedTagStarts(`<d><a '>`)).toBe(1);
    expect(() => parseFeed(rssWith(`<description>${'<a'.repeat(20)}`), 'text/xml', BASE)).toThrow(
      'did not return an RSS',
    );
  });

  it('reads long fields as before, without a tag cut in half', () => {
    const long = `<p>${'word '.repeat(50_000)}</p>`;
    expect(plainText(long, 50)).toBe(plainText(long.slice(0, 1000), 50));
    const cut = plainText(`${'a'.repeat(65_530)}<a href="https://x.example/">b</a>`, 70_000);
    expect(cut.endsWith('a')).toBe(true);
    const rows = rowsOf(
      rssWith(
        `<description><![CDATA[${'<b>x</b> '.repeat(10_000)}]]></description><guid>${fill('<a>x</a>', 100_000)}</guid>`,
      ),
    );
    expect(rows[0]!.summary).toMatch(/^x x x .*…$/);
    expect((rows[0]!.id as string).length).toBeLessThanOrEqual(200);
  });
});

describe('FeedParser', () => {
  const parser = new FeedParser({ timeoutMs: 10_000 });
  afterAll(() => parser.close());

  it('parses on a worker exactly as inline', async () => {
    expect(await parser.parse(RSS, 'application/rss+xml', BASE)).toEqual(
      parseFeed(RSS, 'application/rss+xml', BASE),
    );
    expect(parser.running()).toBe(true);
  });

  it('passes parse errors through with their message', async () => {
    await expect(parser.parse('{"items":[]}', 'application/json', BASE)).rejects.toThrow(
      'did not return an RSS',
    );
    await expect(parser.parse('{"items":[]}', 'application/json', BASE)).rejects.toBeInstanceOf(HttpError);
  });

  it('stops a document that takes too long and carries on with a fresh worker', async () => {
    const slow = new FeedParser({ timeoutMs: 20 });
    try {
      const big = `<rss version="2.0"><channel>${fill('<item><title>a</title></item>')}</channel></rss>`;
      await expect(slow.parse(big, 'application/rss+xml', BASE)).rejects.toThrow('took too long');
      expect(slow.running()).toBe(false);
      // A fresh worker has to start, which can take longer than the 20 ms limit; the limit counts only parsing.
      await expect(slow.parse(RSS, 'application/rss+xml', BASE)).resolves.toMatchObject({
        title: 'Example & News',
      });
    } finally {
      await slow.close();
    }
  });

  it('ends the worker, not the server, when a document needs too much memory', async () => {
    const small = new FeedParser({ maxHeapMb: 24 });
    try {
      const flood = `<rss version="2.0"><channel><item><guid>${fill('<a>x</a>')}</guid></item></channel></rss>`;
      await expect(small.parse(flood, 'application/rss+xml', BASE)).rejects.toThrow('too large');
      await expect(small.parse(RSS, 'application/rss+xml', BASE)).resolves.toMatchObject({
        title: 'Example & News',
      });
    } finally {
      await small.close();
    }
  });

  it('survives over-limit documents back to back, one worker heap at a time', async () => {
    const small = new FeedParser({ maxHeapMb: 24 });
    try {
      const flood = `<rss version="2.0"><channel><item><guid>${fill('<a>x</a>')}</guid></item></channel></rss>`;
      const results = await Promise.allSettled([
        small.parse(flood, 'application/rss+xml', BASE),
        small.parse(flood, 'application/rss+xml', BASE),
        small.parse(RSS, 'application/rss+xml', BASE),
      ]);
      expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'fulfilled']);
      expect(small.threads()).toBeLessThanOrEqual(1);
    } finally {
      await small.close();
    }
  });

  it('starts the next worker only after the failed one has exited', async () => {
    const workers: FakeWorker[] = [];
    const fake = new FeedParser({
      createWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });
    try {
      const first = fake.parse(RSS, 'application/rss+xml', BASE);
      const second = fake.parse(RSS, 'application/rss+xml', BASE);
      await settle();
      const sent = workers[0]!.posted[0]!;
      // The document travels as transferred bytes, not as a cloned string.
      expect((sent.value as { bytes: Uint8Array }).bytes).toBeInstanceOf(Uint8Array);
      expect(sent.transfer).toHaveLength(1);
      workers[0]!.outOfMemory();
      await expect(first).rejects.toThrow('too large');
      await settle();
      expect(workers).toHaveLength(1);
      expect(fake.threads()).toBe(1);
      workers[0]!.exit();
      await settle();
      expect(workers).toHaveLength(2);
      const id = (workers[1]!.posted[0]!.value as { id: number }).id;
      workers[1]!.emit('message', { id, ok: true, feed: { title: 'ok' } });
      await expect(second).resolves.toMatchObject({ title: 'ok' });
    } finally {
      const closing = fake.close();
      workers.at(-1)!.exit();
      await closing;
    }
  });
});

describe('sampleFeed', () => {
  it('is deterministic and grows by one item every two minutes', () => {
    const t = Date.UTC(2026, 9, 30, 12, 0, 30);
    const a = sampleFeed('https://www.sme.sk/', t);
    expect(a.table.rows).toHaveLength(10);
    expect(a.title).toBe('sme.sk (offline sample)');
    expect(sampleFeed('https://www.sme.sk/', t).table.rows).toEqual(a.table.rows);
    const later = sampleFeed('https://www.sme.sk/', t + 2 * 60_000).table.rows;
    expect(later[1]!.id).toBe(a.table.rows[0]!.id);
    expect(later[0]!.id).not.toBe(a.table.rows[0]!.id);
  });
});

// A local upstream; the test dispatcher routes every request to it, whatever the host in the URL.
let server: Server;
let dispatcher: Agent;
const hits: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = `https://${req.headers.host}${req.url}`;
    hits.push(url);
    const send = (type: string, body: string) => {
      res.writeHead(200, { 'content-type': type });
      res.end(body);
    };
    switch (req.url) {
      case '/news':
        return send(
          'text/html; charset=utf-8',
          '<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head></html>',
        );
      case '/feed.xml':
        return send('application/rss+xml', RSS);
      case '/plain-page':
        return send('text/html', '<html><body>no feed</body></html>');
      case '/broken.xml':
        return send('application/rss+xml', `<rss><channel><item><description>${'<a'.repeat(50)}`);
      case '/private':
        return send(
          'text/html',
          '<link rel="alternate" type="application/rss+xml" href="https://127.0.0.1/feed.xml">',
        );
      default:
        res.writeHead(404);
        res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  dispatcher = new Agent({
    connect: (_options, callback) => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => callback(null, socket));
      socket.once('error', (e) => callback(e, null));
    },
  });
});

afterAll(async () => {
  await dispatcher.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
  vi.restoreAllMocks();
  hits.length = 0;
});

describe('FeedService', () => {
  const service = () => new FeedService({ offline: false, test: { dispatcher, timeoutMs: 2000 } });

  it('finds the feed behind a page, then asks the feed directly', async () => {
    const feeds = service();
    const feed = await feeds.load('https://site.example/news');
    expect(feed.feedUrl).toBe('https://site.example/feed.xml');
    expect(feed.table.rows).toHaveLength(3);
    expect(hits).toEqual(['https://site.example/news', 'https://site.example/feed.xml']);
  });

  it('asks each address at most every five minutes, honouring a longer ttl', async () => {
    const feeds = service();
    let now = Date.UTC(2026, 9, 30, 12);
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await feeds.load('https://site.example/feed.xml');
    await Promise.all([
      feeds.load('https://site.example/feed.xml'),
      feeds.load('https://site.example/feed.xml'),
    ]);
    expect(hits).toHaveLength(1);
    // The feed says <ttl>30</ttl>: longer than the five-minute floor, so it is honoured.
    now += FEED_MIN_TTL_MS + 1;
    await feeds.load('https://site.example/feed.xml');
    expect(hits).toHaveLength(1);
    now += 30 * 60_000;
    await feeds.load('https://site.example/feed.xml');
    expect(hits).toHaveLength(2);
  });

  it('explains when a page announces no feed', async () => {
    await expect(service().load('https://site.example/plain-page')).rejects.toThrow('No feed found');
  });

  it('remembers a failure for a few minutes instead of fetching and parsing again', async () => {
    const feeds = service();
    let now = Date.UTC(2026, 9, 30, 12);
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    for (const url of ['https://site.example/broken.xml', 'https://site.example/plain-page']) {
      const message = url.endsWith('.xml') ? 'did not return an RSS' : 'No feed found';
      await expect(feeds.load(url)).rejects.toThrow(message);
      await expect(Promise.all([feeds.load(url), feeds.load(url)])).rejects.toThrow(message);
      now += FEED_FAILURE_TTL_MS - 1;
      await expect(feeds.load(url)).rejects.toThrow(message);
      expect(hits).toEqual([url]);
      now += 2;
      await expect(feeds.load(url)).rejects.toThrow(message);
      expect(hits).toEqual([url, url]);
      hits.length = 0;
    }
  });

  it('keeps the SSRF guard on the page and on the discovered feed', async () => {
    await expect(service().load('https://127.0.0.1/feed.xml')).rejects.toThrow(/private|local|not allowed/i);
    await expect(service().load('https://site.example/private')).rejects.toThrow(
      /private|local|not allowed/i,
    );
    expect(hits).toEqual(['https://site.example/private']);
  });

  it("goes through the outbound limiter, and does not remember the limiter's refusal as a failure", async () => {
    const feeds = new FeedService({
      offline: false,
      test: { dispatcher, timeoutMs: 2000 },
      outbound: new OutboundLimiter({ perHostPerMinute: 2 }),
    });
    // Discovery takes two requests to the host: the page and its feed. That is the host's budget.
    await feeds.load('https://site.example/news');
    await expect(feeds.load('https://site.example/plain-page')).rejects.toMatchObject({ status: 429 });
    expect(hits).toEqual(['https://site.example/news', 'https://site.example/feed.xml']);
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    now += 60_000;
    await expect(feeds.load('https://site.example/plain-page')).rejects.toThrow('No feed found');
    expect(hits).toHaveLength(3);
  });

  it('serves the sample offline without any request', async () => {
    const feed = await new FeedService({ offline: true }).load('https://site.example/news');
    expect(feed.table.rows).toHaveLength(10);
    expect(hits).toHaveLength(0);
  });
});
