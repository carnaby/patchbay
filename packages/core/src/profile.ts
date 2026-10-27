/**
 * Dataset profiling: what is in this table and what role does each column play?
 * The profile drives the built-in suggestion engine and is also returned to
 * MCP clients, so an agent can reason about unfamiliar data without reading
 * every row.
 */
import type { Column, DataTable, Scalar } from './table.ts';

export type ColumnRole =
  | 'time'
  | 'measure'
  | 'dimension'
  | 'identifier'
  | 'text'
  | 'latitude'
  | 'longitude'
  | 'url'
  | 'flag';

export interface ColumnProfile extends Column {
  role: ColumnRole;
  nulls: number;
  distinct: number;
  min?: number;
  max?: number;
  mean?: number;
  top?: { value: string; count: number }[];
  sample: Scalar[];
}

export interface TableProfile {
  rows: number;
  columns: ColumnProfile[];
  /** Time span covered by the first time column, if any. */
  span?: { field: string; from: number; to: number };
}

const URL_RE = /^https?:\/\//i;
const ID_NAME = /(^id$|_id$|Id$|^uuid$|^key$|^code$)/;

/** Whether a numeric column's name says it holds a latitude or a longitude; shared with the map editor's defaults. */
export function coordinateRole(columnName: string): 'latitude' | 'longitude' | null {
  const name = columnName.toLowerCase();
  if (/^(lat|latitude)$/.test(name) || name.endsWith('.lat') || name.endsWith('latitude')) return 'latitude';
  if (/^(lon|lng|long|longitude)$/.test(name) || name.endsWith('.lon') || name.endsWith('longitude'))
    return 'longitude';
  return null;
}

function roleOf(col: Column, values: Scalar[], distinct: number, rows: number): ColumnRole {
  const name = col.name.toLowerCase();
  if (col.type === 'time') return 'time';
  if (col.type === 'boolean') return 'flag';
  if (col.type === 'number') {
    const coordinate = coordinateRole(col.name);
    if (coordinate) return coordinate;
    if (/^(year|yr)$/.test(name)) return 'time';
    if (ID_NAME.test(col.name) && distinct === rows) return 'identifier';
    return 'measure';
  }
  const strings = values.filter((v): v is string => typeof v === 'string');
  if (strings.length && strings.filter((s) => URL_RE.test(s)).length / strings.length > 0.8) return 'url';
  if (ID_NAME.test(col.name) && distinct === rows) return 'identifier';
  const avgLength = strings.reduce((s, v) => s + v.length, 0) / Math.max(strings.length, 1);
  if (distinct <= Math.max(30, rows * 0.2) && avgLength < 60) return 'dimension';
  return 'text';
}

export function profileTable(table: DataTable): TableProfile {
  const rows = table.rows.length;
  const columns = table.columns.map((col): ColumnProfile => {
    const values = table.rows.map((r) => r[col.name] ?? null);
    const present = values.filter((v) => v !== null);
    const counts = new Map<string, number>();
    for (const v of present) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
    const profile: ColumnProfile = {
      ...col,
      role: roleOf(col, present, counts.size, rows),
      nulls: rows - present.length,
      distinct: counts.size,
      sample: present.slice(0, 5),
    };
    if (col.type === 'number' || col.type === 'time') {
      const ns = present.filter((v): v is number => typeof v === 'number');
      if (ns.length) {
        let min = ns[0]!;
        let max = ns[0]!;
        let sum = 0;
        for (const n of ns) {
          if (n < min) min = n;
          if (n > max) max = n;
          sum += n;
        }
        profile.min = min;
        profile.max = max;
        if (col.type === 'number') profile.mean = sum / ns.length;
      }
    }
    if (col.type === 'string' || col.type === 'boolean') {
      profile.top = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([value, count]) => ({ value, count }));
    }
    return profile;
  });
  const time = columns.find((c) => c.type === 'time' && c.min !== undefined);
  return {
    rows,
    columns,
    ...(time ? { span: { field: time.name, from: time.min!, to: time.max! } } : {}),
  };
}
