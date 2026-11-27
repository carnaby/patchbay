/**
 * Minimal ECharts binding: one instance per element, option updates merged in
 * place (so live data animates instead of redrawing), resize via
 * ResizeObserver. Only the chart types we use are registered (tree-shaking).
 */
import * as echarts from 'echarts/core';
// Each registers itself on import. By path rather than through the 'echarts/charts' and 'echarts/components'
// indexes: an index re-exports every chart and component, which would make the map-only parts look used by every
// page to the bundler, and keep them out of the lazily loaded map chunk (vite.config.ts).
import 'echarts/lib/chart/bar';
import 'echarts/lib/chart/funnel';
import 'echarts/lib/chart/gauge';
import 'echarts/lib/chart/heatmap';
import 'echarts/lib/chart/line';
import 'echarts/lib/chart/pie';
import 'echarts/lib/chart/radar';
import 'echarts/lib/chart/scatter';
import 'echarts/lib/component/grid';
import 'echarts/lib/component/legend';
import 'echarts/lib/component/markLine';
import 'echarts/lib/component/radar';
import 'echarts/lib/component/title';
import 'echarts/lib/component/tooltip';
import 'echarts/lib/component/visualMap';
import { CanvasRenderer } from 'echarts/renderers';
import { useContext, useEffect, useRef } from 'react';
import { PresentationScaleContext } from '../editor/presentation.tsx';
import { eventPoint, zoomedLocalPoint } from './zoom-pointer.ts';

echarts.use([CanvasRenderer]);

/** What ECharts reports for a click on an item; only what cross-filter reads. */
export interface EChartItem {
  name?: string;
  seriesName?: string;
  data?: unknown;
}

export function EChart({
  option,
  className,
  label,
  onItemClick,
}: {
  option: Record<string, unknown>;
  className?: string;
  label?: string;
  onItemClick?: ((item: EChartItem) => void) | undefined;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const lastShape = useRef<string>('');
  // The option last given, for an instance made again after it (a new pixel ratio).
  const latest = useRef<Record<string, unknown> | null>(null);
  // The latest handler, read at click time: the instance's listeners stay until it is made again.
  const click = useRef(onItemClick);
  useEffect(() => {
    click.current = onItemClick;
  }, [onItemClick]);
  // Inside the zoomed presentation page the canvas is drawn at the scaled ratio, or it would be upscaled and blurred.
  const scale = useContext(PresentationScaleContext);
  const dpr = window.devicePixelRatio * scale;

  useEffect(() => {
    if (!el.current) return;
    // ECharts 6.1's resize() cannot change the pixel ratio, so a new one means a new instance.
    const instance = echarts.init(el.current, undefined, { renderer: 'canvas', devicePixelRatio: dpr });
    chart.current = instance;
    // Only on a re-init: on the first mount the option effect below gives the first option.
    if (latest.current) {
      // Without the entry animation: a scale change on a wall must not make every chart grow in again.
      instance.setOption({ ...latest.current, animation: false }, { notMerge: true });
      // Later updates animate as the option says (buildOption sets the flag), not as the replay did.
      instance.setOption({ animation: (latest.current.animation as boolean | undefined) ?? true });
      lastShape.current = shapeOf(latest.current);
    }
    const ro = new ResizeObserver(() => instance.resize());
    ro.observe(el.current);
    // A tapped tooltip stays until the next tap, so scrolling would carry it along over the page. A mouse moves it
    // anyway. Capturing on window catches every scroller, also the dashboard's own.
    let touch = false;
    let tip = false;
    const onPointerDown = (e: PointerEvent) => {
      touch = e.pointerType === 'touch';
    };
    const onScroll = () => {
      if (!touch || !tip) return;
      tip = false;
      instance.dispatchAction({ type: 'hideTip' });
    };
    instance.on('showTip', () => {
      tip = true;
    });
    instance.on('hideTip', () => {
      tip = false;
    });
    instance.on('click', (params) => click.current?.(params as EChartItem));
    const node = el.current;
    node.addEventListener('pointerdown', onPointerDown, { passive: true });
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      node.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('scroll', onScroll, { capture: true });
      ro.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, [dpr]);

  // Standardized CSS zoom reports offsetX/offsetY in zoomed pixels (Chrome 158 at zoom 1.5: 960 where the chart's
  // own pixel is 640), and zrender 6.1.0 takes offsetX as its local coordinate, so a tap would hit the item 1.5x
  // further. zrender's normalizeEvent (lib/core/event.js:54-55) returns early when the native event already has zrX,
  // so the right point is written there first, while capturing. The early return also skips zrender's zrDelta (wheel),
  // harmless today because no chart uses roam or dataZoom. Private behaviour: check it on a zrender upgrade.
  useEffect(() => {
    const node = el.current;
    if (!node || scale === 1) return;
    const correct = (e: Event) => {
      const point = eventPoint(e);
      if (!point) return;
      const local = zoomedLocalPoint(
        point.clientX,
        point.clientY,
        node.getBoundingClientRect(),
        node.currentCSSZoom || scale,
      );
      Object.assign(e, { zrX: local.x, zrY: local.y });
    };
    for (const type of ZR_EVENTS) node.addEventListener(type, correct, { capture: true, passive: true });
    return () => {
      for (const type of ZR_EVENTS) node.removeEventListener(type, correct, { capture: true });
    };
  }, [scale]);

  useEffect(() => {
    latest.current = option;
    const instance = chart.current;
    if (!instance) return;
    // When the structure changes (other series, other chart kind) replace the
    // option; when only data changes, merge so ECharts animates the update.
    const shape = shapeOf(option);
    const replace = shape !== lastShape.current;
    lastShape.current = shape;
    instance.setOption(option, { notMerge: replace, lazyUpdate: true });
  }, [option]);

  // `isolate`: ECharts gives its tooltip a huge z-index, and without a stacking context of its own the tooltip would
  // rise above the sticky header and open dialogs.
  return <div ref={el} className={`isolate ${className ?? 'h-full w-full'}`} role="img" aria-label={label} />;
}

/** Every DOM event zrender turns into a position. */
const ZR_EVENTS = [
  'pointerdown',
  'pointermove',
  'pointerup',
  'pointerover',
  'pointerout',
  'pointerenter',
  'pointerleave',
  'pointercancel',
  'mousedown',
  'mousemove',
  'mouseup',
  'mouseover',
  'mouseout',
  'mouseenter',
  'mouseleave',
  'click',
  'dblclick',
  'contextmenu',
  'wheel',
  'touchstart',
  'touchmove',
  'touchend',
  'touchcancel',
] as const;

function shapeOf(option: Record<string, unknown>): string {
  const series =
    (option.series as
      | { type?: string; name?: string; markLine?: unknown; triggerEvent?: boolean }[]
      | undefined) ?? [];
  // A merge never drops a markLine, so reference lines coming or going count as a new shape. Nor a clickable line
  // (`triggerEvent`, written only while a cross-filter picks by series), which would stay clickable after it is gone.
  return JSON.stringify([
    series.map((s) => `${s.type}:${s.name}${s.markLine ? ':ref' : ''}${s.triggerEvent ? ':click' : ''}`),
    (option.xAxis as { type?: string } | undefined)?.type,
    Boolean(option.title),
  ]);
}
