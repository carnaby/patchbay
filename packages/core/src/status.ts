/**
 * The status widget: many checks, each with a state, shown as one tile per entity (a service, project or host) in
 * sections (say, the machine it runs on). Pure and without DOM: the browser and the snapshot renderer build the same
 * model here, and both ask `statusFit` which tiles fit, so a screen and the image an agent looks at agree.
 */
import { stripAnsi } from './ansi.ts';
import { formatRelative } from './format.ts';
import type { StatusConfig } from './schema.ts';
import type { Column, DataTable, Scalar } from './table.ts';
import type { ColorToken } from './theme.ts';

export const STATUS_LEVELS = ['fail', 'warn', 'ok', 'off'] as const;
export type StatusLevel = (typeof STATUS_LEVELS)[number];

/** The values each level is read from, case-insensitively after trimming. The MCP reference lists them from here. */
export const STATUS_VOCABULARY: Record<StatusLevel, readonly string[]> = {
  fail: ['fail', 'failed', 'error', 'down', 'critical', 'crit'],
  warn: ['warn', 'warning', 'degraded'],
  ok: ['ok', 'up', 'healthy', 'pass', 'passed', 'success'],
  off: ['off', 'disabled', 'paused', 'maintenance'],
};

/**
 * Rows read, sections and tiles kept, entries in `levels`. A row over a cap is not counted anywhere, which is why the
 * summary line says when rows were left out.
 */
export const STATUS_LIMITS = { rows: 1000, sections: 40, tiles: 300, levels: 40 } as const;

/** Theme tokens, so light and dark mode both get validated colours; not configurable in v1. */
export const STATUS_COLORS: Record<StatusLevel, ColorToken> = {
  fail: 'negative',
  warn: 'warning',
  ok: 'positive',
  off: 'neutral',
};

/** The level in words, for screen readers and the panel: colour is never the only signal. */
export const STATUS_LEVEL_TEXT: Record<StatusLevel, string> = {
  fail: 'failing',
  warn: 'warning',
  ok: 'ok',
  off: 'off',
};

/** Column names that say "this is the state"; shared by the editor's defaults and the suggestions. */
export const STATUS_COLUMN_NAMES: readonly string[] = ['status', 'state', 'health'];

// Lower is worse. Off ranks below ok: a check stopped on purpose is not a problem.
const RANK: Record<StatusLevel, number> = { fail: 0, warn: 1, ok: 2, off: 3 };
const OTHER = 'Other';
// Unlike every "g:"/"e:" key, so a group literally named "Other" stays a section of its own.
const OTHER_KEY = '~other';
/** The tile shows two lines of a detail at worst and the panel is for reading, not for whole logs. */
const DETAIL_MAX = 2000;
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const normal = (value: string) => value.trim().toLowerCase();
const DEFAULT_LEVELS = new Map<string, StatusLevel>(
  STATUS_LEVELS.flatMap((level) =>
    STATUS_VOCABULARY[level].map((word): [string, StatusLevel] => [word, level]),
  ),
);

/** Whether a value is in the default vocabulary; the suggestions spot a status column by its values with it. */
export function isStatusWord(value: string): boolean {
  return DEFAULT_LEVELS.has(normal(value));
}

/**
 * The level lookup, built once per model: the widget's own `levels` first, then the default vocabulary. Booleans
 * read as ok and fail, numbers as their text. Anything else, also null and empty, is warn: a monitor that sends a
 * state nobody expected deserves a look, not green.
 */
export function statusLevels(
  levels?: Readonly<Record<string, StatusLevel>>,
): (value: Scalar | undefined) => StatusLevel {
  const own = new Map<string, StatusLevel>();
  for (const [name, level] of Object.entries(levels ?? {})) own.set(normal(name), level);
  return (value) => {
    if (value === null || value === undefined) return 'warn';
    const text = normal(String(value));
    const mine = own.get(text);
    if (mine) return mine;
    if (typeof value === 'boolean') return value ? 'ok' : 'fail';
    return DEFAULT_LEVELS.get(text) ?? 'warn';
  };
}

export interface StatusCounts {
  fail: number;
  warn: number;
  ok: number;
  off: number;
}

export interface StatusCheck {
  level: StatusLevel;
  /** The status as the data has it ("degraded", "true"), for the panel. */
  value: string;
  label: string | null;
  kind: string | null;
  detail: string | null;
  /** Epoch ms, only from a time column. */
  since: number | null;
}

export interface StatusTile {
  /** Unique in the model (section and entity): the panel finds its tiles again by key after new data. */
  key: string;
  entity: string;
  /** The tile of rows without an entity. */
  other: boolean;
  level: StatusLevel;
  counts: StatusCounts;
  /** Fail first, then warn; within a level the oldest `since` first, then label. */
  problems: StatusCheck[];
  /** Ok checks per kind, most first; without a kind column a single entry with `kind: null`. */
  ok: { kind: string | null; count: number }[];
  off: number;
  /** Every check, worst first, for the panel. */
  checks: StatusCheck[];
}

export interface StatusSection {
  key: string;
  /** Null when the widget has no `group`: one grid without a header. */
  label: string | null;
  other: boolean;
  level: StatusLevel;
  counts: StatusCounts;
  tiles: StatusTile[];
}

export interface StatusModel {
  grouped: boolean;
  summary: boolean;
  /** The worst level of all checks; off when there are none. */
  level: StatusLevel;
  counts: StatusCounts;
  sections: StatusSection[];
  /** Checks counted, after the caps. */
  checks: number;
  truncated: boolean;
  /** Configured columns the table does not have. */
  missing: string[];
}

interface TileDraft {
  entity: string;
  other: boolean;
  checks: StatusCheck[];
}

interface SectionDraft {
  label: string | null;
  other: boolean;
  tiles: Map<string, TileDraft>;
}

const emptyCounts = (): StatusCounts => ({ fail: 0, warn: 0, ok: 0, off: 0 });
const worstOf = (c: StatusCounts): StatusLevel => (c.fail ? 'fail' : c.warn ? 'warn' : c.ok ? 'ok' : 'off');
const isProblem = (level: StatusLevel) => level === 'fail' || level === 'warn';

/** A text cell as both renderers show it: monitor output often carries terminal colour codes, which read as noise. */
function cellText(value: Scalar | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = stripAnsi(String(value)).trim();
  return text === '' ? null : text;
}

const clip = (text: string | null) =>
  text !== null && text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX - 1)}…` : text;

function compareLabels(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return collator.compare(a, b);
}

function byCheck(a: StatusCheck, b: StatusCheck): number {
  const rank = RANK[a.level] - RANK[b.level];
  if (rank) return rank;
  // The problem that has lasted longest comes first; undated ones after the dated.
  if (isProblem(a.level) && a.since !== b.since) {
    if (a.since === null) return 1;
    if (b.since === null) return -1;
    return a.since - b.since;
  }
  return compareLabels(a.label, b.label);
}

function buildTile(key: string, draft: TileDraft): StatusTile {
  const counts = emptyCounts();
  for (const check of draft.checks) counts[check.level]++;
  const checks = [...draft.checks].sort(byCheck);
  const kinds = new Map<string | null, number>();
  for (const check of checks)
    if (check.level === 'ok') kinds.set(check.kind, (kinds.get(check.kind) ?? 0) + 1);
  const ok = [...kinds]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || compareLabels(a.kind, b.kind));
  return {
    key,
    entity: draft.entity,
    other: draft.other,
    level: worstOf(counts),
    counts,
    problems: checks.filter((c) => isProblem(c.level)),
    ok,
    off: counts.off,
    checks,
  };
}

function buildSection(key: string, draft: SectionDraft): StatusSection {
  const tiles = [...draft.tiles].map(([tileKey, t]) => buildTile(tileKey, t));
  tiles.sort(
    (a, b) =>
      RANK[a.level] - RANK[b.level] ||
      Number(a.other) - Number(b.other) ||
      collator.compare(a.entity, b.entity),
  );
  const counts = emptyCounts();
  for (const t of tiles) for (const level of STATUS_LEVELS) counts[level] += t.counts[level];
  return { key, label: draft.label, other: draft.other, level: worstOf(counts), counts, tiles };
}

/** Rows (the dataset's processed table) to sections and tiles, within the caps. */
export function statusModel(table: DataTable, config: StatusConfig): StatusModel {
  const names = new Set(table.columns.map((c) => c.name));
  const configured = [
    config.entity,
    config.status,
    config.group,
    config.label,
    config.kind,
    config.detail,
    config.since,
  ];
  const missing = [...new Set(configured.filter((f): f is string => f !== undefined && !names.has(f)))];
  const levelOf = statusLevels(config.levels);
  const groupField = config.group;
  // Only a time column is a moment: a number could be seconds or a count, and text has no reliable reading.
  const sinceField = table.columns.some((c) => c.name === config.since && c.type === 'time')
    ? config.since
    : undefined;
  const sections = new Map<string, SectionDraft>();
  const counts = emptyCounts();
  let tileCount = 0;
  let checks = 0;
  let truncated = table.rows.length > STATUS_LIMITS.rows;
  const rows = truncated ? table.rows.slice(0, STATUS_LIMITS.rows) : table.rows;
  for (const row of rows) {
    const group = groupField === undefined ? null : cellText(row[groupField]);
    const sectionKey = groupField === undefined ? 'all' : group === null ? OTHER_KEY : `g:${group}`;
    const entity = cellText(row[config.entity]);
    const tileKey = `${sectionKey}\u0000${entity === null ? OTHER_KEY : `e:${entity}`}`;
    let section = sections.get(sectionKey);
    let tile = section?.tiles.get(tileKey);
    if (!tile) {
      if (tileCount >= STATUS_LIMITS.tiles || (!section && sections.size >= STATUS_LIMITS.sections)) {
        truncated = true;
        continue;
      }
      if (!section) {
        section = {
          label: groupField === undefined ? null : (group ?? OTHER),
          other: groupField !== undefined && group === null,
          tiles: new Map(),
        };
        sections.set(sectionKey, section);
      }
      tile = { entity: entity ?? OTHER, other: entity === null, checks: [] };
      section.tiles.set(tileKey, tile);
      tileCount++;
    }
    const raw = row[config.status];
    const since = sinceField === undefined ? null : row[sinceField];
    const check: StatusCheck = {
      level: levelOf(raw),
      value: raw === null || raw === undefined ? '' : String(raw),
      label: config.label === undefined ? null : cellText(row[config.label]),
      kind: config.kind === undefined ? null : cellText(row[config.kind]),
      detail: config.detail === undefined ? null : clip(cellText(row[config.detail])),
      since: typeof since === 'number' && Number.isFinite(since) ? since : null,
    };
    tile.checks.push(check);
    counts[check.level]++;
    checks++;
  }
  const built = [...sections].map(([key, draft]) => buildSection(key, draft));
  built.sort(
    (a, b) =>
      RANK[a.level] - RANK[b.level] ||
      Number(a.other) - Number(b.other) ||
      collator.compare(a.label ?? '', b.label ?? ''),
  );
  return {
    grouped: groupField !== undefined,
    summary: config.summary,
    level: worstOf(counts),
    counts,
    sections: built,
    checks,
    truncated,
    missing,
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "1 problem · 71 ok · 9 off": every count, so nothing a folded layout hides disappears silently. */
export function statusCountsText(c: StatusCounts): string {
  const problems = c.fail + c.warn;
  const parts: string[] = [];
  if (problems)
    parts.push(
      `${plural(problems, 'problem')}${c.fail && c.warn ? ` (${c.fail} fail, ${c.warn} warn)` : ''}`,
    );
  if (c.ok) parts.push(`${c.ok} ok`);
  if (c.off) parts.push(`${c.off} off`);
  return parts.length ? parts.join(' · ') : 'No checks';
}

/** The summary line, with the cap note when rows were left out. */
export function statusSummary(model: StatusModel): string {
  const text = statusCountsText(model.counts);
  return model.truncated ? `${text} · first ${model.checks} checks` : text;
}

/** "internet · 28 ok": a section header, also all that is left of a section folded to its header line. */
export function statusSectionTitle(section: StatusSection): string {
  return `${section.label ?? 'Checks'} · ${statusCountsText(section.counts)}`;
}

/** The muted line under a tile: ok checks per kind, then the off count ("container ×3 · cert · 2 off"). */
export function statusTileFoot(tile: StatusTile): string {
  const parts = tile.ok.map(({ kind, count }) =>
    kind === null ? `${count} ok` : count > 1 ? `${kind} ×${count}` : kind,
  );
  if (tile.off) parts.push(`${tile.off} off`);
  return parts.join(' · ');
}

/** "fail · cue-backup · 9 hours ago", the same words in the browser and the snapshot. */
export function statusProblemHead(check: StatusCheck, now: number): string {
  const since = check.since === null ? null : formatRelative(check.since, now);
  return [check.level, check.label, since].filter((part) => part !== null).join(' · ');
}

/** Why the widget cannot draw: a required column the data does not have. Optional ones just stay empty. */
export function statusConfigProblem(model: StatusModel, config: StatusConfig): string | null {
  if (model.checks === 0) return null;
  const gone = [config.entity, config.status].filter((f) => model.missing.includes(f)).map((f) => `"${f}"`);
  if (gone.length === 0) return null;
  return gone.length > 1
    ? `Columns ${gone.join(' and ')} are not in the data`
    : `Column ${gone[0]} is not in the data`;
}

/** The tiles with these keys in the current model, in the given order; keys no longer in the data are skipped. */
export function statusTilesByKey(model: StatusModel, keys: readonly string[]): StatusTile[] {
  const all = new Map(model.sections.flatMap((s) => s.tiles.map((t) => [t.key, t] as const)));
  return keys.flatMap((key) => {
    const found = all.get(key);
    return found ? [found] : [];
  });
}

/** Columns a status widget would take, by name. Shared by the editor's defaults and the suggestions. */
export interface StatusFields {
  entity: string;
  status: string;
  group?: string;
  label?: string;
  kind?: string;
  detail?: string;
  since?: string;
}

const NAMES = {
  entity: ['service', 'project', 'name', 'host'],
  group: ['machine', 'host', 'server', 'node'],
  label: ['name', 'check'],
  kind: ['kind', 'type'],
  detail: ['detail', 'details', 'message', 'error', 'output'],
  since: ['since', 'changed_at', 'last_change', 'status_since'],
} as const;

/**
 * Picks the other columns for a given status column by their names, or null when nothing can make the tiles. The
 * entity comes first: a "host" column is the tile when nothing names a service, and a section when something does.
 */
export function statusFields<C extends Column>(
  columns: readonly C[],
  status: string,
  accept: { entity?: (column: C) => boolean; group?: (column: C) => boolean } = {},
): StatusFields | null {
  const used = new Set([status]);
  const free = (c: C) => !used.has(c.name);
  const take = (c: C | undefined) => {
    if (c) used.add(c.name);
    return c;
  };
  const byName = (list: readonly string[], ok: (c: C) => boolean) => {
    for (const name of list) {
      const found = columns.find((c) => free(c) && c.name.toLowerCase() === name && ok(c));
      if (found) return take(found);
    }
    return undefined;
  };
  const isText = (c: C) => c.type === 'string';
  const entityOk = (c: C) => isText(c) && (accept.entity?.(c) ?? true);
  const reserved = new Set<string>([...NAMES.group, ...NAMES.kind, ...NAMES.detail]);
  const entity =
    byName(NAMES.entity, entityOk) ??
    take(columns.find((c) => free(c) && entityOk(c) && !reserved.has(c.name.toLowerCase()))) ??
    take(columns.find((c) => free(c) && entityOk(c)));
  if (!entity) return null;
  const group = byName(NAMES.group, (c) => isText(c) && (accept.group?.(c) ?? true));
  const label = byName(NAMES.label, isText);
  const kind = byName(NAMES.kind, isText);
  const detail = byName(NAMES.detail, isText);
  const since = byName(NAMES.since, (c) => c.type === 'time');
  return {
    entity: entity.name,
    status,
    ...(group ? { group: group.name } : {}),
    ...(label ? { label: label.name } : {}),
    ...(kind ? { kind: kind.name } : {}),
    ...(detail ? { detail: detail.name } : {}),
    ...(since ? { since: since.name } : {}),
  };
}

/** A complete starting config for any columns, for the editor's "Status" button and type switch. */
export function statusDefaults(columns: readonly Column[]): StatusFields {
  const status =
    columns.find((c) => c.type !== 'time' && STATUS_COLUMN_NAMES.includes(c.name.toLowerCase())) ??
    columns.find((c) => c.type === 'string') ??
    columns[0];
  const name = status?.name ?? 'status';
  return (
    statusFields(columns, name) ?? {
      entity: columns.find((c) => c.name !== name)?.name ?? 'name',
      status: name,
    }
  );
}

/* ---------- layout: what fits in a box ---------- */

/**
 * Sizes both renderers draw with, in CSS pixels. The fit estimates text from them. Snapshots draw in Inter, the
 * browser in the platform's system-ui: 6.6 px per character is above Segoe UI at 12 px (5.5 on mixed text, 6.4 on
 * semibold capitals) and Inter's mixed text (5.9), but capitals and hex in some phone fonts run wider, so the browser
 * also measures what it drew and fits once more when a line ran over (StatusBody).
 */
export const STATUS_METRICS = {
  minTileWidth: 150,
  gap: 8,
  sectionGap: 12,
  summaryHeight: 28,
  summaryLine: 20,
  summarySize: 14,
  headerHeight: 24,
  headerLine: 18,
  padX: 10,
  padY: 8,
  accent: 3,
  radius: 6,
  nameHeight: 18,
  nameSize: 13,
  lineHeight: 16,
  textSize: 12,
  problemGap: 6,
  charWidth: 6.6,
  clampLines: 2,
  moreNames: 3,
} as const;

/** A drawn cell: one tile, or a fold that counts tiles ("+6 more ok", "+2 off", "+3 more problems"). */
export type StatusItem =
  | { kind: 'tile'; tile: StatusTile; clamp: boolean }
  | { kind: 'more'; what: 'ok' | 'off' | 'problems'; level: StatusLevel; tiles: StatusTile[] };
export type StatusMore = Extract<StatusItem, { kind: 'more' }>;

export interface StatusPlaced {
  item: StatusItem;
  span: number;
  /** Relative to the widget body's top-left corner. */
  x: number;
  y: number;
  width: number;
  /** Already stretched to its grid row, as CSS grid rows stretch their items. */
  height: number;
}

export interface StatusSectionLayout {
  section: StatusSection;
  header: boolean;
  /** Folded to its header line (rule 5). */
  collapsed: boolean;
  /** Top of the header, or of the grid when there is no header. */
  y: number;
  items: StatusPlaced[];
  height: number;
}

/** Calm sections at the end, folded into one header-sized line ("+3 more sections · 12 ok"), a button like a header. */
export interface StatusMoreSections {
  sections: StatusSection[];
  /** Top of the line, relative to the widget body. */
  y: number;
}

export interface StatusLayout {
  columns: number;
  /** 0 without the summary line. */
  summaryHeight: number;
  /** The sections drawn; calm ones folded into `moreSections`, or left out, are not in it. */
  sections: StatusSectionLayout[];
  moreSections: StatusMoreSections | null;
  /** Details are cut to two lines. */
  clamped: boolean;
  /** Problem tiles counted in "+N more problems". */
  hiddenProblems: number;
  height: number;
  fits: boolean;
}

/** The browser's CSS grid derives its column count from the same minimum, so both renderers agree. */
export function statusColumns(width: number): number {
  const { minTileWidth, gap } = STATUS_METRICS;
  return Math.max(1, Math.floor((width + gap) / (minTileWidth + gap)));
}

/** The wrap width the fit assumes for a detail; the floor keeps a very narrow tile from wrapping per letter. */
export function statusDetailChars(tileWidth: number): number {
  const { padX, accent, charWidth } = STATUS_METRICS;
  return Math.max(8, Math.floor((tileWidth - 2 * padX - accent) / charWidth));
}

/**
 * Greedy word wrap at `chars` characters, as the browser wraps a detail (`white-space: pre-line` with
 * `overflow-wrap: break-word`): a newline starts a line, runs of spaces count once, and a word longer than a line
 * (a URL, a hash) is cut where the line ends.
 */
export function wrapText(text: string, chars: number): string[] {
  const width = Math.max(1, Math.floor(chars));
  const lines: string[] = [];
  // A trailing newline adds no line in `pre-line`, but a blank line between paragraphs does: dropping it would
  // underestimate the height.
  const paragraphs = text.split(/\r?\n/);
  if (paragraphs.length > 1 && !paragraphs[paragraphs.length - 1]!.trim()) paragraphs.pop();
  for (const paragraph of paragraphs) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      let rest = word;
      while (rest.length > width) {
        if (line) {
          lines.push(line);
          line = '';
        }
        lines.push(rest.slice(0, width));
        rest = rest.slice(width);
      }
      if (!rest) continue;
      if (!line) line = rest;
      else if (line.length + 1 + rest.length <= width) line += ` ${rest}`;
      else {
        lines.push(line);
        line = rest;
      }
    }
    lines.push(line);
  }
  return lines.length ? lines : [''];
}

export function statusMoreTitle(item: StatusMore): string {
  const n = item.tiles.length;
  if (item.what === 'problems') return `+${n} more problem${n === 1 ? '' : 's'}`;
  return item.what === 'ok' ? `+${n} more ok` : `+${n} off`;
}

/** "+3 more sections · 12 ok · 2 off": the folded sections' own counts, as their header lines had them. */
export function statusMoreSectionsTitle(sections: readonly StatusSection[]): string {
  const counts = emptyCounts();
  for (const s of sections) for (const level of STATUS_LEVELS) counts[level] += s.counts[level];
  const n = sections.length;
  return `+${n} more section${n === 1 ? '' : 's'} · ${statusCountsText(counts)}`;
}

/** A few of the folded names, so "+6 more ok" still says which ones. */
export function statusMoreNames(tiles: readonly StatusTile[]): string {
  const shown = tiles.slice(0, STATUS_METRICS.moreNames).map((t) => t.entity);
  return tiles.length > shown.length ? `${shown.join(', ')}, …` : shown.join(', ');
}

function tileHeight(tile: StatusTile, width: number, clamp: boolean): number {
  const M = STATUS_METRICS;
  const chars = statusDetailChars(width);
  let height = M.padY * 2 + M.nameHeight;
  for (const check of tile.problems) {
    const lines = check.detail ? wrapText(check.detail, chars).length : 0;
    height += M.problemGap + M.lineHeight * (1 + (clamp ? Math.min(lines, M.clampLines) : lines));
  }
  if (statusTileFoot(tile)) height += M.lineHeight;
  return height;
}

interface Cell {
  item: StatusItem;
  span: number;
  height: number;
}

/** Row-major placement as CSS grid's default (sparse) auto-flow does it: a cell that does not fit starts a row. */
function place(cells: Cell[], columns: number, columnWidth: number, top: number) {
  const { gap } = STATUS_METRICS;
  const items: StatusPlaced[] = [];
  let col = 0;
  let rowTop = top;
  let rowHeight = 0;
  let rowStart = 0;
  const closeRow = () => {
    for (let i = rowStart; i < items.length; i++) items[i]!.height = rowHeight;
    rowStart = items.length;
  };
  for (const cell of cells) {
    if (col > 0 && col + cell.span > columns) {
      closeRow();
      rowTop += rowHeight + gap;
      col = 0;
      rowHeight = 0;
    }
    items.push({
      item: cell.item,
      span: cell.span,
      x: col * (columnWidth + gap),
      y: rowTop,
      width: cell.span * columnWidth + (cell.span - 1) * gap,
      height: cell.height,
    });
    rowHeight = Math.max(rowHeight, cell.height);
    col += cell.span;
  }
  closeRow();
  return { items, height: items.length ? rowTop + rowHeight - top : 0 };
}

interface FitState {
  section: StatusSection;
  problems: StatusTile[];
  ok: StatusTile[];
  off: StatusTile[];
  /** Problem tiles moved into "+N more problems", last first. */
  hidden: StatusTile[];
  okFolded: boolean;
  offFolded: boolean;
  headerOnly: boolean;
  /** Problems only: the ok and off checks are left to the header's counts. */
  bare: boolean;
}

/**
 * Which tiles a box of this size shows. Folds one step at a time, each from the last section upwards, and stops as
 * soon as everything fits: off tiles, then ok tiles, then calm sections to their header line, then the ok and off
 * cells of sections with problems, then the calm header lines at the end into one "+N more sections" line (one more
 * section at a time), then that line too, then details to two lines, then problem tiles into "+N more problems"
 * (a section left without problem tiles folds away with them).
 * What is broken outranks the names of calm sections, whose counts stay in the summary line. Nothing scrolls: the
 * widget runs unattended on wall screens, so what does not fit is folded and counted, never cut off.
 */
export function statusFit(model: StatusModel, box: { width: number; height: number }): StatusLayout {
  const M = STATUS_METRICS;
  const width = Math.max(1, Math.floor(box.width));
  const columns = statusColumns(width);
  const columnWidth = (width - M.gap * (columns - 1)) / columns;
  // Wide enough for a detail to read as a sentence; on a grid of one or two columns that is the whole row.
  const wide = columns < 3 ? columns : 2;
  const spanWidth = (span: number) => span * columnWidth + (span - 1) * M.gap;
  const moreHeight = M.padY * 2 + M.nameHeight + M.lineHeight;
  const heights = new Map<StatusTile, [number, number]>();
  const heightOf = (tile: StatusTile, clamp: boolean): number => {
    let pair = heights.get(tile);
    if (!pair) {
      const w = spanWidth(tile.problems.length ? wide : 1);
      pair = [tileHeight(tile, w, false), tileHeight(tile, w, true)];
      heights.set(tile, pair);
    }
    return clamp ? pair[1] : pair[0];
  };
  const states: FitState[] = model.sections.map((section) => ({
    section,
    problems: section.tiles.filter((t) => t.problems.length > 0),
    ok: section.tiles.filter((t) => t.problems.length === 0 && t.level === 'ok'),
    off: section.tiles.filter((t) => t.level === 'off'),
    hidden: [],
    okFolded: false,
    offFolded: false,
    headerOnly: false,
    bare: false,
  }));
  const summaryHeight = model.summary ? M.summaryHeight : 0;
  let clamp = false;
  // Sections sort worst first, so the calm ones (no problem tile) are a run at the end. Counted once: a problem
  // section emptied by the last step is not calm. It folds away into "+N more problems" (see measure), not into the
  // "+N more sections" line.
  let calm = 0;
  while (calm < states.length && states[states.length - 1 - calm]!.problems.length === 0) calm++;
  /** Calm sections at the end taken out of the list: merged into one line, or, once `dropped`, left out. */
  let folded = 0;
  let dropped = false;

  const tileCell = (tile: StatusTile, span: number): Cell => ({
    item: { kind: 'tile', tile, clamp },
    span,
    height: heightOf(tile, clamp),
  });
  const moreCell = (what: StatusMore['what'], level: StatusLevel, tiles: StatusTile[]): Cell => ({
    item: { kind: 'more', what, level, tiles },
    span: 1,
    height: moreHeight,
  });

  const measure = (): StatusLayout => {
    // Taken from the end of each section; back in reading order for the panel.
    const hidden = states.flatMap((s) => [...s.hidden].reverse());
    let home = 0;
    for (let i = states.length - 1; i >= 0; i--) {
      if (states[i]!.problems.length) {
        home = i;
        break;
      }
    }
    let y = summaryHeight;
    const shown = states.slice(0, states.length - folded);
    // A problem section whose tiles are all hidden folds away, header and all: the "+N more problems" cell names its
    // tiles and the summary line counts its checks. Hiding runs last, so its ok and off cells are already gone. The
    // section that holds the cell stays, without a header when it was emptied too.
    const emptied = (s: FitState) => s.hidden.length > 0 && s.problems.length === 0;
    const drawn = shown.flatMap((s, i) => (!emptied(s) || (hidden.length && i === home) ? [{ s, i }] : []));
    const sections = drawn.map(({ s, i }, n): StatusSectionLayout => {
      if (n > 0) y += M.sectionGap;
      const top = y;
      const header = model.grouped && !emptied(s);
      if (header) y += M.headerHeight;
      const cells: Cell[] = [];
      if (!s.headerOnly) {
        for (const tile of s.problems) cells.push(tileCell(tile, wide));
        if (hidden.length && i === home) {
          cells.push(moreCell('problems', hidden.some((t) => t.level === 'fail') ? 'fail' : 'warn', hidden));
        }
        if (!s.bare) {
          if (s.okFolded) cells.push(moreCell('ok', 'ok', s.ok));
          else for (const tile of s.ok) cells.push(tileCell(tile, 1));
          if (s.offFolded) cells.push(moreCell('off', 'off', s.off));
          else for (const tile of s.off) cells.push(tileCell(tile, 1));
        }
      }
      const placed = place(cells, columns, columnWidth, y);
      y += placed.height;
      return {
        section: s.section,
        header,
        collapsed: header && placed.items.length === 0,
        y: top,
        items: placed.items,
        height: y - top,
      };
    });
    let moreSections: StatusMoreSections | null = null;
    if (folded && !dropped) {
      // One more child of the same column of sections, so the same gap as between two sections.
      if (sections.length) y += M.sectionGap;
      moreSections = { sections: states.slice(shown.length).map((s) => s.section), y };
      y += M.headerHeight;
    }
    return {
      columns,
      summaryHeight,
      sections,
      moreSections,
      clamped: clamp,
      hiddenProblems: hidden.length,
      height: y,
      fits: y <= box.height,
    };
  };

  const reversed = [...states].reverse();
  // Each step reports whether it changed anything. A single tile is never folded into a "+1" of the same size.
  const steps: (() => boolean)[] = [
    ...reversed.map((s) => () => {
      if (s.offFolded || s.off.length < 2) return false;
      s.offFolded = true;
      return true;
    }),
    ...reversed.map((s) => () => {
      if (s.okFolded || s.ok.length < 2) return false;
      s.okFolded = true;
      return true;
    }),
    ...(model.grouped
      ? reversed.map((s) => () => {
          if (s.headerOnly || s.problems.length > 0) return false;
          s.headerOnly = true;
          return true;
        })
      : []),
    ...reversed.map((s) => () => {
      if (s.bare || s.problems.length === 0 || s.ok.length + s.off.length === 0) return false;
      s.bare = true;
      return true;
    }),
    // Two header lines into one saves a line; one into "+1 more section" would save nothing.
    ...(model.grouped
      ? Array.from({ length: Math.max(0, calm - 1) }, (_, i) => () => {
          const n = i + 2;
          if (!states.slice(-n).every((s) => s.headerOnly)) return false;
          folded = n;
          return true;
        })
      : []),
    () => {
      if (!model.grouped || calm === 0 || !states.slice(-calm).every((s) => s.headerOnly)) return false;
      folded = calm;
      dropped = true;
      return true;
    },
    () => {
      if (clamp) return false;
      clamp = true;
      return true;
    },
  ];
  let layout = measure();
  for (const step of steps) {
    if (layout.fits) break;
    if (step()) layout = measure();
  }
  // Problems are hidden only for the problem tiles themselves to fit, and then until they do: a tile is counted, never
  // cut. Only a box too small for the summary line and one cell stays over.
  while (!layout.fits) {
    const from = reversed.find((s) => s.problems.length > 0);
    if (!from) break;
    from.hidden.push(from.problems.pop()!);
    layout = measure();
  }
  return layout;
}
