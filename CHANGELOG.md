# Changelog

All notable changes to Patchbay are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org).
Container images are published as `ghcr.io/carnaby/patchbay:<version>`; `latest` follows `main`.

## [Unreleased]

### Changed

- **Status widget**: sections and tiles of the same level now keep the order of the dataset's rows instead of being
  sorted by name, so a `sort` transform sets the order (for example "NUC, NAS, Internet"). The worst level still
  comes first and "Other" last within its level.

### Fixed

- **Status widget**: a fold such as "+3 more ok" or "+2 off" is no longer applied when it saves no space (the tiles
  filled the row the fold would take); those tiles stay visible and the next fold is tried, in the browser and in
  snapshots alike.

## [0.2.0] - 2026-11-06

### Added

- **Status widget** (`type: "status"`): monitor checks as one tile per service, host or project in the colour of the
  worst check, in sections (for example per machine), with failing checks listed in full and ok checks summarised
  per kind. What does not fit is folded into "+N" tiles instead of scrolling, and calm sections into one
  "+N more sections" line before any problem is hidden, so it stays readable on a phone and an unattended wall
  screen, and snapshots draw the same tiles. Suggested first for monitor checks (a row or a few per check, not an
  event log), editable in the widget editor; the vocabulary of states is in `get_reference`. An optional `link`
  column (a service's web address) puts an ↗ icon on its tile that opens the site in a new tab.
- **Combining datasets**: a dataset can take its rows from another dataset of the same dashboard (`source.kind:
  "dataset"`), pipelines can `join` (look up columns) and `union` (append rows, with a column naming the origin)
  other datasets, and expressions get whole-table functions such as `col_sum(x, by?)` for shares of total and
  differences from the average. Shared sources are fetched and processed once per request, refresh or snapshot. The
  editor has an "Another dataset" source, a one-click "New dataset from this one", step editors for both new steps
  and presets for share and difference; suggestions derive from the saved dataset instead of copying it.
- **Export and import**: _Export file_ in a dashboard's Details and sharing panel downloads the dashboard and its
  uploaded data as one `.patchbay.json` file; _Import file_ on the New dashboard page (and _Import_ on My dashboards)
  turns such a file into a new dashboard on any server. Stored secrets, the owner, sharing and history are never
  exported. New endpoints: `GET /api/dashboards/:id/export`, `POST /api/dashboards/import`; uploads accept
  `format: "table"` and a `fileId` the document references.
- **Home network sources** (`ALLOW_PRIVATE_HOSTS`, `PRIVATE_HOSTS_FOR`): a self-hosted instance can let http and feed
  sources, and secrets, reach chosen hosts on its own network, also over plain `http://` and on any port;
  administrators' dashboards only by default. Off unless set: a public instance behaves as before, except that an
  `http://` address now gets a message explaining why instead of `Invalid URL`, a URL with another port says that
  only the default HTTPS port works (instead of the private-network text), and a malformed redirect answers
  `502 Invalid redirect`.
- **Showcase format**: an optional `video-square.mp4` per use case for narrow screens, and one optional CSV
  attachment declared in `meta.json`, served as a download and listed with its row count.

### Changed

- **Landing page use cases**: the video spans the section width and opens full screen (button or click), phones
  get the square cut and can swipe between tabs, tab changes slide in over the poster instead of blinking, and the
  CSV the agent got is an attachment with a table preview and a download instead of text in the prompt.

### Fixed

- A page translated by the browser (Google Translate and similar) no longer crashes with a `removeChild`
  `NotFoundError`. Widgets are marked `translate="no"`, so their live values keep updating.
- A dataset whose source was cut to the size limit, served from a cached copy, or derived from a parent over 100,000
  rows is no longer treated as failed: a filter that keeps no rows shows the widget's normal empty state with the
  warning badge, the editor preview shows the table under the warning, and sound cues ring again.
  Agents get the text as `warning` instead of `error`.

## [0.1.0] - 2026-10-31

The first public release.

### Added

- **MCP server** with 15 tools, 2 prompts and a reference resource (protocol 2026-07-28, stateless fallback for older
  clients): list connectors, preview data with a column profile and suggestions, create dashboards, apply atomic and
  validated operations with `dryRun`, upload CSV/JSON, render snapshots, list and restore versions, set visibility.
  No delete tool.
- **OAuth 2.1 authorization server** for MCP clients: PKCE (S256), dynamic client registration, Client ID Metadata
  Documents, resource-bound tokens, rotating refresh tokens with reuse detection, consent screen and revocable
  connections. Personal access tokens for scripts and clients without OAuth.
- **Server-rendered snapshots**: the same ECharts options as the browser, rendered to SVG and rasterised with resvg in
  a worker thread, so an agent can look at its own work.
- **Declarative pipelines**: filter, derive, select, drop, rename, sort, limit, aggregate, time buckets, rolling
  windows and fill, with a sandboxed expression language. Steps have stable ids so concurrent edits merge per step;
  large inputs run in worker threads.
- **Live data** over Server-Sent Events, pushed only when a result changed, and accumulation of "current value"
  sources into time series.
- **Editor** with undo/redo, a version for every save, live highlighting of an agent's changes with an Undo button,
  and replay of unsaved edits on top of a newer version.
- **Widgets**: charts, KPIs, gauges, tables, text, and new for launch: a **map** on a bundled Natural Earth base map
  (points and tracks, no tile server), **clocks** (digital or analog, any time zone) and a **search** box.
- **Sources**: 14 free public APIs (weather, air quality, crypto, exchange rates, earthquakes, the ISS, World Bank,
  Wikipedia, Hacker News, GitHub, npm), 2 synthetic demo sources, CSV/JSON uploads, inline rows, any HTTPS JSON
  endpoint, and **news feeds** (RSS, Atom, JSON Feed) shown as headlines.
- **Colours and formatting**: named colour tokens that adapt to light and dark themes, entity colours per dashboard,
  reference lines, KPI bands and table cell styling.
- **Privacy and accounts**: a `/privacy` page that states the instance's real retention and whether analytics is on,
  and self-service account deletion in Settings (dashboards with their files and versions, secrets, tokens, OAuth
  grants and sessions).
- **Data credits**: each widget and each dashboard snapshot names the sources its data comes from, as their licences
  require (Open-Meteo and World Bank are CC BY 4.0).
- **Secrets for HTTP sources** (off by default): API keys encrypted with AES-256-GCM, bound to an origin and path
  prefix, never readable again, usable but not readable by agents.
- **Presentation mode** for wall screens (full screen, hidden cursor, Screen Wake Lock) and **sound cues** when live
  data changes.
- **Showcase use cases** on the landing page, loaded from `showcase/` as read-only public dashboards with a one-click
  editable copy.
- Installable PWA whose service worker never caches live data.
- Optional, cookieless Umami page-view analytics that never sends dashboard IDs or titles.
- Deployment: one container image on GHCR for `linux/amd64` and `linux/arm64`, a Docker Compose setup with Caddy, and a home server or NAS setup behind a
  Cloudflare Tunnel with Watchtower updates.

### Security

The server was reviewed adversarially before release, and every finding has a regression test. In summary:

- SSRF guard for every user-supplied URL, enforced inside the socket's DNS lookup, with redirects re-checked and all
  IANA special-purpose ranges blocked, including IPv6 forms that embed IPv4.
- Strict CSP, same-origin checks on cookie writes, rate limits per IP (IPv6 per /64 and /56) and per user.
- Bounded resources for anonymous visitors: storage limits for anonymous dashboards and per user, upload cell limits,
  pipeline time and memory limits, snapshot and response-body budgets, slow-request protection, and a memory guard
  that sheds heavy work with 503 and Retry-After before the container runs out of memory.
- Hostile feeds are parsed in linear time off the main thread; snapshot drawing is bounded per render.
- `URL_SOURCES=signed-in` keeps strangers from making a public instance fetch arbitrary addresses.

[Unreleased]: https://github.com/carnaby/patchbay/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/carnaby/patchbay/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/carnaby/patchbay/releases/tag/v0.1.0
