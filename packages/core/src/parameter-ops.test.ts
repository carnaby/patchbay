import { describe, expect, it } from 'vitest';
import { applyOps, emptyDashboard, parseDashboard } from './index.ts';

const region = {
  id: 'region',
  label: 'Region',
  type: 'select' as const,
  options: [
    { value: 'eu', label: 'EU' },
    { value: 'us', label: 'US' },
  ],
  all: 'All regions',
  default: null,
};
const q = { id: 'q', label: 'Search', type: 'text' as const };
const period = {
  id: 'period',
  label: 'Period',
  type: 'dateRange' as const,
  presets: ['last7d' as const, 'last30d' as const],
  default: 'last7d' as const,
};
const base = applyOps(emptyDashboard('t'), [
  {
    op: 'addDataset',
    dataset: { id: 'sales', name: 'Sales', source: { kind: 'inline', rows: [{ region: 'eu' }] } },
  },
]).doc;
const used = applyOps(base, [
  { op: 'addParameter', parameter: region },
  {
    op: 'addStep',
    datasetId: 'sales',
    step: { id: 'f', type: 'filter', expr: '$param.region == null || region == $param.region' },
  },
]).doc;
const ids = (doc: { parameters?: { id: string }[] }) => doc.parameters?.map((p) => p.id);

describe('filter operations', () => {
  it('adds filters at the end or before another, and logs them by label', () => {
    const r = applyOps(base, [
      { op: 'addParameter', parameter: period },
      { op: 'addParameter', parameter: region, before: 'period' },
    ]);
    expect(ids(r.doc)).toEqual(['region', 'period']);
    expect(r.changes).toEqual(['Added filter "Period"', 'Added filter "Region"']);
    expect(() => applyOps(r.doc, [{ op: 'addParameter', parameter: region }])).toThrow(
      'Operation 1: Filter "region" already exists',
    );
    expect(() => applyOps(base, [{ op: 'addParameter', parameter: region, before: 'nope' }])).toThrow(
      'Operation 1: There is no filter "nope" to insert before',
    );
  });

  it('updates by merging, validates the result, and never changes id or type', () => {
    const doc = applyOps(base, [{ op: 'addParameter', parameter: region }]).doc;
    const r = applyOps(doc, [
      {
        op: 'updateParameter',
        id: 'region',
        set: { options: [...region.options, { value: 'apac', label: 'APAC' }], default: 'apac' },
      },
    ]);
    expect(r.doc.parameters![0]).toMatchObject({ default: 'apac', all: 'All regions' });
    expect(r.changes).toEqual(['Updated filter "Region" (options, default)']);
    // null removes an optional field, except default, where null is "All".
    expect(
      applyOps(doc, [{ op: 'updateParameter', id: 'region', set: { all: null, default: 'eu' } }]).doc
        .parameters![0],
    ).not.toHaveProperty('all');
    expect(
      applyOps(doc, [
        { op: 'updateParameter', id: 'region', set: { default: 'eu' } },
        { op: 'updateParameter', id: 'region', set: { default: null } },
      ]).doc.parameters![0]!.default,
    ).toBeNull();
    for (const set of [{ id: 'area' }, { type: 'text' }])
      expect(() => applyOps(doc, [{ op: 'updateParameter', id: 'region', set }])).toThrow(
        /cannot change; add a new filter/,
      );
    expect(() => applyOps(doc, [{ op: 'updateParameter', id: 'region', set: { default: 'xx' } }])).toThrow(
      'Filter "region": the default "xx" is not one of its options',
    );
    expect(() => applyOps(doc, [{ op: 'updateParameter', id: 'region', set: { colour: 'red' } }])).toThrow(
      /Unrecognized key/,
    );
    expect(() => applyOps(doc, [{ op: 'updateParameter', id: 'nope', set: {} }])).toThrow(
      'Operation 1: Unknown filter "nope"',
    );
    expect(() => applyOps(doc, [{ op: 'updateParameter', id: 'region', set: {} }])).toThrow(
      /Operation 1: set is empty/,
    );
  });

  it('removes a filter only once nothing uses it, and the last one leaves no field', () => {
    expect(() => applyOps(used, [{ op: 'removeParameter', id: 'region' }])).toThrow(
      'Operation 1: Filter "region" is used by "Sales" (filter step); remove those references first (earlier in the same batch)',
    );
    const r = applyOps(used, [
      { op: 'removeStep', datasetId: 'sales', stepId: 'f' },
      { op: 'removeParameter', id: 'region' },
    ]);
    expect(r.doc).not.toHaveProperty('parameters');
    expect(r.changes).toContain('Removed filter "Region"');
    const text = JSON.stringify(r.doc);
    expect(JSON.stringify(parseDashboard(JSON.parse(text)))).toBe(text);
  });

  it('refuses $param. inside an option in addParameter and in a new option of updateParameter', () => {
    const bad = { ...region, options: [{ value: 'US$param.x' }], default: null };
    expect(() => applyOps(base, [{ op: 'addParameter', parameter: bad }])).toThrow(
      /cannot contain "\$param\." \("US\$param\.x"\)/,
    );
    // A document stored before the rule: parseDashboard accepts the option.
    const stored = parseDashboard(JSON.parse(JSON.stringify({ ...base, parameters: [bad] })));
    expect(
      ids(applyOps(stored, [{ op: 'updateParameter', id: 'region', set: { label: 'Area' } }]).doc),
    ).toEqual(['region']);
    expect(() =>
      applyOps(stored, [
        {
          op: 'updateParameter',
          id: 'region',
          set: { options: [...bad.options, { value: 'EU$param.y' }] },
        },
      ]),
    ).toThrow(/cannot contain "\$param\."/);
  });

  it('renames by adding, re-pointing and removing in one batch', () => {
    const r = applyOps(used, [
      { op: 'addParameter', parameter: { ...region, id: 'area', label: 'Area' } },
      {
        op: 'updateStep',
        datasetId: 'sales',
        stepId: 'f',
        set: { expr: '$param.area == null || region == $param.area' },
      },
      { op: 'removeParameter', id: 'region' },
    ]);
    expect(ids(r.doc)).toEqual(['area']);
  });

  it('moves filters before another or to the end', () => {
    const doc = applyOps(base, [
      { op: 'addParameter', parameter: region },
      { op: 'addParameter', parameter: q },
      { op: 'addParameter', parameter: period },
    ]).doc;
    expect(ids(applyOps(doc, [{ op: 'moveParameter', id: 'period', before: 'region' }]).doc)).toEqual([
      'period',
      'region',
      'q',
    ]);
    const last = applyOps(doc, [{ op: 'moveParameter', id: 'region', before: null }]);
    expect(ids(last.doc)).toEqual(['q', 'period', 'region']);
    expect(last.changes).toEqual(['Moved filter "Region"']);
    expect(() => applyOps(doc, [{ op: 'moveParameter', id: 'region', before: 'region' }])).toThrow(
      'A filter cannot be placed before itself',
    );
  });

  it('refuses to remove a filter a widget sets with a click', () => {
    const doc = applyOps(base, [
      { op: 'addParameter', parameter: region },
      {
        op: 'addWidget',
        widget: {
          id: 'bars',
          type: 'chart',
          title: 'By region',
          datasetId: 'sales',
          config: {
            kind: 'bar',
            x: 'region',
            y: ['n'],
            crossFilter: { parameter: 'region', field: 'region' },
          },
        },
      },
    ]).doc;
    expect(() => applyOps(doc, [{ op: 'removeParameter', id: 'region' }])).toThrow(
      'Operation 1: Filter "region" is used by "By region" (click); remove those references first (earlier in the same batch)',
    );
  });
});
