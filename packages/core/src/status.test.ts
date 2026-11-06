import { describe, expect, it } from 'vitest';
import {
  applyOps,
  emptyDashboard,
  inferTable,
  isDataWidgetType,
  SIZE_HINTS,
  STATUS_LEVELS,
  STATUS_VOCABULARY,
  type StatusConfigInput,
  StatusConfigSchema,
  type StatusModel,
  statusConfigProblem,
  statusCountsText,
  statusDefaults,
  statusFields,
  statusFit,
  statusLevels,
  statusModel,
  statusProblemHead,
  statusSectionTitle,
  statusSummary,
  statusTileFoot,
  statusTilesByKey,
  WidgetSchema,
} from './index.ts';
import {
  INFRA_NOW,
  INFRA_STATUS_CONFIG,
  infraChecks,
  infraLinkedChecks,
  infraTable,
} from './status.fixture.ts';

const HOUR = 3_600_000;
const config = (input: Partial<StatusConfigInput> = {}) =>
  StatusConfigSchema.parse({ ...INFRA_STATUS_CONFIG, ...input });
const plain = StatusConfigSchema.parse({ entity: 'service', status: 'status' });
const infra = () => statusModel(infraTable(), config());
const names = (tiles: { entity: string }[]) => tiles.map((t) => t.entity);
const section = (label: string) => infra().sections.find((s) => s.label === label)!;
const tile = (sectionLabel: string, entity: string) =>
  section(sectionLabel).tiles.find((t) => t.entity === entity)!;

describe('status levels', () => {
  it('reads the default vocabulary, whatever the case and spacing', () => {
    const level = statusLevels();
    for (const l of STATUS_LEVELS) {
      for (const word of STATUS_VOCABULARY[l]) {
        expect(level(word)).toBe(l);
        expect(level(` ${word.toUpperCase()} `)).toBe(l);
      }
    }
  });

  it('treats anything unexpected as warn, and booleans as ok and fail', () => {
    const level = statusLevels();
    expect([level('running'), level(''), level(null), level(undefined), level(0), level(200)]).toEqual([
      'warn',
      'warn',
      'warn',
      'warn',
      'warn',
      'warn',
    ]);
    expect([level(true), level(false)]).toEqual(['ok', 'fail']);
  });

  it('maps the widget’s own values first, case-insensitively', () => {
    const level = statusLevels({ Running: 'ok', down: 'off', '200': 'ok', false: 'off' });
    expect(level('running')).toBe('ok');
    expect(level('DOWN')).toBe('off');
    expect(level(200)).toBe('ok');
    expect(level(false)).toBe('off');
    expect(level('error')).toBe('fail');
  });

  it('counts both problem levels in words when both occur', () => {
    expect(statusCountsText({ fail: 1, warn: 2, ok: 3, off: 0 })).toBe('3 problems (1 fail, 2 warn) · 3 ok');
    expect(statusCountsText({ fail: 0, warn: 0, ok: 0, off: 0 })).toBe('No checks');
  });
});

describe('status schema', () => {
  it('fills the default and round-trips', () => {
    expect(StatusConfigSchema.parse({ entity: 'service', status: 'status' })).toEqual({
      entity: 'service',
      status: 'status',
      summary: true,
    });
    const full = config({ levels: { running: 'ok' }, summary: false });
    expect(StatusConfigSchema.parse(JSON.parse(JSON.stringify(full)))).toEqual(full);
  });

  it('is strict and bounds levels', () => {
    const ok = { entity: 'a', status: 'b' };
    expect(StatusConfigSchema.safeParse({ ...ok, colour: 'red' }).success).toBe(false);
    expect(StatusConfigSchema.safeParse({ status: 'b' }).success).toBe(false);
    expect(StatusConfigSchema.safeParse({ entity: '', status: 'b' }).success).toBe(false);
    expect(StatusConfigSchema.safeParse({ ...ok, levels: { x: 'bad' } }).success).toBe(false);
    expect(StatusConfigSchema.safeParse({ ...ok, levels: { ['k'.repeat(41)]: 'ok' } }).success).toBe(false);
    const levels = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`v${i}`, 'ok']));
    expect(StatusConfigSchema.safeParse({ ...ok, levels: levels(40) }).success).toBe(true);
    expect(StatusConfigSchema.safeParse({ ...ok, levels: levels(41) }).success).toBe(false);
  });

  it('takes an optional link column and still rejects unknown keys', () => {
    const ok = { entity: 'a', status: 'b' };
    expect(StatusConfigSchema.parse({ ...ok, link: 'url' })).toEqual({ ...ok, link: 'url', summary: true });
    expect(StatusConfigSchema.safeParse({ ...ok, link: '' }).success).toBe(false);
    expect(StatusConfigSchema.safeParse({ ...ok, link: 'url', href: 'url' }).success).toBe(false);
  });

  it('is a data widget with an optional sound and its own size', () => {
    const widget = { id: 's', type: 'status', datasetId: 'd', config: { entity: 'a', status: 'b' } };
    expect(WidgetSchema.safeParse(widget).success).toBe(true);
    const sound = { trigger: { kind: 'condition', expr: 'status == "fail"' } };
    expect(WidgetSchema.safeParse({ ...widget, sound }).success).toBe(true);
    expect(WidgetSchema.safeParse({ id: 's', type: 'status', config: widget.config }).success).toBe(false);
    expect(isDataWidgetType('status')).toBe(true);
    expect(SIZE_HINTS.status).toEqual({ w: 6, h: 5 });
    const doc = applyOps(emptyDashboard(), [
      {
        op: 'addDataset',
        dataset: { id: 'd', name: 'Checks', source: { kind: 'inline', rows: infraChecks() } },
      },
      { op: 'addWidget', widget },
    ]).doc;
    expect(doc.widgets[0]).toMatchObject({ type: 'status', config: { summary: true } });
    expect(doc.layout[0]).toMatchObject({ w: 6, h: 5 });
  });
});

describe('status model', () => {
  it('counts every check and orders sections by their worst level, then by their first row', () => {
    const m = infra();
    expect(m.counts).toEqual({ fail: 1, warn: 0, ok: 20, off: 5 });
    expect([m.checks, m.level, m.truncated, m.grouped]).toEqual([26, 'fail', false, true]);
    expect(statusSummary(m)).toBe('1 problem · 20 ok · 5 off');
    expect(m.sections.map((s) => s.label)).toEqual(['nas', 'nuc', 'internet']);
    expect(m.sections.map(statusSectionTitle)).toEqual([
      'nas · 1 problem · 10 ok · 2 off',
      'nuc · 5 ok · 3 off',
      'internet · 5 ok',
    ]);
  });

  it('puts problem tiles first and all-off tiles last', () => {
    expect(names(section('nas').tiles)).toEqual(['cue', 'blog', 'immich', 'nas', 'watchtower', 'umami']);
    expect(section('nas').tiles.map((t) => t.level)).toEqual(['fail', 'ok', 'ok', 'ok', 'ok', 'off']);
    expect(names(section('nuc').tiles)).toEqual(['home-assistant', 'pihole', 'nuc', 'grafana', 'old-wiki']);
    expect(names(section('internet').tiles)).toEqual(['blog.example.com', 'status', 'patchbay']);
  });

  it('lists the problem in full and summarises the rest per kind', () => {
    const cue = tile('nas', 'cue');
    expect(cue.problems).toEqual([
      {
        level: 'fail',
        value: 'fail',
        label: 'cue-backup',
        kind: 'backup',
        detail: 'FAILED: cue: Postgres container cue-backup-1 is not running, no dump',
        since: INFRA_NOW - 9 * HOUR,
      },
    ]);
    expect(cue.ok).toEqual([{ kind: 'container', count: 2 }]);
    expect(cue.off).toBe(1);
    expect(cue.checks.map((c) => c.label)).toEqual(['cue-backup', 'cue-app', 'cue-db', 'cue-backup-1']);
    expect(statusTileFoot(cue)).toBe('container ×2 · 1 off');
    expect(statusTileFoot(tile('nas', 'blog'))).toBe('container ×2 · cert');
    expect(statusTileFoot(tile('nuc', 'old-wiki'))).toBe('2 off');
    expect(statusProblemHead(cue.problems[0]!, INFRA_NOW)).toBe('fail · cue-backup · 9 hours ago');
  });

  it('takes the worst check, and off only when every check is off', () => {
    const m = statusModel(
      inferTable([
        { service: 'a', status: 'ok' },
        { service: 'a', status: 'off' },
        { service: 'b', status: 'off' },
        { service: 'b', status: 'paused' },
        { service: 'c', status: 'off' },
        { service: 'c', status: 'degraded' },
      ]),
      plain,
    );
    expect(m.grouped).toBe(false);
    expect(m.sections).toHaveLength(1);
    expect(m.sections[0]!.label).toBeNull();
    expect(m.sections[0]!.tiles.map((t) => [t.entity, t.level])).toEqual([
      ['c', 'warn'],
      ['a', 'ok'],
      ['b', 'off'],
    ]);
    // Without a kind column the ok checks are just counted.
    expect(statusTileFoot(m.sections[0]!.tiles[1]!)).toBe('1 ok · 1 off');
  });

  it('orders problems: fail before warn, the oldest first, undated after dated, then by name', () => {
    const at = (hours: number) => new Date(INFRA_NOW - hours * HOUR).toISOString();
    const rows = [
      { service: 'db', name: 'disk', status: 'warn', since: at(10) },
      { service: 'db', name: 'replica', status: 'fail', since: at(1) },
      { service: 'db', name: 'primary', status: 'fail', since: at(5) },
      { service: 'db', name: 'backup', status: 'fail', since: null },
      { service: 'db', name: 'archive', status: 'fail', since: at(1) },
    ];
    const m = statusModel(
      inferTable(rows),
      StatusConfigSchema.parse({ entity: 'service', status: 'status', label: 'name', since: 'since' }),
    );
    expect(m.sections[0]!.tiles[0]!.problems.map((p) => p.label)).toEqual([
      'primary',
      'archive',
      'replica',
      'backup',
      'disk',
    ]);
  });

  it('collects empty groups and entities under "Other", after named ones of the same level', () => {
    const rows = [
      { machine: 'zeta', service: 'a', status: 'ok' },
      { machine: null, service: 'b', status: 'ok' },
      { machine: '', service: null, status: 'ok' },
      { machine: 'alpha', service: 'c', status: 'ok' },
    ];
    const grouped = StatusConfigSchema.parse({ entity: 'service', status: 'status', group: 'machine' });
    const m = statusModel(inferTable(rows), grouped);
    expect(m.sections.map((s) => s.label)).toEqual(['zeta', 'alpha', 'Other']);
    expect(names(m.sections[2]!.tiles)).toEqual(['b', 'Other']);
    // The worst level decides first: a failing "Other" comes before calm sections.
    const failing = statusModel(
      inferTable([...rows, { machine: null, service: 'd', status: 'down' }]),
      grouped,
    );
    expect(failing.sections.map((s) => s.label)).toEqual(['Other', 'zeta', 'alpha']);
  });

  it('keeps the row order among sections and tiles of the same level, so a sort step decides it', () => {
    const grouped = StatusConfigSchema.parse({ entity: 'service', status: 'status', group: 'machine' });
    const rows = [
      { machine: 'NUC', service: 'pihole', status: 'ok' },
      { machine: 'NAS', service: 'zeta', status: 'ok' },
      { machine: null, service: 'loose', status: 'ok' },
      { machine: 'NUC', service: 'grafana', status: 'ok' },
      { machine: 'Internet', service: 'site', status: 'ok' },
      { machine: 'NAS', service: 'alpha', status: 'ok' },
      { machine: 'NAS', service: null, status: 'ok' },
      { machine: 'NAS', service: 'beta', status: 'ok' },
    ];
    const m = statusModel(inferTable(rows), grouped);
    // "Other" first appears before Internet but stays last among the calm sections, as its tile does in NAS.
    expect(m.sections.map((s) => s.label)).toEqual(['NUC', 'NAS', 'Internet', 'Other']);
    expect(names(m.sections[0]!.tiles)).toEqual(['pihole', 'grafana']);
    expect(names(m.sections[1]!.tiles)).toEqual(['zeta', 'alpha', 'beta', 'Other']);
    // The level still decides first: a failing section and tile move ahead of the row order.
    const failing = statusModel(
      inferTable([...rows, { machine: 'Internet', service: 'site', status: 'down' }]),
      grouped,
    );
    expect(failing.sections.map((s) => s.label)).toEqual(['Internet', 'NUC', 'NAS', 'Other']);
    const tiles = statusModel(
      inferTable([...rows, { machine: 'NAS', service: 'beta', status: 'warn' }]),
      grouped,
    );
    expect(names(tiles.sections[0]!.tiles)).toEqual(['beta', 'zeta', 'alpha', 'Other']);
  });

  it('reads at most 1000 rows, 40 sections and 300 tiles, and says so', () => {
    const rows = statusModel(
      inferTable(Array.from({ length: 1001 }, (_, i) => ({ service: `s${i % 10}`, status: 'ok' }))),
      plain,
    );
    expect([rows.checks, rows.counts.ok, rows.truncated]).toEqual([1000, 1000, true]);
    expect(statusSummary(rows)).toBe('1000 ok · first 1000 checks');

    const grouped = StatusConfigSchema.parse({ entity: 'service', status: 'status', group: 'machine' });
    const sections = statusModel(
      inferTable(Array.from({ length: 41 }, (_, i) => ({ machine: `m${i}`, service: 'x', status: 'ok' }))),
      grouped,
    );
    expect([sections.sections.length, sections.checks, sections.truncated]).toEqual([40, 40, true]);

    const tiles = statusModel(
      inferTable(Array.from({ length: 301 }, (_, i) => ({ service: `s${i}`, status: 'fail' }))),
      plain,
    );
    expect([tiles.sections[0]!.tiles.length, tiles.counts.fail, tiles.truncated]).toEqual([300, 300, true]);
    expect(statusSummary(tiles)).toBe('300 problems · first 300 checks');
  });

  it('names a required column the data does not have, instead of drawing every tile as a warning', () => {
    const wrong = config({ status: 'state', since: 'changed' });
    const m = statusModel(infraTable(), wrong);
    expect(m.missing).toEqual(['state', 'changed']);
    expect(statusConfigProblem(m, wrong)).toBe('Column "state" is not in the data');
    expect(statusConfigProblem(infra(), config())).toBeNull();
    const both = config({ entity: 'thing', status: 'state' });
    expect(statusConfigProblem(statusModel(infraTable(), both), both)).toBe(
      'Columns "thing" and "state" are not in the data',
    );
  });

  it('shows an empty dataset as "No checks", not as an error', () => {
    const m = statusModel({ columns: [], rows: [] }, config());
    expect(m.sections).toEqual([]);
    expect([statusSummary(m), m.level]).toEqual(['No checks', 'off']);
    expect(statusConfigProblem(m, config())).toBeNull();
  });

  it('ignores a since column that is not a time', () => {
    const allChecks = (m: ReturnType<typeof infra>) =>
      m.sections.flatMap((s) => s.tiles.flatMap((t) => t.checks));
    const text = statusModel(
      inferTable(infraChecks().map((r) => ({ ...r, since: '9 hours ago' }))),
      config(),
    );
    expect(allChecks(text).every((c) => c.since === null)).toBe(true);
    expect(statusProblemHead(text.sections[0]!.tiles[0]!.problems[0]!, INFRA_NOW)).toBe('fail · cue-backup');
    // Epoch seconds in a plain number column: not a moment this widget can trust.
    const seconds = statusModel(
      inferTable(infraChecks().map((r) => ({ ...r, since: 1_762_300_000 }))),
      config(),
    );
    expect(allChecks(seconds).every((c) => c.since === null)).toBe(true);
  });

  it('reads terminal colour codes in the text columns as plain text', () => {
    const m = statusModel(
      inferTable([
        {
          machine: '\u001b[34mnas\u001b[0m',
          service: '\u001b[1mcue\u001b[0m',
          name: '\u001b[32mcue-backup\u001b[0m',
          kind: 'backup\u001b[K',
          status: 'fail',
          detail: '\u001b[31mFAILED\u001b[0m: exit 1 \u001b]0;title\u0007done \u001b[',
        },
        { machine: 'nas', service: 'blog', name: 'blog-web', kind: 'web', status: 'ok', detail: '\u001b[0m' },
      ]),
      StatusConfigSchema.parse({
        entity: 'service',
        status: 'status',
        group: 'machine',
        label: 'name',
        kind: 'kind',
        detail: 'detail',
      }),
    );
    // The coloured and the plain "nas" are one section.
    expect(m.sections.map((s) => s.label)).toEqual(['nas']);
    const [cue, blog] = m.sections[0]!.tiles;
    expect(cue!.entity).toBe('cue');
    expect(cue!.problems[0]).toMatchObject({
      label: 'cue-backup',
      kind: 'backup',
      detail: 'FAILED: exit 1 done',
    });
    // Nothing but codes is no detail at all.
    expect(blog!.checks[0]!.detail).toBeNull();
  });

  it('reads a coloured status value by its words, and shows it without the codes', () => {
    const level = statusLevels({ running: 'ok' });
    expect(level('\u001b[32mok\u001b[0m')).toBe('ok');
    expect(level('\u001b[31mFAILED\u001b[0m')).toBe('fail');
    expect(level('\u001b[1mRunning\u001b[0m')).toBe('ok');
    const m = statusModel(
      inferTable([{ service: 'web', status: '\u001b[32mok\u001b[0m' }]),
      StatusConfigSchema.parse({ entity: 'service', status: 'status' }),
    );
    const check = m.sections[0]!.tiles[0]!.checks[0]!;
    expect(check.level).toBe('ok');
    expect(check.value).toBe('ok');
  });

  it('finds the tiles of an open panel again in new data, and drops the ones that are gone', () => {
    const keys = [tile('nas', 'cue').key, tile('nas', 'blog').key];
    expect(names(statusTilesByKey(infra(), keys))).toEqual(['cue', 'blog']);
    const next = infraChecks()
      .filter((r) => r.service !== 'cue')
      .map((r) => (r.service === 'blog' && r.name === 'blog-web' ? { ...r, status: 'down' } : r));
    const found = statusTilesByKey(statusModel(inferTable(next), config()), keys);
    expect(found.map((t) => [t.entity, t.level])).toEqual([['blog', 'fail']]);
  });
});

describe('status links', () => {
  const linked = (rows = infraLinkedChecks()) => statusModel(inferTable(rows), config({ link: 'url' }));
  const tileOf = (m: StatusModel, entity: string) =>
    m.sections.flatMap((s) => s.tiles).find((t) => t.entity === entity)!;

  it('gives a tile the web address of its entity', () => {
    const m = linked();
    expect(tileOf(m, 'cue').href).toBe('https://cue.example.com/');
    expect(tileOf(m, 'patchbay').href).toBe('https://patchbay.example.com/');
    // A service without web has no link at all, not an empty one.
    expect('href' in tileOf(m, 'immich')).toBe(false);
    expect(m.missing).toEqual([]);
  });

  it('takes the first valid address in row order, skipping nulls and unsafe values', () => {
    const rows = [
      { service: 'a', status: 'ok', url: null },
      { service: 'a', status: 'ok', url: '' },
      { service: 'a', status: 'fail', url: 'javascript:alert(1)' },
      { service: 'a', status: 'ok', url: '/relative/path' },
      { service: 'a', status: 'ok', url: 'https://a.example.com/first' },
      { service: 'a', status: 'ok', url: 'https://a.example.com/second' },
      { service: 'b', status: 'ok', url: 'javascript:alert(1)' },
      { service: 'b', status: 'ok', url: 'ftp://b.example.com' },
      { service: 'c', status: 'ok', url: 'http://c.example.com' },
    ];
    const m = statusModel(inferTable(rows), config({ group: undefined, link: 'url' }));
    expect(tileOf(m, 'a').href).toBe('https://a.example.com/first');
    expect('href' in tileOf(m, 'b')).toBe(false);
    expect(tileOf(m, 'c').href).toBe('http://c.example.com/');
  });

  it('gives no link to the tile of rows without an entity: their addresses belong to different things', () => {
    const rows = [
      { service: null, status: 'ok', url: 'https://one.example.com' },
      { service: null, status: 'ok', url: 'https://two.example.com' },
    ];
    const m = statusModel(inferTable(rows), config({ group: undefined, link: 'url' }));
    expect(m.sections[0]!.tiles.map((t) => [t.entity, t.other, 'href' in t])).toEqual([
      ['Other', true, false],
    ]);
  });

  it('draws no link without a link column, and names a configured one the data does not have', () => {
    expect(
      infra()
        .sections.flatMap((s) => s.tiles)
        .some((t) => 'href' in t),
    ).toBe(false);
    const gone = statusModel(infraTable(), config({ link: 'url' }));
    expect(gone.sections.flatMap((s) => s.tiles).some((t) => 'href' in t)).toBe(false);
    expect(gone.missing).toEqual(['url']);
    expect(statusConfigProblem(gone, config({ link: 'url' }))).toBeNull();
  });

  it('never puts a link on a fold', () => {
    const layout = statusFit(linked(), { width: 480, height: 443 });
    const folds = layout.sections.flatMap((s) => s.items).filter((p) => p.item.kind === 'more');
    expect(folds.length).toBeGreaterThan(0);
    for (const fold of folds) expect('href' in fold.item).toBe(false);
    // The folded tiles keep theirs, for the panel that lists them.
    const tiles = folds.flatMap((p) => (p.item.kind === 'more' ? p.item.tiles : []));
    expect(tiles.some((t) => t.href)).toBe(true);
  });
});

describe('status columns by name', () => {
  const cols = (...list: string[]) => list.map((name) => ({ name, type: 'string' as const }));

  it('takes a column named url, link or href as the link, never as the tile', () => {
    for (const name of ['url', 'link', 'href', 'URL']) {
      expect(statusFields(cols(name, 'thing', 'state'), 'state')).toEqual({
        entity: 'thing',
        status: 'state',
        link: name,
      });
    }
    expect(statusDefaults(inferTable(infraLinkedChecks()).columns)).toEqual({
      ...INFRA_STATUS_CONFIG,
      link: 'url',
    });
    // A number column is no address.
    expect(statusFields([...cols('service', 'state'), { name: 'url', type: 'number' }], 'state')).toEqual({
      entity: 'service',
      status: 'state',
    });
  });

  it('takes a column the caller knows holds addresses when none is named like one', () => {
    const columns = cols('service', 'home', 'state');
    expect(statusFields(columns, 'state', { link: (c) => c.name === 'home' })).toEqual({
      entity: 'service',
      status: 'state',
      link: 'home',
    });
    expect(statusFields(columns, 'state')).toEqual({ entity: 'service', status: 'state' });
  });

  it('picks the infra columns', () => {
    expect(statusFields(infraTable().columns, 'status')).toEqual(INFRA_STATUS_CONFIG);
  });

  it('makes tiles of the host when nothing names a service, and sections of it when a name does', () => {
    expect(statusFields(cols('host', 'state'), 'state')).toEqual({ entity: 'host', status: 'state' });
    expect(statusFields(cols('host', 'name', 'state'), 'state')).toEqual({
      entity: 'name',
      status: 'state',
      group: 'host',
    });
    expect(statusFields(cols('state'), 'state')).toBeNull();
  });

  it('gives the editor a starting point for any columns', () => {
    expect(statusDefaults(infraTable().columns)).toEqual(INFRA_STATUS_CONFIG);
    expect(
      statusDefaults([
        { name: 'x', type: 'number' },
        { name: 'server', type: 'string' },
        { name: 'health', type: 'string' },
      ]),
    ).toEqual({ entity: 'server', status: 'health' });
    expect(statusDefaults([])).toEqual({ entity: 'name', status: 'status' });
  });
});
