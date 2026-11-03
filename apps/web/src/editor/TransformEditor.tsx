import {
  AGGREGATE_OPS,
  ExprError,
  FUNCTIONS,
  joinKeys,
  parse,
  TABLE_FUNCTION_ARGS,
  TABLE_FUNCTIONS,
  TIME_UNITS,
  type TransformInput,
  WINDOW_OPS,
} from '@patchbay/core';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button, cx, IconButton, Input, Select } from '../components/ui.tsx';
import { columnsAfter } from './columns.ts';
import { PRESETS, type PresetKind, presetColumnName, presetExpression } from './step-presets.ts';

type Step = TransformInput;

const STEP_LABELS: Record<Step['type'], { label: string; help: string }> = {
  filter: { label: 'Filter rows', help: 'Keep rows where the expression is true' },
  derive: { label: 'Add column', help: 'Compute a new column from an expression' },
  aggregate: { label: 'Group & aggregate', help: 'Group rows and compute sums, averages, counts…' },
  timeBucket: { label: 'Time bucket', help: 'Round times to hour/day/week/… (then aggregate)' },
  sort: { label: 'Sort', help: 'Order rows' },
  limit: { label: 'Limit', help: 'Keep the first or last N rows' },
  window: { label: 'Running calc', help: 'Rolling average, cumulative sum, change…' },
  select: { label: 'Keep columns', help: 'Keep only some columns' },
  drop: { label: 'Remove columns', help: 'Drop columns you do not need' },
  rename: { label: 'Rename', help: 'Rename a column' },
  fillNull: { label: 'Fill empty', help: 'Replace empty values with a constant' },
  join: { label: 'Look up columns', help: 'Add columns from another dataset where the keys match' },
  union: { label: 'Append rows', help: 'Add the rows of other datasets below these' },
};

/** What join and union need to know about the dashboard's other datasets. */
interface StepContext {
  datasets: { id: string; name: string }[];
  columnsOf: (id: string) => string[];
  self: { id: string; name: string } | undefined;
}

const DEFAULTS: Record<Step['type'], (cols: string[], ctx: StepContext) => Step> = {
  filter: () => ({ type: 'filter', expr: 'true' }),
  derive: () => ({ type: 'derive', as: 'new_column', expr: '1' }),
  aggregate: (c) => ({
    type: 'aggregate',
    groupBy: c[0] ? [c[0]] : [],
    metrics: [{ op: 'count', as: 'count' }],
  }),
  timeBucket: (c) => ({ type: 'timeBucket', field: c[0] ?? 'time', unit: 'day' }),
  sort: (c) => ({ type: 'sort', by: [{ field: c[0] ?? '', dir: 'asc' }] }),
  limit: () => ({ type: 'limit', n: 100, from: 'start' }),
  window: (c) => ({ type: 'window', op: 'rolling_avg', field: c[0] ?? '', size: 7 }),
  select: (c) => ({ type: 'select', fields: c.slice(0, 3) }),
  drop: (c) => ({ type: 'drop', fields: c.slice(0, 1) }),
  rename: (c) => ({ type: 'rename', map: c[0] ? { [c[0]]: `${c[0]}_renamed` } : {} }),
  fillNull: (c) => ({ type: 'fillNull', fields: c.slice(0, 1), value: 0 }),
  join: (c, { datasets, columnsOf }) => {
    const other = datasets[0]?.id ?? '';
    const theirs = columnsOf(other);
    // A column both sides have is the likeliest key.
    return { type: 'join', with: other, on: [c.find((x) => theirs.includes(x)) ?? c[0] ?? ''], how: 'left' };
  },
  union: (_c, { datasets }) => ({ type: 'union', with: datasets[0] ? [datasets[0].id] : [] }),
};

/**
 * A reference to an existing column. While the source's columns are unknown (still loading, or the preview failed
 * or is blocked) it is a plain text field, so the step stays editable; once they are known it is a select, and a
 * name that is not among them stays listed as missing so a broken reference is visible rather than swapped.
 */
function ColumnSelect({
  value,
  columns,
  onChange,
}: {
  value: string;
  columns: string[];
  onChange: (v: string) => void;
}) {
  if (columns.length === 0) {
    return (
      <Input
        aria-label="Column"
        value={value}
        placeholder="column"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 text-[13px]"
      />
    );
  }
  return (
    <Select
      aria-label="Column"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 text-[13px]"
    >
      {value === '' ? (
        <option value="" disabled>
          Pick a column
        </option>
      ) : columns.includes(value) ? null : (
        <option value={value}>{value} (missing)</option>
      )}
      {columns.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </Select>
  );
}

function ColumnChips({
  value,
  columns,
  onChange,
}: {
  value: string[];
  columns: string[];
  onChange: (v: string[]) => void;
}) {
  const all = [...new Set([...columns, ...value])];
  return (
    <div className="flex flex-wrap gap-1">
      {all.map((c) => {
        const on = value.includes(c);
        return (
          <button
            key={c}
            type="button"
            onClick={() => onChange(on ? value.filter((v) => v !== c) : [...value, c])}
            className={cx(
              'rounded-md border px-1.5 py-0.5 text-xs transition',
              on ? 'border-ink bg-ink text-page' : 'border-line text-ink-2 hover:border-ink-2',
            )}
          >
            {c}
          </button>
        );
      })}
    </div>
  );
}

function ExpressionInput({
  value,
  onChange,
  columns,
}: {
  value: string;
  onChange: (v: string) => void;
  columns: string[];
}) {
  const [showHelp, setShowHelp] = useState(false);
  const error = useMemo(() => {
    try {
      parse(value);
      return null;
    } catch (e) {
      return e instanceof ExprError ? e.message : 'Invalid expression';
    }
  }, [value]);
  return (
    <div className="space-y-1">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className={cx('h-8 font-mono text-[12.5px]', error && 'border-bad')}
      />
      <div className="flex items-start justify-between gap-2 text-[11px]">
        <span className={error ? 'text-bad' : 'text-muted'}>
          {error ?? `Columns: ${columns.slice(0, 8).join(', ')}${columns.length > 8 ? '…' : ''}`}
        </span>
        <button
          type="button"
          className="shrink-0 text-muted underline hover:text-ink"
          onClick={() => setShowHelp((v) => !v)}
        >
          {showHelp ? 'hide' : 'functions'}
        </button>
      </div>
      {showHelp ? (
        <div className="max-h-40 overflow-y-auto rounded-md bg-surface-2 p-2 font-mono text-[11px] text-ink-2">
          <div className="mb-1 font-sans text-muted">
            Operators: + - * / % ^ == != &lt; &gt; &amp;&amp; || ! and or not, cond ? a : b, `field with
            spaces`
          </div>
          {Object.entries(FUNCTIONS).map(([name, f]) => (
            <div key={name}>
              {name}({f.args}) <span className="font-sans text-muted">{f.doc}</span>
            </div>
          ))}
          <div className="mt-1 mb-1 font-sans text-muted">
            Whole table (the rows at this point in the pipeline):
          </div>
          {Object.entries(TABLE_FUNCTIONS).map(([name, f]) => (
            <div key={name}>
              {name}({TABLE_FUNCTION_ARGS}) <span className="font-sans text-muted">{f.doc}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** One-click expressions for the Add column step; the result is an ordinary expression the user can still edit. */
function DerivePresets({
  columns,
  onApply,
}: {
  columns: string[];
  onApply: (expr: string, as: string) => void;
}) {
  const [kind, setKind] = useState<PresetKind | null>(null);
  const [column, setColumn] = useState('');
  const [per, setPer] = useState('');
  if (!kind) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {(Object.keys(PRESETS) as PresetKind[]).map((k) => (
          <Button
            key={k}
            size="sm"
            variant="ghost"
            onClick={() => {
              setKind(k);
              setColumn(columns[0] ?? '');
              setPer('');
            }}
          >
            {PRESETS[k].label}
          </Button>
        ))}
      </div>
    );
  }
  return (
    <div className="space-y-1.5 rounded-lg bg-surface-2 p-2">
      <div className="grid grid-cols-2 gap-1.5">
        <ColumnSelect value={column} columns={columns} onChange={setColumn} />
        <Select
          aria-label="Per"
          value={per}
          onChange={(e) => setPer(e.target.value)}
          className="h-8 text-[13px]"
        >
          <option value="">over all rows</option>
          {columns
            .filter((c) => c !== column)
            .map((c) => (
              <option key={c} value={c}>
                per {c}
              </option>
            ))}
        </Select>
      </div>
      <p className="text-[11px] text-muted">{PRESETS[kind].help}</p>
      <div className="flex gap-1.5">
        <Button
          size="sm"
          disabled={!column}
          onClick={() => {
            onApply(presetExpression(kind, column, per || undefined), presetColumnName(kind, column));
            setKind(null);
          }}
        >
          Use
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setKind(null)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function StepFields({
  step,
  columns,
  ctx,
  onChange,
}: {
  step: Step;
  columns: string[];
  ctx: StepContext;
  onChange: (s: Step) => void;
}) {
  const row = 'grid grid-cols-2 gap-2';
  switch (step.type) {
    case 'filter':
      return (
        <ExpressionInput
          value={step.expr}
          columns={columns}
          onChange={(expr) => onChange({ ...step, expr })}
        />
      );
    case 'derive':
      return (
        <div className="space-y-2">
          <Input
            value={step.as}
            onChange={(e) => onChange({ ...step, as: e.target.value })}
            placeholder="new column name"
            className="h-8 text-[13px]"
          />
          <DerivePresets
            columns={columns}
            onApply={(expr, as) => onChange({ ...step, expr, ...(step.as === 'new_column' ? { as } : {}) })}
          />
          <ExpressionInput
            value={step.expr}
            columns={columns}
            onChange={(expr) => onChange({ ...step, expr })}
          />
        </div>
      );
    case 'select':
    case 'drop':
      return (
        <ColumnChips
          value={step.fields}
          columns={columns}
          onChange={(fields) => onChange({ ...step, fields })}
        />
      );
    case 'fillNull':
      return (
        <div className="space-y-2">
          <ColumnChips
            value={step.fields}
            columns={columns}
            onChange={(fields) => onChange({ ...step, fields })}
          />
          <Input
            value={String(step.value)}
            onChange={(e) =>
              onChange({
                ...step,
                value:
                  e.target.value !== '' && !Number.isNaN(Number(e.target.value))
                    ? Number(e.target.value)
                    : e.target.value,
              })
            }
            placeholder="value"
            className="h-8 text-[13px]"
          />
        </div>
      );
    case 'join': {
      const theirs = ctx.columnsOf(step.with);
      const keys = joinKeys(step.on);
      // A plain name when both sides use it, as agents write it too.
      const setKeys = (next: { left: string; right: string }[]) =>
        onChange({ ...step, on: next.map((k) => (k.left === k.right ? k.left : k)) });
      const rightKeys = new Set(keys.map((k) => k.right));
      const bringable = theirs.filter((c) => !rightKeys.has(c));
      return (
        <div className="space-y-2">
          <Select
            aria-label="From dataset"
            value={step.with}
            onChange={(e) => onChange({ ...step, with: e.target.value })}
            className="h-8 text-[13px]"
          >
            {ctx.datasets.some((d) => d.id === step.with) ? null : (
              <option value={step.with}>{step.with} (missing)</option>
            )}
            {ctx.datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
          <div className="text-[11px] text-muted">Match (this dataset = the other)</div>
          {keys.map((k, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional list
            <div key={i} className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-1.5">
              <ColumnSelect
                value={k.left}
                columns={columns}
                onChange={(left) => setKeys(keys.map((x, j) => (j === i ? { ...x, left } : x)))}
              />
              <span className="text-muted">=</span>
              <ColumnSelect
                value={k.right}
                columns={theirs}
                onChange={(right) => setKeys(keys.map((x, j) => (j === i ? { ...x, right } : x)))}
              />
              <IconButton
                label="Remove"
                disabled={keys.length === 1}
                onClick={() => setKeys(keys.filter((_, j) => j !== i))}
              >
                <Trash2 className="size-3.5" />
              </IconButton>
            </div>
          ))}
          {keys.length < 4 ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setKeys([...keys, { left: columns[0] ?? '', right: theirs[0] ?? '' }])}
            >
              + key
            </Button>
          ) : null}
          <Select
            aria-label="Keep"
            value={step.how ?? 'left'}
            onChange={(e) => onChange({ ...step, how: e.target.value as 'left' | 'inner' })}
            className="h-8 text-[13px]"
          >
            <option value="left">All my rows</option>
            <option value="inner">Only rows with a match</option>
          </Select>
          <div className="text-[11px] text-muted">Columns to bring</div>
          <ColumnChips
            value={step.fields ?? bringable}
            columns={bringable}
            onChange={(fields) => {
              const { fields: _all, ...rest } = step;
              // All of them is the default: stored as no list, so columns added to the other dataset later come too.
              const all = fields.length === bringable.length && bringable.every((c) => fields.includes(c));
              onChange(all ? rest : { ...rest, fields });
            }}
          />
        </div>
      );
    }
    case 'union': {
      const sources = [
        ...(ctx.self ? [ctx.self] : []),
        ...step.with.map((id) => ({ id, name: ctx.datasets.find((d) => d.id === id)?.name ?? id })),
      ];
      return (
        <div className="space-y-2">
          <div className="text-[11px] text-muted">Datasets</div>
          <div className="flex flex-wrap gap-1">
            {ctx.datasets.map((d) => {
              const on = step.with.includes(d.id);
              return (
                <button
                  key={d.id}
                  type="button"
                  disabled={!on && step.with.length >= 4}
                  onClick={() => {
                    const next = on ? step.with.filter((x) => x !== d.id) : [...step.with, d.id];
                    if (next.length) onChange({ ...step, with: next });
                  }}
                  className={cx(
                    'rounded-md border px-1.5 py-0.5 text-xs transition disabled:opacity-40',
                    on ? 'border-ink bg-ink text-page' : 'border-line text-ink-2 hover:border-ink-2',
                  )}
                >
                  {d.name}
                </button>
              );
            })}
          </div>
          <Input
            value={step.origin ?? ''}
            placeholder="Name the origin in a column (optional)"
            onChange={(e) => {
              const { origin: _o, labels: _l, ...rest } = step;
              const origin = e.target.value;
              if (!origin) return onChange(rest);
              // Explicit labels keep series values, and so their colours, when a dataset is renamed later.
              const labels =
                step.labels ?? Object.fromEntries(sources.map((s) => [s.id, s.name.slice(0, 80)]));
              onChange({ ...rest, origin, labels });
            }}
            className="h-8 text-[13px]"
          />
          {step.origin
            ? sources.map((s) => (
                <div key={s.id} className="grid grid-cols-2 items-center gap-1.5">
                  <span className="truncate text-xs text-muted">{s.name}</span>
                  <Input
                    value={step.labels?.[s.id] ?? ''}
                    placeholder={s.name}
                    onChange={(e) => {
                      const labels = { ...step.labels };
                      if (e.target.value) labels[s.id] = e.target.value.slice(0, 80);
                      else delete labels[s.id];
                      const { labels: _old, ...rest } = step;
                      onChange(Object.keys(labels).length ? { ...rest, labels } : rest);
                    }}
                    className="h-8 text-[13px]"
                  />
                </div>
              ))
            : null}
        </div>
      );
    }
    case 'rename': {
      const entries = Object.entries(step.map);
      return (
        <div className="space-y-1.5">
          {entries.map(([from, to], i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: editing keys in place
            <div key={i} className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-1.5">
              <ColumnSelect
                value={from}
                columns={columns}
                onChange={(v) =>
                  onChange({
                    ...step,
                    map: Object.fromEntries(entries.map(([f, t], j) => (j === i ? [v, t] : [f, t]))),
                  })
                }
              />
              <span className="text-muted">→</span>
              <Input
                value={to}
                onChange={(e) => onChange({ ...step, map: { ...step.map, [from]: e.target.value } })}
                className="h-8 text-[13px]"
              />
              <IconButton
                label="Remove"
                onClick={() =>
                  onChange({ ...step, map: Object.fromEntries(entries.filter((_, j) => j !== i)) })
                }
              >
                <Trash2 className="size-3.5" />
              </IconButton>
            </div>
          ))}
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              onChange({
                ...step,
                map: { ...step.map, [columns.find((c) => !(c in step.map)) ?? 'column']: 'new_name' },
              })
            }
          >
            Add rename
          </Button>
        </div>
      );
    }
    case 'sort':
      return (
        <div className="space-y-1.5">
          {step.by.map((b, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional list
            <div key={i} className="grid grid-cols-[1fr_110px_auto] gap-1.5">
              <ColumnSelect
                value={b.field}
                columns={columns}
                onChange={(field) =>
                  onChange({ ...step, by: step.by.map((x, j) => (j === i ? { ...x, field } : x)) })
                }
              />
              <Select
                value={b.dir ?? 'asc'}
                onChange={(e) =>
                  onChange({
                    ...step,
                    by: step.by.map((x, j) =>
                      j === i ? { ...x, dir: e.target.value as 'asc' | 'desc' } : x,
                    ),
                  })
                }
                className="h-8 text-[13px]"
              >
                <option value="asc">ascending</option>
                <option value="desc">descending</option>
              </Select>
              <IconButton
                label="Remove"
                disabled={step.by.length === 1}
                onClick={() => onChange({ ...step, by: step.by.filter((_, j) => j !== i) })}
              >
                <Trash2 className="size-3.5" />
              </IconButton>
            </div>
          ))}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onChange({ ...step, by: [...step.by, { field: columns[0] ?? '', dir: 'asc' }] })}
          >
            Then by…
          </Button>
        </div>
      );
    case 'limit':
      return (
        <div className={row}>
          <Input
            type="number"
            min={1}
            value={step.n}
            onChange={(e) => onChange({ ...step, n: Math.max(1, Number(e.target.value) || 1) })}
            className="h-8 text-[13px]"
          />
          <Select
            value={step.from ?? 'start'}
            onChange={(e) => onChange({ ...step, from: e.target.value as 'start' | 'end' })}
            className="h-8 text-[13px]"
          >
            <option value="start">first rows</option>
            <option value="end">last rows</option>
          </Select>
        </div>
      );
    case 'timeBucket':
      return (
        <div className={row}>
          <ColumnSelect
            value={step.field}
            columns={columns}
            onChange={(field) => onChange({ ...step, field })}
          />
          <Select
            value={step.unit}
            onChange={(e) => onChange({ ...step, unit: e.target.value as (typeof TIME_UNITS)[number] })}
            className="h-8 text-[13px]"
          >
            {TIME_UNITS.map((u) => (
              <option key={u} value={u}>
                per {u}
              </option>
            ))}
          </Select>
          <Select
            value={step.dropPartial ? 'drop' : 'keep'}
            onChange={(e) => {
              const { dropPartial: _off, ...rest } = step;
              onChange(e.target.value === 'drop' ? { ...rest, dropPartial: true } : rest);
            }}
            className="h-8 text-[13px]"
            title="The first and last bucket are often only partly covered by the data (a rolling window), which looks like a sudden drop"
          >
            <option value="keep">all buckets</option>
            <option value="drop">complete buckets only</option>
          </Select>
        </div>
      );
    case 'window':
      return (
        <div className="space-y-2">
          <div className={row}>
            <Select
              value={step.op}
              onChange={(e) => onChange({ ...step, op: e.target.value as (typeof WINDOW_OPS)[number] })}
              className="h-8 text-[13px]"
            >
              {WINDOW_OPS.map((o) => (
                <option key={o} value={o}>
                  {o.replace('_', ' ')}
                </option>
              ))}
            </Select>
            <ColumnSelect
              value={step.field}
              columns={columns}
              onChange={(field) => onChange({ ...step, field })}
            />
          </div>
          <div className={row}>
            {step.op.startsWith('rolling') ? (
              <Input
                type="number"
                min={2}
                value={step.size ?? 7}
                onChange={(e) => onChange({ ...step, size: Math.max(2, Number(e.target.value) || 2) })}
                className="h-8 text-[13px]"
                title="Window size (rows)"
              />
            ) : (
              <span />
            )}
            <Input
              value={step.as ?? ''}
              placeholder={`${step.op}_${step.field}`}
              onChange={(e) => onChange({ ...step, as: e.target.value || undefined })}
              className="h-8 text-[13px]"
            />
          </div>
        </div>
      );
    case 'aggregate':
      return (
        <div className="space-y-2">
          <div className="text-[11px] text-muted">Group by</div>
          <ColumnChips
            value={step.groupBy ?? []}
            columns={columns}
            onChange={(groupBy) => onChange({ ...step, groupBy })}
          />
          <div className="text-[11px] text-muted">Metrics</div>
          {step.metrics.map((m, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional list
            <div key={i} className="grid grid-cols-[110px_1fr_1fr_auto] gap-1.5">
              <Select
                value={m.op}
                onChange={(e) =>
                  onChange({
                    ...step,
                    metrics: step.metrics.map((x, j) =>
                      j === i ? { ...x, op: e.target.value as (typeof AGGREGATE_OPS)[number] } : x,
                    ),
                  })
                }
                className="h-8 text-[13px]"
              >
                {AGGREGATE_OPS.map((o) => (
                  <option key={o} value={o}>
                    {o.replace('_', ' ')}
                  </option>
                ))}
              </Select>
              {m.op === 'count' ? (
                <span className="self-center text-xs text-muted">rows</span>
              ) : (
                <ColumnSelect
                  value={m.field ?? ''}
                  columns={columns}
                  onChange={(field) =>
                    onChange({
                      ...step,
                      metrics: step.metrics.map((x, j) => (j === i ? { ...x, field } : x)),
                    })
                  }
                />
              )}
              <Input
                value={m.as ?? ''}
                placeholder={m.field ? `${m.op}_${m.field}` : m.op}
                onChange={(e) =>
                  onChange({
                    ...step,
                    metrics: step.metrics.map((x, j) =>
                      j === i ? { ...x, as: e.target.value || undefined } : x,
                    ),
                  })
                }
                className="h-8 text-[13px]"
              />
              <IconButton
                label="Remove"
                disabled={step.metrics.length === 1}
                onClick={() => onChange({ ...step, metrics: step.metrics.filter((_, j) => j !== i) })}
              >
                <Trash2 className="size-3.5" />
              </IconButton>
            </div>
          ))}
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              onChange({
                ...step,
                metrics: [...step.metrics, { op: 'sum', field: columns.find(Boolean) ?? '' }],
              })
            }
          >
            Add metric
          </Button>
        </div>
      );
  }
}

export function TransformEditor({
  steps,
  baseColumns,
  trace,
  datasets = [],
  columnsOf = () => [],
  self,
  onChange,
}: {
  steps: Step[];
  baseColumns: string[];
  trace?: { step: number; rows: number }[] | undefined;
  datasets?: { id: string; name: string }[];
  columnsOf?: (id: string) => string[];
  self?: { id: string; name: string } | undefined;
  onChange: (steps: Step[]) => void;
}) {
  const ctx: StepContext = { datasets, columnsOf, self };
  const [adding, setAdding] = useState(false);
  const update = (i: number, s: Step) => onChange(steps.map((x, j) => (j === i ? s : x)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...steps];
    const [s] = next.splice(i, 1);
    next.splice(i + d, 0, s!);
    onChange(next);
  };
  return (
    <div className="space-y-2">
      {steps.length === 0 ? (
        <p className="text-xs text-muted">No processing: the data is used as it comes.</p>
      ) : null}
      {steps.map((step, i) => {
        const cols = columnsAfter(baseColumns, steps.slice(0, i), columnsOf);
        const rows = trace?.find((t) => t.step === i)?.rows;
        return (
          <div key={step.id ?? `new-${i}`} className="rounded-xl border border-line bg-surface p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="flex size-5 items-center justify-center rounded-full bg-surface-2 text-[11px] font-semibold text-ink-2">
                {i + 1}
              </span>
              <span className="text-[13px] font-medium">{STEP_LABELS[step.type].label}</span>
              {rows !== undefined ? (
                <span className="tabular text-[11px] text-muted">→ {rows.toLocaleString('en')} rows</span>
              ) : null}
              <span className="flex-1" />
              <IconButton label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp className="size-3.5" />
              </IconButton>
              <IconButton label="Move down" disabled={i === steps.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown className="size-3.5" />
              </IconButton>
              <IconButton label="Remove step" onClick={() => onChange(steps.filter((_, j) => j !== i))}>
                <Trash2 className="size-3.5" />
              </IconButton>
            </div>
            <StepFields step={step} columns={cols} ctx={ctx} onChange={(s) => update(i, s)} />
          </div>
        );
      })}
      {adding ? (
        <div className="grid grid-cols-2 gap-1.5 rounded-xl border border-dashed border-line-strong p-2">
          {/* Join and union read other datasets: nothing to offer on a dashboard with only this one. */}
          {(Object.keys(STEP_LABELS) as Step['type'][])
            .filter((type) => (type !== 'join' && type !== 'union') || datasets.length > 0)
            .map((type) => (
              <button
                key={type}
                type="button"
                className="rounded-lg px-2.5 py-2 text-left hover:bg-surface-2"
                onClick={() => {
                  onChange([...steps, DEFAULTS[type](columnsAfter(baseColumns, steps, columnsOf), ctx)]);
                  setAdding(false);
                }}
              >
                <div className="text-[13px] font-medium">{STEP_LABELS[type].label}</div>
                <div className="text-[11px] text-muted">{STEP_LABELS[type].help}</div>
              </button>
            ))}
        </div>
      ) : (
        <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setAdding(true)}>
          Add step
        </Button>
      )}
    </div>
  );
}
