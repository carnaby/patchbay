# Proposal 0001: incremental live updates (SSE deltas)

|                    |                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| Status             | **Proposed, not implemented.** Pick it up when live dashboards become a measurable bandwidth or CPU cost. |
| Area               | `apps/server/src/live/hub.ts`, `apps/web/src/state/sync.ts`, `packages/core/src/types.ts`                 |
| Effort             | About half a day including tests                                                                          |
| New infrastructure | None                                                                                                      |

## Problem

When a live dataset refreshes and its content hash changes, the hub sends the **whole processed table** to every
subscriber:

```ts
{ type: 'data', result: DatasetResult }   // result.table holds every row, every time
```

For the most common live shape, a rolling window (the last N points of a signal, an `accumulate` buffer, a price
history), almost all rows are identical between two ticks: one row falls off the front, one is appended at the end.

Example: the "Live signal" template refreshes every second with 2 series × 120 points. Each push is ~240 rows
(≈ 12 KB of JSON) to deliver one new point per series. With 50 viewers that is ~600 KB/s of redundant traffic, plus
JSON serialisation per subscriber on the server and a full re-parse and chart diff per tick in every browser.

It does not matter today. It will matter with many viewers, short intervals or larger windows.

## What it would solve

- Live traffic proportional to _what changed_ instead of the window size (typically 50–100× less for rolling windows).
- Less server CPU: serialise each event once per tick, not once per subscriber.
- Less work in the browser: append to the cached rows instead of replacing and re-diffing the whole table.
- A sequence number per dataset makes missed or reordered updates detectable (today a lost event is silently healed
  only by the next full push).

## Non-goals

- Changing how data is computed. Pipelines still produce full tables; the delta is computed afterwards.
- Deltas for arbitrary edits in the middle of a table. Anything that is not "drop from the front, append at the end"
  falls back to a full snapshot. Aggregations that change every row are full snapshots by nature.

## Design

### Wire format

Extend `LiveEvent` in `packages/core/src/types.ts`:

```ts
| { type: 'data'; result: DatasetResult; seq: number }                 // full snapshot (existing shape + seq)
| { type: 'dataDelta'; datasetId: string; seq: number; baseSeq: number;
    drop: number;                 // rows removed from the front
    append: Row[];                // rows added at the end
    fetchedAt: string; hash: string }                                  // hash of the resulting full table
```

`seq` increases by one per dataset per pushed change. `baseSeq` is the snapshot the delta applies to.

### Server (`LiveHub`)

Per room and dataset, keep the last pushed table and its `seq` (the hub already keeps `lastHash`).

On each tick with a changed hash:

1. Compare the new rows with the previous ones. Find the smallest `drop` such that `prev.slice(drop)` is a prefix of
   `next` (compare by a per-row hash; checking `drop` from 0 upward is enough since windows move forward).
2. If found, the columns are unchanged and `append.length` is less than half of `next.length`, send `dataDelta`.
   Otherwise send a full `data` snapshot.
3. Serialise the event once and write the same string to every subscriber.

Bound the extra memory: keep previous tables only for rooms with subscribers (rooms already disappear when the last
viewer leaves), and only for tables up to `MAX_ROWS_OUT`.

### Client (`useLiveEvents`)

Keep `seq` next to each dataset in the query cache.

- `data`: replace as today and store `seq`.
- `dataDelta` with `baseSeq === cached.seq`: apply `rows = rows.slice(drop).concat(append)`, set `seq`, and verify
  `hash`. On a hash mismatch, refetch the dataset.
- `dataDelta` with any other `baseSeq` (missed an event, reconnected): ignore it and refetch the dataset over REST,
  which returns a full snapshot with the current `seq`.

`EventSource` reconnects automatically; the `hello` event on reconnect should include the current `seq` per dataset
so the client can decide whether to refetch.

### Hashing

`hashTable` currently hashes the whole JSON string. For deltas, hash rows individually (FNV-1a over a stable row
serialisation) so the prefix comparison is O(rows) without re-serialising.

## Testing

- Core: a pure `diffRows(prev, next)` returning `{ drop, append } | null`, unit-tested for: pure append, rolling window,
  no overlap, column change, identical tables, `drop` beyond length.
- Server: a hub test with a fake `DataService` that produces a rolling window; assert the first push is `data`, the
  following ones `dataDelta`, and that a column change or a large change falls back to `data`.
- Client: apply a sequence of events including a gap (`baseSeq` mismatch) and assert a refetch happens and the final
  rows equal the server's table.
- Measure: bytes sent per minute for the "Live signal" template before and after (log in a test or a script).

## Risks

- **Divergence bugs** (client and server disagree on the rows). Mitigated by sending the resulting `hash` with every
  delta and refetching on mismatch: the worst case is one extra full fetch.
- **Complexity in `sync.ts`**. Keep the delta logic in one pure function shared from core so both sides use the same
  code to apply and verify.

## Alternatives considered

- **Compress SSE responses (gzip/brotli).** Cheap and complementary: rolling windows compress very well. It does not
  reduce server serialisation or client re-parsing, and per-event flushing limits compression gains. Worth doing
  first if a quick win is needed (`hono/compress` with care for streaming).
- **WebSockets.** Bidirectional and binary, but traffic here is one-directional and SSE already handles reconnection.
  It would not change the payload problem.
- **Send only the latest point and let the client maintain the window.** Simpler, but breaks for sources that return
  windows (`demo.signal`, histories) and for pipelines whose output is not append-only. The generic prefix-diff covers
  both.
