import { describe, expect, it } from 'vitest';
import {
  dependentsOf,
  effectiveRefreshSec,
  hasLineage,
  lineageCycles,
  lineageDepth,
  lineageIssues,
  lineageKey,
  lineageSecretIds,
  readersOf,
  upstreamClosure,
  upstreamOf,
} from './lineage.ts';
import { type DashboardDoc, DashboardDocSchema, DocumentError, parseDashboard } from './schema.ts';

const ds = (id: string, source: unknown, extra: Record<string, unknown> = {}) => ({
  id,
  name: id.toUpperCase(),
  source,
  ...extra,
});
const root = (id: string, extra: Record<string, unknown> = {}) =>
  ds(id, { kind: 'inline', rows: [{ a: 1 }] }, extra);
const from = (id: string, parent: string, extra: Record<string, unknown> = {}) =>
  ds(id, { kind: 'dataset', id: parent }, extra);
// Parsed without integrityIssues, so broken graphs can be inspected.
const doc = (...datasets: unknown[]): DashboardDoc =>
  DashboardDocSchema.parse({ schemaVersion: 1, title: 't', datasets });

describe('the dataset graph', () => {
  it('lists each cycle once as a closed path, without self references', () => {
    const d = doc(
      from('a', 'b'),
      from('b', 'a'),
      from('c', 'b'),
      root('s', { transforms: [{ type: 'union', with: ['s'] }] }),
    );
    expect(lineageCycles(d)).toEqual([['a', 'b', 'a']]);
    expect(lineageCycles(doc(root('a'), from('b', 'a')))).toEqual([]);
  });

  it('lists what a dataset reads: its source, then join and union datasets, once', () => {
    const d = doc(
      root('a'),
      root('b'),
      root('c'),
      from('x', 'a', {
        transforms: [
          { type: 'join', with: 'b', on: ['a'] },
          { type: 'union', with: ['c', 'b'] },
        ],
      }),
    );
    expect(upstreamOf(d.datasets[3]!)).toEqual(['a', 'b', 'c']);
    expect(readersOf(d, 'b')).toEqual(['x']);
    expect(hasLineage(d, 'a')).toBe(true);
    expect(hasLineage(doc(root('lonely')), 'lonely')).toBe(false);
  });

  it('orders dependents parents first and closures nearest first', () => {
    const d = doc(from('grandchild', 'child'), from('child', 'w'), root('w'), from('other', 'w'));
    // Parents before children; siblings in the order they become ready.
    expect(dependentsOf(d, 'w')).toEqual(['other', 'child', 'grandchild']);
    expect(upstreamClosure(d, 'grandchild')).toEqual(['child', 'w']);
    expect(lineageDepth(d, 'grandchild')).toBe(2);
  });

  it('changes the lineage key when an ancestor changes, and only then', () => {
    const d = doc(root('w'), from('c', 'w'), root('unrelated'));
    const key = lineageKey(d, 'c');
    const parentEdited = {
      ...d,
      datasets: d.datasets.map((x) => (x.id === 'w' ? { ...x, name: 'New' } : x)),
    };
    const unrelatedEdited = {
      ...d,
      datasets: d.datasets.map((x) => (x.id === 'unrelated' ? { ...x, name: 'New' } : x)),
    };
    expect(lineageKey(parentEdited, 'c')).not.toBe(key);
    expect(lineageKey(unrelatedEdited, 'c')).toBe(key);
  });

  it('takes the shortest live interval of the lineage and every secret in it', () => {
    const secret = 'sec_AAAAAAAAAAAAAAAA';
    const d = doc(
      ds('orders', { kind: 'http', url: 'https://api.example.com/o', secrets: [secret] }, { refreshSec: 60 }),
      root('fast', { refreshSec: 0 }),
      from('view', 'orders', { transforms: [{ type: 'union', with: ['fast'] }] }),
    );
    expect(effectiveRefreshSec(d, 'view')).toBe(60);
    expect(effectiveRefreshSec(d, 'fast')).toBe(0);
    expect(lineageSecretIds(d, 'view')).toEqual([secret]);
    expect(lineageSecretIds(d, 'fast')).toEqual([]);
  });
});

describe('lineageIssues', () => {
  it('names unknown and self references', () => {
    expect(lineageIssues(doc(from('temps', 'brno')))).toEqual([
      'Dataset "temps" reads unknown dataset "brno"',
    ]);
    expect(lineageIssues(doc(root('temps', { transforms: [{ type: 'union', with: ['temps'] }] })))).toEqual([
      'Dataset "temps" reads itself',
    ]);
  });

  it('finds cycles through sources and through join or union steps', () => {
    expect(lineageIssues(doc(from('a', 'b'), from('b', 'a')))).toEqual([
      'Datasets "a" → "b" → "a" form a cycle',
    ]);
    expect(
      lineageIssues(
        doc(
          from('a', 'b'),
          from('b', 'c'),
          root('c', { transforms: [{ type: 'join', with: 'a', on: ['x'] }] }),
        ),
      ),
    ).toEqual(['Datasets "a" → "b" → "c" → "a" form a cycle']);
  });

  it('limits depth to 4 and inputs to 8', () => {
    const chain = doc(
      root('d0'),
      from('d1', 'd0'),
      from('d2', 'd1'),
      from('d3', 'd2'),
      from('d4', 'd3'),
      from('d5', 'd4'),
    );
    expect(lineageIssues(chain)).toEqual([
      'Dataset "d5" is 5 levels deep; chains of derived datasets are limited to 4',
    ]);
    const roots = Array.from({ length: 9 }, (_, i) => root(`r${i + 1}`));
    const wide = doc(
      ...roots,
      root('a', { transforms: [{ type: 'union', with: ['r1', 'r2', 'r3', 'r4'] }] }),
      root('b', { transforms: [{ type: 'union', with: ['r5', 'r6', 'r7', 'r8'] }] }),
      from('c', 'a', {
        transforms: [
          { type: 'union', with: ['b'] },
          { type: 'join', with: 'r9', on: ['a'] },
        ],
      }),
    );
    expect(lineageIssues(wide)).toEqual([
      'Dataset "c" reads 11 other datasets, directly or through others; the limit is 8',
    ]);
  });

  it('refuses refreshSec and accumulate on derived datasets', () => {
    expect(
      lineageIssues(doc(root('weather'), from('temps', 'weather', { refreshSec: 30, accumulate: 10 }))),
    ).toEqual([
      'Dataset "temps" takes its rows from "weather" and refreshes when it does; remove refreshSec.',
      'Dataset "temps" takes its rows from "weather" and keeps no history of its own; set accumulate on "weather" instead.',
    ]);
    // A dataset with its own source and a join keeps its own interval.
    expect(
      lineageIssues(
        doc(root('w'), root('j', { refreshSec: 30, transforms: [{ type: 'join', with: 'w', on: ['a'] }] })),
      ),
    ).toEqual([]);
  });

  it('runs on every parse', () => {
    expect(() => parseDashboard({ schemaVersion: 1, title: 't', datasets: [from('temps', 'brno')] })).toThrow(
      DocumentError,
    );
  });
});
