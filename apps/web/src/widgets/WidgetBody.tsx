import {
  buildChartOption,
  buildGaugeOption,
  type ColorMap,
  cellStyle,
  compileTableRules,
  computeGauge,
  computeKpi,
  type DatasetResult,
  formatNumber,
  resolveColor,
  THEMES,
  tableColumns,
  type Widget,
} from '@patchbay/core';
import { AlertTriangle, ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Minus } from 'lucide-react';
import { useMemo, useState } from 'react';
import Markdown from 'react-markdown';
import { cx, Spinner } from '../components/ui.tsx';
import { useTheme } from '../lib/hooks.ts';
import { EChart } from './EChart.tsx';

/** Renders a widget's content for a dataset result. Pure presentation. */
export function WidgetBody({
  widget,
  result,
  loading,
  errorHint,
  entityColors,
}: {
  widget: Widget;
  result: DatasetResult | undefined;
  loading?: boolean;
  /** What to do about the error; only passed for the dashboard's owner, viewers see the generic message alone. */
  errorHint?: string | null;
  /** The dashboard's entity colours (`doc.colors`). */
  entityColors?: ColorMap | undefined;
}) {
  if (widget.type === 'text') return <TextBody markdown={widget.config.markdown} />;
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
      return <ChartBody widget={widget} result={result} entityColors={entityColors} />;
    case 'kpi':
      return <KpiBody widget={widget} result={result} />;
    case 'gauge':
      return <GaugeBody widget={widget} result={result} />;
    case 'table':
      return <TableBody widget={widget} result={result} />;
  }
}

function ChartBody({
  widget,
  result,
  entityColors,
}: {
  widget: Extract<Widget, { type: 'chart' }>;
  result: DatasetResult;
  entityColors?: ColorMap | undefined;
}) {
  const mode = useTheme();
  const option = useMemo(
    () => buildChartOption(widget.config, result.table, THEMES[mode], { entityColors }),
    [widget.config, result.table, mode, entityColors],
  );
  return <EChart option={option} label={widget.title ?? 'Chart'} />;
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

function TableBody({
  widget,
  result,
}: {
  widget: Extract<Widget, { type: 'table' }>;
  result: DatasetResult;
}) {
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<{ field: string; dir: 1 | -1 } | null>(null);
  const mode = useTheme();
  const table = result.table;
  const columns = useMemo(() => tableColumns(widget.config, table), [widget.config, table]);
  // Compiled once per result and config, not per cell.
  const rules = useMemo(() => compileTableRules(widget.config), [widget.config]);
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
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
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
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity
              <tr key={i} className="border-b border-line/60 last:border-0 hover:bg-surface-2/60">
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
                      {typeof v === 'string' && URL_RE.test(v) ? (
                        <a
                          href={v}
                          target="_blank"
                          rel="noopener noreferrer nofollow"
                          className="text-data hover:underline"
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
