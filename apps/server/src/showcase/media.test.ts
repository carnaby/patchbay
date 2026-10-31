import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const opened = vi.hoisted(() => ({ count: 0 }));
vi.mock('node:fs', async (orig) => {
  const fs = await orig<typeof import('node:fs')>();
  return {
    ...fs,
    createReadStream: ((...a: Parameters<typeof fs.createReadStream>) => {
      opened.count++;
      return fs.createReadStream(...a);
    }) as typeof fs.createReadStream,
  };
});

import { mediaResponse } from './media.ts';

const path = join(mkdtempSync(join(tmpdir(), 'pb-media-')), 'v.mp4');
writeFileSync(path, Buffer.from('0123456789'));
const file = { path, size: 10, etag: 'abcdef0123456789' };

describe('mediaResponse', () => {
  it('sends the whole file with caching headers', async () => {
    const r = mediaResponse(file, 'video/mp4', undefined, undefined);
    expect(r.status).toBe(200);
    expect(r.headers.get('accept-ranges')).toBe('bytes');
    expect(r.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(r.headers.get('etag')).toBe('"abcdef0123456789"');
    expect(await r.text()).toBe('0123456789');
  });

  it('answers ranges with 206', async () => {
    const r = mediaResponse(file, 'video/mp4', 'bytes=2-5', undefined);
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(r.headers.get('content-length')).toBe('4');
    expect(await r.text()).toBe('2345');
    expect(await mediaResponse(file, 'video/mp4', 'bytes=7-', undefined).text()).toBe('789');
    expect(await mediaResponse(file, 'video/mp4', 'bytes=-3', undefined).text()).toBe('789');
  });

  it('answers unsatisfiable or malformed ranges with 416', () => {
    for (const range of ['bytes=999999999-', 'bytes=5-2', 'bytes=abc', 'bytes=0-1,4-5']) {
      const r = mediaResponse(file, 'video/mp4', range, undefined);
      expect(r.status).toBe(416);
      expect(r.headers.get('content-range')).toBe('bytes */10');
    }
  });

  it('answers 304 when the etag matches', () => {
    expect(mediaResponse(file, 'video/mp4', undefined, '"abcdef0123456789"').status).toBe(304);
  });

  it('accepts weak validators, lists and *', () => {
    for (const h of ['W/"abcdef0123456789"', '"x", "abcdef0123456789"', '*'])
      expect(mediaResponse(file, 'video/mp4', undefined, h).status).toBe(304);
    expect(mediaResponse(file, 'video/mp4', undefined, '"other"').status).toBe(200);
  });

  it('answers HEAD with the same headers, no body and no opened file', () => {
    const before = opened.count;
    const full = mediaResponse(file, 'video/mp4', undefined, undefined, true);
    const part = mediaResponse(file, 'video/mp4', 'bytes=2-5', undefined, true);
    expect(full.status).toBe(200);
    expect(full.headers.get('content-length')).toBe('10');
    expect(full.body).toBeNull();
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(part.body).toBeNull();
    expect(opened.count).toBe(before);
  });

  it('closes the file when the client aborts', async () => {
    const r = mediaResponse(file, 'video/mp4', undefined, undefined);
    await r.body!.cancel();
    expect(r.body!.locked).toBe(false);
  });
});
