/** Wire types shared by the server and the web client. */
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
}

export interface DashboardEnvelope {
  meta: DashboardMeta;
  doc: DashboardDoc;
  access: DashboardAccess;
}

export interface DatasetResult {
  datasetId: string;
  table: DataTable;
  fetchedAt: string;
  hash: string;
  truncated: boolean;
  trace?: PipelineResult['trace'];
  error?: string;
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
  size: number;
  uploadedAt: string;
}

export interface AdminDashboardRow extends DashboardMeta {
  ownerEmail: string | null;
  sizeBytes: number;
  widgets: number;
}
