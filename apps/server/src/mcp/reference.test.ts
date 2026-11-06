import { describe, expect, it } from 'vitest';
import { referenceText } from './reference.ts';

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
      '- status { entity, status, group?, label?, kind?, detail?, since?, levels?, summary }',
    );
    for (const word of ['degraded', 'maintenance', 'crit', 'passed', 'true = ok, false = fail'])
      expect(text).toContain(word);
    expect(text).toContain('"+N more ok"');
    expect(text).toContain('"+N more problems"');
    expect(text).toContain('"type": "status"');
    expect(text).toContain('status 6x5');
    expect(text).toContain('## Sound cues (chart, kpi, gauge, table, map, status)');
  });
});
