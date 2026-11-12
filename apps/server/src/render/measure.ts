/**
 * Text widths for ECharts on the server. ECharts has no canvas there, so zrender falls back to a built-in table of
 * character widths that is up to 8 % narrower than the Inter that resvg draws. `containLabel` and the legend then
 * left too little room: long axis labels ("@modelcontextprotocol/sdk") ran past the card's edge and legend entries
 * overlapped. Measuring with the same font and the same rasteriser removes the difference.
 */
import { Resvg } from '@resvg/resvg-js';
import * as echarts from 'echarts';
import { FONT_OPTIONS, xmlChars } from './svg.ts';

const MEASURE_SIZE = 100;
type Weight = 400 | 600 | 700;
const WEIGHTS: Weight[] = [400, 600, 700];

/** Right edge of a one-line text, as resvg draws it. */
function rightEdge(value: string, weight: Weight): number {
  const safe = value.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]!);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="200"><text xml:space="preserve" x="0" y="100" font-family="Inter" font-weight="${weight}" font-size="${MEASURE_SIZE}">${safe}</text></svg>`;
  const box = new Resvg(svg, { font: FONT_OPTIONS }).getBBox();
  return box ? box.x + box.width : 0;
}

/**
 * Advance of one character in em. Measured between two "H" so that side bearings and a trailing space count, which
 * a bounding box alone would leave out. Kerning is ignored on purpose: it only ever makes the drawing narrower.
 */
function advance(ch: string, weight: Weight, reference: number): number {
  return Math.max(0, rightEdge(`H${ch}H`, weight) - reference) / MEASURE_SIZE;
}

const advances = new Map<Weight, Map<string, number>>();
for (const weight of WEIGHTS) {
  const table = new Map<string, number>();
  const reference = rightEdge('HH', weight);
  // Printable ASCII up front, so the common case never measures at render time.
  for (let code = 0x20; code <= 0x7e; code++) {
    const ch = String.fromCharCode(code);
    table.set(ch, advance(ch, weight, reference));
  }
  table.set('\0reference', reference);
  advances.set(weight, table);
}

// Unbounded on purpose: a worker is replaced after a render timeout, and in practice the table only grows by the
// distinct characters seen, which is small.
function advanceOf(ch: string, weight: Weight): number {
  const table = advances.get(weight)!;
  const known = table.get(ch);
  if (known !== undefined) return known;
  // Controls are not XML and draw nothing.
  const width = xmlChars(ch) === ch && ch >= ' ' ? advance(ch, weight, table.get('\0reference')!) : 0;
  table.set(ch, width);
  return width;
}

/** Width in px of `text` in the bundled Inter; size and weight come from a CSS font shorthand. */
export function interTextWidth(text: string, font: string): number {
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 12);
  const numeric = Number(/\b([1-9]00)\b/.exec(font)?.[1] ?? 400);
  const weight: Weight = /\bbold\b/.test(font) || numeric >= 700 ? 700 : numeric >= 500 ? 600 : 400;
  let em = 0;
  for (const ch of text) em += advanceOf(ch, weight);
  return em * size;
}

export function installTextMeasure(): void {
  echarts.setPlatformAPI({
    measureText: (text, font) => ({ width: interTextWidth(String(text ?? ''), font ?? '12px sans-serif') }),
  });
}

/** Cuts `value` with an ellipsis so it draws no wider than `maxWidth` px in `font`. */
export function truncateToWidth(value: string, maxWidth: number, font: string): string {
  if (interTextWidth(value, font) <= maxWidth) return value;
  const chars = [...value];
  // Keep at least one character, as truncate() does.
  let keep = chars.length - 1;
  while (keep > 1 && interTextWidth(`${chars.slice(0, keep).join('')}…`, font) > maxWidth) keep--;
  return `${chars.slice(0, Math.max(1, keep)).join('')}…`;
}
