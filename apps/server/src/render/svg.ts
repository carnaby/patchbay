/** SVG text pieces shared by the snapshot renderer and the widgets it draws by hand. */

/** The bundled family (see FONT_OPTIONS in snapshot.ts); unquoted, so it is safe inside attributes. */
export const FONT = 'Inter, sans-serif';

/**
 * Terminal escape sequences (colours, cursor moves, window titles) as a script's or a monitor's output carries them,
 * dropped whole: a red "FAILED" reads "FAILED", not "[31mFAILED[0m".
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;
/** What XML 1.0 does not allow in text: C0 controls but tab, LF and CR, U+FFFE/FFFF and lone surrogates. */
const NOT_XML =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * Without the characters XML forbids: one of them makes resvg refuse the whole image, every card of it. Also for SVG
 * that ECharts wrote, where an ESC never belongs either.
 */
export const xmlSafe = (s: string) => s.replace(ANSI, '').replace(NOT_XML, '');

const esc = (s: string) =>
  xmlSafe(s).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );

export function truncate(text: string, maxChars: number) {
  return text.length > maxChars ? `${text.slice(0, Math.max(1, maxChars - 1))}…` : text;
}

export function text(
  x: number,
  y: number,
  value: string,
  opts: { size?: number; color: string; weight?: number; anchor?: string },
) {
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${opts.size ?? 12}" font-weight="${opts.weight ?? 400}" fill="${opts.color}" text-anchor="${opts.anchor ?? 'start'}">${esc(value)}</text>`;
}
