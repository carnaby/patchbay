import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { MediaFile } from './load.ts';

const RANGE = /^bytes=(\d*)-(\d*)$/;

/** If-None-Match may be a list, `*`, or carry weak validators; weak comparison is what GET revalidation uses. */
function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some((t) => {
    const v = t.trim();
    return v === '*' || v.replace(/^W\//, '') === etag;
  });
}

/**
 * A file response with single byte ranges: Safari plays an MP4 only when the server answers Range requests, and
 * seeking in any browser uses them. Multi-range requests are refused (416); no player needs them.
 */
export function mediaResponse(
  file: MediaFile,
  contentType: string,
  rangeHeader: string | undefined,
  ifNoneMatch: string | undefined,
  head = false,
): Response {
  // Size and etag come from startup; media files only change with a deploy (and a restart).
  const etag = `"${file.etag}"`;
  const base = {
    'content-type': contentType,
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=86400',
    etag,
  };
  if (etagMatches(ifNoneMatch, etag)) return new Response(null, { status: 304, headers: base });
  if (!rangeHeader) {
    // HEAD must not open the file: Hono would drop the body unread and the descriptor would stay open.
    const body = head ? null : (Readable.toWeb(createReadStream(file.path)) as ReadableStream);
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
  // Cancelling the web stream (client abort) destroys the underlying file stream and closes its descriptor.
  const body = head ? null : (Readable.toWeb(createReadStream(file.path, { start, end })) as ReadableStream);
  return new Response(body, {
    status: 206,
    headers: {
      ...base,
      'content-range': `bytes ${start}-${end}/${file.size}`,
      'content-length': String(end - start + 1),
    },
  });
}
