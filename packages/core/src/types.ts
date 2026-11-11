/** Wire types shared by the server and the web client. */
import type { CalendarWindow } from './parameters.ts';
import type { DashboardDoc } from './schema.ts';
import type { DataTable } from './table.ts';
import type { PipelineResult } from './transforms.ts';

export type Visibility = 'public' | 'private';

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  isAdmin: boolean;
}

export interface Actor {
  kind: 'user' | 'anonymous' | 'mcp' | 'system';
  userId?: string;
  /** e.g. "Jane Doe" or "Claude (via MCP)" */
  label: string;
}

export interface DashboardMeta {
  id: string;
  title: string;
  ownerId: string | null;
  visibility: Visibility;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastViewedAt: string;
  lastActor?: Actor;
}

export interface DashboardAccess {
  canEdit: boolean;
  isOwner: boolean;
  /** Created without an account; always public, editable with its edit key. */
  anonymous: boolean;
  /**
   * Editors only: the dashboard's sources may reach the operator's private hosts (ALLOW_PRIVATE_HOSTS), decided by its
   * owner. False for everyone else; absent from older servers.
   */
  privateHosts?: boolean;
}

export interface DashboardEnvelope {
  meta: DashboardMeta;
  doc: DashboardDoc;
  access: DashboardAccess;
}

/**
 * How a cached connector copy served after a failed refresh starts its warning. The widget badge reads "stale" only
 * for it: the other warnings (a capped source, a cut parent) are current data that is incomplete.
 */
export const CACHED_DATA_WARNING = 'Showing cached data';

export interface DatasetResult {
  datasetId: string;
  table: DataTable;
  fetchedAt: string;
  hash: string;
  truncated: boolean;
  trace?: PipelineResult['trace'];
  /** The dataset failed: no rows, or only what an earlier step kept. */
  error?: string;
  /** The failure is this server's own limit, not the source: ask again after this many seconds. */
  retryAfterSec?: number;
  /**
   * The error cannot pass by asking again: only an edit of the dashboard, a secret or a server setting fixes it. The
   * page asks again only rarely (every 15 minutes), so a fix made while a wall screen stays open still shows up.
   * Never set together with `retryAfterSec`; absent means it may pass.
   */
  lasting?: true;
  /**
   * Set by the data route for a dataset whose lineage uses a date filter at a relative period: the window the rows
   * were computed for and how long it stays valid. The page refetches when it expires and starts a new sound baseline
   * when the window changes, so a wall screen follows the server's midnight, not its own clock. Never stored in a
   * cache; absent from older servers.
   */
  calendar?: CalendarWindow;
  /**
   * Rows were served but with a caveat (a capped source, a cached copy after a failed refresh, a long parent cut):
   * shown next to the data, never treated as a failure.
   */
  warning?: string;
}

export interface VersionInfo {
  version: number;
  savedAt: string;
  actor: Actor;
  changes: string[];
}

export interface ParamSpec {
  name: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'enum';
  required: boolean;
  default?: string | number | boolean;
  options?: { value: string; label: string }[];
  description?: string;
}

export interface ConnectorInfo {
  id: string;
  name: string;
  category: string;
  description: string;
  params: ParamSpec[];
  /** Upstream data is cached at least this long, whatever the dataset asks for. */
  minRefreshSec: number;
  docsUrl: string;
  attribution: string;
}

export type LiveEvent =
  | { type: 'hello'; version: number }
  | { type: 'doc'; version: number; actor: Actor; changes: string[] }
  | { type: 'data'; result: DatasetResult }
  | { type: 'deleted' };

export interface UploadedFile {
  id: string;
  name: string;
  rows: number;
  columns: number;
  /** Bytes of the file as uploaded. */
  size: number;
  /** Bytes it takes on the server's disk once parsed; the storage limits count this, not `size`. */
  storedBytes?: number;
  uploadedAt: string;
}

export interface AdminDashboardRow extends DashboardMeta {
  ownerEmail: string | null;
  sizeBytes: number;
  widgets: number;
}
