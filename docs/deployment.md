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
#   PRUNE_ANONYMOUS_AFTER_DAYS=60   (optional)
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
cp patchbay.env.example patchbay.env  # GOOGLE_CLIENT_ID/SECRET, ADMIN_EMAILS, DEV_LOGIN=0
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
- `PIPELINE_WORKERS=1` and a 384 MB memory limit suit a 2-core machine. Measured: about 100–120 MB idle, about
  250 MB peak while a 5 MB upload is processed.
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
and `patchbay.env` somewhere safe as well; they hold the tunnel token and the OAuth secret.

## Operations checklist

- `PUBLIC_URL` must be the exact public origin (scheme + host, no trailing slash). OAuth issuer and MCP resource URIs
  are derived from it; a mismatch breaks MCP sign-in.
- Behind a reverse proxy, set `TRUST_PROXY=1` so rate limits see client IPs (`TRUST_PROXY=cloudflare` behind a
  Cloudflare Tunnel, see below).
- Back up `DATA_DIR`. The SQLite index can be rebuilt from the folders, but users and tokens live only in SQLite.
- `GET /healthz` is a liveness probe; the image defines a Docker `HEALTHCHECK`.
- Logs go to stdout. The process handles `SIGTERM` gracefully.
- Limits worth knowing: uploads ≤ 5 MB, ≤ 10,000 rows sent to the browser per dataset, ≤ 60 widgets and 30 datasets per
  dashboard, last 50 versions kept.

## Scaling notes

A single process comfortably serves many concurrent viewers: identical upstream requests are cached and shared, and
live refresh loops exist only for dashboards someone is watching. If you ever need more than one instance, the path is:
move the index and identities to Postgres, dashboards to object storage, and the live hub's fan-out to Redis pub/sub.
The code keeps those concerns behind `DashboardIndex`, `FolderStore` and `LiveHub` for that reason.
