# Proposal 0004: read-only SQL sources (Postgres first)

|                    |                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Status             | **Idea, not scheduled.** Depends on [proposal 0003](0003-source-secrets.md). See "Before it is worth doing".        |
| Area               | `packages/core/src/schema.ts` (a `sql` source), a new `apps/server/src/services/sql.ts`, `DataService`, `config.ts` |
| Effort             | Two to three days once 0003 exists, plus a Postgres service in CI                                                   |
| New infrastructure | One dependency (`pg`, pure JavaScript, no native build). A Postgres container for tests.                            |

## Why

A lot of the data people want on a dashboard is in a database, not behind an HTTP API: the orders table of a shop,
the events table of a side project. Today the only route is to write and host a small JSON endpoint in front of it.
A `sql` source would let a dashboard (and an agent) query it directly:

```ts
{ kind: 'sql', connection: 'sec_…', query: 'select day, count(*) as orders from orders group by day', params?: [...] }
```

`connection` is a 0003 secret whose value is a connection string and whose binding is `postgres://host:port/db`
instead of an HTTPS origin. Everything 0003 says about storage, owner-only resolution, never reading back, caches and
redaction applies unchanged.

## The network problem

Databases usually live on private networks, and `safe-fetch.ts` blocks private addresses for every user-supplied
destination. That block must not be weakened for HTTP, and a SQL source must not become a way around it.

The proposal: **SQL sources are off unless the operator allowlists exact destinations**,
`SQL_HOSTS=db.internal:5432,10.0.0.12:5432`. Only those host:port pairs can be connected to, the check runs on the
connection itself (as the DNS-lookup guard in `safe-fetch.ts` does), and the allowlist never applies to HTTP
sources. Public managed databases (Neon, Supabase) need an entry
too: connecting to arbitrary public host:port pairs would turn the instance into a port scanner. In practice this
makes SQL sources an operator-level feature, which matches who can reasonably vouch for a database on their network.
TLS with certificate verification is required for anything that is not a private address.

## Query safety

The database role is the real guard; everything else is defence in depth.

- **Read-only role, documented as a requirement.** On connect, run the query inside `BEGIN READ ONLY` and refuse the
  connection if `current_setting('transaction_read_only')` is not `on`. Recommend a role with `SELECT` on a few views.
- **One statement.** Use the extended query protocol (parameterised queries in `pg`), which rejects multiple
  statements; additionally reject `;` outside string literals so the error is clear.
- **Limits.** `SET LOCAL statement_timeout` (e.g. 5 s), `lock_timeout`, `idle_in_transaction_session_timeout`; read
  through a cursor and stop at `MAX_ROWS_IN` (100,000) rows and the existing 5 MB budget; at most two pooled
  connections per secret; a minimum refresh of 30 s for live SQL datasets.
- **Parameters, not string building.** Values come from `params`, never from interpolating text.
- **Who writes SQL.** Only editors of an owned dashboard, which means the owner and their agents. An agent can read
  anything the role can read, exactly like a secret-backed HTTP source on its bound host; the same rules for tokens on
  public dashboards apply.

## Pipelines vs. SQL aggregation

Aggregate in SQL. The database is better at it, and returning 100,000 raw rows to aggregate them in a worker is
wasteful. Pipelines still run after the query, unchanged, so derived columns, time buckets and window functions work
the same as for every other source, and the browser, MCP and PNG renderer still agree on the numbers. Translating
pipelines into SQL is explicitly out of scope; the reference text would advise agents to put `group by` in the query
and use pipeline steps for presentation.

## Before it is worth doing

- 0003 is implemented and actually used for private HTTP APIs.
- There is a concrete database to chart that cannot reasonably get an HTTP endpoint. A read-only JSON endpoint (or
  PostgREST in front of a view) already works with 0003, needs no allowlist, and keeps the database off the dashboard
  server's network, which is often the better design.
- The operator accepts that the dashboard server can reach the database (same host, VPN or tunnel) and maintains the
  allowlist.
- CI can run a Postgres container for the tests: read-only enforcement, timeout, row cap, multi-statement rejection,
  allowlist and DNS checks.
- Postgres only at first. MySQL or SQLite files would each need their own driver and safety review.
