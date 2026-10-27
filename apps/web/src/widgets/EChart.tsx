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
import 'echarts/lib/component/radar';
import 'echarts/lib/component/title';
import 'echarts/lib/component/tooltip';
import 'echarts/lib/component/visualMap';
import { CanvasRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';

echarts.use([CanvasRenderer]);

export function EChart({
  option,
  className,
  label,
}: {
  option: Record<string, unknown>;
  className?: string;
  label?: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const lastShape = useRef<string>('');

  useEffect(() => {
    if (!el.current) return;
    const instance = echarts.init(el.current, undefined, { renderer: 'canvas' });
    chart.current = instance;
    const ro = new ResizeObserver(() => instance.resize());
    ro.observe(el.current);
    return () => {
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
    const series = (option.series as { type?: string; name?: string }[] | undefined) ?? [];
    const shape = JSON.stringify([
      series.map((s) => `${s.type}:${s.name}`),
      (option.xAxis as { type?: string } | undefined)?.type,
      Boolean(option.title),
    ]);
    const replace = shape !== lastShape.current;
    lastShape.current = shape;
    instance.setOption(option, { notMerge: replace, lazyUpdate: true });
  }, [option]);

  return <div ref={el} className={className ?? 'h-full w-full'} role="img" aria-label={label} />;
}
