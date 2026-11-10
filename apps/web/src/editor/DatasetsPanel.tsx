import {
  applyOps,
  type ConnectorInfo,
  type DashboardDoc,
  type Dataset,
  type DatasetResult,
  diffSteps,
  FEED_MIN_REFRESH_SEC,
  formatValue,
  HTTP_MIN_REFRESH_SEC,
  type HttpMethod,
  isStaticSource,
  type OpInput,
  type Parameter,
  type ParamSpec,
  type Source,
  type Suggestion,
  sourceSecretIds,
  stepInputsOf,
  suggestionDataset,
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
  GitBranchPlus,
  Globe,
  KeyRound,
  Layers,
  Plug,
  Plus,
  Radio,
  Rss,
  SlidersHorizontal,
  Sparkles,
  Table2,
  Trash2,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
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
import { countLabel } from '../lib/count-label.ts';
import { useConnectors } from '../lib/hooks.ts';
import { withRetry } from '../lib/retry.ts';
import { credentialErrorHint, introducedSecretIds, introducedSecretRefs } from '../lib/secrets.ts';
import { draftView } from '../state/dataset-keys.ts';
import { useEditor } from '../state/editor.ts';
import { type RawValues, useParameters } from '../state/parameters.ts';
import { fromWire, useDatasetColumns } from '../state/sync.ts';
import {
  type CredentialContext,
  CredentialsField,
  issuesFor,
  UrlKeyWarning,
  urlHint,
  useCredentialContext,
} from './CredentialsField.tsx';
import {
  deleteBlocker,
  derivedDraft,
  formatInterval,
  refreshLine,
  secretsTooltip,
  slug,
  sourceCandidates,
} from './dataset-lineage.ts';
import { bodyText, parseBodyText, switchMethod, withBody } from './http-body.ts';
import { InsertFilterMenu } from './InsertFilter.tsx';
import {
  connectorChoices,
  filtersTooltip,
  insertAt,
  refChoices,
  urlPlaceAt,
  wholeRef,
} from './parameter-refs.ts';
import { previewDelay, previewState } from './preview-state.ts';
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
  !((source.kind === 'http' || source.kind === 'feed') && source.url.length < 12) &&
  !(source.kind === 'upload' && source.fileId === 'none');

type DraftDataset = Omit<Dataset, 'transforms'> & { transforms: TransformInput[] };

interface PreviewResponse {
  result: DatasetResult;
  profile: TableProfile;
  suggestions: Suggestion[];
}

// `editing` names the saved dataset the draft replaces: the server checks the graph with the draft in its place
// (otherwise a draft id that collides with a saved one is renamed).
async function previewRequest(
  dashboardId: string,
  dataset: unknown,
  editing?: string,
  parameters: RawValues = {},
): Promise<PreviewResponse> {
  const res = await api<PreviewResponse>(`/api/dashboards/${dashboardId}/preview?rows=arrays`, {
    body: {
      dataset,
      ...(editing ? { editing } : {}),
      // The current view's values of the filters the draft uses: the preview shows what this view would show.
      ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
    },
    dashboardId,
  });
  return { ...res, result: fromWire(res.result) };
}

export function sourceSummary(
  source: Source,
  connectors: ConnectorInfo[] | undefined,
  datasets: readonly Dataset[],
): ReactNode {
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
      return `${source.method === 'POST' ? 'POST · ' : ''}${new URL(source.url).host}`;
    case 'feed':
      return `Feed · ${new URL(source.url).host}`;
    case 'dataset':
      return (
        <>
          from{' '}
          <strong className="font-medium text-ink-2">
            {datasets.find((d) => d.id === source.id)?.name ?? source.id}
          </strong>
        </>
      );
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
  const doc = useEditor((s) => s.doc);
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
            const blocker = doc ? deleteBlocker(doc, d.id) : null;
            const lock = doc ? secretsTooltip(doc, d.id) : null;
            const filters = doc ? filtersTooltip(doc, d.id) : null;
            return (
              <Card key={d.id} className="flex items-center gap-3 p-3">
                <Database className="size-4 shrink-0 text-muted" />
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEditing(d.id)}>
                  <div className="truncate text-sm font-medium">{d.name}</div>
                  <div className="flex items-center gap-1 truncate text-xs text-muted">
                    {lock ? (
                      <span title={lock} className="inline-flex">
                        <KeyRound className="size-3 shrink-0" aria-label={lock} />
                      </span>
                    ) : null}
                    {filters ? (
                      <span title={filters} className="inline-flex">
                        <SlidersHorizontal className="size-3 shrink-0" aria-label={filters} />
                      </span>
                    ) : null}
                    {sourceSummary(d.source, connectors, datasets)} · {d.transforms.length} step
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
                  label="New dataset from this one"
                  onClick={() => {
                    if (!doc) return;
                    const draft = derivedDraft(doc, d.id);
                    const err = apply(
                      [{ op: 'addDataset', dataset: draft }],
                      `Added dataset "${draft.name}"`,
                    );
                    if (err) toast(err, 'bad');
                    else setEditing(draft.id);
                  }}
                >
                  <GitBranchPlus className="size-3.5" />
                </IconButton>
                <IconButton
                  label="Delete dataset"
                  disabled={Boolean(blocker)}
                  title={blocker ?? 'Delete dataset'}
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
  parameters,
  onChange,
}: {
  spec: ParamSpec;
  value: unknown;
  parameters?: readonly Parameter[] | undefined;
  onChange: (v: unknown) => void;
}) {
  const ref = wholeRef(value);
  // Exact id match: "$param.region2" must not read as "region".
  const filter = ref
    ? parameters?.find((p) => ref === `$param.${p.id}` || ref.startsWith(`$param.${p.id}.`))
    : undefined;
  const choices = connectorChoices(parameters, spec);
  return (
    <Field label={`${spec.label}${spec.required ? '' : ' (optional)'}`} hint={spec.description}>
      {(fid) =>
        ref ? (
          <div className="flex h-9 items-center gap-2 rounded-lg border border-line bg-surface-2 px-2 text-sm">
            <SlidersHorizontal className="size-3.5 shrink-0 text-muted" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">Filter: {filter?.label ?? ref}</span>
            <IconButton label="Stop using the filter" onClick={() => onChange(undefined)}>
              <X className="size-3.5" />
            </IconButton>
          </div>
        ) : (
          <div className="flex gap-2">
            {spec.type === 'enum' ? (
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
            )}
            {choices.length ? (
              <InsertFilterMenu choices={choices} onInsert={(text) => onChange(text)} emptyHint="" />
            ) : null}
          </div>
        )
      }
    </Field>
  );
}

function SourceEditor({
  dashboardId,
  source,
  credentials,
  doc,
  editingId,
  onChange,
  onBlockingError,
}: {
  dashboardId: string;
  source: Source;
  credentials: CredentialContext;
  doc: DashboardDoc | null;
  editingId: string | null;
  onChange: (s: Source) => void;
  /** A problem in the form that must block saving (an invalid body), or null. */
  onBlockingError: (message: string | null) => void;
}) {
  const { data: connectors } = useConnectors();
  const qc = useQueryClient();
  const files = useQuery({
    queryKey: ['files', dashboardId],
    queryFn: () => api<UploadedFile[]>(`/api/dashboards/${dashboardId}/files`, { dashboardId }),
  });
  const fileInput = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: async ({ file, path }: { file: File; path: string }) => {
      if (file.size > 5 * 1024 * 1024) throw new Error('Files are limited to 5 MB');
      const content = await file.text();
      // Uploads take turns on the server: a busy answer means "later", not "no".
      return withRetry(() =>
        api<UploadedFile>(`/api/dashboards/${dashboardId}/files`, {
          body: { name: file.name, content, ...(path ? { path } : {}) },
          dashboardId,
        }),
      );
    },
    onSuccess: (file) => {
      qc.invalidateQueries({ queryKey: ['files', dashboardId] });
      onChange({ kind: 'upload', fileId: file.id });
      toast(`Uploaded ${file.name}: ${countLabel(file.rows, 'row')}, ${countLabel(file.columns, 'column')}`);
    },
  });
  // Applied when the file is chosen: the server reads a JSON file at this path once and stores the table it finds.
  const [uploadPath, setUploadPath] = useState('');
  const [inlineText, setInlineText] = useState(() =>
    source.kind === 'inline'
      ? JSON.stringify(source.rows, null, 1)
      : '[\n {"label": "A", "value": 3},\n {"label": "B", "value": 5}\n]',
  );
  const [inlineError, setInlineError] = useState<string | null>(null);
  // The body as typed: invalid JSON stays in the field (with its error) and never reaches the draft.
  const [bodyDraft, setBodyDraft] = useState(() => (source.kind === 'http' ? bodyText(source.body) : ''));
  const [bodyError, setBodyError] = useState<string | null>(null);
  const parameters = doc?.parameters;
  // Where the caret was last in the URL and the body: the Insert filter menu takes the focus away.
  const [urlCaret, setUrlCaret] = useState<number | null>(null);
  const [bodyCaret, setBodyCaret] = useState<number | null>(null);
  // The body is pretty-printed on blur, except when the blur goes to its Insert filter menu: the caret would no longer
  // point where the user put it, and the growing field would move the menu away from the pointer.
  const bodyInsert = useRef<HTMLSpanElement>(null);
  const toBodyInsert = useRef(false);
  const urlChoices = (url: string, secrets: boolean) => {
    const place = urlPlaceAt(url, urlCaret ?? url.length);
    return place ? refChoices(parameters, place, { secrets }) : [];
  };
  const URL_HINT = 'Put the cursor right after a "/" of the path or the "=" of a query parameter.';
  const insertInUrl = (s: Extract<Source, { kind: 'http' | 'feed' }>, text: string) => {
    const at = urlCaret ?? s.url.length;
    const next = insertAt(s.url, at, at, text);
    setUrlCaret(next.caret);
    onChange({ ...s, url: next.value });
  };
  const setBodyProblem = (message: string | null) => {
    setBodyError(message);
    onBlockingError(message);
  };
  const setMethod = (method: HttpMethod) => {
    if (source.kind !== 'http' || method === (source.method ?? 'GET')) return;
    const next = switchMethod(source, method, bodyDraft);
    setBodyDraft(next.text);
    setBodyProblem(next.error);
    onChange(next.source);
  };

  const grouped = useMemo(() => {
    const map = new Map<string, ConnectorInfo[]>();
    for (const c of connectors ?? []) map.set(c.category, [...(map.get(c.category) ?? []), c]);
    return [...map.entries()];
  }, [connectors]);
  const connector =
    source.kind === 'connector' ? connectors?.find((c) => c.id === source.connector) : undefined;

  const candidates = useMemo(() => (doc ? sourceCandidates(doc, editingId) : []), [doc, editingId]);

  const setKind = (kind: Source['kind']) => {
    if (kind === source.kind) return;
    setBodyDraft('');
    setUploadPath('');
    setBodyProblem(null);
    if (kind === 'dataset' && candidates[0]) onChange({ kind, id: candidates[0].id });
    if (kind === 'connector') onChange({ kind, connector: connectors?.[0]?.id ?? 'demo.signal', params: {} });
    if (kind === 'upload') onChange({ kind, fileId: files.data?.[0]?.id ?? 'none' });
    if (kind === 'inline') onChange({ kind, rows: [] });
    if (kind === 'http') onChange({ kind, url: 'https://' });
    if (kind === 'feed') onChange({ kind, url: 'https://', limit: 30 });
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
          {
            value: 'feed',
            label: (
              <>
                <Rss className="size-3.5" />
                News feed
              </>
            ),
          },
          ...(candidates.length > 0 || source.kind === 'dataset'
            ? [
                {
                  value: 'dataset' as const,
                  label: (
                    <>
                      <Layers className="size-3.5" />
                      Another dataset
                    </>
                  ),
                },
              ]
            : []),
        ]}
      />

      {source.kind === 'dataset' ? (
        <Field
          label="Dataset"
          hint="Its processed rows are the input here. It is loaded once for every dataset that reads it, so they stay in sync."
        >
          {(fid) => (
            <Select
              id={fid}
              value={source.id}
              onChange={(e) => onChange({ kind: 'dataset', id: e.target.value })}
            >
              {candidates.some((c) => c.id === source.id) ? null : (
                <option value={source.id}>{source.id} (missing)</option>
              )}
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}

      {source.kind === 'feed' ? (
        <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
          <Field
            label="Feed or website address"
            hint="RSS, Atom or JSON Feed. A site's home page works when it announces a feed. Checked at most every 5 minutes."
          >
            {(fid) => (
              <div className="flex gap-2">
                <Input
                  id={fid}
                  value={source.url}
                  spellCheck={false}
                  onSelect={(e) => setUrlCaret(e.currentTarget.selectionStart)}
                  onChange={(e) => onChange({ ...source, url: e.target.value })}
                  placeholder="https://www.bbc.com/news"
                />
                {parameters?.length ? (
                  <InsertFilterMenu
                    choices={urlChoices(source.url, false)}
                    onInsert={(text) => insertInUrl(source, text)}
                    emptyHint={URL_HINT}
                  />
                ) : null}
              </div>
            )}
          </Field>
          <Field label="Newest items">
            {(fid) => (
              <Input
                id={fid}
                type="number"
                min={1}
                max={200}
                value={source.limit}
                onChange={(e) => {
                  const n = Math.round(Number(e.target.value));
                  if (e.target.value !== '' && Number.isFinite(n))
                    onChange({ ...source, limit: Math.min(200, Math.max(1, n)) });
                }}
              />
            )}
          </Field>
        </div>
      ) : null}

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
                  parameters={parameters}
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
              if (file) upload.mutate({ file, path: uploadPath.trim() });
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
              if (file) upload.mutate({ file, path: uploadPath.trim() });
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
          <Field
            label="Path to the list (JSON files, optional)"
            hint='Dot path inside the JSON file, e.g. "data.items". Set it before choosing the file; leave empty to auto-detect. CSV files ignore it.'
          >
            {(fid) => (
              <Input
                id={fid}
                value={uploadPath}
                spellCheck={false}
                maxLength={200}
                placeholder="data.items"
                onChange={(e) => setUploadPath(e.target.value)}
              />
            )}
          </Field>
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
                      {f.name} · {countLabel(f.rows, 'row')}
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
          <div className="grid gap-3 sm:grid-cols-[auto_1fr] sm:items-start">
            <fieldset className="m-0 min-w-0 space-y-1.5 border-0 p-0">
              <legend className="mb-1.5 block p-0 text-[13px] font-medium text-ink-2">Method</legend>
              <Segmented
                value={source.method ?? 'GET'}
                onChange={setMethod}
                options={[
                  { value: 'GET', label: 'GET', title: 'Read the address' },
                  {
                    value: 'POST',
                    label: 'POST',
                    title: 'Send a JSON body, for read APIs that take their query in it',
                  },
                ]}
              />
            </fieldset>
            <Field label="HTTPS URL" hint={urlHint(credentials)}>
              {(fid) => (
                <div className="flex gap-2">
                  <Input
                    id={fid}
                    value={source.url}
                    spellCheck={false}
                    onSelect={(e) => setUrlCaret(e.currentTarget.selectionStart)}
                    onChange={(e) => onChange({ ...source, url: e.target.value })}
                    placeholder="https://api.example.com/data.json"
                  />
                  {parameters?.length ? (
                    <InsertFilterMenu
                      choices={urlChoices(source.url, (source.secrets?.length ?? 0) > 0)}
                      onInsert={(text) => insertInUrl(source, text)}
                      emptyHint={URL_HINT}
                    />
                  ) : null}
                </div>
              )}
            </Field>
          </div>
          {source.method === 'POST' ? (
            <>
              <Field
                label="Body (JSON)"
                error={bodyError}
                hint="Sent as application/json on every refresh. Use it for read queries; do not put secrets here."
              >
                {(fid) => (
                  <Textarea
                    id={fid}
                    rows={Math.min(16, Math.max(4, bodyDraft.split('\n').length + 1))}
                    value={bodyDraft}
                    spellCheck={false}
                    aria-invalid={bodyError !== null}
                    placeholder={'{\n  "query": "{ viewer { login } }"\n}'}
                    onSelect={(e) => setBodyCaret(e.currentTarget.selectionStart)}
                    onChange={(e) => {
                      setBodyDraft(e.target.value);
                      const parsed = parseBodyText(e.target.value);
                      setBodyProblem(parsed.ok ? null : parsed.error);
                      if (parsed.ok) onChange(withBody(source, parsed.body));
                    }}
                    onFocus={() => {
                      toBodyInsert.current = false;
                    }}
                    onBlur={(e) => {
                      const target = e.relatedTarget;
                      if (toBodyInsert.current || (target && bodyInsert.current?.contains(target))) return;
                      // Pretty-printed once the user is done typing, never while they type.
                      const parsed = parseBodyText(bodyDraft);
                      if (!parsed.ok) return;
                      const pretty = bodyText(parsed.body);
                      if (pretty === bodyDraft) return;
                      setBodyDraft(pretty);
                      // A caret in the old text points elsewhere in the new one: inserts go to the end until the
                      // user puts it back.
                      setBodyCaret(null);
                    }}
                  />
                )}
              </Field>
              {parameters?.length ? (
                <div className="flex justify-end">
                  <span
                    ref={bodyInsert}
                    className="contents"
                    onPointerDown={() => {
                      // Before the body's blur, which in some browsers names no related target for a button.
                      toBodyInsert.current = true;
                    }}
                  >
                    <InsertFilterMenu
                      choices={refChoices(parameters, 'body', { secrets: (source.secrets?.length ?? 0) > 0 })}
                      emptyHint="Only choice and period filters can go into a body."
                      onInsert={(text) => {
                        // A whole JSON string value: "region": "$param.region".
                        const at = bodyCaret ?? bodyDraft.length;
                        const next = insertAt(bodyDraft, at, at, `"${text}"`);
                        setBodyDraft(next.value);
                        setBodyCaret(next.caret);
                        const parsed = parseBodyText(next.value);
                        setBodyProblem(parsed.ok ? null : parsed.error);
                        if (parsed.ok) onChange(withBody(source, parsed.body));
                      }}
                    />
                  </span>
                </div>
              ) : null}
            </>
          ) : null}
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
  const doc = useEditor((s) => s.doc);
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
  // A form problem that a save must not hide by storing the last valid value (an invalid POST body).
  const [sourceError, setSourceError] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(draft), previewDelay(debounced, draft));
    return () => clearTimeout(t);
  }, [draft, debounced]);

  const { data: connectors } = useConnectors();
  // Default the name to the connector's name until the user types their own.
  const [nameTouched, setNameTouched] = useState(Boolean(initial));
  useEffect(() => {
    if (nameTouched) return;
    let wanted: string | undefined;
    if (draft.source.kind === 'connector') {
      const id = draft.source.connector;
      wanted = connectors?.find((x) => x.id === id)?.name;
    } else if (draft.source.kind === 'dataset') {
      const id = draft.source.id;
      const parent = doc?.datasets.find((x) => x.id === id)?.name;
      if (parent) wanted = `${parent} (derived)`.slice(0, 120);
    }
    if (wanted && wanted !== draft.name) setDraft((d) => ({ ...d, name: wanted }));
  }, [draft.source, connectors, doc, nameTouched, draft.name]);

  // A connector serves the same reading until its minimum interval has passed, so faster choices would only promise
  // a refresh that never shows (agents get theirs raised on save; here they are simply not offered).
  const source = draft.source;
  // Feeds and HTTP responses are cached on the server for a while, whatever the dataset asks. Uploads and inline rows
  // only change when edited, so the server never refreshes them on a timer.
  const staticSource = isStaticSource(source);
  const minRefreshSec =
    source.kind === 'connector'
      ? (connectors?.find((c) => c.id === source.connector)?.minRefreshSec ?? 0)
      : source.kind === 'feed'
        ? FEED_MIN_REFRESH_SEC
        : source.kind === 'http'
          ? HTTP_MIN_REFRESH_SEC
          : 0;
  const refreshTooFast = draft.refreshSec > 0 && (staticSource || draft.refreshSec < minRefreshSec);

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

  // The name travels too: the server needs the draft as it will be saved. `editing` is the saved dataset it replaces.
  const editingId = initial?.id;
  const previewBody = { name: debounced.name, source: debounced.source, transforms: debounced.transforms };
  const viewRaw = useParameters((s) => s.raw);
  const saved = useEditor((s) => s.saved);
  const view = useMemo(() => draftView(saved, doc, debounced, viewRaw), [saved, doc, debounced, viewRaw]);
  const sourceView = useMemo(
    () => draftView(saved, doc, { source: debounced.source, transforms: [] }, viewRaw),
    [saved, doc, debounced.source, viewRaw],
  );
  const preview = useQuery({
    queryKey: ['preview', dashboardId, editingId ?? null, JSON.stringify(previewBody), view.key],
    queryFn: () => previewRequest(dashboardId, previewBody, editingId, view.values),
    retry: false,
    enabled: previewable(debounced.source) && !previewBlocked,
  });
  const raw = useQuery({
    queryKey: [
      'preview',
      dashboardId,
      editingId ?? null,
      JSON.stringify({ name: debounced.name, source: debounced.source }),
      sourceView.key,
    ],
    queryFn: () =>
      previewRequest(
        dashboardId,
        { name: debounced.name, source: debounced.source },
        editingId,
        sourceView.values,
      ),
    retry: false,
    enabled: previewable(debounced.source) && !previewBlocked,
  });
  const baseColumns = raw.data?.result.table.columns.map((c) => c.name) ?? [];
  const baseTypes = Object.fromEntries(raw.data?.result.table.columns.map((c) => [c.name, c.type]) ?? []);

  const candidates = useMemo(() => (doc ? sourceCandidates(doc, editingId ?? null) : []), [doc, editingId]);
  // Only the datasets the steps read: loading every other dataset when the editor opens would be wasted work.
  const columnsOf = useDatasetColumns(dashboardId, stepInputsOf(draft));
  const parentId = draft.source.kind === 'dataset' ? draft.source.id : undefined;
  const parent = parentId ? doc?.datasets.find((d) => d.id === parentId) : undefined;
  // Union labels its own rows after where they came from: the parent of a derived dataset, otherwise this dataset.
  const self = parent
    ? { id: parent.id, name: parent.name }
    : initial
      ? { id: initial.id, name: draft.name }
      : undefined;

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
        // The dataset is saved in this same batch: the suggestion reads it instead of copying its source and steps.
        const withDraft = { datasets: [...doc.datasets.filter((d) => d.id !== id), dataset] };
        ops.push({
          op: 'addDataset',
          dataset: suggestionDataset(withDraft, id, target, widget.title ?? 'view', transforms),
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
  const shown = previewState({
    credentialsBlocked: previewBlocked,
    formError: sourceError,
    requestError: preview.error ? errorMessage(preview.error) : null,
    result,
  });

  return (
    <div className="space-y-6">
      <SourceEditor
        dashboardId={dashboardId}
        source={draft.source}
        credentials={credentials}
        doc={doc}
        editingId={initial?.id ?? null}
        onBlockingError={setSourceError}
        onChange={(source) =>
          // A derived dataset has no interval or history of its own (the server would refuse them).
          setDraft((d) => ({
            ...d,
            source,
            ...(source.kind === 'dataset' ? { refreshSec: 0, accumulate: 0 } : {}),
          }))
        }
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
          baseTypes={baseTypes}
          trace={result?.trace}
          datasets={candidates.map((c) => ({ id: c.id, name: c.name }))}
          columnsOf={columnsOf}
          self={self}
          parameters={doc?.parameters}
          onChange={(transforms) => setDraft((d) => ({ ...d, transforms }))}
        />
      </section>

      {draft.source.kind === 'dataset' ? (
        <p className="rounded-lg bg-surface-2 p-3 text-sm text-ink-2">
          {doc ? refreshLine(doc, draft.source.id) : null}
        </p>
      ) : (
        <section className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Live refresh"
            hint={
              staticSource
                ? 'Uploaded files and inline rows change only when you edit them, so there is nothing to refresh.'
                : `While someone is watching, the server refreshes and pushes changes. Public APIs are cached to respect their limits${minRefreshSec > 1 ? `: this one updates at most every ${formatInterval(minRefreshSec)}` : ''}.`
            }
            error={
              refreshTooFast
                ? staticSource
                  ? 'This source never changes on its own. Choose Off.'
                  : `This source updates at most every ${formatInterval(minRefreshSec)}. Choose a longer interval.`
                : null
            }
          >
            {(fid) => (
              <Select
                id={fid}
                value={draft.refreshSec}
                onChange={(e) => setDraft((d) => ({ ...d, refreshSec: Number(e.target.value) }))}
              >
                {/* Agents may save any interval (one raised to a connector's minimum, say): show it as it is. */}
                {REFRESH_OPTIONS.some((o) => o.value === draft.refreshSec) ? null : (
                  <option value={draft.refreshSec}>Every {formatInterval(draft.refreshSec)}</option>
                )}
                {REFRESH_OPTIONS.map((o) => (
                  <option
                    key={o.value}
                    value={o.value}
                    disabled={o.value > 0 && (staticSource || o.value < minRefreshSec)}
                  >
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
      )}

      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <h3 className="text-[13px] font-semibold text-ink-2">Preview</h3>
          {preview.isFetching ? <Spinner className="size-3.5" /> : null}
          {shown.counts ? (
            <span className="text-xs text-muted">{shown.counts}</span>
          ) : shown.body.kind === 'stale' && shown.body.table ? (
            <span className="text-xs text-ink-2">{shown.body.message}</span>
          ) : null}
        </div>
        {shown.body.kind === 'blocked' ? (
          <p className="rounded-lg bg-surface-2 p-3 text-sm text-ink-2">{shown.body.message}</p>
        ) : shown.body.kind === 'error' ? (
          <PreviewError
            message={shown.body.message}
            hasSecrets={sourceSecretIds(debounced.source).length > 0}
            canAddSecrets={credentials.canUseSecrets && debounced.source.kind === 'http'}
          />
        ) : shown.body.kind === 'loading' ? (
          <Spinner />
        ) : (
          <>
            {shown.body.kind === 'stale' && !shown.body.table ? (
              <p className="rounded-lg bg-surface-2 p-3 text-sm text-ink-2">{shown.body.message}</p>
            ) : null}
            {/* An out-of-date table stays where it is, dimmed, with the hint in the heading: the field flips between
                valid and invalid while typing, and nothing may move. */}
            {result && (shown.body.kind === 'table' || shown.body.table) ? (
              <div
                className={cx('space-y-2 transition-opacity', shown.body.kind === 'stale' && 'opacity-40')}
                aria-disabled={shown.body.kind === 'stale' || undefined}
              >
                {result.warning ? (
                  <p className="flex items-start gap-2 rounded-lg bg-warn/10 p-2.5 text-xs text-ink">
                    <AlertTriangle className="mt-px size-3.5 shrink-0 text-warn" />
                    <span>{result.warning}</span>
                  </p>
                ) : null}
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
              </div>
            ) : null}
          </>
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
          disabled={
            !draft.name.trim() || Boolean(preview.error) || blockedByCredentials || sourceError !== null
          }
          title={sourceError ?? (blockedByCredentials ? 'Fix the credentials first' : undefined)}
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
