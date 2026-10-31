/**
 * RSS 2.0, RSS 1.0 (RDF), Atom 1.0 and JSON Feed 1.x into one fixed table (proposal 0009).
 *
 * Feed content is untrusted markup, so every text becomes plain text here: the table renders text, and there is
 * nothing left to sanitise later. Links outside http/https are dropped here and checked again where they render.
 */
import { createHash } from 'node:crypto';
import type { Column, DataTable, Row } from '@patchbay/core';
import { XMLParser } from 'fast-xml-parser';
import { HttpError } from '../util/errors.ts';
import {
  cdataSections,
  declaresEntities,
  replaceTags,
  startsLikeHtml,
  stripMarkup,
  unclosedTagStarts,
} from './scan.ts';

export const FEED_COLUMNS: Column[] = [
  { name: 'id', type: 'string' },
  { name: 'title', type: 'string' },
  { name: 'link', type: 'string' },
  { name: 'published', type: 'time' },
  { name: 'summary', type: 'string' },
  { name: 'author', type: 'string' },
  { name: 'source', type: 'string' },
  { name: 'image', type: 'string' },
];

/** Items kept per feed before a dataset's own `limit`; the source schema allows at most 200. */
export const MAX_FEED_ITEMS = 200;
const MAX_TITLE = 300;
const MAX_SUMMARY = 500;
const MAX_SHORT = 200;
/**
 * Raw characters read per text field, markup included. Far more than any field shows, so real feeds read exactly
 * as before; it caps the work one hostile field can cause.
 */
const MAX_FIELD_RAW = 64 * 1024;
/** Links and dates longer than this are not links or dates. */
const MAX_LINK = 8 * 1024;
const MAX_DATE = 128;
/** fast-xml-parser rescans from each unclosed tag start (see `unclosedTagStarts`): a few cost little, many are an attack. */
const MAX_UNCLOSED_TAGS = 8;
/** Backstop for the whole document; the work is linear, so a real feed takes a small fraction of this. */
const PARSE_BUDGET_MS = 4000;

export interface ParsedFeed {
  title: string;
  table: DataTable;
  /** The feed's own `<ttl>` in minutes (RSS), when it states one. */
  ttlMinutes: number | null;
}

type Node = unknown;

/** Elements whose content may be text, escaped HTML, CDATA or nested xhtml. */
const RICH = ['title', 'description', 'summary', 'content', 'content:encoded', 'subtitle'];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  // The five XML entities and numeric references; DTD entities are refused before parsing (below).
  processEntities: true,
  htmlEntities: false,
  // Text fields are kept as raw inner XML and converted by `richText`: in object mode the parser would reorder mixed
  // content (Atom xhtml "Faster <em>maps</em>." came out as "maps Faster.").
  stopNodes: RICH.map((tag) => `*.${tag}`),
});

const list = (node: Node): Node[] =>
  node === undefined || node === null ? [] : Array.isArray(node) ? node : [node];

/**
 * Every text inside a node, attributes left out (Atom `type="xhtml"` content arrives as nested elements), up to
 * `budget` characters: a field with a million children must not cost a million strings.
 */
function textOf(node: Node, budget = MAX_FIELD_RAW): string {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    const s = String(node);
    return s.length > budget ? s.slice(0, budget) : s;
  }
  if (typeof node !== 'object') return '';
  const values = Array.isArray(node)
    ? node
    : Object.entries(node as Record<string, Node>)
        .filter(([key]) => !key.startsWith('@_'))
        .map(([, value]) => value);
  let out = '';
  for (let i = 0; i < values.length && out.length < budget; i++) {
    if (i > 0) out += ' ';
    out += textOf(values[i], budget - out.length);
  }
  return out;
}

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
};

/** HTML entities that survive XML decoding inside escaped HTML (`&amp;nbsp;` becomes `&nbsp;`). */
function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code =
        name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return NAMED[name.toLowerCase()] ?? whole;
  });
}

/**
 * The first `MAX_FIELD_RAW` characters, without a tag cut in half at the end (it would show as text). Every field
 * is cut before any other processing, so the work per field is bounded whatever the feed sends.
 */
function bounded(raw: string): { text: string; cut: boolean } {
  if (raw.length <= MAX_FIELD_RAW) return { text: raw, cut: false };
  const text = raw.slice(0, MAX_FIELD_RAW);
  const lt = text.lastIndexOf('<');
  return { text: lt !== -1 && text.indexOf('>', lt) === -1 ? text.slice(0, lt) : text, cut: true };
}

/** Markup to readable text: scripts and styles go with their content, block ends become spaces. */
export function plainText(raw: string, max: number): string {
  const text = decodeHtmlEntities(stripMarkup(bounded(raw).text))
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const text = (node: Node, max: number) => plainText(textOf(node), max) || null;

const XML_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decodeXml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (whole, name: string) => {
    if (name[0] !== '#') return XML_ENTITIES[name.toLowerCase()] ?? whole;
    const code =
      name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });

/**
 * Raw inner XML of a text element to plain text. CDATA is literal; outside it, element markup (nested xhtml) goes
 * first and XML entities are decoded after, which turns escaped HTML into HTML that `plainText` then strips.
 */
function richText(node: Node, max: number): string | null {
  const raw = bounded(textOf(node));
  let html = '';
  for (const part of cdataSections(raw.text, raw.cut)) {
    html += part.cdata ? part.text : decodeXml(replaceTags(part.text, /</g, ' '));
  }
  return plainText(html, max) || null;
}

/** An absolute http(s) URL resolved against the feed's address, or null. */
export function safeLink(href: string | null | undefined, base: string): string | null {
  if (!href || href.length > MAX_LINK) return null;
  try {
    const url = new URL(decodeHtmlEntities(href.trim()), base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Images are fetched by viewers' browsers later (proposal 0008), so only https is kept. */
const safeImage = (href: string | null | undefined, base: string) => {
  const url = safeLink(href, base);
  return url?.startsWith('https:') ? url : null;
};

function time(...candidates: Node[]): number | null {
  for (const c of candidates) {
    const raw = textOf(c, MAX_DATE * 4).trim();
    if (!raw || raw.length > MAX_DATE) continue;
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

const attr = (node: Node, name: string): string | null => {
  const value = node && typeof node === 'object' ? (node as Record<string, Node>)[`@_${name}`] : undefined;
  return typeof value === 'string' ? value : null;
};

const isImageType = (type: string | null) => Boolean(type?.toLowerCase().startsWith('image/'));

function mediaImage(item: Record<string, Node>, base: string): string | null {
  for (const thumb of list(item['media:thumbnail'])) {
    const url = safeImage(attr(thumb, 'url'), base);
    if (url) return url;
  }
  for (const group of [item, ...list(item['media:group'])] as Record<string, Node>[]) {
    for (const media of list(group?.['media:content'])) {
      if (attr(media, 'medium') === 'image' || isImageType(attr(media, 'type'))) {
        const url = safeImage(attr(media, 'url'), base);
        if (url) return url;
      }
    }
  }
  return null;
}

function itemId(id: string | null, link: string | null, title: string | null, published: number | null) {
  if (id) return id.slice(0, MAX_SHORT);
  if (link) return link.slice(0, MAX_SHORT);
  return createHash('sha256')
    .update(`${title ?? ''}|${published ?? ''}`)
    .digest('hex')
    .slice(0, 16);
}

function rssItem(item: Record<string, Node>, base: string, source: string): Row {
  const guid = item.guid;
  const guidText = text(guid, MAX_SHORT);
  const permalink = attr(guid, 'isPermaLink') !== 'false' ? safeLink(guidText, base) : null;
  const link = safeLink(textOf(item.link).trim(), base) ?? permalink;
  const title = richText(item.title, MAX_TITLE);
  const published = time(item.pubDate, item['dc:date'], item.published, item.updated);
  let image: string | null = null;
  for (const enclosure of list(item.enclosure)) {
    if (isImageType(attr(enclosure, 'type'))) image ??= safeImage(attr(enclosure, 'url'), base);
  }
  image ??= mediaImage(item, base) ?? safeImage(attr(item['itunes:image'], 'href'), base);
  return {
    id: itemId(guidText, link, title, published),
    title,
    link,
    published,
    summary: richText(item.description ?? item['content:encoded'], MAX_SUMMARY),
    author: text(item.author ?? item['dc:creator'], MAX_SHORT),
    source,
    image,
  };
}

function atomLink(entry: Record<string, Node>, base: string, rel: string, image = false): string | null {
  for (const link of list(entry.link)) {
    const linkRel = attr(link, 'rel') ?? 'alternate';
    if (linkRel !== rel) continue;
    if (image && !isImageType(attr(link, 'type'))) continue;
    const url = image ? safeImage(attr(link, 'href'), base) : safeLink(attr(link, 'href'), base);
    if (url) return url;
  }
  return null;
}

function atomEntry(entry: Record<string, Node>, base: string, source: string): Row {
  const link = atomLink(entry, base, 'alternate');
  const title = richText(entry.title, MAX_TITLE);
  const published = time(entry.published, entry.updated, entry.issued);
  const authors = list(entry.author).map((a) => text((a as Record<string, Node>)?.name ?? a, MAX_SHORT));
  return {
    id: itemId(text(entry.id, MAX_SHORT), link, title, published),
    title,
    link,
    published,
    summary: richText(entry.summary ?? entry.content, MAX_SUMMARY),
    author: authors.filter(Boolean).join(', ').slice(0, MAX_SHORT) || null,
    source,
    image: atomLink(entry, base, 'enclosure', true) ?? mediaImage(entry, base),
  };
}

interface JsonFeedItem {
  id?: unknown;
  url?: unknown;
  external_url?: unknown;
  title?: unknown;
  summary?: unknown;
  content_text?: unknown;
  content_html?: unknown;
  date_published?: unknown;
  date_modified?: unknown;
  image?: unknown;
  banner_image?: unknown;
  authors?: { name?: unknown }[];
  author?: { name?: unknown };
}

const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);

function jsonFeed(json: Record<string, unknown>, base: string, deadline: number): ParsedFeed {
  const source = plainText(str(json.title) ?? '', MAX_SHORT) || new URL(base).hostname;
  const items = Array.isArray(json.items) ? (json.items as JsonFeedItem[]) : [];
  const rows = rowsWithin(items, deadline, (item): Row => {
    const link = safeLink(str(item.url) ?? str(item.external_url), base);
    const title = str(item.title) ? plainText(str(item.title)!, MAX_TITLE) || null : null;
    const published = time(str(item.date_published), str(item.date_modified));
    const summarySource = str(item.summary) ?? str(item.content_text) ?? str(item.content_html);
    const author = (Array.isArray(item.authors) ? item.authors[0] : item.author)?.name;
    return {
      id: itemId(str(item.id), link, title, published),
      title,
      link,
      published,
      summary: summarySource ? plainText(summarySource, MAX_SUMMARY) || null : null,
      author: str(author) ? plainText(str(author)!, MAX_SHORT) || null : null,
      source,
      image: safeImage(str(item.image) ?? str(item.banner_image), base),
    };
  });
  return { title: source, table: finish(rows), ttlMinutes: null };
}

/** The first `MAX_FEED_ITEMS` items as rows, giving up when the document has used its time budget. */
function rowsWithin<T>(items: T[], deadline: number, toRow: (item: T) => Row): Row[] {
  const rows: Row[] = [];
  for (const item of items.slice(0, MAX_FEED_ITEMS)) {
    if (Date.now() > deadline) throw new HttpError(502, 'The feed took too long to read');
    rows.push(toRow(item));
  }
  return rows;
}

/** Newest first, undated items last, in their feed order. */
function finish(rows: Row[]): DataTable {
  const sorted = rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const x = a.row.published as number | null;
      const y = b.row.published as number | null;
      if (x === y) return a.i - b.i;
      if (x === null) return 1;
      if (y === null) return -1;
      return y - x;
    })
    .map((r) => r.row);
  return { columns: FEED_COLUMNS, rows: sorted };
}

const NOT_A_FEED = 'The address did not return an RSS, Atom or JSON feed';

export function looksLikeHtml(text: string, contentType: string): boolean {
  if (contentType === 'text/html' || contentType === 'application/xhtml+xml') return true;
  return startsLikeHtml(text.slice(0, 2048).replace(/^﻿/, ''));
}

/** Parses a feed document; `base` is the address it came from (relative links resolve against it). */
export function parseFeed(body: string, contentType: string, base: string): ParsedFeed {
  const deadline = Date.now() + PARSE_BUDGET_MS;
  const trimmed = body.replace(/^﻿/, '').trimStart();
  if (contentType.includes('json') || trimmed.startsWith('{')) {
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      throw new HttpError(502, NOT_A_FEED);
    }
    const version = (json as Record<string, unknown> | null)?.version;
    if (typeof version !== 'string' || !version.startsWith('https://jsonfeed.org/version/'))
      throw new HttpError(502, NOT_A_FEED);
    return jsonFeed(json as Record<string, unknown>, base, deadline);
  }
  // Entity expansion is the classic XML denial of service, and real feeds never declare entities.
  if (declaresEntities(trimmed.slice(0, 65_536)))
    throw new HttpError(502, 'Feeds with DTD entities are not supported');
  if (unclosedTagStarts(trimmed, MAX_UNCLOSED_TAGS + 1) > MAX_UNCLOSED_TAGS)
    throw new HttpError(502, NOT_A_FEED);

  let doc: Record<string, Node>;
  try {
    doc = parser.parse(trimmed) as Record<string, Node>;
  } catch {
    throw new HttpError(502, NOT_A_FEED);
  }

  const rss = doc.rss as Record<string, Node> | undefined;
  const channel = rss ? (list(rss.channel)[0] as Record<string, Node> | undefined) : undefined;
  if (channel) {
    const title = richText(channel.title, MAX_SHORT) ?? new URL(base).hostname;
    const items = list(channel.item) as Record<string, Node>[];
    const ttl = Number(textOf(channel.ttl));
    return {
      title,
      table: finish(rowsWithin(items, deadline, (item) => rssItem(item, base, title))),
      ttlMinutes: Number.isFinite(ttl) && ttl > 0 ? ttl : null,
    };
  }
  const rdf = doc['rdf:RDF'] as Record<string, Node> | undefined;
  if (rdf) {
    const title =
      richText((list(rdf.channel)[0] as Record<string, Node> | undefined)?.title, MAX_SHORT) ??
      new URL(base).hostname;
    const items = list(rdf.item) as Record<string, Node>[];
    const rows = rowsWithin(items, deadline, (item) => rssItem(item, base, title));
    return { title, table: finish(rows), ttlMinutes: null };
  }
  const feed = doc.feed as Record<string, Node> | undefined;
  if (feed && typeof feed === 'object') {
    const title = richText(feed.title, MAX_SHORT) ?? new URL(base).hostname;
    const entries = list(feed.entry) as Record<string, Node>[];
    const rows = rowsWithin(entries, deadline, (entry) => atomEntry(entry, base, title));
    return { title, table: finish(rows), ttlMinutes: null };
  }
  throw new HttpError(502, NOT_A_FEED);
}
