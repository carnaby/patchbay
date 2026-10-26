import {
  applyOps,
  type ConnectorInfo,
  type DashboardDoc,
  type Dataset,
  type DatasetResult,
  diffSteps,
  formatValue,
  type OpInput,
  type ParamSpec,
  type Source,
  type Suggestion,
  sourceSecretIds,
  type TableProfile,
  type TransformInput,
  type UploadedFile,
  type WidgetInput,
} from '@patchbay/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  Database,
  FileUp,
  Globe,
  KeyRound,
  Plug,
  Plus,
  Radio,
  Sparkles,
  Table2,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  cx,
  Drawer,
  Field,
  IconButton,
  Input,
  Segmented,
  Select,
  Spinner,
  Textarea,
  toast,
} from '../components/ui.tsx';
import { api, errorMessage } from '../lib/api.ts';
import { useConnectors } from '../lib/hooks.ts';
import { credentialErrorHint, introducedSecretIds, introducedSecretRefs } from '../lib/secrets.ts';
import { useEditor } from '../state/editor.ts';
import {
  type CredentialContext,
  CredentialsField,
  issuesFor,
  UrlKeyWarning,
  urlHint,
  useCredentialContext,
} from './CredentialsField.tsx';
import { askPublicSecrets } from './public-secrets.tsx';
import { TransformEditor } from './TransformEditor.tsx';

const REFRESH_OPTIONS = [
  { value: 0, label: 'Off (on load)' },
  { value: 1, label: 'Every second' },
  { value: 5, label: 'Every 5 s' },
  { value: 30, label: 'Every 30 s' },
  { value: 60, label: 'Every minute' },
  { value: 300, label: 'Every 5 min' },
  { value: 900, label: 'Every 15 min' },
  { value: 3600, label: 'Every hour' },
];

/** Skip previews for sources that are obviously not ready yet. */
const previewable = (source: Source) =>
  !(source.kind === 'http' && source.url.length < 12) &&
  !(source.kind === 'upload' && source.fileId === 'none');

type DraftDataset = Omit<Dataset, 'transforms'> & { transforms: TransformInput[] };

interface PreviewResponse {
  result: DatasetResult;
  profile: TableProfile;
  suggestions: Suggestion[];
}

function slug(text: string, taken: Set<string>) {
  const base =
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30) || 'data';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export function sourceSummary(source: Source, connectors: ConnectorInfo[] | undefined) {
  switch (source.kind) {
    case 'connector': {
      const c = connectors?.find((x) => x.id === source.connector);
      const params = Object.values(source.params).slice(0, 2).join(', ');
      return `${c?.name ?? source.connector}${params ? ` · ${params}` : ''}`;
    }
    case 'upload':
      return 'Uploaded file';
    case 'inline':
      return `${source.rows.length} inline rows`;
    case 'http':
      return new URL(source.url).host;
  }
}

export function DatasetsPanel({
  open,
  onClose,
  dashboardId,
}: {
  open: boolean;
  onClose: () => void;
  dashboardId: string;
}) {
  const datasets = useEditor((s) => s.doc?.datasets ?? []);
  const widgets = useEditor((s) => s.doc?.widgets ?? []);
  const apply = useEditor((s) => s.apply);
  const { data: connectors } = useConnectors();
  const [editing, setEditing] = useState<string | 'new' | null>(null);

  useEffect(() => {
    if (open && datasets.length === 0) setEditing('new');
    if (!open) setEditing(null);
  }, [open, datasets.length]);

  const current = editing && editing !== 'new' ? datasets.find((d) => d.id === editing) : undefined;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="w-[min(680px,100vw)]"
      title={
        editing ? (
          <span className="flex items-center gap-2">
            {datasets.length > 0 ? (
              <IconButton label="Back to datasets" onClick={() => setEditing(null)}>
                <ArrowLeft className="size-4" />
              </IconButton>
            ) : null}
            {editing === 'new' ? 'Add data' : `Edit "${current?.name}"`}
          </span>
        ) : (
          'Data'
        )
      }
    >
      {editing ? (
        <DatasetEditor
          key={editing}
          dashboardId={dashboardId}
          initial={current}
          onDone={() => setEditing(null)}
        />
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-ink-2">
            Datasets say where data comes from and how it is processed. Widgets show datasets; several widgets
            can share one.
          </p>
          {datasets.map((d) => {
            const users = widgets.filter((w) => 'datasetId' in w && w.datasetId === d.id).length;
            return (
              <Card key={d.id} className="flex items-center gap-3 p-3">
                <Database className="size-4 shrink-0 text-muted" />
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEditing(d.id)}>
                  <div className="truncate text-sm font-medium">{d.name}</div>
                  <div className="flex items-center gap-1 truncate text-xs text-muted">
                    {sourceSecretIds(d.source).length ? (
                      <KeyRound className="size-3 shrink-0" aria-label="Uses secrets" />
                    ) : null}
                    {sourceSummary(d.source, connectors)} · {d.transforms.length} step
                    {d.transforms.length === 1 ? '' : 's'} · {users} widget{users === 1 ? '' : 's'}
                  </div>
                </button>
                {d.refreshSec > 0 ? (
                  <Badge tone="good">
                    <Radio className="size-3" />{' '}
                    {d.refreshSec < 60 ? `${d.refreshSec}s` : `${Math.round(d.refreshSec / 60)}m`}
                  </Badge>
                ) : null}
                <IconButton
                  label="Delete dataset"
                  onClick={() => {
                    const err = apply(
                      [{ op: 'removeDataset', id: d.id, cascade: true }],
                      `Removed dataset "${d.name}"`,
                    );
                    if (err) toast(err, 'bad');
                    else
                      toast(
                        users ? `Removed "${d.name}" and ${users} widget(s)` : `Removed "${d.name}"`,
                        'neutral',
                        { label: 'Undo', run: () => useEditor.getState().undo() },
                      );
                  }}
                >
                  <Trash2 className="size-3.5" />
                </IconButton>
              </Card>
            );
          })}
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            Add data
          </Button>
        </div>
      )}
    </Drawer>
  );
}

function ParamInput({
  spec,
  value,
  onChange,
}: {
  spec: ParamSpec;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  return (
    <Field label={`${spec.label}${spec.required ? '' : ' (optional)'}`} hint={spec.description}>
      {(fid) =>
        spec.type === 'enum' ? (
          <Select
            id={fid}
            value={String(value ?? spec.default ?? '')}
            onChange={(e) => onChange(e.target.value)}
          >
            {spec.options!.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        ) : spec.type === 'boolean' ? (
          <Select
            id={fid}
            value={String(value ?? spec.default ?? false)}
            onChange={(e) => onChange(e.target.value === 'true')}
          >
            <option value="true">Yes</option>
            <option value="false">No</option>
          </Select>
        ) : (
          <Input
            id={fid}
            type={spec.type === 'number' ? 'number' : 'text'}
            value={value === undefined || value === null ? '' : String(value)}
            placeholder={spec.default !== undefined ? String(spec.default) : ''}
            onChange={(e) =>
              onChange(
                e.target.value === ''
                  ? undefined
                  : spec.type === 'number'
                    ? Number(e.target.value)
                    : e.target.value,
              )
            }
          />
        )
      }
    </Field>
  );
}

function SourceEditor({
  dashboardId,
  source,
  credentials,
  onChange,
}: {
  dashboardId: string;
  source: Source;
  credentials: CredentialContext;
  onChange: (s: Source) => void;
}) {
  const { data: connectors } = useConnectors();
  const qc = useQueryClient();
  const files = useQuery({
    queryKey: ['files', dashboardId],
    queryFn: () => api<UploadedFile[]>(`/api/dashboards/${dashboardId}/files`, { dashboardId }),
  });
  const fileInput = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > 5 * 1024 * 1024) throw new Error('Files are limited to 5 MB');
      const content = await file.text();
      return api<UploadedFile>(`/api/dashboards/${dashboardId}/files`, {
        body: { name: file.name, content },
        dashboardId,
      });
    },
    onSuccess: (file) => {
      qc.invalidateQueries({ queryKey: ['files', dashboardId] });
      onChange({ kind: 'upload', fileId: file.id });
      toast(`Uploaded ${file.name}: ${file.rows.toLocaleString('en')} rows, ${file.columns} columns`);
    },
  });
  const [inlineText, setInlineText] = useState(() =>
    source.kind === 'inline'
      ? JSON.stringify(source.rows, null, 1)
      : '[\n {"label": "A", "value": 3},\n {"label": "B", "value": 5}\n]',
  );
  const [inlineError, setInlineError] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<string, ConnectorInfo[]>();
    for (const c of connectors ?? []) map.set(c.category, [...(map.get(c.category) ?? []), c]);
    return [...map.entries()];
  }, [connectors]);
  const connector =
    source.kind === 'connector' ? connectors?.find((c) => c.id === source.connector) : undefined;

  const setKind = (kind: Source['kind']) => {
    if (kind === source.kind) return;
    if (kind === 'connector') onChange({ kind, connector: connectors?.[0]?.id ?? 'demo.signal', params: {} });
    if (kind === 'upload') onChange({ kind, fileId: files.data?.[0]?.id ?? 'none' });
    if (kind === 'inline') onChange({ kind, rows: [] });
    if (kind === 'http') onChange({ kind, url: 'https://' });
  };

  return (
    <div className="space-y-4">
      <Segmented
        value={source.kind}
        onChange={setKind}
        options={[
          {
            value: 'connector',
            label: (
              <>
                <Plug className="size-3.5" />
                Public API
              </>
            ),
          },
          {
            value: 'upload',
            label: (
              <>
                <FileUp className="size-3.5" />
                File
              </>
            ),
          },
          {
            value: 'inline',
            label: (
              <>
                <Table2 className="size-3.5" />
                Paste
              </>
            ),
          },
          {
            value: 'http',
            label: (
              <>
                <Globe className="size-3.5" />
                JSON URL
              </>
            ),
          },
        ]}
      />

      {source.kind === 'connector' ? (
        <div className="space-y-3">
          <Field
            label="Source"
            hint={connector ? `${connector.description} Data: ${connector.attribution}.` : undefined}
          >
            {(fid) => (
              <Select
                id={fid}
                value={source.connector}
                onChange={(e) => onChange({ kind: 'connector', connector: e.target.value, params: {} })}
              >
                {grouped.map(([category, list]) => (
                  <optgroup key={category} label={category}>
                    {list.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            )}
          </Field>
          {connector?.params.length ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {connector.params.map((p) => (
                <ParamInput
                  key={p.name}
                  spec={p}
                  value={source.params[p.name]}
                  onChange={(v) => {
                    const params = { ...source.params };
                    if (v === undefined) delete params[p.name];
                    else params[p.name] = v;
                    onChange({ ...source, params });
                  }}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {source.kind === 'upload' ? (
        <div className="space-y-3">
          <input
            ref={fileInput}
            type="file"
            accept=".csv,.json,.tsv,.txt,text/csv,application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) upload.mutate(file);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const file = e.dataTransfer.files[0];
              if (file) upload.mutate(file);
            }}
            className="flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-line-strong px-4 py-8 text-sm text-ink-2 transition hover:border-ink-2 hover:bg-surface"
          >
            {upload.isPending ? <Spinner /> : <FileUp className="size-6 text-muted" />}
            <span>
              <span className="font-medium text-ink">Drop a CSV or JSON file</span> or click to choose (max 5
              MB)
            </span>
            <span className="text-xs text-muted">
              Stored inside this dashboard's folder. Columns and types are detected automatically.
            </span>
          </button>
          {files.data?.length ? (
            <Field label="Use file">
              {(fid) => (
                <Select
                  id={fid}
                  value={source.fileId}
                  onChange={(e) => onChange({ kind: 'upload', fileId: e.target.value })}
                >
                  {files.data.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name} · {f.rows.toLocaleString('en')} rows
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}
        </div>
      ) : null}

      {source.kind === 'inline' ? (
        <Field
          label="Rows (JSON array of objects)"
          error={inlineError}
          hint="Up to 2,000 rows. Handy for targets, thresholds or small reference tables."
        >
          {(fid) => (
            <Textarea
              id={fid}
              rows={8}
              value={inlineText}
              onChange={(e) => {
                setInlineText(e.target.value);
                try {
                  const rows = JSON.parse(e.target.value) as unknown;
                  if (
                    !Array.isArray(rows) ||
                    rows.some((r) => typeof r !== 'object' || r === null || Array.isArray(r))
                  )
                    throw new Error('Expected an array of objects');
                  setInlineError(null);
                  onChange({
                    kind: 'inline',
                    rows: rows as Record<string, string | number | boolean | null>[],
                  });
                } catch (err) {
                  setInlineError(errorMessage(err));
                }
              }}
            />
          )}
        </Field>
      ) : null}

      {source.kind === 'http' ? (
        <div className="grid gap-3">
          <Field label="HTTPS URL" hint={urlHint(credentials)}>
            {(fid) => (
              <Input
                id={fid}
                value={source.url}
                spellCheck={false}
                onChange={(e) => onChange({ ...source, url: e.target.value })}
                placeholder="https://api.example.com/data.json"
              />
            )}
          </Field>
          <UrlKeyWarning source={source} context={credentials} onChange={onChange} />
          <CredentialsField source={source} context={credentials} onChange={onChange} />
          <Field
            label="Path to the list (optional)"
            hint='Dot path inside the response, e.g. "data.items". Leave empty to auto-detect.'
          >
            {(fid) => (
              <Input
                id={fid}
                value={source.path ?? ''}
                onChange={(e) => {
                  const { path: _p, ...rest } = source;
                  onChange(e.target.value ? { ...rest, path: e.target.value } : rest);
                }}
              />
            )}
          </Field>
        </div>
      ) : null}
    </div>
  );
}

function PreviewTable({ result }: { result: DatasetResult }) {
  const rows = result.table.rows.slice(0, 12);
  return (
    <div className="max-h-64 overflow-auto rounded-lg border border-line">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-surface-2">
          <tr>
            {result.table.columns.map((c) => (
              <th key={c.name} className="px-2 py-1.5 font-medium whitespace-nowrap">
                {c.name}
                <span className="ml-1 font-normal text-muted">{c.type}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: preview rows
            <tr key={i} className="border-t border-line/70">
              {result.table.columns.map((c) => (
                <td key={c.name} className="max-w-48 truncate px-2 py-1 whitespace-nowrap">
                  {formatValue(row[c.name] ?? null, c.type)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DatasetEditor({
  dashboardId,
  initial: live,
  onDone,
}: {
  dashboardId: string;
  initial: Dataset | undefined;
  onDone: () => void;
}) {
  const apply = useEditor((s) => s.apply);
  // The version the user started editing from. The prop keeps updating when an
  // agent changes the dataset meanwhile; diffing against that would silently
  // revert the agent's edit, so the diff must be against this snapshot.
  const [initial] = useState(live);
  const [draft, setDraft] = useState<DraftDataset>(
    () =>
      initial ?? {
        id: '',
        name: 'Weather forecast',
        source: { kind: 'connector', connector: 'weather.forecast', params: {} },
        transforms: [],
        refreshSec: 0,
        accumulate: 0,
      },
  );
  const [debounced, setDebounced] = useState(draft);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(draft), 450);
    return () => clearTimeout(t);
  }, [draft]);

  const { data: connectors } = useConnectors();
  // Default the name to the connector's name until the user types their own.
  const [nameTouched, setNameTouched] = useState(Boolean(initial));
  useEffect(() => {
    if (nameTouched || draft.source.kind !== 'connector') return;
    const c = connectors?.find((x) => x.id === (draft.source as { connector: string }).connector);
    if (c && c.name !== draft.name) setDraft((d) => ({ ...d, name: c.name }));
  }, [draft.source, connectors, nameTouched, draft.name]);

  const credentials = useCredentialContext();
  // Credential problems are explained while typing; a request that the server would refuse is not sent at all.
  const previewBlocked = issuesFor(debounced.source, credentials).length > 0;
  const issues = issuesFor(draft.source, credentials);
  const draftIds = sourceSecretIds(draft.source);
  const initialIds = initial ? sourceSecretIds(initial.source) : [];
  // Only new or re-pointed references are checked on save (as on the server), so a deleted secret never blocks
  // renaming the dataset or editing its pipeline.
  const refsChanged =
    draftIds.length > 0 &&
    (initial?.source.kind !== 'http' ||
      draft.source.kind !== 'http' ||
      initial.source.url !== draft.source.url ||
      draftIds.some((id) => !initialIds.includes(id)));
  const blockedByCredentials = refsChanged && issues.length > 0;

  const previewBody = { source: debounced.source, transforms: debounced.transforms };
  const preview = useQuery({
    queryKey: ['preview', dashboardId, JSON.stringify(previewBody)],
    queryFn: () =>
      api<PreviewResponse>(`/api/dashboards/${dashboardId}/preview`, {
        body: { dataset: previewBody },
        dashboardId,
      }),
    retry: false,
    enabled: previewable(debounced.source) && !previewBlocked,
  });
  const raw = useQuery({
    queryKey: ['preview', dashboardId, JSON.stringify({ source: debounced.source, transforms: [] })],
    queryFn: () =>
      api<PreviewResponse>(`/api/dashboards/${dashboardId}/preview`, {
        body: { dataset: { source: debounced.source } },
        dashboardId,
      }),
    retry: false,
    enabled: previewable(debounced.source) && !previewBlocked,
  });
  const baseColumns = raw.data?.result.table.columns.map((c) => c.name) ?? [];

  const save = async (extraWidgets: { widget: WidgetInput; transforms: TransformInput[] }[] = []) => {
    const doc = useEditor.getState().doc!;
    const datasetIds = new Set(doc.datasets.map((d) => d.id));
    const id = initial?.id ?? slug(draft.name, datasetIds);
    datasetIds.add(id);
    const dataset = { ...draft, id };
    // For an existing dataset send only what changed, and pipeline edits as
    // per-step ops: if an agent changed other fields or steps meanwhile, the
    // rebase keeps both edits instead of overwriting theirs.
    const ops: Parameters<typeof apply>[0] = [];
    if (initial) {
      const set: Record<string, unknown> = {};
      for (const key of ['name', 'source', 'refreshSec', 'accumulate'] as const) {
        if (JSON.stringify(initial[key]) !== JSON.stringify(draft[key])) set[key] = draft[key];
      }
      if (Object.keys(set).length) ops.push({ op: 'updateDataset', id, set });
      ops.push(...diffSteps(id, initial.transforms, draft.transforms));
      if (ops.length === 0 && extraWidgets.length === 0) {
        onDone();
        return;
      }
    } else {
      ops.push({ op: 'addDataset', dataset });
    }
    const widgetIds = new Set(doc.widgets.map((w) => w.id));
    for (const { widget, transforms } of extraWidgets) {
      let target = id;
      if (transforms.length) {
        target = slug(`${id}-${widget.title ?? 'view'}`, datasetIds).slice(0, 40);
        datasetIds.add(target);
        ops.push({
          op: 'addDataset',
          dataset: {
            ...dataset,
            id: target,
            name: `${draft.name}: ${widget.title ?? 'view'}`.slice(0, 120),
            transforms: [...draft.transforms, ...transforms],
          },
        });
      }
      const wid = slug(widget.title ?? widget.type, widgetIds);
      widgetIds.add(wid);
      ops.push({ op: 'addWidget', widget: { ...widget, id: wid, datasetId: target } as WidgetInput });
    }
    if (!(await confirmPublicSecrets(ops, credentials))) return;
    const err = apply(ops, initial ? `Edited dataset "${draft.name}"` : `Added dataset "${draft.name}"`);
    if (err) {
      toast(err, 'bad');
      return;
    }
    if (!useEditor.getState().editing) useEditor.getState().setEditing(true);
    onDone();
  };

  const [picked, setPicked] = useState<Set<string>>(new Set());
  const suggestions = preview.data?.suggestions ?? [];
  const result = preview.data?.result;

  return (
    <div className="space-y-6">
      <SourceEditor
        dashboardId={dashboardId}
        source={draft.source}
        credentials={credentials}
        onChange={(source) => setDraft((d) => ({ ...d, source }))}
      />

      <Field label="Name">
        {(fid) => (
          <Input
            id={fid}
            value={draft.name}
            maxLength={120}
            onChange={(e) => {
              setNameTouched(true);
              setDraft((d) => ({ ...d, name: e.target.value }));
            }}
          />
        )}
      </Field>

      <section className="space-y-2">
        <h3 className="text-[13px] font-semibold text-ink-2">Processing rules</h3>
        <TransformEditor
          steps={draft.transforms}
          baseColumns={baseColumns}
          trace={result?.trace}
          onChange={(transforms) => setDraft((d) => ({ ...d, transforms }))}
        />
      </section>

      <section className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Live refresh"
          hint="While someone is watching, the server refreshes and pushes changes. Public APIs are cached to respect their limits."
        >
          {(fid) => (
            <Select
              id={fid}
              value={draft.refreshSec}
              onChange={(e) => setDraft((d) => ({ ...d, refreshSec: Number(e.target.value) }))}
            >
              {REFRESH_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label="Keep history (rows)"
          hint='For sources returning only the current value: keeps the last N readings with a "fetched_at" time. 0 = off.'
        >
          {(fid) => (
            <Input
              id={fid}
              type="number"
              min={0}
              max={5000}
              value={draft.accumulate}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  accumulate: Math.min(5000, Math.max(0, Number(e.target.value) || 0)),
                }))
              }
            />
          )}
        </Field>
      </section>

      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <h3 className="text-[13px] font-semibold text-ink-2">Preview</h3>
          {preview.isFetching ? <Spinner className="size-3.5" /> : null}
          {result ? (
            <span className="text-xs text-muted">
              {result.table.rows.length.toLocaleString('en')} rows{result.truncated ? ' (first 500)' : ''} ·{' '}
              {result.table.columns.length} columns
            </span>
          ) : null}
        </div>
        {previewBlocked ? (
          <p className="rounded-lg bg-surface-2 p-3 text-sm text-ink-2">
            Fix the credentials above to load a preview.
          </p>
        ) : preview.error || result?.error ? (
          <PreviewError
            message={preview.error ? errorMessage(preview.error) : (result?.error ?? '')}
            hasSecrets={sourceSecretIds(debounced.source).length > 0}
            canAddSecrets={credentials.canUseSecrets && debounced.source.kind === 'http'}
          />
        ) : result ? (
          <>
            <PreviewTable result={result} />
            {preview.data?.profile ? (
              <div className="flex flex-wrap gap-1">
                {preview.data.profile.columns.map((c) => (
                  <Badge
                    key={c.name}
                    tone={c.role === 'measure' ? 'data' : c.role === 'time' ? 'good' : 'neutral'}
                  >
                    {c.name}: {c.role}
                  </Badge>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <Spinner />
        )}
      </section>

      {suggestions.length ? (
        <section className="space-y-2">
          <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-ink-2">
            <Sparkles className="size-3.5 text-accent" /> Suggested widgets
          </h3>
          <p className="text-xs text-muted">
            Pick any to add together with the data. Suggestions come from a rules engine that reads your
            columns; an MCP agent can go further.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {suggestions.map((s) => {
              const on = picked.has(s.title);
              return (
                <button
                  key={s.title}
                  type="button"
                  onClick={() =>
                    setPicked((p) =>
                      on ? new Set([...p].filter((x) => x !== s.title)) : new Set([...p, s.title]),
                    )
                  }
                  className={cx(
                    'rounded-xl border p-3 text-left transition',
                    on ? 'border-ink bg-surface-2' : 'border-line bg-surface hover:border-ink-2',
                  )}
                >
                  <div className="text-[13px] font-medium">{s.title}</div>
                  <p className="mt-0.5 line-clamp-2 text-[11.5px] text-muted">{s.rationale}</p>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      <div className="sticky -bottom-5 -mx-5 -mb-5 flex justify-end gap-2 border-t border-line bg-page px-5 py-3">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!draft.name.trim() || Boolean(preview.error) || blockedByCredentials}
          title={blockedByCredentials ? 'Fix the credentials first' : undefined}
          onClick={() =>
            void save(
              suggestions
                .filter((s) => picked.has(s.title))
                .map((s) => ({
                  widget: { ...s.widget, id: 'tmp' } as WidgetInput,
                  transforms: s.transforms,
                })),
            )
          }
        >
          {initial
            ? 'Save changes'
            : picked.size
              ? `Add data + ${picked.size} widget${picked.size > 1 ? 's' : ''}`
              : 'Add data'}
        </Button>
      </div>
    </div>
  );
}

function PreviewError({
  message,
  hasSecrets,
  canAddSecrets,
}: {
  message: string;
  hasSecrets: boolean;
  canAddSecrets: boolean;
}) {
  // Only the dashboard's editors open this panel, so it may say more than the generic widget error.
  const hint = credentialErrorHint(message, { hasSecrets, canAddSecrets });
  return (
    <div className="flex items-start gap-2 rounded-lg bg-bad/10 p-3 text-sm text-bad">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <span>
        {message}
        {hint ? <span className="mt-1 block text-ink-2">{hint}</span> : null}
      </span>
    </div>
  );
}

/**
 * Asks before a dataset edit makes a public dashboard show data fetched with secrets, so the dialog appears at the
 * moment of the change. The confirmation is recorded for exactly these references and sent with the next save.
 */
async function confirmPublicSecrets(ops: OpInput[], credentials: CredentialContext) {
  const state = useEditor.getState();
  if (state.meta?.visibility !== 'public' || !state.doc) return true;
  let next: DashboardDoc;
  try {
    next = applyOps(state.doc, ops).doc;
  } catch {
    return true; // apply() reports the error itself
  }
  const base = state.saved ?? state.doc;
  const refs = introducedSecretRefs(base, next);
  if (refs.length === 0 || refs.every((r) => state.confirmedSecretRefs.includes(r))) return true;
  const names = introducedSecretIds(base, next).map(
    (id) => credentials.secrets?.find((s) => s.id === id)?.name ?? id,
  );
  if (!(await askPublicSecrets('change', names))) return false;
  useEditor.getState().confirmSecretRefs(refs);
  return true;
}
