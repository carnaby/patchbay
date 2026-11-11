import { DatasetSchema, type Suggestion } from '@patchbay/core';
import { describe, expect, it } from 'vitest';
import { suggestionOps } from './server.ts';

const dataset = DatasetSchema.parse({
  id: 'quarterly-revenue-by-sales-region-export',
  name: 'Revenue',
  source: { kind: 'inline', rows: [{ region: 'eu', revenue: 1 }] },
});

const suggestion = (title: string): Suggestion => ({
  title,
  rationale: 'r',
  score: 1,
  transforms: [{ type: 'limit', n: 5 }] as Suggestion['transforms'],
  widget: { type: 'bar', title, x: 'region', y: ['revenue'] } as unknown as Suggestion['widget'],
});

const idsOf = (ops: unknown[]) =>
  (ops as { op: string; dataset?: { id: string }; widget?: { id: string } }[]).map(
    (o) => (o.dataset ?? o.widget)!.id,
  );

describe('suggestionOps', () => {
  it('keeps the dataset ids of two similar long titles apart, within 40 characters', () => {
    expect(dataset.id).toHaveLength(40);
    const out = suggestionOps(
      { datasets: [dataset] },
      dataset,
      [
        suggestion('Revenue by region over the last quarter, bars'),
        suggestion('Revenue by region over the last quarter, lines'),
      ],
      'derive',
    );
    const datasetIds = out.map((s) => idsOf(s.ops)[0]!);
    expect(new Set(datasetIds).size).toBe(2);
    for (const id of datasetIds) expect(id.length).toBeLessThanOrEqual(40);
    const widgetIds = out.map((s) => idsOf(s.ops)[1]!);
    expect(new Set(widgetIds).size).toBe(2);
  });

  it('skips an id the document already has', () => {
    const [first] = suggestionOps({ datasets: [dataset] }, dataset, [suggestion('Taken')], 'copy');
    const taken = idsOf(first!.ops)[1]!;
    // The counter is module state: occupy all but one of its 1000 values so the next suggestion must dodge them.
    const widgets = Array.from({ length: 999 }, (_, i) => ({ id: `taken-${i.toString(36)}` }));
    const out = suggestionOps({ datasets: [dataset], widgets }, dataset, [suggestion('Taken')], 'copy');
    expect(idsOf(out[0]!.ops)[1]).not.toBe(taken);
    expect(widgets.map((w) => w.id)).not.toContain(idsOf(out[0]!.ops)[1]);
  });
});
