import {
  CHART_KINDS,
  type ChartKind,
  type ClockConfig,
  type Column,
  coordinateRole,
  type Format,
  isDataWidgetType,
  isValidTimeZone,
  KPI_AGGS,
  parse,
  REFERENCE_LINE_KINDS,
  SEARCH_ENGINE_LABELS,
  SEARCH_ENGINES,
  type SearchConfig,
  SOUND_IDS,
  type SoundRule,
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
  Clock,
  Filter,
  Gauge,
  Grid3x3,
  Hash,
  LineChart,
  Map as MapIcon,
  PieChart,
  Play,
  Radar,
  Search,
  Sparkles,
  Table2,
  Type,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
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
import { previewSound, SOUND_LABELS } from '../lib/sounds.ts';
import { useEditor } from '../state/editor.ts';
import { useDatasetResult } from '../state/sync.ts';
import {
  ChartColorFields,
  ReferenceLineFields,
  TableColumnChooser,
  TableRulesFields,
  TruncatedBarHint,
  ValueBandsSection,
} from './FormattingFields.tsx';

const TYPE_OPTIONS: { value: WidgetType; label: string; icon: ReactNode }[] = [
  { value: 'chart', label: 'Chart', icon: <LineChart className="size-3.5" /> },
  { value: 'kpi', label: 'KPI', icon: <Hash className="size-3.5" /> },
  { value: 'gauge', label: 'Gauge', icon: <Gauge className="size-3.5" /> },
  { value: 'table', label: 'Table', icon: <Table2 className="size-3.5" /> },
  { value: 'map', label: 'Map', icon: <MapIcon className="size-3.5" /> },
  { value: 'text', label: 'Text', icon: <Type className="size-3.5" /> },
  { value: 'clock', label: 'Clock', icon: <Clock className="size-3.5" /> },
  { value: 'search', label: 'Search', icon: <Search className="size-3.5" /> },
];

/** The viewer's own habit, as a starting point: the saved value is explicit so every screen shows the same. */
function localHourCycle(): 'h12' | 'h23' {
  const cycle = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle;
  return cycle === 'h12' || cycle === 'h11' ? 'h12' : 'h23';
}

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
    case 'map': {
      // The profiler's name rules, so choosing "Map" on a dataset with coordinates needs no further clicks.
      const lat = numeric.find((c) => coordinateRole(c.name) === 'latitude') ?? numeric[0];
      const lon = numeric.find((c) => coordinateRole(c.name) === 'longitude') ?? numeric[1] ?? lat;
      const readings = columns.some((c) => c.name === 'fetched_at');
      return {
        lat: lat?.name ?? 'latitude',
        lon: lon?.name ?? 'longitude',
        ...(readings ? { mode: 'track' as const, terminator: true } : {}),
      };
    }
    case 'text':
      return { markdown: 'Write **markdown** here.' };
    case 'clock':
      return { style: 'digital', hourCycle: localHourCycle(), showDate: true, showSeconds: false };
    case 'search':
      return { engine: 'google' };
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
        ...(isDataWidgetType(widget.type) ? { datasetId: targetDataset } : {}),
      } as WidgetInput,
    });
    const err = apply(ops, `Added "${widget.title ?? widget.type}"`);
    if (err) toast(err, 'bad');
    else onCreated(id);
  };

  return (
    <div className="space-y-6">
      {datasets.length === 0 ? (
        <p className="rounded-lg bg-surface-2 p-3 text-sm text-ink-2">
          Text, clock and search widgets need no data. For charts, tables and the rest, add a dataset under
          Data first.
        </p>
      ) : (
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
      )}

      {datasets.length === 0 ? null : (
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
      )}

      <section className="space-y-2">
        <h3 className="text-[13px] font-semibold text-ink-2">Or start from a blank widget</h3>
        <div className="grid grid-cols-4 gap-2">
          {TYPE_OPTIONS.map((t) => (
            <button
              key={t.value}
              type="button"
              disabled={isDataWidgetType(t.value) && columns.length === 0}
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
      ...(isDataWidgetType(type) ? { datasetId: datasetId ?? datasets[0]?.id } : {}),
      ...(isDataWidgetType(type) && 'sound' in widget && widget.sound ? { sound: widget.sound } : {}),
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
      {isDataWidgetType(widget.type) ? (
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
        {widget.type === 'map' ? <MapFields widget={widget} columns={columns} setConfig={setConfig} /> : null}
        {widget.type === 'clock' ? <ClockFields config={widget.config} setConfig={setConfig} /> : null}
        {widget.type === 'search' ? <SearchFields config={widget.config} setConfig={setConfig} /> : null}
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

      {widget.type === 'chart' ? (
        <>
          <ChartColorFields widget={widget} setConfig={setConfig} />
          <ReferenceLineFields widget={widget} setConfig={setConfig} />
        </>
      ) : null}
      {widget.type === 'map' ? <ChartColorFields widget={widget} setConfig={setConfig} /> : null}
      {widget.type === 'kpi' || widget.type === 'gauge' ? (
        <ValueBandsSection widget={widget} setConfig={setConfig} />
      ) : null}
      {widget.type === 'table' ? (
        <TableRulesFields widget={widget} columns={columns} setConfig={setConfig} />
      ) : null}

      {isDataWidgetType(widget.type) ? (
        <FormatFields
          format={'format' in widget.config ? widget.config.format : undefined}
          setConfig={setConfig}
        />
      ) : null}

      {'datasetId' in widget ? (
        <SoundFields
          sound={widget.sound}
          columns={columns}
          onChange={(sound, label, coalesce) => update({ sound }, label, coalesce)}
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
  noneLabel = 'None',
  filter,
  disabled,
  hint,
}: {
  label: string;
  value: string | undefined;
  columns: Column[];
  onChange: (v: string | undefined) => void;
  optional?: boolean;
  noneLabel?: string;
  filter?: (c: Column) => boolean;
  disabled?: boolean;
  hint?: string;
}) {
  const options = filter ? columns.filter(filter) : columns;
  const known = value === undefined || options.some((c) => c.name === value);
  return (
    <Field label={label} hint={hint} error={known ? null : `Column "${value}" is not in the data`}>
      {(fid) => (
        <Select
          id={fid}
          value={value ?? ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value || undefined)}
        >
          {optional ? <option value="">{noneLabel}</option> : null}
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
              onClick={() =>
                setConfig(
                  {
                    kind: k,
                    // Kinds without a value axis cannot hold reference lines; drop them rather than refuse.
                    ...(c.referenceLines && !(REFERENCE_LINE_KINDS as readonly string[]).includes(k)
                      ? { referenceLines: undefined }
                      : {}),
                  },
                  `Changed chart to ${k}`,
                )
              }
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
                  // A line on a column that is no longer plotted falls back to the first y.
                  const lines = c.referenceLines?.map(({ field, ...line }) =>
                    field && !next.includes(field) ? line : { ...line, ...(field ? { field } : {}) },
                  );
                  if (next.length)
                    setConfig({ y: next, ...(lines ? { referenceLines: lines } : {}) }, 'Changed values');
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
          {c.kind === 'scatter' ? (
            <>
              <NumberField
                label="X min"
                value={c.xMin}
                onChange={(v) => setConfig({ xMin: v }, 'Changed axis', 'xmin')}
              />
              <NumberField
                label="X max"
                value={c.xMax}
                onChange={(v) => setConfig({ xMax: v }, 'Changed axis', 'xmax')}
              />
            </>
          ) : null}
        </div>
      ) : null}
      <TruncatedBarHint config={c} />
    </>
  );
}

function MapFields({
  widget,
  columns,
  setConfig,
}: {
  widget: Extract<Widget, { type: 'map' }>;
  columns: Column[];
  setConfig: SetConfig;
}) {
  const c = widget.config;
  const isNumber = (col: Column) => col.type === 'number';
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <ColumnSelect
          label="Latitude"
          value={c.lat}
          columns={columns}
          filter={isNumber}
          onChange={(v) => v && setConfig({ lat: v }, 'Changed latitude column')}
        />
        <ColumnSelect
          label="Longitude"
          value={c.lon}
          columns={columns}
          filter={isNumber}
          onChange={(v) => v && setConfig({ lon: v }, 'Changed longitude column')}
        />
      </div>
      <div className="space-y-1.5">
        <div className="text-[13px] font-medium text-ink-2">Show</div>
        <Segmented
          value={c.mode}
          onChange={(mode) => setConfig({ mode }, mode === 'track' ? 'Showed a track' : 'Showed points')}
          options={[
            { value: 'points', label: 'Points', title: 'A dot per row' },
            { value: 'track', label: 'Track', title: 'Rows connected in their order: sort by time first' },
          ]}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <ColumnSelect
          label="Group by"
          value={c.series}
          columns={columns}
          optional
          filter={(col) => col.type === 'string' || col.type === 'boolean'}
          hint={c.mode === 'track' ? 'One colour and one line per value' : 'One colour per value'}
          // A map has one colour channel: grouping replaces colouring by value.
          onChange={(v) => setConfig({ series: v, ...(v ? { color: undefined } : {}) }, 'Changed grouping')}
        />
        <ColumnSelect
          label="Size by"
          value={c.size}
          columns={columns}
          optional
          filter={isNumber}
          hint="Dot area grows with the value"
          onChange={(v) => setConfig({ size: v }, 'Changed size column')}
        />
        <ColumnSelect
          label="Colour by"
          value={c.color}
          columns={columns}
          optional
          filter={isNumber}
          disabled={Boolean(c.series)}
          hint={c.series ? 'Not with "Group by": one colour channel only' : 'Sequential blue ramp'}
          onChange={(v) => setConfig({ color: v }, 'Changed colour column')}
        />
        <ColumnSelect
          label="Label"
          value={c.label}
          columns={columns}
          optional
          hint="Tooltips and the table view"
          onChange={(v) => setConfig({ label: v }, 'Changed label column')}
        />
        <Field label="View">
          {(fid) => (
            <Select
              id={fid}
              value={c.view}
              onChange={(e) => setConfig({ view: e.target.value }, 'Changed map view')}
            >
              <option value="fit">Fit to data</option>
              <option value="world">Whole world</option>
            </Select>
          )}
        </Field>
        <Field
          label="Base map"
          hint={c.basemap === 'countries' ? 'Natural Earth, de facto borders' : undefined}
        >
          {(fid) => (
            <Select
              id={fid}
              value={c.basemap}
              onChange={(e) => setConfig({ basemap: e.target.value }, 'Changed base map')}
            >
              <option value="countries">Countries</option>
              <option value="land">Land only</option>
              <option value="none">None</option>
            </Select>
          )}
        </Field>
      </div>
      <Toggle
        label="Day/night shading"
        checked={c.terminator}
        onChange={(v) => setConfig({ terminator: v }, v ? 'Shaded the night side' : 'Removed night shading')}
      />
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
  const counting = c.agg === 'count';
  // Leaving count without a column would make the widget invalid: fall back to a numeric column.
  const fallbackField = (columns.find((col) => col.type === 'number') ?? columns[0])?.name;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <ColumnSelect
          label={counting ? 'Count values of' : 'Value column'}
          value={c.field}
          columns={columns}
          optional={counting}
          noneLabel="Nothing: count rows"
          onChange={(v) =>
            counting
              ? setConfig({ field: v }, 'Changed counted column')
              : v && setConfig({ field: v }, 'Changed value column')
          }
        />
        <Field label="Aggregate">
          {(fid) => (
            <Select
              id={fid}
              value={c.agg}
              onChange={(e) =>
                setConfig(
                  {
                    agg: e.target.value,
                    ...(e.target.value !== 'count' && !c.field && fallbackField
                      ? { field: fallbackField }
                      : {}),
                  },
                  'Changed aggregation',
                )
              }
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
                  <option value="neutral">Neither (neutral)</option>
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
  return (
    <>
      <TableColumnChooser widget={widget} columns={columns} setConfig={setConfig} />
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

function starterCondition(columns: Column[]) {
  const name = columns.find((c) => c.type === 'number')?.name ?? 'value';
  return `${/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `\`${name}\``} > 0`;
}

const DEFAULT_SOUND: SoundRule = {
  trigger: { kind: 'newRows' },
  sound: 'bell',
  volume: 0.7,
  cooldownSec: 10,
};

function SoundFields({
  sound,
  columns,
  onChange,
}: {
  sound: SoundRule | undefined;
  columns: Column[];
  onChange: (sound: SoundRule | null, label: string, coalesce?: string) => void;
}) {
  const set = (patch: Partial<SoundRule>, label = 'Changed sound', coalesce?: string) =>
    onChange({ ...(sound ?? DEFAULT_SOUND), ...patch }, label, coalesce);
  return (
    <details className="group rounded-xl border border-line bg-surface p-4" open={Boolean(sound)}>
      <summary className="cursor-pointer text-[13px] font-medium text-ink-2">Sound</summary>
      <div className="mt-4 space-y-4">
        <Toggle
          label="Play a sound when the live data changes"
          checked={Boolean(sound)}
          onChange={(on) => onChange(on ? DEFAULT_SOUND : null, on ? 'Added a sound' : 'Removed the sound')}
        />
        {sound ? (
          <>
            <div className="space-y-1.5">
              <div className="text-[13px] font-medium text-ink-2">Play when</div>
              <Segmented
                value={sound.trigger.kind}
                onChange={(kind) =>
                  set(
                    { trigger: kind === 'newRows' ? { kind } : { kind, expr: starterCondition(columns) } },
                    'Changed sound trigger',
                  )
                }
                options={[
                  { value: 'newRows', label: 'New rows arrive' },
                  { value: 'condition', label: 'A condition becomes true' },
                ]}
              />
            </div>
            {sound.trigger.kind === 'newRows' ? (
              <ColumnSelect
                label="Rows are identified by"
                value={sound.trigger.key}
                columns={columns}
                optional
                onChange={(key) =>
                  set(
                    { trigger: key ? { kind: 'newRows', key } : { kind: 'newRows' } },
                    'Changed sound trigger',
                  )
                }
              />
            ) : (
              <ConditionInput
                expr={sound.trigger.expr}
                onChange={(expr) =>
                  set({ trigger: { kind: 'condition', expr } }, 'Changed sound condition', 'sound-expr')
                }
              />
            )}
            <p className="-mt-2 text-xs text-muted">
              {sound.trigger.kind === 'newRows'
                ? sound.trigger.key
                  ? 'Plays when a value appears that was not in the previous result, e.g. a new order.'
                  : 'Without a column, plays when the number of rows grew.'
                : 'Checked on the last row (the newest reading). Plays once when it becomes true.'}
            </p>
            <div className="space-y-1.5">
              <div className="text-[13px] font-medium text-ink-2">Which sound</div>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                {SOUND_IDS.map((id) => (
                  <div
                    key={id}
                    className={cx(
                      'flex items-center rounded-lg border text-[13px] transition',
                      sound.sound === id
                        ? 'border-ink bg-surface-2 text-ink'
                        : 'border-line text-ink-2 hover:border-ink-2',
                    )}
                  >
                    <button
                      type="button"
                      aria-pressed={sound.sound === id}
                      className="min-w-0 flex-1 truncate py-1.5 pl-2.5 text-left"
                      onClick={() => {
                        previewSound(id, sound.volume);
                        if (sound.sound !== id) set({ sound: id }, `Changed sound to ${SOUND_LABELS[id]}`);
                      }}
                    >
                      {SOUND_LABELS[id]}
                    </button>
                    <button
                      type="button"
                      aria-label={`Play ${SOUND_LABELS[id]}`}
                      title={`Play ${SOUND_LABELS[id]}`}
                      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:text-ink"
                      onClick={() => previewSound(id, sound.volume)}
                    >
                      <Play className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={`Volume ${Math.round(sound.volume * 100)} %`}>
                {(fid) => (
                  <div className="flex h-9 items-center gap-2">
                    <input
                      id={fid}
                      type="range"
                      min={0}
                      max={100}
                      step={5}
                      value={Math.round(sound.volume * 100)}
                      onChange={(e) =>
                        set({ volume: Number(e.target.value) / 100 }, 'Changed sound volume', 'sound-volume')
                      }
                      // Preview on release, not on every step of the drag.
                      onPointerUp={() => previewSound(sound.sound, sound.volume)}
                      onKeyUp={() => previewSound(sound.sound, sound.volume)}
                      className="min-w-0 flex-1 accent-accent"
                    />
                    <button
                      type="button"
                      aria-label="Play at this volume"
                      title="Play at this volume"
                      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-ink"
                      onClick={() => previewSound(sound.sound, sound.volume)}
                    >
                      <Play className="size-3.5" />
                    </button>
                  </div>
                )}
              </Field>
              <Field label="At most once every" hint="Seconds, 0 to 3600.">
                {(fid) => (
                  <Input
                    id={fid}
                    type="number"
                    min={0}
                    max={3600}
                    value={sound.cooldownSec}
                    onChange={(e) => {
                      const n = Math.round(Number(e.target.value));
                      if (e.target.value !== '' && Number.isFinite(n))
                        set(
                          { cooldownSec: Math.min(3600, Math.max(0, n)) },
                          'Changed sound cooldown',
                          'sound-cooldown',
                        );
                    }}
                  />
                )}
              </Field>
            </div>
            <p className="text-xs text-muted">
              Sounds play only on screens showing this dashboard, never when it first loads. Each viewer can
              mute their own screen. Use them sparingly.
            </p>
          </>
        ) : null}
      </div>
    </details>
  );
}

/** Keeps the typed text locally and saves only expressions that parse, so typing never fails an operation. */
export function ConditionInput({ expr, onChange }: { expr: string; onChange: (expr: string) => void }) {
  const [draft, setDraft] = useState(expr);
  useEffect(() => setDraft(expr), [expr]);
  let error: string | null = null;
  try {
    parse(draft);
  } catch (e) {
    error = e instanceof Error ? e.message : 'Invalid expression';
  }
  return (
    <Field label="Condition" error={draft.trim() ? error : 'Enter an expression, e.g. price > 100000'}>
      {(fid) => (
        <Input
          id={fid}
          value={draft}
          maxLength={2000}
          spellCheck={false}
          className="font-mono text-[13px]"
          placeholder="price > 100000"
          onChange={(e) => {
            setDraft(e.target.value);
            try {
              parse(e.target.value);
              onChange(e.target.value);
            } catch {
              // Shown below the field; the saved rule keeps the last valid expression.
            }
          }}
        />
      )}
    </Field>
  );
}

let zoneList: string[] | null = null;
function timeZones(): string[] {
  if (!zoneList) {
    try {
      zoneList = Intl.supportedValuesOf('timeZone');
    } catch {
      zoneList = [];
    }
  }
  return zoneList;
}

function ClockFields({ config, setConfig }: { config: ClockConfig; setConfig: SetConfig }) {
  // Typed text stays local until it names a real zone, so typing never fails an operation.
  const [zone, setZone] = useState(config.timeZone ?? '');
  useEffect(() => setZone(config.timeZone ?? ''), [config.timeZone]);
  const zoneError =
    zone.trim() && !isValidTimeZone(zone.trim()) ? 'Pick a zone from the list, e.g. Europe/Bratislava' : null;
  return (
    <>
      <div className="space-y-1.5">
        <div className="text-[13px] font-medium text-ink-2">Style</div>
        <Segmented
          value={config.style}
          onChange={(style) => setConfig({ style }, 'Changed clock style')}
          options={[
            { value: 'digital', label: 'Digital' },
            { value: 'analog', label: 'Analog' },
          ]}
        />
      </div>
      <Field label="Time zone" error={zoneError} hint="Empty: each viewer's own local time.">
        {(fid) => (
          <>
            <Input
              id={fid}
              list={`${fid}-zones`}
              value={zone}
              placeholder="My local time"
              spellCheck={false}
              onChange={(e) => {
                const next = e.target.value;
                setZone(next);
                const trimmed = next.trim();
                if (!trimmed) setConfig({ timeZone: undefined }, 'Changed clock time zone', 'clock-zone');
                else if (isValidTimeZone(trimmed))
                  setConfig({ timeZone: trimmed }, 'Changed clock time zone', 'clock-zone');
              }}
            />
            <datalist id={`${fid}-zones`}>
              {timeZones().map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
          </>
        )}
      </Field>
      <Field label="Label" hint="Shown under the time. Empty: the city of the time zone.">
        {(fid) => (
          <Input
            id={fid}
            value={config.label ?? ''}
            maxLength={60}
            onChange={(e) =>
              setConfig({ label: e.target.value || undefined }, 'Changed clock label', 'clock-label')
            }
          />
        )}
      </Field>
      <div className="space-y-1.5">
        <div className="text-[13px] font-medium text-ink-2">Hours</div>
        <Segmented
          value={config.hourCycle}
          onChange={(hourCycle) => setConfig({ hourCycle }, 'Changed clock hours')}
          options={[
            { value: 'h23', label: '24-hour' },
            { value: 'h12', label: '12-hour' },
          ]}
        />
      </div>
      <Toggle
        label="Show the date"
        checked={config.showDate}
        onChange={(showDate) => setConfig({ showDate }, 'Changed clock date')}
      />
      <Toggle
        label="Show seconds"
        checked={config.showSeconds}
        onChange={(showSeconds) => setConfig({ showSeconds }, 'Changed clock seconds')}
      />
    </>
  );
}

function SearchFields({ config, setConfig }: { config: SearchConfig; setConfig: SetConfig }) {
  const [template, setTemplate] = useState(config.template ?? 'https://');
  useEffect(() => setTemplate(config.template ?? 'https://'), [config.template]);
  const templateOk = (t: string) => {
    try {
      return new URL(t).protocol === 'https:' && t.includes('{q}');
    } catch {
      return false;
    }
  };
  return (
    <>
      <Field label="Search engine">
        {(fid) => (
          <Select
            id={fid}
            value={config.engine}
            onChange={(e) => {
              const engine = e.target.value as SearchConfig['engine'];
              if (engine === 'custom') {
                // The schema needs a valid address with the engine, so start from an example to edit.
                const next = templateOk(template) ? template : 'https://example.com/search?q={q}';
                setTemplate(next);
                setConfig({ engine, template: next }, 'Changed search engine');
              } else setConfig({ engine, template: undefined }, 'Changed search engine');
            }}
          >
            {SEARCH_ENGINES.map((e) => (
              <option key={e} value={e}>
                {SEARCH_ENGINE_LABELS[e]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {config.engine === 'custom' ? (
        <Field
          label="Address"
          error={templateOk(template) ? null : 'An https address with {q} where the query goes'}
          hint="e.g. https://en.wikipedia.org/w/index.php?search={q}"
        >
          {(fid) => (
            <Input
              id={fid}
              value={template}
              maxLength={500}
              spellCheck={false}
              className="font-mono text-[13px]"
              onChange={(e) => {
                setTemplate(e.target.value);
                if (templateOk(e.target.value))
                  setConfig({ template: e.target.value }, 'Changed search address', 'search-template');
              }}
            />
          )}
        </Field>
      ) : null}
      <Toggle
        label="Open results in a new tab"
        checked={config.newTab}
        onChange={(newTab) => setConfig({ newTab }, 'Changed search')}
      />
      <Toggle
        label="Put the cursor in the field when the page opens"
        checked={config.autofocus}
        onChange={(autofocus) => setConfig({ autofocus }, 'Changed search')}
      />
      <p className="text-xs text-muted">
        Queries go straight from the browser to the search engine; this server never sees them. With the
        cursor in the field, keyboard shortcuts such as F (present) wait until you click elsewhere.
      </p>
    </>
  );
}
