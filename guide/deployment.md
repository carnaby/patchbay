# Deployment

Patchbay is one Node process that needs a **persistent disk** (dashboard folders + SQLite). That rules out serverless
platforms and makes everything else simple.

## Recommendation

**A small VPS with Docker Compose and Caddy** (e.g. Hetzner CX22, ~4 €/month). It is the cheapest option, the data is
a plain directory you can back up with `rsync` or `restic`, and Caddy handles HTTPS automatically. The repository ships
the compose file for exactly this.

```bash
# on the server
git clone https://github.com/carnaby/patchbay.git && cd patchbay
cp .env.example .env
#   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
#   ADMIN_EMAILS=you@example.com
#   DEV_LOGIN=0
#   PRUNE_ANONYMOUS_AFTER_DAYS=60   (optional, see "Anonymous dashboards and disk space")
#   PRUNE_BLANK_ANONYMOUS_AFTER_HOURS=24
#   URL_SOURCES=signed-in           (optional; see "Limits for a small public instance")
#   SECRETS=off                     (default; see "Secrets for HTTP sources" before changing it)
PATCHBAY_DOMAIN=dash.example.com docker compose up -d
```

Google OAuth client (Google Cloud Console → APIs & Services → Credentials → OAuth client ID, type "Web application"):

- Authorized JavaScript origin: `https://dash.example.com`
- Authorized redirect URI: `https://dash.example.com/auth/google/callback`

## Alternatives

| Platform                            | Works? | Notes                                                                       |
| ----------------------------------- | ------ | --------------------------------------------------------------------------- |
| Home server or NAS                  | Yes    | Behind a Cloudflare Tunnel, no open ports. See the section below.           |
| Fly.io                              | Yes    | One machine + a volume mounted at `/data`. Do not scale beyond one machine. |
| Railway / Render                    | Yes    | Use the Dockerfile and attach a persistent volume at `/data`.               |
| Kubernetes                          | Yes    | `replicas: 1`, a `ReadWriteOnce` volume, `Recreate` strategy.               |
| Vercel, Netlify, Cloudflare Workers | No     | No persistent filesystem.                                                   |

## Home server or NAS behind a Cloudflare Tunnel

Runs Patchbay on a machine at home (a NAS, a mini PC) without opening a port on the router. A `cloudflared`
container dials out to Cloudflare; Cloudflare terminates TLS for your hostname and forwards requests through the
tunnel to `http://patchbay:8787` on the compose project's private network. Images come prebuilt from GHCR
(`ghcr.io/carnaby/patchbay`, `latest` follows `main`, every commit is also tagged with its full SHA), so the
machine needs no checkout and no build. Everything is in [`deploy/nas/`](../deploy/nas/).

You need a domain whose DNS is on Cloudflare (any plan, including Free).

### 1. Create the tunnel

In the Cloudflare dashboard, open **Zero Trust → Networks → Tunnels → Create a tunnel**, choose **Cloudflared**
and give it a name. The install command shown next contains the tunnel token (the long string after `--token`);
copy only the token. Then add a **public hostname**:

- Hostname: e.g. `dash.example.com`, or the bare domain
- Service: type `HTTP`, URL `patchbay:8787`

Cloudflare creates the DNS record itself. For the bare domain, delete an existing `A`/`AAAA`/`CNAME` record for it
first, or the route cannot be saved.

### 2. Google sign-in

Google Cloud Console → APIs & Services → Credentials → OAuth client ID, type "Web application":

- Authorized JavaScript origin: `https://dash.example.com`
- Authorized redirect URI: `https://dash.example.com/auth/google/callback`

### 3. Compose project

Copy the three files from `deploy/nas/` into a directory on the machine, then:

```bash
cp .env.example .env                  # PUID, PGID, PATCHBAY_DOMAIN, TUNNEL_TOKEN
cp patchbay.env.example patchbay.env  # GOOGLE_CLIENT_ID/SECRET, ADMIN_EMAILS, DEV_LOGIN=0, SECRETS(_KEY)
mkdir data                            # must be owned by PUID:PGID
docker compose up -d
```

- `PUID`/`PGID` are the owner of `data/`; the container runs as that user, so the bind mount is writable without
  root. On Synology the first user created is usually `1026:100` (run `id` over SSH). On Synology, create the
  project in Container Manager (Project → Create, pointing at the directory) or run the commands over SSH with
  `sudo`.
- `PUBLIC_URL` is set to `https://${PATCHBAY_DOMAIN}`. It must be the exact public origin: the OAuth issuer, the
  MCP resource, the redirect URI and the `Secure` flag on cookies are all derived from it, never from the request,
  so it does not matter that the tunnel forwards plain HTTP.
- `TRUST_PROXY=cloudflare` makes rate limits use `CF-Connecting-IP` instead of the address of the cloudflared
  container. Use it only when the app is reachable exclusively through Cloudflare (the compose file publishes no
  port); anywhere else the header can be forged.
- `SECRETS` and `SECRETS_KEY` (in `patchbay.env`) decide whether users may store credentials for HTTP sources; leave
  `SECRETS=off` unless you mean it, and read "Secrets for HTTP sources" below first. If you set a key, keep
  `patchbay.env` out of the backup of `data/` (see Backups).
- `PRUNE_ANONYMOUS_AFTER_DAYS=60`, `PRUNE_BLANK_ANONYMOUS_AFTER_HOURS=24`, `ANONYMOUS_STORAGE_LIMIT_MB=1024` and
  `USER_STORAGE_LIMIT_MB=500` are set in the compose file, because anyone can create anonymous dashboards (or sign in
  with a Google account) on a public instance; see "Anonymous dashboards and disk space".
- `PIPELINE_WORKERS=1` and a 512 MB memory limit suit a 2-core machine. 384 MB also holds thanks to the memory
  guard, but it refuses heavy work much sooner under load; see "Memory budget" for the measurements at both sizes.
- `URL_SOURCES=signed-in` is set in the compose file: the instance runs on a home connection, so only dashboards
  owned by a signed-in user can load http and feed sources, and strangers cannot make it fetch arbitrary addresses
  from your IP. See "Limits for a small public instance".
- `UMAMI_SCRIPT_URL` and `UMAMI_WEBSITE_ID` (optional, in `.env`) turn on page-view analytics; see "Analytics"
  below. The compose file passes them through with empty defaults, which means off, and they take precedence over
  `patchbay.env`.
- The tunnel token goes only to `cloudflared` (it is in `.env`, which the app container does not receive).
  `cloudflared` is pinned to an exact version; bump it by hand.
- Updates: the `patchbay` service carries the label `com.centurylinklabs.watchtower.enable=true` for a Watchtower
  instance running with `--label-enable`. Without Watchtower: `docker compose pull && docker compose up -d`. To roll
  back, set `PATCHBAY_TAG` to an earlier commit SHA.

### 4. Cloudflare settings to check

The app sets `Cache-Control` on everything it serves (`no-store` for API, auth and MCP responses, `no-cache` for
HTML, `sw.js`, the manifest and other unhashed files, `immutable` only for hashed `/assets/*`), and Cloudflare
respects it by default. Live updates are server-sent events with a heartbeat every 25 s, well inside Cloudflare's
100 s idle timeout. What remains:

- **Rocket Loader: off.** It rewrites script tags, which the app's Content Security Policy blocks; the app would not
  start.
- **No cache rule that overrides origin headers** ("Cache Everything" with an edge TTL that ignores the origin).
  Dashboards show live data.
- **No challenges for non-browser clients.** Bot Fight Mode, "Under Attack" mode or managed challenges on `/mcp`,
  `/oauth/*`, `/.well-known/*` or `/api/*` break MCP clients and API tokens, which cannot solve a challenge.
- **Always Use HTTPS: on.** Session cookies are `Secure` and are not kept over plain HTTP.

Do not put Cloudflare Access in front of the whole hostname: public dashboards and the MCP OAuth flow must be
reachable without it.

### 5. Backups

Back up the `data/` directory: dashboard folders and `patchbay.db`. The index in the database can be rebuilt from the
folders, but users, sessions and access tokens exist only in `patchbay.db`. A filesystem snapshot (e.g. Btrfs
snapshots on a NAS) is safe because SQLite in WAL mode recovers from a point-in-time copy; for a plain file copy,
stop the `patchbay` container for the duration, since a copy of a database being written can be torn. Keep `.env`
and `patchbay.env` somewhere safe as well; they hold the tunnel token and the OAuth secret. If `patchbay.env` holds a
`SECRETS_KEY`, **never back it up together with `data/`**: a backup that holds both can decrypt every stored secret.
Keep it in a password manager or a separate secret store instead.

## Secrets for HTTP sources

Users can save API keys and tokens under Settings → Secrets and let a JSON URL dataset send them, encrypted at rest
with AES-256-GCM and only ever sent to the origin and path prefix they were saved for. Nobody can read a value back
through Patchbay, but **whoever runs the server can**: it has to decrypt values to use them. The UI tells every user
so before they save one. Only turn this on if you accept that responsibility; for sensitive data, people should run
their own instance.

| `SECRETS`       | Who may store and use secrets                                                    |
| --------------- | -------------------------------------------------------------------------------- |
| `off` (default) | Nobody. Existing secrets are kept, can be listed and deleted, but are never sent |
| `admins`        | Only the users in `ADMIN_EMAILS`: a personal instance others can also sign in to |
| `users`         | Every signed-in user: a team instance, or a public one whose operator accepts it |

Any value other than `off` needs a key, and the server refuses to start without a valid one:

```bash
openssl rand -base64 32
# Windows, without OpenSSL:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Set the result as `SECRETS_KEY`. The startup log says `SECRETS=users: credentials for HTTP sources can be stored`
when the feature is on.

**Keep the key out of the data backup.** `DATA_DIR` only ever holds ciphertext; the key turns it back into readable
credentials. Store `SECRETS_KEY` in a password manager or secret store, not in the same backup set as `data/` (on the
NAS setup: do not back up `patchbay.env` together with `data/`). **Losing the key** makes every stored value
unrecoverable, by design: users enter their secrets again, nothing else breaks.

**Rotation.** Put the new key in `SECRETS_KEY` and the old one in `SECRETS_KEY_PREVIOUS` (comma-separated if
several), restart once, and check the log for `re-encrypted N secrets with the current SECRETS_KEY`. Then remove
`SECRETS_KEY_PREVIOUS` and restart again. Rows that no configured key can open are left alone and counted in the log
(`N secrets cannot be decrypted with the configured keys`); their owners see "could not be decrypted" and can replace
the value.

**If the key and a copy of the database leak together**, rotation does not help: the old copy and the old key still
decrypt. The credentials have to be revoked where they were issued. The admin page lists how many secrets each user
stored (never names or values), so you know whom to tell.

## Anonymous dashboards and disk space

Anyone can create a dashboard without an account (it is public and editable with its edit key), so on a public
instance strangers decide how much disk is used. Three settings bound it, and a fourth bounds each signed-in user:

- `ANONYMOUS_STORAGE_LIMIT_MB` (default `1024`, `0` = no limit) is the disk space all anonymous dashboards may take
  together, counted from what is really on disk (documents, versions, parsed uploads). Above it, anonymous dashboards
  cannot be created, edited or given uploads, and the API answers `507` asking people to sign in. Signed-in users
  are never affected, and claiming an anonymous dashboard moves it out of the total. The limit is on by default
  because it is the one setting that protects every instance's disk.
- `PRUNE_ANONYMOUS_AFTER_DAYS` (default `0` = keep forever) deletes anonymous dashboards nobody opened for that many
  days. Opening a dashboard counts, so it is a retention policy rather than a defence: a script can keep its own
  dashboards alive by viewing them, which is what the storage limit is for.
- `PRUNE_BLANK_ANONYMOUS_AFTER_HOURS` (default `0` = keep) deletes anonymous dashboards still blank that many hours
  after creation: never edited, no data, no widgets. Viewing does not keep them.
- `USER_STORAGE_LIMIT_MB` (default `500`, `0` = no limit) is the disk space one signed-in user's dashboards may take,
  counted the same way. Above it, the API answers `507` to that user's new dashboards, writes that grow a document,
  uploads, copies (a copy's uploads count in full, though they share the original's bytes on disk) and claims;
  edits that do not grow a document and deletes keep working. Administrators (`ADMIN_EMAILS`) are not limited.

Both pruning settings default to off: without Google sign-in every dashboard is anonymous, and a self-hosted instance
should not start deleting its owner's work after an upgrade. Turn them on for a public instance; the NAS compose file
does (60 days, 24 hours).

Per dashboard, whoever owns it: the document is at most 1 MB as JSON (inline rows are for small tables; larger data
goes into uploads), the version history at most 10 MB and 50 versions (the oldest are dropped first), and uploads at
most 20 files and 25 MB as stored on the server (a parsed CSV can take more room than the file). Copies made with
"Make a copy" share the upload files of the original (hard links) instead of copying them; on a file system without
hard links they are copied, and the server says so once in its log.

## Limits for a small public instance

Anyone can create anonymous dashboards, so everything a stranger can make the server hold or do is bounded. The
defaults suit one container with 384 MB of memory; raise them only with more memory.

| Variable                     | Default  | What it bounds                                                                                             |
| ---------------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `UPLOAD_MAX_CELLS`           | 500000   | Rows × columns of an upload to an owned dashboard, and of an HTTP response or inline rows in memory.       |
| `UPLOAD_MAX_CELLS_ANONYMOUS` | 200000   | The same for anonymous dashboards.                                                                         |
| `DATA_CACHE_MB`              | 32       | Parsed tables (uploads, inline rows, HTTP responses) kept between requests, least recently used first out. |
| `PIPELINE_WORKER_MEMORY_MB`  | 96       | Heap of each pipeline worker; a job that needs more fails instead of exhausting the container.             |
| `PIPELINE_WORKERS`           | CPUs − 1 | Pipeline worker threads (at most 4). Each one can take its whole heap: keep `1` at 384 MB.                 |
| `URL_SOURCES`                | everyone | `signed-in`: http and feed sources load only for dashboards owned by a signed-in user.                     |
| `MEMORY_LIMIT_MB`            | detected | Memory the guard measures against (see [Memory guard](#memory-guard)); `0` turns the guard off.            |
| `MEMORY_SOFT_FRACTION`       | 0.8      | Share of that memory above which new heavy work gets 503; lower on small limits (128 MB stay free).        |
| `MEMORY_HARD_FRACTION`       | 0.9      | Share above which writes, MCP calls and new live streams get 503 too; lower on small limits (64 MB free).  |

Fixed limits, for reference: uploads are parsed in the pipeline worker and refused as soon as they pass the cell limit;
an upload has at most 500 columns with names of up to 200 characters, and a JSON upload nests at most 64 levels and
holds at most three values per allowed cell, checked before it is parsed. Inline rows may use at most 200 different
column names (checked when saved). Every table built from a source has at most 500 columns, and inline rows and HTTP
responses keep at most `UPLOAD_MAX_CELLS` cells; both are checked record by record while the table is built, so a
single wide record cannot multiply it. Uploads are parsed and saved one at a time
across the server (two more may wait). A request body over 1 MB is received in full before it is processed, one at a
time (eight more may wait): it has to arrive at 32 KB/s or faster on average after its first 5 s and within 60 s, or the
request gets `408` and the connection is closed, so a slow sender never holds the turn of others; bodies that are
arriving or waiting hold at most 16 MB together, two per client. Node waits at most 20 s for a request's headers and 90
s for a whole request. Every JSON request body and HTTP source response is refused before parsing when it nests deeper
than 64 levels. HTTP sources are fetched at most three at a time, two at a time and 60 times a minute per host, and a
failing address is not asked again for 30 s; the pipeline worker's queue takes jobs round-robin per client, one client
holding at most a tenth of it. Snapshots (`snapshot.png`, `render_snapshot`) are drawn one at a time in a worker thread,
at most four requests in flight and two per client; each client may have four drawn at once and then one every two
seconds (images served from the 30 s cache do not count), beyond which the API answers `429 Too Many Requests` with
`Retry-After`. When a queue is full the API answers `503 Service Unavailable` with `Retry-After`, and live refreshes
skip a beat, instead of the process running out of memory. Live refresh never runs for uploads and inline rows (they
change only when edited) and at most every 30 s for HTTP sources. A dataset's result is sent only up to 4 MB as JSON
(larger ones show an error asking for limit, select or aggregate steps); each result is serialised once and shared by
everyone reading it, and response bodies still being read take at most 12 MB together (6 MB per client), with at most 4
MB more waiting for room up to 10 s; further large reads get a 503 at once.

### Showcase use cases

`SHOWCASE_DIR` points at the folder with the landing page use cases (see the architecture guide). It defaults to
`showcase/` in the repository, and the Docker image ships it as `/app/showcase`, so nothing needs configuring. To
change it in Docker, mount your folder over `/app/showcase` (the image bakes the repository's one in); to turn the
showcase off, point `SHOWCASE_DIR` at an empty folder. Restart after changing files: sizes and ETags are read at
startup. Their dashboards are public and read-only (an admin delete lasts until the next restart). The video and
poster routes are not behind the API rate limiter, so put a CDN or a proxy limit in front when the server is exposed
directly. With `URL_SOURCES=signed-in`, the exact URLs that appear in them still load for
anonymous copies; any other http or feed URL needs a signed-in owner as before.

### Memory budget

One process holds everything: the main thread, the worker threads and their native memory count against the same
container limit. The heavy jobs take turns (`util/heavy.ts`): drawing a snapshot, an upload from parse to disk,
loading a stored upload over 1 MB, a pipeline over 100,000 cells and parsing a feed over 512 KB run one at a time
across the process, so at most one worker is at its peak while the others sit at their resting size.

| Part                      | Resting                                    | Peak                                                                      |
| ------------------------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| Node, code, thread stacks | About 30 MB                                | The same; glibc keeps two malloc arenas (`MALLOC_ARENA_MAX=2`)            |
| Main thread               | 20 MB heap, 10 MB buffers                  | Caches below plus one upload in flight: 100–120 MB heap, 30–60 MB buffers |
| Pipeline worker           | 25 MB                                      | `PIPELINE_WORKER_MEMORY_MB` + 8 MB young generation: 104 MB               |
| Snapshot worker           | 50 MB (ECharts, the world map), while used | 96 + 8 MB heap, plus resvg's pixmap (at most 4 megapixels)                |
| Feed worker               | 30 MB, while used                          | 48 + 8 MB                                                                 |

The main thread's share is bounded by its caches and gates rather than by a heap flag: parsed tables (`DATA_CACHE_MB`,
32), results reused for a few seconds (8 MB), serialised results (8 MB), snapshot images (8 MB), response bodies
(12 MB, 4 MB waiting), large request bodies arriving or waiting for their turn (16 MB) and one large request body and
one upload processed at a time. V8 lets that heap grow to about twice what is live before it collects, which is where
most of the gap between resting and peak comes from. The snapshot and feed workers stop after a minute without work;
an idle server with its pipeline worker takes about 85 MB.

Measured with the production flags (`--memory 384m --cpus 2 --read-only`, `PIPELINE_WORKERS=1`,
`URL_SOURCES=signed-in`), as the container's highest anonymous memory over 60–90 s of each load: a snapshot storm (25
clients cycling the widgets of a 60-chart dashboard, plus full renders after every edit) 275 MB; 500,000-cell uploads
three at a time with 5 MB JSON uploads, deeply nested JSON and over-limit feeds 290 MB; 160 concurrent reads of 20
different 2–4 MB results 267 MB. All of them at once need more than 384 MB: without the memory guard below, the
container is killed after about half a minute, at about 350 MB, and with `--memory 512m` the same run peaks at 415 MB
(447 MB with the kernel's share). With the guard, that run (90 s, with the reads seeded beforehand and three
viewers opening the template dashboards every second and keeping live streams open) holds at 384 MB. In four runs it
peaked at 297–346 MB (303–353 MB with the kernel's share), the attackers got 503 for nearly all their heavy requests,
and every viewer request and health check answered: viewers' p99 0.5–2.7 s for a whole dashboard, `/healthz` p99
0.1–0.4 s and at most 0.9–4.4 s. Before the guard admitted a lone job on a resting server and gave memory back while
idle, the same run took viewers to a p99 of 4–11 s and `/healthz` to 3.6–9.75 s. The guard was back to normal 5–12 s
after the attack, and a visitor creating a dashboard, drawing its snapshot and uploading two files 30 s, 90 s, 4 and
6 minutes later was served every time. At 512 MB the run peaks at 406 MB (412 MB with the kernel's share), viewers'
p99 is 2.3 s, and the guard is back to normal 20 s after. A quiet instance (every template opened and drawn, a
160,000-cell upload) stays under 220 MB and never reaches the guard. Each extra pipeline worker adds 104 MB; keep one
at either size.

The Docker health check (`HEALTHCHECK` in the image) allows 10 s: under such an attack `/healthz` answered in up to
4.4 s, and the check first starts a node process inside the busy container. With 5 s a container that was coping
could be marked unhealthy, which misleads anything that restarts unhealthy containers; three answers in a row slower
than 10 s are worth a restart.

A worker that hits its heap limit fails its job, and its replacement starts only after it has exited, so a worker slot
never holds two heaps. The worker limits hold only while Node runs without `--max-old-space-size` (or
`--max-old-space-size-percentage`): V8 applies that flag to every thread, overriding each worker's own limit, and the
server warns when a worker starts with a different limit than it asked for. The main thread's heap therefore keeps
V8's default limit; its use is bounded by the limits above rather than by a flag.

#### Memory guard

The limits above bound each kind of work; the OOM killer sees their sum. So the server also watches the container's
real memory use and stops new work from adding to it while it is high (`util/memory-pressure.ts`). It reads the
cgroup's charge without the page cache the kernel can drop (cgroup v2: `memory.current` minus `active_file` and
`inactive_file`; cgroup v1 likewise), at most every 250 ms (about 12 µs per read) and every 10 s on its own, and
compares it with the container's limit:

- **Soft** (`MEMORY_SOFT_FRACTION`): new heavy work gets `503` with `Retry-After: 5`: snapshots that are not cached,
  uploads and other bodies over 1 MB, the heavy jobs above, pipelines over 20,000 cells and results over 512 KB that
  are not serialised already. One exception: on a resting server, where no heavy work has run for 30 s and 112 MB
  are still free (up to 272 MB at 384 MB), one job may start; the 30 s start again when it ends. A burst gets at
  most one job every 30 s through it; a visitor after the burst gets served.
- **Hard** (`MEMORY_HARD_FRACTION`): no new heavy work, writes, MCP calls or live streams, with `Retry-After: 10`.
- `/healthz`, static files, dashboard documents, small results and results already in memory keep answering at
  either level, and work already running always finishes. Live refreshes skip a beat, as when a queue is full.

The exception exists because memory does not always come back once the load is gone: glibc and V8 keep some of what
a burst used, and the resting level after an attack was measured between 150 and 270 MB (85 MB on a fresh start).
Refusing all heavy work above 256 MB then refused every visitor's snapshot and upload with nobody attacking, until a
restart. It is not wider because one job is not small: a full render of a 60-chart dashboard took a server resting at
270 MB to 365 MB. Its cost is a pause between heavy jobs while use stays above soft: after a chain of attack uploads,
a visitor's own 1 MB upload took the server into soft for 12 s, and the upload it sent right after got a 503 with
`Retry-After: 5`.

A level is left once use is 5 % of the limit below its threshold, so it does not flap; soft is also left below its
threshold itself once no heavy work has run for 30 s, since a reading with nothing running is the resting level.
While above soft, the main thread collects its garbage and idle workers collect or stop (the snapshot and feed
workers start again on demand), at most every 5 s. Once no heavy work has run for 30 s, at most once a minute, the
server also empties its caches of parsed tables and results, replaces idle pipeline workers by fresh ones and
compacts its heap; after the storm above that took use from 265–294 MB to 155–206 MB within a second. Each change of
level is logged once with its numbers (`[memory] soft pressure: 262 MB of 384 MB
(68%), refusing new heavy work`), and so is each such reclaim; the admin page shows the current use and
refreshes it every 10 s.

The default thresholds keep a fixed amount free rather than a share, because a heavy job takes the same memory in any
container: 0.8 and 0.9 of the limit, but at least 128 MB and 64 MB below it. At 384 MB that is 256 MB and 320 MB; at
512 MB, 384 MB and 448 MB; from 640 MB up, 80 % and 90 %. Without a cgroup limit (a development machine, Windows)
the guard is off unless `MEMORY_LIMIT_MB` is set, and then compares the process's own resident memory with it.
`MEMORY_LIMIT_MB` also overrides a detected limit, and `0` turns the guard off.

## Analytics (optional)

Patchbay has no analytics by default and loads no tracker. To count page views with a
[Umami](https://umami.is) instance you run, set both variables and restart:

```bash
UMAMI_SCRIPT_URL=https://umami.example.com/script.js   # https only
UMAMI_WEBSITE_ID=<the website ID Umami shows, a UUID>
```

Setting only one of them is a startup error. With both set, the server adds the tracker to every page and allows its
origin in the Content Security Policy (`script-src` and `connect-src`, nothing else). The tracker is configured so that:

- it only reports on the host of `PUBLIC_URL` (`data-domains`), and nothing when the browser sends Do Not Track;
- query strings and fragments are never sent (OAuth consent pages carry codes and state in them);
- dashboard links are reported as `/d/:id` and dashboard titles as "Dashboard": a link to a public dashboard works
  like a key, so neither leaves the browser. This happens in Umami's `data-before-send` hook
  (`apps/web/public/umami-hook.js`). Older trackers without that hook would send the real path: check that your
  `script.js` contains `before-send` before turning analytics on.

Umami sets no cookies; whether you need a notice or consent where you operate is yours to check. The script is
loaded with `defer` and nothing depends on it: an ad blocker or an unreachable Umami server changes nothing
for users, including unattended presentation screens. To keep your own visits out of the numbers, run
`localStorage.setItem('umami.disabled', '1')` once in the browser console on your instance.

## Operations checklist

- `PUBLIC_URL` must be the exact public origin (scheme + host, no trailing slash). OAuth issuer and MCP resource URIs
  are derived from it; a mismatch breaks MCP sign-in. Link previews (`og:image`, `og:url`, canonical) use it too.
- Behind a reverse proxy, set `TRUST_PROXY=1` so rate limits see client IPs (`TRUST_PROXY=cloudflare` behind a
  Cloudflare Tunnel, see below).
- Back up `DATA_DIR`. The SQLite index can be rebuilt from the folders, but users, tokens and secrets live only in
  SQLite. Back up `SECRETS_KEY` separately, never in the same place.
- `GET /healthz` is a liveness probe; the image defines a Docker `HEALTHCHECK`.
- Logs go to stdout. The process handles `SIGTERM` gracefully.
- Limits worth knowing: uploads ≤ 5 MB and ≤ `UPLOAD_MAX_CELLS` cells per file and ≤ 25 MB per dashboard as stored,
  documents ≤ 1 MB, ≤ 10,000 rows and ≤ 4 MB sent to the browser per dataset, ≤ 60 widgets and 30 datasets per dashboard, last
  50 versions (≤ 10 MB) kept.

## Scaling notes

A single process comfortably serves many concurrent viewers: identical upstream requests are cached and shared, and
live refresh loops exist only for dashboards someone is watching. If you ever need more than one instance, the path is:
move the index and identities to Postgres, dashboards to object storage, and the live hub's fan-out to Redis pub/sub.
The code keeps those concerns behind `DashboardIndex`, `FolderStore` and `LiveHub` for that reason.
