/**
 * Checks shaped like an infra monitor's checks.json, with a `service` on every row: one failing backup, a few
 * containers stopped on purpose, the rest ok. Shared by the core, server and web tests and by the browser check,
 * which seeds an inline dataset from `infraChecks(Date.now())`. Not part of the app.
 */
import type { StatusConfigInput } from './schema.ts';
import { type DataTable, inferTable } from './table.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** 12:00 UTC on the day the widget was specified; tests read relative times against it. */
export const INFRA_NOW = Date.UTC(2026, 10, 5, 12);

type Check = [
  machine: string,
  kind: string,
  name: string,
  service: string,
  project: string | null,
  status: string,
  ago: number,
  value: number | null,
  detail: string | null,
];

const CHECKS: readonly Check[] = [
  ['nas', 'container', 'cue-app', 'cue', 'cue', 'ok', 12 * DAY, null, null],
  ['nas', 'container', 'cue-db', 'cue', 'cue', 'ok', 12 * DAY, null, null],
  [
    'nas',
    'backup',
    'cue-backup',
    'cue',
    null,
    'fail',
    9 * HOUR,
    null,
    'FAILED: cue: Postgres container cue-backup-1 is not running, no dump',
  ],
  ['nas', 'container', 'cue-backup-1', 'cue', 'cue', 'off', 2 * DAY, null, 'exited (0)'],
  ['nas', 'container', 'blog-web', 'blog', 'blog', 'ok', 5 * DAY, null, null],
  ['nas', 'container', 'blog-api', 'blog', 'blog', 'ok', 5 * DAY, null, null],
  ['nas', 'cert', 'blog-cert', 'blog', null, 'ok', 30 * DAY, 87, 'expires in 87 days'],
  ['nas', 'container', 'umami', 'umami', 'umami', 'off', 9 * DAY, null, 'stopped on purpose'],
  ['nas', 'container', 'immich-server', 'immich', 'immich', 'ok', 3 * DAY, null, null],
  ['nas', 'container', 'immich-ml', 'immich', 'immich', 'ok', 3 * DAY, null, null],
  ['nas', 'backup', 'immich-backup', 'immich', null, 'ok', 11 * HOUR, 2.1, 'dump 2.1 GB'],
  ['nas', 'disk', 'volume1', 'nas', null, 'ok', 40 * DAY, 61, '61 % used'],
  ['nas', 'container', 'watchtower', 'watchtower', 'watchtower', 'ok', 20 * DAY, null, null],
  ['nuc', 'container', 'home-assistant', 'home-assistant', 'home-assistant', 'ok', 6 * DAY, null, null],
  ['nuc', 'web', 'home-assistant-ui', 'home-assistant', null, 'ok', 6 * DAY, 120, '200 in 120 ms'],
  ['nuc', 'container', 'pihole', 'pihole', 'pihole', 'ok', 15 * DAY, null, null],
  ['nuc', 'web', 'pihole-admin', 'pihole', null, 'ok', 15 * DAY, 45, '200 in 45 ms'],
  ['nuc', 'container', 'grafana', 'grafana', 'grafana', 'off', 21 * DAY, null, null],
  ['nuc', 'container', 'old-wiki', 'old-wiki', 'old-wiki', 'off', 60 * DAY, null, null],
  ['nuc', 'web', 'old-wiki-web', 'old-wiki', null, 'off', 60 * DAY, null, null],
  ['nuc', 'disk', 'nvme0', 'nuc', null, 'ok', 40 * DAY, 34, '34 % used'],
  ['internet', 'web', 'blog.example.com', 'blog.example.com', null, 'ok', 2 * DAY, 180, '200 in 180 ms'],
  [
    'internet',
    'cert',
    'blog.example.com-cert',
    'blog.example.com',
    null,
    'ok',
    30 * DAY,
    87,
    'expires in 87 days',
  ],
  ['internet', 'web', 'status.example.com', 'status', null, 'ok', 2 * DAY, 95, '200 in 95 ms'],
  ['internet', 'web', 'patchbay.example.com', 'patchbay', null, 'ok', DAY, 210, '200 in 210 ms'],
  [
    'internet',
    'cert',
    'patchbay.example.com-cert',
    'patchbay',
    null,
    'ok',
    30 * DAY,
    54,
    'expires in 54 days',
  ],
];

/** Inline rows with ISO times, because that is how a dataset stores them; `now` keeps relative times stable. */
export function infraChecks(now = INFRA_NOW): Record<string, string | number | null>[] {
  const iso = (ms: number) => new Date(ms).toISOString();
  return CHECKS.map(([machine, kind, name, service, project, status, ago, value, detail]) => ({
    machine,
    kind,
    name,
    service,
    project,
    status,
    since: iso(now - ago),
    checked_at: iso(now - 2 * 60_000),
    value,
    detail,
  }));
}

export function infraTable(now = INFRA_NOW): DataTable {
  return inferTable(infraChecks(now));
}

/** Web addresses as the monitor's `url` column sends them: the same on every row of a service, none without web. */
export const INFRA_URLS: Readonly<Record<string, string>> = {
  cue: 'https://cue.example.com',
  blog: 'https://blog.example.com',
  'blog.example.com': 'https://blog.example.com',
  'home-assistant': 'https://home.example.com',
  status: 'https://status.example.com',
  patchbay: 'https://patchbay.example.com',
};

/** The checks with that `url` column, for the link on each tile. */
export function infraLinkedChecks(now = INFRA_NOW): Record<string, string | number | null>[] {
  return infraChecks(now).map((row) => ({ ...row, url: INFRA_URLS[String(row.service)] ?? null }));
}

/** How an infra status dashboard is meant to show these checks. */
export const INFRA_STATUS_CONFIG = {
  entity: 'service',
  status: 'status',
  group: 'machine',
  label: 'name',
  kind: 'kind',
  detail: 'detail',
  since: 'since',
} as const satisfies StatusConfigInput;
