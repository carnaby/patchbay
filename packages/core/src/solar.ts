/**
 * Where the sun is overhead, and which half of the world is in the dark, for the map's day/night shading.
 *
 * The NOAA approximation (solar declination and equation of time from the Julian century) is about 0.5° accurate,
 * which is invisible at the 1:110m scale of the base map. Everything takes an explicit time and never reads the
 * clock, so the browser and the snapshot renderer shade the same night for the same data.
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** Normalises a longitude to [-180, 180). */
export function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** Latitude and longitude (degrees) of the point where the sun is at the zenith at `ms` (epoch milliseconds). */
export function subsolarPoint(ms: number): { lat: number; lon: number } {
  const julianDay = ms / 86_400_000 + 2_440_587.5;
  const t = (julianDay - 2_451_545) / 36_525;
  const meanLon = (((280.46646 + t * (36_000.76983 + t * 0.0003032)) % 360) + 360) % 360;
  const meanAnomaly = 357.52911 + t * (35_999.05029 - 0.0001537 * t);
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const m = meanAnomaly * RAD;
  const center =
    Math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m) * 0.000289;
  const omega = (125.04 - 1934.136 * t) * RAD;
  const apparentLon = (meanLon + center - 0.00569 - 0.00478 * Math.sin(omega)) * RAD;
  const meanObliquity = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliquity = (meanObliquity + 0.00256 * Math.cos(omega)) * RAD;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(apparentLon)) * DEG;

  const y = Math.tan(obliquity / 2) ** 2;
  const l0 = meanLon * RAD;
  // Minutes by which the apparent sun runs ahead of the mean sun.
  const equationOfTime =
    4 *
    DEG *
    (y * Math.sin(2 * l0) -
      2 * eccentricity * Math.sin(m) +
      4 * eccentricity * y * Math.sin(m) * Math.cos(2 * l0) -
      0.5 * y * y * Math.sin(4 * l0) -
      1.25 * eccentricity * eccentricity * Math.sin(2 * m));
  const minutes = (((ms % 86_400_000) + 86_400_000) % 86_400_000) / 60_000;
  // Solar noon is where the true solar time is 12:00, i.e. 720 minutes.
  const lon = wrapLon((720 - minutes - equationOfTime) / 4);
  return { lat: declination, lon };
}

/**
 * The night side of the earth at `ms` as one closed ring of [lon, lat] points, in the equirectangular plane the map
 * uses: the terminator from -180° to 180° and back along the pole that is in darkness.
 */
export function nightPolygon(ms: number, stepDeg = 2): [number, number][] {
  const sun = subsolarPoint(ms);
  // Near an equinox tan(declination) approaches 0 and the terminator becomes the two meridians 90° from the sun;
  // clamping keeps the formula finite and draws exactly that.
  const decl = (Math.abs(sun.lat) < 0.01 ? (sun.lat < 0 ? -0.01 : 0.01) : sun.lat) * RAD;
  const ring: [number, number][] = [];
  const steps = Math.max(1, Math.round(360 / stepDeg));
  for (let i = 0; i <= steps; i++) {
    const lon = -180 + (360 * i) / steps;
    const lat = Math.atan(-Math.cos((lon - sun.lon) * RAD) / Math.tan(decl)) * DEG;
    ring.push([lon, lat]);
  }
  // With the sun north of the equator the night lies south of the terminator everywhere, and vice versa.
  const darkPole = decl > 0 ? -90 : 90;
  ring.push([180, darkPole], [-180, darkPole], ring[0]!);
  return ring;
}
