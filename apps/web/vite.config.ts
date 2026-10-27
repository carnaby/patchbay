import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.PATCHBAY_API ?? 'http://localhost:8787';
const proxied = [
  '/api',
  '/auth',
  '/oauth/authorize',
  '/oauth/token',
  '/oauth/register',
  '/oauth/revoke',
  '/.well-known',
  '/mcp',
  '/healthz',
];

interface ModuleInfo {
  isEntry: boolean;
  importers: readonly string[];
  dynamicImporters: readonly string[];
}
type GetModuleInfo = (id: string) => ModuleInfo | null;

const MAP_BODY = /\/widgets\/MapBody\.tsx$/;

/** Modules known to be reachable from a page without passing through the map; only positive answers are final. */
const onPages = new Set<string>();

/** Whether an entry reaches the module along imports that avoid the map body. */
function reachedByPages(id: string, getModuleInfo: GetModuleInfo, visited = new Set<string>()): boolean {
  if (onPages.has(id)) return true;
  visited.add(id);
  const info = getModuleInfo(id);
  const importers = [...(info?.importers ?? []), ...(info?.dynamicImporters ?? [])];
  // Pages start at index.html, which the graph lists as an importer but describes no further.
  const found =
    !info ||
    info.isEntry ||
    importers.length === 0 ||
    importers.some(
      (imp) => !MAP_BODY.test(imp) && !visited.has(imp) && reachedByPages(imp, getModuleInfo, visited),
    );
  if (found) onPages.add(id);
  return found;
}

/**
 * The lazily loaded map chunk: the map body and everything no page reaches without it (the base map, core's map
 * logic, ECharts' geo, lines, custom and graphic parts). It relies on ECharts being imported by path everywhere
 * (EChart.tsx): its index modules would make every part look used by every page. scripts/check-chunks.mjs verifies
 * that no page loads the chunk.
 */
const forMaps = (id: string, getModuleInfo: GetModuleInfo) =>
  MAP_BODY.test(id) || !reachedByPages(id, getModuleInfo);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(proxied.map((p) => [p, { target: api, changeOrigin: false }])),
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1200,
    // scripts/check-chunks.mjs reads it to prove the map chunk stays out of every page's static imports.
    manifest: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: (id, ctx) => (forMaps(id, (m) => ctx.getModuleInfo(m)) ? 'map' : null),
              priority: 3,
              // Its dependencies (core, ECharts' shared code) belong to the pages' chunks; captured here they would
              // make every page load the map chunk.
              includeDependenciesRecursively: false,
            },
            { name: 'charts', test: /echarts|zrender/, priority: 2 },
            { name: 'vendor', test: /node_modules/, priority: 1 },
          ],
        },
      },
    },
  },
});
