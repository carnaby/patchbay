import type { Dataset, Widget } from './schema.ts';

/**
 * The credit lines to show for these widgets, one per distinct source, in the order the widgets come.
 * Some providers require a visible credit (Open-Meteo and the World Bank under CC BY 4.0, CoinGecko), so viewers see
 * it, not only the editor. `attributions` maps a connector id to its credit text (ConnectorInfo.attribution).
 */
export function widgetAttributions(
  datasets: readonly Pick<Dataset, 'id' | 'source'>[],
  widgets: readonly Pick<Widget, 'type'>[],
  attributions: Readonly<Record<string, string>>,
): string[] {
  const byId = new Map(datasets.map((d) => [d.id, d.source]));
  const lines = new Set<string>();
  for (const widget of widgets) {
    const datasetId = 'datasetId' in widget && typeof widget.datasetId === 'string' ? widget.datasetId : null;
    const source = datasetId ? byId.get(datasetId) : undefined;
    if (source?.kind !== 'connector') continue;
    const line = attributions[source.connector]?.trim();
    if (line) lines.add(line);
  }
  return [...lines];
}
