/**
 * The filter bar (proposal 0010): one control per declared filter, under the dashboard header. Values live in the page
 * URL (state/parameters.ts), never in the document, so a change creates no version and other viewers do not see it.
 * Read-only viewers use it like editors. Below `sm` it folds into a "Filters (n)" button that opens a sheet.
 */
import { DATE_PRESET_LABELS, defaultText, type OptionValue, type Parameter } from '@patchbay/core';
import { SlidersHorizontal, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button, Drawer, IconButton, Input, Select, toast, useNarrowScreen } from '../components/ui.tsx';
import { useEditor } from '../state/editor.ts';
import { heldDataValue, type RawValues, summaryOf, useParameters } from '../state/parameters.ts';
import { useDataChoices } from './DataOptions.tsx';

const CUSTOM = 'custom';
/** Typing in a search filter applies after this pause, or at once on Enter. */
const TEXT_DELAY_MS = 400;

export function FilterBar({ dashboardId, live }: { dashboardId: string; live: boolean }) {
  const parameters = useEditor((s) => s.doc?.parameters);
  const raw = useParameters((s) => s.raw);
  const narrow = useNarrowScreen();
  const [open, setOpen] = useState(false);
  if (!parameters?.length) return null;
  const changed = parameters.filter((p) => Object.hasOwn(raw, p.id)).length;
  const reset = () => useParameters.getState().reset();
  const controls = parameters.map((p) => (
    <FilterControl
      key={p.id}
      dashboardId={dashboardId}
      live={live}
      parameter={p}
      parameters={parameters}
      raw={raw}
    />
  ));
  if (narrow) {
    return (
      <div className="mb-3">
        <Button
          size="sm"
          aria-label={changed ? `Filters, ${changed} set` : 'Filters'}
          icon={<SlidersHorizontal className="size-4" />}
          onClick={() => setOpen(true)}
        >
          {changed ? `Filters (${changed})` : 'Filters'}
        </Button>
        <Drawer
          open={open}
          onClose={() => setOpen(false)}
          title="Filters"
          footer={changed ? <Button onClick={reset}>Reset filters</Button> : undefined}
        >
          <div className="space-y-4">{controls}</div>
        </Drawer>
      </div>
    );
  }
  return (
    <fieldset className="mb-3 flex min-w-0 flex-wrap items-end gap-x-4 gap-y-2 border-0 p-0">
      <legend className="sr-only">Filters</legend>
      {controls}
      {changed ? (
        <Button size="sm" variant="ghost" onClick={reset}>
          Reset filters
        </Button>
      ) : null}
    </fieldset>
  );
}

/**
 * Presentation mode's line instead of the bar: a wall screen showing a filtered subset must say which, also once the
 * controls fade out on idle. Nothing in it is interactive.
 */
export function ParameterSummary() {
  const parameters = useEditor((s) => s.doc?.parameters);
  const raw = useParameters((s) => s.raw);
  const text = summaryOf(parameters, raw);
  return text ? <p className="mb-2 text-xs font-medium text-ink-2">{text}</p> : null;
}

function FilterControl({
  dashboardId,
  live,
  parameter: p,
  parameters,
  raw,
}: {
  dashboardId: string;
  live: boolean;
  parameter: Parameter;
  parameters: readonly Parameter[];
  raw: RawValues;
}) {
  const { options: dataOptions, failed } = useDataChoices(dashboardId, p, live);
  const changed = Object.hasOwn(raw, p.id);
  const text = changed ? raw[p.id]! : defaultText(p);
  // Stable, so the text control's debounce restarts only when the filter changes, not on every parent render.
  const apply = useCallback(
    (next: string | null) => {
      const problem = useParameters.getState().set(p.id, next, parameters);
      if (problem) toast(problem, 'bad');
    },
    [p.id, parameters],
  );
  const loading = p.type === 'select' && Boolean(p.optionsFrom) && dataOptions === null && !failed;
  // A link's value the choices do not list stays visible, so the bar never reads "All" for a filtered view. It is
  // only selectable while the choices load; after a failure no value can be checked, so All is the only choice.
  const held = heldDataValue(p, raw, { options: dataOptions, failed });
  const choices: { value: OptionValue; label?: string }[] =
    p.type === 'select'
      ? p.optionsFrom
        ? (dataOptions ?? []).map((value) => ({ value }))
        : (p.options ?? [])
      : [];
  const id = `filter-${p.id}`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted">
        {p.label}
      </label>
      <div className="flex items-center gap-1">
        {p.type === 'select' ? (
          <Select
            id={id}
            value={text}
            disabled={loading}
            onChange={(e) => apply(e.target.value)}
            className="h-8 w-auto min-w-32 text-[13px]"
          >
            {p.all ? <option value="*">{p.all}</option> : null}
            {held !== null ? (
              <option value={held} disabled={!loading}>
                {held}
              </option>
            ) : null}
            {choices.map((o) => (
              <option key={String(o.value)} value={String(o.value)}>
                {o.label ?? String(o.value)}
              </option>
            ))}
          </Select>
        ) : p.type === 'text' ? (
          <TextControl id={id} placeholder={p.placeholder} text={text} onChange={apply} />
        ) : (
          <DateControl id={id} parameter={p} text={text} onChange={apply} />
        )}
        {changed ? (
          <IconButton label={`Reset ${p.label}`} onClick={() => apply(null)}>
            <X className="size-3.5" />
          </IconButton>
        ) : null}
      </div>
    </div>
  );
}

function TextControl({
  id,
  placeholder,
  text,
  onChange,
}: {
  id: string;
  placeholder: string | undefined;
  text: string;
  onChange: (text: string) => void;
}) {
  const [draft, setDraft] = useState(text);
  // A reset, Back or another tab changes the value from outside: the field follows.
  useEffect(() => setDraft(text), [text]);
  useEffect(() => {
    if (draft.trim() === text) return;
    const timer = setTimeout(() => onChange(draft), TEXT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft, text, onChange]);
  return (
    <Input
      id={id}
      type="search"
      value={draft}
      maxLength={100}
      placeholder={placeholder ?? 'Search'}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onChange(draft);
      }}
      className="h-8 w-48 text-[13px]"
    />
  );
}

function DateControl({
  id,
  parameter: p,
  text,
  onChange,
}: {
  id: string;
  parameter: Extract<Parameter, { type: 'dateRange' }>;
  text: string;
  onChange: (text: string) => void;
}) {
  const range = text.includes('..') ? text.split('..') : null;
  const [custom, setCustom] = useState(range !== null);
  const [from, setFrom] = useState(range?.[0] ?? '');
  const [to, setTo] = useState(range?.[1] ?? '');
  useEffect(() => {
    const next = text.includes('..') ? text.split('..') : null;
    setCustom(next !== null);
    if (next) {
      setFrom(next[0]!);
      setTo(next[1]!);
    }
  }, [text]);
  const applyRange = (f: string, t: string) => {
    if (f && t) onChange(`${f}..${t}`);
  };
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Select
        id={id}
        value={custom ? CUSTOM : text}
        onChange={(e) => {
          if (e.target.value === CUSTOM) setCustom(true);
          else {
            setCustom(false);
            onChange(e.target.value);
          }
        }}
        className="h-8 w-auto min-w-36 text-[13px]"
      >
        {p.presets.map((preset) => (
          <option key={preset} value={preset}>
            {DATE_PRESET_LABELS[preset]}
          </option>
        ))}
        {p.custom ? <option value={CUSTOM}>Custom range…</option> : null}
      </Select>
      {custom ? (
        <>
          <Input
            type="date"
            aria-label={`${p.label}: first day`}
            value={from}
            min={p.min}
            max={p.max}
            onChange={(e) => {
              setFrom(e.target.value);
              applyRange(e.target.value, to);
            }}
            className="h-8 w-36 text-[13px]"
          />
          <span className="text-xs text-muted">to</span>
          <Input
            type="date"
            aria-label={`${p.label}: last day`}
            value={to}
            min={p.min}
            max={p.max}
            onChange={(e) => {
              setTo(e.target.value);
              applyRange(from, e.target.value);
            }}
            className="h-8 w-36 text-[13px]"
          />
        </>
      ) : null}
    </div>
  );
}
