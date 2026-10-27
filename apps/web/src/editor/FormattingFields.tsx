/**
 * Editor sections for colour and formatting (proposal 0007): series colours, reference lines, value bands, table
 * column settings and rules, and the dashboard's entity colours. Every change is an operation through the editor's
 * `apply`, like the rest of the widget editor.
 */
import {
  type Bands,
  type ChartConfig,
  type Color,
  type ColorMap,
  type Column,
  type Format,
  REFERENCE_LINE_KINDS,
  REFERENCE_STATS,
  type ReferenceLine,
  resolveColor,
  seriesColors,
  type TableColumn,
  type TableConfig,
  type TableRule,
  THEMES,
  type Widget,
} from '@patchbay/core';
import { ArrowUp, Plus, Settings2, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { ColorPicker } from '../components/ColorPicker.tsx';
import {
  Button,
  Card,
  cx,
  Field,
  IconButton,
  Input,
  Popover,
  Segmented,
  Select,
  toast,
} from '../components/ui.tsx';
import { useTheme } from '../lib/hooks.ts';
import { useEditor } from '../state/editor.ts';
import { useDatasetResult } from '../state/sync.ts';
import { ConditionInput } from './WidgetEditor.tsx';

type SetConfig = (patch: Record<string, unknown>, label?: string, coalesce?: string) => void;

const MAX_LISTED_KEYS = 24;
const STAT_LABELS: Record<(typeof REFERENCE_STATS)[number], string> = {
  avg: 'Average',
  median: 'Median',
  min: 'Minimum',
  max: 'Maximum',
};

function Section({ title, open, children }: { title: string; open: boolean; children: ReactNode }) {
  return (
    <details className="group rounded-xl border border-line bg-surface p-4" open={open}>
      <summary className="cursor-pointer text-[13px] font-medium text-ink-2">{title}</summary>
      <div className="mt-4 space-y-3">{children}</div>
    </details>
  );
}

/** A number field that saves only numbers, so clearing it while typing never fails an operation. */
function NumberInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | undefined;
  onChange: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // Sized by a wrapper: the shared field style is full width and class order cannot override it.
  return (
    <div className="w-24 shrink-0">
      <Input
        aria-label={label}
        type="number"
        className="h-8"
        value={draft ?? value ?? ''}
        onChange={(e) => {
          setDraft(e.target.value);
          if (e.target.value !== '' && Number.isFinite(Number(e.target.value)))
            onChange(Number(e.target.value));
        }}
        onBlur={() => setDraft(null)}
      />
    </div>
  );
}

type ColouredWidget = Extract<Widget, { type: 'chart' | 'map' }>;

/**
 * The keys a widget colours, as its option builder sees them: slice labels, series values or y columns for a chart,
 * the "Group by" values for a map.
 */
function useColorKeys(widget: ColouredWidget): string[] {
  const dashboardId = useEditor((s) => s.id)!;
  const dataset = useEditor((s) => s.doc?.datasets.find((d) => d.id === widget.datasetId));
  const rows = useDatasetResult(dashboardId, dataset, true).data?.table.rows ?? [];
  if (widget.type === 'map') return widget.config.series ? distinctKeys(rows, widget.config.series) : [];
  const c = widget.config;
  const column = c.kind === 'pie' || c.kind === 'donut' ? c.x : c.series;
  if (!column) return c.y;
  return distinctKeys(rows, column);
}

function distinctKeys(rows: readonly Record<string, unknown>[], column: string): string[] {
  const keys = new Set<string>();
  for (const row of rows) {
    const v = row[column];
    keys.add(v === null || v === undefined ? '(empty)' : String(v));
    if (keys.size > 200) break;
  }
  return [...keys].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).slice(0, MAX_LISTED_KEYS);
}

export function ChartColorFields({ widget, setConfig }: { widget: ColouredWidget; setConfig: SetConfig }) {
  const mode = useTheme();
  const entityColors = useEditor((s) => s.doc?.colors);
  const c = widget.config;
  const dataKeys = useColorKeys(widget);
  // Funnels use the ordinal ramp and heatmaps a sequential scale: neither has entity colours. A map has them only
  // per "Group by" value; otherwise its colour channel is the single dot colour or the value ramp.
  if (widget.type === 'chart' && (widget.config.kind === 'funnel' || widget.config.kind === 'heatmap'))
    return null;
  if (widget.type === 'map' && !widget.config.series) return null;
  const list = Array.isArray(c.colors) ? c.colors : null;
  const map: ColorMap = list
    ? Object.fromEntries(dataKeys.map((k, i) => [k, list[i % list.length]!]))
    : ((c.colors as ColorMap | undefined) ?? {});
  const keys = [...dataKeys, ...Object.keys(map).filter((k) => !dataKeys.includes(k))];
  const automatic = seriesColors(keys, c.colors, THEMES[mode], { entityColors });
  const save = (next: ColorMap, label: string) =>
    setConfig({ colors: Object.keys(next).length ? next : undefined }, label);
  return (
    <Section title="Colours" open={Boolean(c.colors)}>
      <p className="text-xs text-muted">
        A colour chosen here belongs to the{' '}
        {c.series
          ? 'series value'
          : widget.type === 'chart' && (widget.config.kind === 'pie' || widget.config.kind === 'donut')
            ? 'slice'
            : 'column'}
        , not to its position, so it stays when data changes. The others take the remaining palette colours.
      </p>
      {list ? (
        <p className="text-xs text-muted">
          This chart has a list of colours in series order; choosing one turns it into a colour per series.
        </p>
      ) : null}
      <div className="space-y-2">
        {keys.map((key, i) => (
          <div key={key} className="flex flex-wrap items-start justify-between gap-2">
            <span className="min-w-0 truncate pt-1.5 text-[13px] text-ink-2" title={key}>
              {key}
            </span>
            <ColorPicker
              label={`Colour of ${key}`}
              value={list ? undefined : map[key]}
              automatic={automatic[i]}
              placeholder={entityColors?.[key] ? 'Dashboard colour' : 'Automatic'}
              onChange={(color) => save({ ...map, [key]: color }, `Changed colour of "${key}"`)}
              onReset={() => {
                const { [key]: _removed, ...rest } = map;
                save(rest, `Reset colour of "${key}"`);
              }}
            />
          </div>
        ))}
        {keys.length === 0 ? <p className="text-xs text-muted">No series in the current data.</p> : null}
      </div>
    </Section>
  );
}

/** Bars encode values by length, so a bar axis that does not start at zero misleads (proposal 0007). */
export function TruncatedBarHint({ config }: { config: ChartConfig }) {
  if (config.kind !== 'bar' || config.yMin === undefined || config.yMin <= 0) return null;
  return (
    <p className="rounded-lg border border-warn/50 bg-warn/10 px-2.5 py-1.5 text-xs text-ink">
      Bars start at zero so their lengths can be compared. To show a benchmark, add a reference line.
    </p>
  );
}

export function ReferenceLineFields({
  widget,
  setConfig,
}: {
  widget: Extract<Widget, { type: 'chart' }>;
  setConfig: SetConfig;
}) {
  const mode = useTheme();
  const c = widget.config;
  if (!(REFERENCE_LINE_KINDS as readonly string[]).includes(c.kind)) return null;
  const lines = c.referenceLines ?? [];
  const save = (next: ReferenceLine[], label: string, coalesce?: string) =>
    setConfig({ referenceLines: next.length ? next : undefined }, label, coalesce);
  const update = (i: number, line: ReferenceLine, label: string, coalesce?: string) =>
    save(
      lines.map((l, j) => (j === i ? line : l)),
      label,
      coalesce,
    );
  return (
    <Section title="Reference lines" open={lines.length > 0}>
      <p className="text-xs text-muted">
        A dashed line for a benchmark, such as an average or a target, on the chart's value axis.
      </p>
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity; their position is their identity
        <Card key={i} className="space-y-3 p-3">
          <div className="flex items-center justify-between gap-2">
            <Segmented
              value={line.stat !== undefined ? 'stat' : 'value'}
              onChange={(kind) => {
                const { value: _v, stat: _s, field: _f, ...rest } = line;
                update(
                  i,
                  kind === 'stat' ? { ...rest, stat: 'avg' } : { ...rest, value: 0 },
                  'Changed reference line',
                );
              }}
              options={[
                { value: 'value', label: 'Value' },
                { value: 'stat', label: 'Statistic' },
              ]}
            />
            <IconButton
              label={`Remove reference line ${i + 1}`}
              onClick={() =>
                save(
                  lines.filter((_, j) => j !== i),
                  'Removed reference line',
                )
              }
              className="size-7"
            >
              <X className="size-3.5" />
            </IconButton>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {line.stat !== undefined ? (
              <div className="flex w-full gap-2">
                <Select
                  aria-label="Statistic"
                  className="h-8"
                  value={line.stat}
                  onChange={(e) =>
                    update(
                      i,
                      { ...line, stat: e.target.value as ReferenceLine['stat'] },
                      'Changed reference line',
                    )
                  }
                >
                  {REFERENCE_STATS.map((s) => (
                    <option key={s} value={s}>
                      {STAT_LABELS[s]}
                    </option>
                  ))}
                </Select>
                {c.y.length > 1 ? (
                  <Select
                    aria-label="Of column"
                    className="h-8"
                    value={line.field ?? c.y[0]}
                    onChange={(e) => update(i, { ...line, field: e.target.value }, 'Changed reference line')}
                  >
                    {c.y.map((y) => (
                      <option key={y} value={y}>
                        of {y}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <span className="w-full self-center text-[13px] text-muted">of {c.y[0]}</span>
                )}
              </div>
            ) : (
              <NumberInput
                label="Value"
                value={line.value}
                onChange={(value) =>
                  update(i, { ...line, value }, 'Changed reference line', `ref-value-${i}`)
                }
              />
            )}
            <Input
              aria-label="Label"
              placeholder="Label, e.g. Network average"
              maxLength={60}
              className="h-8"
              value={line.label ?? ''}
              onChange={(e) => {
                const { label: _l, ...rest } = line;
                update(
                  i,
                  e.target.value ? { ...line, label: e.target.value } : rest,
                  'Changed reference line',
                  `ref-label-${i}`,
                );
              }}
            />
          </div>
          <ColorPicker
            label="Line colour"
            value={line.color}
            placeholder="Neutral"
            automatic={resolveColor('neutral', THEMES[mode], 'mark')}
            onChange={(color) => update(i, { ...line, color }, 'Changed reference line colour')}
            onReset={() => {
              const { color: _c, ...rest } = line;
              update(i, rest, 'Changed reference line colour');
            }}
          />
        </Card>
      ))}
      <Button
        size="sm"
        variant="ghost"
        icon={<Plus className="size-3.5" />}
        disabled={lines.length >= 3}
        onClick={() => save([...lines, { stat: 'avg', label: 'Average' }], 'Added a reference line')}
      >
        Add reference line
      </Button>
    </Section>
  );
}

/** Bands as the gauge has them: "up to N → colour", in ascending order; above the last band nothing. */
export function BandsFields({
  bands,
  onChange,
  hint,
}: {
  bands: Bands | undefined;
  onChange: (bands: Bands | undefined, label: string, coalesce?: string) => void;
  hint: string;
}) {
  const list = bands ?? [];
  const save = (next: Bands, label: string, coalesce?: string) =>
    onChange(next.length ? next : undefined, label, coalesce);
  const ascending = list.every((b, i) => i === 0 || b.upTo >= list[i - 1]!.upTo);
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted">{hint}</p>
      {list.map((band, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: bands have no identity; their position is their identity
        <div key={i} className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-ink-2">Up to</span>
          <NumberInput
            label={`Band ${i + 1} up to`}
            value={band.upTo}
            onChange={(upTo) =>
              save(
                list.map((b, j) => (j === i ? { ...b, upTo } : b)),
                'Changed colour band',
                `band-${i}`,
              )
            }
          />
          <ColorPicker
            label={`Band ${i + 1} colour`}
            value={band.color}
            onChange={(color) =>
              save(
                list.map((b, j) => (j === i ? { ...b, color } : b)),
                'Changed colour band',
              )
            }
          />
          <IconButton
            label={`Remove band ${i + 1}`}
            onClick={() =>
              save(
                list.filter((_, j) => j !== i),
                'Removed colour band',
              )
            }
            className="size-7"
          >
            <X className="size-3.5" />
          </IconButton>
        </div>
      ))}
      {!ascending ? (
        <p className="text-xs text-bad">List the bands from the lowest to the highest value.</p>
      ) : null}
      <Button
        size="sm"
        variant="ghost"
        icon={<Plus className="size-3.5" />}
        disabled={list.length >= 6}
        onClick={() =>
          save(
            [
              ...list,
              {
                upTo: (list.at(-1)?.upTo ?? 0) + (list.length ? 10 : 0),
                color: list.length ? 'warning' : 'negative',
              },
            ],
            'Added colour band',
          )
        }
      >
        Add band
      </Button>
    </div>
  );
}

export function ValueBandsSection({
  widget,
  setConfig,
}: {
  widget: Extract<Widget, { type: 'kpi' | 'gauge' }>;
  setConfig: SetConfig;
}) {
  return (
    <Section
      title={widget.type === 'kpi' ? 'Value colour' : 'Colour bands'}
      open={Boolean(widget.config.bands)}
    >
      <BandsFields
        bands={widget.config.bands}
        onChange={(bands, label, coalesce) => setConfig({ bands }, label, coalesce)}
        hint={
          widget.type === 'kpi'
            ? 'Colours the value: it takes the first band it is at or below. Above the last band it keeps the normal colour.'
            : 'Colours the arc from the minimum up to each value, in ascending order.'
        }
      />
    </Section>
  );
}

type Entry = NonNullable<TableConfig['columns']>[number];
const fieldOf = (e: Entry) => (typeof e === 'string' ? e : e.field);
/** An object that only names its field is the plain name again, which keeps simple tables simple. */
const simplify = (col: TableColumn): Entry =>
  col.label || col.format || col.bands || col.colorAs === 'text' ? col : col.field;

function ColumnSettings({
  column,
  onChange,
}: {
  column: TableColumn;
  onChange: (c: TableColumn, label: string, coalesce?: string) => void;
}) {
  const format = column.format;
  const setFormat = (next: Format | undefined) => {
    const { format: _f, ...rest } = column;
    onChange(next ? { ...rest, format: next } : rest, 'Changed column format');
  };
  return (
    <div className="space-y-3">
      <Field label="Label" hint={`Shown instead of "${column.field}" in the header.`}>
        {(fid) => (
          <Input
            id={fid}
            maxLength={80}
            value={column.label ?? ''}
            placeholder={column.field}
            onChange={(e) => {
              const { label: _l, ...rest } = column;
              onChange(
                e.target.value ? { ...rest, label: e.target.value } : rest,
                'Changed column label',
                `label-${column.field}`,
              );
            }}
          />
        )}
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Number format">
          {(fid) => (
            <Select
              id={fid}
              value={format?.style ?? ''}
              onChange={(e) =>
                setFormat(
                  e.target.value ? { ...format, style: e.target.value as Format['style'] } : undefined,
                )
              }
            >
              <option value="">Table's format</option>
              <option value="number">Number</option>
              <option value="compact">Compact (1.2K)</option>
              <option value="percent">Percent</option>
              <option value="currency">Currency</option>
            </Select>
          )}
        </Field>
        {format ? (
          <Field label="Decimals">
            {(fid) => (
              <Input
                id={fid}
                type="number"
                min={0}
                max={8}
                placeholder="auto"
                value={format.decimals ?? ''}
                onChange={(e) => {
                  const { decimals: _d, ...rest } = format;
                  setFormat(
                    e.target.value === ''
                      ? rest
                      : { ...format, decimals: Math.min(8, Math.max(0, Number(e.target.value))) },
                  );
                }}
              />
            )}
          </Field>
        ) : null}
      </div>
      <div className="space-y-1.5">
        <div className="text-[13px] font-medium text-ink-2">Colour by value</div>
        <BandsFields
          bands={column.bands}
          hint="A cell takes the first band its value is at or below; above the last band it stays uncoloured."
          onChange={(bands, label, coalesce) => {
            const { bands: _b, ...rest } = column;
            onChange(bands ? { ...rest, bands } : rest, label, coalesce);
          }}
        />
      </div>
      {column.bands ? (
        <Segmented
          value={column.colorAs}
          onChange={(colorAs) => onChange({ ...column, colorAs }, 'Changed column colouring')}
          options={[
            { value: 'fill', label: 'Tint the cell' },
            { value: 'text', label: 'Colour the text' },
          ]}
        />
      ) : null}
    </div>
  );
}

/** The column chooser: which columns, in which order, and each one's label, format and colour. */
export function TableColumnChooser({
  widget,
  columns,
  setConfig,
}: {
  widget: Extract<Widget, { type: 'table' }>;
  columns: Column[];
  setConfig: SetConfig;
}) {
  const entries: Entry[] = widget.config.columns ?? columns.map((c) => c.name);
  const shown = new Set(entries.map(fieldOf));
  const save = (next: Entry[], label: string, coalesce?: string) =>
    setConfig(
      {
        // All plain and all present is the same as "every column", the default.
        columns:
          next.length === columns.length && next.every((e) => typeof e === 'string') ? undefined : next,
      },
      label,
      coalesce,
    );
  const missing = entries.map(fieldOf).filter((f) => !columns.some((c) => c.name === f));
  return (
    <div className="space-y-1.5">
      <div className="text-[13px] font-medium text-ink-2">Columns</div>
      <div className="flex flex-wrap gap-1.5">
        {[...columns.map((c) => c.name), ...missing].map((name) => {
          const on = shown.has(name);
          const at = entries.findIndex((e) => fieldOf(e) === name);
          const entry = entries[at];
          const object: TableColumn =
            entry === undefined || typeof entry === 'string' ? { field: name, colorAs: 'fill' } : entry;
          const custom = entry !== undefined && typeof entry !== 'string';
          return (
            <span
              key={name}
              className={cx(
                'inline-flex items-center rounded-md border text-xs transition',
                on ? 'border-ink bg-ink text-page' : 'border-line text-ink-2 hover:border-ink-2',
              )}
            >
              <button
                type="button"
                aria-pressed={on}
                className="px-2 py-1"
                title={custom && object.label ? `${object.label} (${name})` : undefined}
                onClick={() =>
                  save(
                    on ? entries.filter((e) => fieldOf(e) !== name) : [...entries, name],
                    'Changed table columns',
                  )
                }
              >
                {custom && object.label ? object.label : name}
              </button>
              {on ? (
                <Popover
                  label={`Settings of column ${name}`}
                  title={`Column "${name}"`}
                  trigger={<Settings2 className="size-3" />}
                  triggerClassName={cx('border-l border-page/30 px-1.5 py-1.5', custom && 'text-accent')}
                >
                  <ColumnSettings
                    column={object}
                    onChange={(col, label, coalesce) =>
                      save(
                        entries.map((e, j) => (j === at ? simplify(col) : e)),
                        label,
                        coalesce,
                      )
                    }
                  />
                </Popover>
              ) : null}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function starterRule(columns: Column[]): TableRule {
  const col = columns.find((c) => c.type === 'number') ?? columns[0];
  const name = col?.name ?? 'value';
  const ref = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `\`${name}\``;
  return { when: col?.type === 'string' ? `${ref} == ""` : `${ref} > 0`, color: 'negative', colorAs: 'fill' };
}

export function TableRulesFields({
  widget,
  columns,
  setConfig,
}: {
  widget: Extract<Widget, { type: 'table' }>;
  columns: Column[];
  setConfig: SetConfig;
}) {
  const rules = widget.config.rules ?? [];
  const save = (next: TableRule[], label: string, coalesce?: string) =>
    setConfig({ rules: next.length ? next : undefined }, label, coalesce);
  const update = (i: number, rule: TableRule, label: string, coalesce?: string) =>
    save(
      rules.map((r, j) => (j === i ? rule : r)),
      label,
      coalesce,
    );
  return (
    <Section title="Colour rules" open={rules.length > 0}>
      <p className="text-xs text-muted">
        Colour rows or cells where a condition holds, e.g. <code>status == "late"</code>. The first matching
        rule wins; a column's own colours win over rules.
      </p>
      {rules.map((rule, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rules have no identity; their order is their meaning
        <Card key={i} className="space-y-3 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] font-medium text-ink-2">Rule {i + 1}</span>
            <div className="flex gap-1">
              <IconButton
                label={`Move rule ${i + 1} up`}
                disabled={i === 0}
                className="size-7"
                onClick={() => {
                  const next = [...rules];
                  [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
                  save(next, 'Reordered colour rules');
                }}
              >
                <ArrowUp className="size-3.5" />
              </IconButton>
              <IconButton
                label={`Remove rule ${i + 1}`}
                className="size-7"
                onClick={() =>
                  save(
                    rules.filter((_, j) => j !== i),
                    'Removed colour rule',
                  )
                }
              >
                <X className="size-3.5" />
              </IconButton>
            </div>
          </div>
          <ConditionInput
            expr={rule.when}
            onChange={(when) => update(i, { ...rule, when }, 'Changed colour rule', `rule-${i}`)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <ColorPicker
              label="Rule colour"
              value={rule.color}
              onChange={(color) => update(i, { ...rule, color }, 'Changed colour rule')}
            />
            <Segmented
              value={rule.colorAs}
              onChange={(colorAs) => update(i, { ...rule, colorAs }, 'Changed colour rule')}
              options={[
                { value: 'fill', label: 'Tint' },
                { value: 'text', label: 'Text' },
              ]}
            />
          </div>
          <div className="space-y-1.5">
            <Segmented
              value={rule.columns?.length ? 'some' : 'row'}
              onChange={(scope) => {
                const { columns: _c, ...rest } = rule;
                update(
                  i,
                  scope === 'row' ? rest : { ...rest, columns: [columns[0]?.name ?? 'value'] },
                  'Changed colour rule',
                );
              }}
              options={[
                { value: 'row', label: 'Whole row' },
                { value: 'some', label: 'Some columns' },
              ]}
            />
            {rule.columns?.length ? (
              <div className="flex flex-wrap gap-1.5">
                {columns.map((col) => {
                  const on = rule.columns!.includes(col.name);
                  return (
                    <button
                      key={col.name}
                      type="button"
                      aria-pressed={on}
                      onClick={() => {
                        const next = on
                          ? rule.columns!.filter((n) => n !== col.name)
                          : [...rule.columns!, col.name];
                        if (next.length) update(i, { ...rule, columns: next }, 'Changed colour rule');
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
            ) : null}
          </div>
          <Input
            aria-label="Rule name"
            placeholder="Name shown in tooltips, e.g. late orders"
            maxLength={60}
            className="h-8"
            value={rule.label ?? ''}
            onChange={(e) => {
              const { label: _l, ...rest } = rule;
              update(
                i,
                e.target.value ? { ...rule, label: e.target.value } : rest,
                'Changed colour rule',
                `rule-label-${i}`,
              );
            }}
          />
        </Card>
      ))}
      <Button
        size="sm"
        variant="ghost"
        icon={<Plus className="size-3.5" />}
        disabled={rules.length >= 6}
        onClick={() => save([...rules, starterRule(columns)], 'Added a colour rule')}
      >
        Add rule
      </Button>
    </Section>
  );
}

/** Dashboard-wide entity colours: one map every chart uses after its own. */
export function EntityColorsCard() {
  const canEdit = useEditor((s) => s.access?.canEdit ?? false);
  const colors = useEditor((s) => s.doc?.colors);
  const apply = useEditor((s) => s.apply);
  const [draft, setDraft] = useState('');
  if (!canEdit) return null;
  const map = colors ?? {};
  const save = (next: ColorMap, label: string) => {
    const err = apply([{ op: 'setMeta', colors: Object.keys(next).length ? next : null }], label);
    if (err) toast(err, 'bad');
  };
  const add = () => {
    const key = draft.trim();
    if (!key || key in map) return;
    const used = new Set(Object.values(map));
    const color: Color =
      ['accent-1', 'accent-2', 'accent-3', 'accent-4', 'accent-5', 'accent-6', 'accent-7', 'accent-8'].find(
        (t) => !used.has(t),
      ) ?? 'neutral';
    save({ ...map, [key]: color }, `Set the colour of "${key}"`);
    setDraft('');
  };
  return (
    <Card className="space-y-3 p-4">
      <div className="text-[13px] font-medium text-ink-2">Colours of things</div>
      <p className="text-xs text-muted">
        Give a city, product or other series the same colour in every chart. A chart's own colours win.
      </p>
      {Object.entries(map).map(([key, color]) => (
        <div key={key} className="flex flex-wrap items-start justify-between gap-2">
          <span className="min-w-0 truncate pt-1.5 text-[13px] text-ink-2" title={key}>
            {key}
          </span>
          <div className="flex items-center gap-1">
            <ColorPicker
              label={`Colour of ${key}`}
              value={color}
              onChange={(c) => save({ ...map, [key]: c }, `Changed the colour of "${key}"`)}
            />
            <IconButton
              label={`Remove ${key}`}
              className="size-7"
              onClick={() => {
                const { [key]: _removed, ...rest } = map;
                save(rest, `Removed the colour of "${key}"`);
              }}
            >
              <X className="size-3.5" />
            </IconButton>
          </div>
        </div>
      ))}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Input
          aria-label="Series value, column or label"
          placeholder="e.g. Bratislava"
          maxLength={200}
          className="h-8"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button size="sm" type="submit" disabled={!draft.trim() || draft.trim() in map}>
          Add
        </Button>
      </form>
    </Card>
  );
}
