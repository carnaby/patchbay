import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { MediaFile } from './load.ts';

const RANGE = /^bytes=(\d*)-(\d*)$/;

/**
 * A file response with single byte ranges: Safari plays an MP4 only when the server answers Range requests, and
 * seeking in any browser uses them. Multi-range requests are refused (416); no player needs them.
 */
export function mediaResponse(
  file: MediaFile,
  contentType: string,
  rangeHeader: string | undefined,
  ifNoneMatch: string | undefined,
): Response {
  const etag = `"${file.etag}"`;
  const base = {
    'content-type': contentType,
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=86400',
    etag,
  };
  if (ifNoneMatch === etag) return new Response(null, { status: 304, headers: base });
  if (!rangeHeader) {
    const body = Readable.toWeb(createReadStream(file.path)) as ReadableStream;
    return new Response(body, { status: 200, headers: { ...base, 'content-length': String(file.size) } });
  }
  const m = RANGE.exec(rangeHeader.trim());
  let start = -1;
  let end = -1;
  if (m && (m[1] || m[2])) {
    if (m[1] === '') {
      const suffix = Number(m[2]);
      start = Math.max(0, file.size - suffix);
      end = file.size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === '' ? file.size - 1 : Math.min(Number(m[2]), file.size - 1);
    }
  }
  if (start < 0 || start >= file.size || end < start)
    return new Response(null, { status: 416, headers: { ...base, 'content-range': `bytes */${file.size}` } });
  const body = Readable.toWeb(createReadStream(file.path, { start, end })) as ReadableStream;
  return new Response(body, {
    status: 206,
    headers: {
      ...base,
      'content-range': `bytes ${start}-${end}/${file.size}`,
      'content-length': String(end - start + 1),
    },
  });
}
