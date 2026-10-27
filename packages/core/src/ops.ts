/**
 * Granular, semantic edit operations.
 *
 * Agents never rewrite the whole document: they send a small batch of ops
 * (`addWidget`, `updateDataset`, ...) that is applied atomically and validated
 * as a whole. Ops address things by id, which makes them easy for a model to
 * produce, easy to review in a diff, and safe to rebase onto a newer version.
 */
import { z } from 'zod';
import { normalizeLayout, placeItem, reorderLayout } from './layout.ts';
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
import { SoundRuleSchema } from './sound.ts';
import { StepIdSchema, type Transform, TransformSchema, withStepIds } from './transforms.ts';

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
  z
    .strictObject({
      op: z.literal('addStep'),
      datasetId: IdSchema,
      step: TransformSchema,
      before: StepIdSchema.optional().describe('Insert before this step; omit to append'),
    })
    .describe('Add one processing step to a dataset'),
  z
    .strictObject({
      op: z.literal('updateStep'),
      datasetId: IdSchema,
      stepId: StepIdSchema,
      set: z.record(z.string(), z.unknown()).describe('Fields merged into the step (its type cannot change)'),
    })
    .describe('Change one processing step, addressed by its id'),
  z.strictObject({ op: z.literal('removeStep'), datasetId: IdSchema, stepId: StepIdSchema }),
  z
    .strictObject({
      op: z.literal('moveStep'),
      datasetId: IdSchema,
      stepId: StepIdSchema,
      before: StepIdSchema.nullable().describe('Move before this step; null = to the end'),
    })
    .describe('Reorder a processing step'),
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
      sound: SoundRuleSchema.nullable().optional().describe('Replaces the sound cue; null removes it'),
    }),
  }),
  z
    .strictObject({ op: z.literal('replaceWidget'), widget: WidgetSchema })
    .describe('Replace a widget (e.g. change its type) while keeping its place in the layout'),
  z.strictObject({ op: z.literal('removeWidget'), id: IdSchema }),
  z.strictObject({ op: z.literal('moveWidget'), id: IdSchema, ...position.shape }),
  z.strictObject({ op: z.literal('setLayout'), layout: z.array(LayoutItemSchema) }),
  z
    .strictObject({
      op: z.literal('reorderWidget'),
      id: IdSchema,
      before: IdSchema.nullable().describe('null = last'),
    })
    .describe('Move a widget in reading order (how phones stack widgets); sizes are kept'),
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
    case 'addStep':
    case 'updateStep':
    case 'removeStep':
    case 'moveStep': {
      const current = dataset(op.datasetId);
      const steps = withStepIds(current.transforms);
      const indexOf = (id: string) => {
        const i = steps.findIndex((st) => st.id === id);
        if (i < 0)
          fail(
            `Dataset "${current.id}" has no step "${id}". Steps: ${steps.map((st) => st.id).join(', ') || 'none'}`,
          );
        return i;
      };
      let next: Transform[] = [...steps];
      if (op.op === 'addStep') {
        if (op.step.id && steps.some((st) => st.id === op.step.id))
          fail(`Step "${op.step.id}" already exists`);
        const at = op.before ? indexOf(op.before) : next.length;
        next.splice(at, 0, op.step);
        changes.push(`Added a ${op.step.type} step to "${current.name}"`);
      } else if (op.op === 'updateStep') {
        const i = indexOf(op.stepId);
        const merged = TransformSchema.safeParse({
          ...next[i],
          ...op.set,
          id: op.stepId,
          type: next[i]!.type,
        });
        if (!merged.success) fail(formatZodIssues(merged.error).join('; '));
        next[i] = merged.data as Transform;
        changes.push(`Updated the ${next[i]!.type} step of "${current.name}"`);
      } else if (op.op === 'removeStep') {
        const i = indexOf(op.stepId);
        changes.push(`Removed the ${next[i]!.type} step from "${current.name}"`);
        next.splice(i, 1);
      } else {
        const [moved] = next.splice(indexOf(op.stepId), 1);
        const at =
          op.before === null
            ? next.length
            : (() => {
                const i = next.findIndex((st) => st.id === op.before);
                if (i < 0) fail(`Dataset "${current.id}" has no step "${op.before}"`);
                return i;
              })();
        next.splice(at, 0, moved!);
        changes.push(`Reordered steps of "${current.name}"`);
      }
      next = withStepIds(next);
      const parsed = DatasetSchema.safeParse({ ...current, transforms: next });
      if (!parsed.success) fail(formatZodIssues(parsed.error).join('; '));
      return { ...doc, datasets: doc.datasets.map((d) => (d.id === current.id ? parsed.data! : d)) };
    }
    case 'addWidget': {
      if (doc.widgets.some((w) => w.id === op.widget.id)) fail(`Widget "${op.widget.id}" already exists`);
      const item = placeItem(doc.layout, op.widget.id, op.widget.type, op.position);
      changes.push(`Added ${op.widget.type} widget "${op.widget.title ?? op.widget.id}"`);
      return { ...doc, widgets: [...doc.widgets, op.widget], layout: [...doc.layout, item] };
    }
    case 'updateWidget': {
      const current = widget(op.id);
      const { config, sound, ...rest } = op.set;
      const merged: Record<string, unknown> = {
        ...current,
        ...rest,
        ...(config ? { config: { ...current.config, ...config } } : {}),
        ...(sound ? { sound } : {}),
      };
      if (sound === null) delete merged.sound;
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
    case 'reorderWidget': {
      const current = widget(op.id);
      const target = op.before === null ? null : widget(op.before);
      if (target?.id === op.id) fail('A widget cannot be placed before itself');
      changes.push(
        target
          ? `Moved widget "${current.title ?? current.id}" before "${target.title ?? target.id}"`
          : `Moved widget "${current.title ?? current.id}" to the end`,
      );
      // Normalise first: a reorder replayed onto someone else's newer layout must work on a consistent grid.
      return { ...doc, layout: reorderLayout(normalizeLayout(doc.layout, doc.widgets), op.id, op.before) };
    }
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

type StepLike = { id?: string | undefined; type: string };

/**
 * Expresses the change from one pipeline to another as step operations, so a
 * locally edited pipeline can be replayed onto a newer version without
 * clobbering steps somebody else changed in the meantime.
 * Steps without an id in `after` are treated as new.
 */
export function diffSteps(datasetId: string, before: StepLike[], afterInput: StepLike[]): OpInput[] {
  // New steps get an id up front so later steps can be positioned relative to them.
  const taken = new Set([...before, ...afterInput].map((s) => s.id).filter(Boolean));
  const after = afterInput.map((s) => {
    if (s.id) return s;
    let id: string;
    do id = `n${Math.random().toString(36).slice(2, 8)}`;
    while (taken.has(id));
    taken.add(id);
    return { ...s, id };
  });
  const removals: OpInput[] = [];
  const updates: OpInput[] = [];
  const placement: OpInput[] = [];
  const old = new Map(before.filter((s) => s.id).map((s) => [s.id!, s]));
  const kept = new Set<string>();
  for (const s of after) {
    const prev = s.id ? old.get(s.id) : undefined;
    if (prev && prev.type === s.type) kept.add(s.id!);
  }
  for (const s of before)
    if (s.id && !kept.has(s.id)) removals.push({ op: 'removeStep', datasetId, stepId: s.id });

  // Simulated order of the surviving steps; fixed up from the end so that the
  // step after the current one is always already in its final place.
  const order = before.filter((s) => s.id && kept.has(s.id)).map((s) => s.id!);
  for (let i = after.length - 1; i >= 0; i--) {
    const step = after[i]!;
    const target = after[i + 1]?.id ?? null;
    const at = () => (target === null ? order.length : order.indexOf(target));
    if (!kept.has(step.id!)) {
      placement.push({
        op: 'addStep',
        datasetId,
        step: step as never,
        ...(target ? { before: target } : {}),
      });
      order.splice(at(), 0, step.id!);
      continue;
    }
    const id = step.id!;
    const prev = old.get(id)!;
    if (JSON.stringify(prev) !== JSON.stringify(step)) {
      const set: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(step)) if (k !== 'id' && k !== 'type') set[k] = v;
      // Fields that disappeared must be cleared explicitly, since updates merge.
      for (const k of Object.keys(prev)) if (!(k in set) && k !== 'id' && k !== 'type') set[k] = undefined;
      updates.push({ op: 'updateStep', datasetId, stepId: id, set });
    }
    const pos = order.indexOf(id);
    if ((order[pos + 1] ?? null) !== target) {
      placement.push({ op: 'moveStep', datasetId, stepId: id, before: target });
      order.splice(pos, 1);
      order.splice(at(), 0, id);
    }
  }
  return [...removals, ...updates, ...placement];
}
