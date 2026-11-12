/** SVG text pieces shared by the snapshot renderer and the widgets it draws by hand. */
import { fileURLToPath } from 'node:url';
import { stripAnsi } from '@patchbay/core';
import type { ResvgRenderOptions } from '@resvg/resvg-js';

/** The bundled family (see FONT_OPTIONS below); unquoted, so it is safe inside attributes. */
export const FONT = 'Inter, sans-serif';

/**
 * The renderer brings its own fonts instead of asking the OS. resvg finds system fonts through
 * fontconfig, and the slim runtime image has no fonts.conf, so it found none and every text node
 * rendered empty while shapes still drew. On a desktop it picks whatever happens to be installed.
 * Inter covers Latin, Greek, Cyrillic and the symbols used below (▲ ▼ ■ ⚠ …); scripts it lacks
 * (CJK, Arabic) render as boxes, a fair price for snapshots that look the same on every host.
 */
export const FONT_OPTIONS: ResvgRenderOptions['font'] = {
  loadSystemFonts: false,
  fontFiles: ['Inter-Regular.ttf', 'Inter-SemiBold.ttf', 'Inter-Bold.ttf'].map((file) =>
    fileURLToPath(new URL(`./fonts/${file}`, import.meta.url)),
  ),
  defaultFontFamily: 'Inter',
  sansSerifFamily: 'Inter',
};

/** What XML 1.0 does not allow in text: C0 controls but tab, LF and CR, U+FFFE/FFFF and lone surrogates. */
const NOT_XML =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * Without the characters XML forbids: one of them makes resvg refuse the whole image, every card of it. Safe on a
 * whole document (the SVG ECharts wrote): it removes single characters only, never the markup around them.
 */
export const xmlChars = (s: string) => s.replace(NOT_XML, '');

/** Text for an SVG element: plain text, escape sequences dropped whole, nothing XML forbids, markup escaped. */
const esc = (s: string) =>
  xmlChars(stripAnsi(s)).replace(
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
