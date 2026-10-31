/**
 * Data results on their way to clients: the REST data and preview routes and the live stream.
 *
 * A result is serialised once per table and rows format and the bytes are shared: concurrent readers of one dataset,
 * and every viewer a live push goes to, send the same Buffer instead of building their own string. Nothing larger
 * than MAX_RESULT_BYTES is ever built (the size is estimated first and counted exactly while serialising), and the
 * bodies held by responses still being read stay within a byte budget, so a burst of large reads waits briefly and
 * then answers 503 instead of exhausting the heap.
 */
import {
  type DatasetResult,
  type DataTable,
  type LiveEvent,
  type RowsFormat,
  rowValues,
  wireSize,
} from '@patchbay/core';
import { ByteBudget, type ByteBudgetOptions } from '../util/byte-budget.ts';
import { ByteLru } from '../util/lru.ts';
import { currentClient } from '../util/request-context.ts';

/**
 * Largest data result sent to a client, as JSON. 10,000 rows (the most a dataset sends) of 20 numeric columns are
 * 1.4 to 2.3 MB in the arrays format the web app reads, so realistic dashboards stay well below it; and it is small
 * next to a 256 MB heap even with several different results on their way out at once (see RESPONSE_BUDGET).
 */
export const MAX_RESULT_BYTES = 4 * 1024 * 1024;

/** Serialised tables kept for the next reader; a result is reused for a few seconds (DataService). */
const SERIALISED_CACHE_BYTES = 8 * 1024 * 1024;

/**
 * Response bodies held while clients read them (four results at the cap, or many smaller ones), and the bodies
 * waiting for room, which are built already and keep their tables referenced. Part of the memory budget in
 * guide/deployment.md: a few large reads wait, the rest of a burst gets 503 at once.
 */
export const RESPONSE_BUDGET: ByteBudgetOptions = {
  maxBytes: 12 * 1024 * 1024,
  maxBytesPerClient: 6 * 1024 * 1024,
  maxQueue: 8,
  maxQueuedPerClient: 4,
  maxQueuedBytes: 4 * 1024 * 1024,
  maxWaitMs: 10_000,
  retryAfterSec: 5,
};

/** Bodies below this skip the budget: they are what the rate limit already bounds. */
const SMALL_BODY_BYTES = 32 * 1024;

/** A response not read to its end after this long gives its share back, and its connection is ended. */
const MAX_HOLD_MS = 60_000;

/** Bytes per chunk handed to the socket, so a slow reader holds the budget until it has really read the body. */
const CHUNK_BYTES = 64 * 1024;

export function rowsFormat(value: string | undefined): RowsFormat {
  return value === 'arrays' ? 'arrays' : 'objects';
}

/** Rounded up, so a result just over the cap never reads "about 4 MB, more than the 4 MB". */
const mb = (bytes: number) =>
  `${(Math.ceil((bytes / 1024 / 1024) * 10) / 10).toLocaleString('en', { maximumFractionDigits: 1 })} MB`;

/** What a widget shows (and an agent reads) instead of a result too large to send. */
export function tooLargeMessage(bytes: number): string {
  return (
    `The result is too large to send: about ${mb(bytes)} as JSON, more than the ${mb(MAX_RESULT_BYTES)} a dataset ` +
    'may send. Make it smaller with steps: filter or limit rows, aggregate, select only the columns the widgets use, ' +
    'or shorten long text with substr().'
  );
}

/** The result as an error, keeping its columns when they are small enough, so an editor can still pick from them. */
export function tooLargeResult<T extends Pick<DatasetResult, 'table' | 'hash' | 'error'>>(
  result: T,
  bytes: number,
): T {
  const columns = wireSize({ columns: result.table.columns, rows: [] }, 'objects') <= MAX_RESULT_BYTES / 16;
  return {
    ...result,
    table: { columns: columns ? result.table.columns : [], rows: [] },
    hash: `error:too-large:${Math.round(bytes / 1024)}`,
    error: tooLargeMessage(bytes),
  };
}

/** A body ready to stream, and how to give its bytes back once it has been read (or abandoned). */
export interface Body {
  chunks: Uint8Array[];
  bytes: number;
  release: () => void;
}

export class ResultWire {
  private readonly serialised = new ByteLru<Buffer | number>(SERIALISED_CACHE_BYTES);
  private readonly tableIds = new WeakMap<DataTable, number>();
  private nextTableId = 1;
  private readonly frames = new WeakMap<LiveEvent, Map<RowsFormat, Uint8Array>>();
  readonly budget: ByteBudget;
  private readonly maxBytes: number;
  private previews = 0;

  constructor(options: { budget?: ByteBudget; maxBytes?: number } = {}) {
    this.budget = options.budget ?? new ByteBudget(RESPONSE_BUDGET);
    this.maxBytes = options.maxBytes ?? MAX_RESULT_BYTES;
  }

  private keyOf(table: DataTable, format: RowsFormat): string {
    let id = this.tableIds.get(table);
    if (id === undefined) {
      id = this.nextTableId++;
      this.tableIds.set(table, id);
    }
    return `${id}|${format}`;
  }

  /**
   * The table as JSON, or its size when that is over the cap. Keyed by the table object, which DataService shares
   * between the concurrent and recent readers of one result: equal content in another dashboard is another key, so
   * one dashboard's bytes can never be sent for another's.
   */
  private tableJson(table: DataTable, format: RowsFormat): { key: string; json: Buffer | number } {
    const key = this.keyOf(table, format);
    const hit = this.serialised.get(key);
    if (hit !== undefined) return { key, json: hit };
    const json = serialiseTable(table, format, this.maxBytes);
    this.serialised.set(key, json, typeof json === 'number' ? 64 : json.byteLength);
    return { key, json };
  }

  /** The result as JSON with its table spliced in, or null when the table is over the cap. */
  private resultChunks(result: DatasetResult, format: RowsFormat) {
    const { json, key } = this.tableJson(result.table, format);
    if (typeof json === 'number') return { key, chunks: null, size: json };
    const { table: _table, ...rest } = result;
    const head = Buffer.from(`${JSON.stringify(rest).slice(0, -1)},"table":`);
    return { key, chunks: [head, json, Buffer.from('}')], size: json.byteLength };
  }

  /**
   * The body of a data response: the result, or a small error result when it is too large. `wrap` puts it inside an
   * object (the preview route adds a profile). Waits for room in the response budget; throws a BusyError.
   */
  async dataBody(
    result: DatasetResult,
    format: RowsFormat,
    wrap?: { before: string; after: string },
  ): Promise<Body> {
    let { key, chunks, size } = this.resultChunks(result, format);
    if (!chunks) {
      chunks = [Buffer.from(JSON.stringify(tooLargeResult(result, size)))];
      key = '';
    }
    if (wrap) chunks = [Buffer.from(wrap.before), ...chunks, Buffer.from(wrap.after)];
    const bytes = chunks.reduce((sum, c) => sum + c.byteLength, 0);
    if (!key || bytes < SMALL_BODY_BYTES) return { chunks, bytes, release: () => {} };
    // The wrapped body of a preview is its own; a plain result body is shared with every reader of the same table.
    const release = await this.budget.acquire(
      currentClient(),
      wrap ? `${key}|preview${++this.previews}` : key,
      bytes,
    );
    return { chunks, bytes, release };
  }

  /**
   * One server-sent event as bytes, built once per event and format and shared by every subscriber it goes to: the
   * hub hands all of them the same event object.
   */
  frame(event: LiveEvent, format: RowsFormat): Uint8Array {
    let byFormat = this.frames.get(event);
    const hit = byFormat?.get(format);
    if (hit) return hit;
    let bytes: Uint8Array;
    if (event.type === 'data') {
      const { chunks, size } = this.resultChunks(event.result, format);
      const parts = chunks ?? [Buffer.from(JSON.stringify(tooLargeResult(event.result, size)))];
      bytes = Buffer.concat([
        Buffer.from('event: message\ndata: {"type":"data","result":'),
        ...parts,
        Buffer.from('}\n\n'),
      ]);
    } else {
      bytes = Buffer.from(`event: message\ndata: ${JSON.stringify(event)}\n\n`);
    }
    if (!byFormat) {
      byFormat = new Map();
      this.frames.set(event, byFormat);
    }
    byFormat.set(format, bytes);
    return bytes;
  }
}

/**
 * Serialises row by row, counting bytes as it goes, and stops at the cap: the estimate before it ignores escapes and
 * multi-byte characters, which can make the real text several times longer.
 */
function serialiseTable(table: DataTable, format: RowsFormat, maxBytes: number): Buffer | number {
  const estimate = wireSize(table, format);
  if (estimate > maxBytes) return estimate;
  const head = `{"columns":${JSON.stringify(table.columns)},"rows":[`;
  let bytes = Buffer.byteLength(head) + 2;
  const rows: string[] = [];
  for (const row of table.rows) {
    const text = JSON.stringify(format === 'arrays' ? rowValues(table.columns, row) : row);
    bytes += Buffer.byteLength(text) + 1;
    if (bytes > maxBytes) return Math.max(bytes, estimate);
    rows.push(text);
  }
  return Buffer.from(`${head}${rows.join(',')}]}`);
}

/**
 * A response body that hands out its chunks only as the socket asks for them and gives its budget back when the last
 * one is taken, when the client goes away, or after MAX_HOLD_MS (then the connection is ended).
 */
export function streamBody(body: Body): ReadableStream<Uint8Array> {
  let chunk = 0;
  let offset = 0;
  let timer: NodeJS.Timeout | undefined;
  const done = () => {
    if (timer) clearTimeout(timer);
    body.release();
  };
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        timer = setTimeout(() => {
          body.release();
          controller.error(new Error('The client read the response too slowly'));
        }, MAX_HOLD_MS);
        timer.unref();
      },
      pull(controller) {
        const current = body.chunks[chunk];
        if (!current) {
          controller.close();
          done();
          return;
        }
        const end = Math.min(current.byteLength, offset + CHUNK_BYTES);
        // A view, not a copy: every reader of a shared body reads the same memory.
        controller.enqueue(current.subarray(offset, end));
        offset = end;
        if (offset >= current.byteLength) {
          chunk++;
          offset = 0;
        }
      },
      cancel() {
        done();
      },
    },
    { highWaterMark: 0 },
  );
}
