import {
  AGGREGATE_OPS,
  ExprError,
  FUNCTIONS,
  parse,
  TIME_UNITS,
  type TransformInput,
  WINDOW_OPS,
} from '@patchbay/core';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { Button, cx, IconButton, Input, Select } from '../components/ui.tsx';

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
};

const DEFAULTS: Record<Step['type'], (cols: string[]) => Step> = {
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
};

/** Column names available after the given steps (approximate, for autocompletion). */
export function columnsAfter(base: string[], steps: Step[]): string[] {
  let cols = [...base];
  for (const s of steps) {
    switch (s.type) {
      case 'derive':
        if (!cols.includes(s.as)) cols.push(s.as);
        break;
      case 'select':
        cols = [...s.fields];
        break;
      case 'drop':
        cols = cols.filter((c) => !s.fields.includes(c));
        break;
      case 'rename':
        cols = cols.map((c) => s.map[c] ?? c);
        break;
      case 'aggregate':
        cols = [
          ...(s.groupBy ?? []),
          ...s.metrics.map((m) => m.as ?? (m.field ? `${m.op}_${m.field}` : m.op)),
        ];
        break;
      case 'timeBucket':
        if (s.as && !cols.includes(s.as)) cols.push(s.as);
        break;
      case 'window': {
        const as = s.as ?? `${s.op}_${s.field}`;
        if (!cols.includes(as)) cols.push(as);
        break;
      }
    }
  }
  return cols;
}

function ColumnInput({
  value,
  columns,
  onChange,
  placeholder,
}: {
  value: string;
  columns: string[];
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <>
      <Input
        list={id}
        value={value}
        placeholder={placeholder ?? 'column'}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 text-[13px]"
      />
      <datalist id={id}>
        {columns.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
    </>
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
        </div>
      ) : null}
    </div>
  );
}

function StepFields({
  step,
  columns,
  onChange,
}: {
  step: Step;
  columns: string[];
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
    case 'rename': {
      const entries = Object.entries(step.map);
      return (
        <div className="space-y-1.5">
          {entries.map(([from, to], i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: editing keys in place
            <div key={i} className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-1.5">
              <ColumnInput
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
              <ColumnInput
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
          <ColumnInput
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
            <ColumnInput
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
                <ColumnInput
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
  onChange,
}: {
  steps: Step[];
  baseColumns: string[];
  trace?: { step: number; rows: number }[] | undefined;
  onChange: (steps: Step[]) => void;
}) {
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
        const cols = columnsAfter(baseColumns, steps.slice(0, i));
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
            <StepFields step={step} columns={cols} onChange={(s) => update(i, s)} />
          </div>
        );
      })}
      {adding ? (
        <div className="grid grid-cols-2 gap-1.5 rounded-xl border border-dashed border-line-strong p-2">
          {(Object.keys(STEP_LABELS) as Step['type'][]).map((type) => (
            <button
              key={type}
              type="button"
              className="rounded-lg px-2.5 py-2 text-left hover:bg-surface-2"
              onClick={() => {
                onChange([...steps, DEFAULTS[type](columnsAfter(baseColumns, steps))]);
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
