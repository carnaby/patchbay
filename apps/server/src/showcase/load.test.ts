import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIMITS } from '@patchbay/core';
import { afterAll, describe, expect, it } from 'vitest';
import { buildTemplate } from '../services/templates.ts';
import { loadUseCases, MAX_ATTACHMENT_BYTES, MAX_VIDEO_BYTES, trustedSourceUrls } from './load.ts';

function useCase(root: string, slug: string, files: Record<string, string | Buffer>) {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
}

const roots: string[] = [];
const tempRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'pb-showcase-'));
  roots.push(root);
  return root;
};
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const meta = (id: string, order = 1, extra: object = {}) =>
  JSON.stringify({ id, order, title: `Title ${id}`, tab: 'Tab', description: 'Description.', ...extra });
const doc = (extra: object = {}) => JSON.stringify({ ...buildTemplate('blank', 'Showcase'), ...extra });

describe('loadUseCases', () => {
  it('loads valid folders sorted by order and skips broken ones with one warning each', () => {
    const root = tempRoot();
    useCase(root, 'second', {
      'meta.json': meta('second', 2),
      'prompt.md': 'Build B',
      'dashboard.json': doc(),
    });
    useCase(root, 'first', {
      'meta.json': meta('first', 1),
      'prompt.md': 'Build A\n',
      'dashboard.json': doc(),
    });
    useCase(root, 'bad-json', { 'meta.json': '{', 'prompt.md': 'x', 'dashboard.json': doc() });
    useCase(root, 'no-prompt', { 'meta.json': meta('no-prompt'), 'dashboard.json': doc() });
    useCase(root, 'mismatch', { 'meta.json': meta('other'), 'prompt.md': 'x', 'dashboard.json': doc() });
    const warnings: string[] = [];
    const loaded = loadUseCases(root, (m) => warnings.push(m));
    expect(loaded.map((u) => u.meta.id)).toEqual(['first', 'second']);
    expect(loaded[0]!.prompt).toBe('Build A');
    expect(loaded[0]!.dashboardId).toBe('scfirst');
    expect(warnings).toHaveLength(3);
  });

  it('skips a dashboard.json over the document size limit, which every copy of it would hit', () => {
    const text = 'x'.repeat(LIMITS.inlineText - 20);
    const inline = (id: string, kb: number) => ({
      id,
      name: id,
      source: {
        kind: 'inline',
        rows: Array.from({ length: Math.ceil((kb * 1024) / (text.length + 20)) }, (_, i) => ({ i, text })),
      },
    });
    const root = tempRoot();
    useCase(root, 'fits', {
      'meta.json': meta('fits', 1),
      'prompt.md': 'x',
      'dashboard.json': doc({ datasets: [inline('a', 600)] }),
    });
    useCase(root, 'too-large', {
      'meta.json': meta('too-large', 2),
      'prompt.md': 'x',
      'dashboard.json': doc({ datasets: [inline('a', 600), inline('b', 600)] }),
    });
    const warnings: string[] = [];
    const loaded = loadUseCases(root, (m) => warnings.push(m));
    expect(loaded.map((u) => u.meta.id)).toEqual(['fits']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/skipped "too-large".*more than the 1000000 a dashboard may/);
  });

  it('skips the second of two slugs that map to the same dashboard id', () => {
    const root = tempRoot();
    useCase(root, 'abcd-ef', { 'meta.json': meta('abcd-ef', 1), 'prompt.md': 'x', 'dashboard.json': doc() });
    useCase(root, 'abcdef', { 'meta.json': meta('abcdef', 2), 'prompt.md': 'y', 'dashboard.json': doc() });
    const warnings: string[] = [];
    const loaded = loadUseCases(root, (m) => warnings.push(m));
    expect(loaded.map((u) => u.meta.id)).toEqual(['abcd-ef']);
    expect(warnings.join()).toMatch(/same dashboard id/);
  });

  it('reads media with size and etag and ignores an oversized video', () => {
    const root = tempRoot();
    useCase(root, 'video', {
      'meta.json': meta('video', 1),
      'prompt.md': 'x',
      'dashboard.json': doc(),
      'video.mp4': Buffer.alloc(1000, 1),
      'poster.jpg': Buffer.alloc(100, 2),
    });
    useCase(root, 'too-big', {
      'meta.json': meta('too-big', 2),
      'prompt.md': 'x',
      'dashboard.json': doc(),
      'video.mp4': Buffer.alloc(MAX_VIDEO_BYTES + 1, 1),
    });
    const warnings: string[] = [];
    const [video, big] = loadUseCases(root, (m) => warnings.push(m));
    expect(video!.video).toMatchObject({ size: 1000 });
    expect(video!.video!.etag).toMatch(/^[a-f0-9]{16}$/);
    expect(video!.poster).toMatchObject({ size: 100 });
    expect(big!.video).toBeNull();
    expect(warnings.join()).toMatch(/video\.mp4/);
  });

  it('reads the square video like the wide one, with its own limit check', () => {
    const root = tempRoot();
    useCase(root, 'square', {
      'meta.json': meta('square', 1),
      'prompt.md': 'x',
      'dashboard.json': doc(),
      'video.mp4': Buffer.alloc(1000, 1),
      'video-square.mp4': Buffer.alloc(800, 3),
    });
    useCase(root, 'square-big', {
      'meta.json': meta('square-big', 2),
      'prompt.md': 'x',
      'dashboard.json': doc(),
      'video-square.mp4': Buffer.alloc(MAX_VIDEO_BYTES + 1, 1),
    });
    useCase(root, 'wide-only', {
      'meta.json': meta('wide-only', 3),
      'prompt.md': 'x',
      'dashboard.json': doc(),
    });
    const warnings: string[] = [];
    const [square, big, wide] = loadUseCases(root, (m) => warnings.push(m));
    expect(square!.videoSquare).toMatchObject({ size: 800 });
    expect(square!.videoSquare!.etag).not.toBe(square!.video!.etag);
    expect(big!.videoSquare).toBeNull();
    expect(wide!.videoSquare).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/video-square\.mp4/);
  });

  it('reads a declared CSV attachment and counts its rows without the header', () => {
    const root = tempRoot();
    const csvText = 'date,note\r\n2026-09-07,"Smith, J."\r\n2026-09-08,"two\nlines"\r\n';
    useCase(root, 'with-csv', {
      'meta.json': meta('with-csv', 1, { attachment: 'sales.csv' }),
      'prompt.md': 'Here is my export.',
      'dashboard.json': doc(),
      'sales.csv': csvText,
    });
    // A CSV that meta.json does not declare is not an attachment.
    useCase(root, 'undeclared', {
      'meta.json': meta('undeclared', 2),
      'prompt.md': 'x',
      'dashboard.json': doc(),
      'sales.csv': 'a\n1\n',
    });
    const warnings: string[] = [];
    const [csv, undeclared] = loadUseCases(root, (m) => warnings.push(m));
    expect(warnings).toEqual([]);
    expect(csv!.attachment).toMatchObject({ name: 'sales.csv', rows: 2, size: Buffer.byteLength(csvText) });
    expect(csv!.attachment!.etag).toMatch(/^[a-f0-9]{16}$/);
    expect(undeclared!.attachment).toBeNull();
  });

  it('keeps the use case but drops an attachment that is missing, too big, malformed or empty', () => {
    const root = tempRoot();
    const cases: Record<string, string | Buffer | null> = {
      missing: null,
      'too-big': Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0x61),
      unterminated: 'a,b\n1,"2\n',
      ragged: 'a,b\n1,2\n3\n',
      'header-only': 'a,b\n',
    };
    for (const [slug, content] of Object.entries(cases))
      useCase(root, slug, {
        'meta.json': meta(slug, 1, { attachment: 'data.csv' }),
        'prompt.md': 'x',
        'dashboard.json': doc(),
        ...(content === null ? {} : { 'data.csv': content }),
      });
    const warnings: string[] = [];
    const loaded = loadUseCases(root, (m) => warnings.push(m));
    expect(loaded).toHaveLength(5);
    for (const u of loaded) expect(u.attachment, u.meta.id).toBeNull();
    expect(warnings).toHaveLength(5);
    for (const w of warnings) expect(w).toMatch(/data\.csv/);
  });

  it('returns nothing for a missing folder', () => {
    expect(loadUseCases(join(tmpdir(), 'pb-does-not-exist-xyz'), () => {})).toEqual([]);
  });

  it('collects the exact http and feed URLs as trusted sources', () => {
    const root = tempRoot();
    const datasets = [
      {
        id: 'news',
        name: 'News',
        refreshSec: 900,
        transforms: [],
        source: { kind: 'feed', url: 'https://example.org/rss', limit: 30 },
      },
      {
        id: 'api',
        name: 'API',
        refreshSec: 60,
        transforms: [],
        source: { kind: 'http', url: 'https://api.example.org/v1?x=1' },
      },
    ];
    useCase(root, 'urls', {
      'meta.json': meta('urls'),
      'prompt.md': 'x',
      'dashboard.json': doc({ datasets }),
    });
    const urls = trustedSourceUrls(loadUseCases(root, () => {}));
    expect([...urls].sort()).toEqual(['https://api.example.org/v1?x=1', 'https://example.org/rss']);
  });

  const ds = (source: object) => [{ id: 'd', name: 'D', refreshSec: 60, transforms: [], source }];

  it('skips use cases whose data cannot work for the system owner or in copies', () => {
    const root = tempRoot();
    const cases: Record<string, object> = {
      'with-upload': { kind: 'upload', fileId: 'abc123' },
      'with-secret': { kind: 'http', url: 'https://api.example.org/x', secrets: ['sec_aaaaaaaaaaaaaaaa'] },
      inline: { kind: 'inline', rows: [{ a: 1 }] },
    };
    for (const [slug, source] of Object.entries(cases))
      useCase(root, slug, {
        'meta.json': meta(slug),
        'prompt.md': 'x',
        'dashboard.json': doc({ datasets: ds(source) }),
      });
    const warnings: string[] = [];
    const loaded = loadUseCases(root, (m) => warnings.push(m));
    expect(loaded.map((u) => u.meta.id)).toEqual(['inline']);
    expect(warnings.some((w) => /with-upload.*upload/.test(w))).toBe(true);
    expect(warnings.some((w) => /with-secret.*stored secret/.test(w))).toBe(true);
  });

  it('skips use cases whose http or feed sources use filters, but keeps filtered connector params', () => {
    const root = tempRoot();
    const region = {
      id: 'region',
      label: 'Region',
      type: 'select',
      options: [{ value: 'eu' }, { value: 'us' }],
      default: 'eu',
    };
    const cases: Record<string, object> = {
      'bound-http': { kind: 'http', url: 'https://api.example.com/x?r=$param.region' },
      'bound-feed': { kind: 'feed', url: 'https://example.org/rss?r=$param.region', limit: 30 },
      'bound-body': {
        kind: 'http',
        url: 'https://api.example.com/x',
        method: 'POST',
        body: { r: '$param.region' },
      },
      connector: { kind: 'connector', connector: 'demo.sales', params: { region: '$param.region' } },
    };
    for (const [slug, source] of Object.entries(cases))
      useCase(root, slug, {
        'meta.json': meta(slug),
        'prompt.md': 'x',
        'dashboard.json': doc({ parameters: [region], datasets: ds(source) }),
      });
    const warnings: string[] = [];
    const loaded = loadUseCases(root, (m) => warnings.push(m));
    expect(loaded.map((u) => u.meta.id)).toEqual(['connector']);
    for (const slug of ['bound-http', 'bound-feed', 'bound-body'])
      expect(
        warnings.some((w) => w.includes(slug) && w.includes('a showcase source cannot use filters')),
      ).toBe(true);
  });

  it('warns and returns nothing when the showcase path is a file', () => {
    const root = tempRoot();
    const file = join(root, 'not-a-dir');
    writeFileSync(file, 'x');
    const warnings: string[] = [];
    expect(loadUseCases(file, (m) => warnings.push(m))).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});
