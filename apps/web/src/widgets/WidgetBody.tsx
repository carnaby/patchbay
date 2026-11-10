import {
  buildChartOption,
  buildGaugeOption,
  type ColorMap,
  cellLink,
  cellStyle,
  compileTableRules,
  computeGauge,
  computeKpi,
  type DatasetResult,
  DIMMED_OPACITY,
  formatNumber,
  formatRelative,
  formatValue,
  OTHER,
  type ResolvedColumn,
  type Row,
  resolveColor,
  rowSelected,
  type Scalar,
  type Selection,
  THEMES,
  tableColumns,
  type Widget,
} from '@patchbay/core';
import { AlertTriangle, ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Minus } from 'lucide-react';
import { lazy, Suspense, useMemo, useState } from 'react';
import Markdown from 'react-markdown';
import { cx, Spinner } from '../components/ui.tsx';
import { useNow, useTheme } from '../lib/hooks.ts';
import { ClockBody } from './ClockBody.tsx';
import { EChart, type EChartItem } from './EChart.tsx';
import { SearchBody } from './SearchBody.tsx';
import { StatusBody } from './StatusBody.tsx';

// Its own chunk: the base map and the map-only ECharts modules are downloaded only when a dashboard has a map.
const MapBody = lazy(() => import('./MapBody.tsx'));

/** Renders a widget's content for a dataset result. Pure presentation. */
export function WidgetBody({
  widget,
  result,
  loading,
  errorHint,
  asTable = false,
  entityColors,
  selection,
  onPick,
}: {
  widget: Widget;
  result: DatasetResult | undefined;
  loading?: boolean;
  /** What to do about the error; only passed for the dashboard's owner, viewers see the generic message alone. */
  errorHint?: string | null;
  /** Maps only: show the accessible table alternative instead of the map. */
  asTable?: boolean;
  /** The dashboard's entity colours (`doc.colors`). */
  entityColors?: ColorMap | undefined;
  /** The item the widget's cross-filter selects: the others are dimmed (proposal 0010). */
  selection?: Selection | null;
  /** A click on an item, with its value of the cross-filter column; absent when clicks set nothing. */
  onPick?: ((value: Scalar | undefined) => void) | undefined;
}) {
  if (widget.type === 'text') return <TextBody markdown={widget.config.markdown} />;
  if (widget.type === 'clock') return <ClockBody config={widget.config} />;
  if (widget.type === 'search') return <SearchBody config={widget.config} />;
  if (!result) {
    return (
      <div className="flex h-full items-center justify-center">
        {loading ? <Spinner /> : <span className="text-sm text-muted">No data</span>}
      </div>
    );
  }
  if (result.error && result.table.rows.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-sm text-bad">
        <AlertTriangle className="size-5" />
        <span className="line-clamp-3">{result.error}</span>
        {errorHint ? <span className="line-clamp-3 text-xs text-ink-2">{errorHint}</span> : null}
      </div>
    );
  }
  switch (widget.type) {
    case 'chart':
      return (
        <ChartBody
          widget={widget}
          result={result}
          entityColors={entityColors}
          selection={selection ?? null}
          onPick={onPick}
        />
      );
    case 'kpi':
      return <KpiBody widget={widget} result={result} />;
    case 'gauge':
      return <GaugeBody widget={widget} result={result} />;
    case 'table':
      return <TableBody widget={widget} result={result} selection={selection ?? null} onPick={onPick} />;
    case 'status':
      return <StatusBody widget={widget} result={result} />;
    case 'map':
      return (
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center">
              <Spinner />
            </div>
          }
        >
          <MapBody
            widget={widget}
            result={result}
            asTable={asTable}
            entityColors={entityColors}
            selection={selection ?? null}
            onPick={onPick}
          />
        </Suspense>
      );
  }
}

function ChartBody({
  widget,
  result,
  entityColors,
  selection,
  onPick,
}: {
  widget: Extract<Widget, { type: 'chart' }>;
  result: DatasetResult;
  entityColors?: ColorMap | undefined;
  selection: Selection | null;
  onPick: ((value: Scalar | undefined) => void) | undefined;
}) {
  const mode = useTheme();
  const cross = widget.config.crossFilter;
  const byX = cross !== undefined && cross.field === widget.config.x;
  // By x the line keeps its symbols, which carry the dimming too, so also while presenting (as in snapshots). By
  // series only the clicks need it: a line that takes clicks where none can land would still show a pointer.
  const clickable = byX ? 'x' : cross && onPick ? 'series' : undefined;
  const option = useMemo(
    () =>
      buildChartOption(widget.config, result.table, THEMES[mode], {
        entityColors,
        selection,
        ...(clickable ? { clickable } : {}),
      }),
    [widget.config, result.table, mode, entityColors, selection, clickable],
  );
  // A category (or slice) gives the x column's value, a series its own name.
  const onItemClick =
    onPick && cross
      ? (item: EChartItem) => {
          const label = byX ? item.name : item.seriesName;
          // Nothing under the pointer names a category (a line between its symbols): not a click on an item.
          if (byX && label === undefined) return;
          // "Other" (the folded tail) and "(empty)" are what the chart draws for no single value, unless the data holds
          // that text: they set nothing, rather than a search for the word.
          const placeholder =
            (label === OTHER || label === '(empty)') &&
            !result.table.rows.some((r) => r[cross.field] != null && String(r[cross.field]) === label);
          onPick(placeholder ? undefined : label);
        }
      : undefined;
  return <EChart option={option} label={widget.title ?? 'Chart'} onItemClick={onItemClick} />;
}

function GaugeBody({
  widget,
  result,
}: {
  widget: Extract<Widget, { type: 'gauge' }>;
  result: DatasetResult;
}) {
  const mode = useTheme();
  const option = useMemo(
    () => buildGaugeOption(widget.config, computeGauge(widget.config, result.table), THEMES[mode]),
    [widget.config, result.table, mode],
  );
  return <EChart option={option} label={widget.title ?? 'Gauge'} />;
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const points = values
    .map((v, i) => `${(i / (values.length - 1)) * 100},${30 - ((v - min) / (max - min || 1)) * 28 - 1}`)
    .join(' ');
  return (
    <svg
      viewBox="0 0 100 30"
      preserveAspectRatio="none"
      className="h-full w-full overflow-visible"
      aria-hidden="true"
    >
      <polyline
        points={points}
        fill="none"
        stroke="var(--pb-data)"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function KpiBody({ widget, result }: { widget: Extract<Widget, { type: 'kpi' }>; result: DatasetResult }) {
  const mode = useTheme();
  const kpi = computeKpi(widget.config, result.table);
  const Icon = kpi.delta === null ? null : kpi.delta > 0 ? ArrowUp : kpi.delta < 0 ? ArrowDown : Minus;
  return (
    <div className="flex h-full flex-col">
      <div
        className="text-[clamp(1.5rem,3.2vw,2.4rem)] leading-tight font-semibold tracking-tight"
        style={kpi.valueColor ? { color: resolveColor(kpi.valueColor, THEMES[mode], 'text') } : undefined}
      >
        {formatNumber(kpi.value, widget.config.format)}
      </div>
      {kpi.delta !== null && Icon ? (
        <div
          className={cx(
            'mt-1 flex items-center gap-1 text-[13px] font-medium',
            kpi.trend === 'good' ? 'text-good' : kpi.trend === 'bad' ? 'text-bad' : 'text-muted',
          )}
        >
          <Icon className="size-3.5" aria-hidden="true" />
          <span>{formatNumber(Math.abs(kpi.delta), widget.config.format)}</span>
          {kpi.deltaPct !== null ? (
            <span className="text-muted">
              ({kpi.deltaPct > 0 ? '+' : ''}
              {kpi.deltaPct.toFixed(1)}%)
            </span>
          ) : null}
          <span className="sr-only">
            {kpi.trend === 'good'
              ? 'improving'
              : kpi.trend === 'bad'
                ? 'worsening'
                : kpi.trend === 'neutral'
                  ? kpi.delta > 0
                    ? 'increased'
                    : 'decreased'
                  : 'unchanged'}
          </span>
        </div>
      ) : null}
      {kpi.spark.length > 1 ? (
        <div className="mt-auto h-[38%] min-h-6 pt-2">
          <Sparkline values={kpi.spark} />
        </div>
      ) : null}
    </div>
  );
}

const URL_RE = /^https?:\/\//;

export function TableBody({
  widget,
  result,
  selection,
  onPick,
}: {
  widget: Extract<Widget, { type: 'table' }>;
  result: DatasetResult;
  selection?: Selection | null;
  onPick?: ((value: Scalar | undefined) => void) | undefined;
}) {
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<{ field: string; dir: 1 | -1 } | null>(null);
  const mode = useTheme();
  const table = result.table;
  const columns = useMemo(() => tableColumns(widget.config, table), [widget.config, table]);
  // Compiled once per result and config, not per cell.
  const rules = useMemo(() => compileTableRules(widget.config, table), [widget.config, table]);
  const rows = useMemo(() => {
    if (!sort) return table.rows;
    return [...table.rows].sort((a, b) => {
      const x = a[sort.field] ?? null;
      const y = b[sort.field] ?? null;
      if (x === y) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return (
        (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) *
        sort.dir
      );
    });
  }, [table.rows, sort]);
  const size = widget.config.pageSize;
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(page, pages - 1);
  const visible = rows.slice(current * size, current * size + size);
  const list = widget.config.style === 'list';
  const cross = widget.config.crossFilter;
  const pick = onPick && cross ? (row: Row) => onPick(row[cross.field]) : undefined;
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        {list ? (
          <ListRows
            rows={visible}
            columns={columns}
            rules={rules}
            mode={mode}
            selection={selection ?? null}
            pick={pick}
          />
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead className="sticky top-0 bg-surface">
              <tr>
                {columns.map((c, ci) => (
                  <th
                    // biome-ignore lint/suspicious/noArrayIndexKey: a field may be shown twice, the position is its identity
                    key={`${ci}:${c.field}`}
                    className="border-b border-line px-2 py-1.5 font-medium whitespace-nowrap text-muted"
                  >
                    <button
                      type="button"
                      className="hover:text-ink"
                      // The field name stays findable when a label replaces it.
                      title={c.label !== c.field ? c.field : undefined}
                      onClick={() =>
                        setSort((s) =>
                          s?.field === c.field
                            ? { field: c.field, dir: s.dir === 1 ? -1 : 1 }
                            : { field: c.field, dir: 1 },
                        )
                      }
                    >
                      {c.label}
                      {sort?.field === c.field ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((row, i) => (
                <tr
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity
                  key={i}
                  className={cx(
                    'border-b border-line/60 last:border-0 hover:bg-surface-2/60',
                    pick && 'cursor-pointer',
                  )}
                  style={
                    rowSelected(row, selection ?? null) === false ? { opacity: DIMMED_OPACITY } : undefined
                  }
                  onClick={pick ? () => pick(row) : undefined}
                >
                  {columns.map((c, ci) => {
                    const v = row[c.field] ?? null;
                    const cell = cellStyle(row, c, rules, THEMES[mode]);
                    const text = cell.text;
                    return (
                      <td
                        // biome-ignore lint/suspicious/noArrayIndexKey: a field may be shown twice, the position is its identity
                        key={`${ci}:${c.field}`}
                        className={cx(
                          'max-w-72 truncate px-2 py-1.5',
                          c.type === 'number' && 'tabular text-right',
                        )}
                        style={
                          cell.color || cell.background
                            ? { color: cell.color, backgroundColor: cell.background }
                            : undefined
                        }
                        title={cell.reason}
                      >
                        {cellLink(row, c) ? (
                          <a
                            href={cellLink(row, c)!}
                            target="_blank"
                            rel="noopener noreferrer nofollow"
                            className="hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {text}
                          </a>
                        ) : typeof v === 'string' && URL_RE.test(v) ? (
                          <a
                            href={v}
                            target="_blank"
                            rel="noopener noreferrer nofollow"
                            className="text-data hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {v.replace(URL_RE, '').slice(0, 40)}
                          </a>
                        ) : (
                          text
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {pages > 1 ? (
        <div className="flex shrink-0 items-center justify-end gap-2 pt-2 text-xs text-muted">
          <span className="tabular">
            {current * size + 1}-{Math.min(rows.length, (current + 1) * size)} of {rows.length}
          </span>
          <button
            type="button"
            aria-label="Previous page"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
            className="rounded p-0.5 hover:bg-surface-2 disabled:opacity-30"
          >
            <ChevronLeft className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Next page"
            disabled={current >= pages - 1}
            onClick={() => setPage(current + 1)}
            className="rounded p-0.5 hover:bg-surface-2 disabled:opacity-30"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A table as headlines: the first column as the (linked) title, the others on a muted line under it. Times read as
 * "12 min ago", with the exact time as the tooltip, and refresh every minute.
 */
function ListRows({
  rows,
  columns,
  rules,
  mode,
  selection,
  pick,
}: {
  rows: DatasetResult['table']['rows'];
  columns: ResolvedColumn[];
  rules: ReturnType<typeof compileTableRules>;
  mode: 'light' | 'dark';
  selection: Selection | null;
  pick: ((row: Row) => void) | undefined;
}) {
  const now = useNow(60_000);
  const locale = typeof navigator === 'undefined' ? 'en' : navigator.language;
  const [first, ...rest] = columns;
  if (!first) return null;
  return (
    <ul className="divide-y divide-line/60">
      {rows.map((row, i) => {
        const title = cellStyle(row, first, rules, THEMES[mode]);
        const href = cellLink(row, first);
        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: the filter bar sets the same filter from the keyboard
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity
            key={i}
            className={cx('py-2 first:pt-0.5', pick && 'cursor-pointer')}
            style={rowSelected(row, selection) === false ? { opacity: DIMMED_OPACITY } : undefined}
            onClick={pick ? () => pick(row) : undefined}
          >
            <div
              className="line-clamp-2 text-[13.5px] leading-snug font-medium text-ink"
              style={title.color ? { color: title.color } : undefined}
              title={title.reason}
            >
              {href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  {title.text}
                </a>
              ) : (
                title.text
              )}
            </div>
            {rest.length ? (
              <div className="mt-0.5 truncate text-xs text-muted">
                {rest.map((c, ci) => {
                  const v = row[c.field] ?? null;
                  if (v === null || v === '') return null;
                  const relative = c.type === 'time' && typeof v === 'number';
                  const cell = cellStyle(row, c, rules, THEMES[mode]);
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: a field may be shown twice
                    <span key={ci} title={relative ? formatValue(v, 'time') : cell.reason}>
                      {ci > 0 ? ' · ' : ''}
                      <span style={cell.color ? { color: cell.color } : undefined}>
                        {relative ? formatRelative(v, now, locale) : cell.text}
                      </span>
                    </span>
                  );
                })}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function TextBody({ markdown }: { markdown: string }) {
  return (
    <div className="prose-sm h-full overflow-auto text-sm leading-relaxed text-ink-2 [&_a]:text-data [&_a]:underline [&_code]:rounded [&_code]:bg-surface-2 [&_code]:px-1 [&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:text-ink [&_h2]:mb-1.5 [&_h2]:font-semibold [&_h2]:text-ink [&_li]:ml-4 [&_li]:list-disc [&_p]:mb-2 [&_strong]:text-ink">
      <Markdown
        // No raw HTML is rendered; links open safely in a new tab.
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow">
              {children}
            </a>
          ),
        }}
      >
        {markdown}
      </Markdown>
    </div>
  );
}
