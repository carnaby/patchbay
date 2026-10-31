# Third-party notices

Patchbay itself is MIT licensed (see [LICENSE](LICENSE)). The container image and the built web app also contain the
third-party software and data below. Versions are those in `pnpm-lock.yaml` at the time of writing; each package's
own licence file, shipped in `node_modules`, is authoritative.

## Software under licences other than MIT

| Component                                                                        | Version | Licence      | Used for                                      |
| -------------------------------------------------------------------------------- | ------- | ------------ | --------------------------------------------- |
| [Apache ECharts](https://echarts.apache.org) (`echarts`)                         | 6.1.0   | Apache-2.0   | Charts and maps in the browser and snapshots  |
| [ZRender](https://github.com/ecomfe/zrender) (`zrender`)                         | 6.1.0   | BSD-3-Clause | ECharts' rendering engine                     |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)     | 2.4.0   | Apache-2.0   | MCP server (`server`, `core`; `hono` 2.0.2)   |
| [resvg-js](https://github.com/thx/resvg-js) (`@resvg/resvg-js` and its binaries) | 2.6.2   | MPL-2.0      | Rasterising snapshot SVGs to PNG (unmodified) |
| [Lucide](https://lucide.dev) (`lucide-react`)                                    | 1.61.0  | ISC          | Icons in the web app                          |
| [tslib](https://github.com/microsoft/tslib)                                      | 2.3.0   | 0BSD         | Runtime helpers used by ECharts               |
| [@ungap/structured-clone](https://github.com/ungap/structured-clone)             | 1.4.0   | ISC          | Dependency of the Markdown renderer           |

Apache ECharts and the MCP SDK are distributed under the Apache License 2.0. The MCP SDK ships no NOTICE file;
Apache ECharts' NOTICE reads:

```text
Apache ECharts
Copyright 2017-2026 The Apache Software Foundation

This product includes software developed at
The Apache Software Foundation (https://www.apache.org/).
```

resvg-js is used as published, without modification; its source is available at
the link above under the Mozilla Public License 2.0.

All other runtime dependencies (React, Hono, Zod, TanStack Query, react-grid-layout, react-markdown, undici,
fast-xml-parser, Papa Parse, arctic, nanoid, zustand, immer and their dependencies) are MIT licensed. To list them
with their licences: `pnpm licenses list --prod`.

## Fonts

- **Inter** 4.001 (Regular, SemiBold, Bold), © The Inter Project Authors, under the SIL Open Font License 1.1.
  Bundled for text in server-rendered snapshots: `apps/server/src/render/fonts/`, licence in
  [LICENSE.txt](apps/server/src/render/fonts/LICENSE.txt).

## Data

- **Natural Earth** 1:110m Cultural Vectors, Admin 0 – Countries, version 5.1.2: public domain. The base map of the
  map widget, `packages/core/geo/world-110m.json`; see [packages/core/geo/README.md](packages/core/geo/README.md).
- Data that connectors fetch at run time (Open-Meteo, CoinGecko, Frankfurter/ECB, USGS, World Bank, Wikimedia,
  Hacker News, GitHub, npm and others) is not part of this repository and is subject to each provider's terms; the
  editor shows the source of each connector's data.
