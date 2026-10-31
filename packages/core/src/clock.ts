/**
 * The clock widget (proposal 0009). One pure renderer for the browser and the PNG snapshot, so a screen and
 * `render_snapshot` cannot drift. Time zones and summer time come from `Intl`; there is no date maths by hand.
 */
import type { ClockConfig } from './schema.ts';
import type { ChartTheme } from './theme.ts';

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export interface ClockModel {
  /** "14:05" or "2:05"; with seconds "14:05:09". */
  time: string;
  /** "PM" (in the viewer's language) for 12-hour clocks, otherwise null. */
  period: string | null;
  date: string | null;
  label: string | null;
  hours: number;
  minutes: number;
  seconds: number;
}

/** "America/New_York" -> "New York", "Etc/UTC" -> "UTC". */
export function zoneCity(zone: string): string {
  const last = zone.split('/').pop() ?? zone;
  return last.replace(/_/g, ' ');
}

function safeLocale(locale: string): string {
  try {
    new Intl.DateTimeFormat(locale);
    return locale;
  } catch {
    return 'en-GB';
  }
}

/**
 * The clock's text and hand positions at `at`. `zone` is used when the config names no time zone: the browser
 * passes nothing (the viewer's local time), the snapshot passes "UTC" because the server has no viewer.
 */
export function clockModel(
  config: ClockConfig,
  at: number,
  options: { locale: string; zone?: string | undefined },
): ClockModel {
  const timeZone = config.timeZone ?? options.zone;
  const locale = safeLocale(options.locale);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const hours = part('hour') % 24;
  const minutes = part('minute');
  const seconds = part('second');

  const pad = (n: number) => String(n).padStart(2, '0');
  const h = config.hourCycle === 'h12' ? (hours % 12 === 0 ? 12 : hours % 12) : hours;
  const time = `${config.hourCycle === 'h12' ? h : pad(h)}:${pad(minutes)}${config.showSeconds ? `:${pad(seconds)}` : ''}`;
  let period: string | null = null;
  if (config.hourCycle === 'h12') {
    period =
      new Intl.DateTimeFormat(locale, { timeZone, hour: 'numeric', hourCycle: 'h12' })
        .formatToParts(at)
        .find((p) => p.type === 'dayPeriod')?.value ?? (hours < 12 ? 'AM' : 'PM');
  }
  const date = config.showDate
    ? new Intl.DateTimeFormat(locale, { timeZone, weekday: 'long', day: 'numeric', month: 'long' }).format(at)
    : null;
  const label = config.label?.trim() || (timeZone ? zoneCity(timeZone) : null);
  return { time, period, date, label, hours, minutes, seconds };
}

/** "14:05, Thursday 30 October, New York": the accessible name, without seconds so screen readers are not flooded. */
export function describeClock(model: ClockModel): string {
  const time = `${String(model.hours).padStart(2, '0')}:${String(model.minutes).padStart(2, '0')}`;
  return [
    model.period ? `${model.time.replace(/:\d\d$/, '')} ${model.period}` : time,
    model.date,
    model.label,
  ]
    .filter(Boolean)
    .join(', ');
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );

/** Rough text widths for the viewBox; `preserveAspectRatio` scales whatever is left over. */
const DIGIT_EM = 0.62;
const TEXT_EM = 0.52;

/**
 * The clock as a standalone SVG that fills its box. `fontFamily` is "inherit" in the browser (the page font) and
 * the bundled Inter in snapshots. The second hand uses the critical status red: the railway-clock look, and the
 * only colour on the face.
 */
export function clockSvg(
  model: ClockModel,
  config: ClockConfig,
  theme: ChartTheme,
  fontFamily = 'inherit',
): string {
  const font = `font-family="${esc(fontFamily)}"`;
  const lines: { text: string; size: number; color: string; weight: number }[] = [];
  if (model.date) lines.push({ text: model.date, size: 22, color: theme.textSecondary, weight: 500 });
  if (model.label) lines.push({ text: model.label, size: 20, color: theme.muted, weight: 500 });

  if (config.style === 'analog') {
    const size = 200;
    const c = size / 2;
    const r = 92;
    const extra = lines.reduce((sum, l) => sum + l.size * 0.7 + 10, 0);
    const width = Math.max(size, ...lines.map((l) => l.text.length * TEXT_EM * l.size * 0.7 + 16));
    const cx = width / 2;
    const out: string[] = [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width.toFixed(0)} ${(size + extra).toFixed(0)}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">`,
      `<circle cx="${cx}" cy="${c}" r="${r}" fill="none" stroke="${theme.axis}" stroke-width="2"/>`,
    ];
    for (let i = 0; i < 60; i++) {
      const hour = i % 5 === 0;
      const a = (i * 6 * Math.PI) / 180;
      const r1 = r - (hour ? 12 : 5);
      const r2 = r - 2;
      out.push(
        `<line x1="${(cx + r1 * Math.sin(a)).toFixed(2)}" y1="${(c - r1 * Math.cos(a)).toFixed(2)}" x2="${(cx + r2 * Math.sin(a)).toFixed(2)}" y2="${(c - r2 * Math.cos(a)).toFixed(2)}" stroke="${hour ? theme.textSecondary : theme.axis}" stroke-width="${hour ? 3 : 1.2}" stroke-linecap="round"/>`,
      );
    }
    for (const [n, i] of [
      [12, 0],
      [3, 15],
      [6, 30],
      [9, 45],
    ] as const) {
      const a = (i * 6 * Math.PI) / 180;
      const rn = r - 28;
      out.push(
        `<text x="${(cx + rn * Math.sin(a)).toFixed(2)}" y="${(c - rn * Math.cos(a) + 7).toFixed(2)}" ${font} font-size="20" font-weight="600" fill="${theme.textPrimary}" text-anchor="middle">${n}</text>`,
      );
    }
    const hand = (deg: number, length: number, width: number, color: string, tail = 0) => {
      const a = (deg * Math.PI) / 180;
      return `<line x1="${(cx - tail * Math.sin(a)).toFixed(2)}" y1="${(c + tail * Math.cos(a)).toFixed(2)}" x2="${(cx + length * Math.sin(a)).toFixed(2)}" y2="${(c - length * Math.cos(a)).toFixed(2)}" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>`;
    };
    const { hourAngle, minuteAngle, secondAngle } = handAngles(model);
    out.push(hand(hourAngle, r * 0.5, 7, theme.textPrimary));
    out.push(hand(minuteAngle, r * 0.78, 4.5, theme.textPrimary));
    if (config.showSeconds) out.push(hand(secondAngle, r * 0.86, 1.6, theme.status.critical, 16));
    out.push(
      `<circle cx="${cx}" cy="${c}" r="5" fill="${config.showSeconds ? theme.status.critical : theme.textPrimary}"/>`,
    );
    let y = size + 4;
    for (const l of lines) {
      const s = l.size * 0.7;
      y += s + 6;
      out.push(
        `<text x="${cx}" y="${y.toFixed(1)}" ${font} font-size="${s}" font-weight="${l.weight}" fill="${l.color}" text-anchor="middle">${esc(l.text)}</text>`,
      );
    }
    out.push('</svg>');
    return out.join('');
  }

  const timeSize = 96;
  const periodSize = 34;
  const timeWidth =
    model.time.length * DIGIT_EM * timeSize +
    (model.period ? model.period.length * TEXT_EM * periodSize + 12 : 0);
  const width = Math.max(timeWidth, ...lines.map((l) => l.text.length * TEXT_EM * l.size)) + 16;
  const height = timeSize * 0.92 + lines.reduce((sum, l) => sum + l.size + 10, 0) + 8;
  const cx = width / 2;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width.toFixed(0)} ${height.toFixed(0)}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">`,
    `<text x="${cx.toFixed(1)}" y="${(timeSize * 0.8).toFixed(1)}" ${font} font-size="${timeSize}" font-weight="600" fill="${theme.textPrimary}" text-anchor="middle" style="font-variant-numeric: tabular-nums" letter-spacing="-2">${esc(model.time)}${
      model.period
        ? `<tspan font-size="${periodSize}" font-weight="500" fill="${theme.textSecondary}" dx="10" letter-spacing="0">${esc(model.period)}</tspan>`
        : ''
    }</text>`,
  ];
  let y = timeSize * 0.92;
  for (const l of lines) {
    y += l.size + 6;
    out.push(
      `<text x="${cx.toFixed(1)}" y="${y.toFixed(1)}" ${font} font-size="${l.size}" font-weight="${l.weight}" fill="${l.color}" text-anchor="middle">${esc(l.text)}</text>`,
    );
  }
  out.push('</svg>');
  return out.join('');
}

/** Degrees clockwise from 12. The hour and minute hands move continuously, the second hand ticks. */
export function handAngles(model: Pick<ClockModel, 'hours' | 'minutes' | 'seconds'>) {
  return {
    hourAngle: ((model.hours % 12) + model.minutes / 60) * 30,
    minuteAngle: (model.minutes + model.seconds / 60) * 6,
    secondAngle: model.seconds * 6,
  };
}
