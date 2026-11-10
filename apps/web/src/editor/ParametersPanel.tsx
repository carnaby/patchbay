/**
 * The Filters panel (proposal 0010): editors declare, change, reorder and remove the dashboard's filters. Every change
 * is an operation through the editor store (applyOps), so it is versioned, undoable and rebased like any other edit.
 */
import {
  DATE_PRESET_LABELS,
  DATE_PRESETS,
  type DatePreset,
  type OpInput,
  type Parameter,
} from '@patchbay/core';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Drawer,
  Field,
  IconButton,
  Input,
  Menu,
  MenuItem,
  Select,
  Textarea,
  Toggle,
  toast,
} from '../components/ui.tsx';
import { useEditor } from '../state/editor.ts';
import { summaryOf, useParameters } from '../state/parameters.ts';
import {
  checkParameter,
  defaultOps,
  idFromLabel,
  newParameter,
  type OptionInput,
  optionsText,
  type ParameterType,
  parseOptions,
  TYPE_LABELS,
  updateOps,
  usageText,
} from './parameter-form.ts';

type Editing = { parameter: Parameter; isNew: boolean } | null;

export function ParametersPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const doc = useEditor((s) => s.doc);
  const apply = useEditor((s) => s.apply);
  const raw = useParameters((s) => s.raw);
  const [editing, setEditing] = useState<Editing>(null);
  useEffect(() => {
    if (!open) setEditing(null);
  }, [open]);
  const parameters = doc?.parameters ?? [];
  const run = (ops: OpInput[], label: string) => {
    if (ops.length === 0) return true;
    const error = apply(ops, label);
    if (error) toast(error, 'bad');
    return !error;
  };
  const taken = new Set(parameters.map((p) => p.id));
  const add = (type: ParameterType) => setEditing({ parameter: newParameter(type, taken), isNew: true });

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={editing ? (editing.isNew ? 'Add filter' : `Edit "${editing.parameter.label}"`) : 'Filters'}
    >
      {editing ? (
        <ParameterForm
          key={editing.parameter.id}
          initial={editing.parameter}
          isNew={editing.isNew}
          others={parameters.filter((p) => editing.isNew || p.id !== editing.parameter.id)}
          onCancel={() => setEditing(null)}
          onSave={(parameter) => {
            const ops: OpInput[] = editing.isNew
              ? [{ op: 'addParameter', parameter }]
              : updateOps(editing.parameter, parameter);
            if (
              run(
                ops,
                editing.isNew ? `Added filter "${parameter.label}"` : `Edited filter "${parameter.label}"`,
              )
            )
              setEditing(null);
          }}
        />
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-ink-2">
            Filters let every viewer switch what the dashboard shows (a region, a period, a search) from the
            bar under its header. Datasets use them as $param.&lt;id&gt;. Their values live in the page's
            link, never in the dashboard.
          </p>
          {parameters.map((p, i) => {
            const used = doc ? usageText(doc, p.id) : null;
            return (
              <Card key={p.id} className="flex items-center gap-2 p-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{p.label}</div>
                  <div className="truncate text-xs text-muted">
                    <span className="font-mono">$param.{p.id}</span> · {used ?? 'Not used yet'}
                  </div>
                </div>
                <Badge>{TYPE_LABELS[p.type]}</Badge>
                <IconButton
                  label="Move up"
                  disabled={i === 0}
                  onClick={() =>
                    run(
                      [{ op: 'moveParameter', id: p.id, before: parameters[i - 1]!.id }],
                      `Moved filter "${p.label}"`,
                    )
                  }
                >
                  <ArrowUp className="size-3.5" />
                </IconButton>
                <IconButton
                  label="Move down"
                  disabled={i === parameters.length - 1}
                  onClick={() =>
                    run(
                      [{ op: 'moveParameter', id: p.id, before: parameters[i + 2]?.id ?? null }],
                      `Moved filter "${p.label}"`,
                    )
                  }
                >
                  <ArrowDown className="size-3.5" />
                </IconButton>
                <IconButton label="Edit filter" onClick={() => setEditing({ parameter: p, isNew: false })}>
                  <Pencil className="size-3.5" />
                </IconButton>
                <IconButton
                  label="Remove filter"
                  disabled={used !== null}
                  title={used ? `${used}. Remove those references first.` : 'Remove filter'}
                  onClick={() => run([{ op: 'removeParameter', id: p.id }], `Removed filter "${p.label}"`)}
                >
                  <Trash2 className="size-3.5" />
                </IconButton>
              </Card>
            );
          })}
          <div className="flex flex-wrap items-center gap-2">
            <Menu label="Add filter" icon={<Plus className="size-4" />}>
              {(['select', 'text', 'dateRange'] as const).map((type) => (
                <MenuItem key={type} onSelect={() => add(type)}>
                  {TYPE_LABELS[type]}
                </MenuItem>
              ))}
            </Menu>
            {Object.keys(raw).length > 0 ? (
              <Button
                size="sm"
                onClick={() => run(defaultOps(parameters, raw), 'Made the current filter values the default')}
                title={summaryOf(parameters, raw, true)}
              >
                Make current values the default
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </Drawer>
  );
}

function ParameterForm({
  initial,
  isNew,
  others,
  onSave,
  onCancel,
}: {
  initial: Parameter;
  isNew: boolean;
  others: readonly Parameter[];
  onSave: (parameter: Parameter) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, unknown>>(initial);
  const [idTouched, setIdTouched] = useState(!isNew);
  const [optionsDraft, setOptionsDraft] = useState(() =>
    initial.type === 'select' ? optionsText(initial.options) : '',
  );
  const taken = useMemo(() => new Set(others.map((p) => p.id)), [others]);
  const check = checkParameter(draft, others);
  /** Merges a patch; undefined removes a field, as the save's updateParameter would. */
  const set = (patch: Record<string, unknown>) =>
    setDraft((d) => {
      const next = { ...d, ...patch };
      for (const [key, value] of Object.entries(patch)) if (value === undefined) delete next[key];
      return next;
    });
  const text = (key: string) => (typeof draft[key] === 'string' ? (draft[key] as string) : '');

  return (
    <div className="space-y-4">
      <Field label="Label">
        {(fid) => (
          <Input
            id={fid}
            value={text('label')}
            maxLength={40}
            onChange={(e) =>
              set({ label: e.target.value, ...(idTouched ? {} : { id: idFromLabel(e.target.value, taken) }) })
            }
          />
        )}
      </Field>
      <Field
        label="Id"
        hint={
          isNew
            ? 'Datasets use it as $param.<id>. It cannot change once saved.'
            : `Datasets use it as $param.${initial.id}. To rename it, add a new filter and move the references.`
        }
      >
        {(fid) => (
          <Input
            id={fid}
            value={text('id')}
            disabled={!isNew}
            spellCheck={false}
            className="font-mono"
            onChange={(e) => {
              setIdTouched(true);
              set({ id: e.target.value });
            }}
          />
        )}
      </Field>
      {initial.type === 'select' ? (
        <SelectFields draft={draft} set={set} optionsDraft={optionsDraft} setOptionsDraft={setOptionsDraft} />
      ) : initial.type === 'text' ? (
        <>
          <Field label="Placeholder (optional)">
            {(fid) => (
              <Input
                id={fid}
                value={text('placeholder')}
                maxLength={60}
                onChange={(e) => set({ placeholder: e.target.value || undefined })}
              />
            )}
          </Field>
          <Field label="Default (usually empty)">
            {(fid) => (
              <Input
                id={fid}
                value={text('default')}
                maxLength={100}
                onChange={(e) => set({ default: e.target.value })}
              />
            )}
          </Field>
        </>
      ) : (
        <DateFields draft={draft} set={set} />
      )}
      {'error' in check ? <p className="text-xs text-bad">{check.error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={'error' in check}
          onClick={() => {
            if ('parameter' in check) onSave(check.parameter);
          }}
        >
          Save filter
        </Button>
      </div>
    </div>
  );
}

function SelectFields({
  draft,
  set,
  optionsDraft,
  setOptionsDraft,
}: {
  draft: Record<string, unknown>;
  set: (patch: Record<string, unknown>) => void;
  optionsDraft: string;
  setOptionsDraft: (text: string) => void;
}) {
  const options = (draft.options as OptionInput[] | undefined) ?? [];
  const all = typeof draft.all === 'string' ? draft.all : undefined;
  return (
    <>
      <Field label="Options" hint='One per line: a value, or "value | Label". Values appear in links.'>
        {(fid) => (
          <Textarea
            id={fid}
            rows={Math.min(10, Math.max(3, optionsDraft.split('\n').length + 1))}
            value={optionsDraft}
            spellCheck={false}
            onChange={(e) => {
              setOptionsDraft(e.target.value);
              set({ options: parseOptions(e.target.value, options) });
            }}
          />
        )}
      </Field>
      <Toggle
        checked={all !== undefined}
        label='Offer "All"'
        onChange={(on) =>
          set({
            all: on ? 'All' : undefined,
            ...(on || draft.default !== null ? {} : { default: options[0]?.value ?? null }),
          })
        }
      />
      {all !== undefined ? (
        <Field label='Label of "All"'>
          {(fid) => (
            <Input id={fid} value={all} maxLength={40} onChange={(e) => set({ all: e.target.value })} />
          )}
        </Field>
      ) : null}
      <Field label="Default">
        {(fid) => (
          <Select
            id={fid}
            value={draft.default === null ? '*' : String(draft.default)}
            onChange={(e) => {
              const v = e.target.value;
              set({ default: v === '*' ? null : (options.find((o) => String(o.value) === v)?.value ?? v) });
            }}
          >
            {all !== undefined ? <option value="*">{all}</option> : null}
            {options.map((o) => (
              <option key={String(o.value)} value={String(o.value)}>
                {o.label ?? String(o.value)}
              </option>
            ))}
          </Select>
        )}
      </Field>
    </>
  );
}

function DateFields({
  draft,
  set,
}: {
  draft: Record<string, unknown>;
  set: (patch: Record<string, unknown>) => void;
}) {
  const presets = (draft.presets as DatePreset[] | undefined) ?? [];
  const custom = draft.custom === true;
  const range =
    typeof draft.default === 'object' && draft.default !== null
      ? (draft.default as { from: string; to: string })
      : null;
  const today = new Date().toISOString().slice(0, 10);
  return (
    <>
      <fieldset className="m-0 space-y-1.5 border-0 p-0">
        <legend className="mb-1.5 block p-0 text-[13px] font-medium text-ink-2">Presets</legend>
        <div className="grid grid-cols-2 gap-1">
          {DATE_PRESETS.map((preset) => (
            <label key={preset} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={presets.includes(preset)}
                onChange={(e) =>
                  set({
                    presets: DATE_PRESETS.filter((x) =>
                      x === preset ? e.target.checked : presets.includes(x),
                    ),
                  })
                }
              />
              {DATE_PRESET_LABELS[preset]}
            </label>
          ))}
        </div>
      </fieldset>
      <Toggle
        checked={custom}
        label="Allow custom ranges"
        onChange={(on) => set({ custom: on, ...(on || !range ? {} : { default: presets[0] ?? 'last30d' }) })}
      />
      {custom ? (
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="Earliest day (optional)">
            {(fid) => (
              <Input
                id={fid}
                type="date"
                value={typeof draft.min === 'string' ? draft.min : ''}
                onChange={(e) => set({ min: e.target.value || undefined })}
              />
            )}
          </Field>
          <Field label="Latest day (optional)">
            {(fid) => (
              <Input
                id={fid}
                type="date"
                value={typeof draft.max === 'string' ? draft.max : ''}
                onChange={(e) => set({ max: e.target.value || undefined })}
              />
            )}
          </Field>
          <Field label="Longest range (days)">
            {(fid) => (
              <Input
                id={fid}
                type="number"
                min={1}
                max={3660}
                value={typeof draft.maxDays === 'number' ? draft.maxDays : 366}
                onChange={(e) => set({ maxDays: Math.round(Number(e.target.value)) || 1 })}
              />
            )}
          </Field>
        </div>
      ) : null}
      <Field label="Default">
        {(fid) => (
          <Select
            id={fid}
            value={range ? 'custom' : String(draft.default ?? '')}
            onChange={(e) =>
              set({ default: e.target.value === 'custom' ? { from: today, to: today } : e.target.value })
            }
          >
            {presets.map((preset) => (
              <option key={preset} value={preset}>
                {DATE_PRESET_LABELS[preset]}
              </option>
            ))}
            {custom ? <option value="custom">A fixed range</option> : null}
          </Select>
        )}
      </Field>
      {range ? (
        <div className="flex items-center gap-2">
          <Input
            type="date"
            aria-label="Default: first day"
            value={range.from}
            onChange={(e) => set({ default: { ...range, from: e.target.value } })}
          />
          <span className="text-xs text-muted">to</span>
          <Input
            type="date"
            aria-label="Default: last day"
            value={range.to}
            onChange={(e) => set({ default: { ...range, to: e.target.value } })}
          />
        </div>
      ) : null}
    </>
  );
}
