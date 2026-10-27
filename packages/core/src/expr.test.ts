import { describe, expect, it } from 'vitest';
import { compile, ExprError, parse } from './index.ts';

const close = (actual: unknown, expected: number, digits = 9) => {
  expect(typeof actual).toBe('number');
  expect(actual as number).toBeCloseTo(expected, digits);
};

describe('trigonometry', () => {
  it('evaluates the basic functions in radians', () => {
    close(compile('pi()')({}), Math.PI);
    close(compile('sin(pi() / 2)')({}), 1);
    close(compile('cos(0)')({}), 1);
    close(compile('tan(pi() / 4)')({}), 1);
    close(compile('asin(1)')({}), Math.PI / 2);
    close(compile('acos(1)')({}), 0);
    close(compile('atan(1)')({}), Math.PI / 4);
    close(compile('atan2(1, -1)')({}), (3 * Math.PI) / 4);
  });

  it('converts between degrees and radians', () => {
    close(compile('radians(180)')({}), Math.PI);
    close(compile('degrees(pi())')({}), 180);
    close(compile('degrees(atan2(lat, lon))')({ lat: 1, lon: 1 }), 45);
  });

  it('returns null for missing or out-of-domain input instead of NaN', () => {
    expect(compile('sin(x)')({ x: null })).toBeNull();
    expect(compile('asin(2)')({})).toBeNull();
    expect(compile('sin("abc")')({})).toBeNull();
  });

  it('stays sandboxed: no bare constant leaks in, and unknown functions still fail', () => {
    // A bare `pi` is a field reference, so a column named "pi" keeps working.
    expect(compile('pi')({ pi: 7 })).toBe(7);
    expect(() => parse('Math.sin(1)')).toThrow(ExprError);
  });
});

describe('distance', () => {
  it('gives the great-circle distance between two known cities in km', () => {
    // London to Paris is about 344 km; Bratislava to Vienna about 55 km.
    const km = compile('distance(51.5074, -0.1278, 48.8566, 2.3522)')({});
    expect(km as number).toBeGreaterThan(341);
    expect(km as number).toBeLessThan(346);
    const near = compile('distance(lat, lon, 48.2082, 16.3738)')({ lat: 48.1486, lon: 17.1077 });
    expect(near as number).toBeGreaterThan(53);
    expect(near as number).toBeLessThan(57);
  });

  it('is zero for the same point, symmetric, and bounded for antipodes', () => {
    expect(compile('distance(10, 20, 10, 20)')({})).toBe(0);
    const ab = compile('distance(40.7128, -74.006, 35.6762, 139.6503)')({});
    const ba = compile('distance(35.6762, 139.6503, 40.7128, -74.006)')({});
    close(ab, ba as number, 6);
    // New York to Tokyo is about 10 850 km.
    expect(ab as number).toBeGreaterThan(10_800);
    expect(ab as number).toBeLessThan(10_900);
    close(compile('distance(0, 0, 0, 180)')({}), Math.PI * 6371.0088, 3);
  });

  it('returns null when a coordinate is missing', () => {
    expect(compile('distance(lat, lon, 0, 0)')({ lat: 1, lon: null })).toBeNull();
  });
});
