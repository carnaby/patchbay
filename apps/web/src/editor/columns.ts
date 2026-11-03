import { joinedColumns, joinKeys, type TransformInput, unionColumns } from '@patchbay/core';

/**
 * Column names available after the given steps (approximate, for autocompletion and column pickers). Plain
 * TypeScript, apart from the component file, so Node can test it.
 */
export function columnsAfter(
  base: string[],
  steps: readonly TransformInput[],
  columnsOf: (id: string) => string[] = () => [],
): string[] {
  let cols = [...base];
  for (const s of steps) {
    switch (s.type) {
      case 'derive':
        if (!cols.includes(s.as)) cols.push(s.as);
        break;
      case 'select':
        cols = [...s.fields];
        break;
      case 'drop':
        cols = cols.filter((c) => !s.fields.includes(c));
        break;
      case 'rename':
        cols = cols.map((c) => s.map[c] ?? c);
        break;
      case 'aggregate':
        cols = [
          ...(s.groupBy ?? []),
          ...s.metrics.map((m) => m.as ?? (m.field ? `${m.op}_${m.field}` : m.op)),
        ];
        break;
      case 'timeBucket':
        if (s.as && !cols.includes(s.as)) cols.push(s.as);
        break;
      case 'window': {
        const as = s.as ?? `${s.op}_${s.field}`;
        if (!cols.includes(as)) cols.push(as);
        break;
      }
      case 'join':
        cols = [...cols, ...joinedColumns(cols, columnsOf(s.with), s).map((c) => c.name)];
        break;
      case 'union':
        cols = unionColumns([cols, ...s.with.map(columnsOf)], s.origin || undefined);
        break;
    }
  }
  return cols;
}

type JoinStep = Extract<TransformInput, { type: 'join' }>;

const compact = (keys: { left: string; right: string }[]): JoinStep['on'] =>
  keys.map((k) => (k.left === k.right ? k.left : k));

/** Another dataset to look up: its columns are unrelated to the old one's, so the list and right-hand keys go. */
export function switchJoinDataset(step: JoinStep, id: string): JoinStep {
  const { fields: _fields, ...rest } = step;
  return { ...rest, with: id, on: compact(joinKeys(step.on).map((k) => ({ left: k.left, right: k.left }))) };
}

/**
 * Once the other dataset's columns are known, fix keys that cannot match: prefer a column both sides have, else keep
 * the left one and take the other side's first column. Keys valid on both sides are the user's and stay. Returns the
 * same object when nothing changes, so an effect calling it cannot loop.
 */
export function repickJoinKeys(step: JoinStep, left: string[], theirs: string[]): JoinStep {
  if (theirs.length === 0) return step;
  let changed = false;
  const keys = joinKeys(step.on).map((k) => {
    if ((left.length === 0 || left.includes(k.left)) && theirs.includes(k.right)) return k;
    changed = true;
    const shared =
      left.includes(k.left) && theirs.includes(k.left) ? k.left : left.find((c) => theirs.includes(c));
    if (shared !== undefined) return { left: shared, right: shared };
    return { left: k.left, right: theirs[0] as string };
  });
  return changed ? { ...step, on: compact(keys) } : step;
}
