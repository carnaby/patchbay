/**
 * Table cells: which columns a table shows, under which header, in which number format and colour.
 *
 * The browser table and the PNG renderer both call these, so a rule that colours a row in the editor colours the
 * same row in `render_snapshot`. There is no second implementation.
 */
import { bandFor } from './colors.ts';
import { compile, isTruthy } from './expr.ts';
import { formatNumber, formatValue } from './format.ts';
import type { Bands, Format, TableConfig, TableRule } from './schema.ts';
import type { ColumnType, DataTable, Row, Scalar } from './table.ts';
import { type ChartTheme, resolveColor } from './theme.ts';

export interface ResolvedColumn {
  field: string;
  /** Header text: the column's label, or its field name. */
  label: string;
  type: ColumnType;
  format: Format | undefined;
  bands: Bands | undefined;
  colorAs: 'fill' | 'text';
}

/** The table's columns with every default applied; plain names and column objects come out alike. */
export function tableColumns(config: TableConfig, table: DataTable): ResolvedColumn[] {
  const types = new Map(table.columns.map((c) => [c.name, c.type]));
  const list = config.columns?.length ? config.columns : table.columns.map((c) => c.name);
  return list.map((entry) => {
    const col = typeof entry === 'string' ? { field: entry } : entry;
    return {
      field: col.field,
      label: ('label' in col && col.label) || col.field,
      // A configured column missing from the data still gets a header and "-" cells, as before.
      type: types.get(col.field) ?? 'string',
      format: ('format' in col && col.format) || config.format,
      bands: 'bands' in col ? col.bands : undefined,
      colorAs: ('colorAs' in col && col.colorAs) || 'fill',
    };
  });
}

export interface CellStyle {
  /** The formatted value. */
  text: string;
  /** Text colour, contrast-checked against the card. Absent: the normal ink. */
  color?: string;
  /** A light tint behind the cell; the text keeps the normal ink. */
  background?: string;
  /** Why the cell is coloured, for its tooltip: colour is never the only carrier. */
  reason?: string;
}

interface CompiledRule {
  rule: TableRule;
  columns: Set<string> | null;
  test: (row: Row) => boolean;
}

export interface TableRules {
  /** The rules that match a row, in order; evaluated once per row and remembered. */
  matching(row: Row): CompiledRule[];
}

/** Compiles a table's rules once per result. A rule that fails on a row (wrong types) simply does not match it. */
export function compileTableRules(config: TableConfig): TableRules {
  const rules: CompiledRule[] = (config.rules ?? []).map((rule) => {
    let evaluate: ((row: Row) => Scalar) | null = null;
    try {
      evaluate = compile(rule.when);
    } catch {
      // The schema validated the expression; this only guards documents edited by hand.
    }
    return {
      rule,
      columns: rule.columns?.length ? new Set(rule.columns) : null,
      test: (row) => {
        if (!evaluate) return false;
        try {
          return isTruthy(evaluate(row));
        } catch {
          return false;
        }
      },
    };
  });
  const cache = new WeakMap<Row, CompiledRule[]>();
  return {
    matching(row) {
      if (!rules.length) return rules;
      let hit = cache.get(row);
      if (!hit) {
        hit = rules.filter((r) => r.test(row));
        cache.set(row, hit);
      }
      return hit;
    },
  };
}

/**
 * Text and colour of one cell. A column's bands win over row rules for that cell (they are more specific); among
 * rules the first match wins, so their order is their priority.
 */
export function cellStyle(row: Row, column: ResolvedColumn, rules: TableRules, theme: ChartTheme): CellStyle {
  const value = row[column.field] ?? null;
  const text = formatValue(value, column.type, column.format);
  const band = bandFor(column.bands, value);
  let color = band?.color;
  let colorAs = column.colorAs;
  let reason = band ? `${column.label} up to ${formatNumber(band.upTo, column.format)}` : undefined;
  if (!color) {
    const rule = rules.matching(row).find((r) => !r.columns || r.columns.has(column.field));
    if (rule) {
      color = rule.rule.color;
      colorAs = rule.rule.colorAs;
      reason = rule.rule.label || rule.rule.when;
    }
  }
  if (!color) return { text };
  return colorAs === 'text'
    ? { text, color: resolveColor(color, theme, 'text'), ...(reason ? { reason } : {}) }
    : { text, background: resolveColor(color, theme, 'fill'), ...(reason ? { reason } : {}) };
}
