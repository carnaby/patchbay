/**
 * Chart colour tokens. The categorical order is validated for colour-vision
 * deficiency on adjacent pairs in both modes, so series colours are assigned
 * in this fixed order and never cycled or regenerated.
 */
export type ThemeMode = 'light' | 'dark';

export interface ChartTheme {
  mode: ThemeMode;
  surface: string;
  textPrimary: string;
  textSecondary: string;
  muted: string;
  grid: string;
  axis: string;
  categorical: string[];
  sequential: string[];
  status: { good: string; warning: string; serious: string; critical: string };
  deltaGood: string;
  deltaBad: string;
}

const STATUS = { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' };
const SEQUENTIAL = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];

export const THEMES: Record<ThemeMode, ChartTheme> = {
  light: {
    mode: 'light',
    surface: '#fcfcfb',
    textPrimary: '#0b0b0b',
    textSecondary: '#52514e',
    muted: '#898781',
    grid: '#e1e0d9',
    axis: '#c3c2b7',
    categorical: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
    sequential: SEQUENTIAL,
    status: STATUS,
    deltaGood: '#006300',
    deltaBad: '#d03b3b',
  },
  dark: {
    mode: 'dark',
    surface: '#1a1a19',
    textPrimary: '#f0efec',
    textSecondary: '#c3c2b7',
    muted: '#898781',
    grid: '#2c2c2a',
    axis: '#383835',
    categorical: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
    sequential: [...SEQUENTIAL].reverse(),
    status: STATUS,
    deltaGood: '#0ca30c',
    deltaBad: '#e66767',
  },
};

/** Categorical slots beyond this are folded into "Other" rather than inventing hues. */
export const MAX_SERIES = 8;

/**
 * Named colours. Documents store these instead of hex where they can, because a token resolves per theme (and per
 * use, see `resolveColor`) to the validated palette and status colours, so it adapts to dark mode and keeps contrast.
 */
export const COLOR_TOKENS = [
  'accent-1',
  'accent-2',
  'accent-3',
  'accent-4',
  'accent-5',
  'accent-6',
  'accent-7',
  'accent-8',
  'positive',
  'warning',
  'serious',
  'negative',
  'neutral',
] as const;
export type ColorToken = (typeof COLOR_TOKENS)[number];
/** A token or `#rrggbb`. */
export type Color = string;
/** Lines, bars, dots and arcs; glyphs on the card surface; the light wash behind a table cell. */
export type ColorUsage = 'mark' | 'text' | 'fill';

/** WCAG 2 minimum for normal text; also what `text` usage guarantees against the card surface. */
export const TEXT_CONTRAST = 4.5;
/** WCAG 1.4.11 minimum for marks (non-text contrast). */
export const MARK_CONTRAST = 3;

/**
 * Amber and orange status colours are fine as arcs but about 1.8:1 as text on the light card, so text gets its own
 * steps. Pinned by a test that every token's text colour reaches 4.5:1 in both themes.
 */
export const STATUS_TEXT: Record<ThemeMode, { warning: string; serious: string }> = {
  light: { warning: '#996a00', serious: '#b9562c' },
  dark: { warning: '#fab219', serious: '#ec835a' },
};

const HEX = /^#[0-9a-fA-F]{6}$/;
export const isHexColor = (c: string): boolean => HEX.test(c);

type Rgb = [number, number, number];

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function hexToRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function rgbToHex(rgb: Rgb): string {
  return `#${rgb
    .map((c) =>
      Math.round(Math.min(1, Math.max(0, c)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(toLinear) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio of two `#rrggbb` colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** OKLab: perceptual, so moving lightness keeps the hue the eye sees. */
function hexToOklch(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex).map(toLinear) as Rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}

function oklchToLinear(L: number, C: number, h: number): Rgb {
  const A = C * Math.cos(h);
  const B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** Out-of-gamut colours lose chroma, never hue, so a darkened amber stays amber instead of turning olive. */
function oklchToHex(L: number, C: number, h: number): string {
  const inGamut = (c: number) => oklchToLinear(L, c, h).every((v) => v >= -1e-4 && v <= 1 + 1e-4);
  let chroma = C;
  if (!inGamut(chroma)) {
    let lo = 0;
    let hi = C;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(mid)) lo = mid;
      else hi = mid;
    }
    chroma = lo;
  }
  return rgbToHex(oklchToLinear(L, chroma, h).map((v) => toGamma(Math.min(1, Math.max(0, v)))) as Rgb);
}

/**
 * Moves a colour's lightness (OKLCH, hue kept) towards black on light backgrounds and towards white on dark ones,
 * just far enough to reach `min` contrast. Pure and deterministic, so the browser and the PNG renderer agree.
 */
export function ensureContrast(color: string, background: string, min: number): string {
  const hex = color.toLowerCase();
  if (contrastRatio(hex, background) >= min) return hex;
  const darker = contrastRatio('#000000', background) >= contrastRatio('#ffffff', background);
  const [L, C, h] = hexToOklch(hex);
  let near = L;
  let far = darker ? 0 : 1;
  for (let i = 0; i < 30; i++) {
    const mid = (near + far) / 2;
    if (contrastRatio(oklchToHex(mid, C, h), background) >= min) far = mid;
    else near = mid;
  }
  const result = oklchToHex(far, C, h);
  if (contrastRatio(result, background) >= min) return result;
  return darker ? '#000000' : '#ffffff';
}

/** Mixes two `#rrggbb` colours in sRGB, like CSS `color-mix(in srgb, a t, b)`. */
export function mixColors(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex([0, 1, 2].map((i) => x[i]! * t + y[i]! * (1 - t)) as Rgb);
}

/** Share of the colour in a cell tint: visible in each theme while body text keeps its contrast. */
const FILL_SHARE: Record<ThemeMode, number> = { light: 0.18, dark: 0.28 };

function markColor(color: Color, theme: ChartTheme): string {
  const accent = /^accent-([1-8])$/.exec(color);
  if (accent) return theme.categorical[Number(accent[1]) - 1]!;
  switch (color) {
    case 'positive':
      return theme.status.good;
    case 'warning':
      return theme.status.warning;
    case 'serious':
      return theme.status.serious;
    case 'negative':
      return theme.status.critical;
    case 'neutral':
      return theme.muted;
    default:
      return color;
  }
}

/**
 * The only place a colour becomes a hex string. Text is always pushed to 4.5:1 against the card, so a badly chosen
 * custom colour still reads; fills are a light wash under normal ink, which stays readable by construction.
 */
export function resolveColor(color: Color, theme: ChartTheme, usage: ColorUsage): string {
  const mark = markColor(color, theme);
  if (usage === 'mark') return mark;
  if (usage === 'fill') {
    if (color === 'neutral') return theme.grid;
    return isHexColor(mark) ? mixColors(mark, theme.surface, FILL_SHARE[theme.mode]) : mark;
  }
  let text = mark;
  if (color === 'positive') text = theme.deltaGood;
  else if (color === 'negative') text = theme.deltaBad;
  else if (color === 'warning' || color === 'serious') text = STATUS_TEXT[theme.mode][color];
  else if (color === 'neutral') text = theme.textSecondary;
  return isHexColor(text) ? ensureContrast(text, theme.surface, TEXT_CONTRAST) : text;
}
