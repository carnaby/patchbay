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
| Fly.io                              | Yes    | One machine + a volume mounted at `/data`. Do not scale beyond one machine. |
| Railway / Render                    | Yes    | Use the Dockerfile and attach a persistent volume at `/data`.               |
| Kubernetes                          | Yes    | `replicas: 1`, a `ReadWriteOnce` volume, `Recreate` strategy.               |
| Vercel, Netlify, Cloudflare Workers | No     | No persistent filesystem.                                                   |

## Operations checklist

- `PUBLIC_URL` must be the exact public origin (scheme + host, no trailing slash). OAuth issuer and MCP resource URIs
  are derived from it; a mismatch breaks MCP sign-in.
- Behind a reverse proxy, set `TRUST_PROXY=1` so rate limits see client IPs.
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
