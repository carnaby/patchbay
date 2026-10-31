/**
 * Finds the feed a web page announces, so "https://www.bbc.com/news" works as a feed source:
 * `<link rel="alternate" type="application/rss+xml" href="…">` in the page's head.
 */

const FEED_TYPES = new Set([
  'application/rss+xml',
  'application/atom+xml',
  'application/feed+json',
  'application/json',
]);
/** The head is near the top; a page that hides its feed link after this point is not worth reading further. */
const SCAN_BYTES = 256 * 1024;

function attributes(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const re = /([^\s=/>"']+)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  // Skip the tag name itself.
  const body = tag.replace(/^<\s*link\b/i, '');
  for (const m of body.matchAll(re)) {
    attrs.set(m[1]!.toLowerCase(), (m[3] ?? m[4] ?? m[5] ?? '').replace(/&amp;/g, '&'));
  }
  return attrs;
}

/**
 * The first announced feed, resolved against the page's address. Plain http links are upgraded to https: feed
 * sources are https only, and sites that announce http feeds almost always serve them over https too.
 */
export function discoverFeed(html: string, pageUrl: string): string | null {
  for (const [tag] of html.slice(0, SCAN_BYTES).matchAll(/<link\b[^>]*>/gi)) {
    const attrs = attributes(tag);
    const rel = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/);
    const type = (attrs.get('type') ?? '').toLowerCase().trim();
    // JSON Feed pages announce application/feed+json; plain application/json is only accepted with a "feed" hint.
    if (!rel.includes('alternate') || !FEED_TYPES.has(type)) continue;
    if (type === 'application/json' && !/feed/i.test(attrs.get('title') ?? attrs.get('href') ?? '')) continue;
    const href = attrs.get('href');
    if (!href) continue;
    try {
      const url = new URL(href, pageUrl);
      if (url.protocol === 'http:') url.protocol = 'https:';
      if (url.protocol === 'https:') return url.href;
    } catch {
      // A broken href: try the next link.
    }
  }
  return null;
}
