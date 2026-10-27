// Runs after `vite build`: the map chunk (base map, geo code) must only ever be loaded lazily. If a page imported it
// statically, every dashboard would download the world map, map or not. See the chunk groups in vite.config.ts.
import { readFileSync, statSync } from 'node:fs';

const dist = new URL('../dist/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('.vite/manifest.json', dist), 'utf8'));

const mapKeys = Object.keys(manifest).filter((key) => /(^|\/)_?map-[\w-]+\.js$/.test(manifest[key].file));
const fail = (message) => {
  console.error(`check-chunks: ${message}`);
  process.exit(1);
};

if (mapKeys.length !== 1) fail(`expected one map chunk, found ${mapKeys.length}`);
const [mapKey] = mapKeys;
const staticImporters = Object.entries(manifest).filter(([, chunk]) => chunk.imports?.includes(mapKey));
if (staticImporters.length) {
  fail(`the map chunk is imported statically by ${staticImporters.map(([key]) => key).join(', ')}`);
}
if (!Object.values(manifest).some((chunk) => chunk.dynamicImports?.includes(mapKey))) {
  fail('nothing loads the map chunk lazily');
}
// The base map itself must be inside, not in a chunk every page loads.
const size = statSync(new URL(manifest[mapKey].file, dist)).size;
if (size < 100_000) fail(`the map chunk is only ${size} bytes; the base map is missing from it`);

console.log(`check-chunks: ${manifest[mapKey].file} (${Math.round(size / 1024)} KB) is only loaded lazily`);
