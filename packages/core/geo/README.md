# Base map data

`world-110m.json` is the base map of the map widget: the countries of the world as GeoJSON, drawn by ECharts' `geo`
component in the browser and in the PNG snapshot renderer. It is bundled so maps need no tiles and make no
third-party requests.

- **Source:** [Natural Earth](https://www.naturalearthdata.com/) 1:110m Cultural Vectors, Admin 0 – Countries,
  version 5.1.2 (`geojson/ne_110m_admin_0_countries.geojson` in
  [nvkelso/natural-earth-vector](https://github.com/nvkelso/natural-earth-vector) at tag `v5.1.2`).
- **Licence:** public domain. "No permission is needed to use Natural Earth. Crediting the authors is unnecessary."
  We credit it anyway. See <https://www.naturalearthdata.com/about/terms-of-use/>.
- **Borders:** Natural Earth draws de facto boundaries. The widget shows them by default; `basemap: "land"` hides
  them.
- **Conversion:** `node packages/core/geo/build-geo.ts <source.geojson> packages/core/geo/world-110m.json`. It keeps
  only the geometry and `iso_a3` (for a future choropleth), rounds coordinates to 0.1° and drops rings that collapse.
  A test (`packages/core/src/map.test.ts`) keeps the file under 300 KB, so a higher-resolution export fails CI.

The file is outside `src/` and not exported from `index.ts`: only the two places that register the map (the web map
chunk and `apps/server/src/render/snapshot.ts`) import it, so nothing else pays for it.
