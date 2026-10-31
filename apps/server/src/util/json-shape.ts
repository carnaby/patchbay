/**
 * A linear look at a JSON text before `JSON.parse` sees it.
 *
 * V8 parses nesting with a stack of its own outside the JavaScript heap, so a few megabytes of `[[[[…` cost hundreds
 * of megabytes that no heap limit bounds: one such request body took a 384 MB container down. Counting depth and
 * values first is a single pass without allocation, so a hostile document is refused before it costs anything.
 *
 * The scan assumes well-formed JSON. On malformed input its counts may be off, which is harmless: it only decides
 * whether parsing is attempted, and `JSON.parse` still rejects what is not JSON.
 */

export interface JsonShapeLimits {
  /** Arrays and objects open at the same time. */
  maxDepth: number;
  /** Values of any kind: every object, array, string, number, boolean and null (object keys do not count). */
  maxValues: number;
}

export type JsonShapeProblem = { kind: 'depth' | 'values'; limit: number } | null;

/** Nesting that real documents never need; dashboards, pipelines and tabular uploads stay far below it. */
export const MAX_JSON_DEPTH = 64;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COLON = 0x3a;

/** Characters that continue a number or a `true` / `false` / `null` literal. */
function literalChar(c: number): boolean {
  return (
    (c >= 0x30 && c <= 0x39) || // 0-9
    (c >= 0x61 && c <= 0x7a) || // a-z
    c === 0x2e || // .
    c === 0x2b || // +
    c === 0x2d || // -
    c === 0x45 // E
  );
}

/** The first limit the text exceeds, or null when it may be parsed. */
export function jsonShapeProblem(text: string, limits: JsonShapeLimits): JsonShapeProblem {
  const { maxDepth, maxValues } = limits;
  const n = text.length;
  let depth = 0;
  // Every string counts as a value, and every colon marks the string before it as a key instead.
  let values = 0;
  let keys = 0;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === QUOTE) {
      values++;
      // Jump to the closing quote: one not preceded by an odd number of backslashes.
      let end = text.indexOf('"', i + 1);
      while (end > 0) {
        let slashes = 0;
        while (text.charCodeAt(end - 1 - slashes) === BACKSLASH) slashes++;
        if (slashes % 2 === 0) break;
        end = text.indexOf('"', end + 1);
      }
      if (end < 0) return null;
      i = end;
    } else if (c === 0x5b || c === 0x7b) {
      values++;
      if (++depth > maxDepth) return { kind: 'depth', limit: maxDepth };
    } else if (c === 0x5d || c === 0x7d) {
      depth--;
    } else if (c === COLON) {
      keys++;
    } else if (literalChar(c)) {
      values++;
      while (i + 1 < n && literalChar(text.charCodeAt(i + 1))) i++;
    } else {
      continue;
    }
    if (values - keys > maxValues) return { kind: 'values', limit: maxValues };
  }
  return null;
}
