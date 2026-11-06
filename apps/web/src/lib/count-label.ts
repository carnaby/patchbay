/** "1 row", "12,500 rows": a count with its noun, so a one-row file is not announced as "1 rows". */
export const countLabel = (n: number, word: string) =>
  `${n.toLocaleString('en')} ${word}${n === 1 ? '' : 's'}`;
