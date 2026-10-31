# Changelog

All notable changes to Patchbay are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org).
Container images are published as `ghcr.io/carnaby/patchbay:<version>`; `latest` follows `main`.

## [Unreleased]

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
- **Secrets for HTTP sources** (off by default): API keys encrypted with AES-256-GCM, bound to an origin and path
  prefix, never readable again, usable but not readable by agents.
- **Presentation mode** for wall screens (full screen, hidden cursor, Screen Wake Lock) and **sound cues** when live
  data changes.
- **Showcase use cases** on the landing page, loaded from `showcase/` as read-only public dashboards with a one-click
  editable copy.
- Installable PWA whose service worker never caches live data.
- Optional, cookieless Umami page-view analytics that never sends dashboard IDs or titles.
- Deployment: one container image on GHCR, a Docker Compose setup with Caddy, and a home server or NAS setup behind a
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

[Unreleased]: https://github.com/carnaby/patchbay/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/carnaby/patchbay/releases/tag/v0.1.0
