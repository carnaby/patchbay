/**
 * The map widget's body, loaded with React.lazy: this chunk carries the base map (Natural Earth 1:110m), the map
 * logic from core and the ECharts pieces only maps need, so dashboards without a map never download them. It is a
 * hashed file under /assets/, which the service worker caches, so a wall screen that lost its network still draws
 * the map.
 */
import { type DatasetResult, THEMES, type Widget } from '@patchbay/core';
import world from '@patchbay/core/geo/world-110m.json';
import {
  buildMapOption,
  describeMap,
  mapRows,
  mapTableColumns,
  mapTime,
  WORLD_MAP,
} from '@patchbay/core/map';
import * as echarts from 'echarts/core';
// Each registers itself on import; by path, as in EChart.tsx, so they stay in this chunk.
import 'echarts/lib/chart/custom';
import 'echarts/lib/chart/lines';
import 'echarts/lib/component/geo';
import 'echarts/lib/component/graphic';
import { useMemo } from 'react';
import { useTheme } from '../lib/hooks.ts';
import { EChart } from './EChart.tsx';
import { TableBody } from './WidgetBody.tsx';

// Scatter, tooltip, legend and visualMap are already registered by EChart.tsx.
echarts.registerMap(WORLD_MAP, world as Parameters<typeof echarts.registerMap>[1]);

export default function MapBody({
  widget,
  result,
  asTable,
}: {
  widget: Extract<Widget, { type: 'map' }>;
  result: DatasetResult;
  /** The accessible alternative: the rows the map draws, in the same order, as the regular table body. */
  asTable: boolean;
}) {
  const mode = useTheme();
  const config = widget.config;
  const at = mapTime(result.table, result.fetchedAt);
  const option = useMemo(
    () => (asTable ? null : buildMapOption(config, result.table, THEMES[mode], { at })),
    [asTable, config, result.table, mode, at],
  );
  const description = describeMap(config, result.table, at);

  if (asTable || !option) {
    const table = { columns: result.table.columns, rows: mapRows(config, result.table).rows };
    return (
      <div className="flex h-full flex-col gap-1.5">
        <p className="shrink-0 text-xs text-muted">{description}</p>
        <div className="min-h-0 flex-1">
          <TableBody
            widget={{
              id: widget.id,
              type: 'table',
              datasetId: widget.datasetId,
              config: { columns: mapTableColumns(config, result.table), pageSize: 25 },
            }}
            result={{ ...result, table }}
          />
        </div>
      </div>
    );
  }
  // A different encoding (size, colour, legend, shading) starts a fresh chart, so nothing of the old config
  // lingers; new data with the same config merges and animates.
  const shape = [config.mode, config.series, config.size, config.color, config.terminator, mode].join('|');
  return (
    <EChart key={shape} option={option} label={`${widget.title ? `${widget.title}: ` : ''}${description}`} />
  );
}
