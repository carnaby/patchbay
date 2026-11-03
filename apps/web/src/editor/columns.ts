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
 * Once the other dataset's columns are known, fix keys whose right side cannot match: prefer a column both sides
 * have, else keep the left one and take the other side's first column. A key whose right side exists is the user's and
 * stays, and an unknown left column is never touched (the select already shows it as missing). Every branch leaves the
 * right side valid, so a second call returns the same object and an effect calling it cannot loop.
 */
export function repickJoinKeys(step: JoinStep, left: string[], theirs: string[]): JoinStep {
  if (theirs.length === 0) return step;
  let changed = false;
  const keys = joinKeys(step.on).map((k) => {
    if (theirs.includes(k.right)) return k;
    changed = true;
    if (left.includes(k.left)) {
      const shared = theirs.includes(k.left) ? k.left : left.find((c) => theirs.includes(c));
      if (shared !== undefined) return { left: shared, right: shared };
    }
    return { left: k.left, right: theirs.includes(k.left) ? k.left : (theirs[0] as string) };
  });
  return changed ? { ...step, on: compact(keys) } : step;
}
