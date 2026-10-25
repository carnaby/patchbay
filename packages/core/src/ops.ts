/**
 * Granular, semantic edit operations.
 *
 * Agents never rewrite the whole document: they send a small batch of ops
 * (`addWidget`, `updateDataset`, ...) that is applied atomically and validated
 * as a whole. Ops address things by id, which makes them easy for a model to
 * produce, easy to review in a diff, and safe to rebase onto a newer version.
 */
import { z } from 'zod';
import { normalizeLayout, placeItem } from './layout.ts';
import {
  type DashboardDoc,
  DashboardDocSchema,
  DatasetSchema,
  DocumentError,
  formatZodIssues,
  IdSchema,
  integrityIssues,
  LayoutItemSchema,
  SourceSchema,
  type Widget,
  WidgetSchema,
} from './schema.ts';
import { TransformSchema } from './transforms.ts';

const position = z
  .strictObject({
    x: z.number().int().min(0).optional(),
    y: z.number().int().min(0).optional(),
    w: z.number().int().min(1).max(12).optional(),
    h: z.number().int().min(1).max(40).optional(),
  })
  .describe('Optional grid placement on a 12-column grid; omit to auto-place');

export const OpSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('setMeta'),
    title: z.string().min(1).max(120).optional(),
    description: z.string().max(1000).optional(),
  }),
  z.strictObject({ op: z.literal('addDataset'), dataset: DatasetSchema }),
  z.strictObject({
    op: z.literal('updateDataset'),
    id: IdSchema,
    set: z.strictObject({
      name: z.string().min(1).max(120).optional(),
      source: SourceSchema.optional(),
      transforms: z.array(TransformSchema).optional(),
      refreshSec: z.number().int().min(0).max(86_400).optional(),
      accumulate: z.number().int().min(0).max(5000).optional(),
    }),
  }),
  z.strictObject({
    op: z.literal('removeDataset'),
    id: IdSchema,
    cascade: z.boolean().default(false).describe('Also remove widgets that use this dataset'),
  }),
  z.strictObject({ op: z.literal('addWidget'), widget: WidgetSchema, position: position.optional() }),
  z.strictObject({
    op: z.literal('updateWidget'),
    id: IdSchema,
    set: z.strictObject({
      title: z.string().max(120).optional(),
      description: z.string().max(500).optional(),
      datasetId: IdSchema.optional(),
      config: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Shallow-merged into the existing config'),
    }),
  }),
  z
    .strictObject({ op: z.literal('replaceWidget'), widget: WidgetSchema })
    .describe('Replace a widget (e.g. change its type) while keeping its place in the layout'),
  z.strictObject({ op: z.literal('removeWidget'), id: IdSchema }),
  z.strictObject({ op: z.literal('moveWidget'), id: IdSchema, ...position.shape }),
  z.strictObject({ op: z.literal('setLayout'), layout: z.array(LayoutItemSchema) }),
]);
export type Op = z.infer<typeof OpSchema>;
export type OpInput = z.input<typeof OpSchema>;

export class OpError extends Error {
  readonly index: number;
  constructor(message: string, index: number) {
    super(`Operation ${index + 1}: ${message}`);
    this.name = 'OpError';
    this.index = index;
  }
}

export interface ApplyResult {
  doc: DashboardDoc;
  /** Human-readable change log, shown in version history and returned to agents. */
  changes: string[];
}

function applyOne(doc: DashboardDoc, op: Op, index: number, changes: string[]): DashboardDoc {
  const fail = (msg: string): never => {
    throw new OpError(msg, index);
  };
  const widget = (id: string) => doc.widgets.find((w) => w.id === id) ?? fail(`Unknown widget "${id}"`);
  const dataset = (id: string) => doc.datasets.find((d) => d.id === id) ?? fail(`Unknown dataset "${id}"`);

  switch (op.op) {
    case 'setMeta':
      changes.push('Updated title/description');
      return {
        ...doc,
        title: op.title ?? doc.title,
        description: op.description ?? doc.description,
      };
    case 'addDataset':
      if (doc.datasets.some((d) => d.id === op.dataset.id)) fail(`Dataset "${op.dataset.id}" already exists`);
      changes.push(`Added dataset "${op.dataset.name}"`);
      return { ...doc, datasets: [...doc.datasets, op.dataset] };
    case 'updateDataset': {
      const current = dataset(op.id);
      const next = DatasetSchema.safeParse({ ...current, ...op.set });
      if (!next.success) fail(formatZodIssues(next.error).join('; '));
      changes.push(`Updated dataset "${current.name}" (${Object.keys(op.set).join(', ')})`);
      return { ...doc, datasets: doc.datasets.map((d) => (d.id === op.id ? next.data! : d)) };
    }
    case 'removeDataset': {
      const current = dataset(op.id);
      const users = doc.widgets.filter((w) => 'datasetId' in w && w.datasetId === op.id);
      if (users.length && !op.cascade) {
        fail(
          `Dataset "${op.id}" is used by ${users.map((w) => `"${w.id}"`).join(', ')}; pass cascade: true to remove them too`,
        );
      }
      const gone = new Set(users.map((w) => w.id));
      changes.push(`Removed dataset "${current.name}"${gone.size ? ` and ${gone.size} widget(s)` : ''}`);
      return {
        ...doc,
        datasets: doc.datasets.filter((d) => d.id !== op.id),
        widgets: doc.widgets.filter((w) => !gone.has(w.id)),
        layout: doc.layout.filter((l) => !gone.has(l.i)),
      };
    }
    case 'addWidget': {
      if (doc.widgets.some((w) => w.id === op.widget.id)) fail(`Widget "${op.widget.id}" already exists`);
      const item = placeItem(doc.layout, op.widget.id, op.widget.type, op.position);
      changes.push(`Added ${op.widget.type} widget "${op.widget.title ?? op.widget.id}"`);
      return { ...doc, widgets: [...doc.widgets, op.widget], layout: [...doc.layout, item] };
    }
    case 'updateWidget': {
      const current = widget(op.id);
      const { config, ...rest } = op.set;
      const merged = {
        ...current,
        ...rest,
        ...(config ? { config: { ...current.config, ...config } } : {}),
      };
      const next = WidgetSchema.safeParse(merged);
      if (!next.success) fail(formatZodIssues(next.error).join('; '));
      changes.push(`Updated widget "${current.title ?? current.id}" (${Object.keys(op.set).join(', ')})`);
      return { ...doc, widgets: doc.widgets.map((w) => (w.id === op.id ? (next.data as Widget) : w)) };
    }
    case 'replaceWidget': {
      widget(op.widget.id);
      changes.push(`Replaced widget "${op.widget.title ?? op.widget.id}" with a ${op.widget.type}`);
      return { ...doc, widgets: doc.widgets.map((w) => (w.id === op.widget.id ? op.widget : w)) };
    }
    case 'removeWidget': {
      const current = widget(op.id);
      changes.push(`Removed widget "${current.title ?? current.id}"`);
      return {
        ...doc,
        widgets: doc.widgets.filter((w) => w.id !== op.id),
        layout: doc.layout.filter((l) => l.i !== op.id),
      };
    }
    case 'moveWidget': {
      const current = widget(op.id);
      const others = doc.layout.filter((l) => l.i !== op.id);
      const existing = doc.layout.find((l) => l.i === op.id);
      const item = placeItem(others, op.id, current.type, {
        x: op.x ?? existing?.x,
        y: op.y ?? existing?.y,
        w: op.w ?? existing?.w,
        h: op.h ?? existing?.h,
      });
      changes.push(`Moved widget "${current.title ?? current.id}"`);
      return { ...doc, layout: [...others, item] };
    }
    case 'setLayout':
      changes.push('Rearranged layout');
      return { ...doc, layout: op.layout };
  }
}

/**
 * Applies a batch atomically: either every op succeeds and the result is a
 * valid document, or nothing changes and an error explains what went wrong.
 */
export function applyOps(doc: DashboardDoc, rawOps: unknown[]): ApplyResult {
  const ops = rawOps.map((raw, i) => {
    const parsed = OpSchema.safeParse(raw);
    if (!parsed.success) throw new OpError(formatZodIssues(parsed.error).join('; '), i);
    return parsed.data;
  });
  const changes: string[] = [];
  let next = doc;
  ops.forEach((op, i) => {
    next = applyOne(next, op, i, changes);
  });
  next = { ...next, layout: normalizeLayout(next.layout, next.widgets) };
  const parsed = DashboardDocSchema.safeParse(next);
  if (!parsed.success) throw new DocumentError(formatZodIssues(parsed.error));
  const issues = integrityIssues(parsed.data);
  if (issues.length) throw new DocumentError(issues);
  return { doc: parsed.data, changes };
}
