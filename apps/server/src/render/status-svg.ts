/**
 * The status widget as SVG, for snapshots. It draws core's `statusFit` layout as it is, so a snapshot of a body this
 * size shows the tiles and the "+N" a screen of that size shows; only the drawing is done here.
 */
import {
  type ChartTheme,
  resolveColor,
  STATUS_COLORS,
  STATUS_METRICS,
  type StatusLayout,
  type StatusModel,
  type StatusPlaced,
  statusDetailChars,
  statusMoreNames,
  statusMoreSectionsTitle,
  statusMoreTitle,
  statusProblemHead,
  statusSectionTitle,
  statusSummary,
  statusTileFoot,
  wrapText,
} from '@patchbay/core';
import { text, truncate } from './svg.ts';

const M = STATUS_METRICS;
const round = (n: number) => Math.round(n * 10) / 10;
/** The 13 px name line holds fewer characters than the 12 px lines the estimate counts in. */
const nameChars = (chars: number) => Math.max(4, Math.floor((chars * M.textSize) / M.nameSize));
/** Drawn after the name of a tile with a link; Inter has the glyph. Constant markup, never user text. */
const ARROW = ' ↗';

/** The detail as the browser wraps it; cut to two lines, the second ending in an ellipsis, when the fit clamps. */
function detailLines(detail: string | null, chars: number, clamp: boolean): string[] {
  if (!detail) return [];
  const lines = wrapText(detail, chars);
  if (!clamp || lines.length <= M.clampLines) return lines;
  const kept = lines.slice(0, M.clampLines);
  kept[M.clampLines - 1] = truncate(`${kept[M.clampLines - 1]} ${lines[M.clampLines]}`, chars);
  return kept;
}

function cell(placed: StatusPlaced, theme: ChartTheme, now: number): string {
  const { item } = placed;
  const x = round(placed.x);
  const y = round(placed.y);
  const width = round(placed.width);
  const height = round(placed.height);
  const level = item.kind === 'tile' ? item.tile.level : item.level;
  const token = STATUS_COLORS[level];
  const left = round(placed.x + M.accent + M.padX);
  const chars = statusDetailChars(placed.width);
  const out = [
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${M.radius}" fill="${resolveColor(token, theme, 'fill')}"/>`,
    `<rect x="${x}" y="${y}" width="${M.accent}" height="${height}" fill="${resolveColor(token, theme, 'mark')}"/>`,
  ];
  let line = placed.y + M.padY;
  const name = item.kind === 'tile' ? item.tile.entity : statusMoreTitle(item);
  const linked = item.kind === 'tile' && item.tile.href !== undefined;
  // The screen's link icon after the name, so an agent sees which tiles open a site. The name gives way to it, as in
  // the browser, so the line keeps its height and the fit stays true.
  const label = text(left, round(line + 13), truncate(name, nameChars(chars) - (linked ? ARROW.length : 0)), {
    size: M.nameSize,
    weight: 600,
    color: level === 'off' ? theme.textSecondary : theme.textPrimary,
  });
  out.push(
    linked
      ? label.replace(
          /<\/text>$/,
          `<tspan dx="2" font-weight="400" fill="${theme.textSecondary}">${ARROW}</tspan></text>`,
        )
      : label,
  );
  line += M.nameHeight;
  if (item.kind === 'more') {
    out.push(
      text(left, round(line + 12), truncate(statusMoreNames(item.tiles), chars), {
        size: M.textSize,
        color: theme.textSecondary,
      }),
    );
    return out.join('');
  }
  for (const check of item.tile.problems) {
    line += M.problemGap;
    out.push(
      text(left, round(line + 12), truncate(statusProblemHead(check, now), chars), {
        size: M.textSize,
        weight: 600,
        color: resolveColor(STATUS_COLORS[check.level], theme, 'text'),
      }),
    );
    line += M.lineHeight;
    for (const detail of detailLines(check.detail, chars, item.clamp)) {
      out.push(text(left, round(line + 12), detail, { size: M.textSize, color: theme.textPrimary }));
      line += M.lineHeight;
    }
  }
  const foot = statusTileFoot(item.tile);
  if (foot) {
    out.push(
      text(left, round(line + 12), truncate(foot, chars), { size: M.textSize, color: theme.textSecondary }),
    );
  }
  return out.join('');
}

export function statusSvg(
  model: StatusModel,
  layout: StatusLayout,
  theme: ChartTheme,
  width: number,
  height: number,
  now: number,
): string {
  const parts: string[] = [];
  if (layout.summaryHeight) {
    parts.push(
      `<circle cx="5" cy="${M.summaryLine / 2}" r="4" fill="${resolveColor(STATUS_COLORS[model.level], theme, 'mark')}"/>`,
      text(16, 15, truncate(statusSummary(model), Math.floor((width - 16) / 7.6)), {
        size: M.summarySize,
        weight: 600,
        color: theme.textPrimary,
      }),
    );
  } else if (model.sections.length === 0) {
    parts.push(text(0, 15, 'No checks', { size: M.textSize, color: theme.muted }));
  }
  const header = (y: number, title: string) =>
    text(0, round(y + 13), truncate(title, Math.floor(width / M.charWidth)), {
      size: M.textSize,
      weight: 600,
      color: theme.textSecondary,
    });
  for (const section of layout.sections) {
    // Nothing below the card: a layout that does not fit at all is cut at the bottom, never drawn over the border.
    if (section.y >= height) break;
    if (section.header) parts.push(header(section.y, statusSectionTitle(section.section)));
    // A cell that would end below the body would cross the card's padding and border (the body has no clip): left
    // out. The fit only leaves one there in a box too small for the summary line and one cell.
    for (const placed of section.items) {
      if (placed.y + placed.height <= height) parts.push(cell(placed, theme, now));
    }
  }
  const more = layout.moreSections;
  if (more && more.y < height) parts.push(header(more.y, statusMoreSectionsTitle(more.sections)));
  return parts.join('');
}
