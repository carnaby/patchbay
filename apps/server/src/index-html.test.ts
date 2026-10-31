/**
 * The served index.html: link previews with absolute URLs from PUBLIC_URL, and Umami analytics only when the
 * operator configures them (a self-hosted instance must not talk to any third party by default).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, createDeps } from './app.ts';
import { loadConfig } from './config.ts';
import type { Deps } from './context.ts';
import { prepareIndexHtml } from './util/index-html.ts';

const PUBLIC_URL = 'https://dashboards.example.org';
const SCRIPT = 'https://umami.example.net/script.js';
const WEBSITE = '00000000-0000-4000-8000-000000000000';
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

// The real head, so the test breaks if someone rewrites the tags into a shape the server no longer recognises.
const SOURCE = readFileSync(join(import.meta.dirname, '../../web/index.html'), 'utf8');

let dir: string;
let deps: Deps;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay-html-test-'));
  const dist = join(dir, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), SOURCE);
  writeFileSync(join(dist, 'og.png'), PNG);
  writeFileSync(join(dist, 'umami-hook.js'), '');
  deps = await createDeps(
    loadConfig({
      NODE_ENV: 'test',
      DATA_DIR: join(dir, 'data'),
      OFFLINE: '1',
      PUBLIC_URL,
      WEB_DIST: dist,
      PIPELINE_WORKERS: '0',
    }),
  );
});

afterAll(async () => {
  deps.hub.close();
  await deps.pipeline.close();
  deps.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const withAnalytics = () =>
  createApp({
    ...deps,
    config: {
      ...deps.config,
      analytics: loadConfig({ UMAMI_SCRIPT_URL: SCRIPT, UMAMI_WEBSITE_ID: WEBSITE }).analytics,
    },
  });

const get = (app: ReturnType<typeof createApp>, path: string) => app.request(`${PUBLIC_URL}${path}`);

const csp = (res: Response) =>
  Object.fromEntries(
    res.headers
      .get('content-security-policy')!
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .filter((d) => d[0])
      .map(([name, ...values]) => [name, values]),
  );

describe('link previews', () => {
  it('uses absolute URLs from PUBLIC_URL and names the shared page', async () => {
    const app = createApp(deps);
    for (const [path, canonical] of [
      ['/', '/'],
      ['/index.html', '/'],
      ['/d/abc123?key=secret#x', '/d/abc123'],
    ] as const) {
      const res = await get(app, path);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(`<meta property="og:image" content="${PUBLIC_URL}/og.png" />`);
      expect(html).toContain(`<meta property="og:url" content="${PUBLIC_URL}${canonical}" />`);
      expect(html).toMatch(new RegExp(`<link rel="canonical" href="${PUBLIC_URL}${canonical}"[ />]`));
      expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
      expect(html).not.toContain('secret');
      expect(res.headers.get('cache-control')).toBe('no-cache');
    }
  });

  it('escapes the requested path', async () => {
    const html = await (await get(createApp(deps), '/d/%22%3E%3Cscript%3E')).text();
    expect(html).toContain(`href="${PUBLIC_URL}/d/%22%3E%3Cscript%3E"`);
    expect(prepareIndexHtml(SOURCE, { publicUrl: PUBLIC_URL, analytics: null })('/"<x>')).toContain(
      `href="${PUBLIC_URL}/&quot;&lt;x&gt;"`,
    );
  });

  it('serves the preview image as a PNG, not the app shell', async () => {
    const res = await get(createApp(deps), '/og.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
  });
});

describe('Umami analytics', () => {
  it('is off by default: no script, and the CSP allows only this origin', async () => {
    expect(deps.config.analytics).toBeNull();
    const res = await get(createApp(deps), '/');
    const html = await res.text();
    expect(html).not.toContain('umami');
    expect(html).not.toContain('data-website-id');
    const policy = csp(res);
    expect(policy['script-src']).toEqual(["'self'"]);
    expect(policy['connect-src']).toEqual(["'self'"]);
  });

  it('treats empty variables (what compose passes for unset ones) as unset', () => {
    expect(loadConfig({ UMAMI_SCRIPT_URL: '', UMAMI_WEBSITE_ID: '' }).analytics).toBeNull();
  });

  it('injects the tracker and allows exactly its origin when configured', async () => {
    const res = await get(withAnalytics(), '/d/abc123');
    const html = await res.text();
    expect(html).toContain(
      '<script defer src="/umami-hook.js"></script>' +
        `<script defer src="${SCRIPT}" data-website-id="${WEBSITE}" data-domains="dashboards.example.org"` +
        ' data-exclude-search="true" data-exclude-hash="true" data-do-not-track="true"' +
        ' data-before-send="patchbayUmamiBeforeSend"></script></head>',
    );
    const policy = csp(res);
    expect(policy['script-src']).toEqual(["'self'", 'https://umami.example.net']);
    expect(policy['connect-src']).toEqual(["'self'", 'https://umami.example.net']);
    // Nothing else is loosened.
    const plain = csp(await get(createApp(deps), '/'));
    for (const name of Object.keys(plain).filter((n) => n !== 'script-src' && n !== 'connect-src'))
      expect([name, policy[name]]).toEqual([name, plain[name]]);
    expect(Object.keys(policy).sort()).toEqual(Object.keys(plain).sort());
  });

  it('never sends dashboard IDs, dashboard titles, query strings or fragments', () => {
    const source = readFileSync(join(import.meta.dirname, '../../web/public/umami-hook.js'), 'utf8');
    const window: Record<string, any> = {};
    const location = new URL(`${PUBLIC_URL}/d/abc123?key=1`);
    new Function('window', 'location', source)(window, location);
    const hook = window.patchbayUmamiBeforeSend as (type: string, payload: object) => any;

    expect(
      hook('event', {
        url: `${PUBLIC_URL}/d/abc123/?code=x#k`,
        referrer: '/d/zzz9?state=y',
        title: 'Salaries 2026 · Patchbay',
        website: WEBSITE,
      }),
    ).toEqual({
      url: `${PUBLIC_URL}/d/:id/`,
      referrer: '/d/:id',
      title: 'Dashboard · Patchbay',
      website: WEBSITE,
    });
    expect(
      hook('event', {
        url: `${PUBLIC_URL}/oauth/consent?code=x`,
        referrer: 'https://news.ycombinator.com/item?id=1',
        title: 'Authorize access · Patchbay',
      }),
    ).toEqual({
      url: `${PUBLIC_URL}/oauth/consent`,
      referrer: 'https://news.ycombinator.com/item',
      title: 'Authorize access · Patchbay',
    });
    // Another site's /d/ path is not ours to rewrite.
    expect(hook('event', { url: `${PUBLIC_URL}/`, referrer: 'https://other.example/d/x' }).referrer).toBe(
      'https://other.example/d/x',
    );
  });

  it('refuses half a configuration and anything but https and a UUID', () => {
    expect(() => loadConfig({ UMAMI_SCRIPT_URL: SCRIPT })).toThrow(/UMAMI_WEBSITE_ID/);
    expect(() => loadConfig({ UMAMI_WEBSITE_ID: WEBSITE })).toThrow(/UMAMI_SCRIPT_URL/);
    expect(() =>
      loadConfig({ UMAMI_SCRIPT_URL: 'http://umami.example.net/script.js', UMAMI_WEBSITE_ID: WEBSITE }),
    ).toThrow(/https/);
    expect(() => loadConfig({ UMAMI_SCRIPT_URL: SCRIPT, UMAMI_WEBSITE_ID: 'my-site' })).toThrow(/UUID/);
  });
});
