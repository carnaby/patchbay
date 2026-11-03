import { joinedColumns, type TransformInput, unionColumns } from '@patchbay/core';

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
