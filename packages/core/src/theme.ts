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
