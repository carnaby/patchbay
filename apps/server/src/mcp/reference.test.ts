import { describe, expect, it } from 'vitest';
import { referenceText, SERVER_INSTRUCTIONS } from './reference.ts';

describe('the Addresses line of the reference', () => {
  it('tells agents on a public instance not to try home-network services', () => {
    expect(referenceText('https://dash.example.com')).toContain('cannot be loaded here');
    const withNetwork = referenceText('https://dash.example.com', { kind: 'public' });
    expect(withNetwork).toContain('ALLOW_PRIVATE_HOSTS');
    expect(withNetwork).not.toContain('Your dashboards may also load');
  });

  it('lists the hosts only to users who may use them', () => {
    const text = referenceText('https://dash.example.com', {
      kind: 'private',
      entries: ['192.168.1.0/24', 'homeassistant.lan'],
    });
    expect(text).toContain('192.168.1.0/24, homeassistant.lan');
    expect(text).toContain('dashboards:write');
    const other = referenceText('https://dash.example.com', { kind: 'not-yours' });
    expect(other).toContain('owned by an administrator');
    expect(other).not.toContain('192.168.1.0/24');
  });

  it('shows http:// in the url examples only to users who may use the list', () => {
    const entries = ['homeassistant.lan'];
    const example = /url: "https:\/\/\.\.\. or http:\/\/\.\.\."/g;
    const mine = referenceText('https://dash.example.com', { kind: 'private', entries });
    expect(mine.match(example)).toHaveLength(2);
    for (const network of [{ kind: 'public' }, { kind: 'not-yours' }] as const) {
      const text = referenceText('https://dash.example.com', network);
      expect(text.match(example)).toBeNull();
      expect(text).toContain('url: "https://..."');
    }
  });
});

describe('the status widget in the reference', () => {
  it('documents every field, the vocabulary, the folding rules and an example', () => {
    const text = referenceText('https://dash.example.com');
    expect(text).toContain(
      '- status { entity, status, group?, label?, kind?, detail?, since?, link?, levels?, summary }',
    );
    for (const word of ['degraded', 'maintenance', 'crit', 'passed', 'true = ok, false = fail'])
      expect(text).toContain(word);
    expect(text).toContain('"+N more ok"');
    expect(text).toContain('"+N more problems"');
    expect(text).toContain('"+N more sections · 12 ok"');
    expect(text).toContain('"type": "status"');
    expect(text).toContain('link (a column of http(s) addresses)');
    expect(text).toContain('status 6x5');
    expect(text).toContain('## Sound cues (chart, kpi, gauge, table, map, status)');
  });
});

describe('POST queries in the reference', () => {
  it('documents method and body, the read-only intent, the limits, redirects, preview and a GitHub example', () => {
    const text = referenceText('https://dash.example.com');
    expect(text).toContain('## POST queries (http sources)');
    for (const words of [
      'Add method: "POST" and body to an http source',
      'never a string holding JSON',
      'at most 16,384 characters as JSON and 32 levels deep',
      'Only for read queries',
      'sent again on every refresh',
      'Never put a key or token in it',
      'A redirect answer to a POST is an error, never followed',
      'needs the dashboards:write scope',
      '"url": "https://api.github.com/graphql", "method": "POST"',
      '"body": { "query": "{ viewer { login } }" }',
      '"path": "data.viewer"',
    ]) {
      expect(text, words).toContain(words);
    }
  });
});

describe('JSON sources in the reference', () => {
  it('documents the upload path and column-shaped data', () => {
    const text = referenceText('https://dash.example.com');
    expect(text).toContain('upload_data path: "data.items"');
    expect(text).toContain('one row per position, columns in key order');
    expect(text).toContain('Lists of lists ([[t, v], ...]) are not converted');
    expect(text).toContain('or "in the file" for an upload');
  });
});

describe('filters in the reference', () => {
  it('documents declarations, references, the operations, the tool arguments and view links', () => {
    const text = referenceText('https://dash.example.com');
    expect(text).toContain('## Filters (dashboard parameters)');
    for (const words of [
      'type: "select", options: [{ value, label? }], all?: "All regions", default',
      'type: "dateRange", presets: [today|yesterday|last7d|last30d|last90d|thisMonth|lastMonth|thisYear|last12m]',
      'filter { expr: "$param.region == null || region == $param.region" }',
      'filter { expr: "time >= $param.period.start && time < $param.period.end" }',
      'https://api.example.com/v1/sales?region=$param.region&from=$param.period.from&to=$param.period.to',
      'A query pair whose filter is at "all" is left out',
      'Only select and dateRange filters reach URLs, bodies and connectors',
      'addParameter { parameter, before? }, updateParameter { id, set }',
      'get_data, render_snapshot, suggest_widgets and preview_data take parameters',
      'https://dash.example.com/d/<id>?p.region=eu&p.period=last7d',
    ])
      expect(text, words).toContain(words);
    expect(SERVER_INSTRUCTIONS).toContain('declare a filter (addParameter) and use $param.<id>');
  });

  it('documents clicks that set a filter', () => {
    const text = referenceText('https://dash.example.com');
    for (const words of [
      'crossFilter { parameter, field }',
      'bar, line, area, pie, donut and funnel',
      'clicking the selected item again resets it',
      'give the clicked widget a dataset without that filter',
    ])
      expect(text, words).toContain(words);
  });

  it('documents choices from a dataset column', () => {
    const text = referenceText('https://dash.example.com');
    for (const words of [
      'optionsFrom: { dataset, field }',
      'at most 200',
      'never reaches a source with secrets',
    ])
      expect(text, words).toContain(words);
  });

  it('documents the maxDays default, null resets, .start/.end for time columns and undimmed large maps', () => {
    const text = referenceText('https://dash.example.com');
    for (const words of [
      'maxDays (default 366, at most 3660)',
      'null resets custom and maxDays to false and 366',
      'Compare a time column with .start/.end',
      'more than 2,000 plain dots, one series without size or colour',
    ])
      expect(text, words).toContain(words);
  });
});
