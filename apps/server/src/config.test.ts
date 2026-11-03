import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

describe('ALLOW_PRIVATE_HOSTS and PRIVATE_HOSTS_FOR', () => {
  const load = (env: Record<string, string>) => loadConfig({ NODE_ENV: 'test', ...env });

  it('are off by default, also when compose passes empty values', () => {
    expect(load({}).privateHosts).toBeNull();
    const empty = load({ ALLOW_PRIVATE_HOSTS: '', PRIVATE_HOSTS_FOR: '' });
    expect(empty.privateHosts).toBeNull();
    expect(empty.privateHostsFor).toBe('admins');
  });

  it('parse the list once, in canonical spelling', () => {
    const c = load({ ALLOW_PRIVATE_HOSTS: 'NAS.lan, 192.168.1.0/24', PRIVATE_HOSTS_FOR: 'everyone' });
    expect(c.privateHosts?.entries).toEqual(['nas.lan', '192.168.1.0/24']);
    expect(c.privateHostsFor).toBe('everyone');
  });

  it('refuse to start on an entry or a mode they cannot use', () => {
    expect(() => load({ ALLOW_PRIVATE_HOSTS: '0.0.0.0/0' })).toThrow(/too broad/);
    expect(() => load({ ALLOW_PRIVATE_HOSTS: 'http://nas.lan' })).toThrow(/without http:\/\//);
    expect(() => load({ PRIVATE_HOSTS_FOR: 'all' })).toThrow();
  });
});
