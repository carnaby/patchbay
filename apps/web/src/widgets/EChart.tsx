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
import { useEffect, useRef } from 'react';

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
  // The latest handler, read at click time: the instance is made once and its listeners stay.
  const click = useRef(onItemClick);
  useEffect(() => {
    click.current = onItemClick;
  }, [onItemClick]);

  useEffect(() => {
    if (!el.current) return;
    const instance = echarts.init(el.current, undefined, { renderer: 'canvas' });
    chart.current = instance;
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
  }, []);

  useEffect(() => {
    const instance = chart.current;
    if (!instance) return;
    // When the structure changes (other series, other chart kind) replace the
    // option; when only data changes, merge so ECharts animates the update.
    const series =
      (option.series as
        | { type?: string; name?: string; markLine?: unknown; triggerEvent?: boolean }[]
        | undefined) ?? [];
    // A merge never drops a markLine, so reference lines coming or going count as a new shape. Nor a clickable line
    // (`triggerEvent`, written only while a cross-filter picks by series), which would stay clickable after it is gone.
    const shape = JSON.stringify([
      series.map((s) => `${s.type}:${s.name}${s.markLine ? ':ref' : ''}${s.triggerEvent ? ':click' : ''}`),
      (option.xAxis as { type?: string } | undefined)?.type,
      Boolean(option.title),
    ]);
    const replace = shape !== lastShape.current;
    lastShape.current = shape;
    instance.setOption(option, { notMerge: replace, lazyUpdate: true });
  }, [option]);

  // `isolate`: ECharts gives its tooltip a huge z-index, and without a stacking context of its own the tooltip would
  // rise above the sticky header and open dialogs.
  return <div ref={el} className={`isolate ${className ?? 'h-full w-full'}`} role="img" aria-label={label} />;
}
