/**
 * Converts Natural Earth "Admin 0 - Countries" (1:110m, GeoJSON) into the base map the map widget draws.
 *
 * Run by hand, not in the build, whenever the source version changes:
 *
 *   node packages/core/geo/build-geo.ts ne_110m_admin_0_countries.geojson packages/core/geo/world-110m.json
 *
 * Only the geometry and `iso_a3` (for a future choropleth) are kept, and coordinates are rounded to 0.1°: at the
 * 1:110m scale that is below the source's own precision, and it shrinks the file to a fraction of its size.
 */
import { readFileSync, writeFileSync } from 'node:fs';

type Ring = [number, number][];
type Geometry = { type: 'Polygon'; coordinates: Ring[] } | { type: 'MultiPolygon'; coordinates: Ring[][] };
interface Feature {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry: Geometry | null;
}

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('Usage: node build-geo.ts <ne_110m_admin_0_countries.geojson> <world-110m.json>');
  process.exit(1);
}

const round = (v: number) => Math.round(v * 10) / 10;

/** Twice the signed area; zero once rounding has folded a ring onto a line or a point. */
function area(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[i + 1]!;
    sum += x1 * y2 - x2 * y1;
  }
  return sum;
}

function simplifyRing(ring: Ring): Ring | null {
  const out: Ring = [];
  for (const [lon, lat] of ring) {
    const point: [number, number] = [round(lon), round(lat)];
    const last = out[out.length - 1];
    if (!last || last[0] !== point[0] || last[1] !== point[1]) out.push(point);
  }
  // A closed ring needs three distinct corners plus the closing point.
  if (out.length < 4 || area(out) === 0) return null;
  return out;
}

function simplifyPolygon(rings: Ring[]): Ring[] | null {
  const outer = simplifyRing(rings[0] ?? []);
  if (!outer) return null;
  const holes = rings.slice(1).flatMap((r) => {
    const hole = simplifyRing(r);
    return hole ? [hole] : [];
  });
  return [outer, ...holes];
}

/** Some 110m countries carry "-99" as their ISO code (France, Norway, Kosovo); the "EH" field fills those in. */
function isoOf(p: Record<string, unknown>): string {
  for (const key of ['ISO_A3', 'ISO_A3_EH', 'ADM0_A3']) {
    const v = p[key];
    if (typeof v === 'string' && /^[A-Z]{3}$/.test(v)) return v;
  }
  return '';
}

const source = JSON.parse(readFileSync(input, 'utf8')) as { features: Feature[] };
const features: Feature[] = [];
for (const f of source.features) {
  const g = f.geometry;
  if (!g) continue;
  const polygons = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates)
    .map(simplifyPolygon)
    .filter((p): p is Ring[] => p !== null);
  if (!polygons.length) continue;
  features.push({
    type: 'Feature',
    properties: { iso_a3: isoOf(f.properties) },
    geometry:
      polygons.length === 1
        ? { type: 'Polygon', coordinates: polygons[0]! }
        : { type: 'MultiPolygon', coordinates: polygons },
  });
}

// One feature per line: small diffs when the source is updated, and still compact.
const body = features.map((f) => JSON.stringify(f)).join(',\n');
writeFileSync(output, `{"type":"FeatureCollection","features":[\n${body}\n]}\n`);
console.log(`${features.length} features, ${(Buffer.byteLength(body) / 1024).toFixed(0)} KB`);
