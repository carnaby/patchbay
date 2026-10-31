import type { Config } from '../config.ts';

/** Name of the global function in apps/web/public/umami-hook.js. */
export const UMAMI_HOOK = 'patchbayUmamiBeforeSend';

const escapeAttr = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Marks where the requested page's path goes; cannot occur in Vite's output.
const PATH = '{{patchbay:path}}';

/**
 * Prepares the built index.html for this deployment once, and returns a cheap per-request renderer.
 *
 * Link previews need absolute URLs, and only the server knows its public origin (every self-hosted instance has its
 * own). og:url and canonical name the page itself: with "/" on every page, LinkedIn and Facebook would file every
 * shared dashboard link under the home page.
 */
export function prepareIndexHtml(html: string, config: Pick<Config, 'publicUrl' | 'analytics'>) {
  const origin = escapeAttr(config.publicUrl);
  let out = html
    .replace(/(<meta\s+property="og:image"\s+content=")\//g, (_, tag) => `${tag}${origin}/`)
    .replace(/(<meta\s+property="og:url"\s+content=")\/"/g, (_, tag) => `${tag}${origin}${PATH}"`)
    .replace(/(<link\s+rel="canonical"\s+href=")\/"/g, (_, tag) => `${tag}${origin}${PATH}"`);

  const analytics = config.analytics;
  if (analytics) {
    // defer: the tracker never delays rendering, and a blocked or unreachable tracker breaks nothing.
    // Execution order of deferred scripts is the document order, so the hook exists before the first pageview.
    const tags =
      '<script defer src="/umami-hook.js"></script>' +
      `<script defer src="${escapeAttr(analytics.scriptUrl)}"` +
      ` data-website-id="${escapeAttr(analytics.websiteId)}"` +
      ` data-domains="${escapeAttr(new URL(config.publicUrl).hostname)}"` +
      ' data-exclude-search="true" data-exclude-hash="true" data-do-not-track="true"' +
      ` data-before-send="${UMAMI_HOOK}"></script>`;
    out = out.replace('</head>', () => `${tags}</head>`);
  }

  const parts = out.split(PATH);
  return (path: string) => parts.join(escapeAttr(path));
}
