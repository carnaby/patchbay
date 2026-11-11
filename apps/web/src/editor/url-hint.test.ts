import { describe, expect, it } from 'vitest';
import { urlFieldLabel, urlHint } from './url-hint.ts';

describe('url hint', () => {
  it('says private addresses are blocked unless the dashboard may reach the operator’s private hosts', () => {
    expect(urlHint({ canUseSecrets: false, privateHosts: false })).toBe(
      'A public JSON endpoint without credentials. Private network addresses are blocked.',
    );
    expect(urlHint({ canUseSecrets: true, privateHosts: false })).toBe(
      'Don’t put keys into the URL; use Credentials instead. Private network addresses are blocked.',
    );
    expect(urlHint({ canUseSecrets: true, privateHosts: true })).toContain('ALLOW_PRIVATE_HOSTS');
    expect(urlHint({ canUseSecrets: true, privateHosts: true })).not.toContain('blocked');
    expect(urlHint({ canUseSecrets: false, privateHosts: true })).not.toContain('blocked');
    expect(urlFieldLabel(false)).toBe('HTTPS URL');
    expect(urlFieldLabel(true)).toBe('URL');
  });
});
