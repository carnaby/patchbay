import {
  CHART_KINDS,
  type ChartKind,
  type Column,
  type Format,
  KPI_AGGS,
  type Suggestion,
  type TableProfile,
  type Widget,
  type WidgetInput,
  type WidgetType,
} from '@patchbay/core';
import { useQuery } from '@tanstack/react-query';
import {
  AreaChart,
  BarChart3,
  CircleDot,
  Filter,
  Gauge,
  Grid3x3,
  Hash,
  LineChart,
  PieChart,
  Radar,
  Sparkles,
  Table2,
  Type,
} from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import {
  Button,
  Card,
  cx,
  Drawer,
  Field,
  Input,
  Segmented,
  Select,
  Spinner,
  Textarea,
  Toggle,
  toast,
} from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { useEditor } from '../state/editor.ts';
import { useDatasetResult } from '../state/sync.ts';

const TYPE_OPTIONS: { value: WidgetType; label: string; icon: ReactNode }[] = [
  { value: 'chart', label: 'Chart', icon: <LineChart className="size-3.5" /> },
  { value: 'kpi', label: 'KPI', icon: <Hash className="size-3.5" /> },
  { value: 'gauge', label: 'Gauge', icon: <Gauge className="size-3.5" /> },
  { value: 'table', label: 'Table', icon: <Table2 className="size-3.5" /> },
  { value: 'text', label: 'Text', icon: <Type className="size-3.5" /> },
];

const KIND_ICONS: Record<ChartKind, ReactNode> = {
  line: <LineChart className="size-4" />,
  area: <AreaChart className="size-4" />,
  bar: <BarChart3 className="size-4" />,
  pie: <PieChart className="size-4" />,
  donut: <CircleDot className="size-4" />,
  scatter: <Grid3x3 className="size-4" />,
  heatmap: <Grid3x3 className="size-4" />,
  funnel: <Filter className="size-4" />,
  radar: <Radar className="size-4" />,
};

function slug(text: string, taken: Set<string>) {
  const base =
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30) || 'widget';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** Sensible config for a widget type given the dataset's columns. */
export function defaultsFor(type: WidgetType, columns: Column[], previous?: Widget): WidgetInput['config'] {
  const numeric = columns.filter((c) => c.type === 'number');
  const time = columns.find((c) => c.type === 'time');
  const category = columns.find((c) => c.type === 'string');
  const prevY =
    previous?.type === 'chart'
      ? previous.config.y[0]
      : previous && 'field' in previous.config
        ? previous.config.field
        : undefined;
  const measure = prevY ?? numeric[0]?.name ?? columns[0]?.name ?? 'value';
  switch (type) {
    case 'chart':
      return { kind: time ? 'line' : 'bar', x: (time ?? category ?? columns[0])?.name ?? 'x', y: [measure] };
    case 'kpi':
      return { field: measure, agg: 'last', compare: time ? 'previous' : 'none', sparkline: Boolean(time) };
    case 'gauge':
      return { field: measure, min: 0, max: 100 };
    case 'table':
      return { pageSize: 25 };
    case 'text':
      return { markdown: 'Write **markdown** here.' };
  }
}

export function WidgetEditor({
  widgetId,
  onClose,
  onCreated,
}: {
  widgetId: string | null;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const widget = useEditor((s) => s.doc?.widgets.find((w) => w.id === widgetId));
  const open = widgetId !== null;
  return (
    <Drawer
      open={open && (widgetId === '__new__' || Boolean(widget))}
      title={widgetId === '__new__' ? 'Add a widget' : 'Edit widget'}
      onClose={onClose}
    >
      {widgetId === '__new__' ? (
        <NewWidget onCreated={onCreated} />
      ) : widget ? (
        <EditWidget key={widget.id} widget={widget} />
      ) : null}
    </Drawer>
  );
}

function useColumns(datasetId: string | undefined) {
  const id = useEditor((s) => s.id)!;
  const dataset = useEditor((s) => s.doc?.datasets.find((d) => d.id === datasetId));
  const q = useDatasetResult(id, dataset, true);
  return { columns: q.data?.table.columns ?? [], loading: q.isLoading, rows: q.data?.table.rows.length ?? 0 };
}

function NewWidget({ onCreated }: { onCreated: (id: string) => void }) {
  const dashboardId = useEditor((s) => s.id)!;
  const datasets = useEditor((s) => s.doc!.datasets);
  const apply = useEditor((s) => s.apply);
  const [datasetId, setDatasetId] = useState(datasets[0]?.id ?? '');
  const { columns } = useColumns(datasetId);
  const suggestions = useQuery({
    queryKey: ['suggest', dashboardId, datasetId, JSON.stringify(datasets.find((d) => d.id === datasetId))],
    queryFn: () =>
      api<{ profile: TableProfile; suggestions: Suggestion[] }>(
        `/api/dashboards/${dashboardId}/suggest/${datasetId}`,
        { dashboardId },
      ),
    enabled: Boolean(datasetId),
  });

  const create = (widget: Omit<WidgetInput, 'id'>, transforms: Suggestion['transforms'] = []) => {
    const doc = useEditor.getState().doc!;
    const taken = new Set(doc.widgets.map((w) => w.id));
    const id = slug(widget.title ?? widget.type, taken);
    const ops = [];
    let targetDataset = datasetId;
    if (transforms.length) {
      const source = doc.datasets.find((d) => d.id === datasetId)!;
      const dsTaken = new Set(doc.datasets.map((d) => d.id));
      targetDataset = slug(`${source.id}-${widget.title ?? 'view'}`, dsTaken).slice(0, 40);
      ops.push({
        op: 'addDataset' as const,
        dataset: {
          ...source,
          id: targetDataset,
          name: `${source.name}: ${widget.title ?? 'view'}`.slice(0, 120),
          transforms: [...source.transforms, ...transforms],
        },
      });
    }
    ops.push({
      op: 'addWidget' as const,
      widget: {
        ...widget,
        id,
        ...(widget.type === 'text' ? {} : { datasetId: targetDataset }),
      } as WidgetInput,
    });
    const err = apply(ops, `Added "${widget.title ?? widget.type}"`);
    if (err) toast(err, 'bad');
    else onCreated(id);
  };

  return (
    <div className="space-y-6">
      <Field label="Dataset">
        {(fid) => (
          <Select id={fid} value={datasetId} onChange={(e) => setDatasetId(e.target.value)}>
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <section className="space-y-2">
        <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-ink-2">
          <Sparkles className="size-3.5 text-accent" /> Suggested for this data
        </h3>
        {suggestions.isLoading ? (
          <Spinner />
        ) : suggestions.data?.suggestions.length ? (
          <div className="grid gap-2">
            {suggestions.data.suggestions.map((s) => (
              <button
                key={s.title}
                type="button"
                onClick={() => create(s.widget as Omit<WidgetInput, 'id'>, s.transforms)}
                className="rounded-xl border border-line bg-surface p-3 text-left transition hover:border-ink-2"
              >
                <div className="flex items-center gap-2 text-sm font-medium">
                  {s.widget.type === 'chart'
                    ? KIND_ICONS[(s.widget.config as { kind: ChartKind }).kind]
                    : TYPE_OPTIONS.find((t) => t.value === s.widget.type)?.icon}
                  {s.title}
                </div>
                <p className="mt-1 text-xs text-muted">{s.rationale}</p>
              </button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted">No suggestions (the dataset may be empty or still loading).</p>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-[13px] font-semibold text-ink-2">Or start from a blank widget</h3>
        <div className="grid grid-cols-5 gap-2">
          {TYPE_OPTIONS.map((t) => (
            <button
              key={t.value}
              type="button"
              disabled={t.value !== 'text' && columns.length === 0}
              onClick={() =>
                create({ type: t.value, title: t.label, config: defaultsFor(t.value, columns) } as Omit<
                  WidgetInput,
                  'id'
                >)
              }
              className="flex flex-col items-center gap-1.5 rounded-xl border border-line bg-surface py-3 text-xs font-medium text-ink-2 transition hover:border-ink-2 hover:text-ink disabled:opacity-40"
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function EditWidget({ widget }: { widget: Widget }) {
  const apply = useEditor((s) => s.apply);
  const datasets = useEditor((s) => s.doc!.datasets);
  const datasetId = 'datasetId' in widget ? widget.datasetId : undefined;
  const { columns, loading } = useColumns(datasetId);

  const update = (set: Record<string, unknown>, label: string, coalesce?: string) => {
    const err = apply(
      [{ op: 'updateWidget', id: widget.id, set }],
      label,
      coalesce ? { coalesce: `${widget.id}:${coalesce}` } : undefined,
    );
    if (err) toast(err, 'bad');
  };
  const setConfig = (patch: Record<string, unknown>, label = 'Changed widget settings', coalesce?: string) =>
    update({ config: patch }, label, coalesce);

  const changeType = (type: WidgetType) => {
    if (type === widget.type) return;
    const next = {
      id: widget.id,
      type,
      title: widget.title,
      ...(type === 'text' ? {} : { datasetId: datasetId ?? datasets[0]?.id }),
      config: defaultsFor(type, columns, widget),
    } as WidgetInput;
    const err = apply([{ op: 'replaceWidget', widget: next }], `Changed widget to ${type}`);
    if (err) toast(err, 'bad');
  };

  return (
    <div className="space-y-5">
      <Field label="Title">
        {(fid) => (
          <Input
            id={fid}
            value={widget.title ?? ''}
            maxLength={120}
            onChange={(e) => update({ title: e.target.value }, 'Renamed widget', 'title')}
          />
        )}
      </Field>
      <div className="space-y-1.5">
        <div className="text-[13px] font-medium text-ink-2">Type</div>
        <Segmented
          value={widget.type}
          onChange={changeType}
          options={TYPE_OPTIONS.map((t) => ({
            value: t.value,
            label: (
              <>
                {t.icon}
                {t.label}
              </>
            ),
          }))}
        />
      </div>
      {widget.type !== 'text' ? (
        <Field label="Dataset" hint={loading ? 'Loading columns…' : `${columns.length} columns`}>
          {(fid) => (
            <Select
              id={fid}
              value={datasetId}
              onChange={(e) => update({ datasetId: e.target.value }, 'Changed dataset')}
            >
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}

      <Card className="space-y-4 p-4">
        {widget.type === 'chart' ? (
          <ChartFields widget={widget} columns={columns} setConfig={setConfig} />
        ) : null}
        {widget.type === 'kpi' || widget.type === 'gauge' ? (
          <ValueFields widget={widget} columns={columns} setConfig={setConfig} />
        ) : null}
        {widget.type === 'table' ? (
          <TableFields widget={widget} columns={columns} setConfig={setConfig} />
        ) : null}
        {widget.type === 'text' ? (
          <Field label="Markdown" hint="Headings, lists, links and emphasis. Raw HTML is not rendered.">
            {(fid) => (
              <Textarea
                id={fid}
                rows={10}
                value={widget.config.markdown}
                onChange={(e) => setConfig({ markdown: e.target.value }, 'Edited text', 'markdown')}
              />
            )}
          </Field>
        ) : null}
      </Card>

      {widget.type !== 'text' ? (
        <FormatFields
          format={'format' in widget.config ? widget.config.format : undefined}
          setConfig={setConfig}
        />
      ) : null}

      <Field label="Description" hint="Shown as a tooltip on the title.">
        {(fid) => (
          <Input
            id={fid}
            value={widget.description ?? ''}
            maxLength={500}
            onChange={(e) => update({ description: e.target.value }, 'Edited description', 'description')}
          />
        )}
      </Field>
      <p className="text-xs text-muted">Changes apply instantly and can be undone with Ctrl+Z.</p>
    </div>
  );
}

type SetConfig = (patch: Record<string, unknown>, label?: string, coalesce?: string) => void;

function ColumnSelect({
  label,
  value,
  columns,
  onChange,
  optional,
  filter,
}: {
  label: string;
  value: string | undefined;
  columns: Column[];
  onChange: (v: string | undefined) => void;
  optional?: boolean;
  filter?: (c: Column) => boolean;
}) {
  const options = filter ? columns.filter(filter) : columns;
  const known = value === undefined || options.some((c) => c.name === value);
  return (
    <Field label={label} error={known ? null : `Column "${value}" is not in the data`}>
      {(fid) => (
        <Select id={fid} value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
          {optional ? <option value="">None</option> : null}
          {!known && value ? <option value={value}>{value} (missing)</option> : null}
          {options.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name} · {c.type}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

function ChartFields({
  widget,
  columns,
  setConfig,
}: {
  widget: Extract<Widget, { type: 'chart' }>;
  columns: Column[];
  setConfig: SetConfig;
}) {
  const c = widget.config;
  const numeric = columns.filter((col) => col.type === 'number');
  const proportion = c.kind === 'pie' || c.kind === 'donut' || c.kind === 'funnel';
  return (
    <>
      <div className="space-y-1.5">
        <div className="text-[13px] font-medium text-ink-2">Chart</div>
        <div className="grid grid-cols-5 gap-1.5">
          {CHART_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setConfig({ kind: k }, `Changed chart to ${k}`)}
              className={cx(
                'flex flex-col items-center gap-1 rounded-lg border py-2 text-[11px] capitalize transition',
                c.kind === k
                  ? 'border-ink bg-surface-2 text-ink'
                  : 'border-line text-ink-2 hover:border-ink-2',
              )}
            >
              {KIND_ICONS[k]}
              {k}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <ColumnSelect
          label={proportion ? 'Label' : 'X axis'}
          value={c.x}
          columns={columns}
          onChange={(v) => v && setConfig({ x: v }, 'Changed X axis')}
        />
        <ColumnSelect
          label={c.kind === 'heatmap' ? 'Rows (Y category)' : 'Split into series by'}
          value={c.series}
          columns={columns}
          optional
          filter={(col) => col.type === 'string' || col.type === 'boolean'}
          onChange={(v) => setConfig({ series: v }, 'Changed series split')}
        />
      </div>
      <div className="space-y-1.5">
        <div className="text-[13px] font-medium text-ink-2">
          {proportion || c.series ? 'Value' : 'Values'}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {numeric.map((col) => {
            const on = c.y.includes(col.name);
            return (
              <button
                key={col.name}
                type="button"
                onClick={() => {
                  const single = proportion || Boolean(c.series);
                  const next = single
                    ? [col.name]
                    : on
                      ? c.y.filter((y) => y !== col.name)
                      : [...c.y, col.name];
                  if (next.length) setConfig({ y: next }, 'Changed values');
                }}
                className={cx(
                  'rounded-md border px-2 py-1 text-xs transition',
                  on ? 'border-ink bg-ink text-page' : 'border-line text-ink-2 hover:border-ink-2',
                )}
              >
                {col.name}
              </button>
            );
          })}
          {numeric.length === 0 ? <span className="text-xs text-muted">No numeric columns.</span> : null}
        </div>
        {!proportion && !c.series && c.y.length > 1 ? (
          <p className="text-xs text-muted">
            Only combine values that share a unit and scale. Otherwise use two charts.
          </p>
        ) : null}
      </div>
      <div className="grid gap-2.5 sm:grid-cols-2">
        {c.kind === 'bar' ? (
          <Toggle label="Horizontal" checked={c.horizontal} onChange={(v) => setConfig({ horizontal: v })} />
        ) : null}
        {['bar', 'area', 'line'].includes(c.kind) ? (
          <Toggle label="Stacked" checked={c.stacked} onChange={(v) => setConfig({ stacked: v })} />
        ) : null}
        {['line', 'area'].includes(c.kind) ? (
          <Toggle label="Smooth" checked={c.smooth} onChange={(v) => setConfig({ smooth: v })} />
        ) : null}
        <Toggle label="Value labels" checked={c.showLabels} onChange={(v) => setConfig({ showLabels: v })} />
        {!proportion ? (
          <Toggle label="Log scale" checked={c.logScale} onChange={(v) => setConfig({ logScale: v })} />
        ) : null}
        <Toggle
          label="Legend"
          checked={c.showLegend ?? (c.y.length > 1 || Boolean(c.series))}
          onChange={(v) => setConfig({ showLegend: v })}
        />
      </div>
      {!proportion ? (
        <div className="grid grid-cols-2 gap-3">
          <NumberField
            label="Y min"
            value={c.yMin}
            onChange={(v) => setConfig({ yMin: v }, 'Changed axis', 'ymin')}
          />
          <NumberField
            label="Y max"
            value={c.yMax}
            onChange={(v) => setConfig({ yMax: v }, 'Changed axis', 'ymax')}
          />
        </div>
      ) : null}
    </>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
}) {
  return (
    <Field label={label}>
      {(fid) => (
        <Input
          id={fid}
          type="number"
          value={value ?? ''}
          placeholder="auto"
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        />
      )}
    </Field>
  );
}

function ValueFields({
  widget,
  columns,
  setConfig,
}: {
  widget: Extract<Widget, { type: 'kpi' | 'gauge' }>;
  columns: Column[];
  setConfig: SetConfig;
}) {
  const c = widget.config;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <ColumnSelect
          label="Value column"
          value={c.field}
          columns={columns}
          onChange={(v) => v && setConfig({ field: v }, 'Changed value column')}
        />
        <Field label="Aggregate">
          {(fid) => (
            <Select
              id={fid}
              value={c.agg}
              onChange={(e) => setConfig({ agg: e.target.value }, 'Changed aggregation')}
            >
              {KPI_AGGS.map((a) => (
                <option key={a} value={a}>
                  {a === 'last' ? 'Latest value' : a === 'first' ? 'First value' : a}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      {widget.type === 'kpi' ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Compare with">
              {(fid) => (
                <Select
                  id={fid}
                  value={widget.config.compare}
                  onChange={(e) => setConfig({ compare: e.target.value }, 'Changed comparison')}
                >
                  <option value="none">Nothing</option>
                  <option value="previous">Previous row</option>
                  <option value="first">First row</option>
                </Select>
              )}
            </Field>
            <Field label="Good when">
              {(fid) => (
                <Select
                  id={fid}
                  value={widget.config.goodWhen}
                  onChange={(e) => setConfig({ goodWhen: e.target.value }, 'Changed direction')}
                >
                  <option value="up">Going up</option>
                  <option value="down">Going down</option>
                </Select>
              )}
            </Field>
          </div>
          <Toggle
            label="Sparkline"
            checked={widget.config.sparkline}
            onChange={(v) => setConfig({ sparkline: v })}
          />
        </>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <NumberField
            label="Min"
            value={widget.config.min}
            onChange={(v) => setConfig({ min: v ?? 0 }, 'Changed range', 'min')}
          />
          <NumberField
            label="Max"
            value={widget.config.max}
            onChange={(v) => setConfig({ max: v ?? 100 }, 'Changed range', 'max')}
          />
        </div>
      )}
    </>
  );
}

function TableFields({
  widget,
  columns,
  setConfig,
}: {
  widget: Extract<Widget, { type: 'table' }>;
  columns: Column[];
  setConfig: SetConfig;
}) {
  const selected = widget.config.columns;
  const shown = useMemo(() => new Set(selected ?? columns.map((c) => c.name)), [selected, columns]);
  return (
    <>
      <div className="space-y-1.5">
        <div className="text-[13px] font-medium text-ink-2">Columns</div>
        <div className="flex flex-wrap gap-1.5">
          {columns.map((col) => {
            const on = shown.has(col.name);
            return (
              <button
                key={col.name}
                type="button"
                onClick={() => {
                  const next = on ? [...shown].filter((n) => n !== col.name) : [...shown, col.name];
                  setConfig(
                    { columns: next.length === columns.length ? undefined : next },
                    'Changed table columns',
                  );
                }}
                className={cx(
                  'rounded-md border px-2 py-1 text-xs transition',
                  on ? 'border-ink bg-ink text-page' : 'border-line text-ink-2 hover:border-ink-2',
                )}
              >
                {col.name}
              </button>
            );
          })}
        </div>
      </div>
      <Field label="Rows per page">
        {(fid) => (
          <Select
            id={fid}
            value={widget.config.pageSize}
            onChange={(e) => setConfig({ pageSize: Number(e.target.value) }, 'Changed page size')}
          >
            {[10, 25, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        )}
      </Field>
    </>
  );
}

function FormatFields({ format, setConfig }: { format: Format | undefined; setConfig: SetConfig }) {
  const f = format ?? { style: 'number' as const };
  const set = (patch: Partial<Format>, coalesce?: string) =>
    setConfig({ format: { ...f, ...patch } }, 'Changed number format', coalesce);
  return (
    <details className="group rounded-xl border border-line bg-surface p-4" open={Boolean(format)}>
      <summary className="cursor-pointer text-[13px] font-medium text-ink-2">Number format</summary>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="Style">
          {(fid) => (
            <Select
              id={fid}
              value={f.style}
              onChange={(e) => set({ style: e.target.value as Format['style'] })}
            >
              <option value="number">Number</option>
              <option value="compact">Compact (1.2K)</option>
              <option value="percent">Percent</option>
              <option value="currency">Currency</option>
            </Select>
          )}
        </Field>
        <Field label="Decimals">
          {(fid) => (
            <Input
              id={fid}
              type="number"
              min={0}
              max={8}
              placeholder="auto"
              value={f.decimals ?? ''}
              onChange={(e) => {
                const { decimals: _d, ...rest } = f;
                setConfig(
                  {
                    format:
                      e.target.value === ''
                        ? rest
                        : { ...f, decimals: Math.min(8, Math.max(0, Number(e.target.value))) },
                  },
                  'Changed number format',
                  'decimals',
                );
              }}
            />
          )}
        </Field>
        {f.style === 'currency' ? (
          <Field label="Currency">
            {(fid) => (
              <Input
                id={fid}
                maxLength={3}
                value={f.currency ?? 'USD'}
                onChange={(e) =>
                  e.target.value.length === 3 && set({ currency: e.target.value.toUpperCase() }, 'currency')
                }
              />
            )}
          </Field>
        ) : null}
        <Field label="Prefix">
          {(fid) => (
            <Input
              id={fid}
              maxLength={12}
              value={f.prefix ?? ''}
              onChange={(e) => set({ prefix: e.target.value }, 'prefix')}
            />
          )}
        </Field>
        <Field label="Suffix" hint='e.g. " °C" or " km/h"'>
          {(fid) => (
            <Input
              id={fid}
              maxLength={12}
              value={f.suffix ?? ''}
              onChange={(e) => set({ suffix: e.target.value }, 'suffix')}
            />
          )}
        </Field>
      </div>
      <div className="mt-3 flex justify-end">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setConfig({ format: undefined }, 'Reset number format')}
        >
          Reset
        </Button>
      </div>
    </details>
  );
}
