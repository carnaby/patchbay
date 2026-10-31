import type { ConnectorInfo, DataTable, ParamSpec } from '@patchbay/core';
import { z } from 'zod';

export type Params = Record<string, string | number | boolean>;

export interface ConnectorContext {
  fetchJson: <T = unknown>(url: string, headers?: Record<string, string>) => Promise<T>;
}

export interface Connector {
  info: ConnectorInfo;
  /** Calls the real upstream API. */
  fetch(params: Params, ctx: ConnectorContext): Promise<DataTable>;
  /** Deterministic synthetic data with the same shape, for OFFLINE mode, tests and demos. */
  sample(params: Params): DataTable;
}

export function paramsSchema(specs: ParamSpec[]) {
  const shape: Record<string, z.ZodType> = {};
  for (const p of specs) {
    let s: z.ZodType;
    switch (p.type) {
      case 'number':
        s = z.coerce.number();
        break;
      case 'boolean':
        s = z.coerce.boolean();
        break;
      case 'enum':
        s = z.enum(p.options!.map((o) => o.value) as [string, ...string[]]);
        break;
      default:
        s = z
          .string()
          .trim()
          .min(p.required ? 1 : 0)
          .max(500);
    }
    if (p.default !== undefined) s = s.default(p.default as never);
    else if (!p.required) s = s.optional();
    shape[p.name] = s;
  }
  return z.strictObject(shape);
}

/**
 * A numeric param within its documented range, or `fallback` when it is missing or not a number. fetch() and sample()
 * share it: OFFLINE=1 serves sample() to everyone, so an unclamped "days: 1e9" there built a billion rows.
 */
export function clampParam(value: unknown, fallback: number, min: number, max: number): number {
  const n = value === undefined || value === null || value === '' ? fallback : Number(value);
  return Math.min(Math.max(Number.isFinite(n) ? n : fallback, min), max);
}

/** Small seeded PRNG so synthetic data is stable for a given seed. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedOf(...parts: unknown[]): number {
  const text = JSON.stringify(parts);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const floorTo = (ms: number, step: number) => Math.floor(ms / step) * step;
export const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
