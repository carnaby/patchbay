/**
 * The search widget (proposal 0009). The browser builds the results URL and navigates there itself: the query
 * never reaches the Patchbay server, and no `<form action>` is needed (the CSP keeps `form-action 'self'`).
 */
import type { SearchConfig } from './schema.ts';

export const SEARCH_ENGINES = [
  'google',
  'duckduckgo',
  'bing',
  'startpage',
  'ecosia',
  'kagi',
  'custom',
] as const;
export type SearchEngine = (typeof SEARCH_ENGINES)[number];

export const SEARCH_ENGINE_LABELS: Record<SearchEngine, string> = {
  google: 'Google',
  duckduckgo: 'DuckDuckGo',
  bing: 'Bing',
  startpage: 'Startpage',
  ecosia: 'Ecosia',
  kagi: 'Kagi',
  custom: 'Custom',
};

export const SEARCH_TEMPLATES: Record<Exclude<SearchEngine, 'custom'>, string> = {
  google: 'https://www.google.com/search?q={q}',
  duckduckgo: 'https://duckduckgo.com/?q={q}',
  bing: 'https://www.bing.com/search?q={q}',
  startpage: 'https://www.startpage.com/do/search?q={q}',
  ecosia: 'https://www.ecosia.org/search?q={q}',
  kagi: 'https://kagi.com/search?q={q}',
};

/** "Search Google", or "Search example.com" for a custom engine. */
export function searchPlaceholder(config: SearchConfig): string {
  if (config.engine !== 'custom') return `Search ${SEARCH_ENGINE_LABELS[config.engine]}`;
  try {
    return `Search ${new URL(config.template!.replaceAll('{q}', '')).hostname.replace(/^www\./, '')}`;
  } catch {
    return 'Search';
  }
}

/**
 * The results URL, or null for an empty query or an unusable template. The query is percent-encoded, so it can
 * only ever land in the `{q}` slot: it cannot change the scheme, host or path.
 */
export function searchUrl(config: SearchConfig, query: string): string | null {
  const q = query.trim();
  if (!q) return null;
  const template = config.engine === 'custom' ? config.template : SEARCH_TEMPLATES[config.engine];
  if (!template?.includes('{q}')) return null;
  const url = template.replaceAll('{q}', encodeURIComponent(q));
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}
