# Changelog

All notable changes to Patchbay are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org).
Container images are published as `ghcr.io/carnaby/patchbay:<version>`; `latest` follows `main`.

## [Unreleased]

### Fixed

- A wall screen whose dashboard was made private or removed no longer asks for it again every minute, from the next
  midnight on for good, or every 10 seconds after an earlier source error. It now asks every 15 minutes, so a dashboard
  made public again shows up without a reload. A widget with a regular refresh interval keeps its interval.
- In presentation mode on a touch screen, the Maximise button of a widget in the top row can be tapped again while the
  top bar shows.
- A track map's newest positions and a map shown as a table now set the map's filter when clicked, and newest positions
  dim with the rest.
- A widget that times out while another chart of the same image is still loading no longer names that other chart's
  source; it names its own, or asks to shorten the chain.
- "Showing cached data" now appears and clears on a live screen even when the rows stay the same.
- The filter editor keeps the default on its option while that option's text is edited, keeps a label equal to its
  value, and no longer offers to insert a filter after a second "=" in a query value.
- "Insert filter" into a request body waits for a place in the body instead of adding the value after the closing
  brace.
- The editor refuses, in place, a change to a dataset or a filter that the server would refuse because a secret was
  deleted, instead of failing on autosave.
- The dataset preview asks again when a dataset it reads was saved meanwhile.
- Disabled Remove filter, Add filter and Delete dataset buttons say why when they are tapped or focused, also on touch
  screens and to screen readers.
- In images, the ↗ of a status entity no longer touches its name; in the page it is easier to tap.
- Agents get clearer answers:
  - a filter id over 40 characters names the limit;
  - filter values in a preview without a dashboard are reported as ignored;
  - a click value over 100 characters is named as such;
  - two renames onto one column name both columns;
  - a refused option names its value;
  - two suggestions no longer share a dataset id.
- A read-only access token is no longer told that a dashboard may reach the server's private hosts.

### Changed

- At the end of a relative period's day, widgets ask for the new day over a few seconds instead of all in the same
  second.
- `updateParameter` with an empty `set` is refused instead of saving a version that changes nothing.
- A widget that does not refresh on its own now asks again every 15 minutes after the server refused its request (a
  dashboard made private or removed, a filter value no longer offered). Before, it never asked again until a reload.

## [0.3.3] - 2026-11-11

### Fixed

- A dashboard on a relative period (yesterday, last 7 days, last month, ...) now asks again when the server says its
  window ends, so a wall screen whose clock is off no longer keeps yesterday's data until the next day.
- A sound no longer rings, or is skipped, around midnight because the screen's clock differs from the server's: a result
  that arrives just after midnight with the old day's rows is no longer taken as the baseline for the new day.
- A widget whose error only an edit or a setting can fix (a deleted secret, an address the server refuses, a missing
  upload, an invalid definition) is asked again every 15 minutes instead of every minute, so a fixed secret or setting
  shows up on an open wall screen without a reload. This applies to a widget that does not refresh on its own; a
  dataset with a regular refresh interval keeps its interval. Other errors are still retried every minute.
- A dataset whose own source, or a source it reads, is still loading at the 20 second limit now says that it is still
  loading and is retried after 10 seconds, instead of showing an error asking to shorten the chain.
- In presentation mode, a status panel or a maximised widget opened by a tap closes after 30 seconds without input, so
  a stray tap cannot cover a wall screen for good. Overlays opened before presentation stay. Screen readers announce
  the status panel by the entity's name alone, without "(opens in a new tab)".
- Line, area and scatter charts on categories keep their first and last x labels whole, in the page and in images.
- The dataset editor's URL hint follows whether this dashboard may use the server's private hosts: it no longer says
  private addresses are blocked where they are allowed, and the field is then labelled "URL" instead of "HTTPS URL".

### Changed

- A dataset that does not refresh on its own now retries after a failure, every minute, or every 15 minutes for an
  error that needs a fix, until it loads; before, it kept the error until the page was reloaded. A live dataset with a
  long refresh interval may also be asked again between pushes after an error. Retries of many widgets are spread over
  a few seconds.
- In presentation mode the waiting, "No data" and error texts grow with the widget, so they can be read from a
  distance.
- Starting presentation adds `present=1` to the address and leaving removes it, so a reload keeps the current mode and
  a link copied after leaving does not open in presentation mode.

## [0.3.2] - 2026-11-11

### Fixed

- Every built-in connector load, with or without a filter, now has a per-host limit on what it asks the upstream API
  (four loads at a time, 120 a minute per host). A dashboard that opens several cities or periods at once waits briefly
  instead of showing an error, and the page asks again a few seconds after the server refused a dataset for its own
  limits; HTTP sources and feeds are asked again after 10 seconds too. Demo connectors are not counted.
- Results of built-in connectors are kept in a cache bounded by memory (16 MB) instead of by count, so many filter
  values with large results can no longer fill the server's memory. The weather city lookup is bounded too.
- Renaming a column to the name of another existing column is refused with a step error instead of producing two
  columns of that name. A saved dataset that did this now shows that error until the rename is changed.
- A choice value containing `$param.` anywhere is refused when a filter is saved, and such values are left out of
  choices taken from data; before, the dataset using it failed with a misleading message. Existing dashboards keep
  opening.
- A search text filter's default is trimmed, so the page, links, snapshots and agents use the same value.
- Filter values passed to the MCP tools have the same length limits as in the REST API.
- A dashboard on a relative period no longer retries every minute after the server refuses its request outright (a
  removed dashboard, lost access or a filter value that is no longer offered); it still retries after network errors,
  server errors and errors from a source.
- A click-to-filter value that matches no item (such as a partly typed search text) no longer dims every item.
- A showcase whose source URL or body uses a filter is refused when the server starts, instead of failing later in
  anonymous copies.
- `preview_data` (with a dashboard) and `render_snapshot` now echo the filter values used and the link to that view, as
  the reference says; unknown filter ids are named in a note.
- The text `false` bound to a yes/no connector parameter now means false.
- The filter editor keeps the default valid when the options or presets it pointed at change, so Save stays available.
- "Make current values the default" is offered only when it would change something, and no longer creates an empty
  version for filters that take their choices from data.
- The editor shows the limit of 8 filters before saving: "Add filter" is disabled with the reason.
- A dataset that a filter takes its choices from cannot be deleted from the editor, with the reason shown, instead of
  being offered and then refused.

### Changed

- A sound no longer plays for the first result after a relative period (yesterday, last month, ...) moves to a new day
  or month; that result is the new baseline, like the first result after loading the page.
- On a wall screen in presentation mode, a value of a filter that takes its choices from a refreshing dataset is kept
  when it disappears from the data: the affected widgets say they are waiting for it, and the view resumes on its own
  when the value returns. Outside presentation it still falls back to "All".
- Column-shaped JSON (an object of equally long lists such as `{ "labels": [...], "values": [...] }`) is read as
  columns both without a path and through a path. Before 0.3.0 such an object gave one `value` column from its first
  list, or one record, so saved HTTP datasets reading such responses show different columns since 0.3.0.

## [0.3.1] - 2026-11-10

### Fixed

- Filters that take their choices from data no longer slow the server down: the choices of a column with thousands of
  distinct values are sorted much faster and worked out once per loaded result instead of on every request, so links
  carrying such a filter value (valid or not) can no longer keep the server busy for other viewers.
- A dashboard left open on a relative period such as "Last 7 days" no longer keeps yesterday's window for a whole
  day when it re-rendered in the first minute after midnight UTC or its refetch then failed: it now refetches at the
  coming 00:01 UTC and retries every minute until it has the new day's data.
- On a public dashboard, switching a source that uses secrets between GET and POST, or changing its POST body (such
  as the GraphQL query), now asks for the same confirmation as pointing it at another URL: both send new queries with
  your key. Reordering the keys of the same body does not ask.

### Changed

- Dependency updates: Biome 2.6.6, Hono 4.13.17, undici 8.12.4, React Query 5.107, zustand 5.1, Tailwind 4.3.5, Vite 8.3.6.

## [0.3.0] - 2026-11-10

### Added

- **Dashboard filters**: a dashboard can declare filters (a choice such as a region, a search text, a period with
  presets like "Last 30 days") that every viewer sets in a filter bar under the header. Datasets use them as
  `$param.<id>` in filter and derive steps, as a whole query value or path segment of an `http` or `feed` URL, and as
  a whole value of a POST body or connector parameters, so one dashboard serves every region or period instead of a
  copy per value. Values live only in the page link (`?p.region=eu`): a link opens a view, presentation mode can be
  pinned to one and shows which, and nothing is saved or seen by other viewers. Editors declare filters in the
  Filters panel; agents use the new operations and pass `parameters` to `get_data`, `render_snapshot`,
  `suggest_widgets` and `preview_data`. Datasets that use filters refresh by polling rather than the live push.
- **Click to filter**: a chart (bar, line, area, pie, donut, funnel), table or map can set a dashboard filter when an
  item is clicked; clicking it again resets it, Back undoes it, and the other items are dimmed in the browser and in
  snapshots. Clicks do nothing in presentation mode. A choice filter can also take its choices from a column of a
  dataset (`optionsFrom`), up to 200 distinct values.
- **POST for `http` sources**: `method: "POST"` with a JSON `body` (at most 16,384 characters) loads read APIs that
  take their query in a POST body, such as GitHub GraphQL, PostHog or ClickHouse over HTTP. The editor has a GET / POST
  switch and a JSON body field; agents find the fields and a GitHub example in `get_reference`. The request repeats on
  every refresh, so use it for read queries; keys stay in secrets, never in the body. A redirect answer to a POST is an
  error instead of being followed, and a read-only token cannot preview a POST source.
- **Column-shaped JSON**: an `http` response or a JSON upload whose object holds only equally long lists of plain
  values (`{ "timestamps": [...], "values": [...] }`, at least two) now becomes one row per position with every
  column. Before, only the first list was kept. Any other shape is read exactly as before.
- **`path` for JSON uploads**: an upload (MCP `upload_data`, the REST upload endpoint and the upload area in the
  dataset editor) takes an optional `path` such as `"data.items"`, applied to a JSON file before it is stored, so
  records nested inside a file can be used without editing it. CSV files ignore it.

### Fixed

- A column named `__proto__` (a JSON key or a CSV header) is now kept like any other column, in `http` responses,
  uploads, stored files and every processing step; it used to vanish without a message. A record without a column
  that another record has reads that cell as empty even when the column is called `constructor` or `toString`, and
  `rename` no longer renames such a column to a member of JavaScript's `Object`.
- Dataset editor: a typed POST body survives switching the method to GET and back; the preview shows its row and
  column counts only beside the table they describe (a stale table stays dimmed while the body is invalid); and
  typing a POST body waits for a longer pause before previewing, so it no longer sends a request upstream at every
  short pause.

## [0.2.1] - 2026-11-06

### Changed

- **Status widget**: sections and tiles of the same level now keep the order of the dataset's rows instead of being
  sorted by name, so a `sort` transform sets the order (for example "NUC, NAS, Internet"). Without one, calm
  sections follow the order in which the source sends its rows; add a `sort` step for a fixed order. The worst
  level still comes first and "Other" last within its level.

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

[Unreleased]: https://github.com/carnaby/patchbay/compare/v0.3.3...HEAD
[0.3.3]: https://github.com/carnaby/patchbay/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/carnaby/patchbay/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/carnaby/patchbay/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/carnaby/patchbay/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/carnaby/patchbay/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/carnaby/patchbay/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/carnaby/patchbay/releases/tag/v0.1.0
