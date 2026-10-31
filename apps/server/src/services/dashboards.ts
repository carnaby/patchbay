/**
 * Dashboard use-cases with their permission rules. Both the REST API and the
 * MCP server call into this class, so there is exactly one place that decides
 * who may see or change what.
 */
import {
  type Actor,
  applyOps,
  BindingError,
  bindingMatches,
  bindingMismatchMessage,
  CONFIRM_PUBLIC_SECRETS,
  CREDENTIAL_ERRORS,
  type DashboardDoc,
  type DashboardEnvelope,
  type DashboardMeta,
  type Dataset,
  describePlacement,
  docSecretIds,
  FEED_MIN_REFRESH_SEC,
  inferTable,
  MAX_SECRETS_PER_USER,
  OpError,
  parseBinding,
  parseDashboard,
  placementConflict,
  type SecretInfo,
  type SecretMode,
  type SecretPlacement,
  secretParamIssue,
  secretRefChanges,
  secretValueIssue,
  sourceSecretIds,
  type UploadedFile,
  type VersionInfo,
  type Visibility,
} from '@patchbay/core';
import Papa from 'papaparse';
import type { Secrets } from '../auth/secrets.ts';
import type { UserRow, Users } from '../auth/users.ts';
import { unknownConnectorMessage } from '../connectors/registry.ts';
import { now } from '../db.ts';
import type { LiveHub } from '../live/hub.ts';
import type { DashboardIndex } from '../store/dashboard-index.ts';
import type { FolderStore, StoredMeta } from '../store/folder-store.ts';
import { newDashboardId, newId, randomToken, safeEqual, sha256 } from '../util/crypto.ts';
import { badRequest, forbidden, HttpError, notFound, unauthorized } from '../util/errors.ts';
import type { Credential } from '../util/safe-fetch.ts';
import type { DashboardTarget } from './data.ts';
import { buildTemplate } from './templates.ts';

export interface Principal {
  user: UserRow | null;
  isAdmin: boolean;
  /**
   * A bearer token (OAuth access token or PAT) authenticated the request, i.e. an agent or a script rather than a
   * person in the web app. Tokens can use secrets but never manage them or publish data fetched with them.
   */
  viaToken: boolean;
  /** The token lacks the dashboards:write scope. */
  readOnly?: boolean | undefined;
  /** Edit key presented for an anonymous dashboard (header X-Edit-Key). */
  editKey?: string | undefined;
  /** Set when the request comes through MCP, e.g. "Claude". */
  mcpClient?: string | undefined;
}

/** What the web app sends after the user confirmed publishing data fetched with secrets; tokens cannot. */
export interface PublicSecretsConfirmation {
  confirmPublicSecrets?: boolean | undefined;
}

export interface SecretsStatus {
  mode: SecretMode;
  /** Whether this user may store and use secrets right now. */
  canUseSecrets: boolean;
}

export interface SecretListItem extends SecretInfo {
  /** "Authorization: Bearer", "Header X-API-Key", "Query parameter api_key". */
  sentAs: string;
  usedBy?: { dashboardId: string; dashboardTitle: string; datasetId: string; datasetName: string }[];
}

// The 428 code and the generic credential errors live in core, because the web app matches on exactly these strings.
export { CONFIRM_PUBLIC_SECRETS, CREDENTIAL_ERRORS } from '@patchbay/core';

const CLAIM_FIRST = 'Sign in and claim this dashboard to use secrets.';
const TOKEN_PUBLISH =
  'Make it public in the web app; it would show data fetched with your secrets to anyone. Tokens cannot do this.';
const TOKEN_PUBLIC_EDIT =
  'This dashboard is public and shows data fetched with secrets, so agents and tokens cannot change it: a person has to make this change in the Patchbay web app. Ask the user to do it there, or to make the dashboard private first.';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_FILES = 20;
export const MAX_DASHBOARD_BYTES = 25 * 1024 * 1024;
const TOUCH_INTERVAL_MS = 10 * 60_000;

export class ConflictError extends HttpError {
  readonly current: DashboardEnvelope;
  constructor(current: DashboardEnvelope) {
    super(409, 'The dashboard changed since you loaded it', { current });
    this.current = current;
  }
}

interface SecretWriteOptions extends PublicSecretsConfirmation {
  /** Restores skip the existence and binding checks; use time reports dead references instead. */
  restore?: boolean;
}

function withoutSecrets(d: Dataset): Dataset {
  if (d.source.kind !== 'http' || !d.source.secrets) return d;
  const { secrets: _removed, ...source } = d.source;
  return { ...d, source };
}

function secretName(raw: string): string {
  const name = raw.trim();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  if (name.length < 1 || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw badRequest('Names are 1-80 characters without line breaks');
  }
  return name;
}

export function actorOf(p: Principal): Actor {
  if (p.mcpClient)
    return { kind: 'mcp', ...(p.user ? { userId: p.user.id } : {}), label: `${p.mcpClient} (MCP)` };
  if (p.user) return { kind: 'user', userId: p.user.id, label: p.user.name };
  return { kind: 'anonymous', label: 'Anonymous' };
}

/** What the service needs to know about connectors (the ConnectorService, or a stand-in in tests). */
export interface ConnectorLookup {
  has(id: string): boolean;
  get(id: string): { info: { minRefreshSec: number } } | undefined;
}

export class DashboardService {
  private readonly store: FolderStore;
  private readonly index: DashboardIndex;
  private readonly hub: LiveHub;
  private readonly connectors: ConnectorLookup;
  private readonly secrets: Secrets;
  private readonly secretMode: SecretMode;
  private readonly users: Users;
  /** Secret ids whose decryption failure was already logged; once per secret per process is enough. */
  private readonly undecryptableLogged = new Set<string>();

  constructor(
    store: FolderStore,
    index: DashboardIndex,
    hub: LiveHub,
    connectors: ConnectorLookup,
    secrets: { store: Secrets; mode: SecretMode; users: Users },
  ) {
    this.store = store;
    this.index = index;
    this.hub = hub;
    this.connectors = connectors;
    this.secrets = secrets.store;
    this.secretMode = secrets.mode;
    this.users = secrets.users;
  }

  /**
   * Datasets whose source a change points at a connector that does not exist. Only new or changed sources count:
   * documents saved before a connector was removed must keep loading and accept unrelated edits.
   */
  private unknownConnectors(before: DashboardDoc, after: DashboardDoc) {
    const previous = new Map(before.datasets.map((d) => [d.id, d.source]));
    return after.datasets.flatMap((d) => {
      if (d.source.kind !== 'connector' || this.connectors.has(d.source.connector)) return [];
      const old = previous.get(d.id);
      if (old?.kind === 'connector' && old.connector === d.source.connector) return [];
      return [{ datasetId: d.id, connector: d.source.connector }];
    });
  }

  /** Rejects a batch that introduces an unknown connector, naming the operation that did it. */
  private checkOpsConnectors(before: DashboardDoc, after: DashboardDoc, ops: unknown[]) {
    const [bad] = this.unknownConnectors(before, after);
    if (!bad) return;
    const raw = ops as {
      op?: unknown;
      id?: unknown;
      dataset?: { id?: unknown };
      set?: { source?: unknown };
    }[];
    const index = raw.findLastIndex(
      (o) =>
        (o?.op === 'addDataset' && o.dataset?.id === bad.datasetId) ||
        (o?.op === 'updateDataset' && o.id === bad.datasetId && o.set?.source !== undefined),
    );
    const message = `Dataset "${bad.datasetId}": ${unknownConnectorMessage(bad.connector)}`;
    throw index >= 0 ? new OpError(unknownConnectorMessage(bad.connector), index) : badRequest(message);
  }

  /**
   * Raises a new or changed refreshSec that is below its connector's minRefreshSec to that minimum, as one more
   * operation, and says so in the change log. The connector cache would serve the same reading until then anyway; a
   * stored "every 5 s" on a source that updates every 15 min only misleads whoever reads the document. Raising beats
   * rejecting: the batch an agent sent still saves. Datasets the batch did not touch are left alone, so documents
   * saved before a minimum went up keep loading and accept unrelated edits.
   */
  private raiseRefreshToMinimum(before: DashboardDoc, result: { doc: DashboardDoc; changes: string[] }) {
    const previous = new Map(before.datasets.map((d) => [d.id, d]));
    const raises = result.doc.datasets.flatMap((d) => {
      if (d.refreshSec <= 0) return [];
      let min: number;
      let what: string;
      if (d.source.kind === 'connector') {
        min = this.connectors.get(d.source.connector)?.info.minRefreshSec ?? 0;
        what = `the minimum of the ${d.source.connector} connector`;
      } else if (d.source.kind === 'feed') {
        min = FEED_MIN_REFRESH_SEC;
        what = 'the minimum for feeds';
      } else return [];
      if (d.refreshSec >= min) return [];
      const old = previous.get(d.id);
      const untouched =
        old?.refreshSec === d.refreshSec && JSON.stringify(old.source) === JSON.stringify(d.source);
      return untouched ? [] : [{ dataset: d, what, min }];
    });
    if (raises.length === 0) return result;
    const raised = applyOps(
      result.doc,
      raises.map(({ dataset, min }) => ({ op: 'updateDataset', id: dataset.id, set: { refreshSec: min } })),
    );
    return {
      doc: raised.doc,
      changes: [
        ...result.changes,
        ...raises.map(
          ({ dataset, what, min }) =>
            `Raised refreshSec of dataset "${dataset.name}" from ${dataset.refreshSec} s to ${min} s, ${what}`,
        ),
      ],
    };
  }

  private publicMeta(m: StoredMeta, title: string): DashboardMeta {
    return {
      id: m.id,
      title,
      ownerId: m.ownerId,
      visibility: m.visibility,
      version: m.version,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      lastViewedAt: m.lastViewedAt,
      ...(m.lastActor ? { lastActor: m.lastActor } : {}),
    };
  }

  canView(meta: StoredMeta, p: Principal): boolean {
    return meta.visibility === 'public' || p.isAdmin || (p.user !== null && meta.ownerId === p.user.id);
  }

  canEdit(meta: StoredMeta, p: Principal): boolean {
    if (meta.ownerId) return p.user?.id === meta.ownerId;
    return Boolean(meta.editKeyHash && p.editKey && safeEqual(sha256(p.editKey), meta.editKeyHash));
  }

  private envelope(meta: StoredMeta, doc: DashboardDoc, p: Principal): DashboardEnvelope {
    return {
      meta: this.publicMeta(meta, doc.title),
      doc,
      access: {
        canEdit: this.canEdit(meta, p),
        isOwner: p.user !== null && meta.ownerId === p.user.id,
        anonymous: meta.ownerId === null,
      },
    };
  }

  private async load(id: string) {
    const meta = await this.store.readMeta(id);
    if (!meta) {
      // The folder vanished (deleted by hand): heal the index.
      this.index.remove(id);
      throw notFound('Dashboard not found');
    }
    const doc = await this.store.readDoc(id);
    if (!doc) throw notFound('Dashboard not found');
    return { meta, doc };
  }

  /** Loads for viewing. Private dashboards look like 404 to strangers (no existence leak). */
  async loadViewable(id: string, p: Principal) {
    const loaded = await this.load(id).catch((e) => {
      if (e instanceof HttpError) throw e;
      throw notFound('Dashboard not found');
    });
    if (!this.canView(loaded.meta, p)) {
      if (!p.user) throw unauthorized('This dashboard is private. Sign in to view it.');
      throw notFound('Dashboard not found');
    }
    return loaded;
  }

  async get(id: string, p: Principal, options: { touch?: boolean } = {}): Promise<DashboardEnvelope> {
    const { meta, doc } = await this.loadViewable(id, p);
    if (options.touch && Date.now() - Date.parse(meta.lastViewedAt) > TOUCH_INTERVAL_MS) {
      await this.store.withLock(id, async () => {
        const fresh = await this.store.readMeta(id);
        if (!fresh) return;
        fresh.lastViewedAt = now();
        await this.store.writeMeta(fresh);
        this.index.touch(id, fresh.lastViewedAt);
      });
    }
    return this.envelope(meta, doc, p);
  }

  async create(
    p: Principal,
    input: {
      title?: string | undefined;
      template?: string | undefined;
      doc?: DashboardDoc;
      visibility?: Visibility | undefined;
      changes?: string[];
    } & PublicSecretsConfirmation,
  ): Promise<{ envelope: DashboardEnvelope; editKey?: string }> {
    const doc = input.doc ? parseDashboard(input.doc) : buildTemplate(input.template ?? 'blank', input.title);
    if (input.visibility === 'private' && !p.user)
      throw badRequest('Anonymous dashboards are always public. Sign in to create private ones.');
    const secretIds = docSecretIds(doc);
    if (secretIds.length) {
      if (!p.user) throw badRequest(CLAIM_FIRST);
      if (input.visibility === 'public')
        this.assertMayShowSecrets(p, p.user.id, secretIds, input, TOKEN_PUBLISH);
    }
    const id = newDashboardId();
    const at = now();
    const editKey = p.user ? undefined : randomToken('pbk_', 24);
    const meta: StoredMeta = {
      id,
      ownerId: p.user?.id ?? null,
      ownerEmail: p.user?.email ?? null,
      visibility: p.user ? (input.visibility ?? 'private') : 'public',
      editKeyHash: editKey ? sha256(editKey) : null,
      version: 1,
      createdAt: at,
      updatedAt: at,
      lastViewedAt: at,
      lastActor: actorOf(p),
    };
    await this.store.create(
      meta,
      doc,
      actorOf(p),
      input.changes ?? [input.template ? `Created from template "${input.template}"` : 'Created'],
    );
    this.index.upsert(meta, { title: doc.title, widgets: doc.widgets.length });
    const principal = editKey ? { ...p, editKey } : p;
    return { envelope: this.envelope(meta, doc, principal), ...(editKey ? { editKey } : {}) };
  }

  /** Writes a new version under the lock; `mutate` receives the latest document. */
  private async commit(
    id: string,
    p: Principal,
    mutate: (doc: DashboardDoc, meta: StoredMeta) => { doc: DashboardDoc; changes: string[] },
    secretOptions: SecretWriteOptions = {},
  ): Promise<{ envelope: DashboardEnvelope; changes: string[] }> {
    const result = await this.store.withLock(id, async () => {
      const { meta, doc } = await this.load(id);
      if (!this.canEdit(meta, p)) throw forbidden('You cannot edit this dashboard');
      const next = mutate(doc, meta);
      this.checkSecretRefs(meta, doc, next.doc, p, secretOptions);
      const actor = actorOf(p);
      const updated: StoredMeta = {
        ...meta,
        version: meta.version + 1,
        updatedAt: now(),
        lastViewedAt: now(),
        lastActor: actor,
      };
      await this.store.writeDoc(updated, next.doc, actor, next.changes);
      this.index.upsert(updated, { title: next.doc.title, widgets: next.doc.widgets.length });
      return { meta: updated, doc: next.doc, changes: next.changes, actor };
    });
    await this.hub.docChanged(id, {
      type: 'doc',
      version: result.meta.version,
      actor: result.actor,
      changes: result.changes,
    });
    return { envelope: this.envelope(result.meta, result.doc, p), changes: result.changes };
  }

  /** Full-document save from the editor, with optimistic concurrency. */
  async save(
    id: string,
    p: Principal,
    rawDoc: unknown,
    baseVersion: number,
    changes: string[] = ['Edited in the editor'],
    options: PublicSecretsConfirmation = {},
  ) {
    const doc = parseDashboard(rawDoc);
    return this.commit(
      id,
      p,
      (current, meta) => {
        if (meta.version !== baseVersion) {
          throw new ConflictError(this.envelope(meta, current, p));
        }
        const [bad] = this.unknownConnectors(current, doc);
        if (bad) throw badRequest(`Dataset "${bad.datasetId}": ${unknownConnectorMessage(bad.connector)}`);
        return { doc, changes };
      },
      options,
    );
  }

  /** Semantic ops (agents, or editor batches). Ops address ids, so they apply to the latest version. */
  async applyOps(
    id: string,
    p: Principal,
    ops: unknown[],
    options: { dryRun?: boolean; baseVersion?: number } & PublicSecretsConfirmation = {},
  ) {
    if (!Array.isArray(ops) || ops.length === 0) throw badRequest('Provide at least one operation');
    if (ops.length > 100) throw badRequest('At most 100 operations per batch');
    if (options.dryRun) {
      const { meta, doc } = await this.load(id);
      if (!this.canEdit(meta, p)) throw forbidden('You cannot edit this dashboard');
      const applied = applyOps(doc, ops);
      this.checkOpsConnectors(doc, applied.doc, ops);
      const result = this.raiseRefreshToMinimum(doc, applied);
      // A dry run answers exactly like the save would, so agents learn about secret rules before saving.
      this.checkSecretRefs(meta, doc, result.doc, p, options);
      return { envelope: this.envelope(meta, result.doc, p), changes: result.changes, dryRun: true };
    }
    return this.commit(
      id,
      p,
      (doc, meta) => {
        if (options.baseVersion !== undefined && options.baseVersion !== meta.version) {
          throw new ConflictError(this.envelope(meta, doc, p));
        }
        const applied = applyOps(doc, ops);
        this.checkOpsConnectors(doc, applied.doc, ops);
        return this.raiseRefreshToMinimum(doc, applied);
      },
      options,
    );
  }

  async setVisibility(
    id: string,
    p: Principal,
    visibility: Visibility,
    options: PublicSecretsConfirmation = {},
  ) {
    const result = await this.store.withLock(id, async () => {
      const { meta, doc } = await this.load(id);
      if (!p.user || meta.ownerId !== p.user.id) throw forbidden('Only the owner can change visibility');
      const secretIds = docSecretIds(doc);
      if (visibility === 'public' && meta.visibility !== 'public' && secretIds.length) {
        this.assertMayShowSecrets(p, meta.ownerId, secretIds, options, TOKEN_PUBLISH);
      }
      const updated = { ...meta, visibility, updatedAt: now() };
      await this.store.writeMeta(updated);
      this.index.upsert(updated, { title: doc.title, widgets: doc.widgets.length });
      return this.envelope(updated, doc, p);
    });
    if (visibility === 'private') {
      // Live streams opened while it was public must not keep receiving data.
      const meta = await this.store.readMeta(id);
      if (meta) this.hub.revalidate(id, (viewer) => this.canView(meta, viewer));
    }
    return result;
  }

  /** Turns an anonymous dashboard into one owned by the signed-in user. */
  async claim(id: string, p: Principal) {
    if (!p.user) throw unauthorized();
    return this.store.withLock(id, async () => {
      const { meta, doc } = await this.load(id);
      if (meta.ownerId) {
        if (meta.ownerId === p.user!.id) return this.envelope(meta, doc, p);
        throw forbidden('This dashboard already has an owner');
      }
      if (!this.canEdit(meta, p)) throw forbidden('A valid edit key is required to claim this dashboard');
      // Anonymous documents never hold secret references (every write checks it), so this cannot happen. If a
      // folder was edited by hand, refuse: claiming would let the claimant's secrets resolve in a prepared document.
      if (docSecretIds(doc).length)
        throw forbidden('This dashboard references secrets and cannot be claimed');
      const updated: StoredMeta = {
        ...meta,
        ownerId: p.user!.id,
        ownerEmail: p.user!.email,
        editKeyHash: null,
        updatedAt: now(),
      };
      await this.store.writeMeta(updated);
      this.index.upsert(updated, { title: doc.title, widgets: doc.widgets.length });
      return this.envelope(updated, doc, { ...p, editKey: undefined });
    });
  }

  async duplicate(id: string, p: Principal) {
    const { meta, doc } = await this.loadViewable(id, p);
    // Secrets belong to the dashboard's owner. Anyone else's copy would hold dead references (or be rejected, when
    // anonymous), so they are removed and the copy loads its URLs without credentials.
    const strip = !(p.user && meta.ownerId === p.user.id) && docSecretIds(doc).length > 0;
    const datasets = strip ? doc.datasets.map(withoutSecrets) : doc.datasets;
    const created = await this.create(p, {
      doc: { ...doc, datasets, title: `${doc.title} (copy)` },
      ...(strip ? { changes: ['Created', 'Removed secret references (secrets belong to their owner)'] } : {}),
    });
    // Copy only files the copied datasets actually use: unreferenced uploads stay private to editors.
    const used = new Set(doc.datasets.flatMap((d) => (d.source.kind === 'upload' ? [d.source.fileId] : [])));
    for (const file of (await this.store.listFiles(id)).filter((f) => used.has(f.id))) {
      const table = await this.store.readFileTable(id, file.id);
      if (table) await this.store.saveFile(created.envelope.meta.id, { ...file, table });
    }
    return created;
  }

  async delete(id: string, p: Principal) {
    const meta = await this.store.readMeta(id);
    if (!meta) throw notFound('Dashboard not found');
    const isOwner = p.user !== null && meta.ownerId === p.user.id;
    if (!isOwner && !p.isAdmin) throw forbidden('Only the owner or an admin can delete a dashboard');
    await this.store.withLock(id, () => this.store.remove(id));
    this.index.remove(id);
    this.hub.deleted(id);
  }

  async versions(id: string, p: Principal): Promise<VersionInfo[]> {
    await this.loadViewable(id, p);
    return this.store.listVersions(id);
  }

  async restore(id: string, p: Principal, version: number, options: PublicSecretsConfirmation = {}) {
    const stored = await this.store.readVersion(id, version);
    if (!stored) throw notFound(`Version ${version} not found`);
    // A restored reference to a deleted or rebound secret shows "not available" at use time instead of blocking the
    // restore; the anonymous invariant and the public-dashboard rules still apply.
    return this.commit(
      id,
      p,
      () => ({
        doc: parseDashboard(stored.doc),
        changes: [`Restored version ${version}`],
      }),
      { ...options, restore: true },
    );
  }

  listMine(p: Principal): DashboardMeta[] {
    if (!p.user) throw unauthorized();
    return this.index.listByOwner(p.user.id);
  }

  async uploadFile(
    id: string,
    p: Principal,
    input: { name: string; content: string; format?: 'csv' | 'json' | undefined },
  ): Promise<UploadedFile> {
    const { meta } = await this.load(id);
    if (!this.canEdit(meta, p)) throw forbidden('You cannot edit this dashboard');
    if (Buffer.byteLength(input.content) > MAX_FILE_BYTES) throw badRequest('Files are limited to 5 MB');
    const existing = await this.store.listFiles(id);
    const usedBytes = existing.reduce((sum, f) => sum + f.size, 0);
    if (existing.length >= MAX_FILES || usedBytes + Buffer.byteLength(input.content) > MAX_DASHBOARD_BYTES) {
      throw badRequest(
        `A dashboard can hold up to ${MAX_FILES} files and ${MAX_DASHBOARD_BYTES / 1024 / 1024} MB of uploads. Delete unused files first.`,
      );
    }
    const format =
      input.format ?? (/\.json$/i.test(input.name) || /^\s*[[{]/.test(input.content) ? 'json' : 'csv');
    let records: unknown[];
    if (format === 'json') {
      let json: unknown;
      try {
        json = JSON.parse(input.content);
      } catch {
        throw badRequest('The file is not valid JSON');
      }
      records = Array.isArray(json) ? json : (Object.values(json as object).find(Array.isArray) ?? [json]);
    } else {
      const parsed = Papa.parse<Record<string, string>>(input.content.replace(/^﻿/, ''), {
        header: true,
        skipEmptyLines: 'greedy',
        transformHeader: (h) => h.trim(),
      });
      if (parsed.errors.length && parsed.data.length === 0)
        throw badRequest(`Could not parse CSV: ${parsed.errors[0]!.message}`);
      records = parsed.data;
    }
    const table = inferTable(records, { maxRows: 100_000 });
    if (table.columns.length === 0) throw badRequest('The file contains no columns');
    const file = {
      id: `f_${newId()}`.slice(0, 20),
      name: input.name.slice(0, 120),
      rows: table.rows.length,
      columns: table.columns.length,
      size: Buffer.byteLength(input.content),
      uploadedAt: now(),
    };
    await this.store.saveFile(id, { ...file, table });
    return file;
  }

  /** Uploaded files are visible to editors only; viewers see data only through datasets. */
  async listFiles(id: string, p: Principal) {
    const { meta } = await this.loadViewable(id, p);
    if (!this.canEdit(meta, p)) throw forbidden('You cannot edit this dashboard');
    return this.store.listFiles(id);
  }

  async deleteFile(id: string, p: Principal, fileId: string) {
    const { meta, doc } = await this.load(id);
    if (!this.canEdit(meta, p)) throw forbidden('You cannot edit this dashboard');
    const users = doc.datasets.filter((d) => d.source.kind === 'upload' && d.source.fileId === fileId);
    if (users.length) throw badRequest(`File is used by dataset(s): ${users.map((d) => d.name).join(', ')}`);
    await this.store.deleteFile(id, fileId);
  }

  /** The dashboard a stored dataset of `id` resolves against, after checking the caller may view it. */
  async target(id: string, p: Principal): Promise<DashboardTarget> {
    const { meta } = await this.loadViewable(id, p);
    return { id, ownerId: meta.ownerId };
  }

  /**
   * Where an unsaved dataset definition may be previewed. Raw uploads and secrets are for editors only: a preview
   * resolves secrets against the dashboard's owner, so it must be the owner (or their agent) asking. Without a
   * dashboard, only the caller's own secrets can be used.
   */
  async previewTarget(
    p: Principal,
    dashboardId: string | undefined,
    dataset: Dataset,
    options: { requireEdit?: boolean } = {},
  ): Promise<DashboardTarget> {
    const upload = dataset.source.kind === 'upload';
    // A preview sends the credentials to a URL of the caller's choosing (within the binding) without saving
    // anything, so it is a use of the secret, not a read: read-only tokens may not do it.
    if (p.readOnly && sourceSecretIds(dataset.source).length > 0) {
      throw forbidden(
        'Previewing a source that uses secrets needs the dashboards:write scope, because it sends the credentials to the URL you choose. Reconnect with write access.',
      );
    }
    if (!dashboardId) {
      if (upload) throw badRequest('Uploaded files need dashboardId');
      if (!p.user) throw unauthorized();
      return { id: 'preview00', ownerId: p.user.id };
    }
    const { meta } = await this.loadViewable(dashboardId, p);
    const needsEdit = options.requireEdit || upload || sourceSecretIds(dataset.source).length > 0;
    if (needsEdit && !this.canEdit(meta, p)) {
      if (options.requireEdit) throw forbidden('You cannot edit this dashboard');
      throw forbidden(
        upload
          ? 'Only editors of this dashboard can preview its uploaded files'
          : 'Only editors of this dashboard can preview sources that use secrets',
      );
    }
    return { id: dashboardId, ownerId: meta.ownerId };
  }

  // Secrets ------------------------------------------------------------------------------------------------------

  /** The instance switch, applied at use time so turning it off (or losing admin rights) takes effect at once. */
  private mayUseSecrets(userId: string | null): boolean {
    if (!userId || this.secretMode === 'off') return false;
    return this.secretMode === 'users' || this.users.isAdmin(this.users.byId(userId));
  }

  private secretsRefusal(): string {
    return this.secretMode === 'admins'
      ? 'This instance only lets administrators store and use secrets.'
      : 'Secrets are turned off on this server.';
  }

  secretsStatus(user: UserRow | null): SecretsStatus {
    return { mode: this.secretMode, canUseSecrets: this.mayUseSecrets(user?.id ?? null) };
  }

  /** Values are set only in the web app: never through a model, its provider's logs or a chat transcript. */
  private secretsSession(p: Principal): UserRow {
    if (!p.user) throw unauthorized();
    if (p.viaToken)
      throw forbidden('Secrets can only be added or changed in the web app, never with a token.');
    return p.user;
  }

  private secretsWriter(p: Principal): UserRow {
    const user = this.secretsSession(p);
    if (!this.mayUseSecrets(user.id)) throw forbidden(this.secretsRefusal());
    return user;
  }

  /**
   * The caller's secrets: metadata only, never a value or anything derived from it. Allowed whatever the switch
   * says, so users can always see and clean up what they stored.
   */
  async listSecrets(
    p: Principal,
    options: { usedBy?: boolean } = {},
  ): Promise<SecretsStatus & { secrets: SecretListItem[] }> {
    if (!p.user) throw unauthorized();
    const infos = this.secrets.list(p.user.id);
    const usedBy = new Map<string, NonNullable<SecretListItem['usedBy']>>();
    if (options.usedBy && infos.length) {
      for (const d of this.index.listByOwner(p.user.id)) {
        const doc = await this.store.readDoc(d.id).catch(() => null);
        for (const ds of doc?.datasets ?? []) {
          for (const secretId of sourceSecretIds(ds.source)) {
            const list = usedBy.get(secretId) ?? [];
            list.push({
              dashboardId: d.id,
              dashboardTitle: doc!.title,
              datasetId: ds.id,
              datasetName: ds.name,
            });
            usedBy.set(secretId, list);
          }
        }
      }
    }
    return {
      ...this.secretsStatus(p.user),
      secrets: infos.map((info) => ({
        ...info,
        sentAs: describePlacement(info),
        ...(options.usedBy ? { usedBy: usedBy.get(info.id) ?? [] } : {}),
      })),
    };
  }

  createSecret(
    p: Principal,
    input: {
      name: string;
      sendTo: string;
      placement: SecretPlacement;
      paramName?: string | null;
      value: string;
    },
  ): SecretInfo {
    const user = this.secretsWriter(p);
    const name = secretName(input.name);
    let binding: { origin: string; pathPrefix: string };
    try {
      binding = parseBinding(input.sendTo);
    } catch (e) {
      if (e instanceof BindingError) throw badRequest(e.message);
      throw e;
    }
    const paramName = input.paramName?.trim() || null;
    const paramIssue = secretParamIssue(input.placement, paramName);
    if (paramIssue) throw badRequest(paramIssue);
    const value = input.value.trim();
    const valueIssue = secretValueIssue(value, input.placement);
    if (valueIssue) throw badRequest(valueIssue);
    if (this.secrets.count(user.id) >= MAX_SECRETS_PER_USER) {
      throw badRequest(
        `You can store up to ${MAX_SECRETS_PER_USER} secrets. Delete one you no longer use first.`,
      );
    }
    return this.secrets.create(user.id, { name, ...binding, placement: input.placement, paramName }, value);
  }

  /** The binding and placement stay: changing where a value may be sent is not an operation. */
  replaceSecretValue(p: Principal, id: string, rawValue: string): SecretInfo {
    const user = this.secretsWriter(p);
    const info = this.secrets.info(user.id, id);
    if (!info) throw notFound('Secret not found');
    const value = rawValue.trim();
    const issue = secretValueIssue(value, info.placement);
    if (issue) throw badRequest(issue);
    return this.secrets.replaceValue(user.id, id, value)!;
  }

  renameSecret(p: Principal, id: string, rawName: string): SecretInfo {
    const user = this.secretsWriter(p);
    const info = this.secrets.rename(user.id, id, secretName(rawName));
    if (!info) throw notFound('Secret not found');
    return info;
  }

  /** Allowed even when secrets are turned off, so users can always clean up. */
  deleteSecret(p: Principal, id: string) {
    const user = this.secretsSession(p);
    if (!this.secrets.remove(user.id, id)) throw notFound('Secret not found');
  }

  /**
   * The decrypted credentials of a dataset, resolved against the dashboard's owner: never against the viewer, the
   * editor or the agent asking. Throws an HttpError with a generic message, and a dataset whose secrets cannot all
   * be resolved is never fetched without them.
   */
  async credentialsFor(target: DashboardTarget, dataset: Dataset): Promise<Credential[]> {
    const ids = sourceSecretIds(dataset.source);
    if (ids.length === 0 || dataset.source.kind !== 'http') return [];
    const ownerId = target.ownerId;
    if (ownerId === null) throw new HttpError(403, CREDENTIAL_ERRORS.unavailable);
    if (!this.mayUseSecrets(ownerId)) throw new HttpError(403, CREDENTIAL_ERRORS.off);
    const unsealed = ids.map((id) => this.secrets.unseal(ownerId, id));
    const found = unsealed.filter((u) => u !== null);
    if (found.length !== ids.length) throw new HttpError(403, CREDENTIAL_ERRORS.unavailable);
    const url = dataset.source.url;
    if (found.some((u) => !bindingMatches(u.info, url).ok)) throw new HttpError(403, CREDENTIAL_ERRORS.bound);
    for (const u of found) {
      if (u.value !== null) continue;
      if (!this.undecryptableLogged.has(u.info.id)) {
        this.undecryptableLogged.add(u.info.id);
        console.warn(`[patchbay] secret ${u.info.id} cannot be decrypted with the configured SECRETS_KEY`);
      }
      throw new HttpError(403, CREDENTIAL_ERRORS.undecryptable);
    }
    if (placementConflict(found.map((u) => u.info))) throw new HttpError(403, CREDENTIAL_ERRORS.conflict);
    for (const u of found) this.secrets.markUsed(u.info);
    return found.map((u) => ({
      id: u.info.id,
      revision: u.revision,
      origin: u.info.origin,
      pathPrefix: u.info.pathPrefix,
      placement: u.info.placement,
      paramName: u.info.paramName,
      value: u.value!,
    }));
  }

  /**
   * Save-time rules for secret references, for clear early errors to editors and agents (use time stays
   * authoritative). Only datasets that introduce or retarget a reference are checked, so a deleted secret never
   * blocks unrelated edits or autosave.
   */
  private checkSecretRefs(
    meta: StoredMeta,
    before: DashboardDoc,
    after: DashboardDoc,
    p: Principal,
    options: SecretWriteOptions,
  ) {
    // Any edit can change what a public secret-backed dashboard shows (a pipeline step, the JSON path, a new widget,
    // an older version), not only edits to references. Such dashboards are therefore read-only for tokens: an agent
    // steered by a prompt injection must not be able to widen what the public sees.
    if (
      p.viaToken &&
      meta.visibility === 'public' &&
      (docSecretIds(before).length > 0 || docSecretIds(after).length > 0)
    ) {
      throw forbidden(TOKEN_PUBLIC_EDIT);
    }
    if (docSecretIds(after).length === 0) return;
    // Anonymous documents, and therefore all their versions, never hold references. That is what makes claiming
    // safe: a prepared document cannot wait for a victim to claim it and resolve their secrets.
    if (meta.ownerId === null) throw badRequest(CLAIM_FIRST);
    const ownerId = meta.ownerId;
    const changed = secretRefChanges(before, after);
    if (changed.length === 0) return;
    const datasets = after.datasets.filter((d) => changed.includes(d.id));
    if (!options.restore) {
      if (!this.mayUseSecrets(ownerId)) throw badRequest(this.secretsRefusal());
      for (const d of datasets) {
        if (d.source.kind !== 'http') continue;
        const infos = sourceSecretIds(d.source).map((secretId) => {
          const info = this.secrets.info(ownerId, secretId);
          if (!info) {
            throw badRequest(
              `Dataset "${d.id}": there is no secret "${secretId}" among the owner's secrets. Use list_secrets.`,
            );
          }
          return info;
        });
        for (const info of infos) {
          const match = bindingMatches(info, d.source.url);
          if (!match.ok) throw badRequest(`Dataset "${d.id}": ${bindingMismatchMessage(info, match.reason)}`);
        }
        const conflict = placementConflict(infos);
        if (conflict) throw badRequest(`Dataset "${d.id}": ${conflict}`);
      }
    }
    if (meta.visibility === 'public') {
      const ids = [...new Set(datasets.flatMap((d) => sourceSecretIds(d.source)))];
      this.assertMayShowSecrets(p, ownerId, ids, options, TOKEN_PUBLIC_EDIT);
    }
  }

  /**
   * Publishing data fetched with secrets, by making a dashboard public or by adding or re-pointing a secret on a
   * public one, is for a person in the web app after a confirmation. Tokens never can: an agent steered by a prompt
   * injection could otherwise publish whatever the secret unlocks on its host.
   */
  private assertMayShowSecrets(
    p: Principal,
    ownerId: string,
    secretIds: string[],
    options: PublicSecretsConfirmation,
    tokenMessage: string,
  ) {
    if (p.viaToken) throw forbidden(tokenMessage);
    if (options.confirmPublicSecrets) return;
    const secrets = secretIds.map((id) => ({ id, name: this.secrets.info(ownerId, id)?.name ?? null }));
    const names = secrets.map((s) => (s.name ? `"${s.name}"` : s.id)).join(', ');
    throw new HttpError(
      428,
      `Anyone who can view this dashboard will see the data fetched with ${names} (never the secrets themselves). Confirm to continue.`,
      { code: CONFIRM_PUBLIC_SECRETS, secrets },
    );
  }

  async prune(options: { olderThanDays: number; onlyAnonymous: boolean }): Promise<string[]> {
    const cutoff = new Date(Date.now() - options.olderThanDays * 86_400_000).toISOString();
    const ids = this.index.idsViewedBefore(cutoff, options.onlyAnonymous);
    for (const id of ids) {
      await this.store.withLock(id, () => this.store.remove(id));
      this.index.remove(id);
      this.hub.deleted(id);
    }
    return ids;
  }
}
